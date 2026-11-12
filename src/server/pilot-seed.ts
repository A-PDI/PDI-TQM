import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { IMPACT_AREAS } from '../shared/quality.js';
import { many, one } from './db.js';
import { DEMO_USERS, type DemoKey, seedDemo } from './demo-seed.js';
import { makePng } from './fictional-image.js';
import type { Services } from './services.js';

/**
 * Pilot sample data for an isolated TEST environment (never production): fictional suppliers, parts
 * and sources (demo seed), the controlled templates copied from the approved set, and a realistic
 * spread of module records — some completed end to end with their controlled PDFs, the rest waiting
 * for the next step — so one person can click through every module.
 *
 * Every record is created through the application's own API as the demo persona who would do the
 * work, so each event opens its controlled record and every approval goes through the single
 * approval path, exactly as in use. Runs once: a marker in system_setting records the outcome.
 */
export const PILOT_MARKER = 'pilot_seed';

export interface PilotSeedOptions {
  password: string;
  /** Folder of approved controlled-template PDFs (owner file names) to import first; optional. */
  templatesDir?: string | null;
  log: { info: (obj: object, msg?: string) => void; warn: (obj: object, msg?: string) => void };
  /** Render queued controlled PDFs before returning (CLI). On boot the running job worker renders them. */
  drain?: boolean;
}

