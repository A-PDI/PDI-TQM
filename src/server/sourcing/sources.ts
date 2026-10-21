import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { canonicalJson } from '../../shared/forms.js';
import { evaluateReading, parseReading } from '../../shared/measurement.js';
import { CHECKLIST_RULE_VERSION, RISK_RULE_VERSION } from '../../shared/sourcing.js';
import { audit } from '../audit.js';
import { auditedDenial, has, recheckCapability, requireCapability } from '../auth.js';
import { many, one, withTransaction } from '../db.js';
import { conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { enqueueJob } from '../jobs.js';
import { qualityContext } from '../quality/context.js';
import { nextRecordNumber } from '../numbering.js';
import type { Services } from '../services.js';
import { buildApprovalReportSnapshot } from './approval-report.js';
import { evaluateGates } from './gates.js';
import { effectiveSourceStatuses } from './status.js';

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
// Date-only inputs are stored at midday UTC so they read as the same calendar day in US time zones.
const atMidday = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T12:00:00Z` : v);

export function registerSourceRoutes(app: FastifyInstance, svc: Services) {
  const { db, config } = svc;

  app.get('/api/sources', async (req) => {
    await requireCapability(db, req, 'records.read', { action: 'sources.list', consequential: false });
    const q = z.object({ partId: uuid.optional(), supplierId: uuid.optional() }).parse(req.query);
    const rows = await many<{ id: string }>(
      db,
      `SELECT s.id, p.id AS "partId", p.part_number AS "partNumber", p.description, sup.id AS "supplierId", sup.legal_name AS supplier, ss.name AS site,
              sp.supplier_part_number AS "supplierPartNumber", s.pathway, s.configuration, br.revision_label AS "revisionLabel", tb.title AS "baselineTitle"
         FROM source s JOIN company_part p ON p.id = s.part_id JOIN supplier sup ON sup.id = s.supplier_id JOIN supplier_site ss ON ss.id = s.site_id
         JOIN supplier_part sp ON sp.id = s.supplier_part_id LEFT JOIN baseline_revision br ON br.id = s.baseline_revision_id
         LEFT JOIN technical_baseline tb ON tb.id = br.baseline_id
        WHERE ($1::uuid IS NULL OR s.part_id = $1) AND ($2::uuid IS NULL OR s.supplier_id = $2)
        ORDER BY p.part_number, sup.legal_name, ss.name LIMIT 500`,
      [q.partId ?? null, q.supplierId ?? null],
    );
    const statuses = await effectiveSourceStatuses(db, rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, effective: statuses.get(r.id) }));
  });

  app.get('/api/sources/:id', async (req) => {
    const auth = await requireCapability(db, req, 'records.read', { action: 'sources.read', consequential: false });
    const { id } = req.params as { id: string };
    if (!uuid.safeParse(id).success) throw notFound('Source');
    const evaluation = await evaluateGates(db, id, config.displayTimeZone);
    if (!evaluation) throw notFound('Source');
    const ctx = evaluation.context;
    const [acknowledgments, fais, results, decisions, inspections, candidates] = await Promise.all([
      many(
        db,
        `SELECT a.id, a.sent_via AS "sentVia", a.sent_to AS "sentTo", a.sent_at AS "sentAt", a.response, a.representative, a.responded_at AS "respondedAt",
                a.response_note AS "responseNote", r.revision_label AS "revisionLabel", a.baseline_revision_id AS "baselineRevisionId", u.display_name AS "sentBy",
                coalesce((SELECT json_agg(json_build_object('linkId', l.id, 'fileId', f.id, 'name', f.original_name)) FROM evidence_link l JOIN file_object f ON f.id = l.file_id
                           WHERE l.entity_type = 'ACKNOWLEDGMENT' AND l.entity_id = a.id AND l.unlinked_at IS NULL), '[]') AS files
           FROM supplier_acknowledgment a JOIN baseline_revision r ON r.id = a.baseline_revision_id JOIN app_user u ON u.id = a.sent_by
          WHERE a.source_id = $1 ORDER BY a.sent_at DESC`,
        [id],
      ),
      many(
        db,
        `SELECT f.id, f.number, f.sequence, f.sample_type AS "sampleType", f.status, f.decision, f.conditions, f.defects, f.rationale, f.corrective_rationale AS "correctiveRationale",
                f.lot_number AS "lotNumber", f.serial_numbers AS "serialNumbers", f.received_date AS "receivedDate", f.description, f.version,
                r.revision_label AS "revisionLabel", f.baseline_revision_id AS "baselineRevisionId", f.previous_fai_id AS "previousFaiId",
                rb.id AS "recordedById", rb.display_name AS "recordedBy", db.display_name AS "decidedBy", f.decided_at AS "decidedAt",
                coalesce((SELECT json_agg(json_build_object('linkId', l.id, 'fileId', fo.id, 'name', fo.original_name)) FROM evidence_link l JOIN file_object fo ON fo.id = l.file_id
                           WHERE l.entity_type = 'FAI' AND l.entity_id = f.id AND l.unlinked_at IS NULL), '[]') AS files
           FROM fai_sample f JOIN baseline_revision r ON r.id = f.baseline_revision_id JOIN app_user rb ON rb.id = f.recorded_by LEFT JOIN app_user db ON db.id = f.decided_by
          WHERE f.source_id = $1 ORDER BY f.sequence`,
        [id],
      ),
      many(
        db,
        `SELECT r.fai_id AS "faiId", r.char_key AS "charKey", r.char_name AS "charName", r.unit, r.lower_limit AS lower, r.upper_limit AS upper,
                r.value_text AS value, r.visual_result AS "visualResult", r.evaluation, r.note
           FROM fai_result r JOIN fai_sample f ON f.id = r.fai_id WHERE f.source_id = $1 ORDER BY r.char_key`,
        [id],
      ),
      many(
        db,
        `SELECT d.id, d.number, d.decision, d.scope, d.conditions, d.valid_until AS "validUntil", d.rationale, d.decided_at AS "decidedAt", u.display_name AS approver,
                d.manifest_sha256 AS "manifestSha256",
                (SELECT json_build_object('fileId', rr.file_id, 'sha256', rr.sha256, 'pageCount', rr.page_count) FROM report_rendition rr
                  WHERE rr.subject_type = 'SOURCE_APPROVAL' AND rr.subject_id = d.id ORDER BY rr.edition DESC LIMIT 1) AS report
           FROM source_approval_decision d JOIN app_user u ON u.id = d.approver_id WHERE d.source_id = $1 ORDER BY d.decided_at DESC`,
        [id],
      ),
      many(
        db,
        `SELECT id, number, status, outcome, date_received AS "dateReceived", lot_number AS "lotNumber", source_state_at_start AS "sourceStateAtStart"
           FROM inspection WHERE source_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [id],
      ),
      // Released revisions of the same baseline a not-yet-approved source could be re-pointed to.
      ctx.revision
        ? many(
            db,
            `SELECT r.id, r.revision_label AS "revisionLabel" FROM baseline_revision r
              WHERE r.baseline_id = (SELECT baseline_id FROM baseline_revision WHERE id = $1) AND r.status = 'RELEASED' AND r.id <> $1`,
            [ctx.revision.id],
          )
        : [],
    ]);
    const status = (await effectiveSourceStatuses(db, [id])).get(id)!;
    const everApproved = decisions.some((d) => (d as { decision: string }).decision !== 'REJECTED');
    const openFai = (fais as Array<{ status: string }>).some((f) => f.status === 'OPEN');
    return {
      source: ctx.source,
      revision: ctx.revision,
      baseRevision: ctx.baseRevision,
      characteristics: ctx.characteristics,
      request: ctx.request,
      risk: ctx.risk,
      siteQualification: ctx.siteQualification,
      status,
      quality: await qualityContext(db, { sourceId: id }, config.displayTimeZone),
      sourceRestrictions: await many(
        db,
        `SELECT r.id, r.reason, r.decided_at AS "decidedAt", u.display_name AS "decidedBy" FROM supplier_restriction r JOIN app_user u ON u.id = r.decided_by
          WHERE r.source_id = $1 AND r.lifted_at IS NULL`,
        [id],
      ),
      gates: evaluation.gates,
      approvable: evaluation.approvable,
      conditionalOnly: evaluation.conditionalOnly,
      acknowledgments,
      fais: (fais as Array<{ id: string }>).map((f) => ({ ...f, results: results.filter((r) => (r as { faiId: string }).faiId === f.id) })),
      decisions,
      inspections,
      repointCandidates: everApproved ? [] : candidates,
      permissions: {
        canManage: has(auth, 'sourcing.manage'),
        canDecideFai: has(auth, 'validation.decide'),
        canApprove: has(auth, 'source.approve') && ctx.request?.owner_id !== auth.userId,
        approveBlockedReason: has(auth, 'source.approve') && ctx.request?.owner_id === auth.userId ? 'The sourcing request owner cannot approve their own source.' : null,
        canRegisterFai: has(auth, 'sourcing.manage') && !openFai && ctx.revision?.status === 'RELEASED',
        canRestrict: has(auth, 'supplier.restrict'),
      },
    };
  });

  app.patch('/api/sources/:id/governing-revision', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'sourcing.manage', { action: 'source.repoint', entityType: 'source', entityId: id });
    const body = z.object({ baselineRevisionId: uuid }).parse(req.body);
    if (!uuid.safeParse(id).success) throw notFound('Source');
    return withTransaction(db, async (tx) => {
      const s = await one<{ baseline_revision_id: string | null }>(tx, 'SELECT baseline_revision_id FROM source WHERE id = $1 FOR UPDATE', [id]);
      if (!s) throw notFound('Source');
      const same = await one(
        tx,
        `SELECT 1 FROM baseline_revision a JOIN baseline_revision b ON a.baseline_id = b.baseline_id WHERE a.id = $1 AND b.id = $2 AND b.status = 'RELEASED'`,
        [s.baseline_revision_id, body.baselineRevisionId],
      );
      if (!same) throw unprocessable('Choose a released revision of the same technical baseline');
      await tx.query('UPDATE source SET baseline_revision_id = $2 WHERE id = $1', [id, body.baselineRevisionId]);
      await audit(tx, { actorId: auth.userId, action: 'source.repoint', entityType: 'source', entityId: id, summary: 'Governing revision updated before approval', after: body, requestId: req.id });
      return { ok: true };
    });
  });

  // ------------------------------------------------------------------ supplier acknowledgment
  app.post('/api/sources/:id/acknowledgments', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'sourcing.manage', { action: 'acknowledgment.send', entityType: 'source', entityId: id });
    const body = z
      .object({ sentVia: z.enum(['EMAIL', 'PORTAL', 'MEETING', 'MAIL', 'OTHER']), sentTo: z.string().trim().min(2).max(300), sentAt: z.string().datetime({ offset: true }).or(date) })
      .parse(req.body);
    if (!uuid.safeParse(id).success) throw notFound('Source');
    const created = await withTransaction(db, async (tx) => {
      const s = await one<{ baseline_revision_id: string | null; status: string | null; label: string | null }>(
        tx,
        `SELECT s.baseline_revision_id, r.status, r.revision_label AS label FROM source s LEFT JOIN baseline_revision r ON r.id = s.baseline_revision_id WHERE s.id = $1 FOR UPDATE OF s`,
        [id],
      );
      if (!s) throw notFound('Source');
      if (!s.baseline_revision_id || s.status !== 'RELEASED') throw unprocessable('Only a released revision can be sent for supplier acknowledgment');
      if (await one(tx, `SELECT 1 FROM supplier_acknowledgment WHERE source_id = $1 AND response = 'PENDING'`, [id])) {
        throw conflict('An acknowledgment request is already awaiting the supplier response');
      }
      const a = await one<{ id: string }>(
        tx,
        `INSERT INTO supplier_acknowledgment (source_id, baseline_revision_id, sent_via, sent_to, sent_at, sent_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [id, s.baseline_revision_id, body.sentVia, body.sentTo, atMidday(body.sentAt), auth.userId],
      );
      await tx.query(
        `INSERT INTO work_item (kind, title, subject_type, subject_id, assignee_id) VALUES ('SUPPLIER_RESPONSE', $1, 'SOURCE', $2, $3)`,
        [`Record supplier response to Rev ${s.label}`, id, auth.userId],
      );
      await audit(tx, { actorId: auth.userId, action: 'acknowledgment.send', entityType: 'source', entityId: id, summary: `Rev ${s.label} sent to ${body.sentTo} via ${body.sentVia.toLowerCase()}`, requestId: req.id });
      return { id: a!.id };
    });
    return reply.code(201).send(created);
  });

  app.post('/api/acknowledgments/:id/response', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'sourcing.manage', { action: 'acknowledgment.response', entityType: 'supplier_acknowledgment', entityId: id });
    const body = z
      .object({
        response: z.enum(['ACKNOWLEDGED', 'OBJECTED']),
        representative: z.string().trim().min(2).max(200),
        respondedAt: z.string().datetime({ offset: true }).or(date),
        note: z.string().trim().max(4000).nullable().optional(),
      })
      .parse(req.body);
    if (body.response === 'OBJECTED' && !body.note) throw unprocessable('Record what the supplier objected to');
    if (!uuid.safeParse(id).success) throw notFound('Acknowledgment');
    return withTransaction(db, async (tx) => {
      const a = await one<{ source_id: string; response: string; label: string }>(
        tx,
        `SELECT a.source_id, a.response, r.revision_label AS label FROM supplier_acknowledgment a JOIN baseline_revision r ON r.id = a.baseline_revision_id WHERE a.id = $1 FOR UPDATE OF a`,
        [id],
      );
      if (!a) throw notFound('Acknowledgment');
      if (a.response !== 'PENDING') throw conflict('The supplier response was already recorded');
      await tx.query(
        `UPDATE supplier_acknowledgment SET response = $2, representative = $3, responded_at = $4, response_note = $5, recorded_by = $6, recorded_at = now() WHERE id = $1`,
        [id, body.response, body.representative, atMidday(body.respondedAt), body.note ?? null, auth.userId],
      );
      await tx.query(
        `UPDATE work_item SET status = 'DONE', closed_at = now(), closed_by = $2, closed_reason = 'Response recorded' WHERE subject_type = 'SOURCE' AND subject_id = $1 AND kind = 'SUPPLIER_RESPONSE' AND status = 'OPEN'`,
        [a.source_id, auth.userId],
      );
      await audit(tx, {
        actorId: auth.userId,
        action: 'acknowledgment.response',
        entityType: 'source',
        entityId: a.source_id,
        summary: `Supplier ${body.response === 'ACKNOWLEDGED' ? 'acknowledged' : 'objected to'} Rev ${a.label} (${body.representative}). An acknowledgment does not verify execution.`,
        reason: body.note ?? null,
        requestId: req.id,
      });
      return { response: body.response };
    });
  });

  // ------------------------------------------------------------------ first article / validation
  app.post('/api/sources/:id/fai', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'sourcing.manage', { action: 'fai.register', entityType: 'source', entityId: id });
    const body = z
      .object({
        sampleType: z.enum(['INITIAL_FAI', 'RESUBMITTED_FAI', 'PROTOTYPE', 'PRODUCTION_REPRESENTATIVE']),
        receivedDate: date,
        lotNumber: z.string().trim().max(80).nullable().optional(),
        serialNumbers: z.string().trim().max(500).nullable().optional(),
        description: z.string().trim().max(2000).nullable().optional(),
        correctiveRationale: z.string().trim().max(4000).nullable().optional(),
      })
      .parse(req.body);
    if (!uuid.safeParse(id).success) throw notFound('Source');
    const created = await withTransaction(db, async (tx) => {
      const s = await one<{ baseline_revision_id: string | null; status: string | null }>(
        tx,
        `SELECT s.baseline_revision_id, r.status FROM source s LEFT JOIN baseline_revision r ON r.id = s.baseline_revision_id WHERE s.id = $1 FOR UPDATE OF s`,
        [id],
      );
      if (!s) throw notFound('Source');
      if (!s.baseline_revision_id || s.status !== 'RELEASED') throw unprocessable('A first article is evaluated only against a released technical revision');
      if (await one(tx, `SELECT 1 FROM fai_sample WHERE source_id = $1 AND status = 'OPEN'`, [id])) throw conflict('Decide the open sample before registering another');
      const prior = await many<{ id: string; number: string; decision: string | null; baseline_revision_id: string }>(
        tx,
        `SELECT id, number, decision, baseline_revision_id FROM fai_sample WHERE source_id = $1 AND status = 'DECIDED' ORDER BY sequence`,
        [id],
      );
      const last = prior[prior.length - 1];
      // FR-034: after a rejection the next sample must be a documented resubmission; the rejection stays on record.
      let previousFaiId: string | null = null;
      if (last?.decision === 'REJECTED') {
        if (body.sampleType !== 'RESUBMITTED_FAI') throw unprocessable(`${last.number} was rejected: register a resubmitted FAI`);
        if (!body.correctiveRationale || body.correctiveRationale.length < 20) {
          throw unprocessable('A resubmission must document root cause, process correction and why the sample is representative');
        }
        previousFaiId = last.id;
      } else if (body.sampleType === 'RESUBMITTED_FAI') {
        throw unprocessable('A resubmission follows a rejected first article');
      }
      const seq = await one<{ n: number }>(tx, 'SELECT coalesce(max(sequence), 0) + 1 AS n FROM fai_sample WHERE source_id = $1', [id]);
      const number = await nextRecordNumber(tx, 'FAI');
      const f = await one<{ id: string }>(
        tx,
        `INSERT INTO fai_sample (number, source_id, sequence, sample_type, baseline_revision_id, previous_fai_id, corrective_rationale, lot_number, serial_numbers, received_date, description, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [number, id, seq!.n, body.sampleType, s.baseline_revision_id, previousFaiId, body.correctiveRationale ?? null, body.lotNumber ?? null, body.serialNumbers ?? null, body.receivedDate, body.description ?? null, auth.userId],
      );
      await audit(tx, { actorId: auth.userId, action: 'fai.register', entityType: 'source', entityId: id, summary: `${number} (${body.sampleType.replaceAll('_', ' ').toLowerCase()}) registered`, requestId: req.id });
      return { id: f!.id, number };
    });
    return reply.code(201).send(created);
  });

  app.put('/api/fai/:id/results', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'sourcing.manage', { action: 'fai.results', entityType: 'fai_sample', entityId: id });
    const body = z
      .object({
        results: z
          .array(
            z.object({
              charKey: z.string().max(48),
              value: z.string().trim().max(24).nullable().optional(),
              visualResult: z.enum(['CONFORMS', 'DOES_NOT_CONFORM']).nullable().optional(),
              note: z.string().trim().max(1000).nullable().optional(),
            }),
          )
          .max(300),
      })
      .parse(req.body);
    if (!uuid.safeParse(id).success) throw notFound('First article');
    return withTransaction(db, async (tx) => {
      const f = await one<{ status: string; baseline_revision_id: string; source_id: string; number: string }>(
        tx,
        'SELECT status, baseline_revision_id, source_id, number FROM fai_sample WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!f) throw notFound('First article');
      if (f.status !== 'OPEN') throw conflict('Results of a decided first article are frozen');
      const chars = await many<{ char_key: string; name: string; unit: string | null; lower_limit: string | null; upper_limit: string | null }>(
        tx,
        'SELECT char_key, name, unit, lower_limit, upper_limit FROM baseline_characteristic WHERE revision_id = $1',
        [f.baseline_revision_id],
      );
      for (const r of body.results) {
        const c = chars.find((x) => x.char_key === r.charKey);
        if (!c) throw unprocessable(`${r.charKey} is not a characteristic of the governing revision`);
        let evaluation: string;
        let canonical: string | null = null;
        if (r.value) {
          const p = parseReading(r.value);
          if (!p.ok) throw unprocessable(`${c.name}: ${p.error}`);
          canonical = p.value.canonical;
          const limit = c.unit && (c.lower_limit !== null || c.upper_limit !== null)
            ? { charKey: c.char_key, name: c.name, unit: c.unit, lower: c.lower_limit, upper: c.upper_limit, baselineRevision: '', synthetic: false }
            : null;
          evaluation = evaluateReading(canonical, limit);
        } else if (r.visualResult) {
          evaluation = r.visualResult;
        } else {
          await tx.query('DELETE FROM fai_result WHERE fai_id = $1 AND char_key = $2', [id, r.charKey]);
          continue;
        }
        await tx.query(
          `INSERT INTO fai_result (fai_id, char_key, char_name, unit, lower_limit, upper_limit, value_text, value_numeric, visual_result, evaluation, note, recorded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (fai_id, char_key) DO UPDATE SET value_text = EXCLUDED.value_text, value_numeric = EXCLUDED.value_numeric, visual_result = EXCLUDED.visual_result,
             evaluation = EXCLUDED.evaluation, note = EXCLUDED.note, recorded_by = EXCLUDED.recorded_by, recorded_at = now()`,
          [id, c.char_key, c.name, c.unit, c.lower_limit, c.upper_limit, r.value ?? null, canonical, r.value ? null : (r.visualResult ?? null), evaluation, r.note ?? null, auth.userId],
        );
      }
      await tx.query('UPDATE fai_sample SET version = version + 1 WHERE id = $1', [id]);
      await audit(tx, { actorId: auth.userId, action: 'fai.results', entityType: 'source', entityId: f.source_id, summary: `${f.number} results recorded (${body.results.length})`, requestId: req.id });
      const work = await one(tx, `SELECT 1 FROM work_item WHERE subject_type = 'SOURCE' AND subject_id = $1 AND kind = 'FAI_DECISION' AND status = 'OPEN'`, [f.source_id]);
      if (!work) {
        await tx.query(
          `INSERT INTO work_item (kind, title, subject_type, subject_id, required_capability) VALUES ('FAI_DECISION', $1, 'SOURCE', $2, 'validation.decide')`,
          [`Decide ${f.number}`, f.source_id],
        );
      }
      return { ok: true };
    });
  });

  app.post('/api/fai/:id/decide', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'validation.decide', { action: 'fai.decide', entityType: 'fai_sample', entityId: id });
    const body = z
      .object({
        expectedVersion: z.number().int(),
        decision: z.enum(['ACCEPTED', 'CONDITIONAL', 'REJECTED']),
        conditions: z.string().trim().max(2000).nullable().optional(),
        defects: z.string().trim().max(4000).nullable().optional(),
        rationale: z.string().trim().min(5).max(4000),
      })
      .parse(req.body);
    if (!uuid.safeParse(id).success) throw notFound('First article');
    if (body.decision === 'CONDITIONAL' && !body.conditions) throw unprocessable('State the conditions of a conditional acceptance');
    if (body.decision === 'REJECTED' && !body.defects) throw unprocessable('Describe the defects that caused the rejection');
    return withTransaction(db, async (tx) => {
      const f = await one<{ status: string; version: number; recorded_by: string; source_id: string; number: string; baseline_revision_id: string }>(
        tx,
        'SELECT status, version, recorded_by, source_id, number, baseline_revision_id FROM fai_sample WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!f) throw notFound('First article');
      if (f.status !== 'OPEN') throw conflict('This sample has already been decided');
      if (f.version !== body.expectedVersion) throw conflict('Results changed; reload and review them again');
      const recorders = await many<{ recorded_by: string }>(tx, 'SELECT DISTINCT recorded_by FROM fai_result WHERE fai_id = $1', [id]);
      if (f.recorded_by === auth.userId || recorders.some((r) => r.recorded_by === auth.userId)) {
        throw await auditedDenial(db, req, auth.userId, 'fai.decide', 'fai_sample', id, 'the person who registered or measured the sample cannot decide it');
      }
      if (!(await recheckCapability(tx, auth.userId, 'validation.decide'))) throw forbidden();
      const chars = await many<{ char_key: string; name: string }>(tx, 'SELECT char_key, name FROM baseline_characteristic WHERE revision_id = $1', [f.baseline_revision_id]);
      const results = await many<{ char_key: string; evaluation: string }>(tx, 'SELECT char_key, evaluation FROM fai_result WHERE fai_id = $1', [id]);
      const missing = chars.filter((c) => !results.some((r) => r.char_key === c.char_key));
      if (body.decision !== 'REJECTED' && missing.length) throw unprocessable(`Results missing for: ${missing.map((m) => m.name).join(', ')}`);
      const nonconforming = results.filter((r) => r.evaluation === 'OUTSIDE' || r.evaluation === 'DOES_NOT_CONFORM');
      if (body.decision === 'ACCEPTED' && nonconforming.length) {
        throw unprocessable(`${nonconforming.length} result(s) do not conform; the sample cannot be accepted without conditions`);
      }
      await tx.query(
        `UPDATE fai_sample SET status = 'DECIDED', decision = $2, conditions = $3, defects = $4, rationale = $5, decided_by = $6, decided_at = now(),
            grants_used = ARRAY['validation.decide'], version = version + 1 WHERE id = $1`,
        [id, body.decision, body.conditions ?? null, body.defects ?? null, body.rationale, auth.userId],
      );
      await tx.query(
        `UPDATE work_item SET status = 'DONE', closed_at = now(), closed_by = $2, closed_reason = $3 WHERE subject_type = 'SOURCE' AND subject_id = $1 AND kind = 'FAI_DECISION' AND status = 'OPEN'`,
        [f.source_id, auth.userId, `${f.number} ${body.decision}`],
      );
      await audit(tx, {
        actorId: auth.userId,
        action: 'fai.decide',
        entityType: 'source',
        entityId: f.source_id,
        summary: `${f.number} ${body.decision.toLowerCase()}${body.defects ? `: ${body.defects}` : ''}`,
        reason: body.rationale,
        requestId: req.id,
      });
      return { decision: body.decision };
    });
  });

  // ------------------------------------------------------------------ approval
  app.post('/api/sources/:id/request-approval', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'sourcing.manage', { action: 'source.request_approval', entityType: 'source', entityId: id });
    if (!uuid.safeParse(id).success) throw notFound('Source');
    return withTransaction(db, async (tx) => {
      const s = await one<{ approval_state: string; part_number: string }>(
        tx,
        `SELECT s.approval_state, p.part_number FROM source s JOIN company_part p ON p.id = s.part_id WHERE s.id = $1 FOR UPDATE OF s`,
        [id],
      );
      if (!s) throw notFound('Source');
      if (s.approval_state !== 'NOT_APPROVED') throw conflict('Approval has already been requested or granted for this source');
      await tx.query(`UPDATE source SET approval_state = 'IN_REVIEW' WHERE id = $1`, [id]);
      await tx.query(
        `INSERT INTO work_item (kind, title, subject_type, subject_id, required_capability) VALUES ('SOURCE_APPROVAL', $1, 'SOURCE', $2, 'source.approve')`,
        [`Approve source for ${s.part_number}`, id],
      );
      await audit(tx, { actorId: auth.userId, action: 'source.request_approval', entityType: 'source', entityId: id, summary: 'Approval requested', requestId: req.id });
      return { status: 'IN_REVIEW' };
    });
  });

  app.post('/api/sources/:id/decision', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'source.approve', { action: 'source.decide', entityType: 'source', entityId: id });
    const body = z
      .object({
        decision: z.enum(['APPROVED', 'APPROVED_CONDITIONAL', 'REJECTED']),
        scope: z.string().trim().min(3).max(1000),
        conditions: z.string().trim().max(2000).nullable().optional(),
        validUntil: date.nullable().optional(),
        rationale: z.string().trim().min(5).max(4000),
      })
      .parse(req.body);
    if (!uuid.safeParse(id).success) throw notFound('Source');
    if (body.decision === 'APPROVED_CONDITIONAL' && !body.conditions) throw unprocessable('State the conditions of a conditional approval');
    if (body.validUntil && body.validUntil <= new Date().toISOString().slice(0, 10)) throw unprocessable('Validity must end in the future');
    const result = await withTransaction(db, async (tx) => {
      await tx.query('SELECT 1 FROM source WHERE id = $1 FOR UPDATE', [id]);
      // Gates are re-evaluated inside the deciding transaction, not trusted from the screen (FR-036).
      const ev = await evaluateGates(tx, id, config.displayTimeZone);
      if (!ev) throw notFound('Source');
      if (ev.context.request && ev.context.request.owner_id === auth.userId) {
        throw await auditedDenial(db, req, auth.userId, 'source.decide', 'source', id, 'the sourcing request owner cannot approve their own source');
      }
      if (!(await recheckCapability(tx, auth.userId, 'source.approve'))) throw forbidden();
      if (body.decision !== 'REJECTED') {
        const failing = ev.gates.filter((g) => g.status === 'FAIL');
        if (failing.length) {
          await audit(db, {
            actorId: auth.userId,
            action: 'source.decide',
            outcome: 'FAILED',
            entityType: 'source',
            entityId: id,
            summary: `Approval refused: ${failing.length} gate(s) failing`,
            after: failing,
            requestId: req.id,
          });
          throw unprocessable(`${failing.length} approval gate(s) are not met`, { gates: ev.gates });
        }
        if (ev.conditionalOnly && body.decision === 'APPROVED') {
          throw unprocessable('A conditional prerequisite exists (see gates); only a conditional approval with stated conditions is possible', { gates: ev.gates });
        }
      }
      const ctx = ev.context;
      const decidedAt = new Date().toISOString();
      const manifest = {
        schemaVersion: 1,
        decidedAt,
        source: ctx.source,
        governingRevision: ctx.revision && {
          ...ctx.revision,
          characteristics: ctx.characteristics,
          contentSha256: createHash('sha256').update(canonicalJson(ctx.characteristics)).digest('hex'),
        },
        baseRevision: ctx.baseRevision,
        siteQualification: ctx.siteQualification,
        acknowledgment: ctx.acknowledgment,
        firstArticles: ctx.fais,
        risk: ctx.risk,
        sourcingRequest: ctx.request,
        evidence: ctx.requirements,
        openConcerns: ctx.blockingConcerns,
        policies: { risk: RISK_RULE_VERSION, checklist: CHECKLIST_RULE_VERSION, independence: 'POL-01 interim: approver ≠ sourcing request owner' },
      };
      const manifestSha = createHash('sha256').update(canonicalJson(manifest)).digest('hex');
      const number = await nextRecordNumber(tx, 'PSA');
      const d = await one<{ id: string }>(
        tx,
        `INSERT INTO source_approval_decision (number, source_id, decision, scope, conditions, valid_until, rationale, approver_id, decided_at, grants_used, gate_results, manifest, manifest_sha256)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,ARRAY['source.approve'],$10,$11,$12) RETURNING id`,
        [number, id, body.decision, body.scope, body.conditions ?? null, body.validUntil ?? null, body.rationale, auth.userId, decidedAt, JSON.stringify(ev.gates), JSON.stringify(manifest), manifestSha],
      );
      await tx.query(`UPDATE source SET approval_state = $2 WHERE id = $1`, [id, body.decision === 'REJECTED' ? 'NOT_APPROVED' : body.decision]);
      if (ctx.request && body.decision !== 'REJECTED') {
        await tx.query(`UPDATE sourcing_request SET status = 'APPROVED', version = version + 1 WHERE id = $1`, [ctx.request.id]);
        await tx.query(
          `UPDATE work_item SET status = 'DONE', closed_at = now(), closed_by = $2, closed_reason = 'Source approved' WHERE subject_type = 'SOURCING_REQUEST' AND subject_id = $1 AND status = 'OPEN'`,
          [ctx.request.id, auth.userId],
        );
      }
      await tx.query(
        `UPDATE work_item SET status = 'DONE', closed_at = now(), closed_by = $2, closed_reason = $3 WHERE subject_type = 'SOURCE' AND subject_id = $1 AND kind = 'SOURCE_APPROVAL' AND status = 'OPEN'`,
        [id, auth.userId, body.decision],
      );
      const approver = await one<{ display_name: string }>(tx, 'SELECT display_name FROM app_user WHERE id = $1', [auth.userId]);
      const snapshot = buildApprovalReportSnapshot({
        number,
        decision: body.decision,
        scope: body.scope,
        conditions: body.conditions ?? null,
        validUntil: body.validUntil ?? null,
        rationale: body.rationale,
        approver: approver!.display_name,
        decidedAt,
        gates: ev.gates,
        manifest,
        manifestSha256: manifestSha,
        displayTimeZone: config.displayTimeZone,
      });
      const snap = await one<{ id: string }>(
        tx,
        `INSERT INTO report_snapshot (subject_type, subject_id, edition, snapshot, sha256) VALUES ('SOURCE_APPROVAL', $1, 1, $2, $3) RETURNING id`,
        [d!.id, JSON.stringify(snapshot), createHash('sha256').update(canonicalJson(snapshot)).digest('hex')],
      );
      await enqueueJob(tx, 'record_report', `record_report:${snap!.id}`, { snapshotId: snap!.id });
      await audit(tx, {
        actorId: auth.userId,
        action: 'source.decide',
        entityType: 'source',
        entityId: id,
        summary: `${number}: ${body.decision.replaceAll('_', ' ').toLowerCase()} for ${ctx.source.part_number} at ${ctx.source.supplier_name} / ${ctx.source.site_name}`,
        reason: body.rationale,
        after: { manifestSha256: manifestSha, decisionId: d!.id },
        requestId: req.id,
      });
      return { id: d!.id, number, decision: body.decision, manifestSha256: manifestSha };
    });
    return reply.code(201).send(result);
  });
}
