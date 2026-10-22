import { EFFECTIVE_OUTCOME_SQL, completedOn } from '../reports/metrics.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { has, requireCapability } from '../auth.js';
import { many, one } from '../db.js';
import { renderInspectionReport } from '../pdf/inspection-report.js';
import type { Services } from '../services.js';
import { loadPhotoBytes } from './report-job.js';
import { buildReportSnapshot } from './report-snapshot.js';
import {
  activateSection,
  amendInspection,
  completeInspection,
  createInspection,
  passAll,
  reviewInspection,
  saveEntries,
  savePartial,
} from './service.js';
import { stageSection, stagesOf } from './stages.js';
import { loadInspection } from './state.js';

const statusEnum = z.enum(['P', 'F', 'A', 'N']).nullable();
const entryChange = z.object({
  unitIndex: z.number().int().min(0).max(100),
  sectionKey: z.string().max(64),
  rowKey: z.string().max(80),
  status: statusEnum.optional(),
  note: z.string().max(2000).nullable().optional(),
  readings: z.record(z.string().max(16), z.string().max(64).nullable()).optional(),
});
const unitChange = z.object({
  unitIndex: z.number().int().min(1).max(100),
  serialNumber: z.string().max(80).nullable().optional(),
  dispositionNote: z.string().max(2000).nullable().optional(),
});

const createBody = z.object({
  partId: z.string().uuid(),
  formRevisionId: z.string().uuid(),
  unitCount: z.number().int().min(1).max(100),
  poNumber: z.string().max(60).nullable().optional(),
  dateReceived: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  inspectorId: z.string().uuid().nullable().optional(),
  sourceId: z.string().uuid().nullable().optional(),
  lotNumber: z.string().max(80).nullable().optional(),
  lotSize: z.number().int().min(1).max(10_000_000).nullable().optional(),
  samplingNote: z.string().max(500).nullable().optional(),
});

const listQuery = z.object({
  q: z.string().max(100).optional(),
  status: z.enum(['DRAFT', 'PARTIAL', 'OPEN', 'READY_FOR_REVIEW', 'COMPLETED']).optional(),
  outcome: z.enum(['PASS', 'FAIL', 'ACCEPTED']).optional(),
  mine: z.enum(['1']).optional(),
  partId: z.string().uuid().optional(),
  supplierId: z.string().uuid().optional(),
  completedFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  completedTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
});

const PAGE_SIZE = 50;

/**
 * Inspections whose number, part, description, PO, lot, item serial or part alias contains the term ($?).
 * One SELECT per column lets each use its trigram index (migration 0008); an OR across columns does not.
 */
const INSPECTION_SEARCH_SQL = ['number', 'part_number', 'part_description', 'po_number', 'lot_number']
  .map((c) => `SELECT x.id FROM inspection x WHERE x.${c} ILIKE $?`)
  .concat(['SELECT iu.inspection_id FROM inspection_unit iu WHERE iu.serial_number ILIKE $?', 'SELECT x.id FROM inspection x JOIN part_alias pa ON pa.part_id = x.part_id WHERE pa.alias ILIKE $?'])
  .join(' UNION ');

