import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type FormDefinition, type FormSection, type ResponseStatus, allowedStatuses, readingLimitRef, sectionRows } from '../../shared/forms.js';
import { type EntryState, type Evaluation, evaluateInspection, readingId, rowId } from '../../shared/inspection.js';
import { formatLimit, parseReading } from '../../shared/measurement.js';
import { audit } from '../audit.js';
import { type AuthContext, has, recheckCapability, requireCapability } from '../auth.js';
import { type Queryable, many, one, withTransaction } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { sanitizeFilename, validatePhoto } from '../file-validation.js';
import type { RecordReportSnapshot } from '../pdf/record-report.js';
import { formatDate } from '../pdf/text.js';
import { issueRecordEdition, renditions } from '../quality/common.js';
import type { Services } from '../services.js';
import { FileTooLargeError } from '../storage.js';
import { resolveBaseline } from './service.js';
import { type BaselineSnapshot, limitsFromBaseline } from './state.js';

/**
 * Cylinder head Stage 2 (owner decisions, 22 Oct 2026): one record per head, linked to its completed
 * Stage 1 inspection, holding the fire ring section with its own date, part number, review and PDF.
 * Entries are evaluated as a one-item form so the Stage 1 completion and review rules apply unchanged.
 */
const STAGE = 'STAGE_2';
/** Stage entries are kept as item 1 of a one-section form; the head's Stage 1 item number is stored on the record. */
const UNIT = 1;
const MAX_NOTE = 2000;
const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

interface StageRow {
  id: string;
  number: string;
  inspection_id: string;
  unit_index: number;
  section_snapshot: FormSection;
  serial_number: string;
  stage_part_id: string;
  stage_part_number: string;
  baseline_snapshot: BaselineSnapshot | null;
  performed_on: string;
  inspector_id: string;
  inspector_name: string;
  status: 'OPEN' | 'READY_FOR_REVIEW' | 'COMPLETED';
  outcome: string | null;
  review_reasons: unknown;
  submitted_at: Date | null;
  completed_at: Date | null;
  completed_by_name: string | null;
  version: number;
  created_at: Date;
  stage1_number: string;
  stage1_part_number: string;
  stage1_date_received: string;
  stage1_completed_at: Date | null;
  form_number: string;
  form_revision_label: string | null;
  stage_part_description: string;
}

interface LoadedStage {
  row: StageRow;
  definition: FormDefinition;
  entry: EntryState;
  evaluation: Evaluation;
  photos: Array<{ link_id: string; file_id: string; row_key: string | null; caption: string | null; sha256: string; original_name: string | null }>;
}

/** The fire ring section a cylinder head form offers for Stage 2, if any. */
export function stageSection(def: FormDefinition): FormSection | null {
  return def.sections.find((s) => s.pattern === 'groove_specs' && s.scope === 'unit') ?? null;
}

function oneItemForm(row: Pick<StageRow, 'section_snapshot' | 'form_number' | 'form_revision_label'>, component: string): FormDefinition {
  return {
    schemaVersion: 1,
    formNumber: row.form_number,
    component,
    revisionLabel: row.form_revision_label,
    sections: [{ ...row.section_snapshot, optional: false }],
  };
}

