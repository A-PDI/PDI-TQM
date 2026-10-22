import { randomUUID } from 'node:crypto';
import {
  CARBONZAPP_ADAPTER,
  type CzReport,
  EXCLUSION_TEXT,
  type ReadReport,
  exclusionReasons,
  readReport,
  reportKey,
  reportTime,
  reportsFromPayload,
  sanitiseReport,
} from '../../shared/carbonzapp.js';
import { audit } from '../audit.js';
import type { AuthContext } from '../auth.js';
import { type DbClient, type Queryable, many, one, withTransaction } from '../db.js';
import { AppError, conflict } from '../errors.js';
import { nextRecordNumber } from '../numbering.js';
import type { Services } from '../services.js';
import { type BenchTestInput, contentHash, ensureInjector, findPart, insertTest, sourceKey } from './bench.js';

/**
 * CarbonZapp cloud client (owner's bench, INJECTOR_TESTS_TECHNICAL_DESCRIPTION §5): one endpoint,
 * the key sent both as a Bearer token and in the body, paged by an inclusive `date_from`.
 * The key is read only from the server environment (CARBONZAPP_API_KEY) and never stored or shown.
 */
const DEFAULT_BASE_URL = 'https://cloudx.carbonzapp.com';
const REPORTS_PATH = '/userapi/v1/client/getReports';
const SETTING_KEY = 'carbonzapp_sync';
/** Incremental syncs re-read the last five minutes so a report written during a sync is not missed. */
const OVERLAP_MS = 5 * 60 * 1000;
/**
 * The first sync asks for everything since this date: some CarbonZapp deployments answer a request
 * without date_from with an empty list (technical description §6.1), so a wide date is sent instead.
 */
const FIRST_SYNC_FROM = '2000-01-01T00:00:00.000Z';

const envInt = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

export const benchConfig = () => ({
  apiKey: process.env.CARBONZAPP_API_KEY?.trim() || null,
  baseUrl: (process.env.CARBONZAPP_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, ''),
  timeoutMs: envInt('CARBONZAPP_TIMEOUT_MS', 30_000),
  maxPages: envInt('CARBONZAPP_MAX_PAGES', 100),
  budgetMs: envInt('CARBONZAPP_FETCH_BUDGET_MS', 240_000),
});

const benchError = (status: number, code: string, message: string) => new AppError(status, code, message);
const looksLikeHtml = (body: string) => /^\s*<(?:!doctype|html)/i.test(body) || /auth0|<title>/i.test(body);

