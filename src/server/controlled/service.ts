import {
  type ControlledTypeDef,
  EVIDENCE_CONTINUATION,
  EVIDENCE_SCHEDULE,
  NARRATIVE_CONTINUATION,
  type RecordData,
  type TemplateSchema,
  continuationNumber,
} from '../../shared/controlled-forms.js';
import { canonicalJson } from '../../shared/forms.js';
import { audit } from '../audit.js';
import { type Queryable, many, one, withTransaction } from '../db.js';
import { type JobRow, PermanentJobError } from '../jobs.js';
import type { Services } from '../services.js';
import type { EvidenceStorage } from '../storage.js';
import { EvidenceIntegrityError } from '../storage.js';
import { sha256 } from './pdf-text.js';
import { RenderProblem, type SheetTemplate, planSheets, renderSheets } from './render.js';
import { DERIVER, deriveTemplate } from './template.js';
import { validateOutput } from './validate.js';

export const SUBJECT = 'CONTROLLED_RECORD';

export async function todayIn(db: Queryable, tz: string): Promise<string> {
  return (await one<{ d: string }>(db, `SELECT (now() AT TIME ZONE $1)::date AS d`, [tz]))!.d;
}

export interface RevisionRef {
  documentId: string;
  documentNumber: string;
  revisionId: string;
  revisionLabel: string;
  effectiveFrom: string;
  sha256: string;
  fileId: string;
  storageKey: string;
}

const REVISION_SELECT = `SELECT d.id AS "documentId", d.number AS "documentNumber", r.id AS "revisionId", r.revision_label AS "revisionLabel",
        r.effective_from AS "effectiveFrom", r.sha256, r.file_id AS "fileId", f.storage_key AS "storageKey"
   FROM controlled_document d
   JOIN controlled_document_revision r ON r.document_id = d.id
   JOIN file_object f ON f.id = r.file_id`;

/** The revision in force on a date: the latest one already effective (Document Library rule). */
export async function revisionInForce(db: Queryable, number: string, asOf: string): Promise<RevisionRef | null> {
  return one<RevisionRef>(db, `${REVISION_SELECT} WHERE d.number = $1 AND r.effective_from <= $2 ORDER BY r.effective_from DESC, r.released_at DESC LIMIT 1`, [number, asOf]);
}

export async function revisionById(db: Queryable, revisionId: string): Promise<RevisionRef | null> {
  return one<RevisionRef>(db, `${REVISION_SELECT} WHERE r.id = $1`, [revisionId]);
}

/** Template definition of a revision, derived from its stored PDF on first use and kept immutably. */
export async function templateFor(db: Queryable, storage: EvidenceStorage, revisionId: string): Promise<TemplateSchema> {
  const cached = await one<{ schema: TemplateSchema }>(db, 'SELECT schema FROM controlled_template WHERE revision_id = $1', [revisionId]);
  if (cached) return cached.schema;
  const rev = await revisionById(db, revisionId);
  if (!rev) throw new Error(`Controlled document revision ${revisionId} not found`);
  const bytes = await storage.readVerified(rev.storageKey, rev.sha256);
  const schema = await deriveTemplate(bytes);
  await db.query(
    `INSERT INTO controlled_template (revision_id, deriver, interactive, schema, schema_sha256) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (revision_id) DO NOTHING`,
    [revisionId, DERIVER, schema.interactive, JSON.stringify(schema), sha256(canonicalJson(schema))],
  );
  return schema;
}

export interface Binding {
  role: 'BASE' | 'CONTINUATION' | 'EVIDENCE' | 'NARRATIVE';
  scheduleKey: string | null;
  documentNumber: string;
  revisionId: string;
  revisionLabel: string;
  effectiveFrom: string;
  sha256: string;
  fileId: string;
}

/** Every sheet a FORM record may need: its base form, each schedule's continuation, the evidence and narrative continuations. */
export async function bindingsInForce(db: Queryable, def: ControlledTypeDef, base: RevisionRef, schema: TemplateSchema, asOf: string): Promise<Binding[]> {
  const out: Binding[] = [{ role: 'BASE', scheduleKey: null, ...pick(base) }];
  if (def.category !== 'FORM') return out;
  for (const s of schema.schedules) {
    if (s.key === EVIDENCE_SCHEDULE) continue;
    const r = await revisionInForce(db, continuationNumber(def.code, s.key), asOf);
    if (r) out.push({ role: 'CONTINUATION', scheduleKey: s.key, ...pick(r) });
  }
  const ev = await revisionInForce(db, EVIDENCE_CONTINUATION, asOf);
  if (ev) out.push({ role: 'EVIDENCE', scheduleKey: null, ...pick(ev) });
  const narr = await revisionInForce(db, NARRATIVE_CONTINUATION, asOf);
  if (narr) out.push({ role: 'NARRATIVE', scheduleKey: null, ...pick(narr) });
  return out;
}

