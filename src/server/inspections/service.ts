import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import {
  type FormDefinition,
  type ResponseStatus,
  allowedStatuses,
  canonicalJson,
  formDefinitionSchema,
  isPassAllEligible,
  readingLimitRef,
  sectionRows,
} from '../../shared/forms.js';
import { evaluateInspection, passAllTargets, readingId, rowId, summarizeReviewReasons } from '../../shared/inspection.js';
import { parseReading } from '../../shared/measurement.js';
import { audit } from '../audit.js';
import { type AuthContext, recheckCapability, requireCapability } from '../auth.js';
import type { Config } from '../config.js';
import { type Db, type DbClient, many, one, withTransaction } from '../db.js';
import { badRequest, conflict, forbidden, unprocessable } from '../errors.js';
import { enqueueJob } from '../jobs.js';
import { nextRecordNumber } from '../numbering.js';
import { dayIn } from '../../shared/quality.js';
import { assertConcessionCovers } from '../quality/ncr.js';
import { effectiveSourceStatuses } from '../sourcing/status.js';
import { buildReportSnapshot, snapshotHash } from './report-snapshot.js';
import { type BaselineSnapshot, type LoadedInspection, loadInspection } from './state.js';

export interface EntryChange {
  unitIndex: number;
  sectionKey: string;
  rowKey: string;
  status?: ResponseStatus | null;
  note?: string | null;
  readings?: Record<string, string | null>;
}

export interface UnitChange {
  unitIndex: number;
  serialNumber?: string | null;
  dispositionNote?: string | null;
}

const MAX_NOTE = 2000;

