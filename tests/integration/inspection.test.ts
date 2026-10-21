import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makePng } from '../fixtures/images.js';
import { type Harness, type Session, formRevisionId, passAll, save, startHarness, version } from './harness.js';

let h: Harness;
let inspector: Session;
let quality: Session;
let manager: Session;

const pdfToText = (bytes: Buffer) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tqms-pdf-'));
  const file = path.join(dir, 'r.pdf');
  writeFileSync(file, bytes);
  return execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
};

beforeAll(async () => {
  h = await startHarness();
  inspector = await h.login('inspector');
  quality = await h.login('quality');
  manager = await h.login('manager');
});
afterAll(async () => h?.close());

async function launchRingKit(s: Session, units = 2, extra: Record<string, unknown> = {}) {
  const parts = (await s.get('/api/parts?q=OE-PRK-55')).json as Array<{ id: string; partNumber: string }>;
  expect(parts[0]!.partNumber).toBe('TQ-PRK-3003'); // found by OE alias
  const res = await s.send('POST', '/api/inspections', {
    partId: parts[0]!.id,
    formRevisionId: await formRevisionId(s, 'PDI-IQI-004'),
    unitCount: units,
    poNumber: 'PO-55120',
    dateReceived: '2026-10-19',
    sourceId: h.ids.sources.ringNwr1,
    lotNumber: 'LOT-A17',
    lotSize: 240,
    ...extra,
  });
  expect(res.status).toBe(201);
  return res.json.id as string;
}

const RING_READINGS: Record<string, string> = {
  free_end_gap_relaxed: '10.05',
  installed_end_gap: '0.52',
  axial_width_ring_height: '2.980',
  radial_wall_thickness: '4.20',
};

async function completeRingUnits(s: Session, id: string, units: number[]) {
  await passAll(s, id, 0, 'A');
  for (const u of units) {
    await passAll(s, id, u, 'B');
    const r = await save(
      s,
      id,
      Object.entries(RING_READINGS).map(([rowKey, v]) => ({ unitIndex: u, sectionKey: 'C', rowKey, status: 'P', readings: { a1: v, a2: v } })),
      [{ unitIndex: u, serialNumber: `SN-${u}00${u}` }],
    );
    expect(r.status).toBe(200);
  }
}

