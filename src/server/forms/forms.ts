import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type FormDefinition, type FormSection, canonicalJson, formDefinitionSchema } from '../../shared/forms.js';
import { audit } from '../audit.js';
import { auditedDenial, has, recheckCapability, requireCapability } from '../auth.js';
import { type Queryable, many, one, withTransaction } from '../db.js';
import { conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { createInspection } from '../inspections/service.js';
import { closeWork, history, openWork, uuid } from '../quality/common.js';
import type { Services } from '../services.js';

interface RevisionRow {
  id: string;
  form_id: string;
  form_number: string;
  component: string;
  sequence: number;
  revision_label: string | null;
  status: string;
  definition: FormDefinition;
  based_on_revision_id: string | null;
  created_by: string | null;
  submitted_by: string | null;
  version?: number;
}

/** Hash of the definition exactly as stored (JSON drops undefined fields). */
const sha = (def: FormDefinition) => createHash('sha256').update(canonicalJson(JSON.parse(JSON.stringify(def)))).digest('hex');

async function loadRevision(db: Queryable, id: string, lock = false): Promise<RevisionRow> {
  if (!uuid.safeParse(id).success) throw notFound('Form revision');
  const r = await one<RevisionRow>(
    db,
    `SELECT r.*, f.form_number, f.component FROM form_revision r JOIN inspection_form f ON f.id = r.form_id WHERE r.id = $1${lock ? ' FOR UPDATE OF r' : ''}`,
    [id],
  );
  if (!r) throw notFound('Form revision');
  return r;
}

export interface FormDiffRow {
  section: string;
  row: string | null;
  change: 'ADDED' | 'REMOVED' | 'CHANGED';
  detail: string;
}

/** Readable difference between two form definitions (sections, rows and their texts). */
export function diffForms(before: FormDefinition | null, after: FormDefinition): FormDiffRow[] {
  const out: FormDiffRow[] = [];
  const prior = new Map((before?.sections ?? []).map((s) => [s.key, s]));
  for (const s of after.sections) {
    const old = prior.get(s.key);
    if (!old) {
      out.push({ section: s.title, row: null, change: 'ADDED', detail: `New ${s.pattern.replaceAll('_', ' ')} section (${s.rows.length} rows)` });
      continue;
    }
    prior.delete(s.key);
    const sectionChanges = (['title', 'pattern', 'scope', 'optional'] as const).filter((k) => old[k] !== s[k]);
    if (sectionChanges.length || canonicalJson(old.params ?? {}) !== canonicalJson(s.params ?? {}))
      out.push({ section: s.title, row: null, change: 'CHANGED', detail: `Changed: ${[...sectionChanges, ...(canonicalJson(old.params ?? {}) !== canonicalJson(s.params ?? {}) ? ['params'] : [])].join(', ')}` });
    const rows = new Map(old.rows.map((r) => [r.key, r]));
    for (const r of s.rows) {
      const o = rows.get(r.key);
      if (!o) out.push({ section: s.title, row: r.name, change: 'ADDED', detail: r.acceptance ?? r.specText ?? '' });
      else {
        rows.delete(r.key);
        const fields = (['name', 'acceptance', 'location', 'specText', 'unit', 'limitNote'] as const).filter((k) => (o[k] ?? '') !== (r[k] ?? ''));
        if (fields.length) out.push({ section: s.title, row: r.name, change: 'CHANGED', detail: fields.map((f) => `${f}: "${o[f] ?? ''}" → "${r[f] ?? ''}"`).join('; ') });
      }
    }
    for (const r of rows.values()) out.push({ section: s.title, row: r.name, change: 'REMOVED', detail: '' });
  }
  for (const s of prior.values()) out.push({ section: s.title, row: null, change: 'REMOVED', detail: `${s.rows.length} rows` });
  return out;
}

const slug = (name: string, taken: Set<string>) => {
  const baseKey = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'row';
  let key = baseKey;
  for (let i = 2; taken.has(key); i += 1) key = `${baseKey}_${i}`;
  taken.add(key);
  return key;
};

export function registerFormRoutes(app: FastifyInstance, svc: Services) {
  const { db } = svc;

  app.get('/api/form-revisions/:id', async (req) => {
    const auth = await requireCapability(db, req, 'records.read', { action: 'forms.read', consequential: false });
    const { id } = req.params as { id: string };
    const r = await loadRevision(db, id);
    const basedOn = r.based_on_revision_id ? await loadRevision(db, r.based_on_revision_id) : null;
    const meta = await one(
      db,
      `SELECT r.provenance, r.change_summary AS "changeSummary", r.release_rationale AS "releaseRationale", r.created_at AS "createdAt", r.released_at AS "releasedAt",
              r.submitted_at AS "submittedAt", c.display_name AS "createdBy", s.display_name AS "submittedBy", rl.display_name AS "releasedBy",
              (SELECT count(*)::int FROM inspection i WHERE i.form_revision_id = r.id) AS "inspectionCount"
         FROM form_revision r LEFT JOIN app_user c ON c.id = r.created_by LEFT JOIN app_user s ON s.id = r.submitted_by LEFT JOIN app_user rl ON rl.id = r.released_by
        WHERE r.id = $1`,
      [id],
    );
    const siblings = await many(
      db,
      `SELECT id, sequence, revision_label AS "revisionLabel", status, released_at AS "releasedAt" FROM form_revision WHERE form_id = $1 AND status <> 'ONE_OFF' ORDER BY sequence`,
      [r.form_id],
    );
    const author = r.created_by === auth.userId || r.submitted_by === auth.userId;
    return {
      revision: { id: r.id, formNumber: r.form_number, component: r.component, sequence: r.sequence, revisionLabel: r.revision_label, status: r.status, definition: r.definition, ...meta },
      basedOn: basedOn ? { id: basedOn.id, revisionLabel: basedOn.revision_label, status: basedOn.status } : null,
      diff: diffForms(basedOn?.definition ?? null, r.definition),
      siblings,
      history: await history(db, 'form_revision', [id]),
      permissions: {
        edit: has(auth, 'forms.publish') && r.status === 'DRAFT',
        release: has(auth, 'forms.publish') && r.status === 'IN_REVIEW' && !author,
        releaseBlockedReason: has(auth, 'forms.publish') && r.status === 'IN_REVIEW' && author ? 'You authored or submitted this revision; someone else must release it.' : null,
        newDraft: has(auth, 'forms.publish') && r.status === 'RELEASED',
      },
    };
  });

  // A new draft copies the released definition; released revisions are never edited (FR-042, AT-03).
  app.post('/api/form-revisions/:id/drafts', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'forms.publish', { action: 'forms.draft', entityType: 'form_revision', entityId: id });
    const body = z.object({ revisionLabel: z.string().trim().min(1).max(20), changeSummary: z.string().trim().min(5).max(2000) }).parse(req.body);
    const created = await withTransaction(db, async (tx) => {
      const r = await loadRevision(tx, id, true);
      if (r.status !== 'RELEASED') throw conflict('Start a new draft from the released revision');
      if (await one(tx, `SELECT 1 FROM form_revision WHERE form_id = $1 AND status IN ('DRAFT', 'IN_REVIEW')`, [r.form_id])) throw conflict(`${r.form_number} already has a draft or a revision in review`);
      if (await one(tx, 'SELECT 1 FROM form_revision WHERE form_id = $1 AND revision_label = $2', [r.form_id, body.revisionLabel])) throw conflict(`Revision ${body.revisionLabel} already exists`);
      const seq = (await one<{ n: number }>(tx, 'SELECT max(sequence)::int + 1 AS n FROM form_revision WHERE form_id = $1', [r.form_id]))!.n;
      const def: FormDefinition = { ...r.definition, revisionLabel: body.revisionLabel };
      const row = await one<{ id: string }>(
        tx,
        `INSERT INTO form_revision (form_id, sequence, revision_label, status, definition, definition_sha256, provenance, change_summary, created_by, based_on_revision_id)
         VALUES ($1,$2,$3,'DRAFT',$4,$5,$6,$7,$8,$9) RETURNING id`,
        [r.form_id, seq, body.revisionLabel, JSON.stringify(def), sha(def), `Drafted in TQMS from ${r.revision_label ? `Rev ${r.revision_label}` : `sequence ${r.sequence}`}`, body.changeSummary, auth.userId, r.id],
      );
      await audit(tx, { actorId: auth.userId, action: 'forms.draft', entityType: 'form_revision', entityId: row!.id, summary: `${r.form_number} Rev ${body.revisionLabel} drafted`, reason: body.changeSummary, requestId: req.id });
      return { id: row!.id };
    });
    return reply.code(201).send(created);
  });

  app.put('/api/form-revisions/:id/definition', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'forms.publish', { action: 'forms.edit', entityType: 'form_revision', entityId: id });
    const body = z.object({ definition: z.unknown(), changeSummary: z.string().trim().min(5).max(2000).optional() }).parse(req.body);
    return withTransaction(db, async (tx) => {
      const r = await loadRevision(tx, id, true);
      if (r.status !== 'DRAFT') throw conflict('Only a draft revision can be edited');
      const parsed = formDefinitionSchema.safeParse(body.definition);
      if (!parsed.success) throw unprocessable('The form definition is not valid', parsed.error.issues.map((i) => i.message));
      const def: FormDefinition = { ...parsed.data, formNumber: r.form_number, revisionLabel: r.revision_label, oneOff: undefined };
      delete def.oneOff;
      // Rows that are new in this draft take a key from their name; keys of rows in the released base never change.
      const base = r.based_on_revision_id ? (await loadRevision(tx, r.based_on_revision_id)).definition : null;
      for (const section of def.sections) {
        const baseKeys = new Set(base?.sections.find((x) => x.key === section.key)?.rows.map((x) => x.key) ?? []);
        const taken = new Set(section.rows.filter((x) => baseKeys.has(x.key)).map((x) => x.key));
        section.rows = section.rows.map((row) => (baseKeys.has(row.key) ? row : { ...row, key: slug(row.name, taken) }));
      }
      const reparsed = formDefinitionSchema.safeParse(def);
      if (!reparsed.success) throw unprocessable('The form definition is not valid', reparsed.error.issues.map((i) => i.message));
      const removed = diffForms(r.definition, def).filter((d) => d.change === 'REMOVED').length;
      await tx.query(`UPDATE form_revision SET definition = $2, definition_sha256 = $3, change_summary = coalesce($4, change_summary), status_changed_at = now() WHERE id = $1`, [
        id,
        JSON.stringify(def),
        sha(def),
        body.changeSummary ?? null,
      ]);
      await audit(tx, { actorId: auth.userId, action: 'forms.edit', entityType: 'form_revision', entityId: id, summary: `Draft edited (${def.sections.length} sections${removed ? `, ${removed} removal(s) vs previous draft` : ''})`, requestId: req.id });
      return { sha256: sha(def) };
    });
  });

  app.post('/api/form-revisions/:id/submit', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'forms.publish', { action: 'forms.submit', entityType: 'form_revision', entityId: id });
    return withTransaction(db, async (tx) => {
      const r = await loadRevision(tx, id, true);
      if (r.status !== 'DRAFT') throw conflict('Only a draft can be submitted');
      if (!diffForms(r.based_on_revision_id ? (await loadRevision(tx, r.based_on_revision_id)).definition : null, r.definition).length) throw unprocessable('The draft has no changes');
      await tx.query(`UPDATE form_revision SET status = 'IN_REVIEW', submitted_by = $2, submitted_at = now(), status_changed_at = now() WHERE id = $1`, [id, auth.userId]);
      await openWork(tx, { kind: 'FORM_RELEASE', title: `Release ${r.form_number} Rev ${r.revision_label}`, subjectType: 'FORM_REVISION', subjectId: id, capability: 'forms.publish' });
      await audit(tx, { actorId: auth.userId, action: 'forms.submit', entityType: 'form_revision', entityId: id, summary: `${r.form_number} Rev ${r.revision_label} submitted for release`, requestId: req.id });
      return { status: 'IN_REVIEW' };
    });
  });

  app.post('/api/form-revisions/:id/return', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'forms.publish', { action: 'forms.return', entityType: 'form_revision', entityId: id });
    const body = z.object({ reason: z.string().trim().min(5).max(2000) }).parse(req.body);
    return withTransaction(db, async (tx) => {
      const r = await loadRevision(tx, id, true);
      if (r.status !== 'IN_REVIEW') throw conflict('Only a revision in review can be returned');
      await tx.query(`UPDATE form_revision SET status = 'DRAFT', status_changed_at = now() WHERE id = $1`, [id]);
      await closeWork(tx, ['FORM_RELEASE'], 'FORM_REVISION', id, auth.userId, 'Returned');
      await audit(tx, { actorId: auth.userId, action: 'forms.return', entityType: 'form_revision', entityId: id, summary: `${r.form_number} Rev ${r.revision_label} returned to draft`, reason: body.reason, requestId: req.id });
      return { status: 'DRAFT' };
    });
  });

  // Only newly started inspections use the new revision; completed ones keep their frozen snapshot (NEG-03).
  app.post('/api/form-revisions/:id/release', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'forms.publish', { action: 'forms.release', entityType: 'form_revision', entityId: id });
    const body = z.object({ rationale: z.string().trim().min(5).max(2000) }).parse(req.body);
    return withTransaction(db, async (tx) => {
      const r = await loadRevision(tx, id, true);
      if (r.status !== 'IN_REVIEW') throw conflict('Only a revision in review can be released');
      if (r.created_by === auth.userId || r.submitted_by === auth.userId)
        throw await auditedDenial(db, req, auth.userId, 'forms.release', 'form_revision', id, 'A form revision must be released by someone other than its author or submitter');
      if (!(await recheckCapability(tx, auth.userId, 'forms.publish'))) throw forbidden();
      const prior = await one<{ id: string; revision_label: string | null }>(tx, `SELECT id, revision_label FROM form_revision WHERE form_id = $1 AND status = 'RELEASED' FOR UPDATE`, [r.form_id]);
      if (prior) await tx.query(`UPDATE form_revision SET status = 'SUPERSEDED', status_changed_at = now() WHERE id = $1`, [prior.id]);
      await tx.query(
        `UPDATE form_revision SET status = 'RELEASED', released_by = $2, released_at = now(), release_rationale = $3, status_changed_at = now() WHERE id = $1`,
        [id, auth.userId, body.rationale],
      );
      await closeWork(tx, ['FORM_RELEASE'], 'FORM_REVISION', id, auth.userId, 'Released');
      await audit(tx, {
        actorId: auth.userId,
        action: 'forms.release',
        entityType: 'form_revision',
        entityId: id,
        summary: `${r.form_number} Rev ${r.revision_label} released${prior ? `; Rev ${prior.revision_label ?? '(original)'} superseded — existing inspections keep their frozen form` : ''}`,
        reason: body.rationale,
        requestId: req.id,
      });
      return { status: 'RELEASED' };
    });
  });

  app.delete('/api/form-revisions/:id', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'forms.publish', { action: 'forms.discard', entityType: 'form_revision', entityId: id });
    return withTransaction(db, async (tx) => {
      const r = await loadRevision(tx, id, true);
      if (r.status !== 'DRAFT') throw conflict('Only a draft can be discarded');
      await tx.query('DELETE FROM form_revision WHERE id = $1', [id]);
      await audit(tx, { actorId: auth.userId, action: 'forms.discard', entityType: 'inspection_form', entityId: r.form_id, summary: `Draft ${r.form_number} Rev ${r.revision_label} discarded`, requestId: req.id });
      return { ok: true };
    });
  });

  // Governed one-off inspection for a product without a catalogue form (FR-042).
  app.post('/api/inspections/one-off', async (req, reply) => {
    await requireCapability(db, req, 'inspection.perform', { action: 'inspection.create', consequential: false });
    const row = z.object({ name: z.string().trim().min(2).max(120), acceptance: z.string().trim().max(500).optional(), unit: z.string().trim().max(20).optional(), specText: z.string().trim().max(200).optional() });
    const body = z
      .object({
        partId: uuid,
        component: z.string().trim().min(2).max(80),
        reason: z.string().trim().min(10).max(1000),
        receivingFromRevisionId: uuid,
        visualRows: z.array(row).max(60).default([]),
        dimensionalRows: z.array(row).max(60).default([]),
        unitCount: z.number().int().min(1).max(100),
        poNumber: z.string().trim().max(60).nullable().optional(),
        dateReceived: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        sourceId: uuid.nullable().optional(),
        lotNumber: z.string().trim().max(80).nullable().optional(),
        lotSize: z.number().int().positive().nullable().optional(),
        samplingNote: z.string().trim().max(500).nullable().optional(),
      })
      .parse(req.body);
    if (!body.visualRows.length && !body.dimensionalRows.length) throw unprocessable('Add at least one visual or dimensional characteristic');
    const template = await loadRevision(db, body.receivingFromRevisionId);
    if (template.status !== 'RELEASED') throw unprocessable('Copy the receiving checklist from a released form');
    const receiving = template.definition.sections.find((s) => s.scope === 'inspection');
    if (!receiving) throw unprocessable(`${template.form_number} has no receiving section`);
    const vk = new Set<string>();
    const dk = new Set<string>();
    const sections: FormSection[] = [
      receiving,
      ...(body.visualRows.length
        ? [{ key: 'B', letter: 'B', title: 'VISUAL INSPECTION', pattern: 'pass_fail_checklist' as const, scope: 'unit' as const, optional: false, rows: body.visualRows.map((r) => ({ key: slug(r.name, vk), name: r.name, acceptance: r.acceptance })) }]
        : []),
      ...(body.dimensionalRows.length
        ? [
            {
              key: 'C',
              letter: 'C',
              title: 'DIMENSIONAL INSPECTION',
              pattern: 'dimensional' as const,
              scope: 'unit' as const,
              optional: false,
              rows: body.dimensionalRows.map((r) => ({ key: slug(r.name, dk), name: r.name, unit: r.unit, specText: r.specText })),
            },
          ]
        : []),
    ];
    const definition: FormDefinition = { schemaVersion: 1, formNumber: 'PDI-IQI-MISC', component: body.component, revisionLabel: null, oneOff: true, sections };
    const created = await createInspection(db, req, {
      partId: body.partId,
      oneOff: { definition, reason: body.reason },
      unitCount: body.unitCount,
      poNumber: body.poNumber,
      dateReceived: body.dateReceived,
      sourceId: body.sourceId,
      lotNumber: body.lotNumber,
      lotSize: body.lotSize,
      samplingNote: body.samplingNote,
    });
    return reply.code(201).send(created);
  });
}
