import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_VOLUME, seedVolume } from '../fixtures/volume.js';
import { type Harness, type Session, startHarness } from './harness.js';

/**
 * Performance with years of history (Part III list requirements, FR-114). Server-side latency of the
 * main read paths is measured in process (no network) against about three years of fictional
 * records. The budgets below are engineering targets for this test machine, not business policy.
 */
let h: Harness;
let quality: Session;
let counts: Record<string, number>;
const RUNS = 7;

/** Median and worst of RUNS timed requests after one warm-up. */
async function measure(s: Session, url: string) {
  expect((await s.get(url)).status, url).toBe(200);
  const times: number[] = [];
  for (let i = 0; i < RUNS; i += 1) {
    const t0 = performance.now();
    const r = await s.get(url);
    times.push(performance.now() - t0);
    expect(r.status, url).toBe(200);
  }
  times.sort((a, b) => a - b);
  return { median: Math.round(times[Math.floor(RUNS / 2)]!), worst: Math.round(times[RUNS - 1]!) };
}

beforeAll(async () => {
  h = await startHarness();
  quality = await h.login('quality');
  const t0 = performance.now();
  // PERF_SCALE=5 approximates fifteen years of history for an occasional scaling check.
  const scale = Number(process.env.PERF_SCALE ?? 1);
  counts = await seedVolume(h.pool, Object.fromEntries(Object.entries(DEFAULT_VOLUME).map(([k, v]) => [k, k.endsWith('PerInspection') || k === 'testsPerInjector' ? v : Math.round(v * scale)])) as typeof DEFAULT_VOLUME);
  console.log(`volume seeded in ${Math.round(performance.now() - t0)} ms`, counts);
}, 600_000);
afterAll(async () => h?.close());

describe('read paths stay practical with years of records', () => {
  it('lists, search, home, detail, reports and traceability meet their latency budgets', async () => {
    expect(counts.inspection).toBeGreaterThanOrEqual(DEFAULT_VOLUME.inspections);
    const someInspection = (await h.pool.query(`SELECT id FROM inspection WHERE number = 'VOL-003000'`)).rows[0].id;
    const someInjector = (await h.pool.query(`SELECT id FROM injector WHERE serial_number = 'VINJ-000750'`)).rows[0].id;
    const part = h.ids.parts['TQ-PRK-3003'];
    const year = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    // [label, url, budget for the median in ms]
    const cases: Array<[string, string, number]> = [
      ['Home (My Work)', '/api/home', 300],
      ['Inspection list, newest first', '/api/inspections', 300],
      ['Inspection list, search by serial', '/api/inspections?q=VSN-002500-1', 400],
      ['Inspection list, completed FAIL drill-down', `/api/inspections?status=COMPLETED&outcome=FAIL&completedFrom=${year}&completedTo=${today}`, 400],
      ['Inspection detail', `/api/inspections/${someInspection}`, 300],
      ['Global search', '/api/search?q=LOT-V4321', 500],
      ['Part hub', `/api/parts/${part}`, 400],
      ['NCR list', '/api/ncrs', 300],
      ['Injector list', '/api/injectors', 300],
      ['Injector detail', `/api/injectors/${someInjector}`, 300],
      ['Injector analytics, 1 year', `/api/injectors/analytics?from=${year}&to=${today}`, 800],
      ['Reports overview, 90 days', '/api/reports/overview', 1500],
      ['Reports overview, 1 year', `/api/reports/overview?from=${year}&to=${today}`, 2000],
      ['Trace by part + lot', `/api/trace?partId=${part}&lot=LOT-V4321`, 500],
      ['Trace by serial', '/api/trace?serial=VSN-004321-2', 500],
    ];
    const results: Array<{ label: string; url: string; median: number; worst: number; budget: number }> = [];
    for (const [label, url, budget] of cases) results.push({ label, url, budget, ...(await measure(quality, url)) });
    console.table(results.map((r) => ({ path: r.label, 'median ms': r.median, 'worst ms': r.worst, 'budget ms': r.budget })));
    mkdirSync(path.resolve(import.meta.dirname, '../../var'), { recursive: true });
    writeFileSync(path.resolve(import.meta.dirname, '../../var/performance.json'), JSON.stringify({ measuredAt: new Date().toISOString(), counts, runs: RUNS, results }, null, 2));
    expect(results.filter((r) => r.median > r.budget).map((r) => `${r.label}: median ${r.median} ms > ${r.budget} ms`)).toEqual([]);
  }, 600_000);
});