const pick = (r: RevisionRef) => ({ documentNumber: r.documentNumber, revisionId: r.revisionId, revisionLabel: r.revisionLabel, effectiveFrom: r.effectiveFrom, sha256: r.sha256, fileId: r.fileId });

export async function recordBindings(db: Queryable, recordId: string): Promise<Binding[]> {
  return many<Binding>(
    db,
    `SELECT b.role, b.schedule_key AS "scheduleKey", d.number AS "documentNumber", r.id AS "revisionId", r.revision_label AS "revisionLabel",
            r.effective_from AS "effectiveFrom", r.sha256, r.file_id AS "fileId"
       FROM controlled_record_binding b
       JOIN controlled_document d ON d.id = b.document_id
       JOIN controlled_document_revision r ON r.id = b.revision_id
      WHERE b.record_id = $1
      ORDER BY CASE b.role WHEN 'BASE' THEN 0 WHEN 'CONTINUATION' THEN 1 WHEN 'NARRATIVE' THEN 2 ELSE 3 END, d.number`,
    [recordId],
  );
}

export interface RecordRow {
  id: string;
  number: string;
  type_code: string;
  category: 'FORM' | 'ATTACHMENT';
  document_id: string;
  revision_id: string;
  entity_type: string;
  entity_id: string | null;
  entity_label: string;
  title: string;
  status: 'DRAFT' | 'SUBMITTED' | 'COMPLETED' | 'VOID';
  data: RecordData;
  data_sha256: string | null;
  record_revision: number;
  cycle: number;
  prepared_by: string;
  prepared_by_name: string;
  created_at: string;
  submitted_by: string | null;
  submitted_by_name: string | null;
  submitted_at: string | null;
  submitted_on: string | null;
  completed_at: string | null;
  void_reason: string | null;
  version: number;
}

export async function loadRecord(db: Queryable, id: string, tz: string, opts: { lock?: boolean } = {}): Promise<RecordRow | null> {
  return one<RecordRow>(
    db,
    `SELECT c.*, pu.display_name AS prepared_by_name, su.display_name AS submitted_by_name,
            CASE WHEN c.submitted_at IS NULL THEN NULL ELSE (c.submitted_at AT TIME ZONE $2)::date::text END AS submitted_on
       FROM controlled_record c
       JOIN app_user pu ON pu.id = c.prepared_by
       LEFT JOIN app_user su ON su.id = c.submitted_by
      WHERE c.id = $1 ${opts.lock ? 'FOR UPDATE OF c' : ''}`,
    [id, tz],
  );
}

export interface SignatureRow {
  id: string;
  cycle: number;
  role_key: string;
  role_label: string;
  mode: 'INTERNAL' | 'EXTERNAL' | 'NOT_REQUIRED';
  signer_id: string;
  signer_name: string;
  signer_title: string | null;
  signed_on: string;
  decision: string | null;
  statement: string | null;
  reference: string | null;
  details: Record<string, string>;
  data_sha256: string;
  recorded_by: string;
  created_at: string;
}

export async function signatures(db: Queryable, recordId: string): Promise<SignatureRow[]> {
  return many<SignatureRow>(
    db,
    `SELECT s.*, u.display_name AS recorded_by FROM controlled_record_signature s JOIN app_user u ON u.id = s.signer_id
      WHERE s.record_id = $1 ORDER BY s.cycle, s.created_at`,
    [recordId],
  );
}

export interface AttachmentRow {
  linkId: string;
  fileId: string;
  name: string;
  sha256: string;
  mime: string;
  byteSize: number;
  caption: string | null;
  linkedOn: string;
  linkedBy: string;
  conforms: boolean | null;
  conformanceDetail: string | null;
}

export async function attachments(db: Queryable, recordId: string, tz: string): Promise<AttachmentRow[]> {
  return many<AttachmentRow>(
    db,
    `SELECT l.id AS "linkId", f.id AS "fileId", f.original_name AS name, f.sha256, f.mime_type AS mime, f.byte_size::int AS "byteSize",
            l.caption, (l.linked_at AT TIME ZONE $2)::date::text AS "linkedOn", u.display_name AS "linkedBy",
            k.conforms, k.detail AS "conformanceDetail"
       FROM evidence_link l
       JOIN file_object f ON f.id = l.file_id
       JOIN app_user u ON u.id = l.linked_by
       LEFT JOIN controlled_attachment_check k ON k.link_id = l.id
      WHERE l.entity_type = $3 AND l.entity_id = $1 AND l.unlinked_at IS NULL
      ORDER BY l.linked_at, l.id`,
    [recordId, tz, SUBJECT],
  );
}

