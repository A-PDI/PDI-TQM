import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dayIn } from '../../src/shared/quality.js';
import { GOOD_ROWS, benchCsv } from '../fixtures/bench.js';
import { makePng } from '../fixtures/images.js';
import { type Harness, type Session, formRevisionId, passAll, save, startHarness, version } from './harness.js';

/** Stage 4: management metrics (FR-102/FR-104), exports (FR-103/C10), issued reports and traceability (AT-20/FR-010). */
let h: Harness;
let inspector: Session;
let quality: Session;
let ringPartId: string;
const OUT = path.resolve(import.meta.dirname, '../../var/report-samples');
const TZ = 'America/Chicago';
const today = () => dayIn(TZ);
const daysAgo = (n: number) => dayIn(TZ, new Date(Date.now() - n * 86_400_000));

const ok = (r: { status: number; json: unknown }, status = 200) => {
  expect(r.status, JSON.stringify(r.json)).toBe(status);
  return r.json as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
};

const RING = { free_end_gap_relaxed: '10.05', installed_end_gap: '0.52', axial_width_ring_height: '2.980', radial_wall_thickness: '4.20' };

/** Completed ring-kit inspection; failed units record an uncoated running face with photo, concern and NCR. */
async function ringInspection(lot: string, failUnit: number | null): Promise<{ id: string; ncrId: string | null }> {
  const s = inspector;
  const id = ok(
    await s.send('POST', '/api/inspections', {
      partId: ringPartId,
      formRevisionId: await formRevisionId(s, 'PDI-IQI-004'),
      unitCount: 2,
      poNumber: 'PO-88120',
      dateReceived: today(),
      sourceId: h.ids.sources.ringNwr1,
      lotNumber: lot,
    }),
    201,
  ).id as string;
  await passAll(s, id, 0, 'A');
  for (let u = 1; u <= 2; u += 1) {
    await passAll(s, id, u, 'B');
    ok(await save(s, id, Object.entries(RING).map(([rowKey, v]) => ({ unitIndex: u, sectionKey: 'C', rowKey, status: 'P', readings: { a1: v } })), [{ unitIndex: u, serialNumber: `${lot}-SN${u}` }]));
  }
  if (failUnit) {
    ok(await save(s, id, [{ unitIndex: failUnit, sectionKey: 'B', rowKey: 'running_face_coating', status: 'F', note: 'Running face uncoated (fictional)' }]));
    ok(await s.upload(`/api/inspections/${id}/photos?unitIndex=${failUnit}&sectionKey=B&rowKey=running_face_coating`, makePng(60, 40, [150, 30, 30]), 'coating.png', 'image/png'), 201);
  }
  const done = ok(await s.send('POST', `/api/inspections/${id}/complete`, { expectedVersion: await version(s, id) }));
  let ncrId: string | null = null;
  if (failUnit) {
    const eventId = ok(await s.send('POST', `/api/inspections/${id}/concerns`, { unitIndex: failUnit, sectionKey: 'B', rowKey: 'running_face_coating', ownerId: h.ids.users.quality }), 201).id;
    ok(await quality.send('POST', `/api/quality/events/${eventId}/triage`, { expectedVersion: 1, decision: 'TRIAGED', ownerId: h.ids.users.quality, severity: 'MEDIUM' }));
    ncrId = ok(
      await quality.send('POST', `/api/quality/events/${eventId}/confirm-ncr`, {
        expectedVersion: 2,
        severity: 'MEDIUM',
        ownerId: h.ids.users.quality,
        failureMode: 'Missing running-face coating',
        rationale: 'Coating absent; recurrence check (fictional)',
      }),
      201,
    ).id;
  }
  if (done.status === 'READY_FOR_REVIEW') {
    ok(await quality.send('POST', `/api/inspections/${id}/review`, { decision: 'CONFIRM', expectedVersion: await version(quality, id), comment: 'Confirmed (fictional)' }));
  }
  return { id, ncrId };
}

let passId: string;
let failA: { id: string; ncrId: string | null };

