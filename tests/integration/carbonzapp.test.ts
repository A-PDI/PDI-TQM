import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { type IncomingMessage, type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { CzReport } from '../../src/shared/carbonzapp.js';
import { type Harness, type Session, passAll, startHarness, version } from './harness.js';

/**
 * CarbonZapp bench sync and inspections started from bench results (owner decisions 22 Oct 2026).
 * A local server stands in for cloudx.carbonzapp.com; the payloads are the fixture's fictional copy
 * of the owner's two-injector sample.
 */
const KEY = 'test-only-carbonzapp-key';
const sample = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../fixtures/carbonzapp-sample.json'), 'utf8')) as CzReport[];
const report = (id: string, slot: number, sn: string, datetime: string, patch: (r: CzReport) => void = () => undefined): CzReport => {
  const r = JSON.parse(JSON.stringify(sample[slot === 0 ? 0 : 1])) as CzReport;
  r._id = id;
  r.SlotsData = { ...r.SlotsData, position: slot, sn };
  r.datetime = datetime;
  patch(r);
  return r;
};

let h: Harness;
let admin: Session;
let inspector: Session;
let quality: Session;
let server: Server;
let requests: Array<{ auth: string | undefined; body: Record<string, unknown> }>;
let respond: (body: Record<string, unknown>) => { status: number; body: string; type?: string };
let bench: CzReport[];

/** Serves `bench` like the real API: oldest first, inclusive date_from, a small page (three reports). */
const pagedBench = (body: Record<string, unknown>) => {
  const from = typeof body.date_from === 'string' ? new Date(body.date_from).getTime() : -Infinity;
  const page = bench
    .filter((r) => new Date(String(r.datetime)).getTime() >= from)
    .sort((a, b) => String(a.datetime).localeCompare(String(b.datetime)))
    .slice(0, 3);
  return { status: 200, body: JSON.stringify(page) };
};

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });

beforeAll(async () => {
  h = await startHarness();
  [admin, inspector, quality] = await Promise.all([h.login('admin'), h.login('inspector'), h.login('quality')]);
  server = createServer(async (req, res) => {
    const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
    requests.push({ auth: req.headers.authorization, body });
    if (req.url !== '/userapi/v1/client/getReports' || req.method !== 'POST') {
      res.writeHead(404).end('not found');
      return;
    }
    const out = respond(body);
    res.writeHead(out.status, { 'content-type': out.type ?? 'application/json' }).end(out.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  process.env.CARBONZAPP_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  delete process.env.CARBONZAPP_BASE_URL;
  delete process.env.CARBONZAPP_API_KEY;
  await new Promise((resolve) => server?.close(resolve));
  await h?.close();
});
beforeEach(() => {
  requests = [];
  respond = pagedBench;
  process.env.CARBONZAPP_API_KEY = KEY;
});

const sync = () => admin.send('POST', '/api/injectors/bench/sync', {});
const benchTests = async (qs = '') => (await admin.get(`/api/injectors/bench/tests${qs}`)).json as Array<{ id: string; serial: string; outcome: string; partNumber: string; inspection: unknown }>;

describe('Sync now', () => {
  it('is for administrators and needs the server key', async () => {
    expect((await inspector.send('POST', '/api/injectors/bench/sync', {})).status).toBe(403);
    expect((await quality.get('/api/injectors/bench')).status).toBe(403);
    delete process.env.CARBONZAPP_API_KEY;
    expect((await admin.get('/api/injectors/bench')).json).toMatchObject({ configured: false, lastSync: null });
    const r = await sync();
    expect(r.status).toBe(400);
    expect(r.json.error).toMatchObject({ code: 'NO_API_KEY' });
    expect(requests).toHaveLength(0);
  });

  it('imports new results, excludes repair serials and RMA jobs, and holds unknown parts', async () => {
    bench = [
      report('run-0001', 0, 'TQ-SN-0455', '2026-06-30T13:40:56+00:00'),
      report('run-0001', 2, 'TQ-SN-0447', '2026-06-30T13:40:56+00:00'),
      report('run-0002', 0, 'R-TQ-0001', '2026-07-01T09:00:00+00:00'),
      report('run-0002', 2, 'TQ-SN-0900', '2026-07-01T09:00:00+00:00', (r) => {
        r.job = 'RMA-77';
        r.customer_name = 'Someone';
      }),
      report('run-0003', 0, 'TQ-SN-0901', '2026-07-02T09:00:00+00:00', (r) => {
        r.actuator_code = 'ZZ123PX';
      }),
    ];
    const r = await sync();
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ fetched: 5, added: 2, duplicate: 0, conflict: 0, excluded: 2, unreadable: 0, waitingForPart: 1, dateFrom: '2000-01-01T00:00:00.000Z', truncated: false });
    expect(r.json.importNumber).toMatch(/^BI-/);
    // Key sent as the Bearer token and in the body; the first sync asks for everything since 2000.
    expect(requests[0]).toEqual({ auth: `Bearer ${KEY}`, body: { api_key: KEY, date_from: '2000-01-01T00:00:00.000Z' } });
    expect(requests.length).toBeGreaterThan(1);
    expect(requests[1]!.body.date_from).toBe('2026-07-01T09:00:00.000Z');

    const list = await benchTests();
    expect(list.map((x) => [x.serial, x.outcome, x.partNumber]).sort()).toEqual([
      ['TQ-SN-0447', 'PASS', 'TQ-INJ-9009'],
      ['TQ-SN-0455', 'PASS', 'TQ-INJ-9009'],
    ]);
    const stored = (await h.pool.query(`SELECT t.raw, t.bench_report_id, t.bench_slot, t.machine_id, t.test_plan, bi.adapter FROM injector_test t JOIN bench_import bi ON bi.id = t.import_id ORDER BY t.bench_slot`)).rows;
    expect(stored[0]).toMatchObject({ bench_report_id: 'run-0001', bench_slot: 0, machine_id: '000000001', test_plan: 'Cummins XPI-CRIN', adapter: 'CARBONZAPP-API-1' });
    expect(Object.keys(stored[0].raw)).not.toContain('job');
    const results = (await h.pool.query(`SELECT r.condition, r.parameter, r.value_text, r.bench_lower::text, r.bench_upper::text, r.bench_outcome, r.machine_verdict FROM injector_test_result r JOIN injector_test t ON t.id = r.test_id WHERE t.bench_slot = 0 AND t.bench_report_id = 'run-0001' ORDER BY r.position`)).rows;
    expect(results).toHaveLength(12);
    expect(results[3]).toEqual({ condition: 'Peak HP', parameter: 'Delivery', value_text: '230.3', bench_lower: '220.9', bench_upper: '249.1', bench_outcome: 'PASS', machine_verdict: 'PASS' });

    // The import file keeps what was fetched, without job or customer fields.
    const file = (await h.pool.query(`SELECT f.id FROM bench_import bi JOIN file_object f ON f.id = bi.file_id WHERE bi.number = $1`, [r.json.importNumber])).rows[0];
    const bytes = (await admin.get(`/api/files/${file.id}`)).raw.toString('utf8');
    expect(bytes).toContain('run-0002');
    expect(bytes).not.toMatch(/RMA-77|Someone|customer_name/);

    const status = (await admin.get('/api/injectors/bench')).json;
    expect(status).toMatchObject({ configured: true, lastImport: r.json.importNumber, waiting: [{ partNumber: 'ZZ123PX', count: 1 }] });
    expect(status.waiting[0].reason).toMatch(/not a PDI part number or alias/);
  });

  it('re-reads the last five minutes and never changes a stored result', async () => {
    const last = (await admin.get('/api/injectors/bench')).json.lastSync as string;
    bench = [
      report('run-0001', 0, 'TQ-SN-0455', '2026-06-30T13:40:56+00:00', (r) => {
        r.AllTests!.find((t) => t.TestInfo?.test_name === 'iVM.03')!.PrimaryTank!.AvrResult = '12.9';
      }),
      report('run-0001', 2, 'TQ-SN-0447', '2026-06-30T13:40:56+00:00'),
    ];
    respond = (body) => (body.date_from ? pagedBench({}) : { status: 500, body: 'expected a date filter' });
    const r = await sync();
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json).toMatchObject({ added: 0, duplicate: 1, conflict: 1 });
    expect(requests[0]!.body.date_from).toBe(new Date(new Date(last).getTime() - 5 * 60 * 1000).toISOString());
    const kept = (await h.pool.query(`SELECT value_text FROM injector_test_result r JOIN injector_test t ON t.id = r.test_id WHERE t.bench_slot = 0 AND r.condition = 'Low Idle'`)).rows;
    expect(kept).toEqual([{ value_text: '12.6' }]);
  });

  it('imports held results once the bench part is added as an alias', async () => {
    await h.pool.query(`INSERT INTO part_alias (part_id, alias, normalized) VALUES ($1, 'ZZ-123', 'ZZ123')`, [h.ids.parts['TQ-INJ-9009']]);
    bench = [];
    const r = await sync();
    expect(r.json).toMatchObject({ fetched: 0, added: 1, pendingImported: 1, waitingForPart: 0 });
    expect((await benchTests()).map((x) => x.serial)).toContain('TQ-SN-0901');
    expect((await admin.get('/api/injectors/bench')).json.waiting).toEqual([]);
  });

  it('pages forward until the bench has nothing newer', async () => {
    bench = ['07-10', '07-11', '07-12', '07-13', '07-14'].map((d, i) => report(`run-1${i}`, 0, `TQ-SN-1${i}`, `2026-${d}T08:00:00+00:00`));
    await h.pool.query(`UPDATE system_setting SET value = jsonb_set(value, '{lastSync}', '"2026-07-09T00:00:00.000Z"') WHERE key = 'carbonzapp_sync'`);
    const r = await sync();
    expect(r.json).toMatchObject({ fetched: 5, added: 5, truncated: false });
    expect(requests.map((q) => q.body.date_from)).toEqual(['2026-07-08T23:55:00.000Z', '2026-07-12T08:00:00.000Z', '2026-07-14T08:00:00.000Z']);
  });

  it('continues after an incomplete fetch from the newest result read', async () => {
    process.env.CARBONZAPP_MAX_PAGES = '1';
    try {
      bench = ['08-01', '08-02', '08-03', '08-04'].map((d, i) => report(`run-2${i}`, 0, `TQ-SN-2${i}`, `2026-${d}T08:00:00+00:00`));
      await h.pool.query(`UPDATE system_setting SET value = jsonb_set(value, '{lastSync}', '"2026-07-31T00:00:00.000Z"') WHERE key = 'carbonzapp_sync'`);
      const first = await sync();
      expect(first.json).toMatchObject({ fetched: 3, added: 3, truncated: true, lastSync: '2026-08-03T08:00:00.000Z' });
      const second = await sync();
      expect(second.json).toMatchObject({ added: 1, duplicate: 1, truncated: true });
      expect(requests.at(-1)!.body.date_from).toBe('2026-08-03T07:55:00.000Z');
    } finally {
      delete process.env.CARBONZAPP_MAX_PAGES;
    }
  });

  it('explains bench failures', async () => {
    respond = () => ({ status: 401, type: 'text/html', body: '<!doctype html><title>Sign in</title>' });
    let r = await sync();
    expect(r.status).toBe(502);
    expect(r.json.error.message).toMatch(/rejected the request \(HTTP 401\).*API key/);
    respond = () => ({ status: 200, body: 'not json' });
    r = await sync();
    expect(r.json.error).toMatchObject({ code: 'CARBONZAPP_BAD_RESPONSE' });
    respond = () => ({ status: 200, body: JSON.stringify({ message: 'nope' }) });
    expect((await sync()).json.error.message).toMatch(/unexpected \(non-array\) response/);
    respond = () => ({ status: 503, body: 'maintenance window' });
    expect((await sync()).json.error.message).toBe('CarbonZapp API returned HTTP 503: maintenance window');
  });
});