describe('AT-01 receiving inspection, multi-item, fail with evidence', () => {
  let id: string;
  it('runs launch → shared section → items → missing photo blocked → photo → review → frozen PDF', async () => {
    id = await launchRingKit(inspector);
    await completeRingUnits(inspector, id, [1, 2]);

    // Item 2 coating failure: note entered, photo missing.
    let r = await save(inspector, id, [{ unitIndex: 2, sectionKey: 'B', rowKey: 'running_face_coating', status: 'F', note: 'Coating flaking near gap, approx 3 mm' }]);
    expect(r.status).toBe(200);

    // Pause / resume: partial save and reload keep every entry.
    r = await inspector.send('POST', `/api/inspections/${id}/save-partial`, { expectedVersion: await version(inspector, id) });
    expect(r.status).toBe(200);
    const resumed = (await inspector.get(`/api/inspections/${id}`)).json;
    expect(resumed.status).toBe('PARTIAL');
    expect(resumed.readings['1|C|installed_end_gap|a1'].text).toBe('0.52');
    expect(resumed.units[1].serialNumber).toBe('SN-2002');

    r = await inspector.send('POST', `/api/inspections/${id}/complete`, { expectedVersion: resumed.version });
    expect(r.status).toBe(422);
    expect(r.json.error.details.errors.map((e: { path: string; message: string }) => `${e.path}: ${e.message}`)).toEqual([
      'Item 2 → Visual → Running Face Coating: photograph of this characteristic is required',
    ]);
    expect((await inspector.get(`/api/inspections/${id}`)).json.responses['2|B|running_face_coating'].status).toBe('F'); // partial data preserved

    const up = await inspector.upload(`/api/inspections/${id}/photos?unitIndex=2&sectionKey=B&rowKey=running_face_coating`, makePng(120, 90), 'coating.png', 'image/png');
    expect(up.status).toBe(201);

    r = await inspector.send('POST', `/api/inspections/${id}/complete`, { expectedVersion: await version(inspector, id) });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: 'READY_FOR_REVIEW', outcome: 'FAIL' });

    // Locked while awaiting review.
    r = await save(inspector, id, [{ unitIndex: 1, sectionKey: 'B', rowKey: 'ring_body', status: 'F', note: 'x' }]);
    expect(r.status).toBe(409);

    r = await quality.send('POST', `/api/inspections/${id}/review`, { decision: 'CONFIRM', comment: 'Failure confirmed', expectedVersion: await version(quality, id) });
    expect(r.status).toBe(200);
    expect(await h.svc.worker!.drain()).toBe(1);

    const done = (await quality.get(`/api/inspections/${id}`)).json;
    expect(done.status).toBe('COMPLETED');
    expect(done.outcome).toBe('FAIL');
    expect(done.reports).toHaveLength(1);
    const file = await quality.get(`/api/files/${done.reports[0].fileId}`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(createHash('sha256').update(file.raw).digest('hex')).toBe(done.reports[0].sha256);
    const text = pdfToText(file.raw);
    for (const expected of [
      'INCOMING QUALITY INSPECTION',
      'OVERALL OUTCOME: FAIL',
      'TQ-PRK-3003',
      'PO-55120',
      'ITEM 1 OF 2 · SERIAL SN-1001',
      'ITEM 2 OF 2 · SERIAL SN-2002',
      'Coating flaking near gap',
      'Photo 1',
      '9.80 – 10.40 mm',
      'Independent review: confirmed by Casey Morgan',
      'Page 1 of',
    ]) {
      expect(text).toContain(expected);
    }
    expect(text).not.toMatch(/Edition 0|DRAFT/);
  });

  it('NEG-02: a completed inspection cannot be edited; an authorized amendment preserves the original edition', async () => {
    const before = (await manager.get(`/api/inspections/${id}`)).json;
    let r = await save(inspector, id, [{ unitIndex: 1, sectionKey: 'B', rowKey: 'ring_body', status: 'F', note: 'tamper' }]);
    expect(r.status).toBe(409);
    await expect(h.pool.query(`UPDATE inspection_response SET status = 'P' WHERE inspection_id = $1`, [id])).rejects.toThrow(/frozen/);
    await expect(h.pool.query(`UPDATE inspection SET outcome = 'PASS' WHERE id = $1`, [id])).rejects.toThrow(/frozen/);

    // Inspector lacks amendment authority.
    r = await inspector.send('POST', `/api/inspections/${id}/amendments`, {
      reason: 'Fix it',
      expectedVersion: before.version,
      changes: [{ unitIndex: 2, sectionKey: 'B', rowKey: 'gap_end_faces', status: 'P' }],
    });
    expect(r.status).toBe(403);

    r = await manager.send('POST', `/api/inspections/${id}/amendments`, {
      reason: 'Serial transcription corrected per packing slip; note clarified',
      expectedVersion: before.version,
      changes: [{ unitIndex: 2, sectionKey: 'B', rowKey: 'running_face_coating', note: 'Coating flaking near gap, approx 3 mm; confirmed under 10x loupe' }],
    });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ amendmentNo: 1, outcome: 'FAIL' });
    await h.svc.worker!.drain();
    const after = (await manager.get(`/api/inspections/${id}`)).json;
    expect(after.reports.map((x: { edition: number }) => x.edition)).toEqual([1, 2]);
    expect(after.reports[0].sha256).toBe(before.reports[0].sha256);
    const original = await manager.get(`/api/files/${before.reports[0].fileId}`);
    expect(createHash('sha256').update(original.raw).digest('hex')).toBe(before.reports[0].sha256);
    const orig = await h.pool.query(`SELECT note FROM inspection_response WHERE inspection_id = $1 AND unit_index = 2 AND row_key = 'running_face_coating' AND amendment_no = 0`, [id]);
    expect(orig.rows[0].note).toBe('Coating flaking near gap, approx 3 mm');
    expect(pdfToText((await manager.get(`/api/files/${after.reports[1].fileId}`)).raw)).toContain('Amendment 1 by Riley Chen');
  });
});