/** Evidence-register rows for attached files (E01, E02 …), listed ahead of manually entered references. */
export function attachmentRows(files: AttachmentRow[]): Array<Record<string, string>> {
  return files.map((f, i) => ({
    evidence_id: `E${String(i + 1).padStart(2, '0')}`,
    file_ref: `${f.name} (SHA-256 ${f.sha256.slice(0, 12)})`,
    caption: f.caption ?? f.name,
    date: f.linkedOn,
    uploaded_by: f.linkedBy,
    _fileId: f.fileId,
  }));
}

const clip = (v: string, n: number) => (v.length > n ? v.slice(0, n) : v);

/**
 * The values printed on the form: entered data, system identity on every page, the evidence register
 * and, once signed, the decision and approval blocks.
 */
export function composeData(schema: TemplateSchema, rec: RecordRow, files: AttachmentRow[], sigs: SignatureRow[], submittedOn: string | null): RecordData {
  const fields: Record<string, string> = { ...rec.data.fields };
  const has = (k: string) => schema.fields.some((f) => f.key === k);
  if (has('record_id')) fields.record_id = rec.number;
  if (submittedOn && has('submission_date')) fields.submission_date = submittedOn;
  for (const f of schema.fields) {
    const m = /^page(\d+)_(record_ref|sheet_ref)$/.exec(f.key);
    if (!m) continue;
    fields[f.key] = m[2] === 'record_ref' ? `${rec.number} / Rev ${rec.record_revision}` : `${rec.number}-P${m[1]}`;
  }
  const current = sigs.filter((s) => s.cycle === rec.cycle);
  for (const s of current) {
    const n = /^approver(\d)$/.exec(s.role_key)?.[1];
    if (!n) continue;
    if (has(`approver${n}`)) fields[`approver${n}`] = s.mode === 'NOT_REQUIRED' ? 'NA - not required' : s.signer_name;
    if (has(`approval${n}_date`)) fields[`approval${n}_date`] = s.signed_on;
    if (n === '1') {
      if (s.decision && has('pdi_decision')) fields.pdi_decision = s.decision;
      if (s.statement && has('decision_conditions')) fields.decision_conditions = s.statement;
      for (const [k, v] of Object.entries(s.details ?? {})) if (has(k) && v) fields[k] = v;
    }
  }
  if (current.length && has('pdi_authorization_ref')) {
    const first = current[0]!;
    fields.pdi_authorization_ref = clip(`TQM ${rec.number} C${rec.cycle} ${first.id.slice(0, 8)}`, 59);
  }
  const schedules = { ...rec.data.schedules, [EVIDENCE_SCHEDULE]: [...attachmentRows(files), ...(rec.data.schedules[EVIDENCE_SCHEDULE] ?? [])] };
  return { fields, schedules };
}

export interface ControlledSnapshot {
  kind: 'CONTROLLED_FORM';
  schemaVersion: 1;
  docCode: string;
  number: string;
  title: string;
  recordRevision: number;
  cycle: number;
  preparedBy: string;
  completedDate: string;
  generatedAt: string;
  bindings: Binding[];
  data: RecordData;
}

/** Loads the bound template bytes (hash-verified) and schemas for rendering. */
export async function sheetTemplates(svc: Services, bindings: Binding[]) {
  const load = async (b: Binding): Promise<SheetTemplate> => {
    const rev = await revisionById(svc.db, b.revisionId);
    if (!rev || rev.sha256 !== b.sha256) throw new PermanentJobError(`${b.documentNumber} Rev ${b.revisionLabel} is not the bound revision`);
    const bytes = await svc.storage.readVerified(rev.storageKey, rev.sha256);
    return { documentNumber: b.documentNumber, revisionId: b.revisionId, revisionLabel: b.revisionLabel, sha256: b.sha256, bytes, schema: await templateFor(svc.db, svc.storage, b.revisionId) };
  };
  const base = bindings.find((b) => b.role === 'BASE');
  if (!base) throw new PermanentJobError('The record has no bound base revision');
  const continuations: Record<string, SheetTemplate> = {};
  for (const b of bindings.filter((x) => x.role === 'CONTINUATION')) continuations[b.scheduleKey!] = await load(b);
  const ev = bindings.find((b) => b.role === 'EVIDENCE');
  const narr = bindings.find((b) => b.role === 'NARRATIVE');
  return { base: await load(base), continuations, evidence: ev ? await load(ev) : null, narrative: narr ? await load(narr) : null };
}

