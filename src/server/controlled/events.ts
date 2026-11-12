import type { Capability } from '../../shared/capabilities.js';
import {
  CONTROLLED_TYPE_BY_CODE,
  type ControlledEntity,
  type ControlledTypeDef,
  EVENT_BINDINGS,
  type EventBinding,
  type Problem,
  ROW_KEY,
  type RecordData,
  type TemplateSchema,
  completionProblems,
  decisionBlock,
} from '../../shared/controlled-forms.js';
import { canonicalJson } from '../../shared/forms.js';
import { audit } from '../audit.js';
import { type Queryable, many, one } from '../db.js';
import { conflict, forbidden, unprocessable } from '../errors.js';
import { enqueueJob } from '../jobs.js';
import { nextRecordNumber } from '../numbering.js';
import type { Services } from '../services.js';
import { sha256 } from './pdf-text.js';
import { entityContext, fitToTemplate } from './prefill.js';
import {
  type ControlledSnapshot,
  type RecordRow,
  SUBJECT,
  type SignatureRow,
  attachments,
  bindingsInForce,
  composeData,
  layoutProblem,
  loadRecord,
  recordBindings,
  revisionInForce,
  signatures,
  templateFor,
  todayIn,
} from './service.js';

/**
 * One approval path per module event. Module services call these inside their own transactions, so
 * the controlled record opens, submits, is decided or is voided together with the module record —
 * never as a second, separate approval.
 */

let services: Services | null = null;

/** Registered once at start-up (app.ts); module hooks need storage to read template revisions. */
export function useControlledServices(svc: Services) {
  services = svc;
}

function svc(): Services {
  if (!services) throw new Error('Controlled records are not initialised');
  return services;
}

export interface Actor {
  userId: string;
  displayName: string;
}

export interface Step {
  key: string;
  label: string;
  mode: 'INTERNAL' | 'EXTERNAL';
  capabilities: Capability[];
  /** This block records the PDI decision. */
  decides: boolean;
  optional: boolean;
  /** Signed by the module decision (event-bound records), never on the controlled record itself. */
  module: EventBinding['decision'] | null;
}

/** The approval blocks printed on the bound template (FORM) or the required acknowledgments (ATTACHMENT). */
export function stepsFor(def: ControlledTypeDef, schema: TemplateSchema | null, eventBound = false): Step[] {
  if (def.category === 'ATTACHMENT') return def.signatures.map((s) => ({ key: s.key, label: s.label, mode: s.mode, capabilities: s.capabilities, decides: false, optional: false, module: null }));
  const decision = eventBound ? (EVENT_BINDINGS[def.code]?.decision ?? null) : null;
  const decider = decision?.block ?? 'approver1';
  return def.steps
    .filter((s) => !schema || schema.fields.some((f) => f.key === s.field))
    .map((s) => ({
      key: s.field,
      label: schema?.fields.find((f) => f.key === s.field)?.label ?? s.field,
      mode: 'INTERNAL' as const,
      capabilities: s.capabilities,
      decides: s.field === decider,
      optional: s.optional,
      module: decision && s.field === decision.block ? decision : null,
    }));
}

export const isEventBound = (rec: { event_bound?: boolean }) => rec.event_bound === true;

/** The open (draft or submitted) event record of a type for a module record. */
export async function openRecordFor(db: Queryable, code: string, entityType: ControlledEntity, entityId: string, lock = false): Promise<{ id: string } | null> {
  return one<{ id: string }>(
    db,
    `SELECT id FROM controlled_record WHERE type_code = $1 AND entity_type = $2 AND entity_id = $3 AND event_bound AND status IN ('DRAFT', 'SUBMITTED')${lock ? ' FOR UPDATE' : ''}`,
    [code, entityType, entityId],
  );
}

/**
 * Opens the event's controlled record in the module's transaction, bound to the released revisions in
 * force today (base form, continuation sheets, evidence and narrative continuations). Returns null —
 * and the module carries on as before — when no interactive revision of the form is in force.
 */
