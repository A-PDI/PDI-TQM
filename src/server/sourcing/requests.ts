import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CHECKLIST_RULE_VERSION, RISK_FACTORS, RISK_RULE_VERSION, type RiskInputs, assessRisk, buildChecklist } from '../../shared/sourcing.js';
import { audit } from '../audit.js';
import { has, recheckCapability, requireCapability } from '../auth.js';
import { type DbClient, many, one, withTransaction } from '../db.js';
import { conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { nextRecordNumber } from '../numbering.js';
import type { Services } from '../services.js';
import { evaluateGates } from './gates.js';
import { effectiveSourceStatuses } from './status.js';

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const normalize = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

const intake = z.object({
  title: z.string().trim().min(3).max(200),
  pathway: z.enum(['A', 'B', 'C']),
  partId: uuid.nullable().optional(),
  proposedPartNumber: z.string().trim().max(60).nullable().optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  supplierId: uuid.nullable().optional(),
  siteId: uuid.nullable().optional(),
  supplierPartNumber: z.string().trim().max(80).nullable().optional(),
  configuration: z.string().trim().min(1).max(120).optional(),
  commercialRationale: z.string().trim().max(2000).nullable().optional(),
  quantityNote: z.string().trim().max(500).nullable().optional(),
  ownerId: uuid.nullable().optional(),
  targetDate: date.nullable().optional(),
});

async function lockRequest(tx: DbClient, id: string) {
  const r = await one<{ id: string; number: string; status: string; pathway: 'A' | 'B' | 'C'; owner_id: string; version: number; source_id: string | null }>(
    tx,
    'SELECT id, number, status, pathway, owner_id, version, source_id FROM sourcing_request WHERE id = $1 FOR UPDATE',
    [id],
  );
  if (!r) throw notFound('Sourcing request');
  return r;
}

export function registerSourcingRoutes(app: FastifyInstance, svc: Services) {
  const { db } = svc;

  app.get('/api/sourcing', async (req) => {
    await requireCapability(db, req, 'records.read', { action: 'sourcing.list', consequential: false });
    const q = z.object({ status: z.enum(['OPEN', 'SOURCE_CREATED', 'APPROVED', 'CANCELLED', 'ACTIVE']).optional() }).parse(req.query);
    return many(
      db,
      `SELECT r.id, r.number, r.title, r.pathway, r.status, r.target_date AS "targetDate", r.created_at AS "createdAt",
              coalesce(p.part_number, r.proposed_part_number) AS "partNumber", sup.legal_name AS supplier, ss.name AS site, o.display_name AS owner,
              (SELECT ra.result FROM risk_assessment ra WHERE ra.sourcing_request_id = r.id ORDER BY ra.assessed_at DESC LIMIT 1) AS risk
         FROM sourcing_request r JOIN app_user o ON o.id = r.owner_id LEFT JOIN company_part p ON p.id = r.part_id
         LEFT JOIN supplier sup ON sup.id = r.supplier_id LEFT JOIN supplier_site ss ON ss.id = r.site_id
        WHERE ($1::text IS NULL OR r.status = $1 OR ($1 = 'ACTIVE' AND r.status IN ('OPEN', 'SOURCE_CREATED')))
        ORDER BY r.created_at DESC LIMIT 200`,
      [q.status ?? null],
    );
  });

  app.post('/api/sourcing', async (req, reply) => {
    const auth = await requireCapability(db, req, 'sourcing.manage', { action: 'sourcing.create', consequential: false });
    const body = intake.parse(req.body);
    if (!body.partId && !body.proposedPartNumber) throw unprocessable('Select a company part or enter the proposed part number');
    const created = await withTransaction(db, async (tx) => {
      if (body.siteId && (!body.supplierId || !(await one(tx, 'SELECT 1 FROM supplier_site WHERE id = $1 AND supplier_id = $2', [body.siteId, body.supplierId])))) {
        throw unprocessable('The site does not belong to the selected supplier');
      }
      const ownerId = body.ownerId ?? auth.userId;
      const number = await nextRecordNumber(tx, 'SR');
      const r = await one<{ id: string }>(
        tx,
        `INSERT INTO sourcing_request (number, title, pathway, part_id, proposed_part_number, description, supplier_id, site_id, supplier_part_number,
            configuration, commercial_rationale, quantity_note, owner_id, target_date, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10,'STANDARD'),$11,$12,$13,$14,$15) RETURNING id`,
        [
          number,
          body.title,
          body.pathway,
          body.partId ?? null,
          body.proposedPartNumber ?? null,
          body.description ?? null,
          body.supplierId ?? null,
          body.siteId ?? null,
          body.supplierPartNumber ?? null,
          body.configuration ?? null,
          body.commercialRationale ?? null,
          body.quantityNote ?? null,
          ownerId,
          body.targetDate ?? null,
          auth.userId,
        ],
      );
      await tx.query(
        `INSERT INTO work_item (kind, title, subject_type, subject_id, assignee_id, due_at) VALUES ('SOURCING_REQUEST', $1, 'SOURCING_REQUEST', $2, $3, $4)`,
        [`${number}: ${body.title}`.slice(0, 200), r!.id, ownerId, body.targetDate ?? null],
      );
      await audit(tx, { actorId: auth.userId, action: 'sourcing.create', entityType: 'sourcing_request', entityId: r!.id, summary: `${number} started (path ${body.pathway})`, requestId: req.id });
      return { id: r!.id, number };
    });
    return reply.code(201).send(created);
  });

  app.get('/api/sourcing/:id', async (req) => {
    const auth = await requireCapability(db, req, 'records.read', { action: 'sourcing.read', consequential: false });
    const { id } = req.params as { id: string };
    if (!uuid.safeParse(id).success) throw notFound('Sourcing request');
    const request = await one<Record<string, unknown> & { source_id: string | null; owner_id: string; status: string }>(
      db,
      `SELECT r.*, p.part_number, p.description AS part_description, sup.legal_name AS supplier_name, ss.name AS site_name, o.display_name AS owner_name
         FROM sourcing_request r JOIN app_user o ON o.id = r.owner_id LEFT JOIN company_part p ON p.id = r.part_id
         LEFT JOIN supplier sup ON sup.id = r.supplier_id LEFT JOIN supplier_site ss ON ss.id = r.site_id WHERE r.id = $1`,
      [id],
    );
    if (!request) throw notFound('Sourcing request');
    const [risks, requirements, history] = await Promise.all([
      many(
        db,
        `SELECT ra.id, ra.inputs, ra.rule_version AS "ruleVersion", ra.score, ra.result, ra.rationale, ra.assessed_at AS "assessedAt", u.display_name AS "assessedBy"
           FROM risk_assessment ra JOIN app_user u ON u.id = ra.assessed_by WHERE ra.sourcing_request_id = $1 ORDER BY ra.assessed_at DESC`,
        [id],
      ),
      many(
        db,
        `SELECT r.id, r.code, r.title, r.applicability, r.rationale, r.rule_version AS "ruleVersion", r.status, r.satisfaction_note AS "satisfactionNote",
                r.waiver_reason AS "waiverReason", r.version, sb.display_name AS "satisfiedBy", r.satisfied_at AS "satisfiedAt", wb.display_name AS "waivedBy", r.waived_at AS "waivedAt",
                coalesce((SELECT json_agg(json_build_object('linkId', l.id, 'fileId', f.id, 'name', f.original_name, 'sha256', f.sha256) ORDER BY l.linked_at)
                            FROM evidence_link l JOIN file_object f ON f.id = l.file_id
                           WHERE l.entity_type = 'EVIDENCE_REQUIREMENT' AND l.entity_id = r.id AND l.unlinked_at IS NULL AND f.status = 'AVAILABLE'), '[]') AS files
           FROM evidence_requirement r LEFT JOIN app_user sb ON sb.id = r.satisfied_by LEFT JOIN app_user wb ON wb.id = r.waived_by
          WHERE r.sourcing_request_id = $1
          ORDER BY CASE r.applicability WHEN 'REQUIRED' THEN 0 WHEN 'CONDITIONAL' THEN 1 ELSE 2 END, r.code`,
        [id],
      ),
      many(
        db,
        `SELECT a.occurred_at AS "occurredAt", a.action, a.outcome, a.summary, a.reason, u.display_name AS actor
           FROM audit_event a LEFT JOIN app_user u ON u.id = a.actor_id WHERE a.entity_type = 'sourcing_request' AND a.entity_id = $1 ORDER BY a.id`,
        [id],
      ),
    ]);
    const gates = request.source_id ? await evaluateGates(db, request.source_id, svc.config.displayTimeZone) : null;
    const status = request.source_id ? (await effectiveSourceStatuses(db, [request.source_id])).get(request.source_id) : null;
    return {
      request,
      risks,
      requirements,
      history,
      gates: gates ? { gates: gates.gates, approvable: gates.approvable, conditionalOnly: gates.conditionalOnly } : null,
      sourceStatus: status ?? null,
      riskFactors: RISK_FACTORS,
      permissions: {
        canManage: has(auth, 'sourcing.manage') && ['OPEN', 'SOURCE_CREATED'].includes(request.status),
        canWaive: has(auth, 'requirement.waive'),
      },
    };
  });

  app.patch('/api/sourcing/:id', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'sourcing.manage', { action: 'sourcing.edit', entityType: 'sourcing_request', entityId: id });
    const body = intake.partial().extend({ expectedVersion: z.number().int() }).parse(req.body);
    if (!uuid.safeParse(id).success) throw notFound('Sourcing request');
    return withTransaction(db, async (tx) => {
      const r = await lockRequest(tx, id);
      if (r.version !== body.expectedVersion) throw conflict('This request changed; reload and try again');
      if (!['OPEN', 'SOURCE_CREATED'].includes(r.status)) throw conflict('This request is closed');
      if (r.source_id && (body.pathway || body.partId || body.supplierId || body.siteId || body.supplierPartNumber || body.configuration)) {
        throw conflict('The exact source is already identified; identity fields can no longer change');
      }
      if (body.pathway && body.pathway !== r.pathway && (await one(tx, 'SELECT 1 FROM risk_assessment WHERE sourcing_request_id = $1', [id]))) {
        throw conflict('The pathway cannot change after risk and evidence were assessed; cancel and start a new request');
      }
      const fields: Array<[string, unknown]> = [
        ['title', body.title],
        ['pathway', body.pathway],
        ['part_id', body.partId],
        ['proposed_part_number', body.proposedPartNumber],
        ['description', body.description],
        ['supplier_id', body.supplierId],
        ['site_id', body.siteId],
        ['supplier_part_number', body.supplierPartNumber],
        ['configuration', body.configuration],
        ['commercial_rationale', body.commercialRationale],
        ['quantity_note', body.quantityNote],
        ['target_date', body.targetDate],
        ['owner_id', body.ownerId],
      ];
      const set = fields.filter(([, v]) => v !== undefined);
      if (set.length) {
        await tx.query(
          `UPDATE sourcing_request SET ${set.map(([c], i) => `${c} = $${i + 2}`).join(', ')}, version = version + 1 WHERE id = $1`,
          [id, ...set.map(([, v]) => v)],
        );
      }
      const after = await one<{ site_id: string | null; supplier_id: string | null }>(tx, 'SELECT site_id, supplier_id FROM sourcing_request WHERE id = $1', [id]);
      if (after?.site_id && !(await one(tx, 'SELECT 1 FROM supplier_site WHERE id = $1 AND supplier_id = $2', [after.site_id, after.supplier_id]))) {
        throw unprocessable('The site does not belong to the selected supplier');
      }
      await audit(tx, { actorId: auth.userId, action: 'sourcing.edit', entityType: 'sourcing_request', entityId: id, summary: `Intake updated (${set.map(([c]) => c).join(', ')})`, requestId: req.id });
      return { ok: true };
    });
  });

  app.post('/api/sourcing/:id/risk', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'sourcing.manage', { action: 'sourcing.risk', entityType: 'sourcing_request', entityId: id });
    const factor = z.union([z.literal(1), z.literal(2), z.literal(3)]);
    const body = z
      .object({ inputs: z.object(Object.fromEntries(RISK_FACTORS.map((f) => [f.key, factor])) as Record<string, typeof factor>), rationale: z.string().trim().max(2000).nullable().optional() })
      .parse(req.body);
    if (!uuid.safeParse(id).success) throw notFound('Sourcing request');
    const inputs = body.inputs as RiskInputs;
    const { score, result } = assessRisk(inputs);
    return withTransaction(db, async (tx) => {
      const r = await lockRequest(tx, id);
      if (!['OPEN', 'SOURCE_CREATED'].includes(r.status)) throw conflict('This request is closed');
      await tx.query(
        `INSERT INTO risk_assessment (sourcing_request_id, inputs, rule_version, score, result, rationale, assessed_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [id, JSON.stringify(inputs), RISK_RULE_VERSION, score, result, body.rationale ?? null, auth.userId],
      );
      // Add missing checklist items; re-evaluate only OPEN items so satisfied/waived evidence is never erased (FR-027).
      for (const item of buildChecklist(r.pathway, result)) {
        await tx.query(
          `INSERT INTO evidence_requirement (sourcing_request_id, code, title, applicability, rationale, rule_version) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (sourcing_request_id, code) DO UPDATE SET applicability = EXCLUDED.applicability, rationale = EXCLUDED.rationale,
             rule_version = EXCLUDED.rule_version, version = evidence_requirement.version + 1
           WHERE evidence_requirement.status = 'OPEN'`,
          [id, item.code, item.title, item.applicability, item.rationale, CHECKLIST_RULE_VERSION],
        );
      }
      await tx.query('UPDATE sourcing_request SET version = version + 1 WHERE id = $1', [id]);
      await audit(tx, {
        actorId: auth.userId,
        action: 'sourcing.risk',
        entityType: 'sourcing_request',
        entityId: id,
        summary: `Risk assessed ${result} (score ${score}, ${RISK_RULE_VERSION}); checklist ${CHECKLIST_RULE_VERSION} applied`,
        after: inputs,
        requestId: req.id,
      });
      return { score, result };
    });
  });

  app.post('/api/requirements/:id/satisfy', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'sourcing.manage', { action: 'requirement.satisfy', entityType: 'evidence_requirement', entityId: id });
    const body = z.object({ expectedVersion: z.number().int(), note: z.string().trim().max(2000).nullable().optional() }).parse(req.body);
    if (!uuid.safeParse(id).success) throw notFound('Requirement');
    return withTransaction(db, async (tx) => {
      const r = await one<{ status: string; version: number; code: string; sourcing_request_id: string }>(
        tx,
        'SELECT status, version, code, sourcing_request_id FROM evidence_requirement WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!r) throw notFound('Requirement');
      if (r.version !== body.expectedVersion) throw conflict('This item changed; reload and try again');
      if (r.status !== 'OPEN') throw conflict(`This item is already ${r.status.toLowerCase()}`);
      const files = await one<{ n: number }>(
        tx,
        `SELECT count(*)::int AS n FROM evidence_link l JOIN file_object f ON f.id = l.file_id
          WHERE l.entity_type = 'EVIDENCE_REQUIREMENT' AND l.entity_id = $1 AND l.unlinked_at IS NULL AND f.status = 'AVAILABLE'`,
        [id],
      );
      if (!files!.n) throw unprocessable('Attach the evidence document before marking this item satisfied');
      await tx.query(
        `UPDATE evidence_requirement SET status = 'SATISFIED', satisfied_by = $2, satisfied_at = now(), satisfaction_note = $3, version = version + 1 WHERE id = $1`,
        [id, auth.userId, body.note ?? null],
      );
      await audit(tx, { actorId: auth.userId, action: 'requirement.satisfy', entityType: 'sourcing_request', entityId: r.sourcing_request_id, summary: `${r.code} satisfied (${files!.n} file(s))`, requestId: req.id });
      return { status: 'SATISFIED' };
    });
  });

  app.post('/api/requirements/:id/waive', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'requirement.waive', { action: 'requirement.waive', entityType: 'evidence_requirement', entityId: id });
    const body = z.object({ expectedVersion: z.number().int(), reason: z.string().trim().min(10).max(2000) }).parse(req.body);
    if (!uuid.safeParse(id).success) throw notFound('Requirement');
    return withTransaction(db, async (tx) => {
      const r = await one<{ status: string; version: number; code: string; applicability: string; sourcing_request_id: string }>(
        tx,
        'SELECT status, version, code, applicability, sourcing_request_id FROM evidence_requirement WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!r) throw notFound('Requirement');
      if (r.version !== body.expectedVersion) throw conflict('This item changed; reload and try again');
      if (r.status !== 'OPEN') throw conflict(`This item is already ${r.status.toLowerCase()}`);
      if (!(await recheckCapability(tx, auth.userId, 'requirement.waive'))) throw forbidden();
      await tx.query(
        `UPDATE evidence_requirement SET status = 'WAIVED', waived_by = $2, waived_at = now(), waiver_reason = $3, version = version + 1 WHERE id = $1`,
        [id, auth.userId, body.reason],
      );
      await audit(tx, {
        actorId: auth.userId,
        action: 'requirement.waive',
        entityType: 'sourcing_request',
        entityId: r.sourcing_request_id,
        summary: `${r.code} (${r.applicability.toLowerCase()}) waived`,
        reason: body.reason,
        requestId: req.id,
      });
      return { status: 'WAIVED' };
    });
  });

  // Identifies (or links) the exact source: part + supplier + site + supplier part + configuration + baseline revision.
  app.post('/api/sourcing/:id/source', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'sourcing.manage', { action: 'source.create', entityType: 'sourcing_request', entityId: id });
    const body = z.object({ expectedVersion: z.number().int(), baselineRevisionId: uuid }).parse(req.body);
    if (!uuid.safeParse(id).success) throw notFound('Sourcing request');
    const result = await withTransaction(db, async (tx) => {
      const r = await lockRequest(tx, id);
      if (r.version !== body.expectedVersion) throw conflict('This request changed; reload and try again');
      if (r.status !== 'OPEN') throw conflict('The exact source has already been identified or the request is closed');
      const full = await one<{ part_id: string | null; supplier_id: string | null; site_id: string | null; supplier_part_number: string | null; configuration: string; pathway: 'A' | 'B' | 'C' }>(
        tx,
        'SELECT part_id, supplier_id, site_id, supplier_part_number, configuration, pathway FROM sourcing_request WHERE id = $1',
        [id],
      );
      const missing = [!full!.part_id && 'company part', !full!.supplier_id && 'supplier', !full!.site_id && 'manufacturing site', !full!.supplier_part_number && 'supplier part number'].filter(Boolean);
      if (missing.length) throw unprocessable(`Complete the intake first: ${missing.join(', ')}`);
      const rev = await one<{ part_id: string; ownership: string }>(
        tx,
        `SELECT b.part_id, b.ownership FROM baseline_revision r JOIN technical_baseline b ON b.id = r.baseline_id WHERE r.id = $1`,
        [body.baselineRevisionId],
      );
      const expected = { A: 'PDI', B: 'SUPPLIER', C: 'SUPPLIER_PLUS_DELTA' }[full!.pathway];
      if (!rev || rev.part_id !== full!.part_id) throw unprocessable('The baseline revision does not belong to this part');
      if (rev.ownership !== expected) throw unprocessable(`Path ${full!.pathway} must be governed by a ${expected.replaceAll('_', ' ').toLowerCase()} baseline`);
      const sp = await one<{ id: string }>(
        tx,
        `INSERT INTO supplier_part (supplier_id, supplier_part_number, normalized) VALUES ($1,$2,$3)
         ON CONFLICT (supplier_id, normalized) DO UPDATE SET supplier_part_number = supplier_part.supplier_part_number RETURNING id`,
        [full!.supplier_id, full!.supplier_part_number, normalize(full!.supplier_part_number!)],
      );
      const existing = await one<{ id: string }>(
        tx,
        `SELECT id FROM source WHERE part_id = $1 AND supplier_id = $2 AND site_id = $3 AND supplier_part_id = $4 AND configuration = $5 AND baseline_revision_id = $6`,
        [full!.part_id, full!.supplier_id, full!.site_id, sp!.id, full!.configuration, body.baselineRevisionId],
      );
      if (existing && (await one(tx, `SELECT 1 FROM sourcing_request WHERE source_id = $1 AND status <> 'CANCELLED' AND id <> $2`, [existing.id, id]))) {
        throw conflict('This exact source is already being qualified under another sourcing request');
      }
      const sourceId =
        existing?.id ??
        (await one<{ id: string }>(
          tx,
          `INSERT INTO source (part_id, supplier_id, site_id, supplier_part_id, configuration, baseline_revision_id, pathway, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [full!.part_id, full!.supplier_id, full!.site_id, sp!.id, full!.configuration, body.baselineRevisionId, full!.pathway, auth.userId],
        ))!.id;
      await tx.query(`UPDATE sourcing_request SET status = 'SOURCE_CREATED', source_id = $2, version = version + 1 WHERE id = $1`, [id, sourceId]);
      await audit(tx, {
        actorId: auth.userId,
        action: 'source.create',
        entityType: 'sourcing_request',
        entityId: id,
        summary: `${existing ? 'Linked existing' : 'Identified new'} exact source`,
        after: { sourceId },
        requestId: req.id,
      });
      await audit(tx, { actorId: auth.userId, action: 'source.create', entityType: 'source', entityId: sourceId, summary: `Source ${existing ? 'linked to' : 'identified by'} ${r.number}`, requestId: req.id });
      return { sourceId };
    });
    return reply.code(201).send(result);
  });

  app.post('/api/sourcing/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'sourcing.manage', { action: 'sourcing.cancel', entityType: 'sourcing_request', entityId: id });
    const body = z.object({ reason: z.string().trim().min(5).max(2000) }).parse(req.body);
    if (!uuid.safeParse(id).success) throw notFound('Sourcing request');
    return withTransaction(db, async (tx) => {
      const r = await lockRequest(tx, id);
      if (!['OPEN', 'SOURCE_CREATED'].includes(r.status)) throw conflict('This request is already closed');
      await tx.query(`UPDATE sourcing_request SET status = 'CANCELLED', version = version + 1 WHERE id = $1`, [id]);
      await tx.query(`UPDATE work_item SET status = 'CANCELLED', closed_at = now(), closed_by = $2, closed_reason = $3 WHERE subject_type = 'SOURCING_REQUEST' AND subject_id = $1 AND status = 'OPEN'`, [
        id,
        auth.userId,
        body.reason,
      ]);
      await audit(tx, { actorId: auth.userId, action: 'sourcing.cancel', entityType: 'sourcing_request', entityId: id, summary: `${r.number} cancelled`, reason: body.reason, requestId: req.id });
      return { status: 'CANCELLED' };
    });
  });
}