export async function createInspection(
  db: Db,
  req: FastifyRequest,
  input: {
    partId: string;
    /** A released catalogue revision, or omitted when `oneOff` builds a governed one-off form (FR-042). */
    formRevisionId?: string;
    oneOff?: { definition: FormDefinition; reason: string };
    unitCount: number;
    poNumber?: string | null;
    dateReceived: string;
    inspectorId?: string | null;
    sourceId?: string | null;
    lotNumber?: string | null;
    lotSize?: number | null;
    samplingNote?: string | null;
    /** Runs inside the creating transaction, so related records commit or roll back with the inspection. */
    afterCreate?: (tx: DbClient, created: { id: string; number: string; userId: string; formRevisionId: string }) => Promise<void>;
    /**
     * Starting from bench results (owner decision: administrators): the creator needs this capability
     * instead of inspection.perform and may name the inspector, who must hold inspection.perform.
     */
    creatorCapability?: 'injector.bench_sync';
  },
): Promise<{ id: string; number: string }> {
  const auth = await requireCapability(db, req, input.creatorCapability ?? 'inspection.perform', { action: 'inspection.create', consequential: false });
  const inspectorId = input.inspectorId ?? auth.userId;
  if (input.creatorCapability) {
    if (!(await recheckCapability(db, inspectorId, 'inspection.perform'))) {
      throw unprocessable(inspectorId === auth.userId ? 'You are not authorized to perform inspections; choose an inspector' : 'The selected inspector is not authorized to perform inspections');
    }
  } else if (inspectorId !== auth.userId) {
    await requireCapability(db, req, 'inspection.assign', { action: 'inspection.assign', entityType: 'user', entityId: inspectorId });
    if (!(await recheckCapability(db, inspectorId, 'inspection.perform'))) {
      throw unprocessable('The selected inspector is not authorized to perform inspections');
    }
  }
  const today = new Date();
  if (new Date(`${input.dateReceived}T00:00:00Z`).getTime() > today.getTime() + 36 * 3600 * 1000) {
    throw unprocessable('Date received cannot be in the future');
  }

  return withTransaction(db, async (tx) => {
    const part = await one<{ id: string; part_number: string; description: string; active: boolean }>(
      tx,
      'SELECT id, part_number, description, active FROM company_part WHERE id = $1',
      [input.partId],
    );
    if (!part || !part.active) throw unprocessable('Part not found or inactive');

    let formRevisionId = input.formRevisionId ?? null;
    if (input.oneOff) {
      // One-off forms are stored as immutable ONE_OFF revisions of the Miscellaneous form; they never become a released template.
      const misc = await one<{ id: string }>(tx, `SELECT id FROM inspection_form WHERE form_number = 'PDI-IQI-MISC' FOR UPDATE`);
      if (!misc) throw unprocessable('The Miscellaneous form is not loaded');
      const definition = formDefinitionSchema.parse({ ...input.oneOff.definition, formNumber: 'PDI-IQI-MISC', oneOff: true });
      const seq = (await one<{ n: number }>(tx, 'SELECT coalesce(max(sequence), 0)::int + 1 AS n FROM form_revision WHERE form_id = $1', [misc.id]))!.n;
      const label = `ONE-OFF ${seq}`;
      const def = JSON.parse(JSON.stringify({ ...definition, revisionLabel: label })) as FormDefinition;
      const created = await one<{ id: string }>(
        tx,
        `INSERT INTO form_revision (form_id, sequence, revision_label, status, definition, definition_sha256, provenance, change_summary, created_by)
         VALUES ($1, $2, $3, 'ONE_OFF', $4, $5, $6, $7, $8) RETURNING id`,
        [misc.id, seq, label, JSON.stringify(def), createHash('sha256').update(canonicalJson(def)).digest('hex'), `One-off form built by inspector for ${part.part_number}`, input.oneOff.reason, auth.userId],
      );
      formRevisionId = created!.id;
    }
    if (!formRevisionId) throw unprocessable('Choose an inspection form');
    const form = await one<{ id: string; status: string; definition: FormDefinition; definition_sha256: string }>(
      tx,
      'SELECT id, status, definition, definition_sha256 FROM form_revision WHERE id = $1 FOR SHARE',
      [formRevisionId],
    );
    if (!form) throw unprocessable('Inspection form not found');
    if (form.status === 'ONE_OFF' ? !input.oneOff : form.status !== 'RELEASED') throw unprocessable('Only the currently released form revision can start new inspections');

    let source: { id: string; supplier_id: string; site_id: string; approval_state: string; baseline_revision_id: string | null } | null = null;
    if (input.sourceId) {
      source = await one(tx, 'SELECT id, supplier_id, site_id, approval_state, baseline_revision_id FROM source WHERE id = $1 AND part_id = $2', [
        input.sourceId,
        part.id,
      ]);
      if (!source) throw unprocessable('The selected source does not belong to this part');
      // Record the effective status (restrictions/expiry overlaid) at receipt; another site's approval never carries over.
      source.approval_state = (await effectiveSourceStatuses(tx, [source.id])).get(source.id)!.status;
    }

    const baseline = await resolveBaseline(tx, part.id, source?.baseline_revision_id ?? null, Boolean(source));
    const number = await nextRecordNumber(tx, 'IR');
    const created = await one<{ id: string }>(
      tx,
      `INSERT INTO inspection (number, form_revision_id, form_snapshot, form_snapshot_sha256, baseline_revision_id, baseline_snapshot,
          part_id, part_number, part_description, source_id, supplier_id, site_id, source_state_at_start, po_number, date_received,
          lot_number, lot_size, sampling_note, unit_count, inspector_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id`,
      [
        number,
        form.id,
        JSON.stringify(form.definition),
        form.definition_sha256,
        baseline?.revisionId ?? null,
        baseline ? JSON.stringify(baseline) : null,
        part.id,
        part.part_number,
        part.description,
        source?.id ?? null,
        source?.supplier_id ?? null,
        source?.site_id ?? null,
        source ? source.approval_state : 'NO_SOURCE',
        input.poNumber?.trim() || null,
        input.dateReceived,
        input.lotNumber?.trim() || null,
        input.lotSize ?? null,
        input.samplingNote?.trim() || null,
        input.unitCount,
        inspectorId,
        auth.userId,
      ],
    );
    const id = created!.id;
    await tx.query(
      `INSERT INTO inspection_unit (inspection_id, unit_index) SELECT $1, g FROM generate_series(1, $2) g`,
      [id, input.unitCount],
    );
    if (inspectorId !== auth.userId) {
      await tx.query(
        `INSERT INTO work_item (kind, title, subject_type, subject_id, assignee_id) VALUES ('INSPECTION_ASSIGNED', $1, 'INSPECTION', $2, $3)`,
        [`Inspect ${part.part_number} (${number})`, id, inspectorId],
      );
    }
    await audit(tx, {
      actorId: auth.userId,
      action: 'inspection.create',
      entityType: 'inspection',
      entityId: id,
      summary: `Started ${number} for ${part.part_number} using ${form.definition.formNumber}${form.definition.revisionLabel ? ` Rev ${form.definition.revisionLabel}` : ''}`,
      after: { unitCount: input.unitCount, poNumber: input.poNumber ?? null, sourceId: source?.id ?? null, baselineRevisionId: baseline?.revisionId ?? null },
      requestId: req.id,
    });
    await input.afterCreate?.(tx, { id, number, userId: auth.userId, formRevisionId });
    return { id, number };
  });
}