beforeAll(async () => {
  h = await startHarness();
  [inspector, quality] = await Promise.all([h.login('inspector'), h.login('quality')]);
  mkdirSync(OUT, { recursive: true });
  ringPartId = h.ids.parts['TQ-PRK-3003']!;
  passId = (await ringInspection('LOT-R1', null)).id;
  failA = await ringInspection('LOT-R2', 2);
  await ringInspection('LOT-R3', 1);

  // Fixture: an earlier rejected FAI on the same source that found the same nonconforming characteristic.
  const fai = (
    await h.pool.query(
      `INSERT INTO fai_sample (number, source_id, sequence, sample_type, baseline_revision_id, received_date, recorded_by)
       SELECT 'FAI-SYN-0001', s.id, 1, 'INITIAL_FAI', s.baseline_revision_id, $2::date, $3 FROM source s WHERE s.id = $1 RETURNING id`,
      [h.ids.sources.ringNwr1, daysAgo(40), h.ids.users.engineering],
    )
  ).rows[0].id;
  await h.pool.query(
    `INSERT INTO fai_result (fai_id, char_key, char_name, visual_result, evaluation, recorded_by) VALUES ($1, 'coating', 'Running Face Coating', 'DOES_NOT_CONFORM', 'DOES_NOT_CONFORM', $2)`,
    [fai, h.ids.users.engineering],
  );
  await h.pool.query(
    `UPDATE fai_sample SET status = 'DECIDED', decision = 'REJECTED', defects = 'Uncoated running face on 2 of 5 rings', rationale = 'Coating missing', decided_by = $2, decided_at = now() - interval '39 days', grants_used = '{source.approve}' WHERE id = $1`,
    [fai, h.ids.users.manager],
  );
});
afterAll(async () => h?.close());

describe('FR-102 / FR-104 — management overview with consistent definitions', () => {
  it('reports throughput, outcomes and defect types for the period, with drill-down that matches', async () => {
    const o = ok(await quality.get(`/api/reports/overview?from=${today()}&to=${today()}`));
    expect(o.definitionsVersion).toBe('METRICS-INTERIM-1');
    expect(o.period).toEqual({ from: today(), to: today(), timeZone: TZ });
    expect(o.inspections).toMatchObject({ completed: 3, started: 3, outcomes: { PASS: 1, FAIL: 2, ACCEPTED: 0 }, failRate: 66.7 });
    expect(o.inspections.defects[0]).toMatchObject({ name: 'Running Face Coating', fail: 2, accepted: 0, inspections: 2, parts: ['TQ-PRK-3003'] });

    const fail = ok(await quality.get(o.inspections.links.FAIL.replace('/inspections?', '/api/inspections?')));
    expect(fail.total).toBe(2);
    const all = ok(await quality.get(o.inspections.links.completed.replace('/inspections?', '/api/inspections?')));
    expect(all.total).toBe(3);
    expect(all.items.map((i: { id: string }) => i.id)).toContain(passId);

    const yesterday = ok(await quality.get(`/api/reports/overview?from=${daysAgo(1)}&to=${daysAgo(1)}`));
    expect(yesterday.inspections.completed).toBe(0);
    expect((await quality.get(`/api/reports/overview?from=${today()}&to=${daysAgo(1)}`)).status).toBe(400);
  });

  it('Home and the report agree on open and overdue counts', async () => {
    const o = ok(await quality.get('/api/reports/overview'));
    const home = ok(await quality.get('/api/home'));
    expect(home.counts).toEqual(o.corrective.counts);
    expect(o.corrective.counts.open_ncrs).toBe(2);
    expect(o.corrective.ncrsConfirmed).toBe(2);
  });

  it('supplier quality, approvals and recurrence (including a repeated rejected-FAI defect)', async () => {
    const o = ok(await quality.get('/api/reports/overview'));
    const nwr = o.suppliers.find((s: { completed: number }) => s.completed === 3);
    expect(nwr).toMatchObject({ failed: 2, ncrs: 2, openNcrs: 2, failRate: 66.7 });
    expect(nwr.inspectionsLink).toContain(`supplierId=${nwr.id}`);
    expect(o.recurrence.groups).toHaveLength(1);
    expect(o.recurrence.groups[0]).toMatchObject({ part_number: 'TQ-PRK-3003', characteristic: 'running face coating', failure_mode: 'missing running-face coating' });
    expect(o.recurrence.groups[0].ncrs).toHaveLength(2);
    expect(o.recurrence.faiRepeats).toHaveLength(2);
    expect(o.recurrence.faiRepeats[0]).toMatchObject({ fai_number: 'FAI-SYN-0001', evaluation: 'DOES_NOT_CONFORM' });
    expect(o.qualification.sites).toBeGreaterThan(0);
    expect(o.injectors.definitionsVersion).toBe('METRICS-INTERIM-1');
  });
});

