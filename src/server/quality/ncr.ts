import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CONCESSION_STATE_TEXT,
  DISPOSITION_OUTCOMES,
  DISPOSITION_RULE,
  DISPOSITION_TEXT,
  NCR_STATUS_TEXT,
  concessionState,
  dayIn,
  isUsableOutcome,
  needsReinspection,
} from '../../shared/quality.js';
import { audit } from '../audit.js';
import { auditedDenial, has, recheckCapability, requireCapability } from '../auth.js';
import { type DbClient, type Queryable, many, one, withTransaction } from '../db.js';
import { conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { nextRecordNumber } from '../numbering.js';
import type { Services } from '../services.js';
import { loadInspection } from '../inspections/state.js';
import { effectiveSourceStatuses } from '../sourcing/status.js';
import { closeWork, history, isActiveUser, issueRecordEdition, linkedFiles, openWork, renditions, uuid } from './common.js';
import { buildNcrReport } from './reports.js';
import { linkNcrToScar } from './scars.js';

export interface NcrRow {
  id: string;
  number: string;
  quality_event_id: string;
  title: string;
  status: string;
  severity: string;
  owner_id: string;
  confirmed_by: string;
  part_id: string | null;
  source_id: string | null;
  supplier_id: string | null;
  lot_number: string | null;
  inspection_id: string | null;
  version: number;
}

interface ScopeRow {
  id: string;
  ncr_id: string;
  label: string;
  lot_number: string;
  quantity: number;
  serial_numbers: string[];
  containment_authorized_at: Date | null;
  segregation_verified_at: Date | null;
  state: string;
}

interface DecisionRow {
  id: string;
  scope_id: string;
  outcome: string;
  quantity: number;
  serial_numbers: string[];
  concession_id: string | null;
  decided_by: string;
  decided_at: Date;
  voided_at: Date | null;
  verified: boolean;
}

const serialList = z.array(z.string().trim().min(1).max(80)).max(1000).default([]);

async function loadNcr(db: Queryable, id: string, lock = false): Promise<NcrRow> {
  if (!uuid.safeParse(id).success) throw notFound('NCR');
  const row = await one<NcrRow>(db, `SELECT * FROM ncr WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!row) throw notFound('NCR');
  return row;
}

async function decisionsFor(db: Queryable, scopeIds: string[]): Promise<DecisionRow[]> {
  if (!scopeIds.length) return [];
  return many<DecisionRow>(
    db,
    `SELECT d.id, d.scope_id, d.outcome, d.quantity, d.serial_numbers, d.concession_id, d.decided_by, d.decided_at, d.voided_at,
            coalesce((SELECT v.result = 'VERIFIED' FROM disposition_verification v WHERE v.decision_id = d.id ORDER BY v.verified_at DESC LIMIT 1), false) AS verified
       FROM disposition_decision d WHERE d.scope_id = ANY($1::uuid[]) ORDER BY d.decided_at`,
    [scopeIds],
  );
}

/** Scope and NCR states are derived from the recorded decisions, never typed (Drawing C1). */
export async function recomputeNcr(tx: DbClient, ncrId: string): Promise<string> {
  const scopes = await many<ScopeRow>(tx, 'SELECT * FROM material_scope WHERE ncr_id = $1 ORDER BY created_at FOR UPDATE', [ncrId]);
  const decisions = await decisionsFor(
    tx,
    scopes.map((s) => s.id),
  );
  for (const s of scopes) {
    const active = decisions.filter((d) => d.scope_id === s.id && !d.voided_at);
    const allocated = active.reduce((n, d) => n + d.quantity, 0);
    const released = await one<{ n: number }>(tx, 'SELECT count(*)::int AS n FROM material_release WHERE scope_id = $1', [s.id]);
    let state: string;
    if (!s.segregation_verified_at) state = 'ON_HOLD';
    else if (allocated < s.quantity) state = 'SEGREGATED_VERIFIED';
    else if (!active.every((d) => d.verified)) state = 'DECIDED';
    else if (released!.n > 0) state = 'RELEASED';
    else state = 'VERIFIED_RESOLVED';
    if (state !== s.state) await tx.query('UPDATE material_scope SET state = $2, version = version + 1 WHERE id = $1', [s.id, state]);
    s.state = state;
  }
  const ncr = await one<{ status: string }>(tx, 'SELECT status FROM ncr WHERE id = $1', [ncrId]);
  if (ncr!.status === 'CLOSED') return 'CLOSED';
  let status: string;
  if (!scopes.length || scopes.some((s) => s.state === 'ON_HOLD')) status = 'OPEN';
  else if (scopes.some((s) => s.state === 'SEGREGATED_VERIFIED')) status = 'CONTAINED';
  else if (scopes.some((s) => s.state === 'DECIDED')) status = 'DISPOSITIONED';
  else status = 'VERIFIED_RESOLVED';
  if (status !== ncr!.status) await tx.query('UPDATE ncr SET status = $2, version = version + 1 WHERE id = $1', [ncrId, status]);
  return status;
}

async function loadScope(tx: Queryable, id: string): Promise<ScopeRow & { ncr: NcrRow }> {
  if (!uuid.safeParse(id).success) throw notFound('Affected material');
  const scope = await one<ScopeRow>(tx, 'SELECT * FROM material_scope WHERE id = $1 FOR UPDATE', [id]);
  if (!scope) throw notFound('Affected material');
  const ncr = await loadNcr(tx, scope.ncr_id, true);
  if (ncr.status === 'CLOSED') throw conflict(`${ncr.number} is closed`);
  return { ...scope, ncr };
}

/** Units, lot and dates a concession may authorize (FR-073, AT-14). */
export async function assertConcessionCovers(
  tx: Queryable,
  concessionId: string,
  scope: { partId: string | null; sourceId: string | null; lotNumber: string | null; quantity: number },
  today: string,
): Promise<{ id: string; number: string }> {
  const c = await one<{
    id: string;
    number: string;
    status: string;
    part_id: string;
    source_id: string | null;
    lot_number: string;
    quantity_limit: number;
    valid_from: string;
    valid_until: string;
  }>(tx, `SELECT id, number, status, part_id, source_id, lot_number, quantity_limit, valid_from::text, valid_until::text FROM concession WHERE id = $1 FOR UPDATE`, [
    concessionId,
  ]);
  if (!c) throw unprocessable('Concession not found');
  const used = (await one<{ n: number }>(tx, 'SELECT coalesce(sum(quantity), 0)::int AS n FROM concession_use WHERE concession_id = $1 AND released_at IS NULL', [c.id]))!.n;
  const state = concessionState(c, used, today);
  if (state !== 'CURRENT') throw unprocessable(`${c.number} does not authorize material: ${CONCESSION_STATE_TEXT[state].toLowerCase()}`);
  if (c.part_id !== scope.partId) throw unprocessable(`${c.number} is for a different part`);
  if (c.source_id && c.source_id !== scope.sourceId) throw unprocessable(`${c.number} is for a different supplier source`);
  if (!scope.lotNumber || c.lot_number.trim().toUpperCase() !== scope.lotNumber.trim().toUpperCase())
    throw unprocessable(`${c.number} covers lot ${c.lot_number} only; this material is lot ${scope.lotNumber ?? 'unknown'}`);
  if (used + scope.quantity > c.quantity_limit)
    throw unprocessable(`${c.number} has ${c.quantity_limit - used} of ${c.quantity_limit} units remaining; ${scope.quantity} requested`);
  return { id: c.id, number: c.number };
}

export function registerNcrRoutes(app: FastifyInstance, svc: Services) {
  const { db, config } = svc;
  const today = () => dayIn(config.displayTimeZone);

  // Confirmation turns a triaged concern into an attributable NCR carrying the same identity and files (FR-015, C5).
  app.post('/api/quality/events/:id/confirm-ncr', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!uuid.safeParse(id).success) throw notFound('Quality event');
    const auth = await requireCapability(db, req, 'ncr.manage', { action: 'ncr.confirm', entityType: 'quality_event', entityId: id });
    const body = z
      .object({
        expectedVersion: z.number().int(),
        severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
        ownerId: uuid,
        rationale: z.string().trim().min(5).max(2000),
        failureMode: z.string().trim().max(300).nullable().optional(),
        defectDescription: z.string().trim().max(4000).nullable().optional(),
        recurrenceOfScarId: uuid.nullable().optional(),
        recurrenceResponseDue: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      })
      .parse(req.body);
    const created = await withTransaction(db, async (tx) => {
      const ev = await one<{
        id: string;
        number: string;
        title: string;
        description: string;
        status: string;
        reported_by: string;
        version: number;
        characteristic: string | null;
        expected: string | null;
        actual: string | null;
        part_id: string | null;
        supplier_id: string | null;
        site_id: string | null;
        source_id: string | null;
        inspection_id: string | null;
        po_number: string | null;
        lot_number: string | null;
      }>(tx, 'SELECT * FROM quality_event WHERE id = $1 FOR UPDATE', [id]);
      if (!ev) throw notFound('Quality event');
      if (ev.version !== body.expectedVersion) throw conflict('This concern was changed elsewhere. Reload and try again.');
      if (!['CAPTURED', 'TRIAGED'].includes(ev.status)) throw conflict(`This concern is ${ev.status.toLowerCase().replaceAll('_', ' ')}`);
      if (ev.reported_by === auth.userId) throw await auditedDenial(db, req, auth.userId, 'ncr.confirm', 'quality_event', id, 'A nonconformance must be confirmed by someone other than the reporter');
      if (!(await recheckCapability(tx, auth.userId, 'ncr.manage'))) throw forbidden();
      if (!(await isActiveUser(tx, body.ownerId))) throw unprocessable('The owner must be an active user');
      const number = await nextRecordNumber(tx, 'NCR');
      const ncr = await one<{ id: string }>(
        tx,
        `INSERT INTO ncr (number, quality_event_id, title, defect_description, failure_mode, characteristic, expected, actual, part_id, supplier_id,
            site_id, source_id, inspection_id, po_number, lot_number, severity, owner_id, confirmed_by, confirmation_rationale)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
        [
          number,
          ev.id,
          ev.title,
          body.defectDescription || ev.description,
          body.failureMode ?? null,
          ev.characteristic,
          ev.expected,
          ev.actual,
          ev.part_id,
          ev.supplier_id,
          ev.site_id,
          ev.source_id,
          ev.inspection_id,
          ev.po_number,
          ev.lot_number,
          body.severity,
          body.ownerId,
          auth.userId,
          body.rationale,
        ],
      );
      // Same stored files, linked (never copied) to the NCR.
      await tx.query(
        `INSERT INTO evidence_link (file_id, entity_type, entity_id, caption, linked_by)
         SELECT l.file_id, 'NCR', $1, l.caption, $2 FROM evidence_link l WHERE l.entity_type = 'QUALITY_EVENT' AND l.entity_id = $3 AND l.unlinked_at IS NULL`,
        [ncr!.id, auth.userId, ev.id],
      );
      await tx.query(
        `UPDATE quality_event SET status = 'CONFIRMED_NCR', severity = $2, owner_id = $3, triaged_by = coalesce(triaged_by, $4),
            triaged_at = coalesce(triaged_at, now()), triage_reason = coalesce(triage_reason, $5), version = version + 1 WHERE id = $1`,
        [ev.id, body.severity, body.ownerId, auth.userId, body.rationale],
      );
      await closeWork(tx, ['CONCERN_TRIAGE', 'CONCERN_FOLLOW_UP'], 'QUALITY_EVENT', ev.id, auth.userId, `Confirmed as ${number}`);
      await openWork(tx, { kind: 'NCR_ACTION', title: `${number}: record affected material and containment — ${ev.title}`, subjectType: 'NCR', subjectId: ncr!.id, assigneeId: body.ownerId });
      await audit(tx, { actorId: auth.userId, action: 'ncr.confirm', entityType: 'ncr', entityId: ncr!.id, summary: `${number} confirmed from ${ev.number} (${body.severity.toLowerCase()})`, reason: body.rationale, requestId: req.id });
      await audit(tx, { actorId: auth.userId, action: 'quality.confirmed_ncr', entityType: 'quality_event', entityId: ev.id, summary: `Confirmed as ${number}`, requestId: req.id });
      if (body.recurrenceOfScarId) {
        await linkNcrToScar(tx, req, auth.userId, body.recurrenceOfScarId, ncr!.id, 'RECURRENCE', body.rationale, body.recurrenceResponseDue ?? null);
      }
      return { id: ncr!.id, number };
    });
    return reply.code(201).send(created);
  });

  app.get('/api/ncrs', async (req) => {
    await requireCapability(db, req, 'records.read', { action: 'ncr.list', consequential: false });
    const q = z.object({ status: z.string().max(30).optional(), q: z.string().max(100).optional(), sourceId: uuid.optional(), partId: uuid.optional() }).parse(req.query);
    const params: unknown[] = [];
    const where = ['true'];
    if (q.status === 'OPEN') where.push(`n.status <> 'CLOSED'`);
    else if (q.status) {
      params.push(q.status);
      where.push(`n.status = $${params.length}`);
    }
    if (q.sourceId) {
      params.push(q.sourceId);
      where.push(`n.source_id = $${params.length}`);
    }
    if (q.partId) {
      params.push(q.partId);
      where.push(`n.part_id = $${params.length}`);
    }
    if (q.q?.trim()) {
      params.push(`%${q.q.trim().replace(/[%_\\]/g, '\\$&')}%`);
      where.push(`(n.number ILIKE $${params.length} OR n.title ILIKE $${params.length} OR n.lot_number ILIKE $${params.length} OR p.part_number ILIKE $${params.length})`);
    }
    return many(
      db,
      `SELECT n.id, n.number, n.title, n.status, n.severity, n.lot_number AS "lotNumber", n.confirmed_at AS "confirmedAt", p.part_number AS "partNumber",
              s.legal_name AS supplier, o.display_name AS owner,
              (SELECT count(*)::int FROM scar_ncr x JOIN scar sc ON sc.id = x.scar_id WHERE x.ncr_id = n.id AND sc.status <> 'CLOSED') AS "openScars"
         FROM ncr n LEFT JOIN company_part p ON p.id = n.part_id LEFT JOIN supplier s ON s.id = n.supplier_id JOIN app_user o ON o.id = n.owner_id
        WHERE ${where.join(' AND ')} ORDER BY n.confirmed_at DESC LIMIT 200`,
      params,
    );
  });

  app.get('/api/ncrs/:id', async (req) => {
    const auth = await requireCapability(db, req, 'records.read', { action: 'ncr.read', consequential: false });
    const { id } = req.params as { id: string };
    const base = await loadNcr(db, id);
    const ncr = await one<Record<string, unknown>>(
      db,
      `SELECT n.*, p.part_number, p.description AS part_description, s.legal_name AS supplier_name, ss.name AS site_name, o.display_name AS owner_name,
              c.display_name AS confirmed_by_name, cl.display_name AS closed_by_name, e.number AS event_number, e.reported_by, r.display_name AS reported_by_name,
              e.section_key, e.row_key, e.unit_index, e.serial_number, i.number AS inspection_number, sc.number AS recurrence_scar_number
         FROM ncr n JOIN quality_event e ON e.id = n.quality_event_id JOIN app_user r ON r.id = e.reported_by
         LEFT JOIN company_part p ON p.id = n.part_id LEFT JOIN supplier s ON s.id = n.supplier_id LEFT JOIN supplier_site ss ON ss.id = n.site_id
         JOIN app_user o ON o.id = n.owner_id JOIN app_user c ON c.id = n.confirmed_by LEFT JOIN app_user cl ON cl.id = n.closed_by
         LEFT JOIN inspection i ON i.id = n.inspection_id LEFT JOIN scar sc ON sc.id = n.recurrence_of_scar_id
        WHERE n.id = $1`,
      [id],
    );
    const scopes = await many<ScopeRow & Record<string, unknown>>(
      db,
      `SELECT m.*, a.display_name AS authorized_by_name, v.display_name AS verified_by_name, i.number AS inspection_number
         FROM material_scope m LEFT JOIN app_user a ON a.id = m.containment_authorized_by LEFT JOIN app_user v ON v.id = m.segregation_verified_by
         LEFT JOIN inspection i ON i.id = m.inspection_id
        WHERE m.ncr_id = $1 ORDER BY m.created_at`,
      [id],
    );
    const scopeIds = scopes.map((s) => s.id);
    const decisions = scopeIds.length
      ? await many(
          db,
          `SELECT d.id, d.scope_id AS "scopeId", d.outcome, d.quantity, d.serial_numbers AS "serialNumbers", d.instructions, d.rationale, d.decided_at AS "decidedAt",
                  d.decided_by AS "decidedById", u.display_name AS "decidedBy", d.voided_at AS "voidedAt", d.void_reason AS "voidReason", vu.display_name AS "voidedBy",
                  c.id AS "concessionId", c.number AS "concessionNumber",
                  coalesce((SELECT json_agg(json_build_object('id', v.id, 'result', v.result, 'method', v.method, 'note', v.note, 'verifiedAt', v.verified_at,
                                     'verifiedBy', vv.display_name, 'inspectionId', v.inspection_id, 'inspectionNumber', vi.number) ORDER BY v.verified_at)
                              FROM disposition_verification v JOIN app_user vv ON vv.id = v.verified_by LEFT JOIN inspection vi ON vi.id = v.inspection_id
                             WHERE v.decision_id = d.id), '[]') AS verifications
             FROM disposition_decision d JOIN app_user u ON u.id = d.decided_by LEFT JOIN app_user vu ON vu.id = d.voided_by
             LEFT JOIN concession c ON c.id = d.concession_id
            WHERE d.scope_id = ANY($1::uuid[]) ORDER BY d.decided_at`,
          [scopeIds],
        )
      : [];
    const releases = scopeIds.length
      ? await many(
          db,
          `SELECT r.id, r.scope_id AS "scopeId", r.quantity, r.note, r.released_at AS "releasedAt", u.display_name AS "releasedBy", c.number AS "concessionNumber"
             FROM material_release r JOIN app_user u ON u.id = r.released_by LEFT JOIN concession c ON c.id = r.concession_id
            WHERE r.scope_id = ANY($1::uuid[]) ORDER BY r.released_at`,
          [scopeIds],
        )
      : [];
    const scars = await many(
      db,
      `SELECT s.id, s.number, s.title, s.status, s.cycle, x.relation, s.response_due AS "responseDue" FROM scar_ncr x JOIN scar s ON s.id = x.scar_id
        WHERE x.ncr_id = $1 ORDER BY x.linked_at`,
      [id],
    );
    const concessions = await many(
      db,
      `SELECT c.id, c.number, c.status, c.lot_number AS "lotNumber", c.quantity_limit AS "quantityLimit", c.valid_from::text AS "validFrom", c.valid_until::text AS "validUntil",
              c.characteristic, (SELECT coalesce(sum(quantity), 0)::int FROM concession_use u WHERE u.concession_id = c.id AND u.released_at IS NULL) AS used
         FROM concession c WHERE c.ncr_id = $1 ORDER BY c.requested_at`,
      [id],
    );
    // Earlier evidence for recurrence analysis: FAI history (including rejected samples), prior NCRs, approvals, commitments (AT-08, FR-070).
    const related = {
      fais: base.source_id
        ? await many(
            db,
            `SELECT f.id, f.number, f.sample_type AS "sampleType", f.status, f.decision, f.defects, f.conditions, f.corrective_rationale AS "correctiveRationale",
                    f.decided_at AS "decidedAt", f.lot_number AS "lotNumber",
                    coalesce((SELECT json_agg(json_build_object('charName', r.char_name, 'value', r.value_text, 'evaluation', r.evaluation, 'unit', r.unit) ORDER BY r.char_key)
                                FROM fai_result r WHERE r.fai_id = f.id), '[]') AS results
               FROM fai_sample f WHERE f.source_id = $1 ORDER BY f.sequence`,
            [base.source_id],
          )
        : [],
      approvals: base.source_id
        ? await many(
            db,
            `SELECT d.id, d.number, d.decision, d.scope, d.conditions, d.decided_at AS "decidedAt", d.manifest_sha256 AS "manifestSha256", u.display_name AS approver
               FROM source_approval_decision d JOIN app_user u ON u.id = d.approver_id WHERE d.source_id = $1 ORDER BY d.decided_at`,
            [base.source_id],
          )
        : [],
      priorNcrs: base.part_id
        ? await many(
            db,
            `SELECT n.id, n.number, n.title, n.status, n.failure_mode AS "failureMode", n.lot_number AS "lotNumber", n.confirmed_at AS "confirmedAt",
                    (n.source_id IS NOT DISTINCT FROM $3) AS "sameSource"
               FROM ncr n WHERE n.part_id = $1 AND n.id <> $2 ORDER BY n.confirmed_at DESC LIMIT 20`,
            [base.part_id, id, base.source_id],
          )
        : [],
      commitments: await many(
        db,
        `SELECT c.id, c.number, c.promised_action AS "promisedAction", c.status, c.due_date AS "dueDate" FROM supplier_commitment c
          WHERE c.ncr_id = $1 OR (c.scar_id IN (SELECT scar_id FROM scar_ncr WHERE ncr_id = $1)) ORDER BY c.recorded_at`,
        [id],
      ),
      sourceStatus: base.source_id ? ((await effectiveSourceStatuses(db, [base.source_id])).get(base.source_id) ?? null) : null,
    };
    const inspections = base.part_id
      ? await many(
          db,
          `SELECT i.id, i.number, i.lot_number AS "lotNumber", i.outcome, i.status, i.completed_at AS "completedAt" FROM inspection i
            WHERE i.part_id = $1 AND i.status = 'COMPLETED' ORDER BY i.completed_at DESC LIMIT 30`,
          [base.part_id],
        )
      : [];
    const reporterId = (ncr as { reported_by: string }).reported_by;
    const deciders = new Set(decisions.filter((d) => !(d as { voidedAt: unknown }).voidedAt).map((d) => (d as { decidedById: string }).decidedById));
    return {
      ncr: { ...ncr, statusText: NCR_STATUS_TEXT[base.status] },
      files: await linkedFiles(db, 'NCR', id),
      scopes,
      decisions,
      releases,
      scars,
      concessions,
      related,
      inspections,
      history: await history(db, 'ncr', [id]),
      renditions: await renditions(db, 'NCR', id),
      rule: DISPOSITION_RULE,
      permissions: {
        manage: has(auth, 'ncr.manage') && base.status !== 'CLOSED',
        authorizeContainment: has(auth, 'containment.authorize'),
        verifySegregation: has(auth, 'containment.verify'),
        disposition: has(auth, 'material.disposition'),
        verifyDisposition: has(auth, 'disposition.verify'),
        release: has(auth, 'material.release') && !deciders.has(auth.userId),
        releaseBlockedReason: has(auth, 'material.release') && deciders.has(auth.userId) ? 'Release must be done by someone other than the disposition decider.' : null,
        requestConcession: has(auth, 'concession.request'),
        issueScar: has(auth, 'scar.manage'),
        isReporter: reporterId === auth.userId,
      },
    };
  });

  app.post('/api/ncrs/:id/scopes', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'ncr.manage', { action: 'ncr.scope', entityType: 'ncr', entityId: id });
    const body = z
      .object({
        label: z.string().trim().min(2).max(200),
        lotNumber: z.string().trim().min(1).max(80),
        poNumber: z.string().trim().max(60).nullable().optional(),
        inspectionId: uuid.nullable().optional(),
        quantity: z.number().int().min(1).max(1_000_000),
        serialNumbers: serialList,
        location: z.string().trim().max(200).nullable().optional(),
        containmentAction: z.string().trim().min(5).max(2000),
      })
      .parse(req.body);
    if (new Set(body.serialNumbers).size !== body.serialNumbers.length) throw unprocessable('Serial numbers must be unique');
    if (body.serialNumbers.length > body.quantity) throw unprocessable('More serial numbers than the affected quantity');
    const created = await withTransaction(db, async (tx) => {
      const ncr = await loadNcr(tx, id, true);
      if (ncr.status === 'CLOSED') throw conflict(`${ncr.number} is closed`);
      if (body.inspectionId) {
        const insp = await one<{ part_id: string | null }>(tx, 'SELECT part_id FROM inspection WHERE id = $1', [body.inspectionId]);
        if (!insp || insp.part_id !== ncr.part_id) throw unprocessable('The inspection is not for the NCR part');
      }
      const scope = await one<{ id: string }>(
        tx,
        `INSERT INTO material_scope (ncr_id, label, lot_number, po_number, inspection_id, quantity, serial_numbers, location, containment_action, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [id, body.label, body.lotNumber, body.poNumber ?? null, body.inspectionId ?? null, body.quantity, body.serialNumbers, body.location ?? null, body.containmentAction, auth.userId],
      );
      await recomputeNcr(tx, id);
      await openWork(tx, {
        kind: 'CONTAINMENT_AUTHORIZATION',
        title: `${ncr.number}: authorize containment of lot ${body.lotNumber} (${body.quantity})`,
        subjectType: 'MATERIAL_SCOPE',
        subjectId: scope!.id,
        capability: 'containment.authorize',
      });
      await audit(tx, {
        actorId: auth.userId,
        action: 'ncr.scope',
        entityType: 'ncr',
        entityId: id,
        summary: `Affected material recorded: ${body.label}, lot ${body.lotNumber}, quantity ${body.quantity}${body.serialNumbers.length ? `, serials ${body.serialNumbers.join(', ')}` : ''}`,
        after: { scopeId: scope!.id },
        requestId: req.id,
      });
      return { id: scope!.id };
    });
    return reply.code(201).send(created);
  });

  app.post('/api/scopes/:id/authorize-containment', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'containment.authorize', { action: 'ncr.containment_authorize', entityType: 'material_scope', entityId: id });
    const body = z.object({ note: z.string().trim().max(1000).nullable().optional() }).parse(req.body ?? {});
    return withTransaction(db, async (tx) => {
      const scope = await loadScope(tx, id);
      if (scope.containment_authorized_at) throw conflict('Containment is already authorized');
      if (!(await recheckCapability(tx, auth.userId, 'containment.authorize'))) throw forbidden();
      await tx.query('UPDATE material_scope SET containment_authorized_by = $2, containment_authorized_at = now(), version = version + 1 WHERE id = $1', [id, auth.userId]);
      await closeWork(tx, ['CONTAINMENT_AUTHORIZATION'], 'MATERIAL_SCOPE', id, auth.userId, 'Containment authorized');
      await openWork(tx, {
        kind: 'SEGREGATION_VERIFICATION',
        title: `${scope.ncr.number}: verify lot ${scope.lot_number} is physically segregated`,
        subjectType: 'MATERIAL_SCOPE',
        subjectId: id,
        capability: 'containment.verify',
      });
      await audit(tx, { actorId: auth.userId, action: 'ncr.containment_authorize', entityType: 'ncr', entityId: scope.ncr_id, summary: `Containment of ${scope.label} authorized`, reason: body.note ?? null, requestId: req.id });
      return { ok: true };
    });
  });

  app.post('/api/scopes/:id/verify-segregation', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'containment.verify', { action: 'ncr.segregation_verify', entityType: 'material_scope', entityId: id });
    const body = z.object({ note: z.string().trim().min(5).max(2000) }).parse(req.body);
    return withTransaction(db, async (tx) => {
      const scope = await loadScope(tx, id);
      if (!scope.containment_authorized_at) throw conflict('Containment must be authorized before segregation is verified');
      if (scope.segregation_verified_at) throw conflict('Segregation is already verified');
      await tx.query(
        'UPDATE material_scope SET segregation_verified_by = $2, segregation_verified_at = now(), segregation_note = $3, version = version + 1 WHERE id = $1',
        [id, auth.userId, body.note],
      );
      const status = await recomputeNcr(tx, scope.ncr_id);
      await closeWork(tx, ['SEGREGATION_VERIFICATION'], 'MATERIAL_SCOPE', id, auth.userId, 'Segregation verified');
      await openWork(tx, {
        kind: 'DISPOSITION_DECISION',
        title: `${scope.ncr.number}: decide disposition of lot ${scope.lot_number} (${scope.quantity})`,
        subjectType: 'MATERIAL_SCOPE',
        subjectId: id,
        capability: 'material.disposition',
      });
      await audit(tx, {
        actorId: auth.userId,
        action: 'ncr.segregation_verify',
        entityType: 'ncr',
        entityId: scope.ncr_id,
        summary: `Physical segregation of ${scope.label} verified (no ERP stock movement recorded)`,
        reason: body.note,
        requestId: req.id,
      });
      return { ok: true, ncrStatus: status };
    });
  });

  app.post('/api/scopes/:id/dispositions', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'material.disposition', { action: 'ncr.disposition', entityType: 'material_scope', entityId: id });
    const body = z
      .object({
        outcome: z.enum(DISPOSITION_OUTCOMES),
        quantity: z.number().int().min(1),
        serialNumbers: serialList,
        concessionId: uuid.nullable().optional(),
        instructions: z.string().trim().max(2000).nullable().optional(),
        rationale: z.string().trim().min(5).max(2000),
      })
      .parse(req.body);
    const created = await withTransaction(db, async (tx) => {
      const scope = await loadScope(tx, id);
      if (!(await recheckCapability(tx, auth.userId, 'material.disposition'))) throw forbidden();
      if (!scope.segregation_verified_at) throw conflict('Physical segregation must be verified before a disposition is decided');
      const existing = await decisionsFor(tx, [id]);
      const allocated = existing.filter((d) => !d.voided_at).reduce((n, d) => n + d.quantity, 0);
      if (allocated + body.quantity > scope.quantity)
        throw unprocessable(`Only ${scope.quantity - allocated} of ${scope.quantity} units remain to be dispositioned; one sample's disposition never covers the whole lot`);
      if (body.serialNumbers.length > body.quantity) throw unprocessable('More serial numbers than the decided quantity');
      if (scope.serial_numbers.length) {
        const unknown = body.serialNumbers.filter((s) => !scope.serial_numbers.includes(s));
        if (unknown.length) throw unprocessable(`Serial(s) ${unknown.join(', ')} are not in this affected material`);
        const taken = new Set(existing.filter((d) => !d.voided_at).flatMap((d) => d.serial_numbers));
        const dup = body.serialNumbers.filter((s) => taken.has(s));
        if (dup.length) throw unprocessable(`Serial(s) ${dup.join(', ')} already have a disposition`);
      }
      let concession: { id: string; number: string } | null = null;
      if (body.outcome === 'USE_AS_IS') {
        if (!body.concessionId) throw unprocessable('Use as is requires a current, approved concession for this lot (NEG-06)');
        concession = await assertConcessionCovers(tx, body.concessionId, { partId: scope.ncr.part_id, sourceId: scope.ncr.source_id, lotNumber: scope.lot_number, quantity: body.quantity }, today());
      } else if (body.concessionId) throw unprocessable('A concession applies only to a use-as-is disposition');
      const d = await one<{ id: string }>(
        tx,
        `INSERT INTO disposition_decision (scope_id, outcome, quantity, serial_numbers, concession_id, instructions, rationale, decided_by, grants_used)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [id, body.outcome, body.quantity, body.serialNumbers, concession?.id ?? null, body.instructions ?? null, body.rationale, auth.userId, ['material.disposition']],
      );
      if (concession) {
        await tx.query('INSERT INTO concession_use (concession_id, quantity, disposition_decision_id, used_by) VALUES ($1,$2,$3,$4)', [concession.id, body.quantity, d!.id, auth.userId]);
      }
      await recomputeNcr(tx, scope.ncr_id);
      if (allocated + body.quantity === scope.quantity) await closeWork(tx, ['DISPOSITION_DECISION'], 'MATERIAL_SCOPE', id, auth.userId, 'Fully dispositioned');
      await openWork(tx, {
        kind: 'DISPOSITION_VERIFICATION',
        title: `${scope.ncr.number}: verify ${DISPOSITION_TEXT[body.outcome].label.toLowerCase()} of ${body.quantity} from lot ${scope.lot_number}`,
        subjectType: 'MATERIAL_SCOPE',
        subjectId: id,
        capability: 'disposition.verify',
      });
      await audit(tx, {
        actorId: auth.userId,
        action: 'ncr.disposition',
        entityType: 'ncr',
        entityId: scope.ncr_id,
        summary: `${DISPOSITION_TEXT[body.outcome].label}: ${body.quantity} of lot ${scope.lot_number}${concession ? ` under ${concession.number}` : ''}`,
        reason: body.rationale,
        after: { decisionId: d!.id, rule: DISPOSITION_RULE },
        requestId: req.id,
      });
      return { id: d!.id };
    });
    return reply.code(201).send(created);
  });

  app.post('/api/dispositions/:id/void', async (req) => {
    const { id } = req.params as { id: string };
    if (!uuid.safeParse(id).success) throw notFound('Disposition');
    const auth = await requireCapability(db, req, 'material.disposition', { action: 'ncr.disposition_void', entityType: 'disposition_decision', entityId: id });
    const body = z.object({ reason: z.string().trim().min(5).max(2000) }).parse(req.body);
    return withTransaction(db, async (tx) => {
      const d = await one<{ scope_id: string; voided_at: Date | null; outcome: string; quantity: number }>(tx, 'SELECT scope_id, voided_at, outcome, quantity FROM disposition_decision WHERE id = $1 FOR UPDATE', [id]);
      if (!d) throw notFound('Disposition');
      const scope = await loadScope(tx, d.scope_id);
      if (d.voided_at) throw conflict('This disposition is already void');
      if ((await decisionsFor(tx, [d.scope_id])).find((x) => x.id === id)?.verified) throw conflict('A verified disposition cannot be voided');
      await tx.query('UPDATE disposition_decision SET voided_by = $2, voided_at = now(), void_reason = $3 WHERE id = $1', [id, auth.userId, body.reason]);
      await tx.query('UPDATE concession_use SET released_at = now() WHERE disposition_decision_id = $1 AND released_at IS NULL', [id]);
      await recomputeNcr(tx, scope.ncr_id);
      await openWork(tx, { kind: 'DISPOSITION_DECISION', title: `${scope.ncr.number}: decide disposition of lot ${scope.lot_number}`, subjectType: 'MATERIAL_SCOPE', subjectId: d.scope_id, capability: 'material.disposition' });
      await audit(tx, { actorId: auth.userId, action: 'ncr.disposition_void', entityType: 'ncr', entityId: scope.ncr_id, summary: `${DISPOSITION_TEXT[d.outcome as keyof typeof DISPOSITION_TEXT].label} of ${d.quantity} voided (kept on record)`, reason: body.reason, requestId: req.id });
      return { ok: true };
    });
  });

  // Verification proves the disposition happened; a supplier claim or a different lot is not proof (NEG-07, NEG-08).
  app.post('/api/dispositions/:id/verify', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!uuid.safeParse(id).success) throw notFound('Disposition');
    const auth = await requireCapability(db, req, 'disposition.verify', { action: 'ncr.disposition_verify', entityType: 'disposition_decision', entityId: id });
    const body = z
      .object({
        result: z.enum(['VERIFIED', 'REJECTED']),
        method: z.string().trim().min(3).max(300),
        note: z.string().trim().min(5).max(2000),
        inspectionId: uuid.nullable().optional(),
      })
      .parse(req.body);
    const fail = async (message: string) => {
      await audit(db, { actorId: auth.userId, action: 'ncr.disposition_verify', outcome: 'FAILED', entityType: 'disposition_decision', entityId: id, summary: `Verification refused: ${message}`, requestId: req.id });
      return unprocessable(message);
    };
    const out = await withTransaction(db, async (tx) => {
      const d = await one<{ id: string; scope_id: string; outcome: string; quantity: number; serial_numbers: string[]; concession_id: string | null; decided_at: Date; voided_at: Date | null }>(
        tx,
        'SELECT * FROM disposition_decision WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!d) throw notFound('Disposition');
      const scope = await loadScope(tx, d.scope_id);
      if (d.voided_at) throw conflict('This disposition is void');
      if ((await decisionsFor(tx, [d.scope_id])).find((x) => x.id === id)?.verified) throw conflict('This disposition is already verified');
      if (!(await recheckCapability(tx, auth.userId, 'disposition.verify'))) throw forbidden();
      if (body.result === 'VERIFIED') {
        if (needsReinspection(d.outcome)) {
          if (!body.inspectionId) throw await fail('Rework or repair is verified only by a PDI reinspection of the affected material');
          const insp = await one<{ number: string; status: string; outcome: string | null; part_id: string | null; lot_number: string | null; completed_at: Date | null; form_snapshot: { sections: Array<{ key: string }> } }>(
            tx,
            'SELECT number, status, outcome, part_id, lot_number, completed_at, form_snapshot FROM inspection WHERE id = $1',
            [body.inspectionId],
          );
          if (!insp || insp.status !== 'COMPLETED') throw await fail('The reinspection must be a completed inspection');
          if (insp.part_id !== scope.ncr.part_id) throw await fail(`${insp.number} is for a different part`);
          if ((insp.lot_number ?? '').trim().toUpperCase() !== scope.lot_number.trim().toUpperCase())
            throw await fail(`Evidence mismatch: ${insp.number} inspected lot ${insp.lot_number ?? 'unknown'}, not the affected lot ${scope.lot_number}. A passing replacement lot does not prove this material was reworked; the hold stays in place.`);
          if (!insp.completed_at || insp.completed_at <= d.decided_at) throw await fail(`${insp.number} was completed before the ${d.outcome.toLowerCase()} was decided`);
          if (insp.outcome === 'FAIL') throw await fail(`${insp.number} failed; the material does not conform yet`);
          const ev = await one<{ section_key: string | null; row_key: string | null; characteristic: string | null }>(
            tx,
            'SELECT e.section_key, e.row_key, e.characteristic FROM quality_event e WHERE e.id = $1',
            [scope.ncr.quality_event_id],
          );
          if (ev?.section_key && ev.row_key) {
            // The same characteristic must now conform on every reinspected unit that recorded it.
            const re = await loadInspection(tx, body.inspectionId);
            const ids = Object.keys(re.evaluation.rows).filter((k) => k.endsWith(`|${ev.section_key}|${ev.row_key}`));
            const results = ids.map((k) => ({ status: re.responses[k]?.status ?? null, m: re.evaluation.rows[k]!.measurement }));
            const recorded = results.filter((r) => r.status !== null && r.status !== 'N');
            const conforming = recorded.filter((r) => r.status === 'P' && (r.m === null || r.m === 'WITHIN'));
            if (!recorded.length || conforming.length !== recorded.length)
              throw await fail(`${insp.number} does not show the failed characteristic (${ev.characteristic ?? ev.row_key}) conforming against a released limit on every reinspected item`);
          }
          if (d.serial_numbers.length) {
            const serials = (await many<{ serial_number: string | null }>(tx, 'SELECT serial_number FROM inspection_unit WHERE inspection_id = $1', [body.inspectionId])).map((u) =>
              (u.serial_number ?? '').trim(),
            );
            const missing = d.serial_numbers.filter((s) => !serials.includes(s));
            if (missing.length) throw await fail(`${insp.number} does not include serial(s) ${missing.join(', ')}`);
          }
        } else if (d.outcome === 'USE_AS_IS') {
          const c = await one<{ number: string; valid_until: string; valid_from: string; status: string }>(
            tx,
            'SELECT number, valid_until::text, valid_from::text, status FROM concession WHERE id = $1',
            [d.concession_id],
          );
          const t = today();
          if (!c || c.status !== 'APPROVED' || t > c.valid_until || t < c.valid_from) throw await fail(`${c?.number ?? 'The concession'} is not current; use as is cannot be verified`);
        } else if (body.inspectionId) throw await fail('A return or scrap is verified by its shipment or scrap record, not an inspection');
      }
      const v = await one<{ id: string }>(
        tx,
        `INSERT INTO disposition_verification (decision_id, result, method, inspection_id, note, verified_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [id, body.result, body.method, body.inspectionId ?? null, body.note, auth.userId],
      );
      const status = await recomputeNcr(tx, scope.ncr_id);
      const after = await one<{ state: string }>(tx, 'SELECT state FROM material_scope WHERE id = $1', [d.scope_id]);
      if (after!.state === 'VERIFIED_RESOLVED') {
        await closeWork(tx, ['DISPOSITION_VERIFICATION'], 'MATERIAL_SCOPE', d.scope_id, auth.userId, 'All dispositions verified');
        const usable = (await decisionsFor(tx, [d.scope_id])).filter((x) => !x.voided_at && isUsableOutcome(x.outcome));
        if (usable.length) {
          await openWork(tx, {
            kind: 'MATERIAL_RELEASE',
            title: `${scope.ncr.number}: release verified material from lot ${scope.lot_number}`,
            subjectType: 'MATERIAL_SCOPE',
            subjectId: d.scope_id,
            capability: 'material.release',
          });
        }
      }
      if (status === 'VERIFIED_RESOLVED') await openWork(tx, { kind: 'NCR_ACTION', title: `${scope.ncr.number}: material resolved — close the NCR`, subjectType: 'NCR', subjectId: scope.ncr_id, assigneeId: scope.ncr.owner_id });
      await audit(tx, {
        actorId: auth.userId,
        action: 'ncr.disposition_verify',
        entityType: 'ncr',
        entityId: scope.ncr_id,
        summary: `${DISPOSITION_TEXT[d.outcome as keyof typeof DISPOSITION_TEXT].label} of ${d.quantity} ${body.result === 'VERIFIED' ? 'verified' : 'NOT verified'} (${body.method})`,
        reason: body.note,
        after: { verificationId: v!.id, inspectionId: body.inspectionId ?? null },
        requestId: req.id,
      });
      return { id: v!.id, ncrStatus: status };
    });
    return reply.code(201).send(out);
  });

  // Release is a separate, independent action; a use-as-is release needs its concession to be current today (AT-14).
  app.post('/api/scopes/:id/release', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'material.release', { action: 'ncr.release', entityType: 'material_scope', entityId: id });
    const body = z.object({ note: z.string().trim().min(5).max(2000) }).parse(req.body);
    return withTransaction(db, async (tx) => {
      const scope = await loadScope(tx, id);
      if (scope.state !== 'VERIFIED_RESOLVED') throw conflict(`Material can be released only after every disposition is verified (now: ${scope.state.toLowerCase().replaceAll('_', ' ')})`);
      if (!(await recheckCapability(tx, auth.userId, 'material.release'))) throw forbidden();
      const usable = (await decisionsFor(tx, [id])).filter((d) => !d.voided_at && isUsableOutcome(d.outcome));
      if (!usable.length) throw conflict('No usable material: everything was returned or scrapped');
      if (usable.some((d) => d.decided_by === auth.userId)) {
        throw await auditedDenial(db, req, auth.userId, 'ncr.release', 'material_scope', id, 'Release must be performed by someone other than the disposition decider');
      }
      const t = today();
      for (const d of usable.filter((x) => x.outcome === 'USE_AS_IS')) {
        const c = await one<{ number: string; valid_until: string; valid_from: string; status: string }>(tx, 'SELECT number, valid_until::text, valid_from::text, status FROM concession WHERE id = $1', [
          d.concession_id,
        ]);
        if (!c || c.status !== 'APPROVED' || t > c.valid_until || t < c.valid_from) {
          await audit(db, { actorId: auth.userId, action: 'ncr.release', outcome: 'FAILED', entityType: 'material_scope', entityId: id, summary: `Release refused: ${c?.number} not current on ${t}`, requestId: req.id });
          throw unprocessable(`${c?.number ?? 'The concession'} is not valid on ${t}; the material stays on hold`);
        }
      }
      for (const d of usable) {
        await tx.query('INSERT INTO material_release (scope_id, quantity, concession_id, note, released_by, grants_used) VALUES ($1,$2,$3,$4,$5,$6)', [
          id,
          d.quantity,
          d.concession_id,
          body.note,
          auth.userId,
          ['material.release'],
        ]);
      }
      const status = await recomputeNcr(tx, scope.ncr_id);
      await closeWork(tx, ['MATERIAL_RELEASE'], 'MATERIAL_SCOPE', id, auth.userId, 'Released');
      const qty = usable.reduce((n, d) => n + d.quantity, 0);
      await audit(tx, {
        actorId: auth.userId,
        action: 'ncr.release',
        entityType: 'ncr',
        entityId: scope.ncr_id,
        summary: `${qty} unit(s) of lot ${scope.lot_number} released from the TQMS hold (record only; no ERP stock movement)`,
        reason: body.note,
        requestId: req.id,
      });
      return { released: qty, ncrStatus: status };
    });
  });

  app.post('/api/ncrs/:id/close', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'ncr.manage', { action: 'ncr.close', entityType: 'ncr', entityId: id });
    const body = z.object({ note: z.string().trim().min(5).max(2000), expectedVersion: z.number().int() }).parse(req.body);
    return withTransaction(db, async (tx) => {
      const ncr = await loadNcr(tx, id, true);
      if (ncr.version !== body.expectedVersion) throw conflict('This NCR was changed elsewhere. Reload and try again.');
      const status = await recomputeNcr(tx, id);
      if (status === 'CLOSED') throw conflict(`${ncr.number} is already closed`);
      if (status !== 'VERIFIED_RESOLVED') {
        await audit(db, { actorId: auth.userId, action: 'ncr.close', outcome: 'FAILED', entityType: 'ncr', entityId: id, summary: `Close refused: ${NCR_STATUS_TEXT[status]}`, requestId: req.id });
        throw unprocessable(`${ncr.number} cannot close: ${NCR_STATUS_TEXT[status]?.toLowerCase()}. Every affected quantity needs a verified disposition first.`);
      }
      if (!(await recheckCapability(tx, auth.userId, 'ncr.manage'))) throw forbidden();
      await tx.query(`UPDATE ncr SET status = 'CLOSED', closed_by = $2, closed_at = now(), closure_note = $3, version = version + 1 WHERE id = $1`, [id, auth.userId, body.note]);
      await closeWork(tx, ['NCR_ACTION'], 'NCR', id, auth.userId, 'NCR closed');
      const openScars = await many<{ number: string }>(tx, `SELECT s.number FROM scar_ncr x JOIN scar s ON s.id = x.scar_id WHERE x.ncr_id = $1 AND s.status <> 'CLOSED'`, [id]);
      await audit(tx, {
        actorId: auth.userId,
        action: 'ncr.close',
        entityType: 'ncr',
        entityId: id,
        summary: `${ncr.number} closed after verified material resolution${openScars.length ? `; ${openScars.map((s) => s.number).join(', ')} stays open` : ''}`,
        reason: body.note,
        requestId: req.id,
      });
      return { status: 'CLOSED', openScars: openScars.map((s) => s.number) };
    });
  });

  app.post('/api/ncrs/:id/report', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'ncr.manage', { action: 'ncr.report', entityType: 'ncr', entityId: id });
    const out = await withTransaction(db, async (tx) => {
      const ncr = await loadNcr(tx, id, true);
      const content = await buildNcrReport(tx, id, config.displayTimeZone);
      const issued = await issueRecordEdition(tx, 'NCR', id, (edition) => ({ ...content, edition }));
      await audit(tx, { actorId: auth.userId, action: 'ncr.report', entityType: 'ncr', entityId: id, summary: `${ncr.number} OPS-06 edition ${issued.edition} issued`, requestId: req.id });
      return issued;
    });
    return reply.code(201).send(out);
  });
}
