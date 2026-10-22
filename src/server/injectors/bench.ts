import { createHash, randomUUID } from 'node:crypto';
import type { BenchOutcome, BenchResultRow } from '../../shared/carbonzapp.js';
import { BENCH_ADAPTER, BENCH_COLUMNS, criteriaRef, normalizeSerial, parseCsv } from '../../shared/injectors.js';
import { canonicalJson } from '../../shared/forms.js';
import { compareDecimal, parseReading } from '../../shared/measurement.js';
import { audit } from '../audit.js';
import type { AuthContext } from '../auth.js';
import { type DbClient, type Queryable, many, one, withTransaction } from '../db.js';
import { unprocessable } from '../errors.js';
import { nextRecordNumber } from '../numbering.js';
import type { Services } from '../services.js';

const MAX_ROWS = 50_000;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

export interface BenchResultInput {
  condition: string;
  parameter: string;
  unit: string | null;
  value: string;
  result: 'PASS' | 'FAIL' | null;
  /** CarbonZapp: green band, step outcome and bench note of this measurement. */
  bench?: BenchResultRow['bench'];
}

export interface BenchTestInput {
  machineId: string;
  testPlan: string;
  serial: string;
  partNumber: string;
  testedAt: string;
  testSeq: string;
  operator: string | null;
  results: BenchResultInput[];
  raw: Array<Record<string, string>> | Record<string, unknown>;
  /** CarbonZapp: the bench classification and the report/slot identity. */
  bench?: { outcome: BenchOutcome; reportId: string; slot: number };
}

export interface ParsedBenchFile {
  tests: BenchTestInput[];
  excluded: Array<{ key: string; reason: string; rows: number[] }>;
}

/** Validates the TQMS-BENCH-CSV-1 layout and groups rows into tests; invalid tests are excluded whole. */
export function parseBenchFile(bytes: Buffer): ParsedBenchFile {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw unprocessable('The file is not valid UTF-8 text');
  }
  if (text.includes('\u0000')) throw unprocessable('The file contains binary data');
  let rows: string[][];
  try {
    rows = parseCsv(text);
  } catch (e) {
    throw unprocessable(`The file is not valid CSV: ${(e as Error).message}`);
  }
  if (!rows.length) throw unprocessable('The file is empty');
  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  if (header.length !== BENCH_COLUMNS.length || header.some((h, i) => h !== BENCH_COLUMNS[i])) {
    throw unprocessable(`Unrecognized layout. ${BENCH_ADAPTER} expects the header: ${BENCH_COLUMNS.join(',')}`);
  }
  if (rows.length - 1 > MAX_ROWS) throw unprocessable(`The file has more than ${MAX_ROWS} data rows`);

  const groups = new Map<string, { rows: number[]; records: Array<Record<string, string>>; problems: string[] }>();
  rows.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const rec = Object.fromEntries(BENCH_COLUMNS.map((c, j) => [c, (cells[j] ?? '').trim()])) as Record<string, string>;
    const key = [rec.machine_id, normalizeSerial(rec.serial_number ?? ''), rec.tested_at, rec.test_seq].join('|');
    const g = groups.get(key) ?? { rows: [], records: [], problems: [] };
    g.rows.push(line);
    g.records.push(rec);
    if (cells.length !== BENCH_COLUMNS.length) g.problems.push(`line ${line}: expected ${BENCH_COLUMNS.length} fields, found ${cells.length}`);
    groups.set(key, g);
  });

  const tests: BenchTestInput[] = [];
  const excluded: ParsedBenchFile['excluded'] = [];
  for (const [key, g] of groups) {
    const first = g.records[0]!;
    const problems = [...g.problems];
    for (const col of ['machine_id', 'test_plan', 'serial_number', 'part_number', 'tested_at', 'test_seq', 'condition', 'parameter', 'value'] as const) {
      if (g.records.some((r) => !r[col])) problems.push(`${col} is missing`);
    }
    if (first.tested_at && !TIME_RE.test(first.tested_at)) problems.push(`tested_at "${first.tested_at}" needs an ISO date-time with a time zone`);
    for (const col of ['test_plan', 'part_number', 'operator'] as const) {
      if (new Set(g.records.map((r) => r[col])).size > 1) problems.push(`${col} differs between rows of the same test`);
    }
    const seen = new Set<string>();
    const results: BenchResultInput[] = [];
    for (const r of g.records) {
      const k = `${r.condition}|${r.parameter}`.toLowerCase();
      if (seen.has(k)) problems.push(`${r.condition} / ${r.parameter} appears twice`);
      seen.add(k);
      const v = parseReading(r.value ?? '');
      if (!v.ok) problems.push(`${r.condition} / ${r.parameter}: ${v.error}`);
      const verdict = (r.result ?? '').toUpperCase();
      if (verdict && verdict !== 'PASS' && verdict !== 'FAIL') problems.push(`${r.condition} / ${r.parameter}: result must be PASS, FAIL or empty`);
      results.push({ condition: r.condition!, parameter: r.parameter!, unit: r.unit || null, value: v.ok ? v.value.canonical : (r.value ?? ''), result: verdict ? (verdict as 'PASS' | 'FAIL') : null });
    }
    if (problems.length) {
      excluded.push({ key, reason: [...new Set(problems)].slice(0, 5).join('; '), rows: g.rows });
      continue;
    }
    tests.push({
      machineId: first.machine_id!,
      testPlan: first.test_plan!,
      serial: first.serial_number!,
      partNumber: first.part_number!,
      testedAt: new Date(first.tested_at!).toISOString(),
      testSeq: first.test_seq!,
      operator: first.operator || null,
      results,
      raw: g.records,
    });
  }
  return { tests, excluded };
}