async function loadStage(db: Queryable, id: string, lock = false): Promise<LoadedStage> {
  if (!uuid.safeParse(id).success) throw notFound('Stage record');
  if (lock) await db.query('SELECT 1 FROM inspection_stage WHERE id = $1 FOR UPDATE', [id]);
  const row = await one<StageRow>(
    db,
    `SELECT s.*, u.display_name AS inspector_name, cu.display_name AS completed_by_name,
            i.number AS stage1_number, i.part_number AS stage1_part_number, i.date_received::text AS stage1_date_received,
            i.completed_at AS stage1_completed_at, i.form_snapshot->>'formNumber' AS form_number,
            i.form_snapshot->>'revisionLabel' AS form_revision_label, p.description AS stage_part_description
       FROM inspection_stage s
       JOIN inspection i ON i.id = s.inspection_id
       JOIN app_user u ON u.id = s.inspector_id
       JOIN company_part p ON p.id = s.stage_part_id
       LEFT JOIN app_user cu ON cu.id = s.completed_by
      WHERE s.id = $1`,
    [id],
  );
  if (!row) throw notFound('Stage record');
  const responses = await many<{ row_key: string; status: ResponseStatus | null; note: string | null }>(
    db,
    'SELECT row_key, status, note FROM inspection_stage_response WHERE stage_id = $1',
    [id],
  );
  const readings = await many<{ row_key: string; reading_key: string; value_text: string }>(
    db,
    'SELECT row_key, reading_key, value_text FROM inspection_stage_measurement WHERE stage_id = $1',
    [id],
  );
  const photos = await many<LoadedStage['photos'][number]>(
    db,
    `SELECT l.id AS link_id, f.id AS file_id, l.row_key, l.caption, f.sha256, f.original_name
       FROM evidence_link l JOIN file_object f ON f.id = l.file_id
      WHERE l.entity_type = 'INSPECTION_STAGE' AND l.entity_id = $1 AND l.unlinked_at IS NULL AND f.status = 'AVAILABLE'
      ORDER BY l.linked_at, l.id`,
    [id],
  );
  const key = row.section_snapshot.key;
  const photoCounts: Record<string, number> = {};
  for (const p of photos) if (p.row_key) photoCounts[rowId(UNIT, key, p.row_key)] = (photoCounts[rowId(UNIT, key, p.row_key)] ?? 0) + 1;
  const entry: EntryState = {
    responses: Object.fromEntries(responses.map((r) => [rowId(UNIT, key, r.row_key), { status: r.status, note: r.note }])),
    readings: Object.fromEntries(readings.map((m) => [readingId(UNIT, key, m.row_key, m.reading_key), m.value_text])),
    photoCounts,
    activated: [],
  };
  const definition = oneItemForm(row, 'Cylinder Head Stage 2');
  const raw = evaluateInspection({ definition, unitCount: 1, limits: limitsFromBaseline(row.baseline_snapshot) }, entry);
  // Issue paths name the head, not the internal item 1.
  const rename = <T extends { path: string }>(i: T) => ({ ...i, path: i.path.replace(/^Item 1/, `Stage 2 (SN ${row.serial_number})`) });
  const evaluation: Evaluation = { ...raw, errors: raw.errors.map(rename), reviewReasons: raw.reviewReasons.map(rename) };
  return { row, definition, entry, evaluation, photos };
}

function assertOpen(s: LoadedStage, auth: AuthContext) {
  if (s.row.status !== 'OPEN') throw conflict(`${s.row.number} is ${s.row.status === 'COMPLETED' ? 'completed and frozen' : 'awaiting review'} and cannot be edited`);
  if (s.row.inspector_id !== auth.userId) throw forbidden('Only the Stage 2 inspector can edit this record');
}

function assertVersion(s: LoadedStage, expectedVersion: number) {
  if (s.row.version !== expectedVersion) throw conflict('This Stage 2 record was changed elsewhere. Reload to see the latest entries.', { currentVersion: s.row.version });
}