describe('authority and independence', () => {
  it('NEG-19 / AT-19: the inspector of record cannot review their own inspection, even with review authority', async () => {
    const id = await launchRingKit(manager, 1);
    await completeRingUnits(manager, id, [1]);
    await save(manager, id, [{ unitIndex: 1, sectionKey: 'B', rowKey: 'ring_body', status: 'F', note: 'Kinked ring' }]);
    await manager.upload(`/api/inspections/${id}/photos?unitIndex=1&sectionKey=B&rowKey=ring_body`, makePng(), 'ring.png', 'image/png');
    expect((await manager.send('POST', `/api/inspections/${id}/complete`, { expectedVersion: await version(manager, id) })).status).toBe(200);
    const r = await manager.send('POST', `/api/inspections/${id}/review`, { decision: 'CONFIRM', expectedVersion: await version(manager, id) });
    expect(r.status).toBe(403);
    expect(r.json.error.message).toMatch(/cannot review their own/);
    const denied = await h.pool.query(`SELECT 1 FROM audit_event WHERE entity_id = $1 AND outcome = 'DENIED' AND action = 'inspection.review'`, [id]);
    expect(denied.rowCount).toBe(1);
  });

  it('NEG-01 style: an inspector calling review, triage or grant APIs directly is denied and audited', async () => {
    const id = await launchRingKit(inspector, 1);
    let r = await inspector.send('POST', `/api/inspections/${id}/review`, { decision: 'CONFIRM', expectedVersion: 1 });
    expect(r.status).toBe(403);
    r = await inspector.send('POST', `/api/admin/users/${h.ids.users.inspector2}/grants`, { capabilities: ['inspection.review'], reason: 'please' });
    expect(r.status).toBe(403);
    const audits = await h.pool.query(`SELECT action FROM audit_event WHERE actor_id = $1 AND outcome = 'DENIED'`, [h.ids.users.inspector]);
    expect(audits.rows.map((x) => x.action)).toEqual(expect.arrayContaining(['inspection.review', 'admin.grant']));
  });

  it('AT-02: Accepted needs authorized review; acceptance stays distinct from PASS', async () => {
    const id = await launchRingKit(inspector, 1);
    await completeRingUnits(inspector, id, [1]);
    await save(inspector, id, [{ unitIndex: 1, sectionKey: 'B', rowKey: 'orientation_mark', status: 'A', note: 'Mark faint but legible' }]);
    await inspector.upload(`/api/inspections/${id}/photos?unitIndex=1&sectionKey=B&rowKey=orientation_mark`, makePng(), 'mark.png', 'image/png');
    const c = await inspector.send('POST', `/api/inspections/${id}/complete`, { expectedVersion: await version(inspector, id) });
    expect(c.json).toMatchObject({ status: 'READY_FOR_REVIEW', outcome: 'ACCEPTED' });
    // Quality may review but lacks accepted-result authority.
    let r = await quality.send('POST', `/api/inspections/${id}/review`, { decision: 'CONFIRM', expectedVersion: await version(quality, id) });
    expect(r.status).toBe(403);
    r = await manager.send('POST', `/api/inspections/${id}/review`, { decision: 'CONFIRM', comment: 'Cosmetic only', expectedVersion: await version(manager, id) });
    expect(r.status).toBe(200);
    await h.svc.worker!.drain();
    const d = (await manager.get(`/api/inspections/${id}`)).json;
    expect(d.outcome).toBe('ACCEPTED');
    const text = pdfToText((await manager.get(`/api/files/${d.reports[0].fileId}`)).raw);
    expect(text).toContain('OVERALL OUTCOME: ACCEPTED');
    expect(text).toContain('does not authorize material release');
  });

  it('a reviewer can return an inspection for correction with a reason', async () => {
    const id = await launchRingKit(inspector, 1);
    await completeRingUnits(inspector, id, [1]);
    await save(inspector, id, [{ unitIndex: 1, sectionKey: 'B', rowKey: 'gap_end_faces', status: 'F', note: 'Burr' }]);
    await inspector.upload(`/api/inspections/${id}/photos?unitIndex=1&sectionKey=B&rowKey=gap_end_faces`, makePng(), 'g.png', 'image/png');
    await inspector.send('POST', `/api/inspections/${id}/complete`, { expectedVersion: await version(inspector, id) });
    let r = await quality.send('POST', `/api/inspections/${id}/review`, { decision: 'RETURN', expectedVersion: await version(quality, id) });
    expect(r.status).toBe(422);
    r = await quality.send('POST', `/api/inspections/${id}/review`, { decision: 'RETURN', comment: 'Add serial numbers', expectedVersion: await version(quality, id) });
    expect(r.status).toBe(200);
    const d = (await inspector.get(`/api/inspections/${id}`)).json;
    expect(d.status).toBe('PARTIAL');
    expect(d.permissions.canEdit).toBe(true);
  });
});

