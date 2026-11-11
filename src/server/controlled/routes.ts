import { readFile } from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { PDFDocument } from 'pdf-lib';
import { z } from 'zod';
import type { Capability } from '../../shared/capabilities.js';
import {
  CONTROLLED_TYPES,
  CONTROLLED_TYPE_BY_CODE,
  type ControlledEntity,
  type ControlledTypeDef,
  ENTITY_ROUTES,
  EVENT_BINDINGS,
  EVIDENCE_SCHEDULE,
  ROW_FILE,
  ROW_KEY,
  ROW_LABEL,
  type RecordData,
  type TemplateSchema,
  completionProblems,
  decisionBlock,
  isRealDate,
  valueProblems,
} from '../../shared/controlled-forms.js';
import { canonicalJson } from '../../shared/forms.js';
import { audit } from '../audit.js';
import { type AuthContext, recheckCapability, requireAuth } from '../auth.js';
import { type Queryable, many, one, withTransaction } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { sanitizeFilename, validateDocument } from '../file-validation.js';
import { nextRecordNumber } from '../numbering.js';
import type { Services } from '../services.js';
import { FileTooLargeError } from '../storage.js';
import {
  type Step,
  applyFormDecision,
  assertDerivedUnchanged,
  decisionReadiness,
  derivedFor,
  enteredOnly,
  eventProblems,
  eventStillOpen,
  freezeAndQueue,
  independent,
  lockedPaths,
  mergeDerived,
  openEventRecord,
  openRecordFor,
  stepsFor,
  submitEventRecord,
} from './events.js';
import { sha256 } from './pdf-text.js';
import { entityContext, fitToTemplate } from './prefill.js';
import {
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

const uuid = z.string().uuid();
const version = z.number().int().positive();

/** Anyone who can prepare, approve or acknowledge some controlled record. */
const CONTROLLED_CAPS = [...new Set(CONTROLLED_TYPES.flatMap((t) => [...t.authors, ...t.steps.flatMap((s) => s.capabilities), ...t.signatures.flatMap((s) => s.capabilities)]))] as Capability[];

const holdsAny = (auth: AuthContext, caps: Capability[]) => caps.some((c) => auth.capabilities.has(c));

async function requireControlled(db: Queryable, req: FastifyRequest, action: string, entityId?: string): Promise<AuthContext> {
  const auth = requireAuth(req);
  if (!holdsAny(auth, CONTROLLED_CAPS)) {
    await audit(db, { actorId: auth.userId, action, outcome: 'DENIED', entityType: 'controlled_record', entityId, summary: 'Denied: no authority over controlled records', requestId: req.id });
    throw forbidden('This action requires authority to prepare or approve controlled records');
  }
  return auth;
}

async function deny(db: Queryable, req: FastifyRequest, auth: AuthContext, action: string, id: string, message: string): Promise<never> {
  await audit(db, { actorId: auth.userId, action, outcome: 'DENIED', entityType: 'controlled_record', entityId: id, summary: `Denied: ${message}`, requestId: req.id });
  throw forbidden(message);
}

/**
 * A record of an event-bound type that is not the event's own record (started before the event was
 * bound to its form). It stays on file but takes no approval: the event is decided in its module.
 */
const superseded = (rec: Pick<RecordRow, 'type_code' | 'event_bound' | 'status'>) =>
  !!EVENT_BINDINGS[rec.type_code] && !rec.event_bound && (rec.status === 'DRAFT' || rec.status === 'SUBMITTED');

const SUPERSEDED = (rec: Pick<RecordRow, 'number' | 'type_code'>) =>
  `${rec.number} was started before ${rec.type_code} was bound to its module event; it takes no approval. Use the record opened by the ${EVENT_BINDINGS[rec.type_code]?.decision?.module ?? 'module record'} (start it from there if it has none) and void this draft.`;

const MAX_TEXT = 20000;
const MAX_ROWS = 500;

/** Keeps the entered parts of a draft that the bound template can hold. */
function sanitizeData(schema: TemplateSchema, input: RecordData): RecordData {
  const fields: Record<string, string> = {};
  for (const f of schema.fields) {
    if (f.role !== 'ENTRY') continue;
    const v = input.fields?.[f.key];
    if (typeof v === 'string' && v !== '') fields[f.key] = v.slice(0, MAX_TEXT);
  }
  const schedules: RecordData['schedules'] = {};
  for (const s of schema.schedules) {
    const rows = input.schedules?.[s.key];
    if (!Array.isArray(rows)) continue;
    if (rows.length > MAX_ROWS) throw badRequest(`${s.title ?? s.key}: at most ${MAX_ROWS} rows`);
    const keys = new Set([...s.columns.map((c) => c.key), ROW_KEY, ...(s.rowLabels ? [ROW_LABEL] : [])]);
    schedules[s.key] = rows
      .filter((r) => !(s.key === EVIDENCE_SCHEDULE && r?.[ROW_FILE]))
      .map((r) => {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(r ?? {})) if (keys.has(k) && typeof v === 'string' && v !== '') out[k] = v.slice(0, MAX_TEXT);
        return out;
      });
    // Trailing empty rows beyond the printed checklist are not records.
    const printed = s.rowLabels?.length ?? 0;
    while (schedules[s.key]!.length > printed && Object.keys(schedules[s.key]![schedules[s.key]!.length - 1]!).length === 0) schedules[s.key]!.pop();
  }
  return { fields, schedules };
}

const dataSchema = z.object({ fields: z.record(z.string()).default({}), schedules: z.record(z.array(z.record(z.string()))).default({}) });

