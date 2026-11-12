import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { IMPACT_AREAS } from '../shared/quality.js';
import { many, one } from './db.js';
import { DEMO_USERS, type DemoKey, seedDemo } from './demo-seed.js';
import { makePng } from './fictional-image.js';
import { SCS001_CLAUSES, syntheticMsa001, syntheticScs001, syntheticSignedCopy } from './agreements/synthetic-documents.js';
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
  /** Persona sessions shared between pilot stages, so sign-ins stay under the login rate limit. */
  sessions?: PilotSessions;
}

export type PilotSessions = Record<DemoKey, Session>;

/** One lazily signed-in session per demo persona. */
export function pilotSessions(app: FastifyInstance, password: string): PilotSessions {
  return Object.fromEntries(DEMO_USERS.map((u) => [u.key, lazySession(app, u.key, password)] as const)) as PilotSessions;
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
  const s = opts.sessions ?? pilotSessions(app, opts.password);
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

// ---------------------------------------------------------------- supplier agreements (own marker)
export const PILOT_AGREEMENTS_MARKER = 'pilot_agreements';

/**
 * Fictional supplier-agreement history for the TEST environment, created through the API as the
 * personas would: synthetic MSA-001 and SCS-001 (revision labels prefixed S, so PDI's approved
 * files import later as ordinary revisions), an executed agreement for Bluestone Castings that a
 * renewal supersedes, a newer SCS-001 revision with its impact review, an executed amendment
 * incorporating it, and a draft for Northwind. It needs no controlled templates. Runs once.
 */
export async function seedPilotAgreements(app: FastifyInstance, svc: Services, opts: PilotSeedOptions): Promise<PilotSeedResult> {
  const { db, config } = svc;
  if (config.appEnv === 'production') throw new Error('Pilot sample data may not be seeded into production');
  if (opts.password.length < 12) throw new Error('TQMS_DEMO_PASSWORD (12+ characters) is required for the pilot seed');
  const none = { imported: 0, failed: [] as string[] };
  const prior = await one<{ value: Json }>(db, 'SELECT value FROM system_setting WHERE key = $1', [PILOT_AGREEMENTS_MARKER]);
  if (prior) return { status: 'SKIPPED', reason: `agreements already ${String(prior.value.status ?? 'seeded').toLowerCase()} (${String(prior.value.at ?? '')})`, templates: none, records: [] };
  const storage = await svc.storage.check();
  if (!storage.ok) throw new Error(`Evidence storage is not ready (${storage.reason})`);
  await seedDemo(db, opts.password);
  const s = opts.sessions ?? pilotSessions(app, opts.password);
  const today = (await one<{ d: string }>(db, `SELECT (now() AT TIME ZONE $1)::date::text AS d`, [config.displayTimeZone]))!.d;
  const earlier = addDays(today, -30);
  await db.query(`INSERT INTO system_setting (key, value) VALUES ($1, $2)`, [PILOT_AGREEMENTS_MARKER, JSON.stringify({ status: 'IN_PROGRESS', at: new Date().toISOString(), fictional: true })]);
  const records: string[] = [];
  try {
    // Document Control: synthetic documents, their classification and SCS-001 clauses.
    const msa = await s.admin.upload(`/api/documents/import?effectiveFrom=${earlier}`, await syntheticMsa001('S01'), 'MSA-001_Master_Supplier_Agreement_RevS01.pdf', 'application/pdf');
    const scs = await s.admin.upload(`/api/documents/import?effectiveFrom=${earlier}`, await syntheticScs001('S1.0'), 'SCS-001_Cast_Component_Quality_Identification_Standard_RevS1.0.pdf', 'application/pdf');
    await s.admin.call('PUT', `/api/documents/${msa.documentId}/classification`, { classification: 'MASTER_AGREEMENT', scopeNote: 'Synthetic proposed structure; legal text to be supplied by PDI counsel' });
    await s.admin.call('PUT', `/api/documents/${scs.documentId}/classification`, { classification: 'TECHNICAL_SPECIFICATION', categoryCode: 'CASTING', processes: ['Casting'], productFamilies: ['Cylinder heads'], scopeNote: 'Synthetic stand-in for SCS-001' });
    const clauses = SCS001_CLAUSES.map((c) => ({ clauseRef: c.ref, title: c.title }));
    if (scs.revisionId) await s.admin.call('POST', `/api/document-revisions/${scs.revisionId}/clauses`, { clauses });
    records.push('MSA-001 Rev S01 and SCS-001 Rev S1.0 (synthetic) imported and classified');

    // Master data: the cylinder head is a casting.
    const head = ((await s.purchasing.call('GET', '/api/parts?q=TQ-CYH-4004')) as unknown as Json[]).find((p) => p.partNumber === 'TQ-CYH-4004');
    if (!head) throw new SeedError('Demo part TQ-CYH-4004 not found');
    await s.purchasing.call('PUT', `/api/parts/${head.id}/classification`, { material: 'Gray iron (fictional)', manufacturingProcess: 'Casting' });
    const suppliers = (await s.purchasing.call('GET', '/api/suppliers')) as unknown as Json[];
    const bsc = suppliers.find((x) => x.code === 'BSC')?.id as string | undefined;
    const nwr = suppliers.find((x) => x.code === 'NWR')?.id as string | undefined;
    if (!bsc || !nwr) throw new SeedError('Demo suppliers BSC and NWR not found');
    const bscFa = ((await s.purchasing.call('GET', `/api/suppliers/${bsc}`)).sites as Json[]).find((x) => x.code === 'FA')?.id as string;
    const nwrP1 = ((await s.purchasing.call('GET', `/api/suppliers/${nwr}`)).sites as Json[]).find((x) => x.code === 'P1')?.id as string;

    const version = async (id: string) => (await s.purchasing.call('GET', `/api/agreements/${id}`)).agreement.version as number;
    const approveAndExecute = async (id: string, number: string, effectiveFrom: string) => {
      await s.purchasing.call('POST', `/api/agreements/${id}/submit`, { version: await version(id) });
      await s.quality.call('POST', `/api/agreements/${id}/approve`, {
        version: await version(id),
        legalReviewer: 'Fictional counsel (test environment)',
        legalReference: 'PILOT-LR — fictional legal review, no legal effect',
        legalReviewedOn: today,
      });
      const signed = await s.purchasing.upload(`/api/evidence/SUPPLIER_AGREEMENT/${id}?caption=${encodeURIComponent('Signed agreement (fictional)')}`, await syntheticSignedCopy(number, today), `${number}-signed-fictional.pdf`, 'application/pdf');
      await s.purchasing.call('POST', `/api/agreements/${id}/execution`, {
        version: await version(id),
        signedFileId: signed.fileId,
        effectiveFrom,
        pdiSignatory: { name: 'Jamie Example (fictional)', title: 'Director of Supply Chain (fictional)', signedOn: today },
        supplierSignatory: { name: 'Robin Sample (fictional)', title: 'President, Bluestone Castings (fictional)', signedOn: today },
      });
    };
    const fromRecommendations = async (id: string) => {
      const recs = (await s.purchasing.call('GET', `/api/agreements/${id}/recommendations`)) as unknown as Json[];
      await s.purchasing.call('PUT', `/api/agreements/${id}/documents`, {
        version: await version(id),
        lines: recs.map((r) => ({ role: r.role, documentRevisionId: r.documentRevisionId ?? null, baselineRevisionId: r.baselineRevisionId ?? null, contractualRef: r.contractualRef, partIds: r.partIds, precedence: r.precedence })),
      });
      return recs.map((r) => `${r.documentNumber} Rev ${r.revisionLabel}`);
    };

    // 1. Original agreement for Bluestone Castings, executed (later superseded by its renewal).
    const first = await s.purchasing.call('POST', `/api/suppliers/${bsc}/agreements`, { title: 'Supply agreement — cylinder head castings (pilot)', siteIds: [bscFa], productFamilies: ['Cylinder heads'], expiresOn: addDays(today, 365) });
    const docs1 = await fromRecommendations(first.id);
    await approveAndExecute(first.id, first.number, earlier);
    records.push(`${first.number} executed (${docs1.join(', ')})`);

    // 2. Renewal, executed: supersedes the original, which stays on record.
    const renewal = await s.purchasing.call('POST', `/api/agreements/${first.id}/renewal`, { expiresOn: addDays(today, 3 * 365) });
    await approveAndExecute(renewal.id, renewal.number, today);
    records.push(`${renewal.number} renewal executed; ${first.number} superseded`);

    // 3. SCS-001 Rev S1.1 released: the executed renewal is unchanged and gets a revision review.
    const rev = await s.admin.upload(
      `/api/documents/${scs.documentId}/revisions?revisionLabel=S1.1&effectiveFrom=${today}&changeSummary=${encodeURIComponent('Synthetic clarification for the pilot')}`,
      await syntheticScs001('S1.1'),
      'SCS-001_Cast_Component_Quality_Identification_Standard_RevS1.1.pdf',
      'application/pdf',
    );
    await s.admin.call('POST', `/api/document-revisions/${rev.revisionId}/clauses`, { clauses });
    records.push(`SCS-001 Rev S1.1 released; ${rev.impactedAgreements} agreement(s) flagged for revision review`);

    // 4. Amendment incorporating the new revision, executed.
    const amendment = await s.purchasing.call('POST', `/api/agreements/${renewal.id}/amendments`, { changeSummary: 'Incorporate SCS-001 Rev S1.1 for cylinder head castings (pilot)' });
    await s.purchasing.call('PUT', `/api/agreements/${amendment.id}/documents`, {
      version: await version(amendment.id),
      lines: [{ role: 'SPECIFICATION', action: 'REPLACE', documentRevisionId: rev.revisionId, contractualRef: 'Schedule B1', partIds: [head.id] }],
    });
    await approveAndExecute(amendment.id, amendment.number, today);
    records.push(`${amendment.number} amendment executed (SCS-001 Rev S1.1)`);

    // 5. A draft for Northwind, waiting for its documents.
    const draft = await s.purchasing.call('POST', `/api/suppliers/${nwr}/agreements`, { title: 'Supply agreement — piston ring kits (pilot draft)', siteIds: [nwrP1], productFamilies: ['Rings'] });
    await s.purchasing.call('PUT', `/api/agreements/${draft.id}/documents`, { version: await version(draft.id), lines: [{ role: 'MASTER_AGREEMENT', documentRevisionId: msa.revisionId, contractualRef: 'Agreement' }] });
    records.push(`${draft.number} draft for Northwind`);

    if (opts.drain) await svc.worker?.drain();
    await db.query(`UPDATE system_setting SET value = $2, updated_at = now() WHERE key = $1`, [PILOT_AGREEMENTS_MARKER, JSON.stringify({ status: 'SEEDED', at: new Date().toISOString(), fictional: true, records })]);
    return { status: 'SEEDED', templates: none, records };
  } catch (err) {
    await db.query(`UPDATE system_setting SET value = $2, updated_at = now() WHERE key = $1`, [PILOT_AGREEMENTS_MARKER, JSON.stringify({ status: 'FAILED', at: new Date().toISOString(), error: (err as Error).message.slice(0, 1000), records })]);
    throw err;
  }
}