describe('measurement governance', () => {
  it('NEG-16: readings without a released limit route to Engineering review instead of completing as PASS', async () => {
    const parts = (await inspector.get('/api/parts?q=TQ-PST-1001')).json;
    const res = await inspector.send('POST', '/api/inspections', {
      partId: parts[0].id,
      formRevisionId: await formRevisionId(inspector, 'PDI-IQI-001'),
      unitCount: 1,
      dateReceived: '2026-10-19',
    });
    const id = res.json.id;
    await passAll(inspector, id, 0, 'A');
    await passAll(inspector, id, 1, 'B');
    const rows = ['skirt_od', 'pin_bore_diameter', 'ring_groove_width_top_compression_no_1', 'ring_groove_width_oil_control_no_3'];
    await save(inspector, id, [
      ...rows.map((rowKey) => ({ unitIndex: 1, sectionKey: 'C', rowKey, status: 'P', readings: { a1: '5.000' } })),
      { unitIndex: 1, sectionKey: 'C', rowKey: 'abutment_face_flatness_two_piece_only', status: 'N', note: 'One-piece piston' },
    ]);
    const r = await inspector.send('POST', `/api/inspections/${id}/complete`, { expectedVersion: await version(inspector, id) });
    expect(r.json).toMatchObject({ status: 'READY_FOR_REVIEW', outcome: 'PASS' });
    const d = (await inspector.get(`/api/inspections/${id}`)).json;
    expect(d.reviewReasons.filter((x: { message: string }) => x.message.includes('Specification not released'))).toHaveLength(4);
  });

  it('a recorded value outside the released limit cannot be passed', async () => {
    const id = await launchRingKit(inspector, 1);
    await completeRingUnits(inspector, id, [1]);
    await save(inspector, id, [{ unitIndex: 1, sectionKey: 'C', rowKey: 'installed_end_gap', readings: { a3: '0.66' } }]);
    const r = await inspector.send('POST', `/api/inspections/${id}/complete`, { expectedVersion: await version(inspector, id) });
    expect(r.status).toBe(422);
    expect(r.json.error.details.errors[0].message).toMatch(/outside the released limit/);
    const stored = await h.pool.query(`SELECT value_text, value_numeric::text, decimals, unit FROM inspection_measurement WHERE inspection_id = $1 AND reading_key = 'a3'`, [id]);
    expect(stored.rows[0]).toEqual({ value_text: '0.66', value_numeric: '0.66', decimals: 2, unit: 'mm' });
  });

  it('rejects malformed readings and status values at the API', async () => {
    const id = await launchRingKit(inspector, 1);
    let r = await save(inspector, id, [{ unitIndex: 1, sectionKey: 'C', rowKey: 'installed_end_gap', readings: { a1: '0.5mm' } }]);
    expect(r.status).toBe(422);
    r = await save(inspector, id, [{ unitIndex: 1, sectionKey: 'C', rowKey: 'installed_end_gap', readings: { a9: '1' } }]);
    expect(r.status).toBe(400);
    r = await save(inspector, id, [{ unitIndex: 0, sectionKey: 'B', rowKey: 'ring_body', status: 'P' }]);
    expect(r.status).toBe(400);
  });

  it('NEG-23: Pass All keeps an entered Fail unless overwrite is explicitly chosen', async () => {
    const id = await launchRingKit(inspector, 1);
    await save(inspector, id, [{ unitIndex: 1, sectionKey: 'B', rowKey: 'ring_body', status: 'F', note: 'Twisted' }]);
    let r = await passAll(inspector, id, 1, 'B');
    expect(r.json).toMatchObject({ filled: 3, overwritten: 0, skipped: 1 });
    expect((await inspector.get(`/api/inspections/${id}`)).json.responses['1|B|ring_body'].status).toBe('F');
    r = await inspector.send('POST', `/api/inspections/${id}/pass-all`, { expectedVersion: await version(inspector, id), unitIndex: 1, sectionKey: 'C', mode: 'fill_blank' });
    expect(r.status).toBe(400); // measurements are never filled
    r = await inspector.send('POST', `/api/inspections/${id}/pass-all`, { expectedVersion: await version(inspector, id), unitIndex: 1, sectionKey: 'B', mode: 'overwrite_all' });
    expect(r.json.overwritten).toBe(1);
    const audit = await h.pool.query(`SELECT before_state FROM audit_event WHERE entity_id = $1 AND action = 'inspection.pass_all_overwrite'`, [id]);
    expect(audit.rows[0].before_state).toEqual([{ rowKey: 'ring_body', status: 'F' }]);
  });

  it('optimistic concurrency rejects a stale version', async () => {
    const id = await launchRingKit(inspector, 1);
    const v = await version(inspector, id);
    expect((await inspector.send('PATCH', `/api/inspections/${id}/entries`, { expectedVersion: v, changes: [{ unitIndex: 0, sectionKey: 'A', rowKey: 'part_marking', status: 'P' }] })).status).toBe(200);
    const stale = await inspector.send('PATCH', `/api/inspections/${id}/entries`, { expectedVersion: v, changes: [{ unitIndex: 0, sectionKey: 'A', rowKey: 'part_marking', status: 'F' }] });
    expect(stale.status).toBe(409);
  });
});