export interface PilotSeedResult {
  status: 'SEEDED' | 'SKIPPED';
  reason?: string;
  templates: { imported: number; failed: string[] };
  records: string[];
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

interface Session {
  call: (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, body?: unknown) => Promise<Json>;
  upload: (url: string, bytes: Buffer, filename: string, contentType: string) => Promise<Json>;
}

class SeedError extends Error {}

/** Signs in on first use, so a run that stops early does not spend sign-in attempts (rate limited). */
function lazySession(app: FastifyInstance, who: DemoKey, password: string): Session {
  let session: Promise<Session> | null = null;
  const get = () => (session ??= login(app, who, password));
  return {
    call: async (method, url, body) => (await get()).call(method, url, body),
    upload: async (url, bytes, filename, contentType) => (await get()).upload(url, bytes, filename, contentType),
  };
}

async function login(app: FastifyInstance, who: DemoKey, password: string): Promise<Session> {
  const user = DEMO_USERS.find((u) => u.key === who)!;
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: user.email, password } });
  if (res.statusCode !== 200) throw new SeedError(`Sign-in as ${user.name} failed (${res.statusCode}); is TQMS_DEMO_PASSWORD the demo password?`);
  const cookie = String(res.headers['set-cookie']).split(';')[0]!;
  const csrf = res.json().csrfToken as string;
  const check = (method: string, url: string, r: { statusCode: number; body: string }) => {
    if (r.statusCode >= 300) throw new SeedError(`${method} ${url} as ${user.name}: ${r.statusCode} ${r.body.slice(0, 400)}`);
    return r.body ? (JSON.parse(r.body) as Json) : {};
  };
  return {
    call: async (method, url, body) =>
      check(
        method,
        url,
        await app.inject({
          method,
          url,
          headers: { cookie, 'x-csrf-token': csrf, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
          payload: body === undefined ? undefined : JSON.stringify(body),
        }),
      ),
    upload: async (url, bytes, filename, contentType) => {
      const boundary = `----tqmpilot${Date.now()}`;
      const payload = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
        bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      return check('POST', url, await app.inject({ method: 'POST', url, headers: { cookie, 'x-csrf-token': csrf, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload }));
    },
  };
}

/** Realistic answers for entries the module does not hold (pilot illustrations, all fictional). */
const ANSWERS: Record<string, string> = {
  supplier_revision: 'C',
  sample_selection: 'Random 2 of 24 per incoming plan (fictional)',
  actual_ac: '0',
  actual_re: '1',
  lot_rule: 'Accept on zero nonconforming items',
  release_owner: 'Receiving lead',
  location: 'Receiving cage Q-1',
  equipment_id: 'MIC-0042',
  hold_location: 'Quarantine cage Q-2',
};

/** Fills the entries an event record still needs (choices take their first option; dates today). */
async function completeEntries(s: Session, recordId: string, today: string, extra: (data: Json) => void = () => undefined): Promise<Json> {
  const rec = await s.call('GET', `/api/controlled/records/${recordId}`);
  const data = structuredClone(rec.data);
  for (const f of rec.schema.fields) {
    if (f.role !== 'ENTRY' || f.requirement !== 'REQUIRED' || data.fields[f.key]) continue;
    data.fields[f.key] = f.input === 'choice' ? f.options[0] : f.input === 'date' ? today : (ANSWERS[f.key] ?? `NA - not applicable to this pilot record`).slice(0, f.maxLength ?? 80);
  }
  for (const sched of rec.schema.schedules) {
    const rows = (data.schedules[sched.key] ??= []);
    while (rows.length < (sched.rowLabels?.length ?? 0)) rows.push({});
    for (const row of rows) {
      for (const c of sched.columns) {
        if (c.requirement !== 'REQUIRED' || row[c.key]) continue;
        row[c.key] = c.input === 'choice' ? c.options[0] : c.input === 'date' ? today : (ANSWERS[c.key] ?? 'NA').slice(0, c.maxLength ?? 40);
      }
    }
  }
  extra(data);
  await s.call('PATCH', `/api/controlled/records/${recordId}`, { expectedVersion: rec.version, data });
  return s.call('GET', `/api/controlled/records/${recordId}`);
}

async function eventRecordId(s: Session, entityType: string, entityId: string, code: string): Promise<string> {
  const list = (await s.call('GET', `/api/controlled/records?entityType=${entityType}&entityId=${entityId}&typeCode=${code}`)) as unknown as Json[];
  const r = list.find((x) => x.eventBound && x.status !== 'VOID');
  if (!r) throw new SeedError(`${code} was not opened for ${entityType} ${entityId}`);
  return r.id as string;
}

async function importTemplates(admin: Session, dir: string, effectiveFrom: string, log: PilotSeedOptions['log']) {
  const out = { imported: 0, failed: [] as string[] };
  let names: string[];
  try {
    names = (await readdir(dir)).filter((n) => n.toLowerCase().endsWith('.pdf')).sort();
  } catch (err) {
    log.warn({ dir, err: (err as Error).message }, 'pilot seed: template folder not readable');
    return out;
  }
  for (const name of names) {
    try {
      await admin.upload(`/api/documents/import?effectiveFrom=${effectiveFrom}`, await readFile(path.join(dir, name)), name, 'application/pdf');
      out.imported += 1;
    } catch (err) {
      out.failed.push(`${name}: ${(err as Error).message.slice(0, 160)}`);
    }
  }
  return out;
}

export async function seedPilot(app: FastifyInstance, svc: Services, opts: PilotSeedOptions): Promise<PilotSeedResult> {
  const { db, config } = svc;
  if (config.appEnv === 'production') throw new Error('Pilot sample data may not be seeded into production');
  if (opts.password.length < 12) throw new Error('TQMS_DEMO_PASSWORD (12+ characters) is required for the pilot seed');
  const prior = await one<{ value: Json }>(db, 'SELECT value FROM system_setting WHERE key = $1', [PILOT_MARKER]);
  if (prior) return { status: 'SKIPPED', reason: `already ${String(prior.value.status ?? 'seeded').toLowerCase()} (${String(prior.value.at ?? '')})`, templates: { imported: 0, failed: [] }, records: [] };

  const storage = await svc.storage.check();
  if (!storage.ok) throw new Error(`Evidence storage is not ready (${storage.reason}); the pilot seed stores documents and PDFs there`);
  await seedDemo(db, opts.password);
  const today = (await one<{ d: string }>(db, `SELECT (now() AT TIME ZONE $1)::date::text AS d`, [config.displayTimeZone]))!.d;
  const s = Object.fromEntries(DEMO_USERS.map((u) => [u.key, lazySession(app, u.key, opts.password)] as const)) as Record<DemoKey, Session>;
  const templates = opts.templatesDir ? await importTemplates(s.admin, opts.templatesDir, today, opts.log) : { imported: 0, failed: [] };

  // Sample events need their controlled forms in force; otherwise they would be recorded without them.
  const needed = ['INT-01', 'OPS-02', 'OPS-04', 'OPS-05', 'OPS-06', 'OPS-07', 'VAL-02'];
  const inForce = await many<{ number: string }>(
    db,
    `SELECT DISTINCT d.number FROM controlled_document d JOIN controlled_document_revision r ON r.document_id = d.id WHERE d.number = ANY($1::text[]) AND r.effective_from <= $2`,
    [needed, today],
  );
  const missing = needed.filter((c) => !inForce.some((x) => x.number === c));
  if (missing.length) {
    const reason = `controlled templates not in force: ${missing.join(', ')}. Import the approved templates (Documents → Import, or PILOT_TEMPLATES_DIR) and restart.`;
    opts.log.warn({ missing }, `pilot seed waiting: ${reason}`);
    return { status: 'SKIPPED', reason, templates, records: [] };
  }

  await db.query(`INSERT INTO system_setting (key, value) VALUES ($1, $2)`, [PILOT_MARKER, JSON.stringify({ status: 'IN_PROGRESS', at: new Date().toISOString(), fictional: true })]);
  const records: string[] = [];
  try {
    const ids = await lookups(s);

    // Sourcing: a Path B second-source request; INT-01 opens with it for the intake decision.
    const sr = await s.purchasing.call('POST', '/api/sourcing', { title: 'Second source for piston ring kits (pilot)', pathway: 'B', partId: ids.ringPart, supplierId: ids.nwr, siteId: ids.nwrP2, supplierPartNumber: 'NR-3003-P2', description: 'Rebuild-kit ring sets for 6-cylinder heads (fictional)', commercialRationale: 'Single-source risk on ring kits (fictional)' });
    records.push(`${sr.number} with ${sr.controlled?.number ?? 'no INT-01'} (draft)`);

    // Inspection completed end to end: OPS-02 completed with the inspection, approved by the review.
    const ok1 = await inspect(s.inspector, ids, 'PILOT-101', 'PO-PILOT-101', today, false);
    await completeEntries(s.inspector, await eventRecordId(s.inspector, 'INSPECTION', ok1.id, 'OPS-02'), today);
    await s.inspector.call('POST', `/api/inspections/${ok1.id}/complete`, { expectedVersion: (await s.inspector.call('GET', `/api/inspections/${ok1.id}`)).version });
    await s.quality.call('POST', `/api/inspections/${ok1.id}/review`, { decision: 'CONFIRM', comment: 'Lot accepted on zero defects (pilot)', expectedVersion: (await s.quality.call('GET', `/api/inspections/${ok1.id}`)).version });
    records.push(`${ok1.number} completed; OPS-02 approved by Casey Morgan`);

    // Inspection in progress (Sam Okafor): its OPS-02 is open for completion.
    const wip = await s.inspector2.call('POST', '/api/inspections', { partId: ids.ringPart, formRevisionId: ids.ringForm, unitCount: 3, poNumber: 'PO-PILOT-102', dateReceived: today, sourceId: ids.ringSource, lotNumber: 'PILOT-102' });
    await s.inspector2.call('POST', `/api/inspections/${wip.id}/pass-all`, { expectedVersion: (await s.inspector2.call('GET', `/api/inspections/${wip.id}`)).version, unitIndex: 0, sectionKey: 'A', mode: 'fill_blank' });
    records.push(`${wip.number} in progress (OPS-02 draft)`);

    // Failed lot → concern → NCR with contained material; OPS-06 opens with the NCR.
    const bad = await inspect(s.inspector, ids, 'PILOT-103', 'PO-PILOT-103', today, true);
    await completeEntries(s.inspector, await eventRecordId(s.inspector, 'INSPECTION', bad.id, 'OPS-02'), today);
    await s.inspector.call('POST', `/api/inspections/${bad.id}/complete`, { expectedVersion: (await s.inspector.call('GET', `/api/inspections/${bad.id}`)).version });
    const concern = await s.inspector.call('POST', `/api/inspections/${bad.id}/concerns`, { unitIndex: 2, sectionKey: 'B', rowKey: 'running_face_coating', ownerId: ids.users.quality });
    await s.quality.call('POST', `/api/inspections/${bad.id}/review`, { decision: 'CONFIRM', comment: 'Lot held pending NCR (pilot)', expectedVersion: (await s.quality.call('GET', `/api/inspections/${bad.id}`)).version });
    await s.quality.call('POST', `/api/quality/events/${concern.id}/triage`, { expectedVersion: 1, decision: 'TRIAGED', ownerId: ids.users.quality, severity: 'HIGH' });
    const ncr = await s.manager.call('POST', `/api/quality/events/${concern.id}/confirm-ncr`, { expectedVersion: 2, severity: 'HIGH', ownerId: ids.users.quality, failureMode: 'Missing running-face coating', rationale: 'Coating absent on item 2 (pilot)' });
    const scope = await s.quality.call('POST', `/api/ncrs/${ncr.id}/scopes`, { label: 'Ring kits on shelf R-7', lotNumber: 'PILOT-103', poNumber: 'PO-PILOT-103', inspectionId: bad.id, quantity: 2, serialNumbers: ['PILOT-103-1', 'PILOT-103-2'], location: 'Receiving shelf R-7', containmentAction: 'Red tag, quarantine cage Q-2' });
    await s.manager.call('POST', `/api/scopes/${scope.id}/authorize-containment`, { note: 'Hold both kits (pilot)' });
    await s.quality.call('POST', `/api/scopes/${scope.id}/verify-segregation`, { note: 'Tagged and caged in Q-2 (pilot)' });
    records.push(`${bad.number} failed and held; ${ncr.number} contained, awaiting disposition (OPS-06 draft)`);

    // SCAR to the supplier, with its response recorded; OPS-07 opens with the SCAR.
    const scar = await s.purchasing.call('POST', '/api/scars', { ncrIds: [ncr.id], supplierId: ids.nwr, partId: ids.ringPart, title: 'Missing running-face coating (pilot)', problemStatement: 'Ring kits received without running-face coating on lot PILOT-103 (fictional).', requestedActions: 'Containment, verified root cause, corrective action and evidence', sentTo: 'Quality manager, Northwind Rings (fictional)', sentVia: 'EMAIL', responseDue: addDays(today, 14), ownerId: ids.users.purchasing });
    await s.purchasing.call('POST', `/api/scars/${scar.id}/responses`, { receivedAt: today, channel: 'EMAIL', representative: 'R. Okoye (fictional)', containment: 'Supplier stock purged and recoated (fictional)', rootCause: 'Masking fixture step skipped on line 2 (fictional)', correctiveAction: 'Fixture interlock added to the router (fictional)' });
    records.push(`${scar.number} response received (OPS-07 draft)`);

    // Concession awaiting decision: OPS-05 submitted; Engineering concurrence and the decision remain.
    const devOpen = await s.inspector.call('POST', '/api/concessions', concession(ids.ringPart, 'PILOT-104', today));
    await completeEntries(s.inspector, devOpen.controlled.id, today);
    await s.inspector.call('POST', `/api/controlled/records/${devOpen.controlled.id}/submit`, { expectedVersion: (await s.inspector.call('GET', `/api/controlled/records/${devOpen.controlled.id}`)).version });
    records.push(`${devOpen.number} submitted; awaiting Engineering concurrence and decision`);

    // Concession completed end to end: concurrence, then the concession decision signs OPS-05.
    const devDone = await s.inspector.call('POST', '/api/concessions', concession(ids.ringPart, 'PILOT-105', today));
    await completeEntries(s.inspector, devDone.controlled.id, today);
    await s.inspector.call('POST', `/api/controlled/records/${devDone.controlled.id}/submit`, { expectedVersion: (await s.inspector.call('GET', `/api/controlled/records/${devDone.controlled.id}`)).version });
    await s.engineering.call('POST', `/api/controlled/records/${devDone.controlled.id}/sign`, { expectedVersion: (await s.engineering.call('GET', `/api/controlled/records/${devDone.controlled.id}`)).version, step: 'approver1', statement: 'Wall thickness effect assessed as negligible (pilot)' });
    await s.manager.call('POST', `/api/concessions/${devDone.id}/decide`, { decision: 'APPROVED', rationale: 'Within engineering limits for rebuild kits (pilot)', expectedVersion: (await s.manager.call('GET', `/api/concessions/${devDone.id}`)).concession.version });
    records.push(`${devDone.number} approved; OPS-05 completed`);

    // First article registered and measured: VAL-02 opens with the sample.
    const fai = await s.purchasing.call('POST', `/api/sources/${ids.ringSource}/fai`, { sampleType: 'PRODUCTION_REPRESENTATIVE', receivedDate: today, serialNumbers: 'FA-PILOT-01', lotNumber: 'PILOT-FAI-1' });
    await s.purchasing.call('PUT', `/api/fai/${fai.id}/results`, { results: [{ charKey: 'free_end_gap', value: '10.10' }, { charKey: 'installed_end_gap', value: '0.50' }, { charKey: 'axial_width', value: '2.981' }, { charKey: 'radial_wall', value: '4.22' }] });
    records.push(`${fai.number} measured (VAL-02 draft)`);

    // Change proposed and assessed: OPS-04 opens with it.
    const chg = await s.purchasing.call('POST', '/api/changes', { origin: 'PDI', title: 'Tighten radial wall tolerance (pilot)', description: 'Tighten the radial wall tolerance on ring kits (fictional)', justification: 'Field wear data (fictional)', categories: ['DIMENSION'], partId: ids.ringPart, sourceIds: [], ownerId: ids.users.purchasing });
    await s.purchasing.call('PUT', `/api/changes/${chg.id}/impact`, { expectedVersion: (await s.purchasing.call('GET', `/api/changes/${chg.id}`)).change.version, summary: 'Specification only; no requalification (fictional)', requalificationRequired: false, items: IMPACT_AREAS.map((area) => ({ area, affected: false, assessment: 'Not affected (fictional)' })) });
    records.push(`${chg.number} impact assessed (OPS-04 draft)`);

    if (opts.drain) await svc.worker?.drain();
    await db.query(`UPDATE system_setting SET value = $2, updated_at = now() WHERE key = $1`, [PILOT_MARKER, JSON.stringify({ status: 'SEEDED', at: new Date().toISOString(), fictional: true, templates, records })]);
    return { status: 'SEEDED', templates, records };
  } catch (err) {
    await db.query(`UPDATE system_setting SET value = $2, updated_at = now() WHERE key = $1`, [PILOT_MARKER, JSON.stringify({ status: 'FAILED', at: new Date().toISOString(), error: (err as Error).message.slice(0, 1000), records })]);
    throw err;
  }
}

const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

const concession = (partId: string, lot: string, today: string) => ({
  partId,
  lotNumber: lot,
  quantityLimit: 4,
  characteristic: 'Radial wall thickness',
  permittedException: '4.32 mm accepted for this lot (fictional)',
  conditions: 'Rebuild kits only',
  justification: 'Engineering assessed negligible effect on seal (fictional)',
  validFrom: today,
  validUntil: addDays(today, 30),
});

interface Ids {
  ringPart: string;
  ringForm: string;
  ringSource: string;
  nwr: string;
  nwrP2: string;
  users: { quality: string; purchasing: string };
}

async function lookups(s: Record<DemoKey, Session>): Promise<Ids> {
  const parts = (await s.inspector.call('GET', '/api/parts?q=TQ-PRK-3003')) as unknown as Json[];
  const ringPart = parts[0]?.id as string | undefined;
  if (!ringPart) throw new SeedError('Demo part TQ-PRK-3003 not found');
  const forms = (await s.inspector.call('GET', '/api/forms')) as unknown as Json[];
  const ringForm = forms.find((f) => f.formNumber === 'PDI-IQI-004')?.revisionId as string | undefined;
  if (!ringForm) throw new SeedError('Inspection form PDI-IQI-004 is not released');
  const options = await s.inspector.call('GET', `/api/parts/${ringPart}/launch-options`);
  const suppliers = (await s.purchasing.call('GET', '/api/suppliers')) as unknown as Json[];
  const nwr = suppliers.find((x) => x.code === 'NWR')?.id as string;
  const detail = await s.purchasing.call('GET', `/api/suppliers/${nwr}`);
  const nwrP2 = (detail.sites as Json[]).find((x) => x.code === 'P2')?.id as string;
  const ringSource = (options.sources as Json[])[0]?.id as string;
  const me = async (k: DemoKey) => (await s[k].call('GET', '/api/auth/me')).user.id as string;
  return { ringPart, ringForm, ringSource, nwr, nwrP2, users: { quality: await me('quality'), purchasing: await me('purchasing') } };
}

/** A two-item ring-kit inspection with all answers and readings; optionally one failed coating with its photo. */
async function inspect(s: Session, ids: Ids, lot: string, po: string, today: string, fail: boolean): Promise<Json> {
  const insp = await s.call('POST', '/api/inspections', { partId: ids.ringPart, formRevisionId: ids.ringForm, unitCount: 2, poNumber: po, dateReceived: today, sourceId: ids.ringSource, lotNumber: lot });
  const v = async () => (await s.call('GET', `/api/inspections/${insp.id}`)).version as number;
  await s.call('POST', `/api/inspections/${insp.id}/pass-all`, { expectedVersion: await v(), unitIndex: 0, sectionKey: 'A', mode: 'fill_blank' });
  for (const u of [1, 2]) {
    await s.call('POST', `/api/inspections/${insp.id}/pass-all`, { expectedVersion: await v(), unitIndex: u, sectionKey: 'B', mode: 'fill_blank' });
    const readings = { free_end_gap_relaxed: '10.05', installed_end_gap: '0.52', axial_width_ring_height: '2.980', radial_wall_thickness: '4.20' };
    await s.call('PATCH', `/api/inspections/${insp.id}/entries`, { expectedVersion: await v(), changes: Object.entries(readings).map(([rowKey, a1]) => ({ unitIndex: u, sectionKey: 'C', rowKey, status: 'P', readings: { a1 } })), units: [{ unitIndex: u, serialNumber: `${lot}-${u}` }] });
  }
  if (fail) {
    await s.call('PATCH', `/api/inspections/${insp.id}/entries`, { expectedVersion: await v(), changes: [{ unitIndex: 2, sectionKey: 'B', rowKey: 'running_face_coating', status: 'F', note: 'Running face uncoated (pilot)' }] });
    await s.upload(`/api/inspections/${insp.id}/photos?unitIndex=2&sectionKey=B&rowKey=running_face_coating`, makePng(120, 80, [150, 40, 40]), 'coating.png', 'image/png');
  }
  return insp;
}