export function registerInspectionRoutes(app: FastifyInstance, svc: Services) {
  const { db, config } = svc;

  app.get('/api/inspections', async (req) => {
    const auth = await requireCapability(db, req, 'records.read', { action: 'inspection.list', consequential: false });
    const q = listQuery.parse(req.query);
    const where: string[] = ["i.status <> 'VOID'"];
    const params: unknown[] = [];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replaceAll('$?', `$${params.length}`));
    };
    if (q.q?.trim()) {
      add(
        // A UNION of index-backed matches (trigram indexes, migration 0008) instead of correlated EXISTS inside an OR.
        `i.id IN (${INSPECTION_SEARCH_SQL})`,
        `%${q.q.trim().replace(/[%_\\]/g, '\\$&')}%`,
      );
    }
    if (q.status === 'OPEN') where.push("i.status IN ('DRAFT', 'PARTIAL')");
    else if (q.status) add('i.status = $?', q.status);
    // Same effective outcome and completion-date definitions as the reports (drill-down consistency).
    if (q.outcome) add(`${EFFECTIVE_OUTCOME_SQL} = $?`, q.outcome);
    if (q.mine) add('i.inspector_id = $?', auth.userId);
    if (q.partId) add('i.part_id = $?', q.partId);
    if (q.supplierId) add('i.supplier_id = $?', q.supplierId);
    if (q.completedFrom || q.completedTo) {
      params.push(config.displayTimeZone);
      const tzRef = `$${params.length}`;
      if (q.completedFrom) add(`${completedOn(tzRef)} >= $?::date`, q.completedFrom);
      if (q.completedTo) add(`${completedOn(tzRef)} <= $?::date`, q.completedTo);
    }
    const whereSql = where.join(' AND ');
    const total = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM inspection i WHERE ${whereSql}`, params);
    const items = await many(
      db,
      `SELECT i.id, i.number, i.part_number AS "partNumber", i.part_description AS "partDescription", i.po_number AS "poNumber",
              i.lot_number AS "lotNumber", i.date_received AS "dateReceived", i.status, i.unit_count AS "unitCount",
              coalesce((SELECT a.resulting_outcome FROM inspection_amendment a WHERE a.inspection_id = i.id ORDER BY a.amendment_no DESC LIMIT 1), i.outcome) AS outcome,
              u.display_name AS inspector, i.created_at AS "createdAt", i.completed_at AS "completedAt",
              fr.definition->>'formNumber' AS "formNumber", fr.revision_label AS "formRevision"
         FROM inspection i JOIN app_user u ON u.id = i.inspector_id JOIN form_revision fr ON fr.id = i.form_revision_id
        WHERE ${whereSql}
        ORDER BY i.created_at DESC, i.number DESC
        LIMIT ${PAGE_SIZE} OFFSET ${(q.page - 1) * PAGE_SIZE}`,
      params,
    );
    const counts = await many<{ status: string; n: number }>(
      db,
      `SELECT status, count(*)::int AS n FROM inspection WHERE status <> 'VOID' GROUP BY status`,
    );
    return { items, total: total!.n, page: q.page, pageSize: PAGE_SIZE, statusCounts: Object.fromEntries(counts.map((c) => [c.status, c.n])) };
  });

  app.post('/api/inspections', async (req, reply) => {
    await requireCapability(db, req, 'inspection.perform', { action: 'inspection.create' });
    const body = createBody.parse(req.body);
    const created = await createInspection(db, req, body);
    return reply.code(201).send(created);
  });

  app.get('/api/inspections/:id', async (req) => {
    const auth = await requireCapability(db, req, 'records.read', { action: 'inspection.read', consequential: false });
    const { id } = req.params as { id: string };
    const state = await loadInspection(db, id);
    const r = state.row;
    const [reviews, amendments, reports, pendingSnapshots, concerns, failedJob] = await Promise.all([
      many(
        db,
        `SELECT r.decision, u.display_name AS reviewer, r.reviewed_at AS "reviewedAt", r.comment, r.grants_used AS "grantsUsed"
           FROM inspection_review r JOIN app_user u ON u.id = r.reviewer_id WHERE r.inspection_id = $1 ORDER BY r.reviewed_at`,
        [id],
      ),
      many(
        db,
        `SELECT a.amendment_no AS "amendmentNo", a.reason, a.resulting_outcome AS "resultingOutcome", u.display_name AS "amendedBy", a.amended_at AS "amendedAt"
           FROM inspection_amendment a JOIN app_user u ON u.id = a.amended_by WHERE a.inspection_id = $1 ORDER BY a.amendment_no`,
        [id],
      ),
      many(
        db,
        `SELECT id AS "renditionId", edition, file_id AS "fileId", sha256, page_count AS "pageCount", rendered_at AS "renderedAt"
           FROM report_rendition WHERE subject_type = 'INSPECTION' AND subject_id = $1 ORDER BY edition`,
        [id],
      ),
      one<{ n: number }>(
        db,
        `SELECT count(*)::int AS n FROM report_snapshot s WHERE s.subject_type = 'INSPECTION' AND s.subject_id = $1
            AND NOT EXISTS (SELECT 1 FROM report_rendition rr WHERE rr.snapshot_id = s.id)`,
        [id],
      ),
      many(
        db,
        `SELECT id, number, title, status, unit_index AS "unitIndex", section_key AS "sectionKey", row_key AS "rowKey"
           FROM quality_event WHERE inspection_id = $1 ORDER BY reported_at`,
        [id],
      ),
      one<{ last_error: string }>(
        db,
        `SELECT j.last_error FROM job j JOIN report_snapshot s ON j.idempotency_key = 'inspection_report:' || s.id
          WHERE s.subject_id = $1 AND j.status = 'FAILED_PERMANENT' ORDER BY j.id DESC LIMIT 1`,
        [id],
      ),
    ]);
    // Accepted items are covered only by a recorded concession use; the inspection itself never releases material (NEG-06).
    const concessionUse = await one<{ id: string; number: string; quantity: number; valid_until: string }>(
      db,
      `SELECT c.id, c.number, u.quantity, c.valid_until::text FROM concession_use u JOIN concession c ON c.id = u.concession_id WHERE u.inspection_id = $1 AND u.released_at IS NULL`,
      [id],
    );
    const editable = ['DRAFT', 'PARTIAL'].includes(r.status) && r.inspector_id === auth.userId && has(auth, 'inspection.perform');
    return {
      id: r.id,
      number: r.number,
      status: r.status,
      outcome: state.effectiveOutcome,
      reportedOutcome: r.outcome,
      version: r.version,
      partId: r.part_id,
      partNumber: r.part_number,
      partDescription: r.part_description,
      poNumber: r.po_number,
      dateReceived: r.date_received,
      lotNumber: r.lot_number,
      lotSize: r.lot_size,
      samplingNote: r.sampling_note,
      unitCount: r.unit_count,
      inspector: { id: r.inspector_id, name: r.inspector_name },
      supplier: r.supplier_id ? { id: r.supplier_id, name: r.supplier_name } : null,
      site: r.site_id ? { id: r.site_id, name: r.site_name } : null,
      sourceId: r.source_id,
      sourceState: r.source_state_at_start,
      createdAt: r.created_at,
      submittedAt: r.submitted_at,
      completedAt: r.completed_at,
      completedBy: r.completed_by_name,
      amendmentCount: r.amendment_count,
      form: { revisionId: r.form_revision_id, definition: r.form_snapshot, sha256: r.form_snapshot_sha256 },
      baseline: r.baseline_snapshot,
      limits: state.limits,
      units: state.units.map((u) => ({ unitIndex: u.unit_index, serialNumber: u.serial_number, dispositionNote: u.disposition_note })),
      activated: state.activated,
      responses: state.responses,
      readings: state.readings,
      photos: state.photos.map((p) => ({
        linkId: p.link_id,
        fileId: p.file_id,
        unitIndex: p.unit_index,
        sectionKey: p.section_key,
        rowKey: p.row_key,
        caption: p.caption,
        width: p.width,
        height: p.height,
        linkedAt: p.linked_at,
        linkedBy: p.linked_by_name,
      })),
      evaluation: state.evaluation,
      reviewReasons: r.review_reasons,
      reviews,
      amendments,
      reports,
      reportPending: pendingSnapshots!.n > 0,
      reportError: failedJob ? 'Report generation failed; an administrator has been notified in the job log.' : null,
      concerns,
      concession: concessionUse ? { id: concessionUse.id, number: concessionUse.number, quantity: concessionUse.quantity, validUntil: concessionUse.valid_until } : null,
      permissions: {
        canEdit: editable,
        canReview: r.status === 'READY_FOR_REVIEW' && has(auth, 'inspection.review') && r.inspector_id !== auth.userId,
        canReviewAccepted: has(auth, 'inspection.review_accepted'),
        canAmend: r.status === 'COMPLETED' && has(auth, 'inspection.amend'),
        canCaptureConcern: has(auth, 'quality.capture'),
        canRequestConcession: has(auth, 'concession.request'),
      },
      // Cylinder head Stage 2: per-head follow-on records of a completed inspection whose form has the fire ring section.
      stages: await stagesOf(db, id),
      stage2: {
        available: r.status === 'COMPLETED' && stageSection(r.form_snapshot) !== null,
        canStart: r.status === 'COMPLETED' && stageSection(r.form_snapshot) !== null && has(auth, 'inspection.perform'),
      },
    };
  });

  app.patch('/api/inspections/:id/entries', async (req) => {
    const { id } = req.params as { id: string };
    await requireCapability(db, req, 'inspection.perform', { action: 'inspection.edit', entityType: 'inspection', entityId: id });
    const body = z
      .object({ expectedVersion: z.number().int(), changes: z.array(entryChange).max(500), units: z.array(unitChange).max(100).optional() })
      .parse(req.body);
    return saveEntries(db, req, id, body);
  });

  app.post('/api/inspections/:id/sections', async (req) => {
    const { id } = req.params as { id: string };
    await requireCapability(db, req, 'inspection.perform', { action: 'inspection.edit', entityType: 'inspection', entityId: id });
    const body = z.object({ expectedVersion: z.number().int(), unitIndex: z.number().int(), sectionKey: z.string().max(64) }).parse(req.body);
    return activateSection(db, req, id, body);
  });

  app.post('/api/inspections/:id/pass-all', async (req) => {
    const { id } = req.params as { id: string };
    await requireCapability(db, req, 'inspection.perform', { action: 'inspection.edit', entityType: 'inspection', entityId: id });
    const body = z
      .object({
        expectedVersion: z.number().int(),
        unitIndex: z.number().int(),
        sectionKey: z.string().max(64),
        mode: z.enum(['fill_blank', 'overwrite_all']),
      })
      .parse(req.body);
    return passAll(db, req, id, body);
  });

  app.post('/api/inspections/:id/save-partial', async (req) => {
    const { id } = req.params as { id: string };
    await requireCapability(db, req, 'inspection.perform', { action: 'inspection.edit', entityType: 'inspection', entityId: id });
    const body = z.object({ expectedVersion: z.number().int() }).parse(req.body);
    return savePartial(db, req, id, body.expectedVersion);
  });

  app.post('/api/inspections/:id/complete', async (req) => {
    const { id } = req.params as { id: string };
    await requireCapability(db, req, 'inspection.perform', { action: 'inspection.complete', entityType: 'inspection', entityId: id });
    const body = z.object({ expectedVersion: z.number().int() }).parse(req.body);
    return completeInspection(db, config, req, id, body.expectedVersion);
  });

  app.post('/api/inspections/:id/review', async (req) => {
    const { id } = req.params as { id: string };
    await requireCapability(db, req, 'inspection.review', { action: 'inspection.review', entityType: 'inspection', entityId: id });
    const body = z
      .object({
        decision: z.enum(['CONFIRM', 'RETURN']),
        comment: z.string().max(2000).nullable().optional(),
        expectedVersion: z.number().int(),
        concessionId: z.string().uuid().nullable().optional(),
      })
      .parse(req.body);
    return reviewInspection(db, config, req, id, body);
  });

  app.post('/api/inspections/:id/amendments', async (req) => {
    const { id } = req.params as { id: string };
    await requireCapability(db, req, 'inspection.amend', { action: 'inspection.amend', entityType: 'inspection', entityId: id });
    const body = z
      .object({ reason: z.string().max(2000), changes: z.array(entryChange).min(1).max(200), expectedVersion: z.number().int() })
      .parse(req.body);
    return amendInspection(db, config, req, id, body);
  });

  app.get('/api/inspections/:id/history', async (req) => {
    await requireCapability(db, req, 'records.read', { action: 'inspection.history', consequential: false });
    const { id } = req.params as { id: string };
    return many(
      db,
      `SELECT a.id, a.occurred_at AS "occurredAt", a.action, a.outcome, a.summary, a.reason, u.display_name AS actor
         FROM audit_event a LEFT JOIN app_user u ON u.id = a.actor_id
        WHERE a.entity_type = 'inspection' AND a.entity_id = $1 ORDER BY a.id`,
      [id],
    );
  });

  // Draft/print preview rendered on demand from current entries; never stored as a controlled edition.
  app.get('/api/inspections/:id/preview.pdf', async (req, reply) => {
    await requireCapability(db, req, 'records.read', { action: 'inspection.preview', consequential: false });
    const { id } = req.params as { id: string };
    const state = await loadInspection(db, id);
    const snapshot = buildReportSnapshot(state, {
      edition: 0,
      draft: true,
      displayTimeZone: config.displayTimeZone,
      generatedAt: new Date(),
      outcome: state.evaluation.errors.length ? null : state.evaluation.overall,
      review: null,
      amendment: null,
    });
    const { bytes } = await renderInspectionReport({ snapshot, logo: svc.logo, photoBytes: await loadPhotoBytes(svc, snapshot) });
    reply
      .header('Content-Type', 'application/pdf')
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', `inline; filename="${state.row.number}-preview.pdf"`);
    return reply.send(bytes);
  });
}