function buildAddendum(s: LoadedStage, edition: number, tz: string, review: { reviewer: string; comment: string | null } | null): RecordReportSnapshot {
  const r = s.row;
  const limits = limitsFromBaseline(r.baseline_snapshot);
  const rows = sectionRows(r.section_snapshot);
  const cylinders = rows[0]?.readingLabels ?? [];
  const colW = cylinders.length ? Math.min(0.08, 0.5 / cylinders.length) : 0;
  const status = (key: string) => s.entry.responses[rowId(UNIT, r.section_snapshot.key, key)];
  const outcome = r.outcome ?? 'PASS';
  return {
    kind: 'RECORD_REPORT',
    schemaVersion: 1,
    title: 'Cylinder Head Stage 2 Addendum',
    docCode: `${r.form_number}${r.form_revision_label ? ` Rev ${r.form_revision_label}` : ''}`,
    number: r.number,
    edition,
    generatedAt: new Date().toISOString(),
    displayTimeZone: tz,
    outcome: {
      label: outcome,
      tone: outcome === 'PASS' ? 'good' : outcome === 'FAIL' ? 'bad' : 'warn',
      note: `Stage 2 result for SN ${r.serial_number}. The Stage 1 inspection ${r.stage1_number} and its report are unchanged.`,
    },
    meta: [
      ['Serial number', r.serial_number],
      ['Stage 1 inspection', `${r.stage1_number} (item ${r.unit_index})`],
      ['Stage 1 part', r.stage1_part_number],
      ['Stage 1 received', formatDate(r.stage1_date_received, tz)],
      ['Stage 1 completed', r.stage1_completed_at ? formatDate(r.stage1_completed_at.toISOString(), tz) : '—'],
      ['Stage 2 part', `${r.stage_part_number} — ${r.stage_part_description}`],
      ['Stage 2 date', formatDate(r.performed_on, tz)],
      ['Stage 2 inspector', r.inspector_name],
      ['Specification', r.baseline_snapshot ? `${r.baseline_snapshot.baselineTitle} Rev ${r.baseline_snapshot.revisionLabel}` : 'Not released for the Stage 2 part — readings are observations'],
      ...(review ? ([['Reviewed by', review.reviewer]] as Array<[string, string]>) : []),
    ],
    sections: [
      {
        title: r.section_snapshot.title,
        kind: 'table',
        columns: [
          { header: 'Measurement', width: 0.2 },
          { header: 'Specification / limit', width: 0.22 },
          ...cylinders.map((c) => ({ header: c, width: colW })),
          { header: 'Result', width: Math.max(0.08, 1 - 0.42 - colW * cylinders.length) },
        ],
        rows: rows.map((row) => {
          const ref = readingLimitRef(row, row.readingKeys[0]!);
          const limit = ref ? limits[ref] : undefined;
          return [
            row.label,
            limit ? formatLimit(limit) : row.source?.specText ? `${row.source.specText} (reference)` : 'Not released',
            ...row.readingKeys.map((k) => s.entry.readings[readingId(UNIT, r.section_snapshot.key, row.key, k)] ?? '—'),
            status(row.key)?.status ?? '—',
          ];
        }),
      },
      {
        title: 'Observations',
        kind: 'text',
        paragraphs: rows
          .map((row) => [row.label, status(row.key)?.note?.trim()] as const)
          .filter(([, note]) => note)
          .map(([label, note]) => `${label}: ${note}`)
          .concat(s.evaluation.reviewReasons.length ? [`Reviewed items: ${s.evaluation.reviewReasons.map((i) => `${i.path}: ${i.message}`).join('; ')}`] : [])
          .concat(review?.comment ? [`Review comment: ${review.comment}`] : [])
          .concat(rows.length && !rows.some((row) => status(row.key)?.note?.trim()) ? ['No observations recorded.'] : []),
      },
      {
        title: 'Photographs (original files, SHA-256)',
        kind: 'table',
        columns: [
          { header: 'Characteristic', width: 0.3 },
          { header: 'File', width: 0.3 },
          { header: 'SHA-256', width: 0.4 },
        ],
        rows: s.photos.length
          ? s.photos.map((p) => [rows.find((x) => x.key === p.row_key)?.label ?? '—', p.original_name ?? p.file_id, p.sha256])
          : [['—', 'No photographs', '—']],
      },
    ],
  };
}

