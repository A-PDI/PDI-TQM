import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SCAR_STATUS_TEXT, dayIn } from '../../shared/quality.js';
import { audit } from '../audit.js';
import { auditedDenial, has, recheckCapability, requireCapability } from '../auth.js';
import { type Queryable, many, one, withTransaction } from '../db.js';
import { conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { nextRecordNumber } from '../numbering.js';
import type { Services } from '../services.js';
import { closeWork, history, isActiveUser, isoDate, issueRecordEdition, linkedFiles, openWork, renditions, uuid } from './common.js';
import { buildScarReport } from './reports.js';

const CHANNELS = ['EMAIL', 'PORTAL', 'MEETING', 'CALL', 'MAIL', 'OTHER'] as const;

interface ScarRow {
  id: string;
  number: string;
  supplier_id: string;
  site_id: string | null;
  source_id: string | null;
  part_id: string | null;
  title: string;
  status: string;
  cycle: number;
  owner_id: string;
  issued_by: string;
  effectiveness_plan: string | null;
  response_due: string;
  version: number;
}

async function loadScar(db: Queryable, id: string, lock = false): Promise<ScarRow> {
  if (!uuid.safeParse(id).success) throw notFound('SCAR');
  const s = await one<ScarRow>(db, `SELECT *, response_due::text FROM scar WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!s) throw notFound('SCAR');
  return s;
}

/**
 * Links an NCR to a SCAR. A recurrence after implementation was verified (or after closure)
 * reopens the SCAR into a new cycle; earlier responses and verifications stay frozen (C5).
 */
export async function linkNcrToScar(
  tx: Queryable,
  req: FastifyRequest,
  actorId: string,
  scarId: string,
  ncrId: string,
  relation: 'ORIGIN' | 'RECURRENCE',
  reason: string,
  responseDue: string | null,
): Promise<{ reopened: boolean }> {
  const scar = await loadScar(tx, scarId, true);
  const ncr = await one<{ number: string; supplier_id: string | null }>(tx, 'SELECT number, supplier_id FROM ncr WHERE id = $1', [ncrId]);
  if (!ncr) throw notFound('NCR');
  if (ncr.supplier_id !== scar.supplier_id) throw unprocessable(`${ncr.number} is not for the SCAR supplier`);
  if (await one(tx, 'SELECT 1 FROM scar_ncr WHERE scar_id = $1 AND ncr_id = $2', [scarId, ncrId])) throw conflict(`${ncr.number} is already linked to ${scar.number}`);
  await tx.query('INSERT INTO scar_ncr (scar_id, ncr_id, relation, linked_by) VALUES ($1,$2,$3,$4)', [scarId, ncrId, relation, actorId]);
  let reopened = false;
  if (relation === 'RECURRENCE') {
    await tx.query('UPDATE ncr SET recurrence_of_scar_id = $2, version = version + 1 WHERE id = $1', [ncrId, scarId]);
    if (['IMPLEMENTATION_VERIFIED', 'EFFECTIVENESS_VERIFIED', 'CLOSED'].includes(scar.status)) {
      if (!responseDue) throw unprocessable('A new supplier response due date is required to reopen the SCAR');
      await tx.query(
        `UPDATE scar SET status = 'ISSUED', cycle = cycle + 1, response_due = $2, closed_by = NULL, closed_at = NULL, closure_note = NULL, version = version + 1 WHERE id = $1`,
        [scarId, responseDue],
      );
      await tx.query('INSERT INTO scar_reopen (scar_id, ncr_id, from_status, to_cycle, reason, reopened_by) VALUES ($1,$2,$3,$4,$5,$6)', [
        scarId,
        ncrId,
        scar.status,
        scar.cycle + 1,
        reason,
        actorId,
      ]);
      await closeWork(tx, ['SCAR_VERIFICATION'], 'SCAR', scarId, actorId, 'Reopened by recurrence');
      await openWork(tx, { kind: 'SCAR_RESPONSE', title: `${scar.number} reopened by ${ncr.number}: revised supplier response`, subjectType: 'SCAR', subjectId: scarId, assigneeId: scar.owner_id, dueAt: responseDue });
      reopened = true;
    }
  }
  await audit(tx, {
    actorId,
    action: relation === 'RECURRENCE' ? 'scar.recurrence' : 'scar.link_ncr',
    entityType: 'scar',
    entityId: scarId,
    summary: relation === 'RECURRENCE' ? `Recurrence ${ncr.number} linked${reopened ? `; reopened as cycle ${scar.cycle + 1} (earlier results kept)` : ''}` : `${ncr.number} linked`,
    reason,
    requestId: req.id,
  });
  return { reopened };
}

export function registerScarRoutes(app: FastifyInstance, svc: Services) {
  const { db, config } = svc;

  app.post('/api/scars', async (req, reply) => {
    const auth = await requireCapability(db, req, 'scar.manage', { action: 'scar.issue' });
    const body = z
      .object({
        ncrIds: z.array(uuid).max(20).default([]),
        supplierId: uuid,
        siteId: uuid.nullable().optional(),
        sourceId: uuid.nullable().optional(),
        partId: uuid.nullable().optional(),
        title: z.string().trim().min(3).max(200),
        problemStatement: z.string().trim().min(10).max(4000),
        requestedActions: z.string().trim().max(4000).nullable().optional(),
        sentTo: z.string().trim().min(2).max(200),
        sentVia: z.enum(CHANNELS),
        responseDue: isoDate,
        ownerId: uuid,
      })
      .parse(req.body);
    const created = await withTransaction(db, async (tx) => {
      if (!(await isActiveUser(tx, body.ownerId))) throw unprocessable('The owner must be an active user');
      if (body.siteId && !(await one(tx, 'SELECT 1 FROM supplier_site WHERE id = $1 AND supplier_id = $2', [body.siteId, body.supplierId]))) throw unprocessable('The site does not belong to this supplier');
      if (body.sourceId && !(await one(tx, 'SELECT 1 FROM source WHERE id = $1 AND supplier_id = $2', [body.sourceId, body.supplierId]))) throw unprocessable('The source does not belong to this supplier');
      const number = await nextRecordNumber(tx, 'SCAR');
      const s = await one<{ id: string }>(
        tx,
        `INSERT INTO scar (number, supplier_id, site_id, source_id, part_id, title, problem_statement, requested_actions, sent_to, sent_via, response_due, owner_id, issued_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [
          number,
          body.supplierId,
          body.siteId ?? null,
          body.sourceId ?? null,
          body.partId ?? null,
          body.title,
          body.problemStatement,
          body.requestedActions ?? null,
          body.sentTo,
          body.sentVia,
          body.responseDue,
          body.ownerId,
          auth.userId,
        ],
      );
      await audit(tx, { actorId: auth.userId, action: 'scar.issue', entityType: 'scar', entityId: s!.id, summary: `${number} issued to ${body.sentTo} via ${body.sentVia.toLowerCase()}; response due ${body.responseDue}`, requestId: req.id });
      for (const ncrId of body.ncrIds) await linkNcrToScar(tx, req, auth.userId, s!.id, ncrId, 'ORIGIN', 'Issued from the nonconformance', null);
      await openWork(tx, { kind: 'SCAR_RESPONSE', title: `${number}: supplier response due — ${body.title}`, subjectType: 'SCAR', subjectId: s!.id, assigneeId: body.ownerId, dueAt: body.responseDue });
      return { id: s!.id, number };
    });
    return reply.code(201).send(created);
  });

  app.get('/api/scars', async (req) => {
    await requireCapability(db, req, 'records.read', { action: 'scar.list', consequential: false });
    const q = z.object({ status: z.string().max(30).optional(), supplierId: uuid.optional() }).parse(req.query);
    const params: unknown[] = [];
    const where = ['true'];
    if (q.status === 'OPEN') where.push(`s.status <> 'CLOSED'`);
    else if (q.status) {
      params.push(q.status);
      where.push(`s.status = $${params.length}`);
    }
    if (q.supplierId) {
      params.push(q.supplierId);
      where.push(`s.supplier_id = $${params.length}`);
    }
    return many(
      db,
      `SELECT s.id, s.number, s.title, s.status, s.cycle, s.response_due AS "responseDue", s.issued_at AS "issuedAt", sup.legal_name AS supplier, o.display_name AS owner,
              (s.status = 'ISSUED' AND s.response_due < $${params.length + 1}::date) AS overdue
         FROM scar s JOIN supplier sup ON sup.id = s.supplier_id JOIN app_user o ON o.id = s.owner_id
        WHERE ${where.join(' AND ')} ORDER BY s.issued_at DESC LIMIT 200`,
      [...params, dayIn(config.displayTimeZone)],
    );
  });

  app.get('/api/scars/:id', async (req) => {
    const auth = await requireCapability(db, req, 'records.read', { action: 'scar.read', consequential: false });
    const { id } = req.params as { id: string };
    const s = await loadScar(db, id);
    const scar = await one(
      db,
      `SELECT s.*, s.response_due::text AS response_due, sup.legal_name AS supplier_name, ss.name AS site_name, p.part_number, o.display_name AS owner_name,
              i.display_name AS issued_by_name, c.display_name AS closed_by_name
         FROM scar s JOIN supplier sup ON sup.id = s.supplier_id LEFT JOIN supplier_site ss ON ss.id = s.site_id LEFT JOIN company_part p ON p.id = s.part_id
         JOIN app_user o ON o.id = s.owner_id JOIN app_user i ON i.id = s.issued_by LEFT JOIN app_user c ON c.id = s.closed_by
        WHERE s.id = $1`,
      [id],
    );
    const responses = await many(
      db,
      `SELECT r.*, u.display_name AS recorded_by_name FROM scar_response r JOIN app_user u ON u.id = r.recorded_by WHERE r.scar_id = $1 ORDER BY r.revision`,
      [id],
    );
    const verifications = await many<{ kind: string; cycle: number; result: string; verified_by: string }>(
      db,
      `SELECT v.*, u.display_name AS verified_by_name,
              coalesce((SELECT json_agg(json_build_object('id', i.id, 'number', i.number, 'outcome', i.outcome, 'dateReceived', i.date_received)) FROM inspection i WHERE i.id = ANY(v.inspection_ids)), '[]') AS inspections
         FROM scar_verification v JOIN app_user u ON u.id = v.verified_by WHERE v.scar_id = $1 ORDER BY v.verified_at`,
      [id],
    );
    const ncrs = await many(
      db,
      `SELECT n.id, n.number, n.title, n.status, x.relation, x.linked_at AS "linkedAt" FROM scar_ncr x JOIN ncr n ON n.id = x.ncr_id WHERE x.scar_id = $1 ORDER BY x.linked_at`,
      [id],
    );
    const reopens = await many(
      db,
      `SELECT r.*, n.number AS ncr_number, u.display_name AS reopened_by_name FROM scar_reopen r JOIN ncr n ON n.id = r.ncr_id JOIN app_user u ON u.id = r.reopened_by
        WHERE r.scar_id = $1 ORDER BY r.reopened_at`,
      [id],
    );
    const commitments = await many(
      db,
      `SELECT id, number, promised_action AS "promisedAction", status, due_date AS "dueDate" FROM supplier_commitment WHERE scar_id = $1 ORDER BY recorded_at`,
      [id],
    );
    // Candidate evidence: completed inspections of this supplier (and source, when set).
    const inspections = await many(
      db,
      `SELECT i.id, i.number, i.outcome, i.date_received AS "dateReceived", i.lot_number AS "lotNumber", i.completed_at AS "completedAt"
         FROM inspection i WHERE i.status = 'COMPLETED' AND i.supplier_id = $1 AND ($2::uuid IS NULL OR i.source_id = $2)
        ORDER BY i.completed_at DESC LIMIT 50`,
      [s.supplier_id, s.source_id],
    );
    const implementer = verifications.find((v) => v.kind === 'IMPLEMENTATION' && v.cycle === s.cycle && v.result === 'VERIFIED')?.verified_by ?? null;
    return {
      scar: { ...scar, statusText: SCAR_STATUS_TEXT[s.status] },
      responses,
      verifications,
      ncrs,
      reopens,
      commitments,
      inspections,
      files: await linkedFiles(db, 'SCAR', id),
      history: await history(db, 'scar', [id]),
      renditions: await renditions(db, 'SCAR', id),
      permissions: {
        manage: has(auth, 'scar.manage') && s.status !== 'CLOSED',
        verify: has(auth, 'scar.verify'),
        effectivenessBlockedReason: implementer === auth.userId ? 'Effectiveness must be verified by someone other than the implementation verifier.' : null,
        close: has(auth, 'scar.close'),
      },
    };
  });

  app.post('/api/scars/:id/responses', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'scar.manage', { action: 'scar.response', entityType: 'scar', entityId: id });
    const text = (max: number) => z.string().trim().max(max).nullable().optional();
    const body = z
      .object({
        receivedAt: z.string().datetime({ offset: true }).or(isoDate),
        channel: z.enum(CHANNELS),
        representative: z.string().trim().min(2).max(200),
        team: text(1000),
        problemDescription: text(4000),
        containment: z.string().trim().min(3).max(4000),
        rootCause: z.string().trim().min(3).max(4000),
        correctiveAction: z.string().trim().min(3).max(4000),
        implementation: text(4000),
        prevention: text(4000),
        supplierClaimsDone: z.boolean().default(false),
      })
      .parse(req.body);
    const out = await withTransaction(db, async (tx) => {
      const s = await loadScar(tx, id, true);
      if (s.status === 'CLOSED') throw conflict(`${s.number} is closed`);
      if (s.status !== 'ISSUED' && s.status !== 'RESPONSE_RECEIVED') throw conflict(`${s.number} is ${s.status.toLowerCase().replaceAll('_', ' ')}; a new response follows a recurrence or failed verification`);
      const rev = (await one<{ n: number }>(tx, 'SELECT coalesce(max(revision), 0)::int AS n FROM scar_response WHERE scar_id = $1', [id]))!.n + 1;
      const receivedAt = body.receivedAt.length === 10 ? `${body.receivedAt}T12:00:00Z` : body.receivedAt;
      await tx.query(
        `INSERT INTO scar_response (scar_id, revision, cycle, received_at, channel, representative, team, problem_description, containment, root_cause,
            corrective_action, implementation, prevention, supplier_claims_done, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          id,
          rev,
          s.cycle,
          receivedAt,
          body.channel,
          body.representative,
          body.team ?? null,
          body.problemDescription ?? null,
          body.containment,
          body.rootCause,
          body.correctiveAction,
          body.implementation ?? null,
          body.prevention ?? null,
          body.supplierClaimsDone,
          auth.userId,
        ],
      );
      // A supplier's response or "done" claim never advances beyond RESPONSE_RECEIVED (NEG-07).
      await tx.query(`UPDATE scar SET status = 'RESPONSE_RECEIVED', version = version + 1 WHERE id = $1`, [id]);
      await closeWork(tx, ['SCAR_RESPONSE'], 'SCAR', id, auth.userId, `Response revision ${rev} recorded`);
      await openWork(tx, { kind: 'SCAR_VERIFICATION', title: `${s.number}: verify supplier implementation (PDI evidence)`, subjectType: 'SCAR', subjectId: id, capability: 'scar.verify' });
      await audit(tx, {
        actorId: auth.userId,
        action: 'scar.response',
        entityType: 'scar',
        entityId: id,
        summary: `Supplier response revision ${rev} from ${body.representative}${body.supplierClaimsDone ? ' (supplier states actions complete — not verified)' : ''}`,
        requestId: req.id,
      });
      return { revision: rev };
    });
    return reply.code(201).send(out);
  });

  app.put('/api/scars/:id/plan', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'scar.manage', { action: 'scar.plan', entityType: 'scar', entityId: id });
    const body = z.object({ effectivenessPlan: z.string().trim().min(10).max(4000) }).parse(req.body);
    return withTransaction(db, async (tx) => {
      const s = await loadScar(tx, id, true);
      if (['EFFECTIVENESS_VERIFIED', 'CLOSED'].includes(s.status)) throw conflict('Effectiveness has already been verified for this cycle');
      await tx.query('UPDATE scar SET effectiveness_plan = $2, version = version + 1 WHERE id = $1', [id, body.effectivenessPlan]);
      await audit(tx, { actorId: auth.userId, action: 'scar.plan', entityType: 'scar', entityId: id, summary: 'Effectiveness verification plan recorded', after: { plan: body.effectivenessPlan }, requestId: req.id });
      return { ok: true };
    });
  });

  app.post('/api/scars/:id/verifications', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'scar.verify', { action: 'scar.verify', entityType: 'scar', entityId: id });
    const body = z
      .object({
        kind: z.enum(['IMPLEMENTATION', 'EFFECTIVENESS']),
        result: z.enum(['VERIFIED', 'NOT_VERIFIED']),
        method: z.string().trim().min(3).max(300),
        evidence: z.string().trim().min(5).max(4000),
        inspectionIds: z.array(uuid).max(50).default([]),
        populationNote: z.string().trim().max(2000).nullable().optional(),
        alternativeMethod: z.boolean().default(false),
        responseDue: isoDate.nullable().optional(),
      })
      .parse(req.body);
    const fail = async (message: string) => {
      await audit(db, { actorId: auth.userId, action: 'scar.verify', outcome: 'FAILED', entityType: 'scar', entityId: id, summary: `Verification refused: ${message}`, requestId: req.id });
      return unprocessable(message);
    };
    const out = await withTransaction(db, async (tx) => {
      const s = await loadScar(tx, id, true);
      if (!(await recheckCapability(tx, auth.userId, 'scar.verify'))) throw forbidden();
      const inspections = body.inspectionIds.length
        ? await many<{ id: string; number: string; status: string; outcome: string | null; supplier_id: string | null; source_id: string | null; completed_at: Date | null }>(
            tx,
            'SELECT id, number, status, outcome, supplier_id, source_id, completed_at FROM inspection WHERE id = ANY($1::uuid[])',
            [body.inspectionIds],
          )
        : [];
      if (inspections.length !== body.inspectionIds.length) throw unprocessable('Unknown inspection');
      for (const i of inspections) {
        if (i.status !== 'COMPLETED') throw await fail(`${i.number} is not a completed inspection`);
        if (i.supplier_id !== s.supplier_id || (s.source_id && i.source_id !== s.source_id)) throw await fail(`${i.number} is not for the SCAR supplier/source`);
      }
      const files = await linkedFiles(tx, 'SCAR', id);
      let next = s.status;
      if (body.kind === 'IMPLEMENTATION') {
        if (s.status !== 'RESPONSE_RECEIVED') throw conflict(`Implementation can be verified only after a supplier response (now ${s.status.toLowerCase().replaceAll('_', ' ')})`);
        if (body.result === 'VERIFIED' && !inspections.length && !files.length)
          throw await fail('Implementation needs objective PDI evidence: a completed inspection or an attached document. A supplier statement alone is not proof (NEG-07).');
        next = body.result === 'VERIFIED' ? 'IMPLEMENTATION_VERIFIED' : 'ISSUED';
      } else {
        if (s.status !== 'IMPLEMENTATION_VERIFIED') throw conflict('Effectiveness is verified after implementation has been verified');
        const impl = await one<{ verified_by: string; verified_at: Date }>(
          tx,
          `SELECT verified_by, verified_at FROM scar_verification WHERE scar_id = $1 AND cycle = $2 AND kind = 'IMPLEMENTATION' AND result = 'VERIFIED' ORDER BY verified_at DESC LIMIT 1`,
          [id, s.cycle],
        );
        if (impl?.verified_by === auth.userId) throw await auditedDenial(db, req, auth.userId, 'scar.verify', 'scar', id, 'Effectiveness must be verified independently of the implementation verifier');
        if (!s.effectiveness_plan) throw await fail('Record the effectiveness verification plan first');
        if (body.result === 'VERIFIED') {
          if (body.alternativeMethod) {
            if (!body.populationNote || !files.length) throw await fail('An alternative effectiveness method needs a population/time note and attached evidence (POL-04 open)');
          } else {
            if (!inspections.length) throw await fail('Effectiveness needs later production evidence: at least one completed inspection received after implementation was verified');
            for (const i of inspections) {
              if (!i.completed_at || i.completed_at <= impl!.verified_at) throw await fail(`${i.number} predates the verified implementation; it is not later production evidence`);
              if (i.outcome === 'FAIL') throw await fail(`${i.number} failed; the corrective action is not shown effective`);
            }
          }
        }
        next = body.result === 'VERIFIED' ? 'EFFECTIVENESS_VERIFIED' : 'ISSUED';
      }
      if (next === 'ISSUED' && !body.responseDue) throw unprocessable('A new supplier response due date is required when verification fails');
      await tx.query(
        `INSERT INTO scar_verification (scar_id, cycle, kind, result, method, evidence, inspection_ids, population_note, verified_by, grants_used)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, s.cycle, body.kind, body.result, body.method, body.evidence, body.inspectionIds, body.populationNote ?? null, auth.userId, ['scar.verify']],
      );
      await tx.query(`UPDATE scar SET status = $2, response_due = coalesce($3, response_due), version = version + 1 WHERE id = $1`, [id, next, next === 'ISSUED' ? body.responseDue : null]);
      await closeWork(tx, ['SCAR_VERIFICATION'], 'SCAR', id, auth.userId, `${body.kind.toLowerCase()} ${body.result.toLowerCase().replace('_', ' ')}`);
      if (next === 'IMPLEMENTATION_VERIFIED')
        await openWork(tx, { kind: 'SCAR_VERIFICATION', title: `${s.number}: verify effectiveness on later production`, subjectType: 'SCAR', subjectId: id, capability: 'scar.verify' });
      else if (next === 'EFFECTIVENESS_VERIFIED')
        await openWork(tx, { kind: 'SCAR_VERIFICATION', title: `${s.number}: effectiveness verified — close`, subjectType: 'SCAR', subjectId: id, capability: 'scar.close' });
      else await openWork(tx, { kind: 'SCAR_RESPONSE', title: `${s.number}: revised supplier response needed`, subjectType: 'SCAR', subjectId: id, assigneeId: s.owner_id, dueAt: body.responseDue });
      await audit(tx, {
        actorId: auth.userId,
        action: 'scar.verify',
        entityType: 'scar',
        entityId: id,
        summary: `${body.kind === 'IMPLEMENTATION' ? 'Implementation' : 'Effectiveness'} ${body.result === 'VERIFIED' ? 'verified' : 'NOT verified'} (${body.method})`,
        reason: body.evidence,
        after: { inspections: inspections.map((i) => i.number), cycle: s.cycle },
        requestId: req.id,
      });
      return { status: next };
    });
    return reply.code(201).send(out);
  });

  app.post('/api/scars/:id/close', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'scar.close', { action: 'scar.close', entityType: 'scar', entityId: id });
    const body = z.object({ note: z.string().trim().min(5).max(2000) }).parse(req.body);
    return withTransaction(db, async (tx) => {
      const s = await loadScar(tx, id, true);
      if (s.status !== 'EFFECTIVENESS_VERIFIED') {
        await audit(db, { actorId: auth.userId, action: 'scar.close', outcome: 'FAILED', entityType: 'scar', entityId: id, summary: `Close refused: ${SCAR_STATUS_TEXT[s.status]}`, requestId: req.id });
        throw unprocessable(`${s.number} cannot close: ${SCAR_STATUS_TEXT[s.status]?.toLowerCase()}`);
      }
      if (!(await recheckCapability(tx, auth.userId, 'scar.close'))) throw forbidden();
      await tx.query(`UPDATE scar SET status = 'CLOSED', closed_by = $2, closed_at = now(), closure_note = $3, version = version + 1 WHERE id = $1`, [id, auth.userId, body.note]);
      await closeWork(tx, ['SCAR_VERIFICATION', 'SCAR_RESPONSE'], 'SCAR', id, auth.userId, 'SCAR closed');
      await audit(tx, { actorId: auth.userId, action: 'scar.close', entityType: 'scar', entityId: id, summary: `${s.number} closed after verified effectiveness (cycle ${s.cycle})`, reason: body.note, requestId: req.id });
      return { status: 'CLOSED' };
    });
  });

  app.post('/api/scars/:id/ncrs', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'scar.manage', { action: 'scar.link_ncr', entityType: 'scar', entityId: id });
    const body = z
      .object({ ncrId: uuid, relation: z.enum(['ORIGIN', 'RECURRENCE']), reason: z.string().trim().min(5).max(2000), responseDue: isoDate.nullable().optional() })
      .parse(req.body);
    const out = await withTransaction(db, (tx) => linkNcrToScar(tx, req, auth.userId, id, body.ncrId, body.relation, body.reason, body.responseDue ?? null));
    return reply.code(201).send(out);
  });

  app.post('/api/scars/:id/report', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'scar.manage', { action: 'scar.report', entityType: 'scar', entityId: id });
    const out = await withTransaction(db, async (tx) => {
      const s = await loadScar(tx, id, true);
      const content = await buildScarReport(tx, id, config.displayTimeZone);
      const issued = await issueRecordEdition(tx, 'SCAR', id, (edition) => ({ ...content, edition }));
      await audit(tx, { actorId: auth.userId, action: 'scar.report', entityType: 'scar', entityId: id, summary: `${s.number} OPS-07/08 edition ${issued.edition} issued`, requestId: req.id });
      return issued;
    });
    return reply.code(201).send(out);
  });
}