export interface Criteria {
  revisionId: string | null;
  limits: Map<string, { lower: string | null; upper: string | null; unit: string | null }>;
}

/** Released PDI bench criteria for a part: FUNCTIONAL characteristics referenced injector:<condition>__<parameter>. */
export async function releasedCriteria(db: Queryable, partId: string): Promise<Criteria> {
  const revs = await many<{ id: string }>(
    db,
    `SELECT DISTINCT r.id FROM baseline_revision r JOIN technical_baseline b ON b.id = r.baseline_id
       JOIN baseline_characteristic c ON c.revision_id = r.id
      WHERE b.part_id = $1 AND r.status = 'RELEASED' AND c.form_row_ref LIKE 'injector:%'`,
    [partId],
  );
  // Two released revisions defining bench criteria would be ambiguous: no PDI verdict is calculated.
  if (revs.length !== 1) return { revisionId: null, limits: new Map() };
  const chars = await many<{ form_row_ref: string; lower: string | null; upper: string | null; unit: string | null }>(
    db,
    `SELECT form_row_ref, lower_limit::text AS lower, upper_limit::text AS upper, unit FROM baseline_characteristic WHERE revision_id = $1 AND form_row_ref LIKE 'injector:%'`,
    [revs[0]!.id],
  );
  return { revisionId: revs[0]!.id, limits: new Map(chars.map((c) => [c.form_row_ref, { lower: c.lower, upper: c.upper, unit: c.unit }])) };
}

export function evaluateTest(results: BenchResultInput[], criteria: Criteria) {
  const evaluated = results.map((r) => {
    const limit = criteria.limits.get(criteriaRef(r.condition, r.parameter));
    // Never infer units: a unit mismatch is not compared.
    const comparable = limit && (limit.lower !== null || limit.upper !== null) && (limit.unit ?? null) === (r.unit ?? null) && parseReading(r.value).ok;
    let evaluation: 'WITHIN' | 'OUTSIDE' | 'NO_LIMIT' = 'NO_LIMIT';
    if (comparable) {
      const below = limit.lower !== null && compareDecimal(r.value, limit.lower) < 0;
      const above = limit.upper !== null && compareDecimal(r.value, limit.upper) > 0;
      evaluation = below || above ? 'OUTSIDE' : 'WITHIN';
    }
    return { ...r, lower: comparable ? limit.lower : null, upper: comparable ? limit.upper : null, evaluation };
  });
  const limited = evaluated.filter((r) => r.evaluation !== 'NO_LIMIT');
  const pdi: 'PASS' | 'FAIL' | 'NO_CRITERIA' | 'PARTIAL_CRITERIA' = !limited.length
    ? 'NO_CRITERIA'
    : limited.some((r) => r.evaluation === 'OUTSIDE')
      ? 'FAIL'
      : limited.length === evaluated.length
        ? 'PASS'
        : 'PARTIAL_CRITERIA';
  const machine: 'PASS' | 'FAIL' | 'NOT_REPORTED' = results.some((r) => r.result === 'FAIL') ? 'FAIL' : results.length && results.every((r) => r.result === 'PASS') ? 'PASS' : 'NOT_REPORTED';
  return { evaluated, pdi, machine, criteriaRevisionId: limited.length ? criteria.revisionId : null };
}

export const contentHash = (t: BenchTestInput) =>
  createHash('sha256')
    .update(
      canonicalJson({
        plan: t.testPlan,
        part: t.partNumber.toUpperCase(),
        operator: t.operator,
        results: [...t.results].sort((a, b) => `${a.condition}|${a.parameter}`.localeCompare(`${b.condition}|${b.parameter}`)),
      }),
    )
    .digest('hex');