/** One request to the bench cloud; errors become messages an administrator can act on (§5.2). */
export async function fetchReports(dateFrom: string | null): Promise<CzReport[]> {
  const cfg = benchConfig();
  if (!cfg.apiKey) throw benchError(400, 'NO_API_KEY', 'The CarbonZapp API key is not configured. Set CARBONZAPP_API_KEY in the server environment.');
  let resp: Response;
  try {
    resp = await fetch(`${cfg.baseUrl}${REPORTS_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(dateFrom ? { api_key: cfg.apiKey, date_from: dateFrom } : { api_key: cfg.apiKey }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (err) {
    const e = err as Error;
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      throw benchError(504, 'CARBONZAPP_TIMEOUT', `CarbonZapp did not respond within ${Math.round(cfg.timeoutMs / 1000)}s. Check the bench connection and try again.`);
    }
    const cause = (e as { cause?: { message?: string } }).cause?.message;
    throw benchError(502, 'CARBONZAPP_NETWORK', `Could not reach CarbonZapp (${cause ?? e.message}). Check the server's network access to ${new URL(cfg.baseUrl).host}.`);
  }
  const body = await resp.text();
  if (!resp.ok || looksLikeHtml(body)) {
    if (looksLikeHtml(body) || [302, 400, 401, 403].includes(resp.status)) {
      throw benchError(
        502,
        'CARBONZAPP_HTTP_ERROR',
        `CarbonZapp rejected the request (HTTP ${resp.status}). This usually means the API key is invalid or expired — generate a new key and update CARBONZAPP_API_KEY.`,
      );
    }
    throw benchError(502, 'CARBONZAPP_HTTP_ERROR', `CarbonZapp API returned HTTP ${resp.status}: ${body.replace(/\s+/g, ' ').trim().slice(0, 160)}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw benchError(502, 'CARBONZAPP_BAD_RESPONSE', 'CarbonZapp returned a non-JSON response. The API key may be invalid, or the endpoint has changed.');
  }
  const reports = reportsFromPayload(payload);
  if (!reports) throw benchError(502, 'CARBONZAPP_BAD_RESPONSE', 'CarbonZapp API returned an unexpected (non-array) response.');
  return reports;
}

/**
 * Pages forward by the newest test time seen (§5.4). The bench answers oldest first with at most
 * one page per request; `truncated` means the result is incomplete (page or time budget reached).
 */
export async function fetchAllReports(dateFrom: string | null): Promise<{ reports: CzReport[]; pages: number; truncated: boolean; newest: string | null }> {
  const cfg = benchConfig();
  const started = Date.now();
  const byKey = new Map<string, CzReport>();
  let cursor = dateFrom;
  let pages = 0;
  let truncated = false;
  let newestSeen: Date | null = null;
  while (pages < cfg.maxPages) {
    const batch = await fetchReports(cursor);
    pages += 1;
    let added = 0;
    let newest: Date | null = null;
    for (const r of batch) {
      const key = reportKey(r);
      if (!byKey.has(key)) {
        byKey.set(key, r);
        added += 1;
      }
      const t = reportTime(r);
      if (t && (!newest || t > newest)) newest = t;
    }
    if (newest && (!newestSeen || newest > newestSeen)) newestSeen = newest;
    if (!batch.length || added === 0 || !newest) break;
    const next = newest.toISOString();
    if (cursor && next <= cursor) break;
    cursor = next;
    if (Date.now() - started > cfg.budgetMs || pages >= cfg.maxPages) {
      truncated = true;
      break;
    }
  }
  return { reports: [...byKey.values()], pages, truncated, newest: newestSeen?.toISOString() ?? null };
}

function toTestInput(r: ReadReport, raw: CzReport): BenchTestInput {
  return {
    machineId: r.machineSerial,
    testPlan: [r.brand, r.injectorType].filter(Boolean).join(' ') || 'CarbonZapp',
    serial: r.serial,
    partNumber: r.partNumber,
    testedAt: r.testedAt,
    testSeq: `${r.reportId}/${r.slot}`,
    operator: null,
    results: r.results.map((x) => ({ condition: x.condition, parameter: x.parameter, unit: x.unit, value: x.value, result: x.verdict, bench: x.bench })),
    raw: sanitiseReport(raw) as Record<string, unknown>,
    bench: { outcome: r.outcome, reportId: r.reportId, slot: r.slot },
  };
}

/**
 * The PDI part for a bench part code: the part number or an alias, exactly (ignoring separators);
 * otherwise a part number or alias of 5+ characters contained in the bench code (the bench adds
 * suffixes such as "PX" to the core number). More than one candidate is ambiguous and not matched.
 */
export async function findBenchPart(db: Queryable, code: string): Promise<{ part: { id: string; part_number: string } | null; reason: string | null }> {
  const exact = await findPart(db, code);
  if (exact) return { part: exact, reason: null };
  const norm = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const candidates = await many<{ id: string; part_number: string }>(
    db,
    `SELECT DISTINCT p.id, p.part_number FROM company_part p
       LEFT JOIN part_alias a ON a.part_id = p.id
      WHERE p.active AND (
            (length(a.normalized) >= 5 AND position(a.normalized IN $1) > 0)
         OR (length(regexp_replace(upper(p.part_number), '[^A-Z0-9]', '', 'g')) >= 5
             AND position(regexp_replace(upper(p.part_number), '[^A-Z0-9]', '', 'g') IN $1) > 0))
      ORDER BY p.part_number LIMIT 3`,
    [norm],
  );
  if (candidates.length === 1) return { part: candidates[0]!, reason: null };
  if (candidates.length > 1) return { part: null, reason: `Bench part ${code} matches more than one PDI part (${candidates.map((c) => c.part_number).join(', ')})` };
  return { part: null, reason: `Bench part ${code} is not a PDI part number or alias` };
}

export interface SyncOutcome {
  importNumber: string | null;
  fetched: number;
  pages: number;
  truncated: boolean;
  dateFrom: string;
  added: number;
  duplicate: number;
  conflict: number;
  excluded: number;
  unreadable: number;
  waitingForPart: number;
  pendingImported: number;
  injectorsAdded: number;
  lastSync: string;
}

type ReportLine = { key: string; serial?: string; partNumber?: string; testedAt?: string; outcome: string; reason?: string; testId?: string };

async function storeTest(
  tx: DbClient,
  read: ReadReport,
  raw: CzReport,
  ctx: { importId: string; actorId: string },
): Promise<{ line: ReportLine; added: boolean; injectorCreated: boolean; waiting: boolean; conflict: boolean }> {
  const input = toTestInput(read, raw);
  const key = sourceKey(input);
  const base = { key, serial: read.serial, partNumber: read.partNumber, testedAt: read.testedAt };
  // A bench run and slot is stored once; the record never changes afterwards.
  const existing = await one<{ id: string; content_sha256: string }>(
    tx,
    'SELECT id, content_sha256 FROM injector_test WHERE bench_report_id = $1 AND bench_slot = $2',
    [read.reportId, read.slot],
  );
  if (existing) {
    const same = existing.content_sha256 === contentHash(input);
    return {
      line: { ...base, outcome: same ? 'DUPLICATE' : 'CONFLICT', reason: same ? 'Already imported; nothing changed' : 'The bench now reports different values for this run and slot; the original is kept unchanged', testId: existing.id },
      added: false,
      injectorCreated: false,
      waiting: false,
      conflict: !same,
    };
  }
  const match = await findBenchPart(tx, read.partNumber);
  if (!match.part) {
    await tx.query(
      `INSERT INTO bench_pending (source_key, part_number, serial_number, tested_at, reason, payload) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (source_key) DO UPDATE SET reason = EXCLUDED.reason, payload = EXCLUDED.payload, last_seen_at = now()`,
      [key, read.partNumber, read.serial, read.testedAt, match.reason, JSON.stringify(sanitiseReport(raw))],
    );
    return { line: { ...base, outcome: 'WAITING_FOR_PART', reason: `${match.reason}. Add it as an alias of the PDI part; the next sync imports it.` }, added: false, injectorCreated: false, waiting: true, conflict: false };
  }
  const inj = await ensureInjector(tx, match.part.id, read.serial, ctx.actorId);
  const testId = await insertTest(tx, input, { injectorId: inj.id, partId: match.part.id, origin: 'IMPORT', importId: ctx.importId, actorId: ctx.actorId });
  await tx.query('DELETE FROM bench_pending WHERE source_key = $1', [key]);
  return { line: { ...base, outcome: 'ADDED', testId }, added: true, injectorCreated: inj.created, waiting: false, conflict: false };
}

let syncRunning = false;

/**
 * "Sync now" (owner decision: on demand only, administrators). Fetches reports since the last sync,
 * applies the fixed exclusions, keeps the fetched reports (without job and customer fields) as the
 * import file, and stores every new injector result as an immutable test in one transaction.
 * Results whose part is not yet known wait in bench_pending and are retried on every sync.
 */
export async function syncBench(svc: Services, auth: AuthContext, requestId?: string): Promise<SyncOutcome> {
  if (syncRunning) throw conflict('A bench sync is already running; wait for it to finish');
  syncRunning = true;
  try {
    const startedAt = new Date();
    const setting = await one<{ value: { lastSync?: string } }>(svc.db, 'SELECT value FROM system_setting WHERE key = $1', [SETTING_KEY]);
    const last = setting?.value.lastSync ? new Date(setting.value.lastSync) : null;
    const dateFrom = last && !Number.isNaN(last.getTime()) ? new Date(last.getTime() - OVERLAP_MS).toISOString() : FIRST_SYNC_FROM;
    const fetched = await fetchAllReports(dateFrom);

    const eligible: Array<{ raw: CzReport; read: ReadReport }> = [];
    const lines: ReportLine[] = [];
    let excluded = 0;
    let unreadable = 0;
    for (const raw of fetched.reports) {
      const reasons = exclusionReasons(raw);
      if (reasons.length) {
        excluded += 1;
        lines.push({ key: reportKey(raw), outcome: 'EXCLUDED', reason: reasons.map((r) => EXCLUSION_TEXT[r]).join('; ') });
        continue;
      }
      const read = readReport(raw);
      if (!read.ok) {
        unreadable += 1;
        lines.push({ key: reportKey(raw), outcome: 'UNREADABLE', reason: read.reason });
        continue;
      }
      eligible.push({ raw, read: read.report });
    }
    const pending = await many<{ source_key: string; payload: CzReport }>(svc.db, 'SELECT source_key, payload FROM bench_pending ORDER BY tested_at');
    const fetchedKeys = new Set(eligible.map((e) => sourceKey(toTestInput(e.read, e.raw))));
    const retry = pending
      .filter((p) => !fetchedKeys.has(p.source_key))
      .map((p) => ({ raw: p.payload, read: readReport(p.payload) }))
      .filter((p): p is { raw: CzReport; read: { ok: true; report: ReadReport } } => p.read.ok)
      .map((p) => ({ raw: p.raw, read: p.read.report }));

    const outcome: SyncOutcome = {
      importNumber: null,
      fetched: fetched.reports.length,
      pages: fetched.pages,
      truncated: fetched.truncated,
      dateFrom,
      added: 0,
      duplicate: 0,
      conflict: 0,
      excluded,
      unreadable,
      waitingForPart: 0,
      pendingImported: 0,
      injectorsAdded: 0,
      // After an incomplete fetch the next sync continues from the newest test read, not from now.
      lastSync: fetched.truncated ? (fetched.newest ?? setting?.value.lastSync ?? FIRST_SYNC_FROM) : startedAt.toISOString(),
    };

    if (fetched.reports.length || retry.length) {
      // The import file is what this sync processed, without job or customer fields.
      const fileBytes = Buffer.from(
        JSON.stringify({ adapter: CARBONZAPP_ADAPTER, dateFrom, reports: fetched.reports.map(sanitiseReport), retriedFromPending: retry.map((r) => r.raw) }, null, 1),
      );
      const staged = await svc.storage.stageBuffer(fileBytes);
      const storageKey = await svc.storage.finalize(staged);
      try {
        await withTransaction(svc.db, async (tx) => {
          const importId = randomUUID();
          const number = await nextRecordNumber(tx, 'BI');
          const fileRow = await one<{ id: string }>(
            tx,
            `INSERT INTO file_object (kind, status, sha256, byte_size, mime_type, original_name, storage_key, uploaded_by)
             VALUES ('IMPORT','AVAILABLE',$1,$2,'application/json',$3,$4,$5) RETURNING id`,
            [staged.sha256, staged.size, `carbonzapp-sync-${startedAt.toISOString().slice(0, 19).replace(/[:T]/g, '')}.json`, storageKey, auth.userId],
          );
          for (const [list, fromPending] of [
            [eligible, false],
            [retry, true],
          ] as const) {
            for (const e of list) {
              const r = await storeTest(tx, e.read, e.raw, { importId, actorId: auth.userId });
              lines.push(fromPending ? { ...r.line, reason: [r.line.reason, 'retried from results waiting for a part'].filter(Boolean).join('; ') } : r.line);
              if (r.added) {
                outcome.added += 1;
                if (fromPending) outcome.pendingImported += 1;
              } else if (r.conflict) outcome.conflict += 1;
              else if (!r.waiting) outcome.duplicate += 1;
              if (r.injectorCreated) outcome.injectorsAdded += 1;
            }
          }
          outcome.waitingForPart = (await one<{ n: number }>(tx, 'SELECT count(*)::int AS n FROM bench_pending'))!.n;
          const prior = await one<{ number: string }>(tx, 'SELECT number FROM bench_import WHERE file_sha256 = $1 ORDER BY imported_at LIMIT 1', [staged.sha256]);
          const total = outcome.fetched + retry.length;
          await tx.query(
            `INSERT INTO bench_import (id, number, file_id, file_sha256, adapter, status, tests_total, tests_added, tests_duplicate, tests_conflict, tests_excluded, injectors_added, report, imported_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [
              importId,
              number,
              fileRow!.id,
              staged.sha256,
              CARBONZAPP_ADAPTER,
              prior ? 'DUPLICATE_FILE' : 'COMPLETED',
              total,
              outcome.added,
              outcome.duplicate,
              outcome.conflict,
              excluded + unreadable,
              outcome.injectorsAdded,
              JSON.stringify({
                priorImport: prior?.number ?? null,
                source: 'CarbonZapp API',
                dateFrom,
                pages: fetched.pages,
                truncated: fetched.truncated,
                waitingForPart: outcome.waitingForPart,
                tests: lines.slice(0, 5000),
              }),
              auth.userId,
            ],
          );
          await tx.query(`INSERT INTO evidence_link (file_id, entity_type, entity_id, caption, linked_by) VALUES ($1, 'BENCH_IMPORT', $2, $3, $4)`, [
            fileRow!.id,
            importId,
            'CarbonZapp reports fetched by this sync (job and customer fields removed)',
            auth.userId,
          ]);
          await tx.query(
            `INSERT INTO system_setting (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
            [SETTING_KEY, JSON.stringify({ lastSync: outcome.lastSync, lastImport: number })],
          );
          await audit(tx, {
            actorId: auth.userId,
            action: 'injector.bench_sync',
            entityType: 'bench_import',
            entityId: importId,
            summary: `${number}: CarbonZapp sync — ${outcome.fetched} fetched, ${outcome.added} added, ${outcome.duplicate} already present, ${outcome.conflict} conflicting, ${excluded + unreadable} excluded, ${outcome.waitingForPart} waiting for a part${fetched.truncated ? ' (fetch incomplete)' : ''}`,
            after: { ...outcome, importNumber: number },
            requestId,
          });
          outcome.importNumber = number;
        });
      } catch (err) {
        await svc.storage.removeOrphan(storageKey);
        throw err;
      }
    } else {
      await withTransaction(svc.db, async (tx) => {
        await tx.query(
          `INSERT INTO system_setting (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = system_setting.value || EXCLUDED.value, updated_at = now()`,
          [SETTING_KEY, JSON.stringify({ lastSync: outcome.lastSync })],
        );
        outcome.waitingForPart = (await one<{ n: number }>(tx, 'SELECT count(*)::int AS n FROM bench_pending'))!.n;
        await audit(tx, { actorId: auth.userId, action: 'injector.bench_sync', summary: 'CarbonZapp sync — no new bench reports', after: { ...outcome }, requestId });
      });
    }
    return outcome;
  } finally {
    syncRunning = false;
  }
}

export async function benchStatus(db: Queryable) {
  const cfg = benchConfig();
  const setting = await one<{ value: { lastSync?: string; lastImport?: string } }>(db, 'SELECT value FROM system_setting WHERE key = $1', [SETTING_KEY]);
  const waiting = await many<{ partNumber: string; count: number; reason: string; oldest: Date }>(
    db,
    `SELECT part_number AS "partNumber", count(*)::int AS count, max(reason) AS reason, min(tested_at) AS oldest
       FROM bench_pending GROUP BY part_number ORDER BY part_number`,
  );
  return {
    configured: Boolean(cfg.apiKey),
    host: new URL(cfg.baseUrl).host,
    lastSync: setting?.value.lastSync ?? null,
    lastImport: setting?.value.lastImport ?? null,
    exclusions: Object.values(EXCLUSION_TEXT),
    waiting,
  };
}
