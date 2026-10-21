import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CAPABILITIES, type Capability, ROLE_BUNDLES } from '../shared/capabilities.js';
import { dayIn } from '../shared/quality.js';
import { audit } from './audit.js';
import {
  attemptLogin,
  clearSessionCookie,
  createSession,
  has,
  hashPassword,
  passwordProblem,
  requireAuth,
  requireCapability,
  setSessionCookie,
  verifyPassword,
} from './auth.js';
import { many, one, withTransaction } from './db.js';
import { AppError, badRequest, forbidden, notFound, unprocessable } from './errors.js';
import type { Services } from './services.js';
import { qualityContext } from './quality/context.js';
import { effectiveSourceStatuses } from './sourcing/status.js';

const uuid = z.string().uuid();
const like = (s: string) => `%${s.trim().replace(/[%_\\]/g, '\\$&')}%`;
const normalize = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

export function registerCoreRoutes(app: FastifyInstance, svc: Services) {
  const { db, config } = svc;

  // ---------------------------------------------------------------- authentication
  app.post('/api/auth/login', { config: { rateLimit: { max: config.loginRateLimitPerMinute, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(256) }).parse(req.body);
    const result = await attemptLogin(db, body.email, body.password);
    if (!result.ok) {
      await audit(db, {
        actorId: result.userId ?? null,
        action: 'auth.login',
        outcome: 'DENIED',
        summary: result.locked ? 'Login refused: account temporarily locked' : 'Login failed',
        requestId: req.id,
      });
      throw new AppError(401, 'LOGIN_FAILED', result.locked ? 'Too many failed attempts. Try again in 15 minutes.' : 'Email or password is incorrect');
    }
    const session = await createSession(db, result.userId!, config.sessionTtlHours, req.ip, req.headers['user-agent']);
    setSessionCookie(reply, session.token, session.expiresAt, config.secureCookies);
    await audit(db, { actorId: result.userId!, action: 'auth.login', summary: 'Signed in', requestId: req.id });
    return { csrfToken: session.csrfToken };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const auth = requireAuth(req);
    await db.query('UPDATE user_session SET revoked_at = now() WHERE id = $1', [auth.sessionId]);
    clearSessionCookie(reply, config.secureCookies);
    await audit(db, { actorId: auth.userId, action: 'auth.logout', summary: 'Signed out', requestId: req.id });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => {
    const auth = requireAuth(req);
    return {
      user: { id: auth.userId, email: auth.email, displayName: auth.displayName },
      capabilities: [...auth.capabilities].sort(),
      csrfToken: auth.csrfToken,
      environment: config.appEnv,
      displayTimeZone: config.displayTimeZone,
    };
  });

  app.post('/api/auth/change-password', async (req) => {
    const auth = requireAuth(req);
    const body = z.object({ currentPassword: z.string().max(256), newPassword: z.string().max(256) }).parse(req.body);
    const problem = passwordProblem(body.newPassword);
    if (problem) throw unprocessable(problem);
    const row = await one<{ password_hash: string }>(db, 'SELECT password_hash FROM app_user WHERE id = $1', [auth.userId]);
    if (!(await verifyPassword(body.currentPassword, row?.password_hash ?? null))) throw unprocessable('Current password is incorrect');
    await db.query('UPDATE app_user SET password_hash = $2 WHERE id = $1', [auth.userId, await hashPassword(body.newPassword)]);
    await db.query('UPDATE user_session SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL', [auth.userId, auth.sessionId]);
    await audit(db, { actorId: auth.userId, action: 'auth.change_password', summary: 'Password changed; other sessions revoked', requestId: req.id });
    return { ok: true };
  });

  // ---------------------------------------------------------------- home / work / search
  app.get('/api/home', async (req) => {
    const auth = await requireCapability(db, req, 'records.read', { action: 'home.read', consequential: false });
    const caps = [...auth.capabilities];
    const team = (req.query as { scope?: string }).scope === 'team' && has(auth, 'work.view_team');
    const work = await many(
      db,
      `SELECT w.id, w.kind, w.title, w.subject_type AS "subjectType", w.subject_id AS "subjectId", w.due_at AS "dueAt",
              w.created_at AS "createdAt", a.display_name AS assignee, w.required_capability AS "requiredCapability",
              CASE w.subject_type
                WHEN 'INSPECTION' THEN '/inspections/' || w.subject_id
                WHEN 'QUALITY_EVENT' THEN '/quality/' || w.subject_id
                WHEN 'SOURCE' THEN '/sources/' || w.subject_id
                WHEN 'SOURCING_REQUEST' THEN '/sourcing/' || w.subject_id
                WHEN 'BASELINE_REVISION' THEN '/baselines/' || w.subject_id
                WHEN 'QUALIFICATION' THEN '/suppliers/' || (SELECT q.supplier_id FROM supplier_qualification q WHERE q.id = w.subject_id)
                WHEN 'NCR' THEN '/quality/ncrs/' || w.subject_id
                WHEN 'MATERIAL_SCOPE' THEN '/quality/ncrs/' || (SELECT m.ncr_id FROM material_scope m WHERE m.id = w.subject_id)
                WHEN 'CONCESSION' THEN '/quality/concessions/' || w.subject_id
                WHEN 'SCAR' THEN '/quality/scars/' || w.subject_id
                WHEN 'COMMITMENT' THEN '/commitments/' || w.subject_id
                WHEN 'CHANGE' THEN '/changes/' || w.subject_id
                WHEN 'CHANGE_ACTION' THEN '/changes/' || (SELECT ca.change_id FROM change_action ca WHERE ca.id = w.subject_id)
                WHEN 'FORM_REVISION' THEN '/forms/' || w.subject_id
              END AS link,
              (w.due_at IS NOT NULL AND w.due_at < now()) AS overdue
         FROM work_item w LEFT JOIN app_user a ON a.id = w.assignee_id
        WHERE w.status = 'OPEN' AND ($3 OR w.assignee_id = $1 OR (w.assignee_id IS NULL AND w.required_capability = ANY($2::text[])))
        ORDER BY w.due_at NULLS LAST, w.created_at`,
      [auth.userId, caps, team],
    );
    const drafts = await many(
      db,
      `SELECT id, number, part_number AS "partNumber", part_description AS "partDescription", status, updated_at AS "updatedAt", unit_count AS "unitCount"
         FROM inspection WHERE inspector_id = $1 AND status IN ('DRAFT', 'PARTIAL') ORDER BY updated_at DESC LIMIT 20`,
      [auth.userId],
    );
    const counts = await one<{ awaiting_review: number; open_concerns: number; open_inspections: number; open_ncrs: number; open_scars: number; overdue_commitments: number }>(
      db,
      `SELECT (SELECT count(*)::int FROM inspection WHERE status = 'READY_FOR_REVIEW') AS awaiting_review,
              (SELECT count(*)::int FROM quality_event WHERE status IN ('CAPTURED', 'TRIAGED')) AS open_concerns,
              (SELECT count(*)::int FROM inspection WHERE status IN ('DRAFT', 'PARTIAL')) AS open_inspections,
              (SELECT count(*)::int FROM ncr WHERE status <> 'CLOSED') AS open_ncrs,
              (SELECT count(*)::int FROM scar WHERE status <> 'CLOSED') AS open_scars,
              (SELECT count(*)::int FROM supplier_commitment WHERE status IN ('OPEN', 'SUPPLIER_CLAIMS_DONE') AND due_date < $1::date) AS overdue_commitments`,
      [dayIn(config.displayTimeZone)],
    );
    const recent = await many(
      db,
      `SELECT DISTINCT ON (a.entity_type, a.entity_id) a.entity_type AS "entityType", a.entity_id AS "entityId", a.summary, a.occurred_at AS "occurredAt"
         FROM audit_event a WHERE a.actor_id = $1 AND a.entity_type IN ('inspection', 'quality_event', 'ncr', 'scar', 'concession', 'change_request', 'supplier_commitment')
          AND a.outcome = 'SUCCESS'
        ORDER BY a.entity_type, a.entity_id, a.occurred_at DESC`,
      [auth.userId],
    );
    recent.sort((x, y) => +new Date(y.occurredAt as string) - +new Date(x.occurredAt as string));
    return { work, drafts, counts, recent: recent.slice(0, 8), teamView: team };
  });

  app.get('/api/search', async (req) => {
    await requireCapability(db, req, 'records.read', { action: 'search', consequential: false });
    const q = z.object({ q: z.string().trim().min(2).max(100) }).parse(req.query);
    const p = like(q.q);
    const [parts, inspections, suppliers, events, records] = await Promise.all([
      many(
        db,
        `SELECT DISTINCT p.id, p.part_number AS "partNumber", p.description FROM company_part p LEFT JOIN part_alias a ON a.part_id = p.id
          LEFT JOIN source s ON s.part_id = p.id LEFT JOIN supplier_part sp ON sp.id = s.supplier_part_id
          WHERE p.part_number ILIKE $1 OR p.description ILIKE $1 OR a.alias ILIKE $1 OR sp.supplier_part_number ILIKE $1 LIMIT 10`,
        [p],
      ),
      many(
        db,
        `SELECT i.id, i.number, i.part_number AS "partNumber", i.po_number AS "poNumber", i.lot_number AS "lotNumber", i.status
           FROM inspection i WHERE i.number ILIKE $1 OR i.po_number ILIKE $1 OR i.lot_number ILIKE $1 OR i.part_number ILIKE $1
              OR EXISTS (SELECT 1 FROM inspection_unit u WHERE u.inspection_id = i.id AND u.serial_number ILIKE $1)
          ORDER BY i.created_at DESC LIMIT 10`,
        [p],
      ),
      many(
        db,
        `SELECT DISTINCT s.id, s.code, s.legal_name AS "legalName" FROM supplier s LEFT JOIN supplier_site ss ON ss.supplier_id = s.id
          WHERE s.code ILIKE $1 OR s.legal_name ILIKE $1 OR s.trading_name ILIKE $1 OR ss.name ILIKE $1 LIMIT 10`,
        [p],
      ),
      many(
        db,
        `SELECT id, number, title, status FROM quality_event WHERE number ILIKE $1 OR title ILIKE $1 OR serial_number ILIKE $1 OR lot_number ILIKE $1
          ORDER BY reported_at DESC LIMIT 10`,
        [p],
      ),
      // Quality and change records: NCR (incl. affected lots/serials), SCAR, concession, change, commitment.
      many(
        db,
        `(SELECT 'NCR' AS type, n.id, n.number, n.title, n.status, '/quality/ncrs/' || n.id AS link FROM ncr n
           WHERE n.number ILIKE $1 OR n.title ILIKE $1 OR n.lot_number ILIKE $1
              OR EXISTS (SELECT 1 FROM material_scope m WHERE m.ncr_id = n.id AND (m.lot_number ILIKE $1 OR array_to_string(m.serial_numbers, ' ') ILIKE $1)) LIMIT 10)
         UNION ALL
         (SELECT 'SCAR', s.id, s.number, s.title, s.status, '/quality/scars/' || s.id FROM scar s WHERE s.number ILIKE $1 OR s.title ILIKE $1 LIMIT 10)
         UNION ALL
         (SELECT 'Concession', c.id, c.number, c.characteristic, c.status, '/quality/concessions/' || c.id FROM concession c WHERE c.number ILIKE $1 OR c.lot_number ILIKE $1 LIMIT 10)
         UNION ALL
         (SELECT 'Change', c.id, c.number, c.title, c.status, '/changes/' || c.id FROM change_request c
           WHERE c.number ILIKE $1 OR c.title ILIKE $1 OR c.supplier_reference ILIKE $1 OR c.effective_lot ILIKE $1 LIMIT 10)
         UNION ALL
         (SELECT 'Commitment', c.id, c.number, c.promised_action, c.status, '/commitments/' || c.id FROM supplier_commitment c
           WHERE c.number ILIKE $1 OR c.promised_action ILIKE $1 OR c.representative ILIKE $1 LIMIT 10)`,
        [p],
      ),
    ]);
    return { parts, inspections, suppliers, qualityEvents: events, records };
  });

  app.get('/api/users/directory', async (req) => {
    await requireCapability(db, req, 'records.read', { action: 'users.directory', consequential: false });
    const q = z.object({ capability: z.string().max(64).optional() }).parse(req.query);
    return many(
      db,
      `SELECT u.id, u.display_name AS "displayName" FROM app_user u
        WHERE u.active AND u.identity_type = 'LOCAL'
          AND ($1::text IS NULL OR EXISTS (SELECT 1 FROM authority_grant g WHERE g.user_id = u.id AND g.capability_code = $1
               AND g.revoked_at IS NULL AND g.effective_from <= now() AND (g.effective_to IS NULL OR g.effective_to > now())))
        ORDER BY u.display_name`,
      [q.capability ?? null],
    );
  });

  // ---------------------------------------------------------------- parts, suppliers, forms
  app.get('/api/parts', async (req) => {
    await requireCapability(db, req, 'records.read', { action: 'parts.list', consequential: false });
    const q = z.object({ q: z.string().max(100).optional() }).parse(req.query);
    const term = q.q?.trim();
    return many(
      db,
      `SELECT p.id, p.part_number AS "partNumber", p.description, p.family, p.criticality, p.default_form_number AS "defaultFormNumber",
              p.is_synthetic AS "isSynthetic",
              (SELECT string_agg(a.alias, ', ' ORDER BY a.alias) FROM part_alias a WHERE a.part_id = p.id) AS aliases
         FROM company_part p
        WHERE p.active AND ($1::text IS NULL OR p.part_number ILIKE $1 OR p.description ILIKE $1
              OR EXISTS (SELECT 1 FROM part_alias a WHERE a.part_id = p.id AND (a.alias ILIKE $1 OR a.normalized LIKE $2)))
        ORDER BY (p.part_number ILIKE $3) DESC, p.part_number LIMIT 25`,
      [term ? like(term) : null, term ? `%${normalize(term)}%` : null, term ? `${term.replace(/[%_\\]/g, '\\$&')}%` : null],
    );
  });

  app.post('/api/parts', async (req, reply) => {
    const auth = await requireCapability(db, req, 'masterdata.edit', { action: 'parts.create' });
    const body = z
      .object({
        partNumber: z.string().trim().min(2).max(60),
        description: z.string().trim().min(2).max(200),
        family: z.string().trim().max(80).nullable().optional(),
        defaultFormNumber: z.string().regex(/^PDI-IQI-[0-9A-Z]+$/).nullable().optional(),
        aliases: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
      })
      .parse(req.body);
    const created = await withTransaction(db, async (tx) => {
      const part = await one<{ id: string }>(
        tx,
        `INSERT INTO company_part (part_number, description, family, default_form_number, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [body.partNumber, body.description, body.family ?? null, body.defaultFormNumber ?? null, auth.userId],
      );
      for (const alias of new Set(body.aliases ?? [])) {
        await tx.query(`INSERT INTO part_alias (part_id, alias, normalized) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [part!.id, alias, normalize(alias)]);
      }
      await audit(tx, { actorId: auth.userId, action: 'parts.create', entityType: 'company_part', entityId: part!.id, summary: `Part ${body.partNumber} created`, after: body, requestId: req.id });
      return part!;
    });
    return reply.code(201).send(created);
  });

  app.get('/api/parts/:id', async (req) => {
    await requireCapability(db, req, 'records.read', { action: 'parts.read', consequential: false });
    const { id } = req.params as { id: string };
    if (!uuid.safeParse(id).success) throw notFound('Part');
    const part = await one(
      db,
      `SELECT id, part_number AS "partNumber", description, family, criticality, design_owner AS "designOwner",
              default_form_number AS "defaultFormNumber", is_synthetic AS "isSynthetic", created_at AS "createdAt"
         FROM company_part WHERE id = $1`,
      [id],
    );
    if (!part) throw notFound('Part');
    const [aliases, sources, baselines, inspections, concerns] = await Promise.all([
      many(db, `SELECT alias, alias_type AS "aliasType" FROM part_alias WHERE part_id = $1 ORDER BY alias`, [id]),
      many(
        db,
        `SELECT s.id, s.pathway, s.configuration, s.approval_state AS "approvalState", s.conditions, sup.id AS "supplierId", sup.legal_name AS supplier,
                ss.name AS site, sp.supplier_part_number AS "supplierPartNumber", br.revision_label AS "baselineRevision", br.status AS "baselineStatus",
                tb.title AS "baselineTitle", s.is_synthetic AS "isSynthetic"
           FROM source s JOIN supplier sup ON sup.id = s.supplier_id JOIN supplier_site ss ON ss.id = s.site_id
           JOIN supplier_part sp ON sp.id = s.supplier_part_id
           LEFT JOIN baseline_revision br ON br.id = s.baseline_revision_id LEFT JOIN technical_baseline tb ON tb.id = br.baseline_id
          WHERE s.part_id = $1 ORDER BY sup.legal_name, ss.name`,
        [id],
      ),
      many(
        db,
        `SELECT b.id, b.title, b.ownership, r.id AS "revisionId", r.revision_label AS "revisionLabel", r.status, r.is_synthetic AS "isSynthetic",
                r.released_at AS "releasedAt", u.display_name AS "releasedBy",
                (SELECT json_agg(json_build_object('name', c.name, 'unit', c.unit, 'lower', c.lower_limit, 'upper', c.upper_limit, 'ref', c.form_row_ref)
                   ORDER BY c.char_key) FROM baseline_characteristic c WHERE c.revision_id = r.id) AS characteristics
           FROM technical_baseline b JOIN baseline_revision r ON r.baseline_id = b.id LEFT JOIN app_user u ON u.id = r.released_by
          WHERE b.part_id = $1 ORDER BY b.title, r.revision_label`,
        [id],
      ),
      many(
        db,
        `SELECT i.id, i.number, i.status, i.outcome, i.po_number AS "poNumber", i.lot_number AS "lotNumber", i.date_received AS "dateReceived"
           FROM inspection i WHERE i.part_id = $1 AND i.status <> 'VOID' ORDER BY i.created_at DESC LIMIT 20`,
        [id],
      ),
      many(db, `SELECT id, number, title, status FROM quality_event WHERE part_id = $1 ORDER BY reported_at DESC LIMIT 20`, [id]),
    ]);
    const statuses = await effectiveSourceStatuses(db, sources.map((s) => (s as { id: string }).id));
    const sourcing = await many(
      db,
      `SELECT id, number, title, pathway, status FROM sourcing_request WHERE part_id = $1 ORDER BY created_at DESC`,
      [id],
    );
    const quality = await qualityContext(db, { partId: id }, config.displayTimeZone);
    return { part, aliases, sources: sources.map((s) => ({ ...s, effective: statuses.get((s as { id: string }).id) })), baselines, inspections, concerns, sourcing, quality };
  });

  app.get('/api/parts/:id/launch-options', async (req) => {
    await requireCapability(db, req, 'records.read', { action: 'parts.read', consequential: false });
    const { id } = req.params as { id: string };
    if (!uuid.safeParse(id).success) throw notFound('Part');
    const part = await one<{ default_form_number: string | null; family: string | null }>(
      db,
      'SELECT default_form_number, family FROM company_part WHERE id = $1',
      [id],
    );
    if (!part) throw notFound('Part');
    const sources = await many(
      db,
      `SELECT s.id, sup.legal_name AS supplier, ss.name AS site, sp.supplier_part_number AS "supplierPartNumber", s.approval_state AS "approvalState",
              s.pathway, s.configuration
         FROM source s JOIN supplier sup ON sup.id = s.supplier_id JOIN supplier_site ss ON ss.id = s.site_id JOIN supplier_part sp ON sp.id = s.supplier_part_id
        WHERE s.part_id = $1 ORDER BY sup.legal_name`,
      [id],
    );
    const statuses = await effectiveSourceStatuses(db, sources.map((s) => (s as { id: string }).id));
    return { suggestedFormNumber: part.default_form_number, sources: sources.map((s) => ({ ...s, effective: statuses.get((s as { id: string }).id) })) };
  });

  app.get('/api/forms', async (req) => {
    await requireCapability(db, req, 'records.read', { action: 'forms.list', consequential: false });
    const all = (req.query as { all?: string }).all === '1';
    return many(
      db,
      `SELECT r.id AS "revisionId", f.form_number AS "formNumber", f.component, r.revision_label AS "revisionLabel", r.sequence, r.status,
              r.provenance, r.released_at AS "releasedAt", r.definition_sha256 AS sha256,
              (SELECT count(*)::int FROM inspection i WHERE i.form_revision_id = r.id) AS "inspectionCount"
         FROM form_revision r JOIN inspection_form f ON f.id = r.form_id
        WHERE $1 OR r.status = 'RELEASED'
        ORDER BY f.form_number, r.sequence`,
      [all],
    );
  });

  app.get('/api/forms/revisions/:id', async (req) => {
    await requireCapability(db, req, 'records.read', { action: 'forms.read', consequential: false });
    const { id } = req.params as { id: string };
    if (!uuid.safeParse(id).success) throw notFound('Form revision');
    const rev = await one(
      db,
      `SELECT r.id, f.form_number AS "formNumber", r.revision_label AS "revisionLabel", r.status, r.definition, r.provenance, r.definition_sha256 AS sha256
         FROM form_revision r JOIN inspection_form f ON f.id = r.form_id WHERE r.id = $1`,
      [id],
    );
    if (!rev) throw notFound('Form revision');
    return rev;
  });

  // ---------------------------------------------------------------- administration
  app.get('/api/admin/users', async (req) => {
    await requireCapability(db, req, 'admin.users', { action: 'admin.users.list', consequential: false });
    const users = await many(
      db,
      `SELECT u.id, u.email, u.display_name AS "displayName", u.active, u.created_at AS "createdAt",
              coalesce((SELECT json_agg(json_build_object('id', g.id, 'capability', g.capability_code, 'grantedAt', g.granted_at) ORDER BY g.capability_code)
                          FROM authority_grant g WHERE g.user_id = u.id AND g.revoked_at IS NULL), '[]') AS grants
         FROM app_user u WHERE u.identity_type = 'LOCAL' ORDER BY u.display_name`,
    );
    return { users, capabilities: CAPABILITIES, bundles: ROLE_BUNDLES };
  });

  app.post('/api/admin/users', async (req, reply) => {
    const auth = await requireCapability(db, req, 'admin.users', { action: 'admin.users.create' });
    const body = z
      .object({ email: z.string().email().max(200), displayName: z.string().trim().min(2).max(120), temporaryPassword: z.string().max(256) })
      .parse(req.body);
    const problem = passwordProblem(body.temporaryPassword);
    if (problem) throw unprocessable(problem);
    const user = await withTransaction(db, async (tx) => {
      const row = await one<{ id: string }>(
        tx,
        `INSERT INTO app_user (email, display_name, password_hash, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
        [body.email, body.displayName, await hashPassword(body.temporaryPassword), auth.userId],
      );
      await audit(tx, { actorId: auth.userId, action: 'admin.user_create', entityType: 'app_user', entityId: row!.id, summary: `User ${body.email} created`, requestId: req.id });
      return row!;
    });
    return reply.code(201).send(user);
  });

  app.post('/api/admin/users/:id/grants', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'admin.users', { action: 'admin.grant', entityType: 'app_user', entityId: id });
    const body = z.object({ capabilities: z.array(z.string()).min(1).max(30), reason: z.string().trim().min(3).max(500) }).parse(req.body);
    if (!uuid.safeParse(id).success) throw notFound('User');
    // Segregation: administrators cannot change their own authority.
    if (id === auth.userId) {
      await audit(db, { actorId: auth.userId, action: 'admin.grant', outcome: 'DENIED', entityType: 'app_user', entityId: id, summary: 'Denied: self-grant', requestId: req.id });
      throw forbidden('Administrators cannot change their own authority grants');
    }
    for (const c of body.capabilities) if (!(c in CAPABILITIES)) throw badRequest(`Unknown capability ${c}`);
    await withTransaction(db, async (tx) => {
      const target = await one<{ active: boolean }>(tx, 'SELECT active FROM app_user WHERE id = $1 AND identity_type = $2', [id, 'LOCAL']);
      if (!target) throw notFound('User');
      for (const c of body.capabilities as Capability[]) {
        await tx.query(
          `INSERT INTO authority_grant (user_id, capability_code, reason, granted_by) VALUES ($1,$2,$3,$4)
           ON CONFLICT (user_id, capability_code, scope) WHERE revoked_at IS NULL DO NOTHING`,
          [id, c, body.reason, auth.userId],
        );
      }
      await audit(tx, { actorId: auth.userId, action: 'admin.grant', entityType: 'app_user', entityId: id, summary: `Granted ${body.capabilities.join(', ')}`, reason: body.reason, requestId: req.id });
    });
    return { ok: true };
  });

  app.post('/api/admin/grants/:grantId/revoke', async (req) => {
    const { grantId } = req.params as { grantId: string };
    const auth = await requireCapability(db, req, 'admin.users', { action: 'admin.revoke', entityType: 'authority_grant', entityId: grantId });
    const body = z.object({ reason: z.string().trim().min(3).max(500) }).parse(req.body);
    if (!uuid.safeParse(grantId).success) throw notFound('Grant');
    return withTransaction(db, async (tx) => {
      const g = await one<{ user_id: string; capability_code: string }>(
        tx,
        'SELECT user_id, capability_code FROM authority_grant WHERE id = $1 AND revoked_at IS NULL FOR UPDATE',
        [grantId],
      );
      if (!g) throw notFound('Grant');
      if (g.user_id === auth.userId) throw forbidden('Administrators cannot change their own authority grants');
      await tx.query('UPDATE authority_grant SET revoked_at = now(), revoked_by = $2, revoke_reason = $3 WHERE id = $1', [grantId, auth.userId, body.reason]);
      await audit(tx, { actorId: auth.userId, action: 'admin.revoke', entityType: 'app_user', entityId: g.user_id, summary: `Revoked ${g.capability_code}`, reason: body.reason, requestId: req.id });
      return { ok: true };
    });
  });

  app.post('/api/admin/users/:id/deactivate', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'admin.users', { action: 'admin.deactivate', entityType: 'app_user', entityId: id });
    const body = z.object({ reason: z.string().trim().min(3).max(500) }).parse(req.body);
    if (!uuid.safeParse(id).success) throw notFound('User');
    if (id === auth.userId) throw forbidden('Administrators cannot deactivate themselves');
    return withTransaction(db, async (tx) => {
      const res = await tx.query(
        `UPDATE app_user SET active = false, deactivated_at = now(), deactivated_by = $2 WHERE id = $1 AND active AND identity_type = 'LOCAL'`,
        [id, auth.userId],
      );
      if (!res.rowCount) throw notFound('Active user');
      await tx.query('UPDATE user_session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
      await audit(tx, { actorId: auth.userId, action: 'admin.deactivate', entityType: 'app_user', entityId: id, summary: 'User deactivated; sessions revoked', reason: body.reason, requestId: req.id });
      return { ok: true };
    });
  });

  app.get('/api/admin/policies', async (req) => {
    await requireCapability(db, req, 'records.read', { action: 'policies.read', consequential: false });
    return many(
      db,
      `SELECT code, area, title, status, interim_behavior AS "interimBehavior", owner, decision, decided_at AS "decidedAt", effective_revision AS "effectiveRevision"
         FROM policy_decision ORDER BY code`,
    );
  });

  app.get('/api/admin/system', async (req) => {
    await requireCapability(db, req, 'admin.system', { action: 'admin.system', consequential: false });
    const storage = await svc.storage.check();
    const jobs = await many(
      db,
      `SELECT id, kind, status, attempts, last_error AS "lastError", created_at AS "createdAt", completed_at AS "completedAt"
         FROM job ORDER BY id DESC LIMIT 50`,
    );
    const audits = await many(
      db,
      `SELECT a.id, a.occurred_at AS "occurredAt", a.action, a.outcome, a.summary, u.display_name AS actor
         FROM audit_event a LEFT JOIN app_user u ON u.id = a.actor_id ORDER BY a.id DESC LIMIT 100`,
    );
    return { storage: { ok: storage.ok, reason: storage.reason ?? null, freeBytes: storage.freeBytes ?? null }, jobs, audits };
  });
}
