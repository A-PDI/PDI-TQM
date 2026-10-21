import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type FormDefinition, sectionRows } from '../../shared/forms.js';
import { parseReading } from '../../shared/measurement.js';
import { audit } from '../audit.js';
import { auditedDenial, has, recheckCapability, requireCapability } from '../auth.js';
import { type DbClient, many, one, withTransaction } from '../db.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.js';
import type { Services } from '../services.js';

const uuid = z.string().uuid();

const characteristic = z.object({
  charKey: z.string().regex(/^[a-z0-9_]{1,48}$/),
  name: z.string().trim().min(1).max(200),
  charType: z.enum(['DIMENSIONAL', 'VISUAL', 'FUNCTIONAL', 'MATERIAL']),
  formRowRef: z.string().regex(/^[a-z_]+:[a-z0-9_]+$/).nullable().optional(),
  unit: z.string().trim().max(20).nullable().optional(),
  lower: z.string().trim().max(24).nullable().optional(),
  upper: z.string().trim().max(24).nullable().optional(),
  limitText: z.string().trim().max(500).nullable().optional(),
  method: z.string().trim().max(500).nullable().optional(),
  special: z.boolean().optional(),
  isDelta: z.boolean().optional(),
});
type CharacteristicInput = z.infer<typeof characteristic>;

function validateCharacteristics(chars: CharacteristicInput[]) {
  const keys = new Set<string>();
  const refs = new Set<string>();
  return chars.map((c) => {
    if (keys.has(c.charKey)) throw badRequest(`Duplicate characteristic key ${c.charKey}`);
    keys.add(c.charKey);
    if (c.formRowRef) {
      if (refs.has(c.formRowRef)) throw unprocessable(`Two characteristics map to the same inspection row ${c.formRowRef}`);
      refs.add(c.formRowRef);
    }
    const parse = (v: string | null | undefined, label: string) => {
      if (v === null || v === undefined || v === '') return null;
      const p = parseReading(v);
      if (!p.ok) throw unprocessable(`${c.name}: ${label} ${p.error}`);
      return p.value.canonical;
    };
    const lower = parse(c.lower, 'lower limit');
    const upper = parse(c.upper, 'upper limit');
    if ((lower !== null || upper !== null) && !c.unit) throw unprocessable(`${c.name}: a numeric limit needs a unit`);
    if (lower !== null && upper !== null && Number(lower) > Number(upper)) throw unprocessable(`${c.name}: lower limit exceeds upper limit`);
    return { ...c, lower, upper };
  });
}

async function copyCharacteristics(tx: DbClient, fromRevision: string, toRevision: string, asDelta: boolean | null) {
  await tx.query(
    `INSERT INTO baseline_characteristic (revision_id, char_key, name, char_type, form_row_ref, unit, lower_limit, upper_limit, nominal, limit_text, method, location, special, is_delta)
     SELECT $2, char_key, name, char_type, form_row_ref, unit, lower_limit, upper_limit, nominal, limit_text, method, location, special,
            CASE WHEN $3::boolean IS NULL THEN is_delta ELSE $3::boolean END
       FROM baseline_characteristic WHERE revision_id = $1`,
    [fromRevision, toRevision, asDelta],
  );
}

