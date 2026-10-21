import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, type Session, sessionFor, startHarness } from './harness.js';

/**
 * Construction Drawing F1: "direct unauthenticated and wrong-capability attempts on every sensitive
 * read/write, report and file". The route list comes from the running application, so a new
 * endpoint is covered automatically.
 */
let h: Harness;
let readOnly: Session;
const READ_ONLY_EMAIL = 'viewer.only@example.com';
const READ_ONLY_PASSWORD = 'Viewer-Only-Password-2026';

/** Routes that are intentionally public or need only a signed-in session. */
const PUBLIC = new Set(['POST /api/auth/login']);
const ANY_SIGNED_IN_WRITE = new Set(['POST /api/auth/logout', 'POST /api/auth/change-password']);
/** Reads that are restricted beyond `records.read` (exports, administration; the policy register is readable by everyone). */
const RESTRICTED_READ = /^GET \/api\/(exports|admin\/(?!policies$))/;
/**
 * Authority comes from the target record (its owner, requester or evidence type), so a request for a
 * record that does not exist is 404; the same request against a real record is checked separately below.
 */
const RECORD_SCOPED = new Set(['DELETE /api/evidence/links/:linkId', 'POST /api/change-actions/:id/complete', 'POST /api/concessions/:id/withdraw']);

const concrete = (url: string) => url.replace(':entityType', 'NCR').replace(/:[A-Za-z]+/g, () => randomUUID());
const apiRoutes = () =>
  h.svc.routes
    .filter((r) => r.url.startsWith('/api/'))
    .map((r) => ({ ...r, key: `${r.method} ${r.url}` }))
    .sort((a, b) => a.key.localeCompare(b.key));

beforeAll(async () => {
  h = await startHarness();
  const admin = await h.login('admin');
  const created = await admin.send('POST', '/api/admin/users', { email: READ_ONLY_EMAIL, displayName: 'Viewer Only', temporaryPassword: READ_ONLY_PASSWORD });
  expect(created.status).toBe(201);
  expect((await admin.send('POST', `/api/admin/users/${created.json.id}/grants`, { capabilities: ['records.read'], reason: 'Authorization sweep (fictional)' })).status).toBe(200);
  const res = await h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: READ_ONLY_EMAIL, password: READ_ONLY_PASSWORD } });
  expect(res.statusCode, res.body).toBe(200);
  readOnly = sessionFor(h.app, String(res.headers['set-cookie']).split(';')[0]!, res.json().csrfToken);
});
afterAll(async () => h?.close());

