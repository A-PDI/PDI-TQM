import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makePng } from '../fixtures/images.js';
import { type Harness, type Session, formRevisionId, passAll, save, startHarness, version } from './harness.js';

/**
 * Representative PDF outputs (Drawing F1 "PDF" row). Each report is produced through the
 * real API + job path, checked for content and page structure, and written to
 * var/report-samples for visual review.
 */
const OUT = path.resolve(import.meta.dirname, '../../var/report-samples');
let h: Harness;
let inspector: Session;
let quality: Session;
let manager: Session;

beforeAll(async () => {
  h = await startHarness();
  inspector = await h.login('inspector');
  quality = await h.login('quality');
  manager = await h.login('manager');
  mkdirSync(OUT, { recursive: true });
});
afterAll(async () => h?.close());

async function start(partNumber: string, formNumber: string, unitCount: number, extra: Record<string, unknown> = {}) {
  const part = (await inspector.get(`/api/parts?q=${partNumber}`)).json[0];
  const r = await inspector.send('POST', '/api/inspections', {
    partId: part.id,
    formRevisionId: await formRevisionId(inspector, formNumber),
    unitCount,
    poNumber: 'PO-60411',
    dateReceived: '2026-10-18',
    lotNumber: 'LOT-2026-118',
    ...extra,
  });
  expect(r.status).toBe(201);
  return r.json.id as string;
}

async function finish(id: string, reviewer: Session | null) {
  const c = await inspector.send('POST', `/api/inspections/${id}/complete`, { expectedVersion: await version(inspector, id) });
  expect(c.status, JSON.stringify(c.json)).toBe(200);
  if (c.json.status === 'READY_FOR_REVIEW') {
    expect(reviewer).not.toBeNull();
    const r = await reviewer!.send('POST', `/api/inspections/${id}/review`, { decision: 'CONFIRM', comment: 'Reviewed (synthetic)', expectedVersion: await version(reviewer!, id) });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  }
  await h.svc.worker!.drain();
  const d = (await inspector.get(`/api/inspections/${id}`)).json;
  expect(d.reports).toHaveLength(1);
  const pdf = (await inspector.get(`/api/files/${d.reports[0].fileId}`)).raw;
  return { detail: d, pdf };
}

function inspectPdf(name: string, pdf: Buffer) {
  const file = path.join(OUT, `${name}.pdf`);
  writeFileSync(file, pdf);
  const text = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
  const pages = Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [file], { encoding: 'utf8' }))![1]);
  return { text, pages };
}

const photo = (seed: number) => makePng(160, 120, [(seed * 53) % 200, (seed * 97) % 200, (seed * 31) % 200]);