/** Dry run used before submission: proves the record can be laid out on its bound sheets. */
export async function layoutProblem(svc: Services, snapshot: Omit<ControlledSnapshot, 'generatedAt'>): Promise<string | null> {
  const t = await sheetTemplates(svc, snapshot.bindings);
  try {
    planSheets({ number: snapshot.number, recordRevision: String(snapshot.recordRevision), title: snapshot.title, ...t, data: snapshot.data, preparedBy: snapshot.preparedBy, completedDate: snapshot.completedDate, generatedAt: new Date() });
    return null;
  } catch (err) {
    if (err instanceof RenderProblem) return err.message;
    throw err;
  }
}

/** Background job: renders the frozen snapshot on its bound revisions, validates it, stores the edition. */
export function controlledRenderHandler(svc: Services) {
  return async (job: JobRow) => {
    const snapshotId = String(job.payload.snapshotId ?? '');
    const snap = await one<{ id: string; subject_id: string; edition: number; snapshot: ControlledSnapshot; sha256: string }>(
      svc.db,
      'SELECT id, subject_id, edition, snapshot, sha256 FROM report_snapshot WHERE id = $1 AND subject_type = $2',
      [snapshotId, SUBJECT],
    );
    if (!snap) throw new PermanentJobError(`Controlled record snapshot ${snapshotId} not found`);
    if (await one(svc.db, 'SELECT 1 FROM report_rendition WHERE snapshot_id = $1', [snap.id])) return;
    if (sha256(canonicalJson(snap.snapshot)) !== snap.sha256) throw new PermanentJobError('Controlled record snapshot failed integrity verification');
    const s = snap.snapshot;
    let t: Awaited<ReturnType<typeof sheetTemplates>>;
    try {
      t = await sheetTemplates(svc, s.bindings);
    } catch (err) {
      if (err instanceof EvidenceIntegrityError) throw new PermanentJobError(`${err.message}. Restore the template file from backup.`);
      throw err;
    }
    let rendered: Awaited<ReturnType<typeof renderSheets>>;
    try {
      const sheets = planSheets({ number: s.number, recordRevision: String(s.recordRevision), title: s.title, ...t, data: s.data, preparedBy: s.preparedBy, completedDate: s.completedDate, generatedAt: new Date(s.generatedAt) });
      rendered = await renderSheets(sheets, { number: s.number, title: s.title, generatedAt: new Date(s.generatedAt) });
    } catch (err) {
      if (err instanceof RenderProblem) throw new PermanentJobError(err.message);
      throw err;
    }
    const schemas = new Map([t.base, ...Object.values(t.continuations), ...(t.evidence ? [t.evidence] : []), ...(t.narrative ? [t.narrative] : [])].map((x) => [x.revisionId, x.schema]));
    const validation = await validateOutput(rendered.bytes, rendered.pages, rendered.expected, schemas);
    if (!validation.ok) {
      throw new PermanentJobError(`Generated ${s.number} failed validation against the approved template: ${validation.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('; ')}`);
    }
    const staged = await svc.storage.stageBuffer(Buffer.from(rendered.bytes));
    const storageKey = await svc.storage.finalize(staged);
    try {
      await withTransaction(svc.db, async (tx) => {
        const file = await one<{ id: string }>(
          tx,
          `INSERT INTO file_object (kind, status, sha256, byte_size, mime_type, original_name, storage_key) VALUES ('REPORT','AVAILABLE',$1,$2,'application/pdf',$3,$4) RETURNING id`,
          [staged.sha256, staged.size, `${s.number}-E${snap.edition}.pdf`, storageKey],
        );
        const rendition = await one<{ id: string }>(
          tx,
          `INSERT INTO report_rendition (snapshot_id, subject_type, subject_id, edition, file_id, sha256, page_count) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [snap.id, SUBJECT, snap.subject_id, snap.edition, file!.id, staged.sha256, rendered.pages.length],
        );
        await tx.query(`INSERT INTO controlled_output_validation (rendition_id, ok, result) VALUES ($1, $2, $3)`, [rendition!.id, validation.ok, JSON.stringify({ ...validation, pages: rendered.pages })]);
        await audit(tx, {
          actorId: null,
          action: 'controlled.render',
          entityType: 'controlled_record',
          entityId: snap.subject_id,
          summary: `Rendered ${s.number} edition ${snap.edition} on ${validation.templates.map((x) => `${x.documentNumber} Rev ${x.revisionLabel}`).join(', ')} (${rendered.pages.length} pages, validated)`,
          after: { sha256: staged.sha256 },
        });
      });
    } catch (err) {
      await svc.storage.removeOrphan(storageKey);
      if (await one(svc.db, 'SELECT 1 FROM report_rendition WHERE snapshot_id = $1', [snap.id])) return;
      throw err;
    }
  };
}