describe('form revision history (AT-03 / NEG-03)', () => {
  it('existing inspections keep revision A while new work uses the newly released revision', async () => {
    const oldId = await launchRingKit(inspector, 1);
    const oldRev = await formRevisionId(inspector, 'PDI-IQI-004');
    // Simulate an authorized release of a new revision (the structured editor is a later stage).
    await h.pool.query(`
      WITH f AS (SELECT form_id, definition FROM form_revision WHERE id = '${oldRev}')
      INSERT INTO form_revision (form_id, sequence, revision_label, status, definition, definition_sha256, provenance, released_by, released_at)
      SELECT form_id, 2, 'B', 'DRAFT', jsonb_set(definition, '{revisionLabel}', '"B"'), 'test', 'test release', '${h.ids.users.engineering}', now() FROM f`);
    await h.pool.query(`UPDATE form_revision SET status = 'SUPERSEDED' WHERE id = $1`, [oldRev]);
    await h.pool.query(`UPDATE form_revision SET status = 'RELEASED' WHERE revision_label = 'B' AND form_id = (SELECT form_id FROM form_revision WHERE id = $1)`, [oldRev]);
    await expect(h.pool.query(`UPDATE form_revision SET definition = '{}'::jsonb WHERE id = $1`, [oldRev])).rejects.toThrow(/immutable/);

    const r = await inspector.send('POST', '/api/inspections', {
      partId: (await inspector.get('/api/parts?q=TQ-PRK-3003')).json[0].id,
      formRevisionId: oldRev,
      unitCount: 1,
      dateReceived: '2026-10-19',
    });
    expect(r.status).toBe(422);
    const newId = await launchRingKit(inspector, 1);
    expect((await inspector.get(`/api/inspections/${newId}`)).json.form.definition.revisionLabel).toBe('B');
    expect((await inspector.get(`/api/inspections/${oldId}`)).json.form.definition.revisionLabel).toBeNull();
  });
});