describe('authorization sweep over every API route', () => {
  it('the inventory is complete enough to be meaningful', () => {
    const routes = apiRoutes();
    expect(routes.length).toBeGreaterThan(150);
    for (const must of ['POST /api/scopes/:id/dispositions', 'POST /api/sources/:id/decision', 'GET /api/files/:fileId', 'GET /api/exports/inspections.csv', 'POST /api/injectors/imports']) {
      expect(routes.map((r) => r.key), must).toContain(must);
    }
  });

  it('every route except sign-in refuses an unauthenticated request with 401', async () => {
    const wrong: string[] = [];
    for (const r of apiRoutes()) {
      if (PUBLIC.has(r.key)) continue;
      const res = await h.app.inject({ method: r.method as 'GET', url: concrete(r.url), payload: r.method === 'GET' ? undefined : {} });
      if (res.statusCode !== 401) wrong.push(`${r.key} → ${res.statusCode}`);
    }
    expect(wrong).toEqual([]);
  });

  it('every state-changing route refuses a signed-in request without the CSRF token', async () => {
    const wrong: string[] = [];
    for (const r of apiRoutes()) {
      if (r.method === 'GET' || PUBLIC.has(r.key)) continue;
      const res = await h.app.inject({ method: r.method as 'POST', url: concrete(r.url), headers: { cookie: readOnly.cookie }, payload: {} });
      if (res.statusCode !== 403 || res.json().error?.code !== 'CSRF') wrong.push(`${r.key} → ${res.statusCode}`);
    }
    expect(wrong).toEqual([]);
  });

  it('a read-only user is refused (403) on every write, export and administration route', async () => {
    const wrong: string[] = [];
    for (const r of apiRoutes()) {
      if (PUBLIC.has(r.key) || ANY_SIGNED_IN_WRITE.has(r.key)) continue;
      if (r.method === 'GET' && !RESTRICTED_READ.test(r.key)) continue;
      const url = concrete(r.url);
      const res = r.method === 'GET' ? await readOnly.get(url) : await readOnly.send(r.method as 'POST', url, {});
      if (RECORD_SCOPED.has(r.key) ? res.status !== 404 : res.status !== 403) wrong.push(`${r.key} → ${res.status} ${JSON.stringify(res.json?.error?.code ?? '')}`);
    }
    expect(wrong).toEqual([]);
  });

  it('every refused write by the read-only user was audited as DENIED, and nothing was created', async () => {
    const userId = (await h.pool.query('SELECT id FROM app_user WHERE email = $1', [READ_ONLY_EMAIL])).rows[0].id;
    const denied = (await h.pool.query(`SELECT count(*)::int AS n FROM audit_event WHERE actor_id = $1 AND outcome = 'DENIED'`, [userId])).rows[0].n;
    const writes = apiRoutes().filter((r) => r.method !== 'GET' && !PUBLIC.has(r.key) && !ANY_SIGNED_IN_WRITE.has(r.key) && !RECORD_SCOPED.has(r.key)).length;
    expect(denied).toBeGreaterThanOrEqual(writes);
    const succeeded = (await h.pool.query(`SELECT action FROM audit_event WHERE actor_id = $1 AND outcome = 'SUCCESS' AND action <> 'auth.login'`, [userId])).rows;
    expect(succeeded).toEqual([]);
  });

  it('a read-only user can read the ordinary record pages', async () => {
    for (const url of ['/api/home', '/api/inspections', '/api/ncrs', '/api/injectors', '/api/reports/overview', `/api/trace?serial=NONE-1`, '/api/search?q=TQ']) {
      expect((await readOnly.get(url)).status, url).toBe(200);
    }
  });

  it('record-scoped writes refuse a user who is not the owner, requester or authorized for the evidence type', async () => {
    const inspector = await h.login('inspector');
    const part = h.ids.parts['TQ-PRK-3003'];
    const concession = await inspector.send('POST', '/api/concessions', {
      partId: part,
      lotNumber: 'LOT-AUTH-1',
      quantityLimit: 1,
      characteristic: 'Running Face Coating',
      permittedException: 'Fictional exception for the authorization sweep',
      justification: 'Fictional justification for the authorization sweep',
      validFrom: new Date().toISOString().slice(0, 10),
      validUntil: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10),
    });
    expect(concession.status, JSON.stringify(concession.json)).toBe(201);
    const withdraw = await readOnly.send('POST', `/api/concessions/${concession.json.id}/withdraw`, {});
    expect(withdraw.status).toBe(403);
    const userId = (await h.pool.query('SELECT id FROM app_user WHERE email = $1', [READ_ONLY_EMAIL])).rows[0].id;
    const audited = await h.pool.query(`SELECT 1 FROM audit_event WHERE actor_id = $1 AND action = 'concession.withdraw' AND outcome = 'DENIED'`, [userId]);
    expect(audited.rowCount).toBe(1);
    expect((await h.pool.query('SELECT status FROM concession WHERE id = $1', [concession.json.id])).rows[0].status).toBe('REQUESTED');
  });
});