export async function openEventRecord(tx: Queryable, code: string, entityId: string, actor: Actor, requestId?: string): Promise<{ id: string; number: string } | null> {
  const binding = EVENT_BINDINGS[code];
  const def = CONTROLLED_TYPE_BY_CODE[code];
  if (!binding || !def) throw new Error(`${code} is not opened by a module event`);
  const { storage, config } = svc();
  const asOf = await todayIn(tx, config.displayTimeZone);
  const base = await revisionInForce(tx, code, asOf);
  if (!base) return null;
  let schema: TemplateSchema;
  try {
    schema = await templateFor(tx, storage, base.revisionId);
  } catch {
    return null; // template file unreadable: the module records the event without a controlled form
  }
  if (!schema.interactive) return null;
  const existing = await openRecordFor(tx, code, binding.entity, entityId);
  if (existing) return { id: existing.id, number: (await one<{ number: string }>(tx, 'SELECT number FROM controlled_record WHERE id = $1', [existing.id]))!.number };
  const ctx = await entityContext(tx, binding.entity, entityId, code, config.displayTimeZone);
  if (!ctx) return null;
  const bindings = await bindingsInForce(tx, def, base, schema, asOf);
  const title = (await one<{ title: string }>(tx, 'SELECT title FROM controlled_document WHERE number = $1', [code]))!.title;
  const number = await nextRecordNumber(tx, code);
  const row = await one<{ id: string }>(
    tx,
    `INSERT INTO controlled_record (number, type_code, category, document_id, revision_id, entity_type, entity_id, entity_label, title, data, prepared_by, event_bound)
     VALUES ($1,$2,'FORM',$3,$4,$5,$6,$7,$8,'{"fields": {}, "schedules": {}}',$9,true) RETURNING id`,
    [number, code, base.documentId, base.revisionId, binding.entity, entityId, ctx.label.slice(0, 300), title, actor.userId],
  );
  for (const b of bindings) {
    await tx.query(
      `INSERT INTO controlled_record_binding (record_id, document_id, revision_id, role, schedule_key)
       SELECT $1, r.document_id, r.id, $3, $4 FROM controlled_document_revision r WHERE r.id = $2`,
      [row!.id, b.revisionId, b.role, b.scheduleKey],
    );
  }
  await audit(tx, {
    actorId: actor.userId,
    action: 'controlled.open',
    entityType: 'controlled_record',
    entityId: row!.id,
    summary: `${number} opened on ${code} Rev ${base.revisionLabel} when ${binding.opensWhen} (${ctx.label})`,
    after: { bindings: bindings.map((b) => `${b.documentNumber} Rev ${b.revisionLabel}`), entity: binding.entity, entityId },
    requestId,
  });
  return { id: row!.id, number };
}

export interface Derived {
  /** Module facts fitted to the template; on an event record these are locked. */
  data: RecordData;
  /** Schedules whose rows are the module's rows (only their other columns are entered on the form). */
  owned: string[];
  route: string | null;
}

/** The module's current facts for a record, fitted to its bound template. */
export async function derivedFor(db: Queryable, rec: Pick<RecordRow, 'entity_type' | 'entity_id' | 'type_code' | 'prepared_by_name'>, schema: TemplateSchema): Promise<Derived> {
  const ctx = await entityContext(db, rec.entity_type as ControlledEntity, rec.entity_id, rec.type_code, svc().config.displayTimeZone);
  if (!ctx) return { data: { fields: {}, schedules: {} }, owned: [], route: null };
  const data = fitToTemplate(schema, ctx, { prepared_by: `${rec.prepared_by_name} / PDI` });
  return { data, owned: Object.keys(data.schedules), route: ctx.route ?? null };
}

const filled = (v: string | undefined) => typeof v === 'string' && v !== '';

/** Entered values with the module's facts laid over them: the module is where those facts are entered. */
export function mergeDerived(schema: TemplateSchema, derived: Derived, entered: RecordData): RecordData {
  const fields: Record<string, string> = { ...entered.fields };
  for (const [k, v] of Object.entries(derived.data.fields)) if (filled(v)) fields[k] = v;
  const schedules: RecordData['schedules'] = { ...entered.schedules };
  for (const key of derived.owned) {
    const s = schema.schedules.find((x) => x.key === key);
    if (!s) continue;
    const mine = entered.schedules[key] ?? [];
    schedules[key] = (derived.data.schedules[key] ?? []).map((d) => {
      const e = mine.find((r) => r[ROW_KEY] && r[ROW_KEY] === d[ROW_KEY]) ?? {};
      const out: Record<string, string> = { [ROW_KEY]: d[ROW_KEY] ?? '' };
      for (const c of s.columns) {
        const v = filled(d[c.key]) ? d[c.key] : e[c.key];
        if (filled(v)) out[c.key] = v!;
      }
      return out;
    });
  }
  return { fields, schedules };
}