export async function resolveBaseline(tx: DbClient, partId: string, sourceBaselineId: string | null, hasSource: boolean): Promise<BaselineSnapshot | null> {
  let revisionId: string | null = null;
  if (hasSource) {
    revisionId = sourceBaselineId;
  } else {
    const released = await many<{ id: string }>(
      tx,
      `SELECT r.id FROM baseline_revision r JOIN technical_baseline b ON b.id = r.baseline_id
        WHERE b.part_id = $1 AND r.status = 'RELEASED'`,
      [partId],
    );
    revisionId = released.length === 1 ? released[0]!.id : null;
  }
  if (!revisionId) return null;
  const rev = await one<{
    id: string;
    revision_label: string;
    status: string;
    is_synthetic: boolean;
    released_at: Date;
    released_by_name: string;
    title: string;
    ownership: string;
  }>(
    tx,
    `SELECT r.id, r.revision_label, r.status, r.is_synthetic, r.released_at, u.display_name AS released_by_name, b.title, b.ownership
       FROM baseline_revision r JOIN technical_baseline b ON b.id = r.baseline_id LEFT JOIN app_user u ON u.id = r.released_by
      WHERE r.id = $1 FOR SHARE OF r`,
    [revisionId],
  );
  // Only released content may govern; drafts never masquerade as limits. A source keeps the exact
  // revision it was approved against even after a newer revision supersedes it (change control re-points it).
  if (!rev || !(rev.status === 'RELEASED' || (hasSource && rev.status === 'SUPERSEDED'))) return null;
  const chars = await many<{
    char_key: string;
    name: string;
    form_row_ref: string | null;
    unit: string | null;
    lower_limit: string | null;
    upper_limit: string | null;
    nominal: string | null;
    limit_text: string | null;
    method: string | null;
  }>(tx, 'SELECT * FROM baseline_characteristic WHERE revision_id = $1 ORDER BY char_key', [revisionId]);
  return {
    revisionId: rev.id,
    baselineTitle: rev.title,
    ownership: rev.ownership,
    revisionLabel: rev.revision_label,
    synthetic: rev.is_synthetic,
    releasedAt: rev.released_at.toISOString(),
    releasedBy: rev.released_by_name,
    characteristics: chars.map((c) => ({
      charKey: c.char_key,
      name: c.name,
      formRowRef: c.form_row_ref,
      unit: c.unit,
      lower: c.lower_limit,
      upper: c.upper_limit,
      nominal: c.nominal,
      limitText: c.limit_text,
      method: c.method,
    })),
  };
}

function assertEditable(state: LoadedInspection, auth: AuthContext) {
  if (!['DRAFT', 'PARTIAL'].includes(state.row.status)) {
    throw conflict(
      state.row.status === 'COMPLETED'
        ? 'This inspection is completed and frozen. Corrections must be recorded as an amendment.'
        : `This inspection is ${state.row.status.replaceAll('_', ' ').toLowerCase()} and cannot be edited`,
    );
  }
  if (state.row.inspector_id !== auth.userId) throw forbidden('Only the assigned inspector can edit this inspection');
}

function assertVersion(state: LoadedInspection, expectedVersion: number) {
  if (state.row.version !== expectedVersion) {
    throw conflict('This inspection was changed elsewhere. Reload to see the latest entries.', { currentVersion: state.row.version });
  }
}

interface ValidatedChange {
  change: EntryChange;
  sectionPattern: string;
  readings: Array<{ key: string; text: string | null; canonical: string | null; decimals: number | null; unit: string | null }>;
}

function validateChanges(def: FormDefinition, unitCount: number, activated: Set<string>, changes: EntryChange[], limitsUnit: (ref: string | null) => string | null): ValidatedChange[] {
  return changes.map((change) => {
    const section = def.sections.find((s) => s.key === change.sectionKey);
    if (!section) throw badRequest(`Unknown section ${change.sectionKey}`);
    if (section.scope === 'inspection' ? change.unitIndex !== 0 : change.unitIndex < 1 || change.unitIndex > unitCount) {
      throw badRequest(`Section ${section.key} does not apply to unit ${change.unitIndex}`);
    }
    if (section.optional && !activated.has(`${change.unitIndex}|${section.key}`)) {
      throw unprocessable(`Add the "${section.title}" section to Item ${change.unitIndex} before entering results`);
    }
    const row = sectionRows(section).find((r) => r.key === change.rowKey);
    if (!row) throw badRequest(`Unknown row ${section.key}.${change.rowKey}`);
    if (change.status !== undefined && change.status !== null) {
      const allowed = row.parentKey ? ['P', 'F'] : allowedStatuses(section.pattern);
      if (!allowed.includes(change.status)) throw badRequest(`Status ${change.status} is not allowed here`);
    }
    if (change.note !== undefined && change.note !== null && change.note.length > MAX_NOTE) throw badRequest('Note is too long');
    const readings: ValidatedChange['readings'] = [];
    for (const [key, value] of Object.entries(change.readings ?? {})) {
      if (!row.readingKeys.includes(key)) throw badRequest(`Unknown reading ${key} for ${row.label}`);
      if (value === null || value.trim() === '') {
        readings.push({ key, text: null, canonical: null, decimals: null, unit: null });
        continue;
      }
      const parsed = parseReading(value);
      if (!parsed.ok) throw unprocessable(`${row.label}: ${parsed.error}`, { unitIndex: change.unitIndex, sectionKey: section.key, rowKey: row.key, readingKey: key });
      readings.push({
        key,
        text: parsed.value.text,
        canonical: parsed.value.canonical,
        decimals: parsed.value.decimals,
        unit: limitsUnit(readingLimitRef(row, key)) ?? row.source?.unit ?? null,
      });
    }
    return { change, sectionPattern: section.pattern, readings };
  });
}