describe('evidence files', () => {
  it('NEG-10: disguised, oversized and traversal uploads are rejected or neutralized without serving bytes', async () => {
    const id = await launchRingKit(inspector, 1);
    const q = `/api/inspections/${id}/photos?unitIndex=1&sectionKey=B&rowKey=ring_body`;
    let r = await inspector.upload(q, Buffer.from('<html><script>alert(1)</script></html>'), 'photo.jpg', 'image/jpeg');
    expect(r.status).toBe(422);
    r = await inspector.upload(q, Buffer.concat([makePng(), Buffer.alloc(3 * 1024 * 1024)]), 'huge.png', 'image/png');
    expect(r.status).toBe(413);
    r = await inspector.upload(q, makePng(), '../../../etc/passwd.png', 'image/png');
    expect(r.status).toBe(201);
    const f = await h.pool.query(`SELECT original_name, storage_key FROM file_object WHERE id = $1`, [r.json.fileId]);
    expect(f.rows[0].original_name).toBe('passwd.png');
    expect(f.rows[0].storage_key).toMatch(/^[0-9a-f-]{36}$/);
    const rejected = await h.pool.query(`SELECT count(*)::int AS n FROM file_object WHERE status = 'REJECTED' AND storage_key IS NULL`);
    expect(rejected.rows[0].n).toBeGreaterThanOrEqual(2);
    r = await inspector.upload(`/api/inspections/${id}/photos?unitIndex=1&sectionKey=B&rowKey=../../x`, makePng(), 'a.png', 'image/png');
    expect(r.status).toBe(400);
  });

  it('NEG-11: file URLs carry no authority — unauthenticated, deactivated and unauthorized sessions are refused', async () => {
    const id = await launchRingKit(inspector, 1);
    const up = await inspector.upload(`/api/inspections/${id}/photos?unitIndex=1&sectionKey=B&rowKey=ring_body`, makePng(), 'a.png', 'image/png');
    const url = `/api/files/${up.json.fileId}`;
    expect((await h.app.inject({ method: 'GET', url })).statusCode).toBe(401);
    const other = await h.login('inspector2');
    expect((await other.get(url)).status).toBe(200);
    const admin = await h.login('admin');
    await admin.send('POST', `/api/admin/grants/${(await h.pool.query(`SELECT id FROM authority_grant WHERE user_id = $1 AND capability_code = 'records.read' AND revoked_at IS NULL`, [h.ids.users.inspector2])).rows[0].id}/revoke`, { reason: 'Test revoke' });
    expect((await other.get(url)).status).toBe(403);
    await admin.send('POST', `/api/admin/users/${h.ids.users.inspector2}/deactivate`, { reason: 'Left company' });
    expect((await other.get(url)).status).toBe(401);
    const res = (await inspector.get(url)).headers;
    expect(res['x-content-type-options']).toBe('nosniff');
    expect(String(res['content-security-policy'])).toContain('sandbox');
  });

  it('NEG-12: readiness fails clearly when the evidence volume marker is missing or storage is read-only', async () => {
    const ok = await h.app.inject({ method: 'GET', url: '/health/ready' });
    expect(ok.statusCode).toBe(200);
    const { EvidenceStorage } = await import('../../src/server/storage.js');
    const missing = new EvidenceStorage(path.join(h.storageRoot, 'not-mounted'), 1);
    expect((await missing.check()).ok).toBe(false);
    const empty = mkdtempSync(path.join(os.tmpdir(), 'tqms-unmounted-'));
    const unmarked = new EvidenceStorage(empty, 1);
    expect(await unmarked.check()).toMatchObject({ ok: false, reason: expect.stringMatching(/marker missing/) });
    const original = h.svc.storage;
    (h.svc as { storage: typeof original }).storage = unmarked;
    const bad = await h.app.inject({ method: 'GET', url: '/health/ready' });
    (h.svc as { storage: typeof original }).storage = original;
    expect(bad.statusCode).toBe(503);
    expect(bad.json().checks.evidenceStorage.ok).toBe(false);
  });
});

