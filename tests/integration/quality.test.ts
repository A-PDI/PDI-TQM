import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dayIn } from '../../src/shared/quality.js';
import { runCommitmentReminders } from '../../src/server/quality/commitments.js';
import { makePdf } from '../fixtures/documents.js';
import { makePng } from '../fixtures/images.js';
import { type Harness, type Session, formRevisionId, passAll, save, startHarness, version } from './harness.js';

/** Stage 3: NCR scope/containment/disposition, concessions, SCAR, commitments, change control and form revisions. */
let h: Harness;
let inspector: Session;
let inspector2: Session;
let quality: Session;
let engineering: Session;
let manager: Session;
let purchasing: Session;
const OUT = path.resolve(import.meta.dirname, '../../var/report-samples');
const TZ = 'America/Chicago';
const today = () => dayIn(TZ);
const plusDays = (n: number) => dayIn(TZ, new Date(Date.now() + n * 86_400_000));

beforeAll(async () => {
  h = await startHarness();
  [inspector, inspector2, quality, engineering, manager, purchasing] = await Promise.all([
    h.login('inspector'),
    h.login('inspector2'),
    h.login('quality'),
    h.login('engineering'),
    h.login('manager'),
    h.login('purchasing'),
  ]);
  mkdirSync(OUT, { recursive: true });
  ringPartId = (await h.pool.query(`SELECT id FROM company_part WHERE part_number = 'TQ-PRK-3003'`)).rows[0].id;
});
afterAll(async () => h?.close());