async function applyChanges(tx: DbClient, state: LoadedInspection, actorId: string, validated: ValidatedChange[], amendmentNo: number) {
  for (const v of validated) {
    const c = v.change;
    const id = rowId(c.unitIndex, c.sectionKey, c.rowKey);
    if (c.status !== undefined || c.note !== undefined) {
      const current = state.responses[id];
      const status = c.status !== undefined ? c.status : (current?.status ?? null);
      const note = c.note !== undefined ? (c.note?.trim() ? c.note : null) : (current?.note ?? null);
      await tx.query(
        `INSERT INTO inspection_response (inspection_id, unit_index, section_key, row_key, status, note, amendment_no, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (inspection_id, unit_index, section_key, row_key, amendment_no)
         DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [state.row.id, c.unitIndex, c.sectionKey, c.rowKey, status, note, amendmentNo, actorId],
      );
      state.responses[id] = { status, note, amendmentNo };
    }
    for (const r of v.readings) {
      if (r.text === null && amendmentNo === 0) {
        await tx.query(
          `DELETE FROM inspection_measurement WHERE inspection_id = $1 AND unit_index = $2 AND section_key = $3 AND row_key = $4
             AND reading_key = $5 AND amendment_no = 0`,
          [state.row.id, c.unitIndex, c.sectionKey, c.rowKey, r.key],
        );
      } else {
        await tx.query(
          `INSERT INTO inspection_measurement (inspection_id, unit_index, section_key, row_key, reading_key, value_text, value_numeric,
              decimals, unit, amendment_no, updated_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (inspection_id, unit_index, section_key, row_key, reading_key, amendment_no)
           DO UPDATE SET value_text = EXCLUDED.value_text, value_numeric = EXCLUDED.value_numeric, decimals = EXCLUDED.decimals,
                         unit = EXCLUDED.unit, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [state.row.id, c.unitIndex, c.sectionKey, c.rowKey, r.key, r.text, r.canonical, r.decimals, r.unit, amendmentNo, actorId],
        );
      }
      const rid = readingId(c.unitIndex, c.sectionKey, c.rowKey, r.key);
      if (r.text === null) delete state.readings[rid];
      else state.readings[rid] = { text: r.text, amendmentNo };
    }
  }
}

async function bumpVersion(tx: DbClient, id: string, setPartial: boolean): Promise<number> {
  const res = await one<{ version: number }>(
    tx,
    `UPDATE inspection SET version = version + 1, updated_at = now(),
        status = CASE WHEN $2 AND status = 'DRAFT' THEN 'PARTIAL' ELSE status END
      WHERE id = $1 RETURNING version`,
    [id, setPartial],
  );
  return res!.version;
}

export async function saveEntries(
  db: Db,
  req: FastifyRequest,
  id: string,
  input: { expectedVersion: number; changes: EntryChange[]; units?: UnitChange[] },
): Promise<{ version: number }> {
  const auth = await requireCapability(db, req, 'inspection.perform', { action: 'inspection.edit', entityType: 'inspection', entityId: id });
  return withTransaction(db, async (tx) => {
    const state = await loadInspection(tx, id, { lock: true });
    assertEditable(state, auth);
    assertVersion(state, input.expectedVersion);
    const validated = validateChanges(state.row.form_snapshot, state.row.unit_count, new Set(state.activated), input.changes, (ref) =>
      ref ? (state.limits[ref]?.unit ?? null) : null,
    );
    await applyChanges(tx, state, auth.userId, validated, 0);
    for (const u of input.units ?? []) {
      if (u.unitIndex < 1 || u.unitIndex > state.row.unit_count) throw badRequest(`Unknown unit ${u.unitIndex}`);
      const serial = u.serialNumber === undefined ? undefined : u.serialNumber?.trim() || null;
      const note = u.dispositionNote === undefined ? undefined : u.dispositionNote?.trim() || null;
      if ((serial?.length ?? 0) > 80 || (note?.length ?? 0) > MAX_NOTE) throw badRequest('Unit field is too long');
      const bench = state.bench.find((b) => b.unitIndex === u.unitIndex);
      if (bench && serial !== undefined && serial !== bench.serial) {
        throw unprocessable(`Item ${u.unitIndex} carries the bench result of SN ${bench.serial}; its serial number cannot change`);
      }
      await tx.query(
        `UPDATE inspection_unit SET
           serial_number = CASE WHEN $3 THEN $4 ELSE serial_number END,
           disposition_note = CASE WHEN $5 THEN $6 ELSE disposition_note END
         WHERE inspection_id = $1 AND unit_index = $2`,
        [id, u.unitIndex, serial !== undefined, serial ?? null, note !== undefined, note ?? null],
      );
    }
    return { version: await bumpVersion(tx, id, true) };
  });
}