/** Paths a person cannot edit on an event record: `fields.<key>` and `schedules.<key>.<row>.<column>`. */
export function lockedPaths(schema: TemplateSchema, derived: Derived): string[] {
  const out = Object.entries(derived.data.fields).filter(([, v]) => filled(v)).map(([k]) => `fields.${k}`);
  for (const key of derived.owned) {
    const s = schema.schedules.find((x) => x.key === key);
    (derived.data.schedules[key] ?? []).forEach((row, i) => {
      for (const c of s?.columns ?? []) if (filled(row[c.key])) out.push(`schedules.${key}.${i}.${c.key}`);
    });
  }
  return out;
}

/** Keeps only what the form adds to the module's facts: locked values are never stored as entries. */
export function enteredOnly(schema: TemplateSchema, derived: Derived, input: RecordData): RecordData {
  const fields = Object.fromEntries(Object.entries(input.fields).filter(([k]) => !filled(derived.data.fields[k])));
  const schedules: RecordData['schedules'] = { ...input.schedules };
  for (const key of derived.owned) {
    const rows = derived.data.schedules[key] ?? [];
    schedules[key] = (input.schedules[key] ?? [])
      .filter((r) => r[ROW_KEY] && rows.some((d) => d[ROW_KEY] === r[ROW_KEY]))
      .map((r) => {
        const d = rows.find((x) => x[ROW_KEY] === r[ROW_KEY])!;
        return Object.fromEntries(Object.entries(r).filter(([k]) => k === ROW_KEY || !filled(d[k])));
      });
  }
  return { fields, schedules };
}

/** True when the module's facts are still exactly what the submitted record shows. */
function derivedUnchanged(schema: TemplateSchema, derived: Derived, frozen: RecordData): boolean {
  const now = mergeDerived(schema, derived, frozen);
  for (const path of lockedPaths(schema, derived)) {
    const [kind, key, ...rest] = path.split('.');
    if (kind === 'fields') {
      if ((frozen.fields[key!] ?? '') !== (now.fields[key!] ?? '')) return false;
    } else {
      const [i, col] = rest;
      if ((frozen.schedules[key!]?.[Number(i)]?.[col!] ?? '') !== (now.schedules[key!]?.[Number(i)]?.[col!] ?? '')) return false;
    }
  }
  for (const key of derived.owned) if ((frozen.schedules[key]?.length ?? 0) !== (derived.data.schedules[key]?.length ?? 0)) return false;
  return true;
}

/** What a submission would check, for display before it happens. */
export async function eventProblems(db: Queryable, rec: RecordRow, schema: TemplateSchema): Promise<{ merged: RecordData; problems: Problem[]; derived: Derived }> {
  const derived = await derivedFor(db, rec, schema);
  const merged = mergeDerived(schema, derived, rec.data);
  return { merged, problems: completionProblems(schema, merged), derived };
}

/**
 * Submits an event record for its decision: the module's facts and the entries made on the form are
 * frozen together and hashed. Called by the module action that submits it (inspection completion) or
 * by the preparer's "Submit for decision".
 */
