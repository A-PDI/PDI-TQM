import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CHANGE_ACTION_KINDS,
  CHANGE_ACTION_TEXT,
  CHANGE_CATEGORIES,
  CHANGE_STATUS_TEXT,
  IMPACT_AREAS,
  PRE_EFFECTIVE_ACTIONS,
  diffCharacteristics,
} from '../../shared/quality.js';
import { audit } from '../audit.js';
import { auditedDenial, has, recheckCapability, requireCapability } from '../auth.js';
import { type Queryable, many, one, withTransaction } from '../db.js';
import { conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { nextRecordNumber } from '../numbering.js';
import { closeWork, history, isActiveUser, isoDate, issueRecordEdition, linkedFiles, openWork, renditions, uuid } from '../quality/common.js';
import { buildChangeReport } from '../quality/reports.js';
import type { Services } from '../services.js';
import { effectiveSourceStatuses } from '../sourcing/status.js';

interface ChangeRow {
  id: string;
  number: string;
  title: string;
  status: string;
  part_id: string;
  supplier_id: string | null;
  categories: string[];
  current_revision_id: string | null;
  proposed_revision_id: string | null;
  requested_by: string;
  owner_id: string;
  requalification_required: boolean | null;
  effective_date: string | null;
  effective_lot: string | null;
  made_effective_at: Date | null;
  decided_at: Date | null;
  version: number;
}

const OPEN_STATES = ['PROPOSED', 'IMPACT_ASSESSED', 'APPROVED', 'EFFECTIVE'];

async function loadChange(db: Queryable, id: string, lock = false): Promise<ChangeRow> {
  if (!uuid.safeParse(id).success) throw notFound('Change');
  const c = await one<ChangeRow>(db, `SELECT *, effective_date::text FROM change_request WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!c) throw notFound('Change');
  return c;
}

async function revisionOfPart(db: Queryable, revisionId: string, partId: string) {
  return one<{ id: string; status: string; revision_label: string; title: string }>(
    db,
    `SELECT r.id, r.status, r.revision_label, b.title FROM baseline_revision r JOIN technical_baseline b ON b.id = r.baseline_id WHERE r.id = $1 AND b.part_id = $2`,
    [revisionId, partId],
  );
}

const characteristicsOf = (db: Queryable, revisionId: string | null) =>
  revisionId
    ? many<Record<string, unknown> & { charKey: string }>(
        db,
        `SELECT char_key AS "charKey", name, char_type AS "charType", form_row_ref AS "formRowRef", unit, lower_limit::text AS lower, upper_limit::text AS upper,
                limit_text AS "limitText", method, special, is_delta AS "isDelta"
           FROM baseline_characteristic WHERE revision_id = $1 ORDER BY char_key`,
        [revisionId],
      )
    : Promise.resolve([]);

/** Objective completion evidence for the action kinds the system can check (FR-081). */
async function actionEvidence(db: Queryable, kind: string, change: ChangeRow): Promise<string | null> {
  const rev = change.proposed_revision_id;
  switch (kind) {
    case 'BASELINE_RELEASE':
      if (!rev) return 'No proposed revision is linked to the change';
      return (await one(db, `SELECT 1 FROM baseline_revision WHERE id = $1 AND status IN ('RELEASED', 'SUPERSEDED')`, [rev])) ? null : 'The proposed revision is not released';
    case 'NEW_ACKNOWLEDGMENT':
      if (!rev) return 'No proposed revision is linked to the change';
      return (await one(db, `SELECT 1 FROM supplier_acknowledgment WHERE baseline_revision_id = $1 AND response = 'ACKNOWLEDGED'`, [rev]))
        ? null
        : 'No supplier has acknowledged the proposed revision';
    case 'REQUALIFY_FAI':
      if (!rev) return 'No proposed revision is linked to the change';
      return (await one(db, `SELECT 1 FROM fai_sample WHERE baseline_revision_id = $1 AND status = 'DECIDED' AND decision IN ('ACCEPTED', 'CONDITIONAL')`, [rev]))
        ? null
        : 'No first article against the proposed revision has been accepted';
    case 'SOURCE_REAPPROVAL':
      if (!rev) return 'No proposed revision is linked to the change';
      return (await one(
        db,
        `SELECT 1 FROM source_approval_decision d JOIN source s ON s.id = d.source_id WHERE s.baseline_revision_id = $1 AND d.decision <> 'REJECTED' AND d.decided_at > $2`,
        [rev, change.decided_at ?? new Date(0)],
      ))
        ? null
        : 'No source governed by the proposed revision has been approved';
    default:
      return null;
  }
}

export function registerChangeRoutes(app: FastifyInstance, svc: Services) {
  const { db, config } = svc;

  app.get('/api/changes', async (req) => {
    await requireCapability(db, req, 'records.read', { action: 'change.list', consequential: false });
    const q = z.object({ status: z.string().max(30).optional(), partId: uuid.optional(), sourceId: uuid.optional() }).parse(req.query);
    const params: unknown[] = [];
    const where = ['true'];
    if (q.status === 'OPEN') where.push(`c.status = ANY('{${OPEN_STATES.join(',')}}'::text[])`);
    else if (q.status) {
      params.push(q.status);
      where.push(`c.status = $${params.length}`);
    }
    if (q.partId) {
      params.push(q.partId);
      where.push(`c.part_id = $${params.length}`);
    }
    if (q.sourceId) {
      params.push(q.sourceId);
      where.push(`EXISTS (SELECT 1 FROM change_source cs WHERE cs.change_id = c.id AND cs.source_id = $${params.length})`);
    }
    return many(
      db,
      `SELECT c.id, c.number, c.title, c.origin, c.status, c.categories, c.requested_at AS "requestedAt", p.part_number AS "partNumber", s.legal_name AS supplier,
              o.display_name AS owner, c.requalification_required AS "requalificationRequired"
         FROM change_request c JOIN company_part p ON p.id = c.part_id LEFT JOIN supplier s ON s.id = c.supplier_id JOIN app_user o ON o.id = c.owner_id
        WHERE ${where.join(' AND ')} ORDER BY c.requested_at DESC LIMIT 200`,
      params,
    );
  });

  app.get('/api/changes/:id', async (req) => {
    const auth = await requireCapability(db, req, 'records.read', { action: 'change.read', consequential: false });
    const { id } = req.params as { id: string };
    const c = await loadChange(db, id);
    const detail = await one(
      db,
      `SELECT c.*, c.effective_date::text AS effective_date, c.desired_effective_date::text AS desired_effective_date, p.part_number, p.description AS part_description,
              s.legal_name AS supplier_name, ss.name AS site_name, rq.display_name AS requested_by_name, o.display_name AS owner_name, ia.display_name AS impact_assessed_by_name,
              d.display_name AS decided_by_name, me.display_name AS made_effective_by_name, iv.display_name AS implementation_verified_by_name,
              ii.number AS implementation_inspection_number,
              cr.revision_label AS current_revision_label, cb.title AS current_baseline_title, cr.status AS current_revision_status,
              pr.revision_label AS proposed_revision_label, pb.title AS proposed_baseline_title, pr.status AS proposed_revision_status
         FROM change_request c JOIN company_part p ON p.id = c.part_id LEFT JOIN supplier s ON s.id = c.supplier_id LEFT JOIN supplier_site ss ON ss.id = c.site_id
         JOIN app_user rq ON rq.id = c.requested_by JOIN app_user o ON o.id = c.owner_id LEFT JOIN app_user ia ON ia.id = c.impact_assessed_by
         LEFT JOIN app_user d ON d.id = c.decided_by LEFT JOIN app_user me ON me.id = c.made_effective_by LEFT JOIN app_user iv ON iv.id = c.implementation_verified_by
         LEFT JOIN inspection ii ON ii.id = c.implementation_inspection_id
         LEFT JOIN baseline_revision cr ON cr.id = c.current_revision_id LEFT JOIN technical_baseline cb ON cb.id = cr.baseline_id
         LEFT JOIN baseline_revision pr ON pr.id = c.proposed_revision_id LEFT JOIN technical_baseline pb ON pb.id = pr.baseline_id
        WHERE c.id = $1`,
      [id],
    );
    const sources = await many<{ id: string }>(
      db,
      `SELECT s.id, p.part_number AS "partNumber", sup.legal_name AS supplier, ss.name AS site, sp.supplier_part_number AS "supplierPartNumber", br.revision_label AS "revisionLabel"
         FROM change_source cs JOIN source s ON s.id = cs.source_id JOIN company_part p ON p.id = s.part_id JOIN supplier sup ON sup.id = s.supplier_id
         JOIN supplier_site ss ON ss.id = s.site_id JOIN supplier_part sp ON sp.id = s.supplier_part_id LEFT JOIN baseline_revision br ON br.id = s.baseline_revision_id
        WHERE cs.change_id = $1 ORDER BY p.part_number`,
      [id],
    );
    const statuses = await effectiveSourceStatuses(
      db,
      sources.map((s) => s.id),
    );
    const impact = await many(db, `SELECT area, affected, assessment FROM change_impact_item WHERE change_id = $1`, [id]);
    const actions = await many(
      db,
      `SELECT a.id, a.kind, a.title, a.status, a.due_date::text AS "dueDate", a.waivable, a.completion_note AS "completionNote", a.completed_at AS "completedAt",
              o.display_name AS owner, a.owner_id AS "ownerId", cb.display_name AS "completedBy"
         FROM change_action a JOIN app_user o ON o.id = a.owner_id LEFT JOIN app_user cb ON cb.id = a.completed_by WHERE a.change_id = $1 ORDER BY a.created_at`,
      [id],
    );
    const diff = diffCharacteristics(await characteristicsOf(db, c.current_revision_id), await characteristicsOf(db, c.proposed_revision_id));
    // Lots received against this part before and after effectivity stay traceable to their own revision.
    const inspections = await many(
      db,
      `SELECT i.id, i.number, i.status, i.outcome, i.date_received::text AS "dateReceived", i.lot_number AS "lotNumber", br.revision_label AS "revisionLabel",
              (i.baseline_revision_id IS NOT DISTINCT FROM $2) AS "onProposed"
         FROM inspection i LEFT JOIN baseline_revision br ON br.id = i.baseline_revision_id
        WHERE i.part_id = $1 ORDER BY i.date_received DESC, i.created_at DESC LIMIT 40`,
      [c.part_id, c.proposed_revision_id],
    );
    const baselines = await many(
      db,
      `SELECT r.id, b.title, r.revision_label AS "revisionLabel", r.status FROM baseline_revision r JOIN technical_baseline b ON b.id = r.baseline_id
        WHERE b.part_id = $1 ORDER BY b.title, r.created_at`,
      [c.part_id],
    );
    return {
      change: { ...detail, statusText: CHANGE_STATUS_TEXT[c.status] },
      sources: sources.map((s) => ({ ...s, effective: statuses.get(s.id) })),
      impact,
      actions,
      diff,
      inspections,
      baselines,
      commitments: await many(db, `SELECT id, number, promised_action AS "promisedAction", status FROM supplier_commitment WHERE change_id = $1`, [id]),
      files: await linkedFiles(db, 'CHANGE', id),
      history: await history(db, 'change_request', [id]),
      renditions: await renditions(db, 'CHANGE', id),
      permissions: {
        manage: has(auth, 'change.manage') && OPEN_STATES.includes(c.status),
        decide: has(auth, 'change.approve') && c.requested_by !== auth.userId,
        decideBlockedReason: has(auth, 'change.approve') && c.requested_by === auth.userId ? 'You requested this change; someone else must decide it.' : null,
        verify: has(auth, 'change.verify'),
        waive: has(auth, 'requirement.waive'),
      },
    };
  });

  app.post('/api/changes', async (req, reply) => {
    const auth = await requireCapability(db, req, 'change.manage', { action: 'change.create' });
    const body = z
      .object({
        origin: z.enum(['PDI', 'SUPPLIER']),
        title: z.string().trim().min(3).max(200),
        description: z.string().trim().min(10).max(4000),
        justification: z.string().trim().min(5).max(4000),
        categories: z.array(z.enum(CHANGE_CATEGORIES)).min(1).max(12),
        partId: uuid,
        supplierId: uuid.nullable().optional(),
        siteId: uuid.nullable().optional(),
        sourceIds: z.array(uuid).max(50).default([]),
        currentRevisionId: uuid.nullable().optional(),
        proposedRevisionId: uuid.nullable().optional(),
        supplierReference: z.string().trim().max(120).nullable().optional(),
        supplierRepresentative: z.string().trim().max(200).nullable().optional(),
        desiredEffectiveDate: isoDate.nullable().optional(),
        affectedStock: z.string().trim().max(2000).nullable().optional(),
        ownerId: uuid,
      })
      .parse(req.body);
    if (body.origin === 'SUPPLIER' && (!body.supplierId || !body.supplierRepresentative)) throw unprocessable('A supplier change needs the supplier and its representative');
    const created = await withTransaction(db, async (tx) => {
      if (!(await isActiveUser(tx, body.ownerId))) throw unprocessable('The owner must be an active user');
      for (const rid of [body.currentRevisionId, body.proposedRevisionId]) if (rid && !(await revisionOfPart(tx, rid, body.partId))) throw unprocessable('The baseline revision is not for this part');
      if (body.siteId && (!body.supplierId || !(await one(tx, 'SELECT 1 FROM supplier_site WHERE id = $1 AND supplier_id = $2', [body.siteId, body.supplierId])))) throw unprocessable('The site does not belong to the supplier');
      for (const sid of body.sourceIds) {
        const s = await one<{ part_id: string; supplier_id: string }>(tx, 'SELECT part_id, supplier_id FROM source WHERE id = $1', [sid]);
        if (!s || s.part_id !== body.partId || (body.supplierId && s.supplier_id !== body.supplierId)) throw unprocessable('Every affected source must be for this part (and supplier)');
      }
      const number = await nextRecordNumber(tx, 'CHG');
      const c = await one<{ id: string }>(
        tx,
        `INSERT INTO change_request (number, origin, title, description, justification, categories, part_id, supplier_id, site_id, current_revision_id, proposed_revision_id,
            supplier_reference, supplier_representative, desired_effective_date, affected_stock, requested_by, owner_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
        [
          number,
          body.origin,
          body.title,
          body.description,
          body.justification,
          body.categories,
          body.partId,
          body.supplierId ?? null,
          body.siteId ?? null,
          body.currentRevisionId ?? null,
          body.proposedRevisionId ?? null,
          body.supplierReference ?? null,
          body.supplierRepresentative ?? null,
          body.desiredEffectiveDate ?? null,
          body.affectedStock ?? null,
          auth.userId,
          body.ownerId,
        ],
      );
      for (const sid of new Set(body.sourceIds)) await tx.query('INSERT INTO change_source (change_id, source_id) VALUES ($1,$2)', [c!.id, sid]);
      await openWork(tx, { kind: 'CHANGE_IMPACT', title: `${number}: assess impact — ${body.title}`, subjectType: 'CHANGE', subjectId: c!.id, assigneeId: body.ownerId });
      await audit(tx, {
        actorId: auth.userId,
        action: 'change.create',
        entityType: 'change_request',
        entityId: c!.id,
        summary: `${number} proposed (${body.origin === 'SUPPLIER' ? `supplier ${body.supplierReference ?? ''}`.trim() : 'PDI'}): ${body.categories.join(', ').toLowerCase()}`,
        reason: body.justification,
        requestId: req.id,
      });
      return { id: c!.id, number };
    });
    return reply.code(201).send(created);
  });

  app.patch('/api/changes/:id', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'change.manage', { action: 'change.update', entityType: 'change_request', entityId: id });
    const body = z
      .object({
        expectedVersion: z.number().int(),
        proposedRevisionId: uuid.nullable().optional(),
        sourceIds: z.array(uuid).max(50).optional(),
        desiredEffectiveDate: isoDate.nullable().optional(),
        affectedStock: z.string().trim().max(2000).nullable().optional(),
      })
      .parse(req.body);
    return withTransaction(db, async (tx) => {
      const c = await loadChange(tx, id, true);
      if (c.version !== body.expectedVersion) throw conflict('This change was edited elsewhere. Reload and try again.');
      if (!['PROPOSED', 'IMPACT_ASSESSED'].includes(c.status)) throw conflict('A decided change can no longer be edited');
      if (body.proposedRevisionId && !(await revisionOfPart(tx, body.proposedRevisionId, c.part_id))) throw unprocessable('The baseline revision is not for this part');
      if (body.sourceIds) {
        for (const sid of body.sourceIds) {
          const s = await one<{ part_id: string; supplier_id: string }>(tx, 'SELECT part_id, supplier_id FROM source WHERE id = $1', [sid]);
          if (!s || s.part_id !== c.part_id || (c.supplier_id && s.supplier_id !== c.supplier_id)) throw unprocessable('Every affected source must be for this part (and supplier)');
        }
        await tx.query('DELETE FROM change_source WHERE change_id = $1', [id]);
        for (const sid of new Set(body.sourceIds)) await tx.query('INSERT INTO change_source (change_id, source_id) VALUES ($1,$2)', [id, sid]);
      }
      // Editing the subject after the impact assessment sends it back for reassessment.
      await tx.query(
        `UPDATE change_request SET proposed_revision_id = CASE WHEN $2 THEN $3::uuid ELSE proposed_revision_id END,
            desired_effective_date = CASE WHEN $4 THEN $5::date ELSE desired_effective_date END,
            affected_stock = CASE WHEN $6 THEN $7 ELSE affected_stock END,
            status = 'PROPOSED', version = version + 1 WHERE id = $1`,
        [
          id,
          body.proposedRevisionId !== undefined,
          body.proposedRevisionId ?? null,
          body.desiredEffectiveDate !== undefined,
          body.desiredEffectiveDate ?? null,
          body.affectedStock !== undefined,
          body.affectedStock ?? null,
        ],
      );
      await closeWork(tx, ['CHANGE_DECISION'], 'CHANGE', id, auth.userId, 'Edited; impact to be reassessed');
      await openWork(tx, { kind: 'CHANGE_IMPACT', title: `${c.number}: assess impact — ${c.title}`, subjectType: 'CHANGE', subjectId: id, assigneeId: c.owner_id });
      await audit(tx, { actorId: auth.userId, action: 'change.update', entityType: 'change_request', entityId: id, summary: `${c.number} edited; impact assessment required again`, after: body, requestId: req.id });
      return { ok: true };
    });
  });

  app.put('/api/changes/:id/impact', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'change.manage', { action: 'change.impact', entityType: 'change_request', entityId: id });
    const body = z
      .object({
        expectedVersion: z.number().int(),
        summary: z.string().trim().min(10).max(4000),
        requalificationRequired: z.boolean(),
        items: z.array(z.object({ area: z.enum(IMPACT_AREAS), affected: z.boolean(), assessment: z.string().trim().min(3).max(2000) })).length(IMPACT_AREAS.length),
      })
      .parse(req.body);
    if (new Set(body.items.map((i) => i.area)).size !== IMPACT_AREAS.length) throw unprocessable('Assess every impact area once');
    return withTransaction(db, async (tx) => {
      const c = await loadChange(tx, id, true);
      if (c.version !== body.expectedVersion) throw conflict('This change was edited elsewhere. Reload and try again.');
      if (!['PROPOSED', 'IMPACT_ASSESSED'].includes(c.status)) throw conflict('A decided change can no longer be reassessed');
      // A new manufacturing site is always assessed as a new source (C3, NEG-17).
      if (c.categories.includes('SITE') && !body.requalificationRequired) throw unprocessable('A manufacturing-site change always requires requalification of the new site and source');
      for (const i of body.items) {
        await tx.query(
          `INSERT INTO change_impact_item (change_id, area, affected, assessment) VALUES ($1,$2,$3,$4)
           ON CONFLICT (change_id, area) DO UPDATE SET affected = EXCLUDED.affected, assessment = EXCLUDED.assessment`,
          [id, i.area, i.affected, i.assessment],
        );
      }
      await tx.query(
        `UPDATE change_request SET impact_summary = $2, requalification_required = $3, impact_assessed_by = $4, impact_assessed_at = now(), status = 'IMPACT_ASSESSED', version = version + 1 WHERE id = $1`,
        [id, body.summary, body.requalificationRequired, auth.userId],
      );
      await closeWork(tx, ['CHANGE_IMPACT'], 'CHANGE', id, auth.userId, 'Impact assessed');
      await openWork(tx, { kind: 'CHANGE_DECISION', title: `${c.number}: decide — ${c.title}`, subjectType: 'CHANGE', subjectId: id, capability: 'change.approve' });
      await audit(tx, {
        actorId: auth.userId,
        action: 'change.impact',
        entityType: 'change_request',
        entityId: id,
        summary: `Impact assessed: ${body.items.filter((i) => i.affected).length} area(s) affected; requalification ${body.requalificationRequired ? 'required' : 'not required'}`,
        reason: body.summary,
        requestId: req.id,
      });
      return { status: 'IMPACT_ASSESSED' };
    });
  });

  app.post('/api/changes/:id/actions', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'change.manage', { action: 'change.action_add', entityType: 'change_request', entityId: id });
    const body = z
      .object({ kind: z.enum(CHANGE_ACTION_KINDS), title: z.string().trim().min(3).max(200).optional(), ownerId: uuid, dueDate: isoDate.nullable().optional(), waivable: z.boolean().default(true) })
      .parse(req.body);
    const out = await withTransaction(db, async (tx) => {
      const c = await loadChange(tx, id, true);
      if (!OPEN_STATES.includes(c.status)) throw conflict(`${c.number} is ${c.status.toLowerCase().replaceAll('_', ' ')}`);
      if (!(await isActiveUser(tx, body.ownerId))) throw unprocessable('The owner must be an active user');
      const title = body.title || CHANGE_ACTION_TEXT[body.kind];
      const a = await one<{ id: string }>(
        tx,
        'INSERT INTO change_action (change_id, kind, title, owner_id, due_date, waivable, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id',
        [id, body.kind, title, body.ownerId, body.dueDate ?? null, body.waivable, auth.userId],
      );
      await openWork(tx, { kind: 'CHANGE_ACTION', title: `${c.number}: ${title}`, subjectType: 'CHANGE_ACTION', subjectId: a!.id, assigneeId: body.ownerId, dueAt: body.dueDate ?? null });
      await audit(tx, { actorId: auth.userId, action: 'change.action_add', entityType: 'change_request', entityId: id, summary: `Action added: ${title}${body.waivable ? '' : ' (not waivable)'}`, requestId: req.id });
      return { id: a!.id };
    });
    return reply.code(201).send(out);
  });

  app.post('/api/change-actions/:id/complete', async (req) => {
    const { id } = req.params as { id: string };
    if (!uuid.safeParse(id).success) throw notFound('Action');
    const auth = await requireCapability(db, req, 'records.read', { action: 'change.action_complete', entityType: 'change_action', entityId: id });
    // Authority depends on the action's owner, so it is checked before the request body is validated.
    const owner = await one<{ owner_id: string }>(db, 'SELECT owner_id FROM change_action WHERE id = $1', [id]);
    if (!owner) throw notFound('Action');
    if (owner.owner_id !== auth.userId && !has(auth, 'change.manage')) {
      throw await auditedDenial(db, req, auth.userId, 'change.action_complete', 'change_action', id, 'Only the action owner or a change manager can complete it');
    }
    const body = z.object({ note: z.string().trim().min(5).max(2000) }).parse(req.body);
    return withTransaction(db, async (tx) => {
      const a = await one<{ change_id: string; kind: string; title: string; status: string; owner_id: string }>(tx, 'SELECT change_id, kind, title, status, owner_id FROM change_action WHERE id = $1 FOR UPDATE', [id]);
      if (!a) throw notFound('Action');
      const c = await loadChange(tx, a.change_id, true);
      if (a.status !== 'OPEN') throw conflict('This action is already resolved');
      const missing = await actionEvidence(tx, a.kind, c);
      if (missing) {
        await audit(db, { actorId: auth.userId, action: 'change.action_complete', outcome: 'FAILED', entityType: 'change_request', entityId: c.id, summary: `${a.title}: ${missing}`, requestId: req.id });
        throw unprocessable(`${a.title} cannot be completed: ${missing}`);
      }
      await tx.query(`UPDATE change_action SET status = 'DONE', completion_note = $2, completed_by = $3, completed_at = now() WHERE id = $1`, [id, body.note, auth.userId]);
      await closeWork(tx, ['CHANGE_ACTION'], 'CHANGE_ACTION', id, auth.userId, 'Done');
      await audit(tx, { actorId: auth.userId, action: 'change.action_complete', entityType: 'change_request', entityId: c.id, summary: `Action done: ${a.title}`, reason: body.note, requestId: req.id });
      return { status: 'DONE' };
    });
  });

  app.post('/api/change-actions/:id/waive', async (req) => {
    const { id } = req.params as { id: string };
    if (!uuid.safeParse(id).success) throw notFound('Action');
    const auth = await requireCapability(db, req, 'requirement.waive', { action: 'change.action_waive', entityType: 'change_action', entityId: id });
    const body = z.object({ reason: z.string().trim().min(10).max(2000) }).parse(req.body);
    return withTransaction(db, async (tx) => {
      const a = await one<{ change_id: string; title: string; status: string; waivable: boolean }>(tx, 'SELECT change_id, title, status, waivable FROM change_action WHERE id = $1 FOR UPDATE', [id]);
      if (!a) throw notFound('Action');
      if (a.status !== 'OPEN') throw conflict('This action is already resolved');
      if (!a.waivable) throw unprocessable(`${a.title} is a non-waivable requirement`);
      await tx.query(`UPDATE change_action SET status = 'WAIVED', completion_note = $2, completed_by = $3, completed_at = now() WHERE id = $1`, [id, body.reason, auth.userId]);
      await closeWork(tx, ['CHANGE_ACTION'], 'CHANGE_ACTION', id, auth.userId, 'Waived');
      await audit(tx, { actorId: auth.userId, action: 'change.action_waive', entityType: 'change_request', entityId: a.change_id, summary: `Action waived: ${a.title}`, reason: body.reason, requestId: req.id });
      return { status: 'WAIVED' };
    });
  });

  app.post('/api/changes/:id/decide', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'change.approve', { action: 'change.decide', entityType: 'change_request', entityId: id });
    const body = z
      .object({ expectedVersion: z.number().int(), decision: z.enum(['APPROVED', 'REJECTED']), rationale: z.string().trim().min(5).max(4000), conditions: z.string().trim().max(2000).nullable().optional() })
      .parse(req.body);
    return withTransaction(db, async (tx) => {
      const c = await loadChange(tx, id, true);
      if (c.version !== body.expectedVersion) throw conflict('This change was edited elsewhere. Reload and try again.');
      if (c.status !== 'IMPACT_ASSESSED') throw conflict(c.status === 'PROPOSED' ? 'Assess the impact before deciding' : `${c.number} is already ${c.status.toLowerCase().replaceAll('_', ' ')}`);
      if (c.requested_by === auth.userId) throw await auditedDenial(db, req, auth.userId, 'change.decide', 'change_request', id, 'A change must be decided by someone other than its requester');
      if (!(await recheckCapability(tx, auth.userId, 'change.approve'))) throw forbidden();
      if (body.decision === 'APPROVED' && c.requalification_required) {
        const requal = await one(tx, `SELECT 1 FROM change_action WHERE change_id = $1 AND kind IN ('REQUALIFY_FAI', 'SOURCE_REAPPROVAL')`, [id]);
        if (!requal) throw unprocessable('Requalification is required: add the first-article or source re-approval action(s) before approving');
      }
      await tx.query(
        `UPDATE change_request SET status = $2, decided_by = $3, decided_at = now(), decision_rationale = $4, conditions = $5, grants_used = $6, version = version + 1 WHERE id = $1`,
        [id, body.decision, auth.userId, body.rationale, body.conditions ?? null, ['change.approve']],
      );
      await closeWork(tx, ['CHANGE_DECISION'], 'CHANGE', id, auth.userId, body.decision);
      if (body.decision === 'REJECTED') await closeWork(tx, ['CHANGE_IMPACT'], 'CHANGE', id, auth.userId, 'Rejected');
      await audit(tx, { actorId: auth.userId, action: 'change.decide', entityType: 'change_request', entityId: id, summary: `${c.number} ${body.decision.toLowerCase()}`, reason: body.rationale, requestId: req.id });
      return { status: body.decision };
    });
  });

  // Release of the decision is separate from verified implementation (FR-082).
  app.post('/api/changes/:id/effective', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'change.manage', { action: 'change.effective', entityType: 'change_request', entityId: id });
    const body = z.object({ effectiveDate: isoDate, effectiveLot: z.string().trim().max(80).nullable().optional(), note: z.string().trim().min(5).max(2000) }).parse(req.body);
    return withTransaction(db, async (tx) => {
      const c = await loadChange(tx, id, true);
      if (c.status !== 'APPROVED') throw conflict('Only an approved change can be made effective');
      if (c.proposed_revision_id && (await actionEvidence(tx, 'BASELINE_RELEASE', c))) throw unprocessable('Release the proposed baseline revision first');
      const pending = await many<{ title: string }>(tx, `SELECT title FROM change_action WHERE change_id = $1 AND status = 'OPEN' AND kind = ANY($2::text[])`, [id, [...PRE_EFFECTIVE_ACTIONS]]);
      if (pending.length) throw unprocessable(`Complete before effectivity: ${pending.map((p) => p.title).join('; ')}`);
      await tx.query(
        `UPDATE change_request SET status = 'EFFECTIVE', effective_date = $2, effective_lot = $3, effective_note = $4, made_effective_by = $5, made_effective_at = now(), version = version + 1 WHERE id = $1`,
        [id, body.effectiveDate, body.effectiveLot ?? null, body.note, auth.userId],
      );
      await openWork(tx, { kind: 'CHANGE_VERIFICATION', title: `${c.number}: verify implementation on the first conforming lot`, subjectType: 'CHANGE', subjectId: id, capability: 'change.verify' });
      await audit(tx, {
        actorId: auth.userId,
        action: 'change.effective',
        entityType: 'change_request',
        entityId: id,
        summary: `${c.number} effective from ${body.effectiveDate}${body.effectiveLot ? `, first lot ${body.effectiveLot}` : ''}; earlier lots keep their recorded revision`,
        reason: body.note,
        requestId: req.id,
      });
      return { status: 'EFFECTIVE' };
    });
  });

  app.post('/api/changes/:id/verify-implementation', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'change.verify', { action: 'change.verify', entityType: 'change_request', entityId: id });
    const body = z.object({ inspectionId: uuid, note: z.string().trim().min(5).max(2000) }).parse(req.body);
    const fail = async (message: string) => {
      await audit(db, { actorId: auth.userId, action: 'change.verify', outcome: 'FAILED', entityType: 'change_request', entityId: id, summary: `Verification refused: ${message}`, requestId: req.id });
      return unprocessable(message);
    };
    return withTransaction(db, async (tx) => {
      const c = await loadChange(tx, id, true);
      if (c.status !== 'EFFECTIVE') throw conflict('Implementation is verified after the change is effective');
      if (!(await recheckCapability(tx, auth.userId, 'change.verify'))) throw forbidden();
      const open = await many<{ title: string }>(tx, `SELECT title FROM change_action WHERE change_id = $1 AND status = 'OPEN'`, [id]);
      if (open.length) throw await fail(`Open actions: ${open.map((a) => a.title).join('; ')}`);
      const i = await one<{ number: string; status: string; outcome: string | null; part_id: string | null; source_id: string | null; baseline_revision_id: string | null; date_received: string; lot_number: string | null }>(
        tx,
        'SELECT number, status, outcome, part_id, source_id, baseline_revision_id, date_received::text, lot_number FROM inspection WHERE id = $1',
        [body.inspectionId],
      );
      if (!i || i.status !== 'COMPLETED') throw await fail('The first-lot evidence must be a completed inspection');
      if (i.part_id !== c.part_id) throw await fail(`${i.number} is for a different part`);
      if (i.outcome !== 'PASS') throw await fail(`${i.number} did not pass; it is not a conforming first lot`);
      if (i.date_received < c.effective_date!) throw await fail(`${i.number} was received ${i.date_received}, before the change became effective (${c.effective_date})`);
      if (c.effective_lot && (i.lot_number ?? '').toUpperCase() !== c.effective_lot.toUpperCase()) throw await fail(`${i.number} is lot ${i.lot_number ?? 'unknown'}, not the first effective lot ${c.effective_lot}`);
      if (c.proposed_revision_id && i.baseline_revision_id !== c.proposed_revision_id) throw await fail(`${i.number} was inspected against a different revision than the changed one`);
      const affected = await many<{ source_id: string }>(tx, 'SELECT source_id FROM change_source WHERE change_id = $1', [id]);
      const governed = c.proposed_revision_id && i.source_id ? await one(tx, 'SELECT 1 FROM source WHERE id = $1 AND baseline_revision_id = $2', [i.source_id, c.proposed_revision_id]) : null;
      if (affected.length && !affected.some((a) => a.source_id === i.source_id) && !governed) throw await fail(`${i.number} is not from an affected source`);
      await tx.query(
        `UPDATE change_request SET status = 'IMPLEMENTATION_VERIFIED', implementation_inspection_id = $2, implementation_note = $3, implementation_verified_by = $4,
            implementation_verified_at = now(), version = version + 1 WHERE id = $1`,
        [id, body.inspectionId, body.note, auth.userId],
      );
      await closeWork(tx, ['CHANGE_VERIFICATION', 'CHANGE_IMPACT'], 'CHANGE', id, auth.userId, 'Implementation verified');
      await audit(tx, { actorId: auth.userId, action: 'change.verify', entityType: 'change_request', entityId: id, summary: `${c.number} implementation verified by ${i.number} (lot ${i.lot_number ?? '—'})`, reason: body.note, requestId: req.id });
      return { status: 'IMPLEMENTATION_VERIFIED' };
    });
  });

  app.post('/api/changes/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'change.manage', { action: 'change.cancel', entityType: 'change_request', entityId: id });
    const body = z.object({ reason: z.string().trim().min(10).max(2000) }).parse(req.body);
    return withTransaction(db, async (tx) => {
      const c = await loadChange(tx, id, true);
      if (!['PROPOSED', 'IMPACT_ASSESSED', 'APPROVED'].includes(c.status)) throw conflict(`${c.number} is ${c.status.toLowerCase().replaceAll('_', ' ')}`);
      await tx.query(`UPDATE change_request SET status = 'CANCELLED', cancel_reason = $2, version = version + 1 WHERE id = $1`, [id, body.reason]);
      await closeWork(tx, ['CHANGE_IMPACT', 'CHANGE_DECISION'], 'CHANGE', id, auth.userId, 'Cancelled');
      const actions = await many<{ id: string }>(tx, `SELECT id FROM change_action WHERE change_id = $1 AND status = 'OPEN'`, [id]);
      for (const a of actions) await closeWork(tx, ['CHANGE_ACTION'], 'CHANGE_ACTION', a.id, auth.userId, 'Change cancelled');
      await audit(tx, { actorId: auth.userId, action: 'change.cancel', entityType: 'change_request', entityId: id, summary: `${c.number} cancelled`, reason: body.reason, requestId: req.id });
      return { status: 'CANCELLED' };
    });
  });

  app.post('/api/changes/:id/report', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'change.manage', { action: 'change.report', entityType: 'change_request', entityId: id });
    const out = await withTransaction(db, async (tx) => {
      const c = await loadChange(tx, id, true);
      const content = await buildChangeReport(tx, id, config.displayTimeZone);
      const issued = await issueRecordEdition(tx, 'CHANGE', id, (edition) => ({ ...content, edition }));
      await audit(tx, { actorId: auth.userId, action: 'change.report', entityType: 'change_request', entityId: id, summary: `${c.number} OPS-04 edition ${issued.edition} issued`, requestId: req.id });
      return issued;
    });
    return reply.code(201).send(out);
  });
}