export async function activateSection(
  db: Db,
  req: FastifyRequest,
  id: string,
  input: { expectedVersion: number; unitIndex: number; sectionKey: string },
): Promise<{ version: number }> {
  const auth = await requireCapability(db, req, 'inspection.perform', { action: 'inspection.edit', entityType: 'inspection', entityId: id });
  return withTransaction(db, async (tx) => {
    const state = await loadInspection(tx, id, { lock: true });
    assertEditable(state, auth);
    assertVersion(state, input.expectedVersion);
    const section = state.row.form_snapshot.sections.find((s) => s.key === input.sectionKey);
    if (!section || !section.optional || section.scope !== 'unit') throw badRequest('Only optional item sections can be added');
    if (input.unitIndex < 1 || input.unitIndex > state.row.unit_count) throw badRequest('Unknown unit');
    await tx.query(
      `INSERT INTO inspection_section_activation (inspection_id, unit_index, section_key, activated_by)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [id, input.unitIndex, input.sectionKey, auth.userId],
    );
    return { version: await bumpVersion(tx, id, true) };
  });
}

export async function passAll(
  db: Db,
  req: FastifyRequest,
  id: string,
  input: { expectedVersion: number; unitIndex: number; sectionKey: string; mode: 'fill_blank' | 'overwrite_all' },
): Promise<{ version: number; filled: number; overwritten: number; skipped: number }> {
  const auth = await requireCapability(db, req, 'inspection.perform', { action: 'inspection.edit', entityType: 'inspection', entityId: id });
  return withTransaction(db, async (tx) => {
    const state = await loadInspection(tx, id, { lock: true });
    assertEditable(state, auth);
    assertVersion(state, input.expectedVersion);
    const section = state.row.form_snapshot.sections.find((s) => s.key === input.sectionKey);
    if (!section || !isPassAllEligible(section)) throw badRequest('Pass All applies only to checklist sections; measurements are never filled');
    if (section.scope === 'inspection' ? input.unitIndex !== 0 : input.unitIndex < 1 || input.unitIndex > state.row.unit_count) {
      throw badRequest('Section does not apply to this unit');
    }
    const targets = passAllTargets(section, input.unitIndex, state.entry);
    const rows = input.mode === 'overwrite_all' ? [...targets.fill, ...targets.overwrite.map((o) => o.rowKey)] : targets.fill;
    const changes: EntryChange[] = rows.map((rowKey) => ({ unitIndex: input.unitIndex, sectionKey: section.key, rowKey, status: 'P' }));
    const validated = validateChanges(state.row.form_snapshot, state.row.unit_count, new Set(state.activated), changes, () => null);
    await applyChanges(tx, state, auth.userId, validated, 0);
    if (input.mode === 'overwrite_all' && targets.overwrite.length) {
      await audit(tx, {
        actorId: auth.userId,
        action: 'inspection.pass_all_overwrite',
        entityType: 'inspection',
        entityId: id,
        summary: `Pass All overwrote ${targets.overwrite.length} existing answer(s) in ${section.title}, unit ${input.unitIndex}`,
        before: targets.overwrite,
        requestId: req.id,
      });
    }
    return {
      version: await bumpVersion(tx, id, true),
      filled: targets.fill.length,
      overwritten: input.mode === 'overwrite_all' ? targets.overwrite.length : 0,
      skipped: input.mode === 'overwrite_all' ? 0 : targets.overwrite.length,
    };
  });
}

export async function savePartial(db: Db, req: FastifyRequest, id: string, expectedVersion: number): Promise<{ version: number }> {
  const auth = await requireCapability(db, req, 'inspection.perform', { action: 'inspection.edit', entityType: 'inspection', entityId: id });
  return withTransaction(db, async (tx) => {
    const state = await loadInspection(tx, id, { lock: true });
    assertEditable(state, auth);
    assertVersion(state, expectedVersion);
    return { version: await bumpVersion(tx, id, true) };
  });
}

async function issueReportEdition(tx: DbClient, config: Config, id: string, extras: { review?: boolean; amendmentNo?: number }) {
  const state = await loadInspection(tx, id);
  const editionRow = await one<{ n: number }>(
    tx,
    `SELECT count(*)::int AS n FROM report_snapshot WHERE subject_type = 'INSPECTION' AND subject_id = $1`,
    [id],
  );
  const edition = editionRow!.n + 1;
  const review = await one<{ decision: string; reviewer: string; reviewed_at: Date; comment: string | null; reasons: Array<{ path: string; message: string }> }>(
    tx,
    `SELECT r.decision, u.display_name AS reviewer, r.reviewed_at, r.comment, r.reasons
       FROM inspection_review r JOIN app_user u ON u.id = r.reviewer_id
      WHERE r.inspection_id = $1 AND r.decision = 'CONFIRMED' ORDER BY r.reviewed_at DESC LIMIT 1`,
    [id],
  );
  const amendment = extras.amendmentNo
    ? await one<{ amendment_no: number; reason: string; by: string; amended_at: Date }>(
        tx,
        `SELECT a.amendment_no, a.reason, u.display_name AS by, a.amended_at FROM inspection_amendment a
           JOIN app_user u ON u.id = a.amended_by WHERE a.inspection_id = $1 AND a.amendment_no = $2`,
        [id, extras.amendmentNo],
      )
    : null;
  const snapshot = buildReportSnapshot(state, {
    edition,
    draft: false,
    displayTimeZone: config.displayTimeZone,
    generatedAt: new Date(),
    outcome: state.effectiveOutcome,
    review: review
      ? {
          decision: review.decision,
          reviewer: review.reviewer,
          reviewedAt: review.reviewed_at.toISOString(),
          comment: review.comment,
          reasons: summarizeReviewReasons(review.reasons),
        }
      : null,
    amendment: amendment ? { number: amendment.amendment_no, reason: amendment.reason, by: amendment.by, at: amendment.amended_at.toISOString() } : null,
  });
  const sha = snapshotHash(snapshot);
  const inserted = await one<{ id: string }>(
    tx,
    `INSERT INTO report_snapshot (subject_type, subject_id, edition, snapshot, sha256) VALUES ('INSPECTION', $1, $2, $3, $4) RETURNING id`,
    [id, edition, JSON.stringify(snapshot), sha],
  );
  await enqueueJob(tx, 'inspection_report', `inspection_report:${inserted!.id}`, { snapshotId: inserted!.id });
}

export async function completeInspection(
  db: Db,
  config: Config,
  req: FastifyRequest,
  id: string,
  expectedVersion: number,
): Promise<{ status: string; outcome: string | null; version: number }> {
  const auth = await requireCapability(db, req, 'inspection.perform', { action: 'inspection.complete', entityType: 'inspection', entityId: id });
  return withTransaction(db, async (tx) => {
    const state = await loadInspection(tx, id, { lock: true });
    assertEditable(state, auth);
    assertVersion(state, expectedVersion);
    if (!(await recheckCapability(tx, auth.userId, 'inspection.perform'))) throw forbidden();
    const ev = state.evaluation;
    if (ev.errors.length) {
      throw unprocessable(`${ev.errors.length} item(s) must be resolved before completion`, { errors: ev.errors });
    }
    const needsReview = ev.reviewReasons.length > 0;
    const status = needsReview ? 'READY_FOR_REVIEW' : 'COMPLETED';
    const updated = await one<{ version: number }>(
      tx,
      `UPDATE inspection SET status = $2, outcome = $3, review_reasons = $4, submitted_by = $5, submitted_at = now(),
          completed_by = CASE WHEN $2 = 'COMPLETED' THEN $5::uuid END,
          completed_at = CASE WHEN $2 = 'COMPLETED' THEN now() END,
          version = version + 1, updated_at = now()
        WHERE id = $1 RETURNING version`,
      [id, status, ev.overall, JSON.stringify(ev.reviewReasons), auth.userId],
    );
    await tx.query(
      `UPDATE work_item SET status = 'DONE', closed_at = now(), closed_by = $2, closed_reason = 'Inspection submitted'
        WHERE subject_type = 'INSPECTION' AND subject_id = $1 AND kind = 'INSPECTION_ASSIGNED' AND status = 'OPEN'`,
      [id, auth.userId],
    );
    if (needsReview) {
      await tx.query(
        `INSERT INTO work_item (kind, title, subject_type, subject_id, required_capability)
         VALUES ('INSPECTION_REVIEW', $1, 'INSPECTION', $2, 'inspection.review')`,
        [`Review ${state.row.number} — ${state.row.part_number} (${ev.overall ?? 'pending'})`, id],
      );
    } else {
      await issueReportEdition(tx, config, id, {});
    }
    await audit(tx, {
      actorId: auth.userId,
      action: needsReview ? 'inspection.submit_for_review' : 'inspection.complete',
      entityType: 'inspection',
      entityId: id,
      summary: needsReview
        ? `${state.row.number} submitted for independent review (${ev.reviewReasons.length} item(s)); reported outcome ${ev.overall}`
        : `${state.row.number} completed; outcome ${ev.overall}`,
      after: { outcome: ev.overall, reviewReasons: ev.reviewReasons.map((r) => `${r.path}: ${r.message}`) },
      requestId: req.id,
    });
    return { status, outcome: ev.overall, version: updated!.version };
  });
}

export async function reviewInspection(
  db: Db,
  config: Config,
  req: FastifyRequest,
  id: string,
  input: { decision: 'CONFIRM' | 'RETURN'; comment?: string | null; expectedVersion: number; concessionId?: string | null },
): Promise<{ status: string }> {
  const auth = await requireCapability(db, req, 'inspection.review', { action: 'inspection.review', entityType: 'inspection', entityId: id });
  return withTransaction(db, async (tx) => {
    const state = await loadInspection(tx, id, { lock: true });
    const deny = async (message: string) => {
      // Recorded outside the transaction so the denial survives the rollback.
      await audit(db, { actorId: auth.userId, action: 'inspection.review', outcome: 'DENIED', entityType: 'inspection', entityId: id, summary: message, requestId: req.id });
      return forbidden(message);
    };
    if (state.row.status !== 'READY_FOR_REVIEW') throw conflict('This inspection is not awaiting review');
    assertVersion(state, input.expectedVersion);
    // Independence: the inspector of record cannot review their own inspection (NEG-19).
    if (state.row.inspector_id === auth.userId) {
      throw await deny('Independent review required: the inspector cannot review their own inspection');
    }
    const grants: string[] = ['inspection.review'];
    if (!(await recheckCapability(tx, auth.userId, 'inspection.review'))) throw forbidden();
    const hasAccepted = state.evaluation.reviewReasons.some((r) => r.message.startsWith('Accepted'));
    if (input.decision === 'CONFIRM' && hasAccepted) {
      if (!(await recheckCapability(tx, auth.userId, 'inspection.review_accepted'))) {
        throw await deny('Confirming an Accepted result requires the "inspection.review_accepted" authority');
      }
      grants.push('inspection.review_accepted');
    }
    const comment = input.comment?.trim() || null;
    if (input.decision === 'RETURN' && !comment) throw unprocessable('A reason is required to return an inspection for correction');
    let concession: { id: string; number: string } | null = null;
    if (input.concessionId) {
      if (input.decision !== 'CONFIRM' || !hasAccepted) throw unprocessable('A concession applies only when confirming Accepted results');
      // Only the accepted items consume the concession; it must cover this exact part, source, lot and date (AT-02, AT-14).
      const ev = state.evaluation;
      const acceptedUnits = Object.values(ev.unitOutcomes).filter((o) => o === 'ACCEPTED').length || (ev.sharedOutcome === 'ACCEPTED' ? state.row.unit_count : 0);
      concession = await assertConcessionCovers(
        tx,
        input.concessionId,
        { partId: state.row.part_id, sourceId: state.row.source_id, lotNumber: state.row.lot_number, quantity: acceptedUnits },
        dayIn(config.displayTimeZone),
      );
      await tx.query('INSERT INTO concession_use (concession_id, quantity, inspection_id, used_by) VALUES ($1,$2,$3,$4)', [concession.id, acceptedUnits, id, auth.userId]);
      await audit(tx, { actorId: auth.userId, action: 'concession.use', entityType: 'concession', entityId: concession.id, summary: `${acceptedUnits} accepted item(s) of ${state.row.number} covered`, requestId: req.id });
    }
    if (input.decision === 'CONFIRM' && state.evaluation.errors.length) throw conflict('Inspection has unresolved entries and cannot be confirmed');
    await tx.query(
      `INSERT INTO inspection_review (inspection_id, decision, reviewer_id, reasons, comment, grants_used) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, input.decision === 'CONFIRM' ? 'CONFIRMED' : 'RETURNED', auth.userId, JSON.stringify(state.evaluation.reviewReasons), comment, grants],
    );
    await tx.query(
      `UPDATE work_item SET status = 'DONE', closed_at = now(), closed_by = $2, closed_reason = $3
        WHERE subject_type = 'INSPECTION' AND subject_id = $1 AND kind = 'INSPECTION_REVIEW' AND status = 'OPEN'`,
      [id, auth.userId, input.decision === 'CONFIRM' ? 'Review confirmed' : 'Returned for correction'],
    );
    if (input.decision === 'CONFIRM') {
      await tx.query(
        `UPDATE inspection SET status = 'COMPLETED', completed_by = $2, completed_at = now(), version = version + 1, updated_at = now() WHERE id = $1`,
        [id, auth.userId],
      );
      await issueReportEdition(tx, config, id, { review: true });
    } else {
      await tx.query(
        `UPDATE inspection SET status = 'PARTIAL', outcome = NULL, review_reasons = NULL, submitted_at = NULL, submitted_by = NULL,
           version = version + 1, updated_at = now() WHERE id = $1`,
        [id],
      );
      await tx.query(
        `INSERT INTO work_item (kind, title, subject_type, subject_id, assignee_id) VALUES ('INSPECTION_ASSIGNED', $1, 'INSPECTION', $2, $3)`,
        [`Correct ${state.row.number}: ${comment}`.slice(0, 200), id, state.row.inspector_id],
      );
    }
    await audit(tx, {
      actorId: auth.userId,
      action: input.decision === 'CONFIRM' ? 'inspection.review_confirm' : 'inspection.review_return',
      entityType: 'inspection',
      entityId: id,
      summary: `${state.row.number} ${input.decision === 'CONFIRM' ? 'review confirmed' : 'returned for correction'}${concession ? `; accepted items under ${concession.number}` : ''}`,
      reason: comment,
      after: { grantsUsed: grants, reasons: state.evaluation.reviewReasons.map((r) => `${r.path}: ${r.message}`) },
      requestId: req.id,
    });
    return { status: input.decision === 'CONFIRM' ? 'COMPLETED' : 'PARTIAL' };
  });
}