export function registerBaselineRoutes(app: FastifyInstance, svc: Services) {
  const { db } = svc;

  app.post('/api/parts/:id/baselines', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'engineering.author', { action: 'baseline.create', entityType: 'company_part', entityId: id });
    const body = z
      .object({
        title: z.string().trim().min(3).max(200),
        ownership: z.enum(['PDI', 'SUPPLIER', 'SUPPLIER_PLUS_DELTA']),
        revisionLabel: z.string().trim().min(1).max(10).regex(/^[A-Za-z0-9.-]+$/),
        baseRevisionId: uuid.nullable().optional(),
        documentRef: z.string().trim().max(300).nullable().optional(),
        notes: z.string().trim().max(2000).nullable().optional(),
      })
      .parse(req.body);
    if (!uuid.safeParse(id).success) throw notFound('Part');
    const created = await withTransaction(db, async (tx) => {
      if (!(await one(tx, 'SELECT 1 FROM company_part WHERE id = $1', [id]))) throw notFound('Part');
      let base: { id: string; part_id: string; ownership: string; status: string } | null = null;
      if (body.ownership === 'SUPPLIER_PLUS_DELTA') {
        if (!body.baseRevisionId) throw unprocessable('A delta specification must reference the exact supplier base revision');
        base = await one(
          tx,
          `SELECT r.id, b.part_id, b.ownership, r.status FROM baseline_revision r JOIN technical_baseline b ON b.id = r.baseline_id WHERE r.id = $1`,
          [body.baseRevisionId],
        );
        if (!base || base.part_id !== id || base.ownership !== 'SUPPLIER') throw unprocessable('The base revision must be a supplier baseline of this part');
        if (base.status !== 'RELEASED') throw unprocessable('The supplier base revision must be released before a delta is built on it');
      } else if (body.baseRevisionId) {
        throw unprocessable('Only a delta specification references a base revision');
      }
      const b = await one<{ id: string }>(tx, `INSERT INTO technical_baseline (part_id, title, ownership, created_by) VALUES ($1,$2,$3,$4) RETURNING id`, [
        id,
        body.title,
        body.ownership,
        auth.userId,
      ]);
      const r = await one<{ id: string }>(
        tx,
        `INSERT INTO baseline_revision (baseline_id, revision_label, base_revision_id, document_ref, notes, authored_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [b!.id, body.revisionLabel.toUpperCase(), base?.id ?? null, body.documentRef ?? null, body.notes ?? null, auth.userId],
      );
      // A delta starts from the supplier's characteristics (not delta); PDI changes are flagged as delta.
      if (base) await copyCharacteristics(tx, base.id, r!.id, false);
      await audit(tx, {
        actorId: auth.userId,
        action: 'baseline.create',
        entityType: 'baseline_revision',
        entityId: r!.id,
        summary: `Draft ${body.title} Rev ${body.revisionLabel.toUpperCase()} created (${body.ownership.toLowerCase()})`,
        requestId: req.id,
      });
      return { baselineId: b!.id, revisionId: r!.id };
    });
    return reply.code(201).send(created);
  });

  app.post('/api/baselines/:id/revisions', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'engineering.author', { action: 'baseline.revise', entityType: 'technical_baseline', entityId: id });
    const body = z
      .object({ revisionLabel: z.string().trim().min(1).max(10).regex(/^[A-Za-z0-9.-]+$/), baseRevisionId: uuid.nullable().optional() })
      .parse(req.body);
    if (!uuid.safeParse(id).success) throw notFound('Baseline');
    const created = await withTransaction(db, async (tx) => {
      const baseline = await one<{ id: string; ownership: string; part_id: string }>(tx, 'SELECT id, ownership, part_id FROM technical_baseline WHERE id = $1', [id]);
      if (!baseline) throw notFound('Baseline');
      if (await one(tx, `SELECT 1 FROM baseline_revision WHERE baseline_id = $1 AND status IN ('DRAFT', 'IN_REVIEW')`, [id])) {
        throw conflict('A draft or in-review revision already exists for this baseline');
      }
      const current = await one<{ id: string; base_revision_id: string | null }>(
        tx,
        `SELECT id, base_revision_id FROM baseline_revision WHERE baseline_id = $1 AND status = 'RELEASED'`,
        [id],
      );
      const baseRevisionId = baseline.ownership === 'SUPPLIER_PLUS_DELTA' ? (body.baseRevisionId ?? current?.base_revision_id ?? null) : null;
      if (baseline.ownership === 'SUPPLIER_PLUS_DELTA' && body.baseRevisionId) {
        const base = await one<{ part_id: string; ownership: string; status: string }>(
          tx,
          `SELECT b.part_id, b.ownership, r.status FROM baseline_revision r JOIN technical_baseline b ON b.id = r.baseline_id WHERE r.id = $1`,
          [body.baseRevisionId],
        );
        if (!base || base.part_id !== baseline.part_id || base.ownership !== 'SUPPLIER' || base.status !== 'RELEASED') {
          throw unprocessable('The new base must be a released supplier baseline revision of this part');
        }
      }
      const r = await one<{ id: string }>(
        tx,
        `INSERT INTO baseline_revision (baseline_id, revision_label, base_revision_id, authored_by) VALUES ($1,$2,$3,$4) RETURNING id`,
        [id, body.revisionLabel.toUpperCase(), baseRevisionId, auth.userId],
      );
      if (current) await copyCharacteristics(tx, current.id, r!.id, null);
      await audit(tx, {
        actorId: auth.userId,
        action: 'baseline.revise',
        entityType: 'baseline_revision',
        entityId: r!.id,
        summary: `Draft Rev ${body.revisionLabel.toUpperCase()} started${current ? ' from the released revision' : ''}`,
        requestId: req.id,
      });
      return { revisionId: r!.id };
    });
    return reply.code(201).send(created);
  });

  app.get('/api/baseline-revisions/:id', async (req) => {
    const auth = await requireCapability(db, req, 'records.read', { action: 'baseline.read', consequential: false });
    const { id } = req.params as { id: string };
    if (!uuid.safeParse(id).success) throw notFound('Baseline revision');
    const revision = await one<Record<string, unknown> & { baseline_id: string; part_id: string; base_revision_id: string | null; status: string; authored_by: string; submitted_by: string | null; default_form_number: string | null }>(
      db,
      `SELECT r.*, b.title, b.ownership, b.part_id, p.part_number, p.description AS part_description, p.default_form_number,
              a.display_name AS authored_by_name, s.display_name AS submitted_by_name, rl.display_name AS released_by_name
         FROM baseline_revision r JOIN technical_baseline b ON b.id = r.baseline_id JOIN company_part p ON p.id = b.part_id
         LEFT JOIN app_user a ON a.id = r.authored_by LEFT JOIN app_user s ON s.id = r.submitted_by LEFT JOIN app_user rl ON rl.id = r.released_by
        WHERE r.id = $1`,
      [id],
    );
    if (!revision) throw notFound('Baseline revision');
    const [characteristics, siblings, base, sources, history, files] = await Promise.all([
      many(
        db,
        `SELECT char_key AS "charKey", name, char_type AS "charType", form_row_ref AS "formRowRef", unit, lower_limit AS lower, upper_limit AS upper,
                limit_text AS "limitText", method, special, is_delta AS "isDelta"
           FROM baseline_characteristic WHERE revision_id = $1 ORDER BY char_key`,
        [id],
      ),
      many(db, `SELECT id, revision_label AS "revisionLabel", status FROM baseline_revision WHERE baseline_id = $1 ORDER BY created_at`, [revision.baseline_id]),
      revision.base_revision_id
        ? one(
            db,
            `SELECT r.id, r.revision_label AS "revisionLabel", r.status, b.title,
                    (SELECT n.id FROM baseline_revision n WHERE n.baseline_id = r.baseline_id AND n.status = 'RELEASED' AND n.id <> r.id LIMIT 1) AS "newerReleasedId",
                    (SELECT n.revision_label FROM baseline_revision n WHERE n.baseline_id = r.baseline_id AND n.status = 'RELEASED' AND n.id <> r.id LIMIT 1) AS "newerReleasedLabel"
               FROM baseline_revision r JOIN technical_baseline b ON b.id = r.baseline_id WHERE r.id = $1`,
            [revision.base_revision_id],
          )
        : null,
      many(
        db,
        `SELECT s.id, sup.legal_name AS supplier, ss.name AS site, s.approval_state AS "approvalState" FROM source s
           JOIN supplier sup ON sup.id = s.supplier_id JOIN supplier_site ss ON ss.id = s.site_id WHERE s.baseline_revision_id = $1`,
        [id],
      ),
      many(
        db,
        `SELECT a.occurred_at AS "occurredAt", a.action, a.outcome, a.summary, a.reason, u.display_name AS actor
           FROM audit_event a LEFT JOIN app_user u ON u.id = a.actor_id WHERE a.entity_type = 'baseline_revision' AND a.entity_id = $1 ORDER BY a.id`,
        [id],
      ),
      many(
        db,
        `SELECT l.id AS "linkId", f.id AS "fileId", f.original_name AS name, f.sha256 FROM evidence_link l JOIN file_object f ON f.id = l.file_id
          WHERE l.entity_type = 'BASELINE_REVISION' AND l.entity_id = $1 AND l.unlinked_at IS NULL ORDER BY l.linked_at`,
        [id],
      ),
    ]);
    // Inspection rows the characteristics can govern (measurement rows of the part's current form).
    let formRows: Array<{ ref: string; label: string }> = [];
    if (revision.default_form_number) {
      const form = await one<{ definition: FormDefinition }>(
        db,
        `SELECT r.definition FROM form_revision r JOIN inspection_form f ON f.id = r.form_id WHERE f.form_number = $1 AND r.status = 'RELEASED'`,
        [revision.default_form_number],
      );
      if (form) {
        for (const s of form.definition.sections) {
          for (const r of sectionRows(s)) {
            if (!r.limitRef || r.parentKey) continue;
            if (r.limitRef === 'valve_recession') {
              if (!formRows.some((f) => f.ref.startsWith('valve_recession'))) {
                formRows.push({ ref: 'valve_recession:intake', label: `${s.title} — intake` }, { ref: 'valve_recession:exhaust', label: `${s.title} — exhaust` });
              }
            } else formRows.push({ ref: r.limitRef, label: `${s.letter ? `${s.letter}. ` : ''}${s.title.split('—').pop()!.trim()} — ${r.label}` });
          }
        }
        formRows = formRows.filter((f, i) => formRows.findIndex((x) => x.ref === f.ref) === i);
      }
    }
    return {
      revision,
      characteristics,
      siblings,
      base,
      sources,
      history,
      files,
      formRows,
      permissions: {
        canEdit: revision.status === 'DRAFT' && has(auth, 'engineering.author'),
        canSubmit: revision.status === 'DRAFT' && has(auth, 'engineering.author'),
        canRelease:
          revision.status === 'IN_REVIEW' && has(auth, 'engineering.release') && revision.authored_by !== auth.userId && revision.submitted_by !== auth.userId,
        releaseBlockedReason:
          revision.status === 'IN_REVIEW' && has(auth, 'engineering.release') && (revision.authored_by === auth.userId || revision.submitted_by === auth.userId)
            ? 'Release must be performed by someone other than the author or submitter.'
            : null,
        canRevise: revision.status === 'RELEASED' && has(auth, 'engineering.author'),
      },
    };
  });

  app.put('/api/baseline-revisions/:id/characteristics', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'engineering.author', { action: 'baseline.edit', entityType: 'baseline_revision', entityId: id });
    const body = z
      .object({
        characteristics: z.array(characteristic).max(300),
        documentRef: z.string().trim().max(300).nullable().optional(),
        notes: z.string().trim().max(2000).nullable().optional(),
      })
      .parse(req.body);
    if (!uuid.safeParse(id).success) throw notFound('Baseline revision');
    const chars = validateCharacteristics(body.characteristics);
    return withTransaction(db, async (tx) => {
      const r = await one<{ status: string; base_revision_id: string | null }>(tx, 'SELECT status, base_revision_id FROM baseline_revision WHERE id = $1 FOR UPDATE', [id]);
      if (!r) throw notFound('Baseline revision');
      if (r.status !== 'DRAFT') throw conflict(`A ${r.status.toLowerCase().replace('_', ' ')} revision cannot be edited; start a new revision`);
      await tx.query('DELETE FROM baseline_characteristic WHERE revision_id = $1', [id]);
      for (const c of chars) {
        await tx.query(
          `INSERT INTO baseline_characteristic (revision_id, char_key, name, char_type, form_row_ref, unit, lower_limit, upper_limit, limit_text, method, special, is_delta)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [id, c.charKey, c.name, c.charType, c.formRowRef ?? null, c.unit || null, c.lower, c.upper, c.limitText || null, c.method || null, c.special ?? false, r.base_revision_id ? (c.isDelta ?? false) : false],
        );
      }
      if (body.documentRef !== undefined || body.notes !== undefined) {
        await tx.query(
          `UPDATE baseline_revision SET document_ref = CASE WHEN $2 THEN $3 ELSE document_ref END, notes = CASE WHEN $4 THEN $5 ELSE notes END WHERE id = $1`,
          [id, body.documentRef !== undefined, body.documentRef ?? null, body.notes !== undefined, body.notes ?? null],
        );
      }
      await audit(tx, { actorId: auth.userId, action: 'baseline.edit', entityType: 'baseline_revision', entityId: id, summary: `Draft characteristics saved (${chars.length})`, requestId: req.id });
      return { count: chars.length };
    });
  });

  app.post('/api/baseline-revisions/:id/submit', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'engineering.author', { action: 'baseline.submit', entityType: 'baseline_revision', entityId: id });
    if (!uuid.safeParse(id).success) throw notFound('Baseline revision');
    return withTransaction(db, async (tx) => {
      const r = await one<{ status: string; revision_label: string; title: string; document_ref: string | null; base_revision_id: string | null }>(
        tx,
        `SELECT r.status, r.revision_label, b.title, r.document_ref, r.base_revision_id FROM baseline_revision r JOIN technical_baseline b ON b.id = r.baseline_id WHERE r.id = $1 FOR UPDATE OF r`,
        [id],
      );
      if (!r) throw notFound('Baseline revision');
      if (r.status !== 'DRAFT') throw conflict('Only a draft can be submitted for release review');
      const chars = await many<{ is_delta: boolean }>(tx, 'SELECT is_delta FROM baseline_characteristic WHERE revision_id = $1', [id]);
      if (!chars.length && !r.document_ref) throw unprocessable('Add characteristics or reference the controlling document before submitting');
      if (r.base_revision_id && !chars.some((c) => c.is_delta)) throw unprocessable('A delta specification must flag at least one PDI delta characteristic');
      await tx.query(`UPDATE baseline_revision SET status = 'IN_REVIEW', submitted_by = $2, submitted_at = now() WHERE id = $1`, [id, auth.userId]);
      await tx.query(
        `INSERT INTO work_item (kind, title, subject_type, subject_id, required_capability) VALUES ('BASELINE_RELEASE', $1, 'BASELINE_REVISION', $2, 'engineering.release')`,
        [`Release review: ${r.title} Rev ${r.revision_label}`.slice(0, 200), id],
      );
      await audit(tx, { actorId: auth.userId, action: 'baseline.submit', entityType: 'baseline_revision', entityId: id, summary: `Rev ${r.revision_label} submitted for release review`, requestId: req.id });
      return { status: 'IN_REVIEW' };
    });
  });

  app.post('/api/baseline-revisions/:id/return', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'engineering.release', { action: 'baseline.return', entityType: 'baseline_revision', entityId: id });
    const body = z.object({ reason: z.string().trim().min(5).max(2000) }).parse(req.body);
    if (!uuid.safeParse(id).success) throw notFound('Baseline revision');
    return withTransaction(db, async (tx) => {
      const r = await one<{ status: string }>(tx, 'SELECT status FROM baseline_revision WHERE id = $1 FOR UPDATE', [id]);
      if (!r) throw notFound('Baseline revision');
      if (r.status !== 'IN_REVIEW') throw conflict('Only an in-review revision can be returned');
      await tx.query(`UPDATE baseline_revision SET status = 'DRAFT', submitted_by = NULL, submitted_at = NULL WHERE id = $1`, [id]);
      await tx.query(
        `UPDATE work_item SET status = 'DONE', closed_at = now(), closed_by = $2, closed_reason = 'Returned to draft' WHERE subject_type = 'BASELINE_REVISION' AND subject_id = $1 AND status = 'OPEN'`,
        [id, auth.userId],
      );
      await audit(tx, { actorId: auth.userId, action: 'baseline.return', entityType: 'baseline_revision', entityId: id, summary: 'Returned to draft', reason: body.reason, requestId: req.id });
      return { status: 'DRAFT' };
    });
  });

  app.post('/api/baseline-revisions/:id/release', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'engineering.release', { action: 'baseline.release', entityType: 'baseline_revision', entityId: id });
    const body = z.object({ rationale: z.string().trim().min(5).max(4000), effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional() }).parse(req.body);
    if (!uuid.safeParse(id).success) throw notFound('Baseline revision');
    return withTransaction(db, async (tx) => {
      const r = await one<{ status: string; baseline_id: string; revision_label: string; authored_by: string; submitted_by: string | null; base_revision_id: string | null }>(
        tx,
        'SELECT status, baseline_id, revision_label, authored_by, submitted_by, base_revision_id FROM baseline_revision WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!r) throw notFound('Baseline revision');
      if (r.status !== 'IN_REVIEW') throw conflict('Only a revision in release review can be released');
      if (r.authored_by === auth.userId || r.submitted_by === auth.userId) {
        throw await auditedDenial(db, req, auth.userId, 'baseline.release', 'baseline_revision', id, 'the author or submitter cannot release their own revision');
      }
      if (!(await recheckCapability(tx, auth.userId, 'engineering.release'))) throw forbidden();
      if (r.base_revision_id) {
        const base = await one<{ status: string }>(tx, 'SELECT status FROM baseline_revision WHERE id = $1', [r.base_revision_id]);
        if (!base || !['RELEASED', 'SUPERSEDED'].includes(base.status)) throw unprocessable('The supplier base revision is not released');
      }
      const previous = await one<{ id: string; revision_label: string }>(
        tx,
        `SELECT id, revision_label FROM baseline_revision WHERE baseline_id = $1 AND status = 'RELEASED' FOR UPDATE`,
        [r.baseline_id],
      );
      if (previous) await tx.query(`UPDATE baseline_revision SET status = 'SUPERSEDED' WHERE id = $1`, [previous.id]);
      await tx.query(
        `UPDATE baseline_revision SET status = 'RELEASED', released_by = $2, released_at = now(), effective_from = coalesce($3::date, current_date), release_rationale = $4 WHERE id = $1`,
        [id, auth.userId, body.effectiveFrom ?? null, body.rationale],
      );
      await tx.query(
        `UPDATE work_item SET status = 'DONE', closed_at = now(), closed_by = $2, closed_reason = 'Released' WHERE subject_type = 'BASELINE_REVISION' AND subject_id = $1 AND status = 'OPEN'`,
        [id, auth.userId],
      );
      await audit(tx, {
        actorId: auth.userId,
        action: 'baseline.release',
        entityType: 'baseline_revision',
        entityId: id,
        summary: `Rev ${r.revision_label} released${previous ? `; Rev ${previous.revision_label} superseded (existing sources and records keep their exact revision)` : ''}`,
        reason: body.rationale,
        requestId: req.id,
      });
      return { status: 'RELEASED', superseded: previous?.revision_label ?? null };
    });
  });
}
