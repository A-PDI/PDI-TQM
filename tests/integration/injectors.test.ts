import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importBenchFile } from '../../src/server/injectors/bench.js';
import { GOOD_ROWS, benchCsv } from '../fixtures/bench.js';
import { type Harness, type Session, startHarness } from './harness.js';

/** Stage 4: bench imports, repair/retest chronology, comparison, shipment evaluation and analytics. */
let h: Harness;
let inspector: Session;
let quality: Session;
const OUT = path.resolve(import.meta.dirname, '../../var/report-samples');
const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();

beforeAll(async () => {
  h = await startHarness();
  [inspector, quality] = await Promise.all([h.login('inspector'), h.login('quality')]);
  mkdirSync(OUT, { recursive: true });
});
afterAll(async () => h?.close());

const ok = (r: { status: number; json: unknown }, status = 200) => {
  expect(r.status, JSON.stringify(r.json)).toBe(status);
  return r.json as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const count = async (table: string) => (await h.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n as number;
const injectorId = async (serial: string) => (await h.pool.query('SELECT id FROM injector WHERE serial_number = $1', [serial])).rows[0]?.id as string;

async function renditionText(snapshotId: string, sample: string) {
  await h.svc.worker!.drain();
  const snap = ok(await quality.get(`/api/report-snapshots/${snapshotId}`));
  expect(snap.fileId, 'rendition').toBeTruthy();
  const file = await quality.get(`/api/files/${snap.fileId}`);
  expect(file.status).toBe(200);
  const out = path.join(OUT, sample);
  writeFileSync(out, file.raw);
  return execFileSync('pdftotext', ['-layout', out, '-']).toString();
}

const T1 = at(6);
const T2 = at(5.5);
const FILE_1 = benchCsv(
  [
    { serial: 'INJ-SYN-0001', testedAt: T1, rows: GOOD_ROWS },
    // Machine says PASS but rated delivery is above the released PDI criteria: the verdicts stay separate.
    {
      serial: 'INJ-SYN-0002',
      testedAt: T1,
      rows: [
        ['Rated', 'Delivery', 'mm3/stroke', '107.2', 'PASS'],
        ['Idle', 'Delivery', 'mm3/stroke', '9.6', 'PASS'],
        ['Rated', 'Return flow', 'mm3/stroke', '21.5', 'PASS'],
      ],
    },
    // Unit differs from the criteria (never converted) and one parameter has no criteria: partial coverage.
    {
      serial: 'INJ-SYN-0003',
      testedAt: T2,
      rows: [
        ['Rated', 'Delivery', 'mm3/s', '100.0', 'PASS'],
        ['Idle', 'Delivery', 'mm3/stroke', '10.0', 'PASS'],
        ['Pilot', 'Delivery', 'mm3/stroke', '1.5', ''],
      ],
    },
    { serial: 'INJ-SYN-0004', part: 'NOT-A-PART-1', testedAt: T2, rows: GOOD_ROWS },
    { serial: 'INJ-SYN-0005', testedAt: 'yesterday', rows: GOOD_ROWS },
    { serial: 'INJ-SYN-0006', testedAt: T2, rows: [['Rated', 'Delivery', 'mm3/stroke', 'abc', 'PASS']] },
  ],
);

describe('AT-05 / FR-060 — bench file import through the interim adapter', () => {
  it('imports valid tests, auto-registers injectors and reports every excluded test with its reason', async () => {
    expect((await inspector.upload('/api/injectors/imports', Buffer.from('a,b\r\n1,2\r\n'), 'wrong.csv', 'text/csv')).status).toBe(422);
    const r = ok(await inspector.upload('/api/injectors/imports', FILE_1, 'bench-run-1.csv', 'text/csv'), 201);
    expect(r.number).toMatch(/^BI-\d{4}-\d{5}$/);
    expect(r.status).toBe('COMPLETED');
    expect(r.totals).toEqual({ total: 6, added: 3, duplicate: 0, conflict: 0, excluded: 3, injectorsAdded: 3 });

    const detail = ok(await inspector.get(`/api/injectors/imports/${r.importId}`));
    expect(detail.adapterNote).toMatch(/not a CarbonZapp/);
    const reasons = detail.import.report.tests.filter((t: { outcome: string }) => t.outcome === 'EXCLUDED').map((t: { reason: string }) => t.reason);
    expect(reasons.join(' | ')).toMatch(/Unknown part number NOT-A-PART-1/);
    expect(reasons.join(' | ')).toMatch(/needs an ISO date-time with a time zone/);
    expect(reasons.join(' | ')).toMatch(/Delivery: /);

    // The original bytes are kept and downloadable, byte for byte.
    const file = await inspector.get(`/api/files/${detail.import.file_id}`);
    expect(file.status).toBe(200);
    expect(createHash('sha256').update(file.raw).digest('hex')).toBe(createHash('sha256').update(FILE_1).digest('hex'));

    const one = ok(await inspector.get(`/api/injectors/${await injectorId('INJ-SYN-0001')}`));
    expect(one.tests).toHaveLength(1);
    expect(one.tests[0]).toMatchObject({ machine_verdict: 'PASS', pdi_evaluation: 'PASS', stage: 'FIRST_TEST', import_number: r.number });
    expect(one.tests[0].criteria_label).toMatch(/PDI injector test criteria/);
    const two = ok(await inspector.get(`/api/injectors/${await injectorId('INJ-SYN-0002')}`));
    expect(two.tests[0]).toMatchObject({ machine_verdict: 'PASS', pdi_evaluation: 'FAIL' });
    const rated = two.tests[0].results.find((x: { condition: string; parameter: string }) => x.condition === 'Rated' && x.parameter === 'Delivery');
    expect(rated).toMatchObject({ value_text: '107.2', pdi_evaluation: 'OUTSIDE', upper_limit: '105.0' });
    const three = ok(await inspector.get(`/api/injectors/${await injectorId('INJ-SYN-0003')}`));
    expect(three.tests[0]).toMatchObject({ machine_verdict: 'NOT_REPORTED', pdi_evaluation: 'PARTIAL_CRITERIA' });
    expect(three.tests[0].results.find((x: { unit: string }) => x.unit === 'mm3/s').pdi_evaluation).toBe('NO_LIMIT');
  });

  it('a user without injector.test cannot import (denied and audited)', async () => {
    const purchasing = await h.login('purchasing');
    expect((await purchasing.upload('/api/injectors/imports', FILE_1, 'x.csv', 'text/csv')).status).toBe(403);
    expect((await h.pool.query(`SELECT 1 FROM audit_event WHERE action = 'injector.import' AND outcome = 'DENIED'`)).rowCount).toBe(1);
  });
});

describe('NEG-09 / NEG-22 — idempotent and all-or-nothing imports', () => {
  it('re-importing the same file adds nothing and names the earlier import', async () => {
    const before = await count('injector_test');
    const r = ok(await inspector.upload('/api/injectors/imports', FILE_1, 'bench-run-1-again.csv', 'text/csv'), 201);
    expect(r.status).toBe('DUPLICATE_FILE');
    expect(r.totals).toMatchObject({ added: 0, duplicate: 3, conflict: 0, injectorsAdded: 0 });
    expect(await count('injector_test')).toBe(before);
    const detail = ok(await inspector.get(`/api/injectors/imports/${r.importId}`));
    expect(detail.import.report.priorImport).toMatch(/^BI-/);
  });

  it('a different value under the same machine/serial/time/sequence is a conflict; the original is never overwritten', async () => {
    const changed = benchCsv([
      { serial: 'INJ-SYN-0001', testedAt: T1, rows: [['Rated', 'Delivery', 'mm3/stroke', '99.9', 'PASS'], ...GOOD_ROWS.slice(1)] },
      { serial: 'inj syn 0001', testedAt: at(5), seq: '2', rows: GOOD_ROWS },
    ]);
    const r = ok(await inspector.upload('/api/injectors/imports', changed, 'bench-run-2.csv', 'text/csv'), 201);
    expect(r.totals).toMatchObject({ added: 1, conflict: 1, injectorsAdded: 0 });
    const one = ok(await inspector.get(`/api/injectors/${await injectorId('INJ-SYN-0001')}`));
    expect(one.tests).toHaveLength(2);
    expect(one.tests[0].results.find((x: { condition: string; parameter: string }) => x.condition === 'Rated' && x.parameter === 'Delivery').value_text).toBe('100.4');
    expect(one.tests[1].stage).toBe('RETEST');
    // Stored tests cannot be edited even directly in the database.
    await expect(h.pool.query(`UPDATE injector_test_result SET value_text = '1' WHERE test_id = $1`, [one.tests[0].id])).rejects.toThrow(/immutable/);
    await expect(h.pool.query(`UPDATE injector_test SET machine_verdict = 'FAIL' WHERE id = $1`, [one.tests[0].id])).rejects.toThrow(/immutable/);
  });

  it('an import interrupted part-way leaves no tests, injectors, import record or stored file behind (NEG-22)', async () => {
    const counts = async () => Promise.all(['injector_test', 'injector_test_result', 'injector', 'bench_import', 'file_object', 'evidence_link'].map(count));
    const before = await counts();
    const auth = { userId: h.ids.users.inspector, capabilities: new Set(['records.read', 'injector.test']) } as never;
    const file = benchCsv([
      { serial: 'INJ-SYN-0101', testedAt: at(4), rows: GOOD_ROWS },
      { serial: 'INJ-SYN-0102', testedAt: at(4), rows: GOOD_ROWS },
      { serial: 'INJ-SYN-0103', testedAt: at(4), rows: GOOD_ROWS },
    ]);
    await expect(
      importBenchFile(h.svc, auth, { bytes: file, name: 'interrupted.csv' }, { afterTest: (n) => {
        if (n === 2) throw new Error('simulated interruption after the second test');
      } }),
    ).rejects.toThrow(/simulated interruption/);
    expect(await counts()).toEqual(before);
    // Re-running the same file afterwards imports everything exactly once.
    const r = ok(await inspector.upload('/api/injectors/imports', file, 'interrupted.csv', 'text/csv'), 201);
    expect(r.totals).toMatchObject({ added: 3, injectorsAdded: 3 });
  });
});

describe('FR-062 / C9 — repair, quick measurements and retest attribution', () => {
  let injId: string;
  let caseId: string;
  let actionId: string;

  it('opens a repair case and records an adjustment with quick measurements', async () => {
    injId = await injectorId('INJ-SYN-0002');
    caseId = ok(await inspector.send('POST', `/api/injectors/${injId}/repair-cases`, { problem: 'Rated delivery above PDI criteria on first test' }), 201).id;
    expect((await inspector.send('POST', `/api/injectors/${injId}/repair-cases`, { problem: 'Second open case attempt' })).status).toBe(409);
    expect((await inspector.send('POST', `/api/repair-cases/${caseId}/actions`, { actionType: 'COMPONENT_REPLACEMENT', description: 'Nozzle swapped' })).status).toBe(422);
    actionId = ok(
      await inspector.send('POST', `/api/repair-cases/${caseId}/actions`, {
        actionType: 'ADJUSTMENT',
        description: 'Shim changed to reduce delivery',
        performedAt: at(3),
        measurements: [
          { name: 'Shim thickness', value: '1.250', unit: 'mm' },
          { name: 'Spring preload', value: '42', unit: 'N' },
        ],
      }),
      201,
    ).id;
    const v = ok(await inspector.get(`/api/injectors/${injId}`)).repairs[0].version;
    const early = await inspector.send('POST', `/api/repair-cases/${caseId}/close`, { note: 'Closing before retest', expectedVersion: v });
    expect(early.status).toBe(422);
    expect(early.json.error.message).toMatch(/retest/);
  });

  it('a retest must follow the repair; the attributed retest closes the case and appears in the chronology', async () => {
    const results = [
      { condition: 'Rated', parameter: 'Delivery', unit: 'mm3/stroke', value: '101.0', result: 'PASS' },
      { condition: 'Idle', parameter: 'Delivery', unit: 'mm3/stroke', value: '9.9', result: 'PASS' },
      { condition: 'Rated', parameter: 'Return flow', unit: 'mm3/stroke', value: '20.0', result: 'PASS' },
    ];
    const before = await inspector.send('POST', `/api/injectors/${injId}/tests`, { machineId: 'BENCH-SYN-01', testPlan: 'SYN-PLAN-CR-1', testedAt: at(4), repairActionId: actionId, results });
    expect(before.status).toBe(422);
    const retest = ok(await inspector.send('POST', `/api/injectors/${injId}/tests`, { machineId: 'BENCH-SYN-01', testPlan: 'SYN-PLAN-CR-1', testedAt: at(2), repairActionId: actionId, results }), 201);
    expect((await inspector.send('POST', `/api/injector-tests/${retest.id}/retest-of`, { repairActionId: actionId })).status).toBe(409);
    const d = ok(await inspector.get(`/api/injectors/${injId}`));
    expect(d.tests.map((t: { stage: string; pdi_evaluation: string }) => `${t.stage}:${t.pdi_evaluation}`)).toEqual(['FIRST_TEST:FAIL', 'RETEST_AFTER_REPAIR:PASS']);
    expect(d.repairs[0].actions[0].measurements).toEqual([
      { name: 'Shim thickness', value: '1.250', unit: 'mm' },
      { name: 'Spring preload', value: '42', unit: 'N' },
    ]);
    ok(await inspector.send('POST', `/api/repair-cases/${caseId}/close`, { note: 'Retest within PDI criteria', expectedVersion: d.repairs[0].version }));
    await expect(h.pool.query(`UPDATE repair_case SET problem = 'x' WHERE id = $1`, [caseId])).rejects.toThrow();
  });
});

describe('FR-061 / FR-063 / FR-064 — comparison, exports, shipment evaluation and analytics', () => {
  it('compares injectors in the chosen order with first and latest values', async () => {
    const ids = [await injectorId('INJ-SYN-0002'), await injectorId('INJ-SYN-0001')];
    const c = ok(await inspector.get(`/api/injectors/compare?ids=${ids.join(',')}`));
    expect(c.injectors.map((i: { serialNumber: string }) => i.serialNumber)).toEqual(['INJ-SYN-0002', 'INJ-SYN-0001']);
    const rated = c.rows.find((r: { condition: string; parameter: string }) => r.condition === 'Rated' && r.parameter === 'Delivery');
    expect(rated.values[0]).toEqual({ first: { value: '107.2', evaluation: 'OUTSIDE' }, latest: { value: '101.0', evaluation: 'WITHIN' } });
    expect(c.injectors[0].latest.afterRepair).toBe(true);
    expect((await inspector.get('/api/injectors/compare?ids=not-a-uuid')).status).toBe(400);
    // A value recorded in another unit gets its own row; it is never lined up with mm3/stroke values.
    const mixed = ok(await inspector.get(`/api/injectors/compare?ids=${ids[0]},${await injectorId('INJ-SYN-0003')}`));
    const ratedRows = mixed.rows.filter((r: { condition: string; parameter: string }) => r.condition === 'Rated' && r.parameter === 'Delivery');
    expect(ratedRows.map((r: { unit: string; values: Array<{ first: { value: string } | null }> }) => [r.unit, r.values.map((v) => v.first?.value ?? null)])).toEqual([
      ['mm3/s', [null, '100.0']],
      ['mm3/stroke', ['107.2', null]],
    ]);
  });

  it('CSV export needs reports.export and neutralizes spreadsheet formulas (C10)', async () => {
    const evil = ok(await inspector.send('POST', '/api/injectors', { partId: h.ids.parts['TQ-INJ-9009'], serialNumber: '=HYPERLINK("http://x")' }), 201).id;
    const ids = [await injectorId('INJ-SYN-0002'), evil].join(',');
    expect((await inspector.get(`/api/exports/injector-compare.csv?ids=${ids}`)).status).toBe(403);
    expect((await h.pool.query(`SELECT 1 FROM audit_event WHERE action = 'export.injector_compare' AND outcome = 'DENIED'`)).rowCount).toBe(1);
    const csv = await quality.get(`/api/exports/injector-compare.csv?ids=${ids}`);
    expect(csv.status).toBe(200);
    expect(String(csv.headers['content-type'])).toMatch(/text\/csv/);
    const text = csv.raw.toString('utf8');
    expect(text).toContain(`"'=HYPERLINK(""http://x"") first"`);
    expect(text).toContain('"107.2"');
    const tests = (await quality.get('/api/exports/injector-tests.csv')).raw.toString('utf8');
    expect(tests.split('\r\n')[0]).toMatch(/period .* METRICS-INTERIM-1/);
  });

  it('issues a comparison report PDF', async () => {
    const ids = [await injectorId('INJ-SYN-0002'), await injectorId('INJ-SYN-0001'), await injectorId('INJ-SYN-0003')];
    expect((await inspector.send('POST', '/api/injectors/compare/report', { ids })).status).toBe(403);
    const r = ok(await quality.send('POST', '/api/injectors/compare/report', { ids }), 201);
    const text = await renditionText(r.snapshotId, 'injector-comparison-val-03.pdf');
    expect(text).toContain('INJECTOR TEST COMPARISON');
    expect(text).toContain('INJ-SYN-0002');
    expect(text).toMatch(/107\.2 \(!\) -> 101\.0/);
    expect(text).toMatch(/not a CarbonZapp/);
  });

  it('a shipment evaluation freezes each injector’s latest result and never claims a release', async () => {
    const ids = [await injectorId('INJ-SYN-0001'), await injectorId('INJ-SYN-0002'), await injectorId('INJ-SYN-0003')];
    const untested = ok(await inspector.send('POST', '/api/injectors', { partId: h.ids.parts['TQ-INJ-9009'], serialNumber: 'INJ-SYN-0099' }), 201).id;
    expect((await inspector.send('POST', '/api/shipment-evaluations', { reference: 'SHIP-SYN-1', injectorIds: ids })).status).toBe(403);
    const r = ok(await quality.send('POST', '/api/shipment-evaluations', { reference: 'SHIP-SYN-1', injectorIds: [...ids, untested] }), 201);
    expect(r.conclusion).toBe('EXCEPTIONS');
    const d = ok(await quality.get(`/api/shipment-evaluations/${r.id}`));
    expect(d.items.map((i: { serialNumber: string; result: string }) => `${i.serialNumber}:${i.result}`)).toEqual([
      'INJ-SYN-0001:PASS',
      'INJ-SYN-0002:PASS',
      'INJ-SYN-0003:NO_CRITERIA',
      'INJ-SYN-0099:NOT_TESTED',
    ]);
    expect(d.items[2].basis).toMatch(/not a PDI verdict/);
    await expect(h.pool.query(`UPDATE shipment_evaluation SET conclusion = 'ALL_PASS' WHERE id = $1`, [r.id])).rejects.toThrow(/immutable/);
    await h.svc.worker!.drain();
    const rendition = (await quality.get(`/api/shipment-evaluations/${r.id}`)).json.renditions[0];
    const file = await quality.get(`/api/files/${rendition.fileId}`);
    const out = path.join(OUT, 'shipment-evaluation-val-03.pdf');
    writeFileSync(out, file.raw);
    const text = execFileSync('pdftotext', ['-layout', out, '-']).toString();
    expect(text).toContain('INJECTOR SHIPMENT EVALUATION');
    expect(text).toMatch(/This evaluation does not/);
    expect(text).toContain('release material.');
  });

  it('analytics report first-pass and post-repair yields on each basis with explicit denominators', async () => {
    const a = ok(await inspector.get('/api/injectors/analytics'));
    expect(a.definitionsVersion).toBe('METRICS-INTERIM-1');
    // First tests: 0001 PASS/PASS, 0002 PASS/FAIL, 0003 NOT_REPORTED/PARTIAL, 0101–0103 PASS/PASS.
    expect(a.firstPassYield.firstTests).toBe(6);
    expect(a.firstPassYield.machine).toEqual({ pass: 5, of: 5, percent: 100 });
    expect(a.firstPassYield.pdi).toEqual({ pass: 4, of: 5, percent: 80 });
    expect(a.postRepairYield).toMatchObject({ tests: 1, pdi: { pass: 1, of: 1, percent: 100 } });
    expect(a.failureModes[0]).toMatchObject({ condition: 'Rated', parameter: 'Delivery', outside_pdi: 1 });
    expect(a.adjustments[0]).toMatchObject({ actionType: 'ADJUSTMENT', actions: 1 });
  });

  it('search finds injectors by serial and bench imports by file name', async () => {
    const s = ok(await inspector.get('/api/search?q=inj-syn-0002'));
    expect(s.records.some((r: { type: string; number: string }) => r.type === 'Injector' && r.number === 'INJ-SYN-0002')).toBe(true);
    const f = ok(await inspector.get('/api/search?q=bench-run-2'));
    expect(f.records.some((r: { type: string }) => r.type === 'Bench import')).toBe(true);
    expect(f.records.some((r: { type: string; link: string }) => r.type === 'Document' && r.link.startsWith('/injectors/imports/'))).toBe(true);
  });
});