export const sourceKey = (t: { machineId: string; serial: string; testedAt: string; testSeq: string }, origin: 'IMPORT' | 'MANUAL' = 'IMPORT') =>
  `${origin === 'MANUAL' ? 'manual:' : ''}${t.machineId.trim().toUpperCase()}|${normalizeSerial(t.serial)}|${t.testedAt}|${t.testSeq}`;

export async function findPart(tx: Queryable, partNumber: string) {
  const norm = partNumber.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return one<{ id: string; part_number: string }>(
    tx,
    `SELECT p.id, p.part_number FROM company_part p WHERE p.active AND (upper(p.part_number) = upper($1)
        OR EXISTS (SELECT 1 FROM part_alias a WHERE a.part_id = p.id AND a.normalized = $2)) LIMIT 1`,
    [partNumber, norm],
  );
}

export async function ensureInjector(tx: Queryable, partId: string, serial: string, actorId: string, synthetic = false): Promise<{ id: string; created: boolean }> {
  const norm = normalizeSerial(serial);
  const existing = await one<{ id: string }>(tx, 'SELECT id FROM injector WHERE part_id = $1 AND normalized_serial = $2', [partId, norm]);
  if (existing) return { id: existing.id, created: false };
  const row = await one<{ id: string }>(
    tx,
    `INSERT INTO injector (part_id, serial_number, normalized_serial, is_synthetic, created_by) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (part_id, normalized_serial) DO UPDATE SET serial_number = injector.serial_number RETURNING id`,
    [partId, serial.trim(), norm, synthetic, actorId],
  );
  return { id: row!.id, created: true };
}

/** Stores one test with its results, frozen against the criteria released now. */
export async function insertTest(
  tx: DbClient,
  t: BenchTestInput,
  ctx: { injectorId: string; partId: string; origin: 'IMPORT' | 'MANUAL'; importId: string | null; actorId: string; repairActionId?: string | null; note?: string | null },
): Promise<string> {
  const criteria = await releasedCriteria(tx, ctx.partId);
  const ev = evaluateTest(t.results, criteria);
  const row = await one<{ id: string }>(
    tx,
    `INSERT INTO injector_test (injector_id, source_key, content_sha256, origin, import_id, machine_id, test_plan, tested_at, operator, machine_verdict,
        pdi_evaluation, criteria_revision_id, repair_action_id, raw, note, recorded_by, bench_outcome, bench_report_id, bench_slot)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
    [
      ctx.injectorId,
      sourceKey(t, ctx.origin),
      contentHash(t),
      ctx.origin,
      ctx.importId,
      t.machineId,
      t.testPlan,
      t.testedAt,
      t.operator,
      ev.machine,
      ev.pdi,
      ev.criteriaRevisionId,
      ctx.repairActionId ?? null,
      JSON.stringify(t.raw),
      ctx.note ?? null,
      ctx.actorId,
      t.bench?.outcome ?? null,
      t.bench?.reportId ?? null,
      t.bench?.slot ?? null,
    ],
  );
  for (const r of ev.evaluated) {
    const v = parseReading(r.value);
    await tx.query(
      `INSERT INTO injector_test_result (test_id, condition, parameter, unit, value_text, value, machine_verdict, lower_limit, upper_limit, pdi_evaluation,
          position, bench_spec, bench_lower, bench_upper, bench_outcome, bench_note, bench_conditions)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        row!.id,
        r.condition,
        r.parameter,
        r.unit,
        r.value,
        v.ok ? v.value.canonical : null,
        r.result,
        r.lower,
        r.upper,
        r.evaluation,
        r.bench?.position ?? null,
        r.bench?.spec ?? null,
        r.bench?.lower ?? null,
        r.bench?.upper ?? null,
        r.bench?.outcome ?? null,
        r.bench?.note ?? null,
        r.bench?.conditions ?? null,
      ],
    );
  }
  return row!.id;
}

export interface ImportOutcome {
  importId: string;
  number: string;
  status: 'COMPLETED' | 'DUPLICATE_FILE';
  totals: { total: number; added: number; duplicate: number; conflict: number; excluded: number; injectorsAdded: number };
}

/**
 * Idempotent, all-or-nothing import of one bench file (FR-060, NEG-09, NEG-22). The original bytes
 * are stored first; tests are written in one transaction, so an interrupted import leaves no partial
 * data and re-importing the same file adds only what is missing.
 */