export async function submitEventRecord(tx: Queryable, recordId: string, actor: Actor, requestId?: string, expectedVersion?: number): Promise<{ number: string; version: number }> {
  const s = svc();
  const tz = s.config.displayTimeZone;
  const rec = await loadRecord(tx, recordId, tz, { lock: true });
  if (!rec) throw conflict('Controlled record not found');
  if (rec.status !== 'DRAFT') throw conflict(`${rec.number} is already ${rec.status.toLowerCase()}`);
  if (expectedVersion !== undefined && rec.version !== expectedVersion) throw conflict('The record was changed by someone else; reload to see the latest');
  const schema = await templateFor(tx, s.storage, rec.revision_id);
  const { merged, problems } = await eventProblems(tx, rec, schema);
  if (problems.length) {
    throw unprocessable(`${rec.number} (${rec.type_code}) has ${problems.length} item(s) to complete before it can be submitted: ${problems.slice(0, 3).map((p) => p.message).join('; ')}${problems.length > 3 ? '; …' : ''}`, problems);
  }
  const files = await attachments(tx, rec.id, tz);
  const today = await todayIn(tx, tz);
  const preview = composeData(schema, { ...rec, data: merged }, files, [], today, decisionBlock(rec.type_code));
  const layout = await layoutProblem(s, { kind: 'CONTROLLED_FORM', schemaVersion: 1, docCode: rec.type_code, number: rec.number, title: rec.title, recordRevision: rec.record_revision, cycle: rec.cycle, preparedBy: rec.prepared_by_name, completedDate: today, bindings: await recordBindings(tx, rec.id), data: preview });
  if (layout) throw unprocessable(layout, [{ path: 'layout', message: layout }]);
  const hash = sha256(canonicalJson({ data: merged, files: files.map((f) => f.sha256) }));
  await tx.query(
    `UPDATE controlled_record SET status = 'SUBMITTED', data = $2, submitted_by = $3, submitted_at = now(), data_sha256 = $4, version = version + 1, updated_at = now() WHERE id = $1`,
    [rec.id, JSON.stringify(merged), actor.userId, hash],
  );
  await audit(tx, { actorId: actor.userId, action: 'controlled.submit', entityType: 'controlled_record', entityId: rec.id, summary: `${rec.number} submitted for decision`, after: { dataSha256: hash }, requestId });
  return { number: rec.number, version: rec.version + 1 };
}

/** Whether a "when required" concurrence must be signed for this record. */
async function concurrenceRequired(db: Queryable, rec: RecordRow, step: Step): Promise<boolean> {
  if (!step.optional) return true;
  if (rec.type_code === 'OPS-06' && rec.entity_id) {
    // Material review: engineering approves repair and use-as-is dispositions.
    return !!(await one(
      db,
      `SELECT 1 FROM disposition_decision d JOIN material_scope m ON m.id = d.scope_id
        WHERE m.ncr_id = $1 AND d.voided_at IS NULL AND d.outcome IN ('REPAIR', 'USE_AS_IS')`,
      [rec.entity_id],
    ));
  }
  return false;
}

export interface ModuleDecision {
  code: string;
  entityType: ControlledEntity;
  entityId: string;
  actor: Actor;
  grants: Capability[];
  /** A value of the template's PDI decision choice. */
  decision: string;
  statement: string;
  details?: Record<string, string>;
  requestId?: string;
}

/** Readiness of an event record for its module decision; null when the event has no open record. */
export async function decisionReadiness(db: Queryable, code: string, entityType: ControlledEntity, entityId: string, userId?: string): Promise<{ recordId: string; number: string; ready: boolean; reason: string | null } | null> {
  const open = await openRecordFor(db, code, entityType, entityId);
  if (!open) return null;
  const s = svc();
  const rec = (await loadRecord(db, open.id, s.config.displayTimeZone))!;
  const label = EVENT_BINDINGS[code]?.decision?.label.toLowerCase() ?? 'the decision';
  if (rec.status === 'DRAFT') {
    const schema = await templateFor(db, s.storage, rec.revision_id);
    const { problems } = await eventProblems(db, rec, schema);
    return {
      recordId: rec.id,
      number: rec.number,
      ready: false,
      reason: problems.length ? `Complete ${rec.number} (${problems.length} item(s) open) and submit it before you ${label}` : `Submit ${rec.number} for decision before you ${label}`,
    };
  }
  const def = CONTROLLED_TYPE_BY_CODE[code]!;
  const schema = await templateFor(db, s.storage, rec.revision_id);
  const current = (await signatures(db, rec.id)).filter((x) => x.cycle === rec.cycle);
  for (const step of stepsFor(def, schema, true)) {
    if (step.module || current.some((x) => x.role_key === step.key)) continue;
    if (await concurrenceRequired(db, rec, step)) return { recordId: rec.id, number: rec.number, ready: false, reason: `${step.label} signs ${rec.number} before you ${label}` };
  }
  if (userId && !independent(rec, current, userId)) {
    return { recordId: rec.id, number: rec.number, ready: false, reason: `You prepared, submitted or already signed ${rec.number}; another approver decides it (POL-01)` };
  }
  return { recordId: rec.id, number: rec.number, ready: true, reason: null };
}

