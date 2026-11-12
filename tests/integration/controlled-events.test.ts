import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IMPACT_AREAS } from '../../src/shared/quality.js';
import { makePdf } from '../fixtures/documents.js';
import { standInFiles } from '../fixtures/controlled-templates.js';
import { type Harness, type Session, formRevisionId, passAll, save, startHarness, version } from './harness.js';

/**
 * One approval path per event: each module event opens its controlled record in the same transaction,
 * the module's own decision signs the form's deciding block (never a second approval on the record),
 * and that decision completes the record and generates the controlled PDF on the bound revisions.
 */
let h: Harness;
let admin: Session;
let inspector: Session;
let quality: Session;
let engineering: Session;
let manager: Session;
let purchasing: Session;
let today: string;
let yesterday: string;
const OUT = path.resolve(import.meta.dirname, '../../var/report-samples');

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ok = (r: { status: number; json: unknown }, status = 200) => {
  expect(r.status, JSON.stringify(r.json)).toBe(status);
  return r.json as Json;
};
const plusDays = (n: number) => {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

beforeAll(async () => {
  h = await startHarness();
  [admin, inspector, quality, engineering, manager, purchasing] = await Promise.all([h.login('admin'), h.login('inspector'), h.login('quality'), h.login('engineering'), h.login('manager'), h.login('purchasing')]);
  mkdirSync(OUT, { recursive: true });
  today = (await h.pool.query(`SELECT (now() AT TIME ZONE $1)::date AS d`, [h.svc.config.displayTimeZone])).rows[0].d;
  yesterday = plusDays(-1);
  for (const f of await standInFiles(['INT-01', 'VAL-11', 'VAL-02', 'OPS-02', 'OPS-04', 'OPS-05', 'OPS-07'])) {
    const r = await admin.upload(`/api/documents/import?effectiveFrom=${yesterday}`, f.bytes, f.name, 'application/pdf');
    expect([200, 201], `${f.name}: ${JSON.stringify(r.json)}`).toContain(r.status);
  }
});
afterAll(async () => h?.close());

/** The event's own controlled record, as the module page lists it. */
async function eventRecord(entityType: string, entityId: string, code: string): Promise<Json> {
  const list = ok(await quality.get(`/api/controlled/records?entityType=${entityType}&entityId=${entityId}&typeCode=${code}`)) as unknown as Json[];
  const bound = list.filter((r) => r.eventBound && r.status !== 'VOID');
  expect(bound, `${code} for ${entityType}`).toHaveLength(1);
  return ok(await quality.get(`/api/controlled/records/${bound[0]!.id}`));
}

/** Completes every required entry the module does not already supply (and each module row's required columns). */
async function complete(s: Session, id: string, extra: (data: Json, rec: Json) => void = () => undefined): Promise<Json> {
  const rec = ok(await s.get(`/api/controlled/records/${id}`));
  const data = structuredClone(rec.data);
  for (const f of rec.schema.fields) {
    if (f.role !== 'ENTRY' || f.requirement !== 'REQUIRED' || data.fields[f.key]) continue;
    data.fields[f.key] = f.input === 'choice' ? f.options[0] : f.input === 'date' ? today : `NA - fictional entry for ${f.label}`.slice(0, f.maxLength ?? 60);
  }
  for (const sched of rec.schema.schedules) {
    // Every printed checklist row is answered.
    const rows = (data.schedules[sched.key] ??= []);
    while (rows.length < (sched.rowLabels?.length ?? 0)) rows.push({});
    for (const row of rows) {
      for (const c of sched.columns) if (c.requirement === 'REQUIRED' && !row[c.key]) row[c.key] = c.input === 'choice' ? c.options[0] : c.input === 'date' ? today : 'NA';
    }
  }
  extra(data, rec);
  ok(await s.send('PATCH', `/api/controlled/records/${id}`, { expectedVersion: rec.version, data }));
  const after = ok(await s.get(`/api/controlled/records/${id}`));
  expect(after.problems, `${after.number} complete`).toEqual([]);
  return after;
}

const submitRecord = async (s: Session, id: string) => ok(await s.send('POST', `/api/controlled/records/${id}/submit`, { expectedVersion: ok(await s.get(`/api/controlled/records/${id}`)).version }));

async function concur(s: Session, id: string, step = 'approver1') {
  ok(await s.send('POST', `/api/controlled/records/${id}/sign`, { expectedVersion: ok(await s.get(`/api/controlled/records/${id}`)).version, step, statement: 'Concur (fictional)' }));
}

/** The module's block cannot be signed on the record: it is signed by the module decision only. */
async function expectNoSecondApproval(s: Session, id: string, step: string) {
  const r = await s.send('POST', `/api/controlled/records/${id}/sign`, { expectedVersion: ok(await s.get(`/api/controlled/records/${id}`)).version, step, decision: 'Approve', conditions: 'second path' });
  expect(r.status, JSON.stringify(r.json)).toBe(409);
  expect(r.json.error.message).toMatch(/is signed when you .* it is not signed separately/);
}

/** Renders queued output and checks it against the bound templates. */
async function output(recordId: string, sample: string, expectText: string[]) {
  await h.svc.worker!.drain();
  const r = (await h.pool.query(`SELECT r.file_id, v.ok, v.result FROM report_rendition r JOIN controlled_output_validation v ON v.rendition_id = r.id WHERE r.subject_type = 'CONTROLLED_RECORD' AND r.subject_id = $1`, [recordId])).rows[0];
  expect(r, 'controlled output rendered').toBeTruthy();
  expect(r.ok).toBe(true);
  expect(r.result.checks.filter((c: { ok: boolean }) => !c.ok)).toEqual([]);
  const file = path.join(OUT, sample);
  writeFileSync(file, (await quality.get(`/api/files/${r.file_id}`)).raw);
  const text = execFileSync('pdftotext', ['-layout', file, '-']).toString().replace(/\s+/g, ' ');
  for (const t of expectText) expect(text, t).toContain(t);
  return text;
}

const signatures = (rec: Json) => rec.steps.map((s: Json) => `${s.key}:${s.signature?.mode}:${s.signature?.signer_name}:${s.signature?.decision ?? '-'}:${s.signature?.module_action ?? '-'}`);

describe('inspection: the review confirmation is the lot decision on OPS-02', () => {
  it('launch opens OPS-02; completion submits it; the review return and confirmation drive it; the worksheet PDF is demoted', async () => {
    const partId = (await h.pool.query(`SELECT id FROM company_part WHERE part_number = 'TQ-PRK-3003'`)).rows[0].id;
    const insp = ok(await inspector.send('POST', '/api/inspections', { partId, formRevisionId: await formRevisionId(inspector, 'PDI-IQI-004'), unitCount: 2, poNumber: 'PO-77001', dateReceived: today, sourceId: h.ids.sources.ringNwr1, lotNumber: 'LOT-IIR-1' }), 201);
    let rec = await eventRecord('INSPECTION', insp.id, 'OPS-02');
    expect(rec).toMatchObject({ status: 'DRAFT', preparedBy: 'Jordan Rivera', binding: { submitAction: { action: 'inspection.complete' }, decision: { action: 'inspection.review' } }, can: { submit: false } });
    await passAll(inspector, insp.id, 0, 'A');
    for (const u of [1, 2]) {
      await passAll(inspector, insp.id, u, 'B');
      ok(await save(inspector, insp.id, Object.entries({ free_end_gap_relaxed: '10.05', installed_end_gap: '0.52', axial_width_ring_height: '2.980', radial_wall_thickness: '4.20' }).map(([rowKey, a1]) => ({ unitIndex: u, sectionKey: 'C', rowKey, status: 'P', readings: { a1 } })), [{ unitIndex: u, serialNumber: `IIR-${u}` }]));
    }
    // The module's readings are the form's measurement rows (locked); the inspector adds the equipment used.
    rec = ok(await quality.get(`/api/controlled/records/${rec.id}`));
    expect(rec.data.fields).toMatchObject({ supplier_lot: 'LOT-IIR-1', purchase_order: 'PO-77001', sampled_qty: '2', inspector: 'Jordan Rivera' });
    expect(rec.data.schedules.measurements).toHaveLength(8);
    expect(rec.data.schedules.measurements[0]).toMatchObject({ sample_id: 'IIR-1', result: 'Pass' });
    expect(rec.locked).toEqual(expect.arrayContaining(['fields.supplier_lot', 'schedules.measurements.0.actual']));

    // Completing the inspection submits OPS-02, so it is refused while the form is incomplete.
    const early = await inspector.send('POST', `/api/inspections/${insp.id}/complete`, { expectedVersion: await version(inspector, insp.id) });
    expect(early.status).toBe(422);
    expect(early.json.error.message).toMatch(new RegExp(`${rec.number} \\(OPS-02\\) has \\d+ item\\(s\\) to complete`));
    await complete(inspector, rec.id, (data) => {
      for (const row of data.schedules.measurements) row.equipment_id = 'MIC-0042';
    });
    const done = ok(await inspector.send('POST', `/api/inspections/${insp.id}/complete`, { expectedVersion: await version(inspector, insp.id) }));
    // A passing lot still goes to the Receiving Quality approver: OPS-02 has one approval for every lot.
    expect(done).toMatchObject({ status: 'READY_FOR_REVIEW', outcome: 'PASS' });
    rec = ok(await quality.get(`/api/controlled/records/${rec.id}`));
    expect(rec.status).toBe('SUBMITTED');
    await expectNoSecondApproval(quality, rec.id, 'approver1');
    expect((await quality.send('POST', `/api/controlled/records/${rec.id}/return`, { expectedVersion: rec.version, reason: 'Wrong path (fictional)' })).status).toBe(409);

    // The review return sends OPS-02 back to draft with the inspection; the next completion resubmits it.
    ok(await quality.send('POST', `/api/inspections/${insp.id}/review`, { decision: 'RETURN', comment: 'Confirm the PO number (fictional)', expectedVersion: await version(quality, insp.id) }));
    rec = ok(await quality.get(`/api/controlled/records/${rec.id}`));
    expect(rec).toMatchObject({ status: 'DRAFT', cycle: 2 });
    expect(rec.data.schedules.measurements[0].equipment_id).toBe('MIC-0042');
    ok(await inspector.send('POST', `/api/inspections/${insp.id}/complete`, { expectedVersion: await version(inspector, insp.id) }));
    ok(await quality.send('POST', `/api/inspections/${insp.id}/review`, { decision: 'CONFIRM', comment: 'Lot accepted (fictional)', expectedVersion: await version(quality, insp.id) }));
    rec = ok(await quality.get(`/api/controlled/records/${rec.id}`));
    expect(rec.status).toBe('COMPLETED');
    expect(signatures(rec)).toEqual(['approver1:INTERNAL:Casey Morgan:Accept lot:inspection.review']);
    await output(rec.id, 'event-ops-02.pdf', [rec.number, 'Accept lot', 'Casey Morgan', 'LOT-IIR-1', 'MIC-0042', 'OPS-02 | Rev 0.3 | Effective: pending']);
    // The inspection's own PDF is issued as the supporting worksheet, naming the controlled record.
    const snap = (await h.pool.query(`SELECT snapshot FROM report_snapshot WHERE subject_type = 'INSPECTION' AND subject_id = $1 ORDER BY edition DESC LIMIT 1`, [insp.id])).rows[0].snapshot;
    expect(snap.notice).toMatch(new RegExp(`INSPECTION WORKSHEET - NOT THE CONTROLLED RECORD.*${rec.number}`));
  });
});

describe('concession: Engineering concurs on OPS-05, then the concession decision approves it', () => {
  it('the decision needs the submitted form and the concurrence; it signs the approval block and voids nothing else', async () => {
    const partId = (await h.pool.query(`SELECT id FROM company_part WHERE part_number = 'TQ-PRK-3003'`)).rows[0].id;
    const body = (lot: string) => ({ partId, lotNumber: lot, quantityLimit: 4, characteristic: 'Radial wall thickness', permittedException: '4.32 mm accepted for this lot (fictional)', conditions: 'Rebuild kits only', justification: 'Engineering assessed negligible effect (fictional)', validFrom: today, validUntil: plusDays(30) });
    const c = ok(await inspector.send('POST', '/api/concessions', body('LOT-DEV-1')), 201);
    expect(c.controlled.number).toMatch(/^OPS-05-/);
    let rec = await eventRecord('CONCESSION', c.id, 'OPS-05');
    expect(rec.data.schedules.limited_lots).toEqual([expect.objectContaining({ lot: 'LOT-DEV-1', requested: '4', authorized: '4' })]);
    const decide = (s: Session, v: number) => s.send('POST', `/api/concessions/${c.id}/decide`, { decision: 'APPROVED', rationale: 'Within engineering limits (fictional)', expectedVersion: v });
    let v = ok(await manager.get(`/api/concessions/${c.id}`)).concession.version;
    expect((await decide(manager, v)).status).toBe(422);

    await complete(inspector, rec.id, (data) => {
      data.schedules.limited_lots[0].location = 'Receiving cage Q-1';
    });
    await submitRecord(inspector, rec.id);
    const blocked = await decide(manager, v);
    expect(blocked.status).toBe(409);
    expect(blocked.json.error.message).toMatch(/Engineering approver must sign OPS-05-.* before you decide concession/);
    // The readiness the concession page shows.
    const ready = ok(await manager.get(`/api/controlled/events/CONCESSION/${c.id}`));
    expect(ready[0]).toMatchObject({ code: 'OPS-05', readiness: { ready: false, reason: expect.stringMatching(/Engineering approver signs/) } });

    await concur(engineering, rec.id, 'approver1');
    await expectNoSecondApproval(manager, rec.id, 'approver2');
    v = ok(await manager.get(`/api/concessions/${c.id}`)).concession.version;
    ok(await decide(manager, v));
    expect(ok(await manager.get(`/api/concessions/${c.id}`)).concession.status).toBe('APPROVED');
    rec = ok(await quality.get(`/api/controlled/records/${rec.id}`));
    expect(rec.status).toBe('COMPLETED');
    expect(signatures(rec)).toEqual(['approver1:INTERNAL:Taylor Brooks:-:-', 'approver2:INTERNAL:Riley Chen:Conditional:concession.decide']);
    expect(rec.composed.fields).toMatchObject({ pdi_decision: 'Conditional', approved_quantity: '4', approval_expiry: plusDays(30), effective_lot: 'LOT-DEV-1' });
    await output(rec.id, 'event-ops-05.pdf', ['Conditional', 'Taylor Brooks', 'Riley Chen', 'LOT-DEV-1', 'Receiving cage Q-1']);
    // No summary edition for a concession that has its controlled record.
    expect((await manager.send('POST', `/api/concessions/${c.id}/report`)).status).toBe(409);

    // A withdrawn request voids its open form; a voided form never takes an approval.
    const w = ok(await inspector.send('POST', '/api/concessions', body('LOT-DEV-2')), 201);
    ok(await inspector.send('POST', `/api/concessions/${w.id}/withdraw`, { reason: 'Lot returned instead (fictional)' }));
    const list = ok(await quality.get(`/api/controlled/records?entityType=CONCESSION&entityId=${w.id}`)) as unknown as Json[];
    expect(list.map((r) => r.status)).toEqual(['VOID']);
  });
});

describe('change: OPS-04 is decided by the change decision', () => {
  it('Engineering concurs, an independent approver decides; the decider cannot be the concurring engineer', async () => {
    const partId = (await h.pool.query(`SELECT id FROM company_part WHERE part_number = 'TQ-PRK-3003'`)).rows[0].id;
    const ownerId = h.ids.users.purchasing;
    const make = async (title: string) =>
      ok(await purchasing.send('POST', '/api/changes', { origin: 'PDI', title, description: 'Tighten radial wall tolerance (fictional)', justification: 'Field wear data (fictional)', categories: ['DIMENSION'], partId, sourceIds: [], ownerId }), 201);
    const chg = await make('Radial wall tolerance (event test)');
    let rec = await eventRecord('CHANGE', chg.id, 'OPS-04');
    expect(rec.data.fields).toMatchObject({ project_ref: chg.number, pdi_part: 'TQ-PRK-3003' });
    const impact = { expectedVersion: ok(await purchasing.get(`/api/changes/${chg.id}`)).change.version, summary: 'Specification only; no requalification (fictional)', requalificationRequired: false, items: IMPACT_AREAS.map((area) => ({ area, affected: false, assessment: 'Not affected (fictional)' })) };
    ok(await purchasing.send('PUT', `/api/changes/${chg.id}/impact`, impact));
    await complete(purchasing, rec.id);
    await submitRecord(purchasing, rec.id);
    await concur(engineering, rec.id, 'approver1');
    const v = ok(await manager.get(`/api/changes/${chg.id}`)).change.version;
    // Taylor Brooks already signed OPS-04: deciding too would be a second signature by the same person.
    const self = await engineering.send('POST', `/api/changes/${chg.id}/decide`, { expectedVersion: v, decision: 'APPROVED', rationale: 'Approve (fictional)' });
    expect(self.status).toBe(403);
    ok(await manager.send('POST', `/api/changes/${chg.id}/decide`, { expectedVersion: v, decision: 'APPROVED', rationale: 'Approved with field data (fictional)' }));
    rec = ok(await quality.get(`/api/controlled/records/${rec.id}`));
    expect(signatures(rec)).toEqual(['approver1:INTERNAL:Taylor Brooks:-:-', 'approver2:INTERNAL:Riley Chen:Approve:change.decide']);
    await output(rec.id, 'event-ops-04.pdf', ['Approve', 'Riley Chen', 'Taylor Brooks', chg.number]);

    // A cancelled change voids its open form.
    const other = await make('Abandoned change (event test)');
    ok(await purchasing.send('POST', `/api/changes/${other.id}/cancel`, { reason: 'Superseded by the field study (fictional)' }));
    const list = ok(await quality.get(`/api/controlled/records?entityType=CHANGE&entityId=${other.id}`)) as unknown as Json[];
    expect(list.map((r) => r.status)).toEqual(['VOID']);
  });
});

describe('first article: VAL-02 is approved by the first-article decision', () => {
  it('registering the sample opens VAL-02 with its measurements; the decision signs Supplier Quality after Engineering', async () => {
    const fai = ok(await purchasing.send('POST', `/api/sources/${h.ids.sources.ringNwr1}/fai`, { sampleType: 'PRODUCTION_REPRESENTATIVE', receivedDate: yesterday, serialNumbers: 'FA-01', lotNumber: 'LOT-FAI-1' }), 201);
    expect(fai.controlled.number).toMatch(/^VAL-02-/);
    ok(await purchasing.send('PUT', `/api/fai/${fai.id}/results`, { results: [{ charKey: 'free_end_gap', value: '10.10' }, { charKey: 'installed_end_gap', value: '0.50' }, { charKey: 'axial_width', value: '2.981' }, { charKey: 'radial_wall', value: '4.22' }] }));
    let rec = await eventRecord('FAI', fai.id, 'VAL-02');
    expect(rec.entity.route).toBe(`/sources/${h.ids.sources.ringNwr1}`);
    expect(rec.data.fields).toMatchObject({ lot: 'LOT-FAI-1', plan_ref: fai.number, evaluated_characteristics: '4', failed_characteristics: '0' });
    expect(rec.data.schedules.measurements.map((m: Json) => m.actual)).toEqual(['2.981', '10.10', '0.50', '4.22']);
    await complete(purchasing, rec.id);
    await submitRecord(purchasing, rec.id);
    await concur(engineering, rec.id, 'approver1');
    const f = ok(await quality.get(`/api/sources/${h.ids.sources.ringNwr1}`)).fais.find((x: Json) => x.id === fai.id);
    ok(await quality.send('POST', `/api/fai/${fai.id}/decide`, { expectedVersion: f.version, decision: 'ACCEPTED', rationale: 'All characteristics within limits (fictional)' }));
    rec = ok(await quality.get(`/api/controlled/records/${rec.id}`));
    expect(signatures(rec)).toEqual(['approver1:INTERNAL:Taylor Brooks:-:-', 'approver2:INTERNAL:Casey Morgan:Approve:fai.decide']);
    await output(rec.id, 'event-val-02.pdf', ['Approve', 'Casey Morgan', 'Taylor Brooks', 'LOT-FAI-1', '10.10']);
  });
});

describe('source approval: VAL-11 replaces the summary approval record', () => {
  it('requesting approval opens VAL-11; the source decision signs it and no summary PDF is issued', async () => {
    const sourceId = h.ids.sources.ringNwr2!;
    const req = ok(await purchasing.send('POST', `/api/sources/${sourceId}/request-approval`, {}));
    expect(req.controlled.number).toMatch(/^VAL-11-/);
    let rec = await eventRecord('SOURCE', sourceId, 'VAL-11');
    expect(rec.data.fields).toMatchObject({ supplier_id: 'NWR', sourcing_path: 'B' });
    await complete(purchasing, rec.id);
    await submitRecord(purchasing, rec.id);
    await concur(engineering, rec.id, 'approver1');
    const decision = ok(await manager.send('POST', `/api/sources/${sourceId}/decision`, { decision: 'REJECTED', scope: 'Ring kits from P2 only', rationale: 'First article evidence not yet available (fictional)' }), 201);
    expect(decision.controlled.number).toBe(rec.number);
    rec = ok(await quality.get(`/api/controlled/records/${rec.id}`));
    expect(signatures(rec)).toEqual(['approver1:INTERNAL:Taylor Brooks:-:-', 'approver2:INTERNAL:Riley Chen:Reject:source.decide']);
    await output(rec.id, 'event-val-11.pdf', ['Reject', 'Riley Chen', decision.number]);
    expect((await h.pool.query(`SELECT count(*)::int AS n FROM report_snapshot WHERE subject_type = 'SOURCE_APPROVAL' AND subject_id = $1`, [decision.id])).rows[0].n).toBe(0);
  });
});

describe('corrective action: closing the SCAR approves its OPS-07', () => {
  it('the supplier response and PDI verifications fill the form; the closure signs it', async () => {
    const nwr = (await h.pool.query(`SELECT id FROM supplier WHERE code = 'NWR'`)).rows[0].id;
    const partId = (await h.pool.query(`SELECT id FROM company_part WHERE part_number = 'TQ-PRK-3003'`)).rows[0].id;
    const scar = ok(
      await purchasing.send('POST', '/api/scars', { supplierId: nwr, partId, title: 'Missing coating (event test)', problemStatement: 'Ring kits received without running-face coating (fictional).', sentTo: 'Quality manager, Northwind (fictional)', sentVia: 'EMAIL', responseDue: plusDays(14), ownerId: h.ids.users.purchasing }),
      201,
    );
    expect(scar.controlled.number).toMatch(/^OPS-07-/);
    ok(await purchasing.send('POST', `/api/scars/${scar.id}/responses`, { receivedAt: today, channel: 'EMAIL', representative: 'R. Okoye (fictional)', containment: 'Stock at supplier purged and recoated (fictional)', rootCause: 'Masking fixture skipped on line 2 (fictional)', correctiveAction: 'Fixture interlock added to the router (fictional)' }), 201);
    ok(await purchasing.upload(`/api/evidence/SCAR/${scar.id}`, await makePdf('Router revision with interlock (fictional)'), 'router.pdf', 'application/pdf'), 201);
    ok(await quality.send('POST', `/api/scars/${scar.id}/verifications`, { kind: 'IMPLEMENTATION', result: 'VERIFIED', method: 'Document review', evidence: 'Router revision reviewed (fictional)' }), 201);
    ok(await purchasing.send('PUT', `/api/scars/${scar.id}/plan`, { effectivenessPlan: 'Inspect the next three lots for coating on every item (fictional)' }));
    ok(await manager.send('POST', `/api/scars/${scar.id}/verifications`, { kind: 'EFFECTIVENESS', result: 'VERIFIED', method: 'Supplier audit', evidence: 'Interlock observed working (fictional)', alternativeMethod: true, populationNote: 'Audit of line 2 (fictional)' }), 201);
    let rec = await eventRecord('SCAR', scar.id, 'OPS-07');
    expect(rec.data.fields).toMatchObject({ containment: 'Stock at supplier purged and recoated (fictional)', actual_effectiveness: 'Supplier audit: Interlock observed working (fictional)' });
    expect(rec.data.schedules.verified_causes[0]).toMatchObject({ cause: 'Masking fixture skipped on line 2 (fictional)' });
    expect(rec.data.schedules.actions[0]).toMatchObject({ action_id: 'CA-1', status: 'Verified', verified_by: expect.stringMatching(/^Riley Chen/) });
    await complete(purchasing, rec.id);
    await submitRecord(purchasing, rec.id);
    await expectNoSecondApproval(manager, rec.id, 'approver1');
    ok(await manager.send('POST', `/api/scars/${scar.id}/close`, { note: 'Effectiveness verified (fictional)' }));
    rec = ok(await quality.get(`/api/controlled/records/${rec.id}`));
    expect(signatures(rec)).toEqual(['approver1:INTERNAL:Riley Chen:Close:scar.close']);
    await output(rec.id, 'event-ops-07.pdf', ['Close', 'Riley Chen', 'Masking fixture skipped on line 2']);
    expect((await purchasing.send('POST', `/api/scars/${scar.id}/report`)).status).toBe(409);
  });
});

describe('sourcing: the INT-01 intake decision drives the sourcing request', () => {
  it('a rejected Product Sourcing Request cancels its sourcing request', async () => {
    const partId = (await h.pool.query(`SELECT id FROM company_part WHERE part_number = 'TQ-PRK-3003'`)).rows[0].id;
    const sr = ok(await purchasing.send('POST', '/api/sourcing', { title: 'Third source for ring kits (event test)', pathway: 'B', partId }), 201);
    expect(sr.controlled.number).toMatch(/^INT-01-/);
    let rec = await eventRecord('SOURCING_REQUEST', sr.id, 'INT-01');
    expect(rec.data.fields).toMatchObject({ project_ref: sr.number, candidate_path: 'B' });
    await complete(purchasing, rec.id);
    await submitRecord(purchasing, rec.id);
    ok(await engineering.send('POST', `/api/controlled/records/${rec.id}/sign`, { expectedVersion: ok(await engineering.get(`/api/controlled/records/${rec.id}`)).version, step: 'approver1', decision: 'Reject', conditions: 'No business case for a third source (fictional)' }));
    await concur(quality, rec.id, 'approver2');
    rec = ok(await quality.get(`/api/controlled/records/${rec.id}`));
    expect(rec.status).toBe('COMPLETED');
    expect(ok(await purchasing.get(`/api/sourcing/${sr.id}`)).request.status).toBe('CANCELLED');
    await output(rec.id, 'event-int-01.pdf', ['Reject', 'Taylor Brooks', 'Casey Morgan', sr.number]);
  });
});