describe('starting an inspection from bench results', () => {
  let inspectionId: string;

  it('needs bench authority, one part and an inspector who performs inspections', async () => {
    const ids = (await benchTests('?q=TQ-SN-04')).map((x) => x.id);
    expect(ids).toHaveLength(2);
    expect((await inspector.send('POST', '/api/injectors/bench/inspections', { testIds: ids })).status).toBe(403);
    const noInspector = await admin.send('POST', '/api/injectors/bench/inspections', { testIds: ids });
    expect(noInspector.status).toBe(422);
    expect(noInspector.json.error.message).toMatch(/choose an inspector/);
    expect((await admin.send('POST', '/api/injectors/bench/inspections', { testIds: [ids[0], ids[0]], inspectorId: h.ids.users.inspector })).status).toBe(422);
  });

  it('creates one inspection with serials and read-only bench results per item', async () => {
    const list = await benchTests('?q=TQ-SN-04');
    const r = await admin.send('POST', '/api/injectors/bench/inspections', { testIds: list.map((x) => x.id), poNumber: 'PO-BENCH-1', inspectorId: h.ids.users.inspector });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    inspectionId = r.json.id;
    const d = (await inspector.get(`/api/inspections/${inspectionId}`)).json;
    expect(d).toMatchObject({ unitCount: 2, partNumber: 'TQ-INJ-9009', poNumber: 'PO-BENCH-1', dateReceived: '2026-06-30', inspector: { id: h.ids.users.inspector } });
    expect(d.form.definition.formNumber).toBe('PDI-IQI-012');
    expect(d.units.map((u: { serialNumber: string }) => u.serialNumber)).toEqual(['TQ-SN-0455', 'TQ-SN-0447']);
    expect(d.bench).toHaveLength(2);
    expect(d.bench[0]).toMatchObject({ unitIndex: 1, serial: 'TQ-SN-0455', outcome: 'PASS' });
    expect(d.bench[0].results[3]).toMatchObject({ condition: 'Peak HP', value: '230.3', lower: '220.9', upper: '249.1', outcome: 'PASS' });
    // Bench results already in an inspection are not offered again and cannot be reused.
    expect((await benchTests('?q=TQ-SN-04&available=true')).length).toBe(0);
    const again = await admin.send('POST', '/api/injectors/bench/inspections', { testIds: [list[0]!.id], inspectorId: h.ids.users.inspector });
    expect(again.status).toBe(409);
    expect(again.json.error.message).toMatch(/already in inspection IR-/);
    // The bench serial cannot be retyped.
    const v = await version(inspector, inspectionId);
    const retype = await inspector.send('PATCH', `/api/inspections/${inspectionId}/entries`, { expectedVersion: v, changes: [], units: [{ unitIndex: 1, serialNumber: 'OTHER' }] });
    expect(retype.status).toBe(422);
  });

  it('completes as PASS when the inspector passes receiving and visual and the bench passed; the PDF carries the bench results', async () => {
    await passAll(inspector, inspectionId, 0, 'A');
    for (const u of [1, 2]) await passAll(inspector, inspectionId, u, 'B');
    const done = await inspector.send('POST', `/api/inspections/${inspectionId}/complete`, { expectedVersion: await version(inspector, inspectionId) });
    expect(done.json).toMatchObject({ status: 'COMPLETED', outcome: 'PASS' });
    await h.svc.worker!.drain();
    const d = (await inspector.get(`/api/inspections/${inspectionId}`)).json;
    const pdf = (await inspector.get(`/api/files/${d.reports[0].fileId}`)).raw;
    const file = path.join(h.storageRoot, 'bench-inspection.pdf');
    writeFileSync(file, pdf);
    const text = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
    expect(text).toContain('TEST BENCH RESULTS (CARBONZAPP)');
    expect(text).toMatch(/Peak HP\s+220\.9 – 249\.1 mm3\/STRK\s+230\.3/);
    expect(text).toContain('Peak Torque - Return');
    expect(text).toContain('bench result PASS');
  });

  it('an item whose bench result failed cannot pass and goes to independent review', async () => {
    bench = [
      report('run-0100', 0, 'TQ-SN-2001', '2026-07-20T08:00:00+00:00', (r) => {
        r.AllTests!.find((t) => t.TestInfo?.test_name === 'iVM.02')!.PrimaryTank!.AvrResult = '40.0';
      }),
    ];
    await h.pool.query(`UPDATE system_setting SET value = jsonb_set(value, '{lastSync}', '"2026-07-19T00:00:00.000Z"') WHERE key = 'carbonzapp_sync'`);
    expect((await sync()).json).toMatchObject({ added: 1 });
    const failed = (await benchTests('?outcome=FAIL'))[0]!;
    expect(failed.serial).toBe('TQ-SN-2001');
    const r = await admin.send('POST', '/api/injectors/bench/inspections', { testIds: [failed.id], inspectorId: h.ids.users.inspector });
    const id = r.json.id as string;
    await passAll(inspector, id, 0, 'A');
    await passAll(inspector, id, 1, 'B');
    const done = await inspector.send('POST', `/api/inspections/${id}/complete`, { expectedVersion: await version(inspector, id) });
    expect(done.json).toMatchObject({ status: 'READY_FOR_REVIEW', outcome: 'FAIL' });
    const d = (await quality.get(`/api/inspections/${id}`)).json;
    expect(d.reviewReasons.map((x: { message: string }) => x.message)).toContain('Test bench result FAIL — independent review required');
    const confirm = await quality.send('POST', `/api/inspections/${id}/review`, { decision: 'CONFIRM', comment: 'Emissions delivery over band (fictional)', expectedVersion: d.version });
    expect(confirm.status, JSON.stringify(confirm.json)).toBe(200);
    expect((await quality.get(`/api/inspections/${id}`)).json).toMatchObject({ status: 'COMPLETED', outcome: 'FAIL' });
  });
});