describe('representative inspection reports', () => {
  it('12-unit cylinder liner: every unit and reading present across pages', async () => {
    const id = await start('TQ-LNR-2002', 'PDI-IQI-002', 12);
    await passAll(inspector, id, 0, 'A');
    const rows = ['bore_diameter', 'bore_out_of_round', 'bore_taper', 'flange_thickness'];
    for (let u = 1; u <= 12; u += 1) {
      await passAll(inspector, id, u, 'B');
      const r = await save(
        inspector,
        id,
        rows.map((rowKey, i) => ({ unitIndex: u, sectionKey: 'C', rowKey, status: 'P', readings: { a1: `${5.1 + i}${u}`, a2: `${5.1 + i}${u + 1}` } })),
        [{ unitIndex: u, serialNumber: `LNR-${String(u).padStart(4, '0')}` }],
      );
      expect(r.status).toBe(200);
    }
    const { pdf } = await finish(id, quality);
    const { text, pages } = inspectPdf('liner-12-unit', pdf);
    expect(pages).toBeGreaterThanOrEqual(6);
    for (let u = 1; u <= 12; u += 1) expect(text).toContain(`ITEM ${u} OF 12 · SERIAL LNR-${String(u).padStart(4, '0')}`);
    expect(text).toContain('Specification not released');
    expect((text.match(/Bore Out-of-Round/g) ?? []).length).toBe(13); // 12 rows + one review summary line
    expect(text).toContain(`Page ${pages} of ${pages}`);
    expect(text).toContain('(continued)');
  });

  it('six-cylinder head: groove, valve recession and vacuum with failed-cylinder valve results', async () => {
    const id = await start('TQ-CYH-4004', 'PDI-IQI-005', 1, { sourceId: h.ids.sources.headBsc });
    await passAll(inspector, id, 0, 'A');
    await passAll(inspector, id, 1, 'B');
    for (const sectionKey of ['C_general', 'C_fire_ring', 'C_valve_recession', 'C_vacuum_test']) {
      const r = await inspector.send('POST', `/api/inspections/${id}/sections`, { expectedVersion: await version(inspector, id), unitIndex: 1, sectionKey });
      expect(r.status).toBe(200);
    }
    const six = (v: (c: number) => string) => Object.fromEntries([1, 2, 3, 4, 5, 6].map((c) => [`c${c}`, v(c)]));
    await save(inspector, id, [
      { unitIndex: 1, sectionKey: 'C_general', rowKey: 'cylinder_head_height', status: 'P', readings: { value: '4.801' } },
      { unitIndex: 1, sectionKey: 'C_general', rowKey: 'surface_finish_ra', status: 'P', readings: { value: '5.0' } },
      { unitIndex: 1, sectionKey: 'C_general', rowKey: 'flatness', status: 'P', readings: { value: '.002' } },
      { unitIndex: 1, sectionKey: 'C_general', rowKey: 'valve_stem_height', status: 'N', note: 'Not specified for this casting' },
      { unitIndex: 1, sectionKey: 'C_fire_ring', rowKey: 'groove_diameter', status: 'P', readings: six(() => '5.990') },
      { unitIndex: 1, sectionKey: 'C_fire_ring', rowKey: 'groove_depth', status: 'P', readings: six((c) => `.03${c % 2}`) },
      { unitIndex: 1, sectionKey: 'C_fire_ring', rowKey: 'wire_protrusion', status: 'P', readings: six(() => '.009') },
      ...[1, 2, 3, 4, 5, 6].map((c) => ({
        unitIndex: 1,
        sectionKey: 'C_valve_recession',
        rowKey: `c${c}`,
        status: 'P',
        readings: { int1: '.033', int2: `.03${c}`, exh1: '.041', exh2: '.044' },
      })),
      ...[1, 2, 4, 5, 6].map((c) => ({ unitIndex: 1, sectionKey: 'C_vacuum_test', rowKey: `c${c}`, status: 'P' })),
      { unitIndex: 1, sectionKey: 'C_vacuum_test', rowKey: 'c3', status: 'F', note: 'Vacuum decay on cylinder 3' },
      { unitIndex: 1, sectionKey: 'C_vacuum_test', rowKey: 'c3_int1', status: 'P' },
      { unitIndex: 1, sectionKey: 'C_vacuum_test', rowKey: 'c3_int2', status: 'F' },
      { unitIndex: 1, sectionKey: 'C_vacuum_test', rowKey: 'c3_exh1', status: 'P' },
      { unitIndex: 1, sectionKey: 'C_vacuum_test', rowKey: 'c3_exh2', status: 'P' },
    ]);
    await inspector.upload(`/api/inspections/${id}/photos?unitIndex=1&sectionKey=C_vacuum_test&rowKey=c3`, photo(3), 'vac.png', 'image/png');
    const { detail, pdf } = await finish(id, quality);
    expect(detail.outcome).toBe('FAIL');
    const { text } = inspectPdf('cylinder-head-6cyl', pdf);
    expect(text).toContain('Governing limits: PDI drawing TQ-CYH-4004 (synthetic), Rev A — SYNTHETIC');
    expect(text).toContain('Intake limit: 0.030 – 0.050 in · Exhaust limit: 0.030 – 0.050 in');
    for (const c of ['C1', 'C2', 'C3', 'C4', 'C5', 'C6']) expect(text).toContain(c);
    expect(text).toContain('Intake 2 valve: Fail');
    expect(text).toContain('Vacuum decay on cylinder 3');
    expect(text).toContain('0.029 – 0.031 in');
  });

  it('accepted three-unit crankshaft: item 1 ACCEPTED, items 2–3 PASS, no implied concession', async () => {
    const id = await start('TQ-CRK-6006', 'PDI-IQI-014', 3);
    await passAll(inspector, id, 0, 'A');
    const dims = ['main_journal_outer_diameter_od', 'crankpin_rod_journal_outer_diameter_od', 'journal_taper_out_of_round', 'total_indicator_runout_crankshaft_straightness'];
    for (let u = 1; u <= 3; u += 1) {
      await passAll(inspector, id, u, 'B');
      await save(inspector, id, dims.map((rowKey) => ({ unitIndex: u, sectionKey: 'C', rowKey, status: 'P', readings: { a1: '3.1240' } })));
    }
    await save(inspector, id, [{ unitIndex: 1, sectionKey: 'B', rowKey: 'journal_surface_finish', status: 'A', note: 'Small gash on journal surface' }], [
      { unitIndex: 1, dispositionNote: 'Small gash on crankshaft surface' },
    ]);
    await inspector.upload(`/api/inspections/${id}/photos?unitIndex=1&sectionKey=B&rowKey=journal_surface_finish`, photo(7), 'gash.png', 'image/png');
    const { detail, pdf } = await finish(id, manager);
    expect(detail.outcome).toBe('ACCEPTED');
    const { text } = inspectPdf('crankshaft-accepted', pdf);
    expect(text).toContain('OVERALL OUTCOME: ACCEPTED');
    expect(text).toMatch(/ITEM 1 — RESULT\s+ACCEPTED/);
    expect(text).toMatch(/ITEM 2 — RESULT\s+PASS/);
    expect(text).toMatch(/ITEM 3 — RESULT\s+PASS/);
    expect(text).toContain("does not authorize material release, disposition");
  });

  it('failed main bearing: packaging damage, row photo, FAIL outcome', async () => {
    const id = await start('TQ-MBR-8008', 'PDI-IQI-027', 1, { sourceId: h.ids.sources.bearingMbi });
    await save(inspector, id, [{ unitIndex: 0, sectionKey: 'A', rowKey: 'outer_carton_condition', status: 'F', note: 'Carton crushed on one corner; shells exposed' }]);
    await passAll(inspector, id, 0, 'A');
    await inspector.upload(`/api/inspections/${id}/photos?unitIndex=0&sectionKey=A&rowKey=outer_carton_condition`, photo(11), 'carton.png', 'image/png');
    await passAll(inspector, id, 1, 'B');
    const saved = await save(inspector, id, [
      ...['bearing_shell_wall_thickness', 'overall_shell_width', 'bearing_free_spread'].map((rowKey) => ({ unitIndex: 1, sectionKey: 'C', rowKey, status: 'P', readings: { a1: '2.5' } })),
      { unitIndex: 1, sectionKey: 'C', rowKey: 'flange_thickness_total_width_for_combination_mai', status: 'N', note: 'Plain shell, no thrust flange' },
      { unitIndex: 1, sectionKey: 'B', rowKey: 'thrust_flanges_for_combination_main_thrust_beari', status: 'N', note: 'Plain shell, no thrust flange' },
    ]);
    expect(saved.status).toBe(200);
    const { detail, pdf } = await finish(id, quality);
    expect(detail.outcome).toBe('FAIL');
    const { text } = inspectPdf('main-bearing-fail', pdf);
    expect(text).toContain('OVERALL OUTCOME: FAIL');
    expect(text).toContain('Carton crushed on one corner');
    expect(text).toContain('Source not approved');
    expect(text).toContain('Photo 1');
  });

  it('image-heavy turbocharger: orderly multi-page photo gallery', async () => {
    const id = await start('TQ-TRB-5005', 'PDI-IQI-011', 1);
    await passAll(inspector, id, 0, 'A');
    await passAll(inspector, id, 1, 'B');
    const rows = ['compressor_wheel_blades', 'turbine_wheel_blades', 'compressor_turbine_housings', 'inlet_outlet_openings', 'mounting_flanges', 'studs_threaded_holes'];
    for (let i = 0; i < 18; i += 1) {
      const rowKey = rows[i % rows.length]!;
      const r = await inspector.upload(`/api/inspections/${id}/photos?unitIndex=1&sectionKey=B&rowKey=${rowKey}`, photo(20 + i), `turbo-${i + 1}.png`, 'image/png');
      expect(r.status).toBe(201);
    }
    await inspector.upload(`/api/inspections/${id}/photos`, photo(99), 'overview.png', 'image/png');
    const { detail, pdf } = await finish(id, null);
    expect(detail.outcome).toBe('PASS');
    const { text, pages } = inspectPdf('turbocharger-photos', pdf);
    expect(text).toContain('Photo 19 · General');
    expect(text).toContain('PHOTOGRAPHS (continued)');
    expect(pages).toBeGreaterThanOrEqual(3);
  });
});