export function registerControlledRoutes(app: FastifyInstance, svc: Services) {
  const { db, storage, config } = svc;
  const tz = config.displayTimeZone;

  const baseSchemaOf = async (rec: RecordRow) => templateFor(db, storage, rec.revision_id);

  /** Types with the revision in force today and whether it can drive a form. */
  app.get('/api/controlled/types', async (req) => {
    requireAuth(req);
    const auth = req.auth!;
    if (!auth.capabilities.has('records.read')) throw forbidden('This action requires the "records.read" authority');
    const asOf = await todayIn(db, tz);
    const out = [];
    for (const t of CONTROLLED_TYPES) {
      const rev = await revisionInForce(db, t.code, asOf);
      let interactive: boolean | null = null;
      let fields = 0;
      if (rev) {
        try {
          const schema = await templateFor(db, storage, rev.revisionId);
          interactive = schema.interactive;
          fields = schema.fields.length + schema.schedules.reduce((n, s) => n + s.columns.length * s.capacity, 0);
        } catch {
          interactive = null;
        }
      }
      out.push({
        ...t,
        title: (await one<{ title: string }>(db, 'SELECT title FROM controlled_document WHERE number = $1', [t.code]))?.title ?? null,
        revision: rev ? { revisionId: rev.revisionId, revisionLabel: rev.revisionLabel, effectiveFrom: rev.effectiveFrom, fileId: rev.fileId } : null,
        interactive,
        templateFields: fields,
        canPrepare: holdsAny(auth, t.authors),
      });
    }
    return { asOf, types: out };
  });

  app.get('/api/controlled/records', async (req) => {
    requireAuth(req);
    if (!req.auth!.capabilities.has('records.read')) throw forbidden('This action requires the "records.read" authority');
    const q = z
      .object({ entityType: z.string().max(40).optional(), entityId: uuid.optional(), entityIds: z.string().max(3800).optional(), typeCode: z.string().max(12).optional(), status: z.enum(['DRAFT', 'SUBMITTED', 'COMPLETED', 'VOID']).optional() })
      .parse(req.query);
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.entityType) add('c.entity_type = ?', q.entityType);
    if (q.entityId) add('c.entity_id = ?', q.entityId);
    if (q.entityIds) {
      const ids = q.entityIds.split(',').filter((x) => uuid.safeParse(x).success).slice(0, 100);
      add('c.entity_id = ANY(?::uuid[])', ids);
    }
    if (q.typeCode) add('c.type_code = ?', q.typeCode);
    if (q.status) add('c.status = ?', q.status);
    return many(
      db,
      `SELECT c.id, c.number, c.type_code AS "typeCode", c.category, c.title, c.status, c.entity_type AS "entityType", c.entity_id AS "entityId",
              c.entity_label AS "entityLabel", r.revision_label AS "revisionLabel", u.display_name AS "preparedBy", c.created_at AS "createdAt",
              c.completed_at AS "completedAt", c.event_bound AS "eventBound",
              (SELECT x.file_id FROM report_rendition x WHERE x.subject_type = '${SUBJECT}' AND x.subject_id = c.id ORDER BY x.edition DESC LIMIT 1) AS "outputFileId"
         FROM controlled_record c
         JOIN controlled_document_revision r ON r.id = c.revision_id
         JOIN app_user u ON u.id = c.prepared_by
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY c.created_at DESC
        LIMIT 200`,
      params,
    );
  });

  /**
   * The event records of one module record and whether each is ready for its module decision, so the
   * module page can say what stands between the user and the decision.
   */
  app.get('/api/controlled/events/:entityType/:entityId', async (req) => {
    requireAuth(req);
    const auth = req.auth!;
    if (!auth.capabilities.has('records.read')) throw forbidden('This action requires the "records.read" authority');
    const { entityType, entityId } = req.params as { entityType: string; entityId: string };
    if (!uuid.safeParse(entityId).success || !(entityType in ENTITY_ROUTES)) throw notFound('Module record');
    const out = [];
    for (const b of Object.values(EVENT_BINDINGS).filter((x) => x.entity === entityType)) {
      const ready = await decisionReadiness(db, b.code, entityType as ControlledEntity, entityId, auth.userId);
      const last = await one<{ id: string; number: string; status: string; output: string | null }>(
        db,
        `SELECT c.id, c.number, c.status,
                (SELECT x.file_id FROM report_rendition x WHERE x.subject_type = '${SUBJECT}' AND x.subject_id = c.id ORDER BY x.edition DESC LIMIT 1) AS output
           FROM controlled_record c WHERE c.type_code = $1 AND c.entity_type = $2 AND c.entity_id = $3 AND c.event_bound ORDER BY c.created_at DESC LIMIT 1`,
        [b.code, entityType, entityId],
      );
      out.push({ code: b.code, opensWhen: b.opensWhen, decision: b.decision, submitAction: b.submitAction, companion: b.companion, record: last, readiness: ready });
    }
    return out;
  });

  app.post('/api/controlled/records', async (req, reply) => {
    const auth = await requireControlled(db, req, 'controlled.create');
    const body = z.object({ typeCode: z.string().max(12), entityId: uuid.nullable().optional() }).parse(req.body);
    const def = CONTROLLED_TYPE_BY_CODE[body.typeCode];
    if (!def) throw badRequest(`Unknown controlled document type ${body.typeCode}`);
    if (!holdsAny(auth, def.authors)) {
      await audit(db, { actorId: auth.userId, action: 'controlled.create', outcome: 'DENIED', entityType: 'controlled_record', summary: `Denied: preparing ${def.code} requires ${def.authors.join(' or ')}`, requestId: req.id });
      throw forbidden(`Preparing ${def.code} requires the ${def.authors.map((c) => `"${c}"`).join(' or ')} authority`);
    }
    const entityId = def.entity === 'SYSTEM' ? null : (body.entityId ?? null);
    if (def.entity !== 'SYSTEM' && !entityId) throw badRequest(`${def.code} is opened from a ${ENTITY_ROUTES[def.entity].label.toLowerCase()}`);
    const ctx = await entityContext(db, def.entity, entityId, def.code, tz);
    if (!ctx) throw notFound(ENTITY_ROUTES[def.entity].label);
    const asOf = await todayIn(db, tz);
    const base = await revisionInForce(db, def.code, asOf);
    if (!base) throw conflict(`No released revision of ${def.code} is in effect. An administrator imports it in the Document Library first.`);
    const schema = await templateFor(db, storage, base.revisionId);
    if (def.category === 'FORM' && !schema.interactive) {
      throw conflict(`${def.code} Rev ${base.revisionLabel} has no fillable fields (${schema.reason ?? 'not a controlled form'}); import the controlled form PDF`);
    }
    // A form bound to a module event is that event's single record: return the open one, or open it now
    // while the event can still take its decision.
    if (EVENT_BINDINGS[def.code]) {
      const open = await openRecordFor(db, def.code, def.entity, entityId!);
      if (open) return reply.code(200).send({ id: open.id, number: (await loadRecord(db, open.id, tz))!.number, existing: true });
      if (!(await eventStillOpen(db, def.code, entityId!))) {
        throw conflict(`This ${ENTITY_ROUTES[def.entity].label.toLowerCase()} has already been decided; its ${def.code} can no longer be completed in TQM`);
      }
      const opened = await withTransaction(db, (tx) => openEventRecord(tx, def.code, entityId!, { userId: auth.userId, displayName: auth.displayName }, req.id));
      if (!opened) throw conflict(`${def.code} could not be opened on Rev ${base.revisionLabel}`);
      return reply.code(201).send(opened);
    }
    const bindings = await bindingsInForce(db, def, base, schema, asOf);
    const data = def.category === 'FORM' ? fitToTemplate(schema, ctx, { prepared_by: `${auth.displayName} / PDI` }) : { fields: {}, schedules: {} };
    const title = (await one<{ title: string }>(db, 'SELECT title FROM controlled_document WHERE number = $1', [def.code]))!.title;
    const created = await withTransaction(db, async (tx) => {
      const number = await nextRecordNumber(tx, def.code);
      const row = await one<{ id: string }>(
        tx,
        `INSERT INTO controlled_record (number, type_code, category, document_id, revision_id, entity_type, entity_id, entity_label, title, data, prepared_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [number, def.code, def.category, base.documentId, base.revisionId, def.entity, entityId, ctx.label.slice(0, 300), title, JSON.stringify(data), auth.userId],
      );
      for (const b of bindings) {
        await tx.query(
          `INSERT INTO controlled_record_binding (record_id, document_id, revision_id, role, schedule_key)
           SELECT $1, r.document_id, r.id, $3, $4 FROM controlled_document_revision r WHERE r.id = $2`,
          [row!.id, b.revisionId, b.role, b.scheduleKey],
        );
      }
      await audit(tx, {
        actorId: auth.userId,
        action: 'controlled.create',
        entityType: 'controlled_record',
        entityId: row!.id,
        summary: `${number} opened on ${def.code} Rev ${base.revisionLabel} for ${ctx.label}`,
        after: { bindings: bindings.map((b) => `${b.documentNumber} Rev ${b.revisionLabel}`) },
        requestId: req.id,
      });
      return { id: row!.id, number };
    });
    return reply.code(201).send(created);
  });

  app.get('/api/controlled/records/:id', async (req) => {
    const { id } = req.params as { id: string };
    requireAuth(req);
    const auth = req.auth!;
    if (!auth.capabilities.has('records.read')) throw forbidden('This action requires the "records.read" authority');
    if (!uuid.safeParse(id).success) throw notFound('Controlled record');
    const rec = await loadRecord(db, id, tz);
    if (!rec) throw notFound('Controlled record');
    const def = CONTROLLED_TYPE_BY_CODE[rec.type_code]!;
    const [schema, bindings, sigs, files] = await Promise.all([baseSchemaOf(rec), recordBindings(db, id), signatures(db, id), attachments(db, id, tz)]);
    const continuationSchemas: Record<string, { capacity: number; labelColumn: string | null; documentNumber: string; revisionLabel: string }> = {};
    for (const b of bindings) {
      if (b.role === 'BASE' || b.role === 'NARRATIVE') continue;
      const s = await templateFor(db, storage, b.revisionId);
      const key = b.role === 'EVIDENCE' ? EVIDENCE_SCHEDULE : b.scheduleKey!;
      const sched = s.schedules.find((x) => x.key === key);
      const baseCols = new Set(schema.schedules.find((x) => x.key === key)?.columns.map((c) => c.key) ?? []);
      if (sched) continuationSchemas[key] = { capacity: sched.capacity, labelColumn: sched.columns.find((c) => !baseCols.has(c.key))?.key ?? null, documentNumber: b.documentNumber, revisionLabel: b.revisionLabel };
    }
    const bound = rec.event_bound;
    const binding = bound ? (EVENT_BINDINGS[rec.type_code] ?? null) : null;
    const steps = stepsFor(def, schema, bound);
    const current = sigs.filter((s) => s.cycle === rec.cycle);
    const outputs = await many(
      db,
      `SELECT r.id, r.edition, r.file_id AS "fileId", r.sha256, r.page_count AS "pageCount", r.rendered_at AS "renderedAt", v.ok AS "validationOk", v.result AS validation
         FROM report_rendition r LEFT JOIN controlled_output_validation v ON v.rendition_id = r.id
        WHERE r.subject_type = $1 AND r.subject_id = $2 ORDER BY r.edition`,
      [SUBJECT, id],
    );
    const job = rec.status === 'COMPLETED' && def.category === 'FORM' && !outputs.length
      ? await one<{ status: string; last_error: string | null }>(db, `SELECT status, last_error FROM job WHERE idempotency_key = $1`, [`controlled_render:${id}:1`])
      : null;
    // An open event record shows the module's current facts (locked) with the entries made on the form.
    const live = bound && rec.status === 'DRAFT' ? await eventProblems(db, rec, schema) : null;
    const derived = live?.derived ?? (bound && rec.entity_id ? await derivedFor(db, rec, schema) : null);
    const data = live?.merged ?? rec.data;
    const composed = def.category === 'FORM' ? composeData(schema, { ...rec, data }, files, sigs, rec.submitted_on, bound ? decisionBlock(rec.type_code) : 'approver1') : null;
    const isAuthor = holdsAny(auth, def.authors);
    const old = superseded(rec);
    const signable = rec.status === 'SUBMITTED' && !old ? nextSteps(def, steps, current).filter((s) => s.mode === 'INTERNAL' && holdsAny(auth, s.capabilities) && independent(rec, current, auth.userId)) : [];
    const readiness = binding?.decision && rec.entity_id && rec.status === 'SUBMITTED' ? await decisionReadiness(db, rec.type_code, binding.entity, rec.entity_id, auth.userId) : null;
    const route = derived?.route ?? ENTITY_ROUTES[rec.entity_type as keyof typeof ENTITY_ROUTES]?.route(rec.entity_id ?? '') ?? null;
    return {
      id: rec.id,
      number: rec.number,
      typeCode: rec.type_code,
      category: rec.category,
      title: rec.title,
      status: rec.status,
      entity: { type: rec.entity_type, id: rec.entity_id, label: rec.entity_label, route },
      module: { name: def.module, route: def.moduleRoute },
      rationale: def.rationale,
      eventBound: bound,
      binding,
      superseded: old ? SUPERSEDED(rec) : null,
      readiness,
      locked: derived && rec.status === 'DRAFT' ? lockedPaths(schema, derived) : [],
      ownedSchedules: derived?.owned ?? [],
      recordRevision: rec.record_revision,
      cycle: rec.cycle,
      version: rec.version,
      preparedBy: rec.prepared_by_name,
      createdAt: rec.created_at,
      submittedBy: rec.submitted_by_name,
      submittedAt: rec.submitted_at,
      completedAt: rec.completed_at,
      voidReason: rec.void_reason,
      bindings,
      schema,
      continuations: continuationSchemas,
      narrative: bindings.some((b) => b.role === 'NARRATIVE'),
      data,
      composed,
      attachments: files,
      steps: steps.map((s) => ({ ...s, signature: current.find((x) => x.role_key === s.key) ?? null })),
      history: sigs.filter((s) => s.cycle !== rec.cycle),
      outputs,
      renderJob: job,
      problems: def.category === 'FORM' && rec.status === 'DRAFT' ? (live?.problems ?? completionProblems(schema, rec.data)) : [],
      can: {
        edit: rec.status === 'DRAFT' && isAuthor && !old,
        submit: rec.status === 'DRAFT' && isAuthor && !old && !binding?.submitAction,
        void: rec.status === 'DRAFT' && isAuthor && !bound,
        sign: signable.map((s) => s.key),
        attest: rec.status === 'SUBMITTED' && def.category === 'ATTACHMENT' && isAuthor ? steps.filter((s) => s.mode === 'EXTERNAL' && !current.some((x) => x.role_key === s.key)).map((s) => s.key) : [],
        return: rec.status === 'SUBMITTED' && !binding?.submitAction && (rec.submitted_by === auth.userId || steps.some((s) => holdsAny(auth, s.capabilities))),
      },
    };
  });

  app.patch('/api/controlled/records/:id', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireControlled(db, req, 'controlled.save', id);
    if (!uuid.safeParse(id).success) throw notFound('Controlled record');
    const body = z.object({ expectedVersion: version, data: dataSchema }).parse(req.body);
    return withTransaction(db, async (tx) => {
      const rec = await loadRecord(tx, id, tz, { lock: true });
      if (!rec) throw notFound('Controlled record');
      const def = CONTROLLED_TYPE_BY_CODE[rec.type_code]!;
      if (!holdsAny(auth, def.authors)) await deny(db, req, auth, 'controlled.save', id, `Editing ${def.code} requires ${def.authors.join(' or ')}`);
      if (rec.category !== 'FORM') throw conflict('This record is an attached document; add files instead');
      if (superseded(rec)) throw conflict(SUPERSEDED(rec));
      if (rec.status !== 'DRAFT') throw conflict(`The record is ${rec.status.toLowerCase()}; return it to draft before editing`);
      if (rec.version !== body.expectedVersion) throw conflict('The record was changed by someone else; reload to see the latest');
      const schema = await templateFor(tx, storage, rec.revision_id);
      let data = sanitizeData(schema, body.data);
      let check = data;
      if (rec.event_bound) {
        // Facts the module holds are entered in the module; only what the form adds is stored here.
        const derived = await derivedFor(tx, rec, schema);
        data = enteredOnly(schema, derived, data);
        check = mergeDerived(schema, derived, data);
      }
      const problems = valueProblems(schema, check);
      if (problems.length) throw unprocessable('Some entries are not valid', problems);
      await tx.query(`UPDATE controlled_record SET data = $2, version = version + 1, updated_at = now() WHERE id = $1`, [id, JSON.stringify(data)]);
      await audit(tx, { actorId: auth.userId, action: 'controlled.save', entityType: 'controlled_record', entityId: id, summary: `${rec.number} draft saved`, requestId: req.id });
      return { version: rec.version + 1, problems: completionProblems(schema, check) };
    });
  });

  app.post('/api/controlled/records/:id/submit', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireControlled(db, req, 'controlled.submit', id);
    if (!uuid.safeParse(id).success) throw notFound('Controlled record');
    const body = z.object({ expectedVersion: version }).parse(req.body);
    const rec = await loadRecord(db, id, tz);
    if (!rec) throw notFound('Controlled record');
    const def = CONTROLLED_TYPE_BY_CODE[rec.type_code]!;
    if (!holdsAny(auth, def.authors)) await deny(db, req, auth, 'controlled.submit', id, `Submitting ${def.code} requires ${def.authors.join(' or ')}`);
    if (superseded(rec)) throw conflict(SUPERSEDED(rec));
    if (rec.status !== 'DRAFT') throw conflict(`The record is already ${rec.status.toLowerCase()}`);
    if (rec.version !== body.expectedVersion) throw conflict('The record was changed by someone else; reload to see the latest');
    if (rec.event_bound) {
      const binding = EVENT_BINDINGS[rec.type_code]!;
      if (binding.submitAction) throw conflict(`${rec.number} is submitted when you ${binding.submitAction.label.toLowerCase()} in the ${binding.decision?.module ?? 'module'}`);
      const out = await withTransaction(db, (tx) => submitEventRecord(tx, id, { userId: auth.userId, displayName: auth.displayName }, req.id, body.expectedVersion));
      return { version: out.version, status: 'SUBMITTED' };
    }
    const files = await attachments(db, id, tz);
    let dataHash: string;
    if (rec.category === 'FORM') {
      const schema = await baseSchemaOf(rec);
      const problems = completionProblems(schema, rec.data);
      if (problems.length) throw unprocessable(`${problems.length} item(s) must be completed before submission`, problems);
      const today = await todayIn(db, tz);
      const preview = composeData(schema, rec, files, [], today);
      const layout = await layoutProblem(svc, { kind: 'CONTROLLED_FORM', schemaVersion: 1, docCode: rec.type_code, number: rec.number, title: rec.title, recordRevision: rec.record_revision, cycle: rec.cycle, preparedBy: rec.prepared_by_name, completedDate: today, bindings: await recordBindings(db, id), data: preview });
      if (layout) throw unprocessable(layout, [{ path: 'layout', message: layout }]);
      dataHash = sha256(canonicalJson({ data: rec.data, files: files.map((f) => f.sha256) }));
    } else {
      if (!files.length) throw unprocessable('Attach the completed or executed document before submitting it for signatures', [{ path: 'attachments', message: 'No document attached' }]);
      dataHash = sha256(canonicalJson(files.map((f) => f.sha256)));
    }
    return withTransaction(db, async (tx) => {
      const res = await tx.query(
        `UPDATE controlled_record SET status = 'SUBMITTED', submitted_by = $2, submitted_at = now(), data_sha256 = $3, version = version + 1, updated_at = now()
          WHERE id = $1 AND status = 'DRAFT' AND version = $4`,
        [id, auth.userId, dataHash, body.expectedVersion],
      );
      if (!res.rowCount) throw conflict('The record was changed by someone else; reload to see the latest');
      await audit(tx, { actorId: auth.userId, action: 'controlled.submit', entityType: 'controlled_record', entityId: id, summary: `${rec.number} submitted for ${rec.category === 'FORM' ? 'approval' : 'signatures'}`, after: { dataSha256: dataHash }, requestId: req.id });
      return { version: rec.version + 1, status: 'SUBMITTED' };
    });
  });

  app.post('/api/controlled/records/:id/sign', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireControlled(db, req, 'controlled.sign', id);
    if (!uuid.safeParse(id).success) throw notFound('Controlled record');
    const body = z
      .object({
        expectedVersion: version,
        step: z.string().max(40),
        decision: z.string().max(80).optional(),
        conditions: z.string().trim().max(MAX_TEXT).optional(),
        details: z.record(z.string().max(200)).optional(),
        secondApproval: z.enum(['REQUIRED', 'NOT_REQUIRED']).optional(),
        statement: z.string().trim().max(2000).optional(),
      })
      .parse(req.body);
    const pre = await loadRecord(db, id, tz);
    if (!pre) throw notFound('Controlled record');
    const def = CONTROLLED_TYPE_BY_CODE[pre.type_code]!;
    const schema = await baseSchemaOf(pre);
    const steps = stepsFor(def, schema, pre.event_bound);
    const step = steps.find((s) => s.key === body.step);
    if (!step || step.mode !== 'INTERNAL') throw badRequest('Unknown approval step');
    if (!holdsAny(auth, step.capabilities)) await deny(db, req, auth, 'controlled.sign', id, `${step.label} requires ${step.capabilities.join(' or ')}`);
    if (superseded(pre)) throw conflict(SUPERSEDED(pre));
    // One approval path: the module decision signs its own block; it is never signed a second time here.
    if (step.module) {
      await audit(db, { actorId: auth.userId, action: 'controlled.sign', outcome: 'DENIED', entityType: 'controlled_record', entityId: id, summary: `Refused: ${step.label} is signed by ${step.module.action}`, requestId: req.id });
      throw conflict(`${step.label} is signed when you ${step.module.label.toLowerCase()} on the ${step.module.module}; it is not signed separately`);
    }
    const decisionField = schema.fields.find((f) => f.key === 'pdi_decision');
    if (step.decides) {
      if (!body.decision || !decisionField?.options?.includes(body.decision) || /^return$/i.test(body.decision)) {
        throw unprocessable(`Choose the PDI decision (${(decisionField?.options ?? []).filter((o) => !/^return$/i.test(o)).join(', ')}); use Return to send the record back`);
      }
      if (schema.fields.some((f) => f.key === 'decision_conditions') && !body.conditions) throw unprocessable('State the decision basis, blocking issues and any authorized restrictions');
      for (const [k, v] of Object.entries(body.details ?? {})) {
        const f = schema.fields.find((x) => x.key === k && x.role === 'DECISION');
        if (!f) throw badRequest(`${k} is not a decision field of this form`);
        if (v && f.input === 'date' && !isRealDate(v)) throw unprocessable(`${f.label}: use a real date in YYYY-MM-DD form`);
      }
    }
    const result = await withTransaction(db, async (tx) => {
      const rec = (await loadRecord(tx, id, tz, { lock: true }))!;
      if (rec.status !== 'SUBMITTED') throw conflict(`The record is ${rec.status.toLowerCase()}, not awaiting approval`);
      if (rec.version !== body.expectedVersion) throw conflict('The record was changed by someone else; reload to see the latest');
      // Authority is re-checked inside the transaction that records the decision.
      const stillHeld = (await Promise.all(step.capabilities.map((c) => recheckCapability(tx, auth.userId, c)))).some(Boolean);
      if (!stillHeld) throw forbidden(`${step.label} requires ${step.capabilities.join(' or ')}`);
      const current = (await signatures(tx, id)).filter((s) => s.cycle === rec.cycle);
      if (!nextSteps(def, steps, current).some((s) => s.key === step.key)) throw conflict(current.some((s) => s.role_key === step.key) ? `${step.label} is already signed` : 'The deciding approval is signed first');
      if (!independent(rec, current, auth.userId)) throw forbidden('Approval must be independent: the preparer, the submitter and another approver of this record cannot sign (POL-01)');
      await assertDerivedUnchanged(tx, rec, schema);
      const today = await todayIn(tx, tz);
      const details = Object.fromEntries(Object.entries(body.details ?? {}).filter(([, v]) => v));
      await tx.query(
        `INSERT INTO controlled_record_signature (record_id, cycle, role_key, role_label, mode, signer_id, signer_name, signed_on, decision, statement, details, data_sha256, grants_used)
         VALUES ($1,$2,$3,$4,'INTERNAL',$5,$6,$7,$8,$9,$10,$11,$12)`,
        [id, rec.cycle, step.key, step.label, auth.userId, auth.displayName, today, step.decides ? body.decision : null, step.decides ? body.conditions : (body.statement ?? null), JSON.stringify(step.decides ? details : {}), rec.data_sha256, step.capabilities.filter((c) => auth.capabilities.has(c))],
      );
      if (step.decides && body.secondApproval === 'NOT_REQUIRED') {
        const optional = steps.find((s) => s.optional && s.key !== step.key);
        if (optional) {
          await tx.query(
            `INSERT INTO controlled_record_signature (record_id, cycle, role_key, role_label, mode, signer_id, signer_name, signed_on, statement, data_sha256)
             VALUES ($1,$2,$3,$4,'NOT_REQUIRED',$5,$6,$7,$8,$9)`,
            [id, rec.cycle, optional.key, optional.label, auth.userId, auth.displayName, today, `${optional.label} not required (decided by ${auth.displayName})`, rec.data_sha256],
          );
        }
      }
      const after = (await signatures(tx, id)).filter((s) => s.cycle === rec.cycle);
      const done = complete(steps, after);
      await tx.query(`UPDATE controlled_record SET version = version + 1, updated_at = now() ${done ? `, status = 'COMPLETED', completed_at = now()` : ''} WHERE id = $1`, [id]);
      await audit(tx, {
        actorId: auth.userId,
        action: 'controlled.sign',
        entityType: 'controlled_record',
        entityId: id,
        summary: `${rec.number}: ${step.label} signed by ${auth.displayName}${step.decides ? ` — decision ${body.decision}` : ''}${done ? '; record completed' : ''}`,
        after: { step: step.key, dataSha256: rec.data_sha256 },
        requestId: req.id,
      });
      if (done && rec.category === 'FORM') {
        await freezeAndQueue(tx, rec, schema, after, today);
        await applyFormDecision(tx, rec, after.find((s) => s.decision)?.decision ?? null, { userId: auth.userId, displayName: auth.displayName }, req.id);
      }
      return { completed: done, version: rec.version + 1 };
    });
    return result;
  });

  /** Category B: records an external signatory exactly as shown on the executed document. */
  app.post('/api/controlled/records/:id/attest', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireControlled(db, req, 'controlled.attest', id);
    if (!uuid.safeParse(id).success) throw notFound('Controlled record');
    const body = z
      .object({ expectedVersion: version, role: z.string().max(40), signerName: z.string().trim().min(2).max(120), signerTitle: z.string().trim().max(120).optional(), signedOn: z.string().refine(isRealDate, 'Use a real date in YYYY-MM-DD form'), reference: z.string().trim().max(200).optional() })
      .parse(req.body);
    const pre = await loadRecord(db, id, tz);
    if (!pre) throw notFound('Controlled record');
    const def = CONTROLLED_TYPE_BY_CODE[pre.type_code]!;
    if (!holdsAny(auth, def.authors)) await deny(db, req, auth, 'controlled.attest', id, `Recording ${def.code} signatures requires ${def.authors.join(' or ')}`);
    const steps = stepsFor(def, null);
    const step = steps.find((s) => s.key === body.role && s.mode === 'EXTERNAL');
    if (!step) throw badRequest('Unknown external signature for this document type');
    return withTransaction(db, async (tx) => {
      const rec = (await loadRecord(tx, id, tz, { lock: true }))!;
      if (rec.status !== 'SUBMITTED') throw conflict(`The record is ${rec.status.toLowerCase()}, not awaiting signatures`);
      if (rec.version !== body.expectedVersion) throw conflict('The record was changed by someone else; reload to see the latest');
      const today = await todayIn(tx, tz);
      if (body.signedOn > today) throw unprocessable('A signature date cannot be in the future');
      const current = (await signatures(tx, id)).filter((s) => s.cycle === rec.cycle);
      if (current.some((s) => s.role_key === step.key)) throw conflict(`${step.label} is already recorded`);
      await tx.query(
        `INSERT INTO controlled_record_signature (record_id, cycle, role_key, role_label, mode, signer_id, signer_name, signer_title, signed_on, reference, statement, data_sha256)
         VALUES ($1,$2,$3,$4,'EXTERNAL',$5,$6,$7,$8,$9,$10,$11)`,
        [id, rec.cycle, step.key, step.label, auth.userId, body.signerName, body.signerTitle ?? null, body.signedOn, body.reference ?? null, `Attested by ${auth.displayName} from the attached document`, rec.data_sha256],
      );
      const done = complete(steps, [...current, { role_key: step.key } as SignatureRow]);
      await tx.query(`UPDATE controlled_record SET version = version + 1, updated_at = now() ${done ? `, status = 'COMPLETED', completed_at = now()` : ''} WHERE id = $1`, [id]);
      await audit(tx, { actorId: auth.userId, action: 'controlled.attest', entityType: 'controlled_record', entityId: id, summary: `${rec.number}: ${step.label} recorded as ${body.signerName} on ${body.signedOn}${done ? '; record completed' : ''}`, requestId: req.id });
      return { completed: done, version: rec.version + 1 };
    });
  });

  app.post('/api/controlled/records/:id/return', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireControlled(db, req, 'controlled.return', id);
    if (!uuid.safeParse(id).success) throw notFound('Controlled record');
    const body = z.object({ expectedVersion: version, reason: z.string().trim().min(5).max(2000) }).parse(req.body);
    const pre = await loadRecord(db, id, tz);
    if (!pre) throw notFound('Controlled record');
    const def = CONTROLLED_TYPE_BY_CODE[pre.type_code]!;
    const steps = stepsFor(def, def.category === 'FORM' ? await baseSchemaOf(pre) : null, pre.event_bound);
    if (pre.submitted_by !== auth.userId && !steps.some((s) => holdsAny(auth, s.capabilities))) await deny(db, req, auth, 'controlled.return', id, 'Only the submitter or an approver can return the record');
    const submitAction = pre.event_bound ? EVENT_BINDINGS[pre.type_code]?.submitAction : null;
    if (submitAction) throw conflict(`${pre.number} returns to draft with the ${EVENT_BINDINGS[pre.type_code]!.decision!.module} (return it for correction there)`);
    return withTransaction(db, async (tx) => {
      const rec = (await loadRecord(tx, id, tz, { lock: true }))!;
      if (rec.status !== 'SUBMITTED') throw conflict(`The record is ${rec.status.toLowerCase()}, not awaiting approval`);
      if (rec.version !== body.expectedVersion) throw conflict('The record was changed by someone else; reload to see the latest');
      await tx.query(`UPDATE controlled_record SET status = 'DRAFT', cycle = cycle + 1, version = version + 1, updated_at = now() WHERE id = $1`, [id]);
      await audit(tx, { actorId: auth.userId, action: 'controlled.return', entityType: 'controlled_record', entityId: id, summary: `${rec.number} returned to draft`, reason: body.reason, requestId: req.id });
      return { version: rec.version + 1, status: 'DRAFT' };
    });
  });

  app.post('/api/controlled/records/:id/void', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireControlled(db, req, 'controlled.void', id);
    if (!uuid.safeParse(id).success) throw notFound('Controlled record');
    const body = z.object({ expectedVersion: version, reason: z.string().trim().min(5).max(2000) }).parse(req.body);
    const pre = await loadRecord(db, id, tz);
    if (!pre) throw notFound('Controlled record');
    const def = CONTROLLED_TYPE_BY_CODE[pre.type_code]!;
    if (!holdsAny(auth, def.authors)) await deny(db, req, auth, 'controlled.void', id, `Voiding ${def.code} requires ${def.authors.join(' or ')}`);
    // The event's own record is voided only with its event (cancelled, withdrawn); otherwise the event would lose its approval path.
    if (pre.event_bound) throw conflict(`${pre.number} belongs to its ${ENTITY_ROUTES[pre.entity_type as ControlledEntity]?.label.toLowerCase() ?? 'module record'} and is voided only if that is cancelled or withdrawn`);
    return withTransaction(db, async (tx) => {
      const rec = (await loadRecord(tx, id, tz, { lock: true }))!;
      if (rec.status !== 'DRAFT') throw conflict('Only a draft can be voided');
      if (rec.version !== body.expectedVersion) throw conflict('The record was changed by someone else; reload to see the latest');
      await tx.query(`UPDATE controlled_record SET status = 'VOID', voided_by = $2, voided_at = now(), void_reason = $3, version = version + 1, updated_at = now() WHERE id = $1`, [id, auth.userId, body.reason]);
      await audit(tx, { actorId: auth.userId, action: 'controlled.void', entityType: 'controlled_record', entityId: id, summary: `${rec.number} voided`, reason: body.reason, requestId: req.id });
      return { status: 'VOID' };
    });
  });

  app.post('/api/controlled/records/:id/attachments', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = await requireControlled(db, req, 'controlled.attach', id);
    if (!uuid.safeParse(id).success) throw notFound('Controlled record');
    const pre = await loadRecord(db, id, tz);
    if (!pre) throw notFound('Controlled record');
    const def = CONTROLLED_TYPE_BY_CODE[pre.type_code]!;
    if (!holdsAny(auth, def.authors)) await deny(db, req, auth, 'controlled.attach', id, `Adding files to ${def.code} requires ${def.authors.join(' or ')}`);
    if (superseded(pre)) throw conflict(SUPERSEDED(pre));
    if (pre.status !== 'DRAFT') throw conflict('Files can be added only while the record is a draft');
    const caption = z.string().trim().max(300).optional().parse((req.query as { caption?: string }).caption);
    const health = await storage.check();
    if (!health.ok) throw new AppError(503, 'STORAGE_UNAVAILABLE', 'Evidence storage is unavailable; the file was not saved.');
    const part = await req.file({ limits: { fileSize: config.maxDocumentBytes + 1, files: 1 } });
    if (!part) throw badRequest('No file was uploaded');
    const name = sanitizeFilename(part.filename);
    let staged;
    try {
      staged = await storage.stage(part.file, config.maxDocumentBytes);
    } catch (err) {
      if (err instanceof FileTooLargeError) throw new AppError(413, 'FILE_TOO_LARGE', err.message);
      throw err;
    }
    const bytes = await readFile(staged.stagingPath);
    const check = validateDocument(bytes);
    if (!check.ok) {
      await storage.discard(staged);
      await audit(db, { actorId: auth.userId, action: 'controlled.attach', outcome: 'FAILED', entityType: 'controlled_record', entityId: id, summary: `Upload rejected: ${check.reason}`, requestId: req.id });
      throw unprocessable(check.reason);
    }
    const conformance = pre.category === 'ATTACHMENT' ? await templateConformance(bytes, check.mime, await baseSchemaOf(pre), pre) : null;
    const storageKey = await storage.finalize(staged);
    try {
      const result = await withTransaction(db, async (tx) => {
        const rec = (await loadRecord(tx, id, tz, { lock: true }))!;
        if (rec.status !== 'DRAFT') throw conflict('The record was submitted while the file uploaded');
        const file = await one<{ id: string }>(
          tx,
          `INSERT INTO file_object (kind, status, sha256, byte_size, mime_type, original_name, storage_key, width, height, uploaded_by)
           VALUES ('DOCUMENT','AVAILABLE',$1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [staged.sha256, staged.size, check.mime, name, storageKey, check.width ?? null, check.height ?? null, auth.userId],
        );
        const link = await one<{ id: string }>(tx, `INSERT INTO evidence_link (file_id, entity_type, entity_id, caption, linked_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [file!.id, SUBJECT, id, caption || null, auth.userId]);
        if (conformance) await tx.query(`INSERT INTO controlled_attachment_check (link_id, template_revision_id, conforms, detail) VALUES ($1,$2,$3,$4)`, [link!.id, rec.revision_id, conformance.conforms, conformance.detail]);
        await tx.query(`UPDATE controlled_record SET version = version + 1, updated_at = now() WHERE id = $1`, [id]);
        await audit(tx, { actorId: auth.userId, action: 'controlled.attach', entityType: 'controlled_record', entityId: id, summary: `${name} attached to ${rec.number}`, after: { fileId: file!.id, sha256: staged.sha256, conformance }, requestId: req.id });
        return { linkId: link!.id, fileId: file!.id, sha256: staged.sha256, name, conformance, version: rec.version + 1 };
      });
      return reply.code(201).send(result);
    } catch (err) {
      await storage.removeOrphan(storageKey);
      throw err;
    }
  });

  app.delete('/api/controlled/records/:id/attachments/:linkId', async (req) => {
    const { id, linkId } = req.params as { id: string; linkId: string };
    const auth = await requireControlled(db, req, 'controlled.detach', id);
    if (!uuid.safeParse(id).success || !uuid.safeParse(linkId).success) throw notFound('Attachment');
    const pre = await loadRecord(db, id, tz);
    if (!pre) throw notFound('Controlled record');
    const def = CONTROLLED_TYPE_BY_CODE[pre.type_code]!;
    if (!holdsAny(auth, def.authors)) await deny(db, req, auth, 'controlled.detach', id, `Removing files from ${def.code} requires ${def.authors.join(' or ')}`);
    return withTransaction(db, async (tx) => {
      const rec = (await loadRecord(tx, id, tz, { lock: true }))!;
      if (rec.status !== 'DRAFT') throw conflict('Files can be removed only while the record is a draft');
      const res = await tx.query(
        `UPDATE evidence_link SET unlinked_at = now(), unlinked_by = $3, unlink_reason = 'Removed before submission' WHERE id = $1 AND entity_type = $4 AND entity_id = $2 AND unlinked_at IS NULL`,
        [linkId, id, auth.userId, SUBJECT],
      );
      if (!res.rowCount) throw notFound('Attachment');
      await tx.query(`UPDATE controlled_record SET version = version + 1, updated_at = now() WHERE id = $1`, [id]);
      await audit(tx, { actorId: auth.userId, action: 'controlled.detach', entityType: 'controlled_record', entityId: id, summary: `Attachment removed from ${rec.number} (file retained)`, requestId: req.id });
      return { version: rec.version + 1 };
    });
  });

}

/**
 * Steps that may be signed on the record now. On an event record the module decision signs its block,
 * so only the concurrence blocks are signed here (in any order, before that decision). Otherwise the
 * deciding approval comes first, then the others in any order.
 */
function nextSteps(def: ControlledTypeDef, steps: Step[], current: Array<Pick<SignatureRow, 'role_key'>>): Step[] {
  const pending = steps.filter((s) => !current.some((x) => x.role_key === s.key));
  if (steps.some((s) => s.module)) return pending.filter((s) => !s.module);
  if (def.category === 'FORM') {
    const decider = steps.find((s) => s.decides);
    if (decider && pending.includes(decider)) return [decider];
  }
  return pending;
}

function complete(steps: Step[], current: Array<Pick<SignatureRow, 'role_key'>>): boolean {
  return steps.every((s) => current.some((x) => x.role_key === s.key));
}

/** Whether an attached PDF is the bound template revision filled in (same field tree), or another format. */
async function templateConformance(bytes: Buffer, mime: string, schema: TemplateSchema, rec: Pick<RecordRow, 'type_code'>): Promise<{ conforms: boolean; detail: string }> {
  if (mime !== 'application/pdf') return { conforms: false, detail: 'Image or scan: not checkable against the template' };
  if (!schema.interactive) return { conforms: false, detail: `${rec.type_code} template has no field tree to compare` };
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
    const names = new Set(doc.getForm().getFields().map((f) => f.getName()));
    const expected = [...schema.fields.map((f) => f.name), ...schema.schedules.flatMap((s) => s.columns.flatMap((c) => Array.from({ length: s.capacity }, (_, i) => `${schema.prefix}__${s.key}__r${String(i + 1).padStart(2, '0')}__${c.key}`)))];
    const present = expected.filter((n) => names.has(n)).length;
    if (present === expected.length) return { conforms: true, detail: `Completed on the bound ${rec.type_code} template (${expected.length} fields match)` };
    return { conforms: false, detail: present ? `Partly matches the bound template (${present} of ${expected.length} fields)` : 'Not on the controlled template (executed or external format)' };
  } catch {
    return { conforms: false, detail: 'PDF could not be read for a template check' };
  }
}
