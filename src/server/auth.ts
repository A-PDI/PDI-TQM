import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Capability } from '../shared/capabilities.js';
import { audit } from './audit.js';
import type { Db, Queryable } from './db.js';
import { forbidden, unauthenticated } from './errors.js';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 96 * 1024 * 1024 };
export const SESSION_COOKIE = 'tqms_sid';
export const MIN_PASSWORD_LENGTH = 12;
const LOCKOUT_THRESHOLD = 8;
const LOCKOUT_MINUTES = 15;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password.normalize('NFKC'), salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (password.length > 256) return 'Password is too long';
  return null;
}

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export interface AuthContext {
  userId: string;
  email: string;
  displayName: string;
  sessionId: string;
  csrfToken: string;
  capabilities: Set<Capability>;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

export async function activeCapabilities(db: Queryable, userId: string): Promise<Set<Capability>> {
  const res = await db.query<{ capability_code: Capability }>(
    `SELECT DISTINCT g.capability_code FROM authority_grant g JOIN app_user u ON u.id = g.user_id
      WHERE g.user_id = $1 AND u.active AND g.revoked_at IS NULL
        AND g.effective_from <= now() AND (g.effective_to IS NULL OR g.effective_to > now())`,
    [userId],
  );
  return new Set(res.rows.map((r) => r.capability_code));
}

export async function createSession(db: Queryable, userId: string, ttlHours: number, ip: string, userAgent: string | undefined) {
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(24).toString('base64url');
  const row = await db.query<{ id: string; expires_at: Date }>(
    `INSERT INTO user_session (token_hash, user_id, csrf_token, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, now() + make_interval(hours => $4), $5, $6) RETURNING id, expires_at`,
    [tokenHash(token), userId, csrfToken, ttlHours, ip, userAgent?.slice(0, 300) ?? null],
  );
  return { token, csrfToken, sessionId: row.rows[0]!.id, expiresAt: row.rows[0]!.expires_at };
}

export async function resolveSession(db: Db, token: string | undefined): Promise<AuthContext | null> {
  if (!token || token.length > 200) return null;
  const res = await db.query<{ session_id: string; csrf_token: string; user_id: string; email: string; display_name: string }>(
    `UPDATE user_session s SET last_seen_at = now()
       FROM app_user u
      WHERE s.token_hash = $1 AND s.user_id = u.id AND u.active AND s.revoked_at IS NULL AND s.expires_at > now()
      RETURNING s.id AS session_id, s.csrf_token, u.id AS user_id, u.email, u.display_name`,
    [tokenHash(token)],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    sessionId: row.session_id,
    csrfToken: row.csrf_token,
    capabilities: await activeCapabilities(db, row.user_id),
  };
}

export interface LoginResult {
  ok: boolean;
  userId?: string;
  locked?: boolean;
}

export async function attemptLogin(db: Db, email: string, password: string): Promise<LoginResult> {
  const user = await db.query<{ id: string; password_hash: string | null; active: boolean; locked_until: Date | null }>(
    `SELECT id, password_hash, active, locked_until FROM app_user WHERE lower(email) = lower($1) AND identity_type = 'LOCAL'`,
    [email],
  );
  const row = user.rows[0];
  // Hash even when the account is unknown so response timing does not reveal accounts.
  const valid = await verifyPassword(password, row?.password_hash ?? (await dummyHash()));
  if (!row || !row.active) return { ok: false };
  if (row.locked_until && row.locked_until > new Date()) return { ok: false, locked: true, userId: row.id };
  if (!valid) {
    await db.query(
      `UPDATE app_user SET failed_login_count = failed_login_count + 1,
         locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
       WHERE id = $1`,
      [row.id, LOCKOUT_THRESHOLD, LOCKOUT_MINUTES],
    );
    return { ok: false, userId: row.id };
  }
  await db.query('UPDATE app_user SET failed_login_count = 0, locked_until = NULL WHERE id = $1', [row.id]);
  return { ok: true, userId: row.id };
}

let cachedDummy: string | null = null;
async function dummyHash(): Promise<string> {
  cachedDummy ??= await hashPassword(randomBytes(16).toString('hex'));
  return cachedDummy;
}

export function requireAuth(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthenticated();
  return req.auth;
}

export function has(auth: AuthContext, cap: Capability): boolean {
  return auth.capabilities.has(cap);
}

/**
 * Enforces a capability at the service boundary. Denials of consequential actions are
 * recorded in the audit trail with the reason (no secrets).
 */
export async function requireCapability(
  db: Queryable,
  req: FastifyRequest,
  cap: Capability,
  context: { action: string; entityType?: string; entityId?: string; consequential?: boolean },
): Promise<AuthContext> {
  const auth = requireAuth(req);
  if (!auth.capabilities.has(cap)) {
    if (context.consequential !== false) {
      await audit(db, {
        actorId: auth.userId,
        action: context.action,
        outcome: 'DENIED',
        entityType: context.entityType,
        entityId: context.entityId,
        summary: `Denied: missing capability ${cap}`,
        requestId: req.id,
      });
    }
    throw forbidden(`This action requires the "${cap}" authority`);
  }
  return auth;
}

/** Re-checks a capability inside the transaction that records a consequential decision. */
export async function recheckCapability(db: Queryable, userId: string, cap: Capability): Promise<boolean> {
  return (await activeCapabilities(db, userId)).has(cap);
}

export function setSessionCookie(reply: FastifyReply, token: string, expiresAt: Date, secure: boolean) {
  reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, secure, sameSite: 'strict', path: '/', expires: expiresAt });
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean) {
  reply.clearCookie(SESSION_COOKIE, { httpOnly: true, secure, sameSite: 'strict', path: '/' });
}