describe('FR-103 / C10 — exports and issued management reports', () => {
  it('CSV exports need reports.export, are audited and carry period, time zone and definitions', async () => {
    expect((await inspector.get('/api/exports/inspections.csv')).status).toBe(403);
    const r = await quality.get(`/api/exports/inspections.csv?from=${today()}&to=${today()}`);
    expect(r.status).toBe(200);
    expect(String(r.headers['content-disposition'])).toContain(`inspections-${today()}-${today()}.csv`);
    const lines = r.raw.toString('utf8').trim().split('\r\n');
    expect(lines[0]).toContain(`period ${today()} to ${today()} (${TZ})`);
    expect(lines[0]).toContain('METRICS-INTERIM-1');
    expect(lines).toHaveLength(2 + 3);
    const ncrs = (await quality.get('/api/exports/ncrs.csv')).raw.toString('utf8').trim().split('\r\n');
    expect(ncrs).toHaveLength(2 + 2);
    expect(ncrs[2]).toContain('"Missing running-face coating"');
    for (const name of ['scars', 'commitments', 'supplier-quality']) expect((await quality.get(`/api/exports/${name}.csv`)).status).toBe(200);
    const audited = await h.pool.query(`SELECT action, outcome FROM audit_event WHERE action LIKE 'export.%' ORDER BY id`);
    expect(audited.rows.filter((a) => a.outcome === 'DENIED').map((a) => a.action)).toEqual(['export.inspections']);
    expect(audited.rows.filter((a) => a.outcome === 'SUCCESS')).toHaveLength(5);
  });

  it('issues an immutable management report edition with a PDF', async () => {
    expect((await inspector.send('POST', '/api/reports/issue', { from: daysAgo(30), to: today() })).status).toBe(403);
    const r = ok(await quality.send('POST', '/api/reports/issue', { from: daysAgo(30), to: today() }), 201);
    expect(r.number).toMatch(/^MR-\d{4}-\d{5}$/);
    await h.svc.worker!.drain();
    const issued = ok(await quality.get('/api/reports/issued'));
    expect(issued[0]).toMatchObject({ number: r.number, periodFrom: daysAgo(30), periodTo: today(), definitionsVersion: 'METRICS-INTERIM-1' });
    const fileId = issued[0].renditions[0].fileId;
    const pdf = await quality.get(`/api/files/${fileId}`);
    const out = path.join(OUT, 'management-report.pdf');
    writeFileSync(out, pdf.raw);
    const text = execFileSync('pdftotext', ['-layout', out, '-']).toString();
    expect(text).toContain('QUALITY MANAGEMENT REPORT');
    expect(text).toContain('Running Face Coating');
    expect(text).toContain('FAI-SYN-0001');
    expect(text).toContain('CALCULATION DEFINITIONS');
    await expect(h.pool.query(`UPDATE management_report SET period_to = period_from WHERE id = $1`, [r.id])).rejects.toThrow(/immutable/);
  });
});