const ok = (r: { status: number; json: unknown }, status = 200) => {
  expect(r.status, JSON.stringify(r.json)).toBe(status);
  return r.json as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const gateMap = (gates: Array<{ code: string; status: string }>) => Object.fromEntries(gates.map((g) => [g.code, g.status]));

const RING = { free_end_gap_relaxed: '10.05', installed_end_gap: '0.52', axial_width_ring_height: '2.980', radial_wall_thickness: '4.20' };
let ringPartId: string;

/** A completed ring-kit inspection; `failCoating` units record an uncoated running face with a photo. */
async function ringInspection(
  s: Session,
  opts: { lot: string; units: number; serials?: string[]; failCoating?: number[]; sourceId?: string | null; dateReceived?: string },
): Promise<{ id: string; number: string; status: string }> {
  const created = ok(
    await s.send('POST', '/api/inspections', {
      partId: ringPartId,
      formRevisionId: await formRevisionId(s, 'PDI-IQI-004'),
      unitCount: opts.units,
      poNumber: 'PO-77310',
      dateReceived: opts.dateReceived ?? today(),
      sourceId: opts.sourceId === undefined ? h.ids.sources.ringNwr1 : opts.sourceId,
      lotNumber: opts.lot,
    }),
    201,
  );
  const id = created.id as string;
  await passAll(s, id, 0, 'A');
  for (let u = 1; u <= opts.units; u += 1) {
    await passAll(s, id, u, 'B');
    ok(
      await save(
        s,
        id,
        Object.entries(RING).map(([rowKey, v]) => ({ unitIndex: u, sectionKey: 'C', rowKey, status: 'P', readings: { a1: v } })),
        [{ unitIndex: u, serialNumber: opts.serials?.[u - 1] ?? `${opts.lot}-${u}` }],
      ),
    );
  }
  for (const u of opts.failCoating ?? []) {
    ok(await save(s, id, [{ unitIndex: u, sectionKey: 'B', rowKey: 'running_face_coating', status: 'F', note: 'Running face uncoated; base metal visible' }]));
    ok(await s.upload(`/api/inspections/${id}/photos?unitIndex=${u}&sectionKey=B&rowKey=running_face_coating`, makePng(90, 60, [140, 40, 40]), `coating-${u}.png`, 'image/png'), 201);
  }
  const done = ok(await s.send('POST', `/api/inspections/${id}/complete`, { expectedVersion: await version(s, id) }));
  return { id, number: (await s.get(`/api/inspections/${id}`)).json.number, status: done.status };
}

async function confirmReview(id: string) {
  ok(await quality.send('POST', `/api/inspections/${id}/review`, { decision: 'CONFIRM', expectedVersion: await version(quality, id), comment: 'Failure confirmed (fictional)' }));
}

async function pdfText(subjectType: string, subjectId: string, sample: string) {
  await h.svc.worker!.drain();
  const r = (await h.pool.query(`SELECT file_id FROM report_rendition WHERE subject_type = $1 AND subject_id = $2 ORDER BY edition DESC LIMIT 1`, [subjectType, subjectId])).rows[0];
  expect(r, `${subjectType} rendition`).toBeTruthy();
  const file = await inspector.get(`/api/files/${r.file_id}`);
  expect(file.status).toBe(200);
  const out = path.join(OUT, sample);
  writeFileSync(out, file.raw);
  const snap = (await h.pool.query(`SELECT snapshot FROM report_snapshot WHERE subject_type = $1 AND subject_id = $2 ORDER BY edition DESC LIMIT 1`, [subjectType, subjectId])).rows[0];
  if (snap) writeFileSync(out.replace(/\.pdf$/, '.snapshot.json'), JSON.stringify(snap.snapshot, null, 2));
  return execFileSync('pdftotext', ['-layout', out, '-']).toString();
}

describe('AT-06 / NEG-01 / NEG-06 / NEG-08 / AT-14 / AT-15 — concern to NCR, disposition, SCAR', () => {
  let inspectionId: string;
  let eventId: string;
  let ncrId: string;
  let scopeId: string;
  let concessionId: string;
  let scarId: string;
  const decisions: Record<string, string> = {};

  it('a quick piston-ring concern from the failed row becomes an NCR with the same evidence (AT-06)', async () => {
    const insp = await ringInspection(inspector, { lot: 'LOT-Q1', units: 3, serials: ['SN-1001', 'SN-2002', 'SN-3003'], failCoating: [2] });
    inspectionId = insp.id;
    expect(insp.status).toBe('READY_FOR_REVIEW');
    eventId = ok(await inspector.send('POST', `/api/inspections/${inspectionId}/concerns`, { unitIndex: 2, sectionKey: 'B', rowKey: 'running_face_coating', ownerId: h.ids.users.engineering }), 201).id;
    ok(await quality.send('POST', `/api/quality/events/${eventId}/triage`, { expectedVersion: 1, decision: 'TRIAGED', ownerId: h.ids.users.engineering, severity: 'HIGH' }));

    // The reporter (and anyone without authority) cannot confirm the nonconformance.
    expect((await inspector.send('POST', `/api/quality/events/${eventId}/confirm-ncr`, { expectedVersion: 2, severity: 'HIGH', ownerId: h.ids.users.quality, rationale: 'Reporter confirming own concern' })).status).toBe(403);
    const ncr = ok(
      await quality.send('POST', `/api/quality/events/${eventId}/confirm-ncr`, {
        expectedVersion: 2,
        severity: 'HIGH',
        ownerId: h.ids.users.quality,
        failureMode: 'Missing running-face coating',
        rationale: 'Coating absent on item 2; supplier process escape suspected',
      }),
      201,
    );
    ncrId = ncr.id;
    expect(ncr.number).toMatch(/^NCR-\d{4}-\d{5}$/);
    const d = ok(await quality.get(`/api/ncrs/${ncrId}`));
    expect(d.ncr).toMatchObject({ lot_number: 'LOT-Q1', po_number: 'PO-77310', characteristic: 'Running Face Coating', status: 'OPEN', serial_number: 'SN-2002' });
    expect(d.ncr.actual).toContain('base metal visible');
    const eventFiles = ok(await quality.get(`/api/quality/events/${eventId}`)).photos.map((p: { fileId: string }) => p.fileId);
    expect(d.files.map((f: { fileId: string }) => f.fileId)).toEqual(eventFiles); // same stored file, no copy
    expect(ok(await quality.get(`/api/quality/events/${eventId}`)).event.status).toBe('CONFIRMED_NCR');
    await confirmReview(inspectionId);
  });

  it('records affected material, then containment authorization and physical segregation', async () => {
    scopeId = ok(
      await quality.send('POST', `/api/ncrs/${ncrId}/scopes`, {
        label: 'Ring kits on receiving shelf R-4',
        lotNumber: 'LOT-Q1',
        poNumber: 'PO-77310',
        inspectionId,
        quantity: 3,
        serialNumbers: ['SN-1001', 'SN-2002', 'SN-3003'],
        location: 'Receiving shelf R-4',
        containmentAction: 'Tag red and move to quarantine cage Q-2',
      }),
      201,
    ).id;
    // Disposition before verified segregation is refused.
    expect((await manager.send('POST', `/api/scopes/${scopeId}/dispositions`, { outcome: 'SCRAP', quantity: 1, rationale: 'Too early' })).status).toBe(409);
    expect((await inspector.send('POST', `/api/scopes/${scopeId}/authorize-containment`, {})).status).toBe(403);
    ok(await manager.send('POST', `/api/scopes/${scopeId}/authorize-containment`, { note: 'Hold all three' }));
    ok(await inspector2.send('POST', `/api/scopes/${scopeId}/verify-segregation`, { note: 'Three kits tagged and caged in Q-2' }));
    expect(ok(await quality.get(`/api/ncrs/${ncrId}`)).ncr.status).toBe('CONTAINED');
  });

  it('NEG-01: an inspector calling the disposition API directly is denied and the attempt is audited', async () => {
    const r = await inspector.send('POST', `/api/scopes/${scopeId}/dispositions`, { outcome: 'USE_AS_IS', quantity: 3, rationale: 'Looks fine to me' });
    expect(r.status).toBe(403);
    const denied = await h.pool.query(`SELECT 1 FROM audit_event WHERE action = 'ncr.disposition' AND outcome = 'DENIED' AND actor_id = $1`, [h.ids.users.inspector]);
    expect(denied.rowCount).toBe(1);
    expect((await h.pool.query('SELECT count(*)::int AS n FROM disposition_decision')).rows[0].n).toBe(0);
  });

  it('NEG-06 / AT-14 / AT-19: use as is needs a current concession for this exact lot, approved by someone else', async () => {
    const noConcession = await manager.send('POST', `/api/scopes/${scopeId}/dispositions`, { outcome: 'USE_AS_IS', quantity: 1, rationale: 'Cosmetic only' });
    expect(noConcession.status).toBe(422);
    expect(noConcession.json.error.message).toMatch(/concession/);

    const request = {
      partId: ringPartId,
      ncrId,
      lotNumber: 'LOT-Q1',
      quantityLimit: 1,
      characteristic: 'Running Face Coating',
      permittedException: 'Item SN-1001 coating thin at gap ends; within functional allowance per Engineering (fictional)',
      conditions: 'Install in rebuild kits only; record serial on build sheet',
      justification: 'Engineering assessed functional effect as negligible for this single item (fictional)',
      validFrom: today(),
      validUntil: plusDays(30),
    };
    concessionId = ok(await inspector.send('POST', '/api/concessions', request), 201).id;
    expect((await inspector.send('POST', `/api/concessions/${concessionId}/decide`, { expectedVersion: 1, decision: 'APPROVED', rationale: 'Self approval attempt' })).status).toBe(403);
    // A manager cannot grant a concession they requested themselves.
    const own = ok(await manager.send('POST', '/api/concessions', { ...request, characteristic: 'Gap end faces' }), 201);
    const self = await manager.send('POST', `/api/concessions/${own.id}/decide`, { expectedVersion: 1, decision: 'APPROVED', rationale: 'self approval' });
    expect(self.status).toBe(403);
    expect(self.json.error.message).toMatch(/other than the requester/);
    ok(await manager.send('POST', `/api/concessions/${concessionId}/decide`, { expectedVersion: 1, decision: 'APPROVED', rationale: 'Single item, bounded conditions' }));
    // Overlapping concession for the same lot and characteristic is refused.
    const dup = ok(await inspector.send('POST', '/api/concessions', request), 201);
    expect((await manager.send('POST', `/api/concessions/${dup.id}/decide`, { expectedVersion: 1, decision: 'APPROVED', rationale: 'duplicate' })).status).toBe(409);

    // An expired concession and one for another lot authorize nothing (later date / other shipment).
    const expired = (
      await h.pool.query(
        `INSERT INTO concession (number, part_id, source_id, lot_number, quantity_limit, characteristic, permitted_exception, justification, valid_from, valid_until,
           requested_by, status, decided_by, decided_at, decision_rationale)
         VALUES ('DEV-TEST-EXPIRED', $1, $2, 'LOT-Q1', 5, 'Ring body', 'Old allowance', 'Historic (fictional)', '2026-01-01', '2026-01-31', $3, 'APPROVED', $4, now(), 'Historic')
         RETURNING id`,
        [ringPartId, h.ids.sources.ringNwr1, h.ids.users.quality, h.ids.users.manager],
      )
    ).rows[0].id;
    const late = await manager.send('POST', `/api/scopes/${scopeId}/dispositions`, { outcome: 'USE_AS_IS', quantity: 1, concessionId: expired, rationale: 'Use old allowance' });
    expect(late.status).toBe(422);
    expect(late.json.error.message).toMatch(/expired/i);
    const otherLot = ok(await inspector.send('POST', '/api/concessions', { ...request, ncrId: null, lotNumber: 'LOT-Q9', characteristic: 'Ring body' }), 201);
    ok(await manager.send('POST', `/api/concessions/${otherLot.id}/decide`, { expectedVersion: 1, decision: 'APPROVED', rationale: 'For lot Q9 only' }));
    const wrongLot = await manager.send('POST', `/api/scopes/${scopeId}/dispositions`, { outcome: 'USE_AS_IS', quantity: 1, concessionId: otherLot.id, rationale: 'Borrow Q9 allowance' });
    expect(wrongLot.status).toBe(422);
    expect(wrongLot.json.error.message).toMatch(/covers lot LOT-Q9 only/);

    // AT-12: the open HIGH NCR blocks source approval and a current concession limits it to conditional;
    // an expired concession relied on by an open NCR blocks it explicitly.
    let gates = gateMap(ok(await purchasing.get(`/api/sources/${h.ids.sources.ringNwr1}`)).gates);
    expect(gates).toMatchObject({ NO_BLOCKING_QUALITY: 'FAIL', CONCESSIONS_CURRENT: 'WARN' });
    await h.pool.query(
      `INSERT INTO concession (number, part_id, source_id, ncr_id, lot_number, quantity_limit, characteristic, permitted_exception, justification, valid_from, valid_until,
         requested_by, status, decided_by, decided_at, decision_rationale)
       VALUES ('DEV-TEST-LAPSED', $1, $2, $3, 'LOT-Q1', 1, 'Ring gap ends', 'Lapsed allowance', 'Historic (fictional)', '2026-02-01', '2026-02-28', $4, 'APPROVED', $5, now(), 'Historic')`,
      [ringPartId, h.ids.sources.ringNwr1, ncrId, h.ids.users.quality, h.ids.users.manager],
    );
    const src = ok(await purchasing.get(`/api/sources/${h.ids.sources.ringNwr1}`));
    gates = gateMap(src.gates);
    expect(gates.CONCESSIONS_CURRENT).toBe('FAIL');
    expect(src.gates.find((g: { code: string }) => g.code === 'CONCESSIONS_CURRENT').detail).toMatch(/DEV-TEST-LAPSED expired 2026-02-28/);
  });

  it('disposition by quantity; no blanket lot decision; exact allocation enforced', async () => {
    decisions.useAsIs = ok(
      await manager.send('POST', `/api/scopes/${scopeId}/dispositions`, { outcome: 'USE_AS_IS', quantity: 1, serialNumbers: ['SN-1001'], concessionId, rationale: 'Under DEV, rebuild kits only' }),
      201,
    ).id;
    decisions.rework = ok(
      await manager.send('POST', `/api/scopes/${scopeId}/dispositions`, { outcome: 'REWORK', quantity: 1, serialNumbers: ['SN-2002'], instructions: 'Recoat running face', rationale: 'Coating can be reapplied' }),
      201,
    ).id;
    // Exhausted concession; and the remaining quantity is only one.
    expect((await manager.send('POST', `/api/scopes/${scopeId}/dispositions`, { outcome: 'USE_AS_IS', quantity: 1, concessionId, rationale: 'again' })).status).toBe(422);
    expect((await manager.send('POST', `/api/scopes/${scopeId}/dispositions`, { outcome: 'SCRAP', quantity: 2, rationale: 'Scrap the rest' })).status).toBe(422);
    decisions.ret = ok(await manager.send('POST', `/api/scopes/${scopeId}/dispositions`, { outcome: 'RETURN_TO_SUPPLIER', quantity: 1, serialNumbers: ['SN-3003'], rationale: 'Supplier to replace' }), 201).id;
    await expect(h.pool.query(`INSERT INTO disposition_decision (scope_id, outcome, quantity, rationale, decided_by, grants_used) VALUES ($1, 'SCRAP', 1, 'x', $2, '{}')`, [scopeId, h.ids.users.manager])).rejects.toThrow(/exceed/);
    await expect(h.pool.query(`UPDATE disposition_decision SET quantity = 2 WHERE id = $1`, [decisions.rework])).rejects.toThrow(/immutable/);
    const d = ok(await quality.get(`/api/ncrs/${ncrId}`));
    expect(d.ncr.status).toBe('DISPOSITIONED');
    // The NCR cannot close before every disposition is verified.
    expect((await quality.send('POST', `/api/ncrs/${ncrId}/close`, { note: 'Closing now', expectedVersion: d.ncr.version })).status).toBe(422);
  });

  it('NEG-08: a passing replacement lot does not verify rework of the affected lot; the same-lot reinspection does', async () => {
    const replacement = await ringInspection(inspector, { lot: 'LOT-REPL', units: 1, serials: ['SN-2002'] });
    expect(replacement.status).toBe('COMPLETED');
    const mismatch = await quality.send('POST', `/api/dispositions/${decisions.rework}/verify`, { result: 'VERIFIED', method: 'Reinspection', note: 'Replacement passes', inspectionId: replacement.id });
    expect(mismatch.status).toBe(422);
    expect(mismatch.json.error.message).toMatch(/Evidence mismatch.*LOT-REPL/);
    expect((await h.pool.query(`SELECT 1 FROM audit_event WHERE action = 'ncr.disposition_verify' AND outcome = 'FAILED'`)).rowCount).toBe(1);
    expect(ok(await quality.get(`/api/ncrs/${ncrId}`)).scopes[0].state).toBe('DECIDED'); // hold retained

    // Supplier statement without PDI evidence is not verification either.
    expect((await quality.send('POST', `/api/dispositions/${decisions.rework}/verify`, { result: 'VERIFIED', method: 'Supplier statement', note: 'Supplier says recoated' })).status).toBe(422);

    const reinspection = await ringInspection(inspector, { lot: 'LOT-Q1', units: 1, serials: ['SN-2002'] });
    ok(await quality.send('POST', `/api/dispositions/${decisions.rework}/verify`, { result: 'VERIFIED', method: 'PDI reinspection', note: 'Coating present and conforming', inspectionId: reinspection.id }), 201);
    ok(await quality.send('POST', `/api/dispositions/${decisions.useAsIs}/verify`, { result: 'VERIFIED', method: 'Concession check', note: 'Conditions applied; serial on build sheet' }), 201);
    expect((await quality.send('POST', `/api/dispositions/${decisions.ret}/verify`, { result: 'VERIFIED', method: 'Return shipment', note: 'RMA shipped', inspectionId: reinspection.id })).status).toBe(422);
    ok(await quality.send('POST', `/api/dispositions/${decisions.ret}/verify`, { result: 'VERIFIED', method: 'Return shipment', note: 'RMA-5521 shipped with carrier receipt (fictional)' }), 201);
    const d = ok(await quality.get(`/api/ncrs/${ncrId}`));
    expect(d.scopes[0].state).toBe('VERIFIED_RESOLVED');
    expect(d.ncr.status).toBe('VERIFIED_RESOLVED');
  });

  it('release is a separate action by someone other than the disposition decider', async () => {
    const own = await manager.send('POST', `/api/scopes/${scopeId}/release`, { note: 'Release verified kits' });
    expect(own.status).toBe(403);
    expect(own.json.error.message).toMatch(/other than the disposition decider/);
    const r = ok(await quality.send('POST', `/api/scopes/${scopeId}/release`, { note: 'Released verified kits back to stock shelf (record only)' }));
    expect(r.released).toBe(2); // use-as-is + rework; the returned kit is not released
    expect(ok(await quality.get(`/api/ncrs/${ncrId}`)).scopes[0].state).toBe('RELEASED');
  });

  it('AT-15 / NEG-07 / NEG-18: SCAR with 8D response, PDI-verified implementation; stays open and visible after NCR closure', async () => {
    scarId = ok(
      await purchasing.send('POST', '/api/scars', {
        ncrIds: [ncrId],
        supplierId: (await h.pool.query(`SELECT id FROM supplier WHERE code = 'NWR'`)).rows[0].id,
        siteId: null,
        sourceId: h.ids.sources.ringNwr1,
        partId: ringPartId,
        title: 'Missing running-face coating on ring kits',
        problemStatement: 'Lot LOT-Q1 item SN-2002 received without running-face coating; see NCR.',
        requestedActions: 'Containment of stock, root cause, corrective action and evidence',
        sentTo: 'Quality manager, Northwind (fictional)',
        sentVia: 'EMAIL',
        responseDue: plusDays(14),
        ownerId: h.ids.users.quality,
      }),
      201,
    ).id;
    ok(
      await purchasing.send('POST', `/api/scars/${scarId}/responses`, {
        receivedAt: today(),
        channel: 'EMAIL',
        representative: 'Lee Example (Northwind QA)',
        containment: 'Sorted 400 kits in stock; 3 uncoated found',
        rootCause: 'Masking fixture left on during PVD run',
        correctiveAction: 'Fixture removal check added to PVD router; operator retrained',
        supplierClaimsDone: true,
      }),
      201,
    );
    let scar = ok(await quality.get(`/api/scars/${scarId}`));
    expect(scar.scar.status).toBe('RESPONSE_RECEIVED'); // a "done" claim is not verification
    expect((await quality.send('POST', `/api/scars/${scarId}/close`, { note: 'Supplier says done' })).status).toBe(403); // quality lacks scar.close
    expect((await manager.send('POST', `/api/scars/${scarId}/close`, { note: 'Supplier says done' })).status).toBe(422);
    const noEvidence = await quality.send('POST', `/api/scars/${scarId}/verifications`, { kind: 'IMPLEMENTATION', result: 'VERIFIED', method: 'Supplier email', evidence: 'Supplier confirmed by email' });
    expect(noEvidence.status).toBe(422);
    expect(noEvidence.json.error.message).toMatch(/supplier statement alone/i);
    ok(await purchasing.upload(`/api/evidence/SCAR/${scarId}`, await makePdf('PVD router rev with fixture check'), 'router.pdf', 'application/pdf'), 201);
    ok(await quality.send('POST', `/api/scars/${scarId}/verifications`, { kind: 'IMPLEMENTATION', result: 'VERIFIED', method: 'Document review', evidence: 'Revised router reviewed; check step present' }), 201);

    // NCR closes after local resolution while the SCAR stays open and visible.
    const n = ok(await quality.get(`/api/ncrs/${ncrId}`));
    const closed = ok(await quality.send('POST', `/api/ncrs/${ncrId}/close`, { note: 'Material resolved and released', expectedVersion: n.ncr.version }));
    expect(closed.openScars).toHaveLength(1);
    const after = ok(await quality.get(`/api/ncrs/${ncrId}`));
    expect(after.ncr.status).toBe('CLOSED');
    expect(after.scars[0].status).toBe('IMPLEMENTATION_VERIFIED');
    expect(ok(await quality.get('/api/scars?status=OPEN')).map((s: { id: string }) => s.id)).toContain(scarId);
    await expect(h.pool.query(`UPDATE ncr SET title = 'edited' WHERE id = $1`, [ncrId])).rejects.toThrow(/final and immutable/);

    // Effectiveness: independent verifier, a plan, and later production evidence.
    expect((await quality.send('POST', `/api/scars/${scarId}/verifications`, { kind: 'EFFECTIVENESS', result: 'VERIFIED', method: 'Receiving inspection', evidence: 'self-verified effectiveness' })).status).toBe(403);
    expect((await manager.send('POST', `/api/scars/${scarId}/verifications`, { kind: 'EFFECTIVENESS', result: 'VERIFIED', method: 'Receiving inspection', evidence: 'no plan recorded yet' })).status).toBe(422);
    ok(await purchasing.send('PUT', `/api/scars/${scarId}/plan`, { effectivenessPlan: 'Inspect the next three production lots for coating presence on every item' }));
    const earlier = (await h.pool.query(`SELECT id FROM inspection WHERE lot_number = 'LOT-REPL'`)).rows[0].id;
    const stale = await manager.send('POST', `/api/scars/${scarId}/verifications`, { kind: 'EFFECTIVENESS', result: 'VERIFIED', method: 'Receiving inspection', evidence: 'Old lot', inspectionIds: [earlier] });
    expect(stale.status).toBe(422);
    expect(stale.json.error.message).toMatch(/predates/);
    const later = await ringInspection(inspector, { lot: 'LOT-Q2', units: 2 });
    ok(
      await manager.send('POST', `/api/scars/${scarId}/verifications`, {
        kind: 'EFFECTIVENESS',
        result: 'VERIFIED',
        method: 'Receiving inspection of later production',
        evidence: 'LOT-Q2 coating present on all items',
        inspectionIds: [later.id],
        populationNote: 'First of three planned lots (fictional)',
      }),
      201,
    );
    ok(await manager.send('POST', `/api/scars/${scarId}/close`, { note: 'Effectiveness verified on later production' }));
    scar = ok(await quality.get(`/api/scars/${scarId}`));
    expect(scar.scar.status).toBe('CLOSED');
    expect(scar.verifications.map((v: { kind: string; result: string }) => `${v.kind}:${v.result}`)).toEqual(['IMPLEMENTATION:VERIFIED', 'EFFECTIVENESS:VERIFIED']);
  });

  it('NEG-18: SCAR and NCR states cannot be pushed by work items or direct edits', async () => {
    const item = (await h.pool.query(`SELECT id FROM work_item WHERE subject_type = 'SCAR' LIMIT 1`)).rows[0];
    for (const url of [`/api/work/${item.id}/complete`, `/api/work-items/${item.id}`, `/api/scars/${scarId}/status`]) {
      expect([404, 405]).toContain((await manager.send('POST', url, { status: 'CLOSED' })).status);
    }
    await expect(h.pool.query(`UPDATE scar SET status = 'ISSUED' WHERE id = $1`, [scarId])).rejects.toThrow(/only a recurrence/);
  });

  it('AT-08: a later production defect reopens the SCAR and the new NCR retrieves FAI history, approvals and follow-up', async () => {
    // FAI history on the source: rejected first article, accepted resubmission.
    const f1 = ok(await purchasing.send('POST', `/api/sources/${h.ids.sources.ringNwr1}/fai`, { sampleType: 'INITIAL_FAI', receivedDate: '2026-09-01', serialNumbers: 'FA-1' }), 201);
    ok(await purchasing.send('PUT', `/api/fai/${f1.id}/results`, { results: [{ charKey: 'free_end_gap', value: '10.05' }] }));
    ok(await quality.send('POST', `/api/fai/${f1.id}/decide`, { expectedVersion: 2, decision: 'REJECTED', defects: 'Running face uncoated on 2 of 5 rings', rationale: 'Coating missing' }));
    const f2 = ok(
      await purchasing.send('POST', `/api/sources/${h.ids.sources.ringNwr1}/fai`, {
        sampleType: 'RESUBMITTED_FAI',
        receivedDate: '2026-09-15',
        serialNumbers: 'FA-2',
        correctiveRationale: 'Masking fixture removed before PVD; coating thickness audit added at the supplier.',
      }),
      201,
    );
    ok(
      await purchasing.send('PUT', `/api/fai/${f2.id}/results`, {
        results: [
          { charKey: 'free_end_gap', value: '10.05' },
          { charKey: 'installed_end_gap', value: '0.52' },
          { charKey: 'axial_width', value: '2.980' },
          { charKey: 'radial_wall', value: '4.20' },
        ],
      }),
    );
    ok(await quality.send('POST', `/api/fai/${f2.id}/decide`, { expectedVersion: 2, decision: 'ACCEPTED', rationale: 'All conform' }));

    const later = await ringInspection(inspector2, { lot: 'LOT-Q7', units: 1, failCoating: [1] });
    const ev = ok(await inspector2.send('POST', `/api/inspections/${later.id}/concerns`, { unitIndex: 1, sectionKey: 'B', rowKey: 'running_face_coating' }), 201);
    const ncr2 = ok(
      await quality.send('POST', `/api/quality/events/${ev.id}/confirm-ncr`, {
        expectedVersion: 1,
        severity: 'HIGH',
        ownerId: h.ids.users.quality,
        failureMode: 'Missing running-face coating',
        rationale: 'Same failure mode as the closed SCAR — recurrence',
        recurrenceOfScarId: scarId,
        recurrenceResponseDue: plusDays(10),
      }),
      201,
    );
    const scar = ok(await quality.get(`/api/scars/${scarId}`));
    expect(scar.scar).toMatchObject({ status: 'ISSUED', cycle: 2 });
    expect(scar.reopens).toHaveLength(1);
    expect(scar.verifications).toHaveLength(2); // earlier cycle kept
    const d = ok(await quality.get(`/api/ncrs/${ncr2.id}`));
    expect(d.ncr.recurrence_scar_number).toBe(scar.scar.number);
    expect(d.related.fais.map((f: { decision: string }) => f.decision)).toEqual(['REJECTED', 'ACCEPTED']);
    expect(d.related.fais[0].defects).toMatch(/uncoated/);
    expect(d.related.fais[1].correctiveRationale).toMatch(/Masking fixture/);
    expect(d.related.priorNcrs.map((n: { id: string; sameSource: boolean }) => [n.id, n.sameSource])).toContainEqual([ncrId, true]);
    expect(d.scars.map((s: { relation: string }) => s.relation)).toEqual(['RECURRENCE']);
  });

  it('controlled NCR, SCAR and concession PDFs are issued as numbered editions', async () => {
    ok(await quality.send('POST', `/api/ncrs/${ncrId}/report`), 201);
    const ncrPdf = await pdfText('NCR', ncrId, 'ncr-ops-06.pdf');
    expect(ncrPdf).toContain('NONCONFORMANCE REPORT');
    expect(ncrPdf).toMatch(/OPS-06/);
    expect(ncrPdf).toContain('LOT-Q1');
    expect(ncrPdf).toMatch(/Use as is/);
    expect(ncrPdf).toMatch(/Return to supplier/);
    ok(await purchasing.send('POST', `/api/scars/${scarId}/report`), 201);
    const scarPdf = await pdfText('SCAR', scarId, 'scar-ops-07.pdf');
    expect(scarPdf).toContain('SUPPLIER CORRECTIVE ACTION REQUEST');
    expect(scarPdf).toMatch(/Masking fixture/);
    expect(scarPdf).toMatch(/EFFECTIVENESS/);
    ok(await manager.send('POST', `/api/concessions/${concessionId}/report`), 201);
    const devPdf = await pdfText('CONCESSION', concessionId, 'concession-ops-05.pdf');
    expect(devPdf).toContain('TEMPORARY DEVIATION / CONCESSION');
    expect(devPdf).toMatch(/1 used of 1/);
    // A second issue is a new edition; the first stays unchanged.
    ok(await quality.send('POST', `/api/ncrs/${ncrId}/report`), 201);
    await h.svc.worker!.drain();
    expect((await h.pool.query(`SELECT edition FROM report_rendition WHERE subject_type = 'NCR' AND subject_id = $1 ORDER BY edition`, [ncrId])).rows.map((r) => r.edition)).toEqual([1, 2]);
  });
});

describe('AT-02 — accepted item confirmed with an authorized concession', () => {
  it('confirmation needs review_accepted; the concession must cover the lot; uses are counted', async () => {
    const created = ok(
      await inspector.send('POST', '/api/inspections', {
        partId: ringPartId,
        formRevisionId: await formRevisionId(inspector, 'PDI-IQI-004'),
        unitCount: 2,
        dateReceived: today(),
        sourceId: h.ids.sources.ringNwr1,
        lotNumber: 'LOT-A2',
      }),
      201,
    );
    const id = created.id as string;
    await passAll(inspector, id, 0, 'A');
    for (const u of [1, 2]) {
      await passAll(inspector, id, u, 'B');
      ok(await save(inspector, id, Object.entries(RING).map(([rowKey, v]) => ({ unitIndex: u, sectionKey: 'C', rowKey, status: 'P', readings: { a1: v } }))));
    }
    ok(await save(inspector, id, [{ unitIndex: 1, sectionKey: 'B', rowKey: 'orientation_mark', status: 'A', note: 'Mark faint but legible' }]));
    ok(await inspector.upload(`/api/inspections/${id}/photos?unitIndex=1&sectionKey=B&rowKey=orientation_mark`, makePng(50, 40), 'mark.png', 'image/png'), 201);
    ok(await inspector.send('POST', `/api/inspections/${id}/complete`, { expectedVersion: await version(inspector, id) }));

    const dev = ok(
      await inspector.send('POST', '/api/concessions', {
        partId: ringPartId,
        inspectionId: id,
        lotNumber: 'LOT-A2',
        quantityLimit: 1,
        characteristic: 'Orientation Mark',
        permittedException: 'Faint orientation mark accepted when legible',
        justification: 'Legibility confirmed by Engineering (fictional)',
        validFrom: today(),
        validUntil: plusDays(7),
      }),
      201,
    );
    // Not yet approved → cannot be used.
    const notYet = await manager.send('POST', `/api/inspections/${id}/review`, { decision: 'CONFIRM', expectedVersion: await version(manager, id), concessionId: dev.id });
    expect(notYet.status).toBe(422);
    ok(await manager.send('POST', `/api/concessions/${dev.id}/decide`, { expectedVersion: 1, decision: 'APPROVED', rationale: 'Bounded to lot A2' }));
    // Quality may review but lacks the authority to confirm Accepted results.
    expect((await quality.send('POST', `/api/inspections/${id}/review`, { decision: 'CONFIRM', expectedVersion: await version(quality, id), concessionId: dev.id })).status).toBe(403);
    ok(await manager.send('POST', `/api/inspections/${id}/review`, { decision: 'CONFIRM', expectedVersion: await version(manager, id), concessionId: dev.id }));
    const insp = ok(await inspector.get(`/api/inspections/${id}`));
    expect(insp.outcome).toBe('ACCEPTED'); // still distinct from PASS
    expect(insp.concession).toMatchObject({ number: expect.stringMatching(/^DEV-/), quantity: 1 });
    const c = ok(await inspector.get(`/api/concessions/${dev.id}`));
    expect(c.concession.state).toBe('EXHAUSTED');
    expect(c.uses).toHaveLength(1);
  });
});

describe('AT-07 / AT-18 — supplier commitments, failed verification, reminders and escalation', () => {
  let commitmentId: string;
  let nwrId: string;

  it('AT-07: a supplier claim is not verification; uncoated incoming units fail it and the source is restricted', async () => {
    nwrId = (await h.pool.query(`SELECT id FROM supplier WHERE code = 'NWR'`)).rows[0].id;
    const ringRev = (await h.pool.query(`SELECT baseline_revision_id FROM source WHERE id = $1`, [h.ids.sources.ringNwr2])).rows[0].baseline_revision_id;
    commitmentId = ok(
      await purchasing.send('POST', '/api/commitments', {
        supplierId: nwrId,
        sourceId: h.ids.sources.ringNwr2,
        baselineRevisionId: ringRev,
        representative: 'Lee Example (Northwind QA)',
        channel: 'CALL',
        communicatedAt: today(),
        statement: 'All ring kits shipped from Plant 2 will carry the running-face coating from the next lot.',
        promisedAction: 'Apply running-face coating on all Plant 2 ring kits',
        expectedOutcome: 'Coating present on every incoming item',
        verificationMethod: 'Receiving inspection of the next Plant 2 lot',
        ownerId: h.ids.users.purchasing,
        dueDate: plusDays(20),
        severity: 'HIGH',
      }),
      201,
    ).id;
    ok(await purchasing.send('POST', `/api/commitments/${commitmentId}/events`, { kind: 'SUPPLIER_CLAIM', note: 'Supplier e-mail: coating implemented' }), 201);
    let c = ok(await purchasing.get(`/api/commitments/${commitmentId}`));
    expect(c.commitment.status).toBe('SUPPLIER_CLAIMS_DONE');
    expect((await quality.send('POST', `/api/commitments/${commitmentId}/verify`, { result: 'VERIFIED', note: 'Supplier says so' })).status).toBe(422);

    const incoming = await ringInspection(inspector, { lot: 'LOT-P2-1', units: 2, failCoating: [1, 2], sourceId: h.ids.sources.ringNwr2 });
    await confirmReview(incoming.id);
    expect((await quality.send('POST', `/api/commitments/${commitmentId}/verify`, { result: 'VERIFIED', note: 'Lot received', inspectionId: incoming.id })).status).toBe(422);
    ok(await quality.send('POST', `/api/commitments/${commitmentId}/verify`, { result: 'FAILED', note: 'Both items uncoated on LOT-P2-1', inspectionId: incoming.id }));
    ok(await manager.send('POST', `/api/sources/${h.ids.sources.ringNwr2}/restrictions`, { reason: 'Coating commitment failed on LOT-P2-1' }), 201);

    c = ok(await purchasing.get(`/api/commitments/${commitmentId}`));
    expect(c.commitment).toMatchObject({ status: 'OPEN', owner_name: 'Morgan Diaz' }); // duty and owner kept
    expect(c.events.map((e: { kind: string }) => e.kind)).toEqual(['SUPPLIER_CLAIM', 'VERIFICATION_FAILED']);
    expect(c.events[1].inspectionNumber).toBe(incoming.number);
    const src = ok(await purchasing.get(`/api/sources/${h.ids.sources.ringNwr2}`));
    expect(src.status.status).toBe('RESTRICTED');
    expect(gateMap(src.gates).SUPPLIER_NOT_RESTRICTED).toBe('FAIL');
    // Plant 1 (a different exact source) is not restricted by Plant 2's hold.
    expect(ok(await purchasing.get(`/api/sources/${h.ids.sources.ringNwr1}`)).status.status).not.toBe('RESTRICTED');
    const next = ok(
      await inspector.send('POST', '/api/inspections', { partId: ringPartId, formRevisionId: await formRevisionId(inspector, 'PDI-IQI-004'), unitCount: 1, dateReceived: today(), sourceId: h.ids.sources.ringNwr2 }),
      201,
    );
    expect(ok(await inspector.get(`/api/inspections/${next.id}`)).sourceState).toBe('RESTRICTED');
    const supplier = ok(await purchasing.get(`/api/suppliers/${nwrId}`));
    expect(supplier.quality.commitments.map((x: { id: string }) => x.id)).toContain(commitmentId);
    expect(supplier.restrictions.some((r: { kind: string; sourceLabel: string }) => r.kind === 'RESTRICTED' && /Lakeside/.test(r.sourceLabel))).toBe(true);
  });

  it('AT-18: overdue commitments are reminded daily and escalated per severity; verified with evidence they close', async () => {
    const promise = ok(
      await purchasing.send('POST', '/api/commitments', {
        supplierId: nwrId,
        representative: 'Sam Example (Northwind sales)',
        channel: 'MEETING',
        communicatedAt: plusDays(-10),
        statement: 'Will send the revised packaging specification.',
        promisedAction: 'Send revised packaging specification',
        verificationMethod: 'Document received and reviewed by PDI',
        ownerId: h.ids.users.purchasing,
        dueDate: plusDays(-2),
        severity: 'HIGH',
      }),
      201,
    );
    const first = await runCommitmentReminders(h.pool, TZ);
    expect(first.reminded).toBeGreaterThanOrEqual(1);
    expect(first.escalated).toBeGreaterThanOrEqual(1);
    const again = await runCommitmentReminders(h.pool, TZ);
    expect(again).toEqual({ reminded: 0, escalated: 0 }); // idempotent per day
    const c = ok(await purchasing.get(`/api/commitments/${promise.id}`));
    expect(c.commitment.overdue).toBe(true);
    expect(c.events.map((e: { kind: string }) => e.kind)).toEqual(['REMINDER', 'ESCALATED']);
    const mine = ok(await purchasing.get('/api/home'));
    expect(mine.work.find((w: { subjectId: string; kind: string }) => w.subjectId === promise.id && w.kind === 'COMMITMENT_FOLLOW_UP')).toMatchObject({ overdue: true, link: `/commitments/${promise.id}` });
    const team = ok(await manager.get('/api/home'));
    expect(team.work.some((w: { subjectId: string; kind: string }) => w.subjectId === promise.id && w.kind === 'COMMITMENT_ESCALATION')).toBe(true);
    expect(team.counts.overdue_commitments).toBeGreaterThanOrEqual(1);

    ok(await purchasing.upload(`/api/evidence/COMMITMENT/${promise.id}`, await makePdf('Packaging spec rev C'), 'packaging.pdf', 'application/pdf'), 201);
    ok(await quality.send('POST', `/api/commitments/${promise.id}/verify`, { result: 'VERIFIED', note: 'Revised packaging specification received and reviewed' }));
    const done = ok(await purchasing.get(`/api/commitments/${promise.id}`));
    expect(done.commitment.status).toBe('VERIFIED');
    expect((await h.pool.query(`SELECT count(*)::int AS n FROM work_item WHERE subject_id = $1 AND status = 'OPEN'`, [promise.id])).rows[0].n).toBe(0);
    await expect(h.pool.query(`UPDATE supplier_commitment SET status = 'OPEN' WHERE id = $1`, [promise.id])).rejects.toThrow(/final and immutable/);
  });
});

describe('AT-16 / NEG-17 — supplier coating/process change', () => {
  it('compares baselines, assesses impact, requires requalification, separates approval, effectivity and verified first lot', async () => {
    // An approved Path B source at a new supplier for the ring kit, governed by supplier spec S1.
    const sup = ok(await purchasing.send('POST', '/api/suppliers', { code: 'CHX', legalName: 'Crestline Rings (fictional)', category: 'Piston rings' }), 201);
    const site = ok(await purchasing.send('POST', `/api/suppliers/${sup.id}/sites`, { code: 'M1', name: 'Crestline Mill 1' }), 201);
    const spec = ok(await purchasing.send('POST', `/api/parts/${ringPartId}/baselines`, { title: 'Crestline spec CR-55 (fictional)', ownership: 'SUPPLIER', revisionLabel: 'S1', documentRef: 'CR-55' }), 201);
    const chars = [
      { charKey: 'free_end_gap', name: 'Free End Gap (relaxed)', charType: 'DIMENSIONAL', formRowRef: 'dimensional:free_end_gap_relaxed', unit: 'mm', lower: '9.80', upper: '10.40' },
      { charKey: 'radial_wall', name: 'Radial Wall Thickness', charType: 'DIMENSIONAL', formRowRef: 'dimensional:radial_wall_thickness', unit: 'mm', lower: '4.10', upper: '4.30' },
      { charKey: 'installed_end_gap', name: 'Installed End Gap', charType: 'DIMENSIONAL', formRowRef: 'dimensional:installed_end_gap', unit: 'mm', lower: '0.40', upper: '0.65' },
      { charKey: 'axial_width', name: 'Axial Width (ring height)', charType: 'DIMENSIONAL', formRowRef: 'dimensional:axial_width_ring_height', unit: 'mm', lower: '2.970', upper: '2.990' },
    ];
    ok(await purchasing.send('PUT', `/api/baseline-revisions/${spec.revisionId}/characteristics`, { characteristics: chars }));
    ok(await purchasing.send('POST', `/api/baseline-revisions/${spec.revisionId}/submit`));
    ok(await engineering.send('POST', `/api/baseline-revisions/${spec.revisionId}/release`, { rationale: 'Catalog sheet checked (fictional)' }));
    const approveSource = async (revisionId: string) => {
      const req = ok(await purchasing.send('POST', '/api/sourcing', { title: `Crestline ring kit ${revisionId.slice(0, 4)}`, pathway: 'B', partId: ringPartId, supplierId: sup.id, siteId: site.id, supplierPartNumber: 'CR-55' }), 201);
      ok(
        await purchasing.send('POST', `/api/sourcing/${req.id}/risk`, {
          inputs: { criticality: 1, severity: 1, supplierMaturity: 1, newness: 1, manufacturingChange: 1, verificationDifficulty: 1, qualityHistory: 1 },
        }),
      );
      const detail = ok(await purchasing.get(`/api/sourcing/${req.id}`));
      const s = ok(await purchasing.send('POST', `/api/sourcing/${req.id}/source`, { expectedVersion: detail.request.version, baselineRevisionId: revisionId }), 201);
      for (const r of ok(await purchasing.get(`/api/sourcing/${req.id}`)).requirements.filter((x: { applicability: string }) => x.applicability === 'REQUIRED')) {
        ok(await purchasing.upload(`/api/evidence/EVIDENCE_REQUIREMENT/${r.id}`, await makePdf(r.code), `${r.code}.pdf`, 'application/pdf'), 201);
        ok(await purchasing.send('POST', `/api/requirements/${r.id}/satisfy`, { expectedVersion: r.version, note: 'Fictional evidence' }));
      }
      return { sourceId: s.sourceId as string, requestId: req.id as string };
    };
    const q = ok(await purchasing.send('POST', `/api/suppliers/${sup.id}/qualifications`, { siteId: site.id, kind: 'INITIAL', scope: 'Rings', findings: 'Capable (fictional)', proposedResult: 'QUALIFIED' }), 201);
    ok(await quality.send('POST', `/api/qualifications/${q.id}/decide`, { expectedVersion: 1, decision: 'QUALIFIED', rationale: 'Reviewed', validUntil: '2028-12-31' }));
    const original = await approveSource(spec.revisionId);
    ok(await manager.send('POST', `/api/sources/${original.sourceId}/decision`, { decision: 'APPROVED', scope: 'CR-55 from Mill 1 per S1', rationale: 'Low risk catalog' }), 201);
    const before = await ringInspection(inspector, { lot: 'LOT-CR-OLD', units: 1, sourceId: original.sourceId });

    // Supplier PCN: new coating process, radial wall tolerance changes.
    const s2 = ok(await purchasing.send('POST', `/api/baselines/${spec.baselineId}/revisions`, { revisionLabel: 'S2' }), 201).revisionId;
    ok(
      await purchasing.send('PUT', `/api/baseline-revisions/${s2}/characteristics`, {
        characteristics: [chars[0], { ...chars[1], lower: '4.15' }, chars[2], chars[3], { charKey: 'coating', name: 'Running face coating', charType: 'VISUAL', formRowRef: null, limitText: 'PVD CrN present' }],
      }),
    );
    const chg = ok(
      await engineering.send('POST', '/api/changes', {
        origin: 'SUPPLIER',
        title: 'Crestline PVD coating process change',
        description: 'Supplier moves running-face coating from chrome plating to PVD CrN and tightens radial wall.',
        justification: 'Supplier PCN-77: environmental and wear improvement',
        categories: ['COATING', 'PROCESS'],
        partId: ringPartId,
        supplierId: sup.id,
        siteId: site.id,
        sourceIds: [original.sourceId],
        currentRevisionId: spec.revisionId,
        proposedRevisionId: s2,
        supplierReference: 'PCN-77',
        supplierRepresentative: 'Dana Example (Crestline QA)',
        desiredEffectiveDate: today(),
        affectedStock: '40 kits in stock from LOT-CR-OLD stay under S1',
        ownerId: h.ids.users.engineering,
      }),
      201,
    );
    let d = ok(await engineering.get(`/api/changes/${chg.id}`));
    expect(d.diff.find((r: { charKey: string }) => r.charKey === 'radial_wall')).toMatchObject({ change: 'CHANGED', fields: ['lower'] });
    expect(d.diff.find((r: { charKey: string }) => r.charKey === 'coating').change).toBe('ADDED');
    expect((await manager.send('POST', `/api/changes/${chg.id}/decide`, { expectedVersion: d.change.version, decision: 'APPROVED', rationale: 'Too early' })).status).toBe(409);

    const items = ['DRAWING', 'VALIDATION_FAI', 'INSPECTION_PLAN', 'SOURCE_APPROVAL', 'SUPPLIER_ACKNOWLEDGMENT', 'STOCK_WIP', 'SUPPLIER_COMMITMENTS'].map((area) => ({
      area,
      affected: area !== 'SUPPLIER_COMMITMENTS',
      assessment: `${area} assessed for PVD change (fictional)`,
    }));
    ok(await engineering.send('PUT', `/api/changes/${chg.id}/impact`, { expectedVersion: d.change.version, summary: 'Coating and wall change require new source approval', requalificationRequired: true, items }));
    d = ok(await engineering.get(`/api/changes/${chg.id}`));
    // The requester cannot decide; requalification actions are required before approval.
    const self = await engineering.send('POST', `/api/changes/${chg.id}/decide`, { expectedVersion: d.change.version, decision: 'APPROVED', rationale: 'Self decision attempt' });
    expect(self.status).toBe(403);
    expect((await manager.send('POST', `/api/changes/${chg.id}/decide`, { expectedVersion: d.change.version, decision: 'APPROVED', rationale: 'Looks acceptable' })).status).toBe(422);
    const action = async (kind: string, waivable = true) =>
      ok(await engineering.send('POST', `/api/changes/${chg.id}/actions`, { kind, ownerId: h.ids.users.purchasing, dueDate: plusDays(14), waivable }), 201).id as string;
    const releaseAction = await action('BASELINE_RELEASE', false);
    const ackAction = await action('NEW_ACKNOWLEDGMENT');
    const reapproval = await action('SOURCE_REAPPROVAL', false);
    d = ok(await engineering.get(`/api/changes/${chg.id}`));
    ok(await manager.send('POST', `/api/changes/${chg.id}/decide`, { expectedVersion: d.change.version, decision: 'APPROVED', rationale: 'Approved subject to requalification', conditions: 'New source approval before use' }));

    // NEG-17: the current approved source is flagged until the change is verified.
    let src = ok(await purchasing.get(`/api/sources/${original.sourceId}`));
    expect(src.status.status).toBe('REQUALIFICATION_REQUIRED');
    expect(gateMap(src.gates).CHANGE_CONTROL).toBe('FAIL');

    // Effectivity waits for the released revision; the release action needs objective evidence.
    expect((await engineering.send('POST', `/api/changes/${chg.id}/effective`, { effectiveDate: today(), note: 'Go live now' })).status).toBe(422);
    expect((await purchasing.send('POST', `/api/change-actions/${releaseAction}/complete`, { note: 'Released' })).status).toBe(422);
    expect((await quality.send('POST', `/api/change-actions/${releaseAction}/waive`, { reason: 'Not needed for this change' })).status).toBe(422);
    ok(await purchasing.send('POST', `/api/baseline-revisions/${s2}/submit`));
    ok(await engineering.send('POST', `/api/baseline-revisions/${s2}/release`, { rationale: 'PCN-77 revision reviewed (fictional)' }));
    ok(await purchasing.send('POST', `/api/change-actions/${releaseAction}/complete`, { note: 'S2 released by Engineering' }));
    ok(await quality.send('POST', `/api/change-actions/${ackAction}/waive`, { reason: 'Supplier-owned specification; supplier issued S2 itself' }));
    ok(await engineering.send('POST', `/api/changes/${chg.id}/effective`, { effectiveDate: today(), effectiveLot: 'LOT-CR-NEW', note: 'Effective from first PVD lot' }));

    // Requalification: a new exact source governed by S2 is approved.
    const changed = await approveSource(s2);
    expect(changed.sourceId).not.toBe(original.sourceId);
    expect((await quality.send('POST', `/api/changes/${chg.id}/verify-implementation`, { inspectionId: before.id, note: 'Early attempt' })).status).toBe(422); // re-approval still open
    ok(await manager.send('POST', `/api/sources/${changed.sourceId}/decision`, { decision: 'APPROVED', scope: 'CR-55 PVD from Mill 1 per S2', rationale: 'Requalified after PCN-77' }), 201);
    ok(await purchasing.send('POST', `/api/change-actions/${reapproval}/complete`, { note: 'Changed source approved' }));

    // Old-revision lot is not implementation evidence; the first PVD lot under S2 is.
    const old = await quality.send('POST', `/api/changes/${chg.id}/verify-implementation`, { inspectionId: before.id, note: 'Old lot' });
    expect(old.status).toBe(422);
    const wrongLot = await ringInspection(inspector, { lot: 'LOT-CR-X', units: 1, sourceId: changed.sourceId });
    expect((await quality.send('POST', `/api/changes/${chg.id}/verify-implementation`, { inspectionId: wrongLot.id, note: 'Not first lot' })).status).toBe(422);
    const first = await ringInspection(inspector, { lot: 'LOT-CR-NEW', units: 1, sourceId: changed.sourceId });
    expect(first.status).toBe('COMPLETED');
    ok(await quality.send('POST', `/api/changes/${chg.id}/verify-implementation`, { inspectionId: first.id, note: 'First PVD lot conforms to S2' }));

    d = ok(await engineering.get(`/api/changes/${chg.id}`));
    expect(d.change.status).toBe('IMPLEMENTATION_VERIFIED');
    // Shipment-specific effectivity: each lot keeps the revision it was received under.
    const byLot = Object.fromEntries(d.inspections.map((i: { lotNumber: string; revisionLabel: string }) => [i.lotNumber, i.revisionLabel]));
    expect(byLot['LOT-CR-OLD']).toBe('S1');
    expect(byLot['LOT-CR-NEW']).toBe('S2');
    src = ok(await purchasing.get(`/api/sources/${original.sourceId}`));
    expect(src.status.status).toBe('APPROVED');
    await expect(h.pool.query(`UPDATE change_request SET title = 'x' WHERE id = $1`, [chg.id])).rejects.toThrow(/final and immutable/);

    ok(await engineering.send('POST', `/api/changes/${chg.id}/report`), 201);
    const text = await pdfText('CHANGE', chg.id, 'change-ops-04.pdf');
    expect(text).toContain('CHANGE IMPACT & REQUALIFICATION DECISION');
    expect(text).toContain('Radial Wall Thickness');
    expect(text).toMatch(/LOT-CR-NEW/);
  });

  it('a site change always requires requalification', async () => {
    const chg = ok(
      await engineering.send('POST', '/api/changes', {
        origin: 'PDI',
        title: 'Move ring kit to Lakeside plant',
        description: 'Transfer production of the ring kit to another manufacturing site.',
        justification: 'Capacity',
        categories: ['SITE'],
        partId: ringPartId,
        ownerId: h.ids.users.engineering,
      }),
      201,
    );
    const items = ['DRAWING', 'VALIDATION_FAI', 'INSPECTION_PLAN', 'SOURCE_APPROVAL', 'SUPPLIER_ACKNOWLEDGMENT', 'STOCK_WIP', 'SUPPLIER_COMMITMENTS'].map((area) => ({ area, affected: false, assessment: 'n/a' }));
    const r = await engineering.send('PUT', `/api/changes/${chg.id}/impact`, { expectedVersion: 1, summary: 'Site move only, nothing else', requalificationRequired: false, items });
    expect(r.status).toBe(422);
    expect(r.json.error.message).toMatch(/site change always requires requalification/);
  });
});

describe('AT-03 / NEG-03 — controlled form revision editing and one-off inspections', () => {
  it('drafts, edits, independently releases revision B; old inspections keep A; new work uses B', async () => {
    const revA = await formRevisionId(inspector, 'PDI-IQI-004');
    const oldInsp = ok(await inspector.send('POST', '/api/inspections', { partId: ringPartId, formRevisionId: revA, unitCount: 1, dateReceived: today(), lotNumber: 'LOT-F1' }), 201);
    expect((await inspector.send('POST', `/api/form-revisions/${revA}/drafts`, { revisionLabel: 'B', changeSummary: 'Add coating thickness' })).status).toBe(403);
    const draft = ok(await engineering.send('POST', `/api/form-revisions/${revA}/drafts`, { revisionLabel: 'B', changeSummary: 'Add coating thickness check' }), 201);
    expect((await engineering.send('POST', `/api/form-revisions/${revA}/drafts`, { revisionLabel: 'C', changeSummary: 'second draft' })).status).toBe(409);
    const def = ok(await engineering.get(`/api/form-revisions/${draft.id}`)).revision.definition;
    def.sections[1].rows.push({ key: 'coating_thickness_spot', name: 'Coating Thickness Spot Check', acceptance: 'Coating present across full running face' });
    def.sections[1].rows[0].acceptance = 'Coating continuous, no flaking or bare metal';
    expect((await engineering.send('PUT', `/api/form-revisions/${draft.id}/definition`, { definition: { ...def, sections: [] } })).status).toBe(422);
    ok(await engineering.send('PUT', `/api/form-revisions/${draft.id}/definition`, { definition: def }));
    const detail = ok(await engineering.get(`/api/form-revisions/${draft.id}`));
    expect(detail.diff.map((x: { change: string; row: string }) => `${x.change}:${x.row}`)).toEqual(['CHANGED:Running Face Coating', 'ADDED:Coating Thickness Spot Check']);
    ok(await engineering.send('POST', `/api/form-revisions/${draft.id}/submit`));
    const self = await engineering.send('POST', `/api/form-revisions/${draft.id}/release`, { rationale: 'self release' });
    expect(self.status).toBe(403);
    ok(await quality.send('POST', `/api/form-revisions/${draft.id}/release`, { rationale: 'Reviewed with receiving team (fictional)' }));

    // Revision A can no longer start inspections; existing work keeps its frozen A snapshot.
    expect((await inspector.send('POST', '/api/inspections', { partId: ringPartId, formRevisionId: revA, unitCount: 1, dateReceived: today() })).status).toBe(422);
    const revB = await formRevisionId(inspector, 'PDI-IQI-004');
    expect(revB).toBe(draft.id);
    const newInsp = ok(await inspector.send('POST', '/api/inspections', { partId: ringPartId, formRevisionId: revB, unitCount: 1, dateReceived: today() }), 201);
    expect(ok(await inspector.get(`/api/inspections/${newInsp.id}`)).form.definition.revisionLabel).toBe('B');
    const oldDef = ok(await inspector.get(`/api/inspections/${oldInsp.id}`)).form.definition;
    expect(oldDef.revisionLabel).toBeNull();
    expect(oldDef.sections[1].rows.some((r: { key: string }) => r.key === 'coating_thickness_spot')).toBe(false);
    await expect(h.pool.query(`UPDATE form_revision SET definition = '{}'::jsonb WHERE id = $1`, [draft.id])).rejects.toThrow(/immutable/);
  });

  it('FR-042: a governed one-off inspection uses copied receiving rows and always needs independent review', async () => {
    const revB = await formRevisionId(inspector, 'PDI-IQI-004');
    const r = ok(
      await inspector.send('POST', '/api/inspections/one-off', {
        partId: ringPartId,
        component: 'Ring kit sample from new vendor',
        reason: 'Evaluation sample; no catalogue form for this vendor packaging',
        receivingFromRevisionId: revB,
        visualRows: [{ name: 'Packaging insert', acceptance: 'Insert present' }],
        dimensionalRows: [{ name: 'Ring outer diameter', unit: 'mm' }],
        unitCount: 1,
        dateReceived: today(),
      }),
      201,
    );
    const insp = ok(await inspector.get(`/api/inspections/${r.id}`));
    expect(insp.form.definition).toMatchObject({ formNumber: 'PDI-IQI-MISC', oneOff: true });
    expect(insp.form.definition.sections.map((s: { key: string }) => s.key)).toEqual(['A', 'B', 'C']);
    const rev = (await h.pool.query(`SELECT status FROM form_revision WHERE id = $1`, [insp.form.revisionId])).rows[0];
    expect(rev.status).toBe('ONE_OFF');
    // A one-off revision cannot be used to start other inspections.
    expect((await inspector.send('POST', '/api/inspections', { partId: ringPartId, formRevisionId: insp.form.revisionId, unitCount: 1, dateReceived: today() })).status).toBe(422);
    await passAll(inspector, r.id, 0, 'A');
    await passAll(inspector, r.id, 1, 'B');
    ok(await save(inspector, r.id, [{ unitIndex: 1, sectionKey: 'C', rowKey: 'ring_outer_diameter', status: 'P', readings: { a1: '120.02' } }]));
    const done = ok(await inspector.send('POST', `/api/inspections/${r.id}/complete`, { expectedVersion: await version(inspector, r.id) }));
    expect(done.status).toBe('READY_FOR_REVIEW');
    expect(ok(await inspector.get(`/api/inspections/${r.id}`)).reviewReasons.map((x: { message: string }) => x.message)).toContain(
      'One-off form — not a released template; independent review required',
    );
  });

  it('a custom form can be saved as a template at launch; it starts new work only after independent release', async () => {
    const receiving = await formRevisionId(inspector, 'PDI-IQI-010');
    const custom = {
      partId: ringPartId,
      component: 'CAT Oil Cooler Sample',
      reason: 'First sample of a new oil cooler; measured against the sample drawing',
      receivingFromRevisionId: receiving,
      dimensionalRows: [
        { name: 'Overall Length', unit: 'mm', specText: '362.0' },
        { name: 'Thread Size', specText: '3/8-16' },
      ],
      unitCount: 1,
      dateReceived: today(),
    };
    const bad = await inspector.send('POST', '/api/inspections/one-off', { ...custom, saveAsTemplate: { formNumber: 'OIL-COOLER-S' } });
    expect(bad.status).toBe(400);
    const taken = await inspector.send('POST', '/api/inspections/one-off', { ...custom, saveAsTemplate: { formNumber: 'PDI-IQI-010' } });
    expect(taken.status).toBe(409);
    expect(taken.json.error.message).toMatch(/PDI-IQI-010 already exists/);

    const before = (await h.pool.query(`SELECT count(*)::int AS n FROM inspection`)).rows[0].n;
    const r = ok(await inspector.send('POST', '/api/inspections/one-off', { ...custom, saveAsTemplate: { formNumber: 'pdi-iqi-010-s' } }), 201);
    expect(r.templateFormNumber).toBe('PDI-IQI-010-S');
    expect((await h.pool.query(`SELECT count(*)::int AS n FROM inspection`)).rows[0].n).toBe(before + 1);
    const tpl = (ok(await quality.get('/api/forms?all=1')) as Array<{ formNumber: string; status: string; revisionId: string }>).find((f) => f.formNumber === 'PDI-IQI-010-S')!;
    expect(tpl.status).toBe('IN_REVIEW');
    const detail = ok(await quality.get(`/api/form-revisions/${tpl.revisionId}`));
    expect(detail.revision.definition).toMatchObject({ formNumber: 'PDI-IQI-010-S', component: 'CAT Oil Cooler Sample' });
    expect(detail.revision.definition.oneOff).toBeUndefined();
    expect(detail.revision.definition.sections.find((s: { key: string }) => s.key === 'C').rows).toEqual([
      { key: 'overall_length', name: 'Overall Length', unit: 'mm', specText: '362.0' },
      { key: 'thread_size', name: 'Thread Size', specText: '3/8-16' },
    ]);
    // Not usable until released, and the inspector who created it cannot release it.
    expect((await inspector.send('POST', '/api/inspections', { partId: ringPartId, formRevisionId: tpl.revisionId, unitCount: 1, dateReceived: today() })).status).toBe(422);
    expect((await inspector.send('POST', `/api/form-revisions/${tpl.revisionId}/release`, { rationale: 'self' })).status).toBe(403);
    const work = await h.pool.query(`SELECT kind, required_capability, status FROM work_item WHERE subject_type = 'FORM_REVISION' AND subject_id = $1`, [tpl.revisionId]);
    expect(work.rows).toEqual([{ kind: 'FORM_RELEASE', required_capability: 'forms.publish', status: 'OPEN' }]);
    ok(await quality.send('POST', `/api/form-revisions/${tpl.revisionId}/release`, { rationale: 'Checked against the sample drawing (fictional)' }));
    expect((await h.pool.query(`SELECT status FROM work_item WHERE subject_type = 'FORM_REVISION' AND subject_id = $1`, [tpl.revisionId])).rows[0].status).not.toBe('OPEN');
    const next = ok(await inspector.send('POST', '/api/inspections', { partId: ringPartId, formRevisionId: await formRevisionId(inspector, 'PDI-IQI-010-S'), unitCount: 1, dateReceived: today() }), 201);
    expect(ok(await inspector.get(`/api/inspections/${next.id}`)).form.definition.formNumber).toBe('PDI-IQI-010-S');
  });
});

describe('search and work queue across Stage 3 records', () => {
  it('finds NCRs by affected serial and lot, SCARs, concessions, changes and commitments', async () => {
    const byserial = ok(await quality.get('/api/search?q=SN-3003')).records;
    expect(byserial.some((r: { type: string }) => r.type === 'NCR')).toBe(true);
    const pcn = ok(await quality.get('/api/search?q=PCN-77')).records;
    expect(pcn.map((r: { type: string }) => r.type)).toContain('Change');
    const dev = ok(await quality.get('/api/search?q=DEV-')).records;
    expect(dev.some((r: { type: string }) => r.type === 'Concession')).toBe(true);
  });
});
