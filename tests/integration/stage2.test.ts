import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makePng } from '../fixtures/images.js';
import { type Harness, type Session, formRevisionId, passAll, save, startHarness, version } from './harness.js';

/** Cylinder head Stage 2 (owner decisions, 22 Oct 2026): per-head, own date and part number, same review rules, addendum PDF. */
let h: Harness;
let inspector: Session;
let inspector2: Session;
let quality: Session;
let stage1Id: string;
let stage2PartId: string;
let out: string;

const six = (v: (c: number) => string) => Object.fromEntries([1, 2, 3, 4, 5, 6].map((c) => [`c${c}`, v(c)]));
const GOOD = [
  { rowKey: 'groove_diameter', status: 'P', readings: six(() => '5.990') },
  { rowKey: 'groove_depth', status: 'P', readings: six(() => '0.030') },
  { rowKey: 'wire_protrusion', status: 'P', readings: six(() => '0.009') },
];

beforeAll(async () => {
  h = await startHarness();
  [inspector, inspector2, quality] = await Promise.all([h.login('inspector'), h.login('inspector2'), h.login('quality')]);
  mkdirSync(path.resolve(import.meta.dirname, '../../var'), { recursive: true });
  out = mkdtempSync(path.resolve(import.meta.dirname, '../../var/stage2-'));

  // Stage 1: two heads received and inspected; the fire ring section is not used at Stage 1.
  const r = await inspector.send('POST', '/api/inspections', {
    partId: h.ids.parts['TQ-CYH-4004'],
    formRevisionId: await formRevisionId(inspector, 'PDI-IQI-005'),
    unitCount: 2,
    dateReceived: '2026-10-01',
    sourceId: h.ids.sources.headBsc,
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  stage1Id = r.json.id;
  await passAll(inspector, stage1Id, 0, 'A');
  for (const u of [1, 2]) await passAll(inspector, stage1Id, u, 'B');
  await save(inspector, stage1Id, [], [{ unitIndex: 1, serialNumber: 'CYH-S1-001' }, { unitIndex: 2, serialNumber: 'CYH-S1-002' }]);

  // The Stage 2 product is a different PDI part with its own released groove limits (fictional demo seed).
  stage2PartId = h.ids.parts['TQ-CYH-4004-S2']!;
});
afterAll(async () => h?.close());

const start = (s: Session, body: Record<string, unknown>) => s.send('POST', `/api/inspections/${stage1Id}/stage2`, { stagePartId: stage2PartId, performedOn: '2026-10-20', ...body });
const stageVersion = async (s: Session, id: string) => (await s.get(`/api/inspection-stages/${id}`)).json.version as number;
const saveStage = async (s: Session, id: string, changes: unknown[]) => s.send('PATCH', `/api/inspection-stages/${id}/entries`, { expectedVersion: await stageVersion(s, id), changes });
const pdfText = (name: string, pdf: Buffer) => {
  const file = path.join(out, `${name}.pdf`);
  writeFileSync(file, pdf);
  return execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
};

describe('starting Stage 2', () => {
  it('is only possible on a completed Stage 1 inspection, per head, with a different part number and a real date', async () => {
    expect((await start(inspector, { unitIndex: 1 })).status).toBe(409);
    const c = await inspector.send('POST', `/api/inspections/${stage1Id}/complete`, { expectedVersion: await version(inspector, stage1Id) });
    expect(c.status, JSON.stringify(c.json)).toBe(200);
    expect(c.json.status).toBe('COMPLETED');
    const detail = (await inspector.get(`/api/inspections/${stage1Id}`)).json;
    expect(detail.stage2).toEqual({ available: true, canStart: true });
    expect(detail.stages).toEqual([]);

    expect((await start(inspector, { unitIndex: 3 })).status).toBe(400);
    expect((await start(inspector, { unitIndex: 1, stagePartId: h.ids.parts['TQ-CYH-4004'] })).json.error.message).toMatch(/must differ/);
    expect((await start(inspector, { unitIndex: 1, performedOn: '2030-01-01' })).json.error.message).toMatch(/future/);
    expect((await start(inspector, { unitIndex: 1, performedOn: '2026-09-01' })).json.error.message).toMatch(/before the Stage 1 receipt/);
    expect((await start(inspector, { unitIndex: 1, serialNumber: 'OTHER' })).json.error.message).toMatch(/recorded as SN CYH-S1-001/);
    expect((await quality.send('POST', `/api/inspections/${stage1Id}/stage2`, { unitIndex: 1, stagePartId: stage2PartId, performedOn: '2026-10-20' })).status).toBe(403);
  });
});

describe('a passing Stage 2', () => {
  let stageId: string;
  it('records the fire ring readings against the Stage 2 part limits and completes with an addendum PDF', async () => {
    const created = await start(inspector, { unitIndex: 2 });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    stageId = created.json.id;
    expect(created.json.number).toMatch(/-S2-2$/);
    expect((await start(inspector, { unitIndex: 2 })).status).toBe(409);

    const d = (await inspector.get(`/api/inspection-stages/${stageId}`)).json;
    expect(d).toMatchObject({ status: 'OPEN', serialNumber: 'CYH-S1-002', performedOn: '2026-10-20', stagePart: { partNumber: 'TQ-CYH-4004-S2' } });
    expect(Object.keys(d.limits).sort()).toEqual(['groove_specs:groove_depth', 'groove_specs:wire_protrusion']);
    expect(d.definition.sections.map((s: { key: string; pattern: string }) => `${s.key}:${s.pattern}`)).toEqual(['C_fire_ring:groove_specs']);
    // Someone else cannot enter results on this record.
    expect((await saveStage(inspector2, stageId, GOOD)).status).toBe(403);

    const incomplete = await inspector.send('POST', `/api/inspection-stages/${stageId}/complete`, { expectedVersion: d.version });
    expect(incomplete.status).toBe(422);
    expect((await saveStage(inspector, stageId, GOOD)).status).toBe(200);
    const done = await inspector.send('POST', `/api/inspection-stages/${stageId}/complete`, { expectedVersion: await stageVersion(inspector, stageId) });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    // Groove diameter has no released limit for the Stage 2 part, so (as in Stage 1) Engineering review is required.
    expect(done.json.status).toBe('READY_FOR_REVIEW');
    expect((await quality.send('POST', `/api/inspection-stages/${stageId}/review`, { decision: 'CONFIRM', comment: 'Groove diameter checked against drawing (fictional)', expectedVersion: await stageVersion(quality, stageId) })).status).toBe(200);
    await h.svc.worker!.drain();

    const final = (await inspector.get(`/api/inspection-stages/${stageId}`)).json;
    expect(final).toMatchObject({ status: 'COMPLETED', outcome: 'PASS' });
    expect(final.reports).toHaveLength(1);
    const text = pdfText('stage2-pass', (await inspector.get(`/api/files/${final.reports[0].fileId}`)).raw);
    expect(text).toContain('CYLINDER HEAD STAGE 2 ADDENDUM');
    expect(text).toContain('CYH-S1-002');
    expect(text).toContain('TQ-CYH-4004-S2');
    expect(text).toContain('10/01/2026'); // Stage 1 received
    expect(text).toContain('10/20/2026'); // Stage 2 date
    expect(text).toContain('0.029 – 0.031 in');
    expect(text).toContain('REVIEWED BY');
  });

  it('leaves the Stage 1 inspection and its report unchanged, and lists the Stage 2 record on it', async () => {
    const s1 = (await inspector.get(`/api/inspections/${stage1Id}`)).json;
    expect(s1.status).toBe('COMPLETED');
    expect(s1.reports).toHaveLength(1);
    expect(s1.stages).toEqual([expect.objectContaining({ id: stageId, unitIndex: 2, serialNumber: 'CYH-S1-002', stagePartNumber: 'TQ-CYH-4004-S2', status: 'COMPLETED', outcome: 'PASS' })]);
    expect((await h.pool.query(`SELECT count(*)::int AS n FROM inspection_response WHERE inspection_id = $1 AND section_key = 'C_fire_ring'`, [stage1Id])).rows[0].n).toBe(0);
  });

  it('is frozen once completed, in the API and in the database', async () => {
    expect((await saveStage(inspector, stageId, GOOD)).status).toBe(409);
    await expect(h.pool.query(`UPDATE inspection_stage_measurement SET value_text = '1', value_numeric = 1 WHERE stage_id = $1`, [stageId])).rejects.toThrow(/locked/);
    await expect(h.pool.query(`UPDATE inspection_stage SET performed_on = '2026-10-21' WHERE id = $1`, [stageId])).rejects.toThrow(/frozen/);
    await expect(h.pool.query(`DELETE FROM inspection_stage WHERE id = $1`, [stageId])).rejects.toThrow(/cannot be deleted/);
  });
});

describe('a failing Stage 2', () => {
  it('needs a note (as in Stage 1, photos are required only on checklist items), goes to independent review, can be returned with a reason, and completes as FAIL', async () => {
    const id = (await start(inspector, { unitIndex: 1, performedOn: '2026-10-21' })).json.id as string;
    const failing = [GOOD[0], GOOD[1], { rowKey: 'wire_protrusion', status: 'F', note: 'Wire protrudes on cylinder 3 (fictional)', readings: six((c) => (c === 3 ? '0.013' : '0.009')) }];
    const noNote = [GOOD[0], GOOD[1], { ...failing[2], note: '' }];
    expect((await saveStage(inspector, id, noNote)).status).toBe(200);
    const missingNote = await inspector.send('POST', `/api/inspection-stages/${id}/complete`, { expectedVersion: await stageVersion(inspector, id) });
    expect(missingNote.status).toBe(422);
    expect(JSON.stringify(missingNote.json)).toMatch(/observation|note/i);
    expect((await saveStage(inspector, id, failing)).status).toBe(200);
    const up = await inspector.upload(`/api/inspection-stages/${id}/photos?rowKey=wire_protrusion`, makePng(60, 40, [150, 40, 40]), 'wire.png', 'image/png');
    expect(up.status, JSON.stringify(up.json)).toBe(201);
    const sent = await inspector.send('POST', `/api/inspection-stages/${id}/complete`, { expectedVersion: await stageVersion(inspector, id) });
    expect(sent.json).toMatchObject({ status: 'READY_FOR_REVIEW', outcome: 'FAIL' });
    const work = await h.pool.query(`SELECT kind, required_capability FROM work_item WHERE subject_type = 'INSPECTION_STAGE' AND subject_id = $1 AND status = 'OPEN'`, [id]);
    expect(work.rows).toEqual([{ kind: 'INSPECTION_REVIEW', required_capability: 'inspection.review' }]);

    // The inspector cannot review their own Stage 2; the refusal is audited.
    expect((await inspector.send('POST', `/api/inspection-stages/${id}/review`, { decision: 'CONFIRM', expectedVersion: await stageVersion(inspector, id) })).status).toBe(403);
    expect((await quality.send('POST', `/api/inspection-stages/${id}/review`, { decision: 'RETURN', expectedVersion: await stageVersion(quality, id) })).status).toBe(422);
    expect((await quality.send('POST', `/api/inspection-stages/${id}/review`, { decision: 'RETURN', comment: 'Re-measure cylinder 3', expectedVersion: await stageVersion(quality, id) })).status).toBe(200);
    expect((await inspector.get(`/api/inspection-stages/${id}`)).json.status).toBe('OPEN');
    ok200(await inspector.send('POST', `/api/inspection-stages/${id}/complete`, { expectedVersion: await stageVersion(inspector, id) }));
    ok200(await quality.send('POST', `/api/inspection-stages/${id}/review`, { decision: 'CONFIRM', comment: 'Fail confirmed (fictional)', expectedVersion: await stageVersion(quality, id) }));
    await h.svc.worker!.drain();
    const final = (await inspector.get(`/api/inspection-stages/${id}`)).json;
    expect(final).toMatchObject({ status: 'COMPLETED', outcome: 'FAIL' });
    expect(final.reviews.map((r: { decision: string }) => r.decision)).toEqual(['RETURNED', 'CONFIRMED']);
    const text = pdfText('stage2-fail', (await inspector.get(`/api/files/${final.reports[0].fileId}`)).raw);
    expect(text).toContain('FAIL');
    expect(text).toContain('Wire protrudes on cylinder 3');
    expect(text).toContain('wire.png');
    const denied = await h.pool.query(`SELECT count(*)::int AS n FROM audit_event WHERE action = 'inspection.stage_review' AND outcome = 'DENIED'`);
    expect(denied.rows[0].n).toBe(1);
  });
});

function ok200(r: { status: number; json: unknown }) {
  expect(r.status, JSON.stringify(r.json)).toBe(200);
}