describe('AT-19 roles', () => {
  const concessionBody = (lot: string) => ({
    partId: h.ids.parts['TQ-PRK-3003'],
    lotNumber: lot,
    quantityLimit: 1,
    characteristic: 'Running Face Coating',
    permittedException: 'Fictional exception for the roles test',
    justification: 'Fictional justification for the roles test',
    validFrom: new Date().toISOString().slice(0, 10),
    validUntil: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10),
  });

  it('an inspector can inspect but cannot release a drawing, change finalized results, grant their own concession or approve a source', async () => {
    const inspector = await h.login('inspector');
    const forms = (await inspector.get('/api/forms')).json as Array<{ revisionId: string; formNumber: string }>;
    const launched = await inspector.send('POST', '/api/inspections', {
      partId: h.ids.parts['TQ-PRK-3003'],
      formRevisionId: forms.find((f) => f.formNumber === 'PDI-IQI-004')!.revisionId,
      unitCount: 1,
      dateReceived: '2026-10-19',
      sourceId: h.ids.sources.ringNwr1,
      lotNumber: 'LOT-ROLE-1',
    });
    expect(launched.status).toBe(201);
    const revision = (await h.pool.query(
      `SELECT r.id FROM baseline_revision r JOIN technical_baseline b ON b.id = r.baseline_id WHERE b.part_id = $1 LIMIT 1`,
      [h.ids.parts['TQ-PRK-3003']],
    )).rows[0].id;
    expect((await inspector.send('POST', `/api/baseline-revisions/${revision}/release`, { expectedVersion: 1 })).status).toBe(403);
    expect((await inspector.send('POST', `/api/inspections/${launched.json.id}/amendments`, { reason: 'secret change', changes: [], expectedVersion: 1 })).status).toBe(403);
    const own = await inspector.send('POST', '/api/concessions', concessionBody('LOT-ROLE-1'));
    expect(own.status).toBe(201);
    expect((await inspector.send('POST', `/api/concessions/${own.json.id}/decide`, { expectedVersion: 1, decision: 'APPROVED', rationale: 'self approval attempt' })).status).toBe(403);
    expect((await inspector.send('POST', `/api/sources/${h.ids.sources.ringNwr1}/decision`, { decision: 'APPROVED', scope: 'x', rationale: 'no authority' })).status).toBe(403);
  });

  it('a cross-functional manager can inspect and decide others’ requests, but still not their own', async () => {
    const inspector = await h.login('inspector');
    const manager = await h.login('manager');
    const forms = (await manager.get('/api/forms')).json as Array<{ revisionId: string; formNumber: string }>;
    const inspection = await manager.send('POST', '/api/inspections', {
      partId: h.ids.parts['TQ-PRK-3003'],
      formRevisionId: forms.find((f) => f.formNumber === 'PDI-IQI-004')!.revisionId,
      unitCount: 1,
      dateReceived: '2026-10-19',
      lotNumber: 'LOT-ROLE-2',
    });
    expect(inspection.status).toBe(201);
    const theirs = await inspector.send('POST', '/api/concessions', concessionBody('LOT-ROLE-2'));
    expect((await manager.send('POST', `/api/concessions/${theirs.json.id}/decide`, { expectedVersion: 1, decision: 'APPROVED', rationale: 'Bounded to one item (fictional)' })).status).toBe(200);
    const mine = await manager.send('POST', '/api/concessions', concessionBody('LOT-ROLE-3'));
    const self = await manager.send('POST', `/api/concessions/${mine.json.id}/decide`, { expectedVersion: 1, decision: 'APPROVED', rationale: 'self approval attempt' });
    expect(self.status).toBe(403);
    expect(self.json.error.message).toMatch(/other than the requester/);
  });
});

describe('FR-110 account recovery', () => {
  it('an administrator sets a temporary password: lockout cleared, old sessions ended, self-reset refused, audited', async () => {
    const admin = await h.login('admin');
    const victim = await h.login('inspector2');
    const userId = h.ids.users.inspector2;
    // Locked out after failed attempts (the lockout rule itself is covered in inspection.test.ts).
    await h.pool.query(`UPDATE app_user SET failed_login_count = 8, locked_until = now() + interval '15 minutes' WHERE id = $1`, [userId]);

    expect((await admin.send('POST', `/api/admin/users/${userId}/reset-password`, { temporaryPassword: 'short', reason: 'Forgot password' })).status).toBe(422);
    expect((await admin.send('POST', `/api/admin/users/${h.ids.users.admin}/reset-password`, { temporaryPassword: 'Admin-Self-Reset-2026', reason: 'self' })).status).toBe(403);
    const ok = await admin.send('POST', `/api/admin/users/${userId}/reset-password`, { temporaryPassword: 'Temporary-Reset-2026', reason: 'Forgot password (fictional)' });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);

    expect((await victim.get('/api/auth/me')).status).toBe(401); // the old session was ended
    const login = await h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'sam.okafor@example.com', password: 'Temporary-Reset-2026' } });
    expect(login.statusCode).toBe(200);
    expect((await h.pool.query('SELECT failed_login_count, locked_until FROM app_user WHERE id = $1', [userId])).rows[0]).toEqual({ failed_login_count: 0, locked_until: null });
    const audited = await h.pool.query(`SELECT reason FROM audit_event WHERE action = 'admin.reset_password' AND entity_id = $1`, [userId]);
    expect(audited.rows.map((r) => r.reason)).toEqual(['Forgot password (fictional)']);
  });
});