export async function importBenchFile(
  svc: Services,
  auth: AuthContext,
  file: { bytes: Buffer; name: string },
  hooks: { afterTest?: (n: number) => void } = {},
): Promise<ImportOutcome> {
  const parsed = parseBenchFile(file.bytes);
  const staged = await svc.storage.stageBuffer(file.bytes);
  const storageKey = await svc.storage.finalize(staged);
  try {
    return await withTransaction(svc.db, async (tx) => {
      const importId = randomUUID();
      const number = await nextRecordNumber(tx, 'BI');
      const prior = await one<{ number: string }>(tx, `SELECT number FROM bench_import WHERE file_sha256 = $1 ORDER BY imported_at LIMIT 1`, [staged.sha256]);
      const fileRow = await one<{ id: string }>(
        tx,
        `INSERT INTO file_object (kind, status, sha256, byte_size, mime_type, original_name, storage_key, uploaded_by)
         VALUES ('IMPORT','AVAILABLE',$1,$2,'text/csv',$3,$4,$5) RETURNING id`,
        [staged.sha256, staged.size, file.name, storageKey, auth.userId],
      );
      const report: Array<{ key: string; serial?: string; testedAt?: string; outcome: string; reason?: string; injectorId?: string; testId?: string }> = parsed.excluded.map((e) => ({
        key: e.key,
        outcome: 'EXCLUDED',
        reason: `${e.reason} (lines ${e.rows.join(', ')})`,
      }));
      const totals = { total: parsed.tests.length + parsed.excluded.length, added: 0, duplicate: 0, conflict: 0, excluded: parsed.excluded.length, injectorsAdded: 0 };
      for (const t of parsed.tests) {
        const key = sourceKey(t);
        const part = await findPart(tx, t.partNumber);
        if (!part) {
          totals.excluded += 1;
          report.push({ key, serial: t.serial, testedAt: t.testedAt, outcome: 'EXCLUDED', reason: `Unknown part number ${t.partNumber}` });
          continue;
        }
        const existing = await one<{ id: string; content_sha256: string; injector_id: string }>(tx, 'SELECT id, content_sha256, injector_id FROM injector_test WHERE source_key = $1', [key]);
        if (existing) {
          const same = existing.content_sha256 === contentHash(t);
          if (same) totals.duplicate += 1;
          else totals.conflict += 1;
          report.push({
            key,
            serial: t.serial,
            testedAt: t.testedAt,
            outcome: same ? 'DUPLICATE' : 'CONFLICT',
            reason: same ? 'Already imported; nothing changed' : 'Same machine, serial, time and sequence with different values; the original is kept unchanged',
            injectorId: existing.injector_id,
            testId: existing.id,
          });
          continue;
        }
        const inj = await ensureInjector(tx, part.id, t.serial, auth.userId);
        if (inj.created) totals.injectorsAdded += 1;
        const testId = await insertTest(tx, t, { injectorId: inj.id, partId: part.id, origin: 'IMPORT', importId, actorId: auth.userId });
        totals.added += 1;
        report.push({ key, serial: t.serial, testedAt: t.testedAt, outcome: 'ADDED', injectorId: inj.id, testId });
        hooks.afterTest?.(totals.added);
      }
      const status = prior ? 'DUPLICATE_FILE' : 'COMPLETED';
      await tx.query(
        `INSERT INTO bench_import (id, number, file_id, file_sha256, adapter, status, tests_total, tests_added, tests_duplicate, tests_conflict, tests_excluded, injectors_added, report, imported_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [importId, number, fileRow!.id, staged.sha256, BENCH_ADAPTER, status, totals.total, totals.added, totals.duplicate, totals.conflict, totals.excluded, totals.injectorsAdded, JSON.stringify({ priorImport: prior?.number ?? null, tests: report.slice(0, 5000) }), auth.userId],
      );
      await tx.query(`INSERT INTO evidence_link (file_id, entity_type, entity_id, caption, linked_by) VALUES ($1, 'BENCH_IMPORT', $2, $3, $4)`, [fileRow!.id, importId, `Original bench file ${file.name}`, auth.userId]);
      await audit(tx, {
        actorId: auth.userId,
        action: 'injector.import',
        entityType: 'bench_import',
        entityId: importId,
        summary: `${number}: ${file.name} — ${totals.added} added, ${totals.duplicate} already present, ${totals.conflict} conflicting, ${totals.excluded} excluded${prior ? ` (same file as ${prior.number})` : ''}`,
        after: { sha256: staged.sha256, totals },
      });
      return { importId, number, status, totals };
    });
  } catch (err) {
    await svc.storage.removeOrphan(storageKey);
    throw err;
  }
}