export async function amendInspection(
  db: Db,
  config: Config,
  req: FastifyRequest,
  id: string,
  input: { reason: string; changes: EntryChange[]; expectedVersion: number },
): Promise<{ amendmentNo: number; outcome: string | null }> {
  const auth = await requireCapability(db, req, 'inspection.amend', { action: 'inspection.amend', entityType: 'inspection', entityId: id });
  const reason = input.reason.trim();
  if (reason.length < 5) throw unprocessable('A meaningful reason is required for an amendment');
  if (!input.changes.length) throw unprocessable('An amendment must change at least one entry');
  return withTransaction(db, async (tx) => {
    const state = await loadInspection(tx, id, { lock: true });
    if (state.row.status !== 'COMPLETED') throw conflict('Only completed inspections are amended; edit drafts directly');
    assertVersion(state, input.expectedVersion);
    if (!(await recheckCapability(tx, auth.userId, 'inspection.amend'))) throw forbidden();
    const amendmentNo = state.row.amendment_count + 1;
    const before = input.changes.map((c) => ({
      ...c,
      previous: {
        status: state.responses[rowId(c.unitIndex, c.sectionKey, c.rowKey)]?.status ?? null,
        note: state.responses[rowId(c.unitIndex, c.sectionKey, c.rowKey)]?.note ?? null,
        readings: Object.fromEntries(
          Object.keys(c.readings ?? {}).map((k) => [k, state.readings[readingId(c.unitIndex, c.sectionKey, c.rowKey, k)]?.text ?? null]),
        ),
      },
    }));
    const validated = validateChanges(state.row.form_snapshot, state.row.unit_count, new Set(state.activated), input.changes, (ref) =>
      ref ? (state.limits[ref]?.unit ?? null) : null,
    );
    // Evaluate the amended record before writing: an amendment cannot leave it incomplete.
    const nextEntry = structuredClone(state.entry);
    for (const v of validated) {
      const key = rowId(v.change.unitIndex, v.change.sectionKey, v.change.rowKey);
      const cur = nextEntry.responses[key] ?? { status: null, note: null };
      nextEntry.responses[key] = {
        status: v.change.status !== undefined ? v.change.status : cur.status,
        note: v.change.note !== undefined ? v.change.note : cur.note,
      };
      for (const r of v.readings) {
        const rk = readingId(v.change.unitIndex, v.change.sectionKey, v.change.rowKey, r.key);
        if (r.text === null) delete nextEntry.readings[rk];
        else nextEntry.readings[rk] = r.text;
      }
    }
    const ev = evaluateInspection({ definition: state.row.form_snapshot, unitCount: state.row.unit_count, limits: state.limits }, nextEntry);
    if (ev.errors.length) throw unprocessable('The amendment would leave required entries unresolved', { errors: ev.errors });

    await tx.query(
      `INSERT INTO inspection_amendment (inspection_id, amendment_no, reason, resulting_outcome, amended_by) VALUES ($1,$2,$3,$4,$5)`,
      [id, amendmentNo, reason, ev.overall, auth.userId],
    );
    await applyChanges(tx, state, auth.userId, validated, amendmentNo);
    await tx.query('UPDATE inspection SET amendment_count = $2, version = version + 1, updated_at = now() WHERE id = $1', [id, amendmentNo]);
    await issueReportEdition(tx, config, id, { amendmentNo });
    await audit(tx, {
      actorId: auth.userId,
      action: 'inspection.amend',
      entityType: 'inspection',
      entityId: id,
      summary: `${state.row.number} amendment ${amendmentNo}; outcome ${state.effectiveOutcome} -> ${ev.overall}`,
      reason,
      before,
      after: input.changes,
      requestId: req.id,
    });
    return { amendmentNo, outcome: ev.overall };
  });
}