export function registerStageRoutes(app: FastifyInstance, svc: Services) {
  const { db, storage, config } = svc;

  app.post('/api/inspections/:id/stage2', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'inspection.perform', { action: 'inspection.stage_start', entityType: 'inspection', entityId: id });
    if (!uuid.safeParse(id).success) throw notFound('Inspection');
    const body = z
      .object({ unitIndex: z.number().int().min(1).max(100), stagePartId: uuid, performedOn: date, serialNumber: z.string().trim().min(1).max(80).nullable().optional() })
      .parse(req.body);
    if (Date.parse(`${body.performedOn}T00:00:00Z`) > Date.now() + 36 * 3600 * 1000) throw unprocessable('The Stage 2 date cannot be in the future');
    const created = await withTransaction(db, async (tx) => {
      const insp = await one<{ number: string; status: string; unit_count: number; part_id: string | null; form_snapshot: FormDefinition; date_received: string }>(
        tx,
        'SELECT number, status, unit_count, part_id, form_snapshot, date_received::text FROM inspection WHERE id = $1 FOR SHARE',
        [id],
      );
      if (!insp) throw notFound('Inspection');
      if (insp.status !== 'COMPLETED') throw conflict('Stage 2 can only be added to a completed Stage 1 inspection');
      const section = stageSection(insp.form_snapshot);
      if (!section) throw unprocessable(`${insp.form_snapshot.formNumber} has no fire ring section for Stage 2`);
      if (body.unitIndex > insp.unit_count) throw badRequest(`Item ${body.unitIndex} is not part of ${insp.number}`);
      if (body.performedOn < insp.date_received) throw unprocessable('The Stage 2 date cannot be before the Stage 1 receipt date');
      const part = await one<{ part_number: string; active: boolean }>(tx, 'SELECT part_number, active FROM company_part WHERE id = $1', [body.stagePartId]);
      if (!part?.active) throw unprocessable('Choose an active Stage 2 part number');
      if (body.stagePartId === insp.part_id) throw unprocessable('The Stage 2 part number must differ from the Stage 1 part number');
      const unit = await one<{ serial_number: string | null }>(tx, 'SELECT serial_number FROM inspection_unit WHERE inspection_id = $1 AND unit_index = $2', [id, body.unitIndex]);
      const recorded = unit?.serial_number?.trim() || null;
      if (recorded && body.serialNumber && body.serialNumber !== recorded) throw unprocessable(`Item ${body.unitIndex} is recorded as SN ${recorded} in Stage 1`);
      const serial = recorded ?? body.serialNumber ?? null;
      if (!serial) throw unprocessable(`Item ${body.unitIndex} has no serial number in Stage 1; enter the head's serial number`);
      if (await one(tx, 'SELECT 1 FROM inspection_stage WHERE inspection_id = $1 AND unit_index = $2 AND stage = $3', [id, body.unitIndex, STAGE])) {
        throw conflict(`Stage 2 is already recorded for item ${body.unitIndex} of ${insp.number}`);
      }
      const baseline = await resolveBaseline(tx, body.stagePartId, null, false);
      const number = `${insp.number}-S2-${body.unitIndex}`;
      const row = await one<{ id: string }>(
        tx,
        `INSERT INTO inspection_stage (number, inspection_id, unit_index, stage, section_snapshot, serial_number, stage_part_id, stage_part_number,
                                       baseline_revision_id, baseline_snapshot, performed_on, inspector_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING id`,
        [number, id, body.unitIndex, STAGE, JSON.stringify(section), serial, body.stagePartId, part.part_number, baseline?.revisionId ?? null, baseline ? JSON.stringify(baseline) : null, body.performedOn, auth.userId],
      );
      await audit(tx, {
        actorId: auth.userId,
        action: 'inspection.stage_start',
        entityType: 'inspection',
        entityId: id,
        summary: `Stage 2 ${number} started for item ${body.unitIndex} (SN ${serial}) as ${part.part_number}, dated ${body.performedOn}`,
        after: { stageId: row!.id, baselineRevisionId: baseline?.revisionId ?? null },
        requestId: req.id,
      });
      return { id: row!.id, number };
    });
    return reply.code(201).send(created);
  });

  app.get('/api/inspection-stages/:id', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'records.read', { action: 'inspection.stage_read', entityType: 'inspection_stage', entityId: id, consequential: false });
    const s = await loadStage(db, id);
    const r = s.row;
    const reviews = await many(
      db,
      `SELECT r.decision, u.display_name AS reviewer, r.reviewed_at AS "reviewedAt", r.comment FROM inspection_stage_review r
         JOIN app_user u ON u.id = r.reviewer_id WHERE r.stage_id = $1 ORDER BY r.reviewed_at`,
      [id],
    );
    return {
      id: r.id,
      number: r.number,
      status: r.status,
      outcome: r.outcome,
      version: r.version,
      inspectionId: r.inspection_id,
      stage1: { number: r.stage1_number, partNumber: r.stage1_part_number, dateReceived: r.stage1_date_received, completedAt: r.stage1_completed_at, unitIndex: r.unit_index },
      serialNumber: r.serial_number,
      stagePart: { id: r.stage_part_id, partNumber: r.stage_part_number, description: r.stage_part_description },
      performedOn: r.performed_on,
      inspector: { id: r.inspector_id, name: r.inspector_name },
      completedAt: r.completed_at,
      completedBy: r.completed_by_name,
      baseline: r.baseline_snapshot ? { baselineTitle: r.baseline_snapshot.baselineTitle, revisionLabel: r.baseline_snapshot.revisionLabel, synthetic: r.baseline_snapshot.synthetic } : null,
      definition: s.definition,
      limits: limitsFromBaseline(r.baseline_snapshot),
      responses: Object.fromEntries(Object.entries(s.entry.responses).map(([k, v]) => [k, { ...v, amendmentNo: 0 }])),
      readings: Object.fromEntries(Object.entries(s.entry.readings).map(([k, v]) => [k, { text: v, amendmentNo: 0 }])),
      photos: s.photos.map((p) => ({ linkId: p.link_id, fileId: p.file_id, unitIndex: UNIT, sectionKey: r.section_snapshot.key, rowKey: p.row_key, caption: p.caption })),
      evaluation: s.evaluation,
      reviewReasons: r.review_reasons,
      reviews,
      reports: await renditions(db, 'INSPECTION_STAGE', id),
      permissions: {
        canEdit: r.status === 'OPEN' && r.inspector_id === auth.userId && has(auth, 'inspection.perform'),
        canReview: r.status === 'READY_FOR_REVIEW' && has(auth, 'inspection.review') && r.inspector_id !== auth.userId,
      },
    };
  });

  app.patch('/api/inspection-stages/:id/entries', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'inspection.perform', { action: 'inspection.stage_save', entityType: 'inspection_stage', entityId: id });
    const body = z
      .object({
        expectedVersion: z.number().int(),
        changes: z
          .array(
            z.object({
              rowKey: z.string().max(80),
              status: z.enum(['P', 'F', 'A', 'N']).nullable().optional(),
              note: z.string().nullable().optional(),
              readings: z.record(z.string(), z.string().nullable()).optional(),
            }),
          )
          .min(1)
          .max(50),
      })
      .parse(req.body);
    return withTransaction(db, async (tx) => {
      const s = await loadStage(tx, id, true);
      assertOpen(s, auth);
      assertVersion(s, body.expectedVersion);
      const section = s.row.section_snapshot;
      const limits = limitsFromBaseline(s.row.baseline_snapshot);
      for (const c of body.changes) {
        const row = sectionRows(section).find((x) => x.key === c.rowKey);
        if (!row) throw badRequest(`Unknown row ${c.rowKey}`);
        if (c.status && !allowedStatuses(section.pattern).includes(c.status)) throw badRequest(`Status ${c.status} is not allowed here`);
        if (c.note && c.note.length > MAX_NOTE) throw badRequest('Note is too long');
        if (c.status !== undefined || c.note !== undefined) {
          const current = s.entry.responses[rowId(UNIT, section.key, row.key)];
          await tx.query(
            `INSERT INTO inspection_stage_response (stage_id, row_key, status, note, updated_by) VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (stage_id, row_key) DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()`,
            [
              id,
              row.key,
              c.status !== undefined ? c.status : (current?.status ?? null),
              c.note !== undefined ? (c.note?.trim() ? c.note : null) : (current?.note ?? null),
              auth.userId,
            ],
          );
        }
        for (const [key, value] of Object.entries(c.readings ?? {})) {
          if (!row.readingKeys.includes(key)) throw badRequest(`Unknown reading ${key} for ${row.label}`);
          if (value === null || value.trim() === '') {
            await tx.query('DELETE FROM inspection_stage_measurement WHERE stage_id = $1 AND row_key = $2 AND reading_key = $3', [id, row.key, key]);
            continue;
          }
          const parsed = parseReading(value);
          if (!parsed.ok) throw unprocessable(`${row.label}: ${parsed.error}`, { rowKey: row.key, readingKey: key });
          const ref = readingLimitRef(row, key);
          await tx.query(
            `INSERT INTO inspection_stage_measurement (stage_id, row_key, reading_key, value_text, value_numeric, decimals, unit, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (stage_id, row_key, reading_key) DO UPDATE SET value_text = EXCLUDED.value_text, value_numeric = EXCLUDED.value_numeric,
               decimals = EXCLUDED.decimals, unit = EXCLUDED.unit, updated_by = EXCLUDED.updated_by, updated_at = now()`,
            [id, row.key, key, parsed.value.text, parsed.value.canonical, parsed.value.decimals, (ref ? limits[ref]?.unit : null) ?? row.source?.unit ?? null, auth.userId],
          );
        }
      }
      const v = await one<{ version: number }>(tx, 'UPDATE inspection_stage SET version = version + 1, updated_at = now() WHERE id = $1 RETURNING version', [id]);
      return { version: v!.version };
    });
  });

  app.post('/api/inspection-stages/:id/photos', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'inspection.perform', { action: 'evidence.upload', entityType: 'inspection_stage', entityId: id });
    const q = z.object({ rowKey: z.string().max(80), caption: z.string().max(300).optional() }).parse(req.query);
    const s = await loadStage(db, id);
    assertOpen(s, auth);
    if (!sectionRows(s.row.section_snapshot).some((r) => r.key === q.rowKey)) throw badRequest('Unknown characteristic for photograph');
    const health = await storage.check();
    if (!health.ok) throw new AppError(503, 'STORAGE_UNAVAILABLE', 'Evidence storage is unavailable; the photograph was not saved. Try again shortly.');
    const part = await req.file({ limits: { fileSize: config.maxPhotoBytes + 1, files: 1 } });
    if (!part) throw badRequest('No file was uploaded');
    const name = sanitizeFilename(part.filename);
    let staged;
    try {
      staged = await storage.stage(part.file, config.maxPhotoBytes);
    } catch (err) {
      if (err instanceof FileTooLargeError) throw new AppError(413, 'FILE_TOO_LARGE', err.message);
      throw err;
    }
    const check = validatePhoto(staged.head, staged.size);
    if (!check.ok) {
      await storage.discard(staged);
      await audit(db, { actorId: auth.userId, action: 'evidence.upload', outcome: 'FAILED', entityType: 'inspection_stage', entityId: id, summary: `Upload rejected: ${check.reason}`, requestId: req.id });
      throw unprocessable(check.reason);
    }
    const storageKey = await storage.finalize(staged);
    try {
      const result = await withTransaction(db, async (tx) => {
        const fresh = await loadStage(tx, id, true);
        assertOpen(fresh, auth);
        const file = await one<{ id: string }>(
          tx,
          `INSERT INTO file_object (kind, status, sha256, byte_size, mime_type, original_name, storage_key, width, height, uploaded_by)
           VALUES ('PHOTO', 'AVAILABLE', $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [staged.sha256, staged.size, check.mime, name, storageKey, check.width, check.height, auth.userId],
        );
        const link = await one<{ id: string }>(
          tx,
          `INSERT INTO evidence_link (file_id, entity_type, entity_id, unit_index, section_key, row_key, caption, linked_by)
           VALUES ($1, 'INSPECTION_STAGE', $2, $3, $4, $5, $6, $7) RETURNING id`,
          [file!.id, id, UNIT, fresh.row.section_snapshot.key, q.rowKey, q.caption?.trim() || null, auth.userId],
        );
        await audit(tx, { actorId: auth.userId, action: 'evidence.upload', entityType: 'inspection_stage', entityId: id, summary: `Photograph ${name} added to ${fresh.row.number}`, after: { fileId: file!.id, sha256: staged.sha256, rowKey: q.rowKey }, requestId: req.id });
        return { linkId: link!.id, fileId: file!.id };
      });
      return reply.code(201).send(result);
    } catch (err) {
      await storage.removeOrphan(storageKey);
      throw err;
    }
  });

  app.delete('/api/inspection-stages/:id/photos/:linkId', async (req) => {
    const { id, linkId } = req.params as { id: string; linkId: string };
    const auth = await requireCapability(db, req, 'inspection.perform', { action: 'evidence.unlink', entityType: 'inspection_stage', entityId: id });
    if (!uuid.safeParse(linkId).success) throw notFound('Photograph');
    return withTransaction(db, async (tx) => {
      const s = await loadStage(tx, id, true);
      assertOpen(s, auth);
      const res = await tx.query(
        `UPDATE evidence_link SET unlinked_at = now(), unlinked_by = $3, unlink_reason = 'Removed by inspector before submission'
          WHERE id = $1 AND entity_type = 'INSPECTION_STAGE' AND entity_id = $2 AND unlinked_at IS NULL`,
        [linkId, id, auth.userId],
      );
      if (!res.rowCount) throw notFound('Photograph');
      await audit(tx, { actorId: auth.userId, action: 'evidence.unlink', entityType: 'inspection_stage', entityId: id, summary: `Photograph link ${linkId} removed`, requestId: req.id });
      return { ok: true };
    });
  });

  app.post('/api/inspection-stages/:id/complete', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'inspection.perform', { action: 'inspection.stage_complete', entityType: 'inspection_stage', entityId: id });
    const body = z.object({ expectedVersion: z.number().int() }).parse(req.body);
    return withTransaction(db, async (tx) => {
      const s = await loadStage(tx, id, true);
      assertOpen(s, auth);
      assertVersion(s, body.expectedVersion);
      if (!(await recheckCapability(tx, auth.userId, 'inspection.perform'))) throw forbidden();
      const ev = s.evaluation;
      if (ev.errors.length) throw unprocessable(`${ev.errors.length} item(s) must be resolved before completion`, { errors: ev.errors });
      const needsReview = ev.reviewReasons.length > 0;
      const status = needsReview ? 'READY_FOR_REVIEW' : 'COMPLETED';
      const updated = await one<{ version: number }>(
        tx,
        `UPDATE inspection_stage SET status = $2, outcome = $3, review_reasons = $4, submitted_at = now(),
            completed_by = CASE WHEN $2 = 'COMPLETED' THEN $5::uuid END, completed_at = CASE WHEN $2 = 'COMPLETED' THEN now() END,
            version = version + 1, updated_at = now()
          WHERE id = $1 RETURNING version`,
        [id, status, ev.overall, JSON.stringify(ev.reviewReasons), auth.userId],
      );
      if (needsReview) {
        await tx.query(
          `INSERT INTO work_item (kind, title, subject_type, subject_id, required_capability) VALUES ('INSPECTION_REVIEW', $1, 'INSPECTION_STAGE', $2, 'inspection.review')`,
          [`Review ${s.row.number} — Stage 2 ${s.row.stage_part_number} SN ${s.row.serial_number} (${ev.overall ?? 'pending'})`.slice(0, 200), id],
        );
      } else {
        const done = { ...s, row: { ...s.row, status: 'COMPLETED' as const, outcome: ev.overall } };
        await issueRecordEdition(tx, 'INSPECTION_STAGE', id, (edition) => buildAddendum(done, edition, config.displayTimeZone, null));
      }
      await audit(tx, {
        actorId: auth.userId,
        action: needsReview ? 'inspection.stage_submit_for_review' : 'inspection.stage_complete',
        entityType: 'inspection_stage',
        entityId: id,
        summary: needsReview ? `${s.row.number} submitted for independent review (${ev.reviewReasons.length} item(s)); reported outcome ${ev.overall}` : `${s.row.number} completed; outcome ${ev.overall}`,
        after: { outcome: ev.overall, reviewReasons: ev.reviewReasons.map((x) => `${x.path}: ${x.message}`) },
        requestId: req.id,
      });
      return { status, outcome: ev.overall, version: updated!.version };
    });
  });

  app.post('/api/inspection-stages/:id/review', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'inspection.review', { action: 'inspection.stage_review', entityType: 'inspection_stage', entityId: id });
    const body = z.object({ decision: z.enum(['CONFIRM', 'RETURN']), comment: z.string().trim().max(2000).nullable().optional(), expectedVersion: z.number().int() }).parse(req.body);
    return withTransaction(db, async (tx) => {
      const s = await loadStage(tx, id, true);
      if (s.row.status !== 'READY_FOR_REVIEW') throw conflict('This Stage 2 record is not awaiting review');
      assertVersion(s, body.expectedVersion);
      const deny = async (message: string) => {
        await audit(db, { actorId: auth.userId, action: 'inspection.stage_review', outcome: 'DENIED', entityType: 'inspection_stage', entityId: id, summary: message, requestId: req.id });
        return forbidden(message);
      };
      if (s.row.inspector_id === auth.userId) throw await deny('Independent review required: the Stage 2 inspector cannot review their own record');
      if (!(await recheckCapability(tx, auth.userId, 'inspection.review'))) throw forbidden();
      const grants = ['inspection.review'];
      const hasAccepted = s.evaluation.reviewReasons.some((r) => r.message.startsWith('Accepted'));
      if (body.decision === 'CONFIRM' && hasAccepted) {
        if (!(await recheckCapability(tx, auth.userId, 'inspection.review_accepted'))) throw await deny('Confirming an Accepted result requires the "inspection.review_accepted" authority');
        grants.push('inspection.review_accepted');
      }
      const comment = body.comment?.trim() || null;
      if (body.decision === 'RETURN' && !comment) throw unprocessable('A reason is required to return a Stage 2 record for correction');
      await tx.query(
        `INSERT INTO inspection_stage_review (stage_id, decision, reviewer_id, reasons, comment, grants_used) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, body.decision === 'CONFIRM' ? 'CONFIRMED' : 'RETURNED', auth.userId, JSON.stringify(s.evaluation.reviewReasons), comment, grants],
      );
      await tx.query(
        `UPDATE work_item SET status = 'DONE', closed_at = now(), closed_by = $2, closed_reason = $3
          WHERE subject_type = 'INSPECTION_STAGE' AND subject_id = $1 AND kind = 'INSPECTION_REVIEW' AND status = 'OPEN'`,
        [id, auth.userId, body.decision === 'CONFIRM' ? 'Review confirmed' : 'Returned for correction'],
      );
      if (body.decision === 'CONFIRM') {
        await tx.query(`UPDATE inspection_stage SET status = 'COMPLETED', completed_by = $2, completed_at = now(), version = version + 1, updated_at = now() WHERE id = $1`, [id, auth.userId]);
        const done = { ...s, row: { ...s.row, status: 'COMPLETED' as const } };
        await issueRecordEdition(tx, 'INSPECTION_STAGE', id, (edition) => buildAddendum(done, edition, config.displayTimeZone, { reviewer: auth.displayName, comment }));
      } else {
        await tx.query(
          `UPDATE inspection_stage SET status = 'OPEN', outcome = NULL, review_reasons = NULL, submitted_at = NULL, version = version + 1, updated_at = now() WHERE id = $1`,
          [id],
        );
        await tx.query(`INSERT INTO work_item (kind, title, subject_type, subject_id, assignee_id) VALUES ('INSPECTION_ASSIGNED', $1, 'INSPECTION_STAGE', $2, $3)`, [
          `Correct ${s.row.number}: ${comment}`.slice(0, 200),
          id,
          s.row.inspector_id,
        ]);
      }
      await audit(tx, {
        actorId: auth.userId,
        action: body.decision === 'CONFIRM' ? 'inspection.stage_review_confirm' : 'inspection.stage_review_return',
        entityType: 'inspection_stage',
        entityId: id,
        summary: `${s.row.number} ${body.decision === 'CONFIRM' ? 'review confirmed' : 'returned for correction'}`,
        reason: comment,
        after: { grantsUsed: grants },
        requestId: req.id,
      });
      return { status: body.decision === 'CONFIRM' ? 'COMPLETED' : 'OPEN' };
    });
  });
}

/** Stage records of one inspection, for its detail view. */
export async function stagesOf(db: Queryable, inspectionId: string) {
  return many<{ id: string; number: string; unitIndex: number; serialNumber: string; stagePartNumber: string; performedOn: string; status: string; outcome: string | null }>(
    db,
    `SELECT id, number, unit_index AS "unitIndex", serial_number AS "serialNumber", stage_part_number AS "stagePartNumber",
            performed_on::text AS "performedOn", status, outcome
       FROM inspection_stage WHERE inspection_id = $1 ORDER BY unit_index`,
    [inspectionId],
  );
}

