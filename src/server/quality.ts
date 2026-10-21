import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readingLimitRef, sectionRows } from '../shared/forms.js';
import { readingId, rowId } from '../shared/inspection.js';
import { formatLimit } from '../shared/measurement.js';
import { audit } from './audit.js';
import { has, recheckCapability, requireCapability } from './auth.js';
import { many, one, withTransaction } from './db.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from './errors.js';
import { loadInspection } from './inspections/state.js';
import { nextRecordNumber } from './numbering.js';
import type { Services } from './services.js';

const uuid = z.string().uuid();

const quickCapture = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().trim().min(3).max(4000),
  ownerId: uuid.nullable().optional(),
  partId: uuid.nullable().optional(),
  supplierId: uuid.nullable().optional(),
  poNumber: z.string().max(60).nullable().optional(),
  lotNumber: z.string().max(80).nullable().optional(),
});

export function registerQualityRoutes(app: FastifyInstance, svc: Services) {
  const { db } = svc;

  app.get('/api/quality/events', async (req) => {
    await requireCapability(db, req, 'records.read', { action: 'quality.list', consequential: false });
    const q = z.object({ status: z.string().max(20).optional(), q: z.string().max(100).optional() }).parse(req.query);
    const params: unknown[] = [];
    const where: string[] = ['true'];
    if (q.status === 'OPEN') where.push("e.status IN ('CAPTURED', 'TRIAGED')");
    else if (q.status) {
      params.push(q.status);
      where.push(`e.status = $${params.length}`);
    }
    if (q.q?.trim()) {
      params.push(`%${q.q.trim().replace(/[%_\\]/g, '\\$&')}%`);
      where.push(`(e.number ILIKE $${params.length} OR e.title ILIKE $${params.length} OR p.part_number ILIKE $${params.length})`);
    }
    return many(
      db,
      `SELECT e.id, e.number, e.title, e.status, e.severity, e.origin_type AS "originType", e.reported_at AS "reportedAt",
              r.display_name AS "reportedBy", o.display_name AS owner, p.part_number AS "partNumber", s.legal_name AS supplier,
              i.number AS "inspectionNumber"
         FROM quality_event e
         JOIN app_user r ON r.id = e.reported_by
         LEFT JOIN app_user o ON o.id = e.owner_id
         LEFT JOIN company_part p ON p.id = e.part_id
         LEFT JOIN supplier s ON s.id = e.supplier_id
         LEFT JOIN inspection i ON i.id = e.inspection_id
        WHERE ${where.join(' AND ')}
        ORDER BY e.reported_at DESC LIMIT 200`,
      params,
    );
  });

  app.get('/api/quality/events/:id', async (req) => {
    const auth = await requireCapability(db, req, 'records.read', { action: 'quality.read', consequential: false });
    const { id } = req.params as { id: string };
    if (!uuid.safeParse(id).success) throw notFound('Quality event');
    const event = await one<Record<string, unknown> & { reported_by: string; status: string }>(
      db,
      `SELECT e.*, r.display_name AS reported_by_name, o.display_name AS owner_name, t.display_name AS triaged_by_name,
              p.part_number, p.description AS part_description, s.legal_name AS supplier_name, ss.name AS site_name, i.number AS inspection_number
         FROM quality_event e
         JOIN app_user r ON r.id = e.reported_by
         LEFT JOIN app_user o ON o.id = e.owner_id
         LEFT JOIN app_user t ON t.id = e.triaged_by
         LEFT JOIN company_part p ON p.id = e.part_id
         LEFT JOIN supplier s ON s.id = e.supplier_id
         LEFT JOIN supplier_site ss ON ss.id = e.site_id
         LEFT JOIN inspection i ON i.id = e.inspection_id
        WHERE e.id = $1`,
      [id],
    );
    if (!event) throw notFound('Quality event');
    const photos = await many(
      db,
      `SELECT l.id AS "linkId", f.id AS "fileId", l.caption, f.width, f.height FROM evidence_link l JOIN file_object f ON f.id = l.file_id
        WHERE l.entity_type = 'QUALITY_EVENT' AND l.entity_id = $1 AND l.unlinked_at IS NULL AND f.status = 'AVAILABLE' ORDER BY l.linked_at`,
      [id],
    );
    const history = await many(
      db,
      `SELECT a.occurred_at AS "occurredAt", a.action, a.outcome, a.summary, a.reason, u.display_name AS actor
         FROM audit_event a LEFT JOIN app_user u ON u.id = a.actor_id
        WHERE a.entity_type = 'quality_event' AND a.entity_id = $1 ORDER BY a.id`,
      [id],
    );
    const ncr = await one<{ id: string; number: string; status: string }>(db, 'SELECT id, number, status FROM ncr WHERE quality_event_id = $1', [id]);
    return {
      event,
      photos,
      history,
      ncr,
      permissions: {
        canConfirmNcr: has(auth, 'ncr.manage') && event.reported_by !== auth.userId && ['CAPTURED', 'TRIAGED'].includes(event.status),
        canTriage: has(auth, 'quality.triage') && event.reported_by !== auth.userId && event.status === 'CAPTURED',
        triageBlockedReason:
          event.reported_by === auth.userId && has(auth, 'quality.triage') ? 'Triage must be performed by someone other than the reporter.' : null,
      },
    };
  });

  app.post('/api/quality/events', async (req, reply) => {
    const auth = await requireCapability(db, req, 'quality.capture', { action: 'quality.capture', consequential: false });
    const body = quickCapture.parse(req.body);
    const created = await withTransaction(db, async (tx) => {
      const number = await nextRecordNumber(tx, 'QE');
      const row = await one<{ id: string }>(
        tx,
        `INSERT INTO quality_event (number, title, description, origin_type, part_id, supplier_id, po_number, lot_number, reported_by, owner_id)
         VALUES ($1,$2,$3,'AD_HOC',$4,$5,$6,$7,$8,$9) RETURNING id`,
        [number, body.title, body.description, body.partId ?? null, body.supplierId ?? null, body.poNumber ?? null, body.lotNumber ?? null, auth.userId, body.ownerId ?? null],
      );
      await tx.query(
        `INSERT INTO work_item (kind, title, subject_type, subject_id, assignee_id, required_capability)
         VALUES ('CONCERN_TRIAGE', $1, 'QUALITY_EVENT', $2, $3, 'quality.triage')`,
        [`Triage ${number}: ${body.title}`.slice(0, 200), row!.id, body.ownerId ?? null],
      );
      await audit(tx, { actorId: auth.userId, action: 'quality.capture', entityType: 'quality_event', entityId: row!.id, summary: `${number} captured: ${body.title}`, requestId: req.id });
      return { id: row!.id, number };
    });
    return reply.code(201).send(created);
  });

  // Concern from an inspection row: carries identity, expected vs actual and the same photos (no retyping, no cloned blobs).
  app.post('/api/inspections/:id/concerns', async (req, reply) => {
    const auth = await requireCapability(db, req, 'quality.capture', { action: 'quality.capture', consequential: false });
    const { id } = req.params as { id: string };
    const body = z
      .object({
        unitIndex: z.number().int().min(0).max(100),
        sectionKey: z.string().max(64),
        rowKey: z.string().max(80),
        title: z.string().trim().max(200).optional(),
        description: z.string().trim().max(4000).optional(),
        ownerId: uuid.nullable().optional(),
      })
      .parse(req.body);
    const created = await withTransaction(db, async (tx) => {
      const state = await loadInspection(tx, id);
      const section = state.row.form_snapshot.sections.find((s) => s.key === body.sectionKey);
      const row = section ? sectionRows(section).find((r) => r.key === body.rowKey) : undefined;
      if (!section || !row) throw badRequest('Unknown characteristic');
      const rid = rowId(body.unitIndex, section.key, row.key);
      const response = state.responses[rid];
      const readings = row.readingKeys
        .map((rk, i) => {
          const v = state.readings[readingId(body.unitIndex, section.key, row.key, rk)]?.text;
          return v ? `${row.readingLabels[i]}: ${v}` : null;
        })
        .filter(Boolean)
        .join(', ');
      const limitRef = row.readingKeys[0] ? readingLimitRef(row, row.readingKeys[0]) : null;
      const limit = limitRef ? state.limits[limitRef] : undefined;
      const expected = row.source?.acceptance ?? (limit ? formatLimit(limit) : (row.source?.specText ?? 'Specification not released'));
      const actual = [response?.status ? `Recorded ${response.status === 'F' ? 'Fail' : response.status === 'A' ? 'Accepted' : response.status}` : null, readings || null, response?.note ?? null]
        .filter(Boolean)
        .join(' — ');
      const unit = state.units.find((u) => u.unit_index === body.unitIndex);
      const existing = await one(
        tx,
        `SELECT 1 FROM quality_event WHERE inspection_id = $1 AND unit_index = $2 AND section_key = $3 AND row_key = $4 AND status IN ('CAPTURED','TRIAGED')`,
        [id, body.unitIndex, section.key, row.key],
      );
      if (existing) throw conflict('An open concern already exists for this characteristic');
      const number = await nextRecordNumber(tx, 'QE');
      const title = body.title || `${state.row.part_number}: ${row.label} (${body.unitIndex === 0 ? 'receiving' : `item ${body.unitIndex}`})`;
      const event = await one<{ id: string }>(
        tx,
        `INSERT INTO quality_event (number, title, description, origin_type, inspection_id, unit_index, section_key, row_key, characteristic,
            expected, actual, part_id, supplier_id, site_id, source_id, po_number, lot_number, serial_number, reported_by, owner_id)
         VALUES ($1,$2,$3,'INSPECTION',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
        [
          number,
          title.slice(0, 200),
          body.description || `Raised from inspection ${state.row.number}.`,
          id,
          body.unitIndex,
          section.key,
          row.key,
          row.label,
          expected,
          actual || 'See inspection record',
          state.row.part_id,
          state.row.supplier_id,
          state.row.site_id,
          state.row.source_id,
          state.row.po_number,
          state.row.lot_number,
          unit?.serial_number ?? null,
          auth.userId,
          body.ownerId ?? null,
        ],
      );
      await tx.query(
        `INSERT INTO evidence_link (file_id, entity_type, entity_id, caption, linked_by)
         SELECT l.file_id, 'QUALITY_EVENT', $1, coalesce(l.caption, $2), $3 FROM evidence_link l
          WHERE l.inspection_id = $4 AND l.entity_type = 'INSPECTION' AND l.unlinked_at IS NULL
            AND l.unit_index = $5 AND l.section_key = $6 AND l.row_key = $7`,
        [event!.id, `From ${state.row.number}`, auth.userId, id, body.unitIndex, section.key, row.key],
      );
      await tx.query(
        `INSERT INTO work_item (kind, title, subject_type, subject_id, assignee_id, required_capability)
         VALUES ('CONCERN_TRIAGE', $1, 'QUALITY_EVENT', $2, $3, 'quality.triage')`,
        [`Triage ${number}: ${title}`.slice(0, 200), event!.id, body.ownerId ?? null],
      );
      await audit(tx, {
        actorId: auth.userId,
        action: 'quality.capture',
        entityType: 'quality_event',
        entityId: event!.id,
        summary: `${number} raised from ${state.row.number} — ${row.label}`,
        requestId: req.id,
      });
      await audit(tx, {
        actorId: auth.userId,
        action: 'quality.linked_concern',
        entityType: 'inspection',
        entityId: id,
        summary: `Concern ${number} raised for ${row.label}`,
        requestId: req.id,
      });
      return { id: event!.id, number };
    });
    return reply.code(201).send(created);
  });

  app.post('/api/quality/events/:id/triage', async (req) => {
    const { id } = req.params as { id: string };
    if (!uuid.safeParse(id).success) throw notFound('Quality event');
    const auth = await requireCapability(db, req, 'quality.triage', { action: 'quality.triage', entityType: 'quality_event', entityId: id });
    const body = z
      .object({
        expectedVersion: z.number().int(),
        decision: z.enum(['TRIAGED', 'NONCONFIRMED', 'INFORMATIONAL']),
        ownerId: uuid.nullable().optional(),
        severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).nullable().optional(),
        reason: z.string().trim().max(2000).optional(),
      })
      .parse(req.body);
    return withTransaction(db, async (tx) => {
      const event = await one<{ id: string; number: string; status: string; reported_by: string; version: number; title: string }>(
        tx,
        'SELECT id, number, status, reported_by, version, title FROM quality_event WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!event) throw notFound('Quality event');
      if (event.version !== body.expectedVersion) throw conflict('This concern was changed elsewhere. Reload and try again.');
      if (event.status !== 'CAPTURED') throw conflict('This concern has already been triaged');
      if (event.reported_by === auth.userId) {
        await audit(db, {
          actorId: auth.userId,
          action: 'quality.triage',
          outcome: 'DENIED',
          entityType: 'quality_event',
          entityId: id,
          summary: 'Denied: reporter cannot triage their own concern',
          requestId: req.id,
        });
        throw forbidden('Triage must be performed by someone other than the reporter');
      }
      if (!(await recheckCapability(tx, auth.userId, 'quality.triage'))) throw forbidden();
      if (body.decision === 'TRIAGED' && (!body.ownerId || !body.severity)) throw unprocessable('An owner and severity are required');
      if (body.decision !== 'TRIAGED' && !body.reason) throw unprocessable('A reason is required to close a concern without action');
      await tx.query(
        `UPDATE quality_event SET status = $2, owner_id = coalesce($3, owner_id), severity = coalesce($4, severity), triaged_by = $5,
            triaged_at = now(), triage_reason = $6, version = version + 1 WHERE id = $1`,
        [id, body.decision, body.ownerId ?? null, body.severity ?? null, auth.userId, body.reason ?? null],
      );
      await tx.query(
        `UPDATE work_item SET status = 'DONE', closed_at = now(), closed_by = $2, closed_reason = $3
          WHERE subject_type = 'QUALITY_EVENT' AND subject_id = $1 AND kind = 'CONCERN_TRIAGE' AND status = 'OPEN'`,
        [id, auth.userId, `Triage: ${body.decision}`],
      );
      if (body.decision === 'TRIAGED') {
        await tx.query(
          `INSERT INTO work_item (kind, title, subject_type, subject_id, assignee_id) VALUES ('CONCERN_FOLLOW_UP', $1, 'QUALITY_EVENT', $2, $3)`,
          [`Follow up ${event.number}: ${event.title}`.slice(0, 200), id, body.ownerId],
        );
      }
      await audit(tx, {
        actorId: auth.userId,
        action: 'quality.triage',
        entityType: 'quality_event',
        entityId: id,
        summary: `${event.number} triaged as ${body.decision}`,
        reason: body.reason ?? null,
        after: { ownerId: body.ownerId ?? null, severity: body.severity ?? null },
        requestId: req.id,
      });
      return { status: body.decision };
    });
  });
}