/** POL-01: the preparer, the submitter and anyone who already signed this cycle cannot approve again. */
export function independent(rec: Pick<RecordRow, 'prepared_by' | 'submitted_by'>, current: Array<Pick<SignatureRow, 'signer_id' | 'mode'>>, userId: string): boolean {
  if (rec.prepared_by === userId || rec.submitted_by === userId) return false;
  return !current.some((s) => s.mode === 'INTERNAL' && s.signer_id === userId);
}

/**
 * The module decision signs the event record's deciding block in the module's transaction: the form
 * must be submitted, its concurrences signed (or not required), the module facts unchanged since
 * submission and the decider independent. The record completes and its controlled PDF is queued.
 * Returns null when the event has no open record (no form in force when it was opened).
 */
export async function decideEvent(tx: Queryable, input: ModuleDecision): Promise<{ id: string; number: string } | null> {
  const binding = EVENT_BINDINGS[input.code];
  if (!binding?.decision) throw new Error(`${input.code} is not decided by a module action`);
  const open = await openRecordFor(tx, input.code, input.entityType, input.entityId, true);
  if (!open) return null;
  const s = svc();
  const tz = s.config.displayTimeZone;
  const rec = (await loadRecord(tx, open.id, tz, { lock: true }))!;
  const label = binding.decision.label.toLowerCase();
  if (rec.status !== 'SUBMITTED') {
    const schema = await templateFor(tx, s.storage, rec.revision_id);
    const { problems } = await eventProblems(tx, rec, schema);
    throw unprocessable(
      problems.length ? `Complete ${rec.number} (${problems.length} item(s) open) and submit it before you ${label}` : `Submit ${rec.number} for decision before you ${label}`,
      problems,
    );
  }
  const def = CONTROLLED_TYPE_BY_CODE[input.code]!;
  const schema = await templateFor(tx, s.storage, rec.revision_id);
  const derived = await derivedFor(tx, rec, schema);
  if (!derivedUnchanged(schema, derived, rec.data)) {
    throw conflict(`The ${binding.decision.module} changed after ${rec.number} was submitted. Return ${rec.number} to draft so the form shows the current record, then submit it again.`);
  }
  const options = schema.fields.find((f) => f.key === 'pdi_decision')?.options ?? [];
  if (options.length && !options.includes(input.decision)) {
    throw unprocessable(`${rec.type_code} Rev on this record has no PDI decision "${input.decision}" (${options.join(', ')})`);
  }
  const steps = stepsFor(def, schema, true);
  const block = steps.find((x) => x.module)!;
  const today = await todayIn(tx, tz);
  let current = (await signatures(tx, rec.id)).filter((x) => x.cycle === rec.cycle);
  if (!independent(rec, current, input.actor.userId)) {
    throw forbidden(`Approval must be independent: whoever prepared, submitted or already signed ${rec.number} cannot ${label} (POL-01)`);
  }
  for (const step of steps) {
    if (step.module || current.some((x) => x.role_key === step.key)) continue;
    if (await concurrenceRequired(tx, rec, step)) throw conflict(`${step.label} must sign ${rec.number} before you ${label}`);
    await tx.query(
      `INSERT INTO controlled_record_signature (record_id, cycle, role_key, role_label, mode, signer_id, signer_name, signed_on, statement, data_sha256, module_action)
       VALUES ($1,$2,$3,$4,'NOT_REQUIRED',$5,$6,$7,$8,$9,$10)`,
      [rec.id, rec.cycle, step.key, step.label, input.actor.userId, input.actor.displayName, today, `${step.label} not required${binding.requiredWhen ? ` (only when ${binding.requiredWhen})` : ''}`, rec.data_sha256, binding.decision.action],
    );
  }
  const details = Object.fromEntries(Object.entries(input.details ?? {}).filter(([k, v]) => v && schema.fields.some((f) => f.key === k && f.role === 'DECISION')));
  await tx.query(
    `INSERT INTO controlled_record_signature (record_id, cycle, role_key, role_label, mode, signer_id, signer_name, signed_on, decision, statement, details, data_sha256, grants_used, module_action)
     VALUES ($1,$2,$3,$4,'INTERNAL',$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [rec.id, rec.cycle, block.key, block.label, input.actor.userId, input.actor.displayName, today, input.decision, input.statement, JSON.stringify(details), rec.data_sha256, input.grants, binding.decision.action],
  );
  await tx.query(`UPDATE controlled_record SET status = 'COMPLETED', completed_at = now(), version = version + 1, updated_at = now() WHERE id = $1`, [rec.id]);
  current = (await signatures(tx, rec.id)).filter((x) => x.cycle === rec.cycle);
  await audit(tx, {
    actorId: input.actor.userId,
    action: 'controlled.decide',
    entityType: 'controlled_record',
    entityId: rec.id,
    summary: `${rec.number}: ${block.label} signed by ${input.actor.displayName} through ${binding.decision.action} — decision ${input.decision}; record completed`,
    after: { step: block.key, dataSha256: rec.data_sha256, moduleAction: binding.decision.action },
    requestId: input.requestId,
  });
  await freezeAndQueue(tx, rec, schema, current, today);
  return { id: rec.id, number: rec.number };
}

/** Freezes the printed content and queues the controlled PDF; runs inside the completing transaction. */
export async function freezeAndQueue(tx: Queryable, rec: RecordRow, schema: TemplateSchema, sigs: SignatureRow[], today: string) {
  const tz = svc().config.displayTimeZone;
  const files = await attachments(tx, rec.id, tz);
  const signed = await loadRecord(tx, rec.id, tz);
  const snapshot: ControlledSnapshot = {
    kind: 'CONTROLLED_FORM',
    schemaVersion: 1,
    docCode: rec.type_code,
    number: rec.number,
    title: rec.title,
    recordRevision: rec.record_revision,
    cycle: rec.cycle,
    preparedBy: rec.prepared_by_name,
    completedDate: signed?.submitted_on ?? today,
    generatedAt: new Date().toISOString(),
    bindings: await recordBindings(tx, rec.id),
    data: composeData(schema, signed ?? rec, files, sigs, signed?.submitted_on ?? today, rec.event_bound ? decisionBlock(rec.type_code) : 'approver1'),
  };
  const snap = await one<{ id: string }>(
    tx,
    `INSERT INTO report_snapshot (subject_type, subject_id, edition, snapshot, sha256) VALUES ($1, $2, 1, $3, $4) RETURNING id`,
    [SUBJECT, rec.id, JSON.stringify(snapshot), sha256(canonicalJson(snapshot))],
  );
  await enqueueJob(tx, 'controlled_render', `controlled_render:${rec.id}:1`, { snapshotId: snap!.id });
}

/** A module return (e.g. inspection returned for correction) sends the submitted record back to draft for a new cycle. */
export async function returnEventRecord(tx: Queryable, code: string, entityType: ControlledEntity, entityId: string, actor: Actor, reason: string, requestId?: string) {
  const open = await openRecordFor(tx, code, entityType, entityId, true);
  if (!open) return;
  const rec = (await loadRecord(tx, open.id, svc().config.displayTimeZone, { lock: true }))!;
  if (rec.status !== 'SUBMITTED') return;
  await tx.query(`UPDATE controlled_record SET status = 'DRAFT', cycle = cycle + 1, version = version + 1, updated_at = now() WHERE id = $1`, [rec.id]);
  await audit(tx, { actorId: actor.userId, action: 'controlled.return', entityType: 'controlled_record', entityId: rec.id, summary: `${rec.number} returned to draft with the ${EVENT_BINDINGS[code]?.decision?.module ?? 'module record'}`, reason, requestId });
}

/** A cancelled or withdrawn event voids its open controlled records; completed ones stay as recorded. */
export async function voidEventRecords(tx: Queryable, entityType: ControlledEntity, entityId: string, actor: Actor, reason: string, requestId?: string) {
  const open = await many<{ id: string; number: string }>(
    tx,
    `SELECT id, number FROM controlled_record WHERE entity_type = $1 AND entity_id = $2 AND event_bound AND status IN ('DRAFT', 'SUBMITTED') FOR UPDATE`,
    [entityType, entityId],
  );
  for (const r of open) {
    await tx.query(`UPDATE controlled_record SET status = 'VOID', voided_by = $2, voided_at = now(), void_reason = $3, version = version + 1, updated_at = now() WHERE id = $1`, [r.id, actor.userId, reason]);
    await audit(tx, { actorId: actor.userId, action: 'controlled.void', entityType: 'controlled_record', entityId: r.id, summary: `${r.number} voided with its ${entityType.toLowerCase().replaceAll('_', ' ')}`, reason, requestId });
  }
}

/**
 * Forms whose own deciding approval is the decision (INT-01): its outcome drives the module record in
 * the completing transaction. A rejected sourcing request is cancelled.
 */
export async function applyFormDecision(tx: Queryable, rec: RecordRow, decision: string | null, actor: Actor, requestId?: string) {
  if (!rec.event_bound || rec.type_code !== 'INT-01' || !rec.entity_id || decision !== 'Reject') return;
  const r = await one<{ number: string; status: string }>(tx, 'SELECT number, status FROM sourcing_request WHERE id = $1 FOR UPDATE', [rec.entity_id]);
  if (!r || !['OPEN', 'SOURCE_CREATED'].includes(r.status)) return;
  await tx.query(`UPDATE sourcing_request SET status = 'CANCELLED', version = version + 1 WHERE id = $1`, [rec.entity_id]);
  await tx.query(
    `UPDATE work_item SET status = 'CANCELLED', closed_at = now(), closed_by = $2, closed_reason = $3 WHERE subject_type = 'SOURCING_REQUEST' AND subject_id = $1 AND status = 'OPEN'`,
    [rec.entity_id, actor.userId, `Rejected on ${rec.number}`],
  );
  await audit(tx, { actorId: actor.userId, action: 'sourcing.cancel', entityType: 'sourcing_request', entityId: rec.entity_id, summary: `${r.number} rejected on ${rec.number} (${rec.type_code})`, requestId });
}

/**
 * Whether the module event can still take its decision, so a record started for it now (an event
 * opened before its form was in force, or the 8D companion) would be decided with it.
 */
export async function eventStillOpen(db: Queryable, code: string, entityId: string): Promise<boolean> {
  const q: Record<string, string> = {
    'OPS-02': `SELECT 1 FROM inspection WHERE id = $1 AND status NOT IN ('COMPLETED', 'READY_FOR_REVIEW', 'VOID')`,
    'OPS-04': `SELECT 1 FROM change_request WHERE id = $1 AND status IN ('PROPOSED', 'IMPACT_ASSESSED')`,
    'OPS-05': `SELECT 1 FROM concession WHERE id = $1 AND status = 'REQUESTED'`,
    'OPS-06': `SELECT 1 FROM ncr WHERE id = $1 AND status <> 'CLOSED'`,
    'OPS-07': `SELECT 1 FROM scar WHERE id = $1 AND status <> 'CLOSED'`,
    'OPS-08': `SELECT 1 FROM scar WHERE id = $1 AND status <> 'CLOSED'`,
    'VAL-02': `SELECT 1 FROM fai_sample WHERE id = $1 AND status = 'OPEN'`,
    'VAL-11': `SELECT 1 FROM source WHERE id = $1 AND approval_state IN ('NOT_APPROVED', 'IN_REVIEW')`,
    'INT-01': `SELECT 1 FROM sourcing_request WHERE id = $1 AND status IN ('OPEN', 'SOURCE_CREATED')`,
  };
  const sql = q[code];
  return sql ? !!(await one(db, sql, [entityId])) : true;
}

/** The person a module action acts for (name as shown on the form). */
export async function actorOf(db: Queryable, userId: string): Promise<Actor> {
  const u = await one<{ display_name: string }>(db, 'SELECT display_name FROM app_user WHERE id = $1', [userId]);
  return { userId, displayName: u?.display_name ?? 'Unknown user' };
}

/** Refuses a signature on an event record whose module facts changed after it was submitted. */
export async function assertDerivedUnchanged(db: Queryable, rec: RecordRow, schema: TemplateSchema) {
  if (!rec.event_bound || rec.status !== 'SUBMITTED') return;
  const derived = await derivedFor(db, rec, schema);
  if (!derivedUnchanged(schema, derived, rec.data)) {
    const module = ENTITY_LABEL[rec.entity_type] ?? 'module record';
    throw conflict(`The ${module} changed after ${rec.number} was submitted. Return ${rec.number} to draft so the form shows the current record, then submit it again.`);
  }
}

const ENTITY_LABEL: Record<string, string> = {
  SOURCING_REQUEST: 'sourcing request',
  SOURCE: 'exact source',
  FAI: 'first article',
  CHANGE: 'change',
  INSPECTION: 'inspection',
  CONCESSION: 'concession',
  NCR: 'NCR',
  SCAR: 'SCAR',
};
