import { chmodSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GOOD_ROWS, benchCsv } from '../fixtures/bench.js';
import { makePng } from '../fixtures/images.js';
import { type Harness, type Session, formRevisionId, passAll, save, startHarness, version } from './harness.js';

/** Construction Drawing F1 adversarial cases: mismatched identity, real concurrency, tampering, corrupt evidence. */
let h: Harness;
let inspector: Session;
let quality: Session;
let admin: Session;

beforeAll(async () => {
  h = await startHarness();
  [inspector, quality, admin] = await Promise.all([h.login('inspector'), h.login('quality'), h.login('admin')]);
});
afterAll(async () => h?.close());

const RING = { free_end_gap_relaxed: '10.05', installed_end_gap: '0.52', axial_width_ring_height: '2.980', radial_wall_thickness: '4.20' };

async function launch(extra: Record<string, unknown> = {}) {
  return inspector.send('POST', '/api/inspections', {
    partId: h.ids.parts['TQ-PRK-3003'],
    formRevisionId: await formRevisionId(inspector, 'PDI-IQI-004'),
    unitCount: 1,
    poNumber: 'PO-ADV-1',
    dateReceived: '2026-10-19',
    sourceId: h.ids.sources.ringNwr1,
    lotNumber: 'LOT-ADV-1',
    ...extra,
  });
}

/** One-item ring inspection; optionally fails the coating row with a photo (goes to review). */
async function completed(failWithPhoto: boolean) {
  const id = (await launch()).json.id as string;
  await passAll(inspector, id, 0, 'A');
  await passAll(inspector, id, 1, 'B');
  await save(inspector, id, Object.entries(RING).map(([rowKey, v]) => ({ unitIndex: 1, sectionKey: 'C', rowKey, status: 'P', readings: { a1: v, a2: v } })), [{ unitIndex: 1, serialNumber: 'SN-ADV-1' }]);
  if (failWithPhoto) {
    await save(inspector, id, [{ unitIndex: 1, sectionKey: 'B', rowKey: 'running_face_coating', status: 'F', note: 'Uncoated (fictional)' }]);
    const up = await inspector.upload(`/api/inspections/${id}/photos?unitIndex=1&sectionKey=B&rowKey=running_face_coating`, makePng(40, 30, [120, 20, 20]), 'adv.png', 'image/png');
    expect(up.status).toBe(201);
  }
  const done = await inspector.send('POST', `/api/inspections/${id}/complete`, { expectedVersion: await version(inspector, id) });
  expect(done.status, JSON.stringify(done.json)).toBe(200);
  if (done.json.status === 'READY_FOR_REVIEW') {
    const r = await quality.send('POST', `/api/inspections/${id}/review`, { decision: 'CONFIRM', expectedVersion: await version(quality, id), comment: 'Confirmed (fictional)' });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
  }
  return id;
}

describe('mismatched identity', () => {
  it('an inspection cannot be launched against a source of another part, or a part that does not exist', async () => {
    const wrongSource = await launch({ sourceId: h.ids.sources.headBsc });
    expect(wrongSource.status).toBe(422);
    expect(wrongSource.json.error.message).toMatch(/does not belong to this part/);
    expect((await launch({ partId: '00000000-0000-4000-8000-000000000000' })).status).toBeGreaterThanOrEqual(400);
    expect((await launch({ sourceId: 'not-a-uuid' })).status).toBe(400);
  });
});