describe('AT-20 / FR-010 — traceability for part + lot or serial', () => {
  it('requires a serial, or a part and a lot', async () => {
    expect((await inspector.get('/api/trace')).status).toBe(400);
    expect((await inspector.get(`/api/trace?partId=${ringPartId}`)).status).toBe(400);
  });

  it('part + lot returns the inspection, exact form/spec revision, FAI history, NCR and what applied on the date', async () => {
    const t = ok(await inspector.get(`/api/trace?partId=${ringPartId}&lot=lot-r2`));
    expect(t.inspections).toHaveLength(1);
    expect(t.inspections[0]).toMatchObject({ id: failA.id, form_number: 'PDI-IQI-004', outcome: 'FAIL', photos: 1, flagged_rows: 1 });
    expect(t.inspections[0].baseline_label).toMatch(/NWR catalog spec NR-3003/);
    expect(t.ncrs.map((n: { id: string }) => n.id)).toEqual([failA.ncrId]);
    expect(t.fai[0]).toMatchObject({ number: 'FAI-SYN-0001', decision: 'REJECTED', nonconforming: ['Running Face Coating (does_not_conform)'] });
    expect(t.appliedOn.baselines.map((b: { title: string }) => b.title)).toEqual(['NWR catalog spec NR-3003 (synthetic)']);
    expect(t.appliedOn.sources[0]).toMatchObject({ approvedAtDate: false, appliedAtDate: 'No source approval decision on or before this date' });
  });

  it('answers "what applied on this date" from the decision history, not today’s state', async () => {
    // Fixture: an approval decided 20 days ago that expired 5 days ago (fictional).
    await h.pool.query(
      `INSERT INTO source_approval_decision (number, source_id, decision, scope, valid_until, rationale, approver_id, decided_at, grants_used, gate_results, manifest, manifest_sha256)
       VALUES ('SA-SYN-0001', $1, 'APPROVED', 'Ring kit NR-3003 from site 1', $2::date, 'Synthetic approval for trace test', $3, now() - interval '20 days', '{source.approve}', '[]', '{}', 'synthetic')`,
      [h.ids.sources.ringNwr1, daysAgo(5), h.ids.users.manager],
    );
    const then = ok(await inspector.get(`/api/trace?partId=${ringPartId}&lot=LOT-R2&date=${daysAgo(10)}`));
    expect(then.appliedOn.sources[0]).toMatchObject({ approvedAtDate: true });
    expect(then.appliedOn.sources[0].appliedAtDate).toMatch(/^Approved under SA-SYN-0001/);
    const now = ok(await inspector.get(`/api/trace?partId=${ringPartId}&lot=LOT-R2`));
    expect(now.appliedOn.sources[0].appliedAtDate).toBe(`Approval SA-SYN-0001 had expired (${daysAgo(5)})`);
    const before = ok(await inspector.get(`/api/trace?partId=${ringPartId}&lot=LOT-R2&date=${daysAgo(25)}`));
    expect(before.appliedOn.sources[0].approvalAtDate).toBeNull();
  });

  it('a serial finds the inspection unit, the NCR material scope and injector bench history', async () => {
    const bySerial = ok(await inspector.get('/api/trace?serial=lot-r2-sn2'));
    expect(bySerial.inspections.map((i: { id: string }) => i.id)).toEqual([failA.id]);
    ok(await inspector.upload('/api/injectors/imports', benchCsv([{ serial: 'INJ-TRACE-77', testedAt: new Date(Date.now() - 3_600_000).toISOString(), rows: GOOD_ROWS }]), 'trace.csv', 'text/csv'), 201);
    const inj = ok(await inspector.get('/api/trace?serial=inj trace 77'));
    expect(inj.injectors).toHaveLength(1);
    expect(inj.injectors[0]).toMatchObject({ serial_number: 'INJ-TRACE-77', tests: 1, latest: { pdiEvaluation: 'PASS' } });
    expect(inj.parts.map((p: { part_number: string }) => p.part_number)).toEqual(['TQ-INJ-9009']);
    expect(inj.appliedOn.baselines[0].title).toMatch(/PDI injector test criteria/);
  });
});