describe('quality concern linkage', () => {
  it('a concern raised from a failed row carries identity and the same photo without re-entry; reporter cannot triage', async () => {
    const id = await launchRingKit(inspector, 1);
    await save(inspector, id, [{ unitIndex: 1, sectionKey: 'B', rowKey: 'running_face_coating', status: 'F', note: 'Uncoated running face' }], [{ unitIndex: 1, serialNumber: 'SN-777' }]);
    const up = await inspector.upload(`/api/inspections/${id}/photos?unitIndex=1&sectionKey=B&rowKey=running_face_coating`, makePng(71, 53, [12, 34, 56]), 'c.png', 'image/png');
    const c = await inspector.send('POST', `/api/inspections/${id}/concerns`, { unitIndex: 1, sectionKey: 'B', rowKey: 'running_face_coating' });
    expect(c.status).toBe(201);
    const ev = (await quality.get(`/api/quality/events/${c.json.id}`)).json;
    expect(ev.event).toMatchObject({ po_number: 'PO-55120', lot_number: 'LOT-A17', serial_number: 'SN-777', characteristic: 'Running Face Coating', origin_type: 'INSPECTION' });
    expect(ev.event.actual).toContain('Uncoated running face');
    expect(ev.photos.map((p: { fileId: string }) => p.fileId)).toEqual([up.json.fileId]);
    const files = await h.pool.query(`SELECT count(*)::int AS n FROM file_object WHERE sha256 = (SELECT sha256 FROM file_object WHERE id = $1)`, [up.json.fileId]);
    expect(files.rows[0].n).toBe(1);

    // The inspector (reporter) cannot triage; an independent quality user can.
    expect((await inspector.send('POST', `/api/quality/events/${c.json.id}/triage`, { expectedVersion: 1, decision: 'NONCONFIRMED', reason: 'x' })).status).toBe(403);
    const t = await quality.send('POST', `/api/quality/events/${c.json.id}/triage`, { expectedVersion: 1, decision: 'TRIAGED', ownerId: h.ids.users.engineering, severity: 'HIGH' });
    expect(t.status).toBe(200);
    const work = (await (await h.login('engineering')).get('/api/home')).json.work;
    expect(work.some((w: { kind: string; subjectId: string }) => w.kind === 'CONCERN_FOLLOW_UP' && w.subjectId === c.json.id)).toBe(true);
  });

  it('NEG-18: there is no generic "mark done" endpoint for work items', async () => {
    const items = await h.pool.query(`SELECT id FROM work_item WHERE status = 'OPEN' LIMIT 1`);
    const r = await quality.send('POST', `/api/work/${items.rows[0].id}/complete`, {});
    expect(r.status).toBe(404);
  });
});

describe('report job recovery (AT-21)', () => {
  it('a report job abandoned by a crashed worker is reclaimed and renders exactly one edition', async () => {
    const id = await launchRingKit(inspector, 1);
    await completeRingUnits(inspector, id, [1]);
    const r = await inspector.send('POST', `/api/inspections/${id}/complete`, { expectedVersion: await version(inspector, id) });
    expect(r.json.status).toBe('COMPLETED'); // all limits released and within → no review needed
    const claimed = await h.svc.worker!.claim();
    expect(claimed).not.toBeNull();
    // Simulate the process dying mid-job: the claim is left behind.
    await h.pool.query(`UPDATE job SET claimed_at = now() - interval '10 minutes' WHERE id = $1`, [claimed!.id]);
    expect(await h.svc.worker!.drain()).toBe(1);
    const n = await h.pool.query(`SELECT count(*)::int AS n FROM report_rendition WHERE subject_id = $1`, [id]);
    expect(n.rows[0].n).toBe(1);
    // A duplicate run of the same job is a no-op.
    await h.svc.worker!.runJob({ ...claimed!, attempts: 2 });
    expect((await h.pool.query(`SELECT count(*)::int AS n FROM report_rendition WHERE subject_id = $1`, [id])).rows[0].n).toBe(1);
  });
});

describe('platform safety', () => {
  it('state changes need the session CSRF token', async () => {
    const r = await h.app.inject({ method: 'POST', url: '/api/quality/events', headers: { cookie: inspector.cookie, 'content-type': 'application/json' }, payload: '{}' });
    expect(r.statusCode).toBe(403);
  });

  it('audit history is append-only', async () => {
    await expect(h.pool.query(`UPDATE audit_event SET summary = 'x'`)).rejects.toThrow(/append-only/);
    await expect(h.pool.query(`DELETE FROM audit_event`)).rejects.toThrow(/append-only/);
  });

  it('administrators cannot grant themselves authority', async () => {
    const admin = await h.login('admin');
    const r = await admin.send('POST', `/api/admin/users/${h.ids.users.admin}/grants`, { capabilities: ['inspection.review'], reason: 'self' });
    expect(r.status).toBe(403);
  });

  it('locks an account after repeated failed sign-ins', async () => {
    for (let i = 0; i < 8; i += 1) {
      await h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'casey.morgan@example.com', password: 'wrong-password-123' }, remoteAddress: `10.0.0.${i}` });
    }
    const r = await h.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'casey.morgan@example.com', password: 'Test-Only-Password-2026' }, remoteAddress: '10.0.1.1' });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.message).toMatch(/Too many failed attempts/);
  });
});