describe('real concurrency (parallel requests, not a stale replay)', () => {
  it('two simultaneous saves with the same version: exactly one wins, the other is told to reload', async () => {
    const id = (await launch()).json.id as string;
    const v = await version(inspector, id);
    const results = await Promise.all(
      ['P', 'F'].map((status) => inspector.send('PATCH', `/api/inspections/${id}/entries`, { expectedVersion: v, changes: [{ unitIndex: 0, sectionKey: 'A', rowKey: 'part_marking', status }] })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await version(inspector, id)).toBe(v + 1);
  });

  it('the same bench file uploaded twice at once is recorded once', async () => {
    const file = benchCsv([
      { serial: 'INJ-RACE-1', testedAt: '2026-10-20T08:00:00Z', rows: GOOD_ROWS },
      { serial: 'INJ-RACE-2', testedAt: '2026-10-20T08:05:00Z', rows: GOOD_ROWS },
    ]);
    const results = await Promise.all([1, 2].map(() => inspector.upload('/api/injectors/imports', file, 'race.csv', 'text/csv')));
    for (const r of results) expect([201, 409]).toContain(r.status);
    expect(results.some((r) => r.status === 201)).toBe(true);
    const n = (await h.pool.query(`SELECT count(*)::int AS n FROM injector_test t JOIN injector i ON i.id = t.injector_id WHERE i.serial_number LIKE 'INJ-RACE-%'`)).rows[0].n;
    expect(n).toBe(2);
    expect((await h.pool.query(`SELECT count(*)::int AS n FROM injector WHERE serial_number LIKE 'INJ-RACE-%'`)).rows[0].n).toBe(2);
  });

  it('two simultaneous "open repair case" requests for one injector create one case', async () => {
    const inj = (await inspector.send('POST', '/api/injectors', { partId: h.ids.parts['TQ-INJ-9009'], serialNumber: 'INJ-RACE-REP' })).json.id;
    const results = await Promise.all([1, 2, 3].map((i) => inspector.send('POST', `/api/injectors/${inj}/repair-cases`, { problem: `Parallel open attempt ${i}` })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    for (const r of results) expect([201, 409]).toContain(r.status);
    expect((await h.pool.query(`SELECT count(*)::int AS n FROM repair_case WHERE injector_id = $1 AND status = 'OPEN'`, [inj])).rows[0].n).toBe(1);
  });
});

describe('real concurrency — one open concern per failed row', () => {
  it('two simultaneous concerns from the same failed row create one', async () => {
    const id = (await launch()).json.id as string;
    await save(inspector, id, [{ unitIndex: 1, sectionKey: 'B', rowKey: 'running_face_coating', status: 'F', note: 'Uncoated (fictional)' }]);
    const body = { unitIndex: 1, sectionKey: 'B', rowKey: 'running_face_coating', ownerId: h.ids.users.quality };
    const results = await Promise.all([1, 2].map(() => inspector.send('POST', `/api/inspections/${id}/concerns`, body)));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.json.error.message).toMatch(/open concern already exists/);
    expect((await h.pool.query(`SELECT count(*)::int AS n FROM quality_event WHERE inspection_id = $1`, [id])).rows[0].n).toBe(1);
  });
});

describe('direct status tampering in the database', () => {
  it('completed inspections, their entries, reviews, renditions and files cannot be altered or deleted', async () => {
    const id = await completed(false);
    await h.svc.worker!.drain();
    await expect(h.pool.query(`UPDATE inspection SET outcome = 'FAIL' WHERE id = $1`, [id])).rejects.toThrow();
    await expect(h.pool.query(`UPDATE inspection SET status = 'DRAFT' WHERE id = $1`, [id])).rejects.toThrow();
    await expect(h.pool.query(`DELETE FROM inspection_response WHERE inspection_id = $1`, [id])).rejects.toThrow();
    await expect(h.pool.query(`UPDATE inspection_measurement SET value_text = '9.99' WHERE inspection_id = $1`, [id])).rejects.toThrow();
    const rendition = (await h.pool.query(`SELECT id, file_id FROM report_rendition WHERE subject_id = $1`, [id])).rows[0];
    await expect(h.pool.query(`UPDATE report_rendition SET sha256 = 'x' WHERE id = $1`, [rendition.id])).rejects.toThrow();
    await expect(h.pool.query(`UPDATE file_object SET sha256 = 'x' WHERE id = $1`, [rendition.file_id])).rejects.toThrow();
    await expect(h.pool.query(`DELETE FROM audit_event`)).rejects.toThrow();
  });
});

describe('corrupt evidence', () => {
  it('a photo whose stored bytes no longer match its hash stops the report visibly and permanently, with an actionable message', async () => {
    const id = await completed(true);
    const photo = (await h.pool.query(
      `SELECT f.storage_key FROM evidence_link l JOIN file_object f ON f.id = l.file_id WHERE l.inspection_id = $1 AND l.unlinked_at IS NULL`,
      [id],
    )).rows[0];
    // Stored objects are read-only (0440); tampering first needs write access, as an attacker on the disk would.
    const object = h.svc.storage.objectPath(photo.storage_key);
    chmodSync(object, 0o640);
    writeFileSync(object, Buffer.from('tampered bytes'));
    await h.svc.worker!.drain();
    const job = (await h.pool.query(`SELECT status, attempts, last_error FROM job WHERE kind = 'inspection_report' AND payload::text LIKE $1 ORDER BY id DESC LIMIT 1`, [`%`])).rows[0];
    expect(job).toMatchObject({ status: 'FAILED_PERMANENT', attempts: 1 });
    expect(job.last_error).toMatch(/failed hash verification; the report was not rendered/);
    expect((await h.pool.query('SELECT count(*)::int AS n FROM report_rendition WHERE subject_id = $1', [id])).rows[0].n).toBe(0);
    const system = await admin.get('/api/admin/system');
    expect(system.json.jobs.some((j: { status: string; lastError: string | null }) => j.status === 'FAILED_PERMANENT' && /hash verification/.test(j.lastError ?? ''))).toBe(true);
  });
});
