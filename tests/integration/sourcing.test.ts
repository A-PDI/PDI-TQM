import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MALICIOUS_PDF, makePdf } from '../fixtures/documents.js';
import { makePng } from '../fixtures/images.js';
import { type Harness, type Session, formRevisionId, startHarness } from './harness.js';

/** Stage 2: supplier/site qualification, A/B/C sourcing, FAI, acknowledgment and gated source approval. */
let h: Harness;
let purchasing: Session;
let quality: Session;
let engineering: Session;
let manager: Session;
let inspector: Session;
let admin: Session;
const OUT = path.resolve(import.meta.dirname, '../../var/report-samples');

beforeAll(async () => {
  h = await startHarness();
  [purchasing, quality, engineering, manager, inspector, admin] = await Promise.all([
    h.login('purchasing'),
    h.login('quality'),
    h.login('engineering'),
    h.login('manager'),
    h.login('inspector'),
    h.login('admin'),
  ]);
  mkdirSync(OUT, { recursive: true });
});
afterAll(async () => h?.close());

const ok = (r: { status: number; json: unknown }, status = 200) => {
  expect(r.status, JSON.stringify(r.json)).toBe(status);
  return r.json as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
};

const LOW = { criticality: 1, severity: 1, supplierMaturity: 1, newness: 1, manufacturingChange: 1, verificationDifficulty: 1, qualityHistory: 1 };
const HIGH = { criticality: 3, severity: 3, supplierMaturity: 2, newness: 3, manufacturingChange: 2, verificationDifficulty: 2, qualityHistory: 2 };

async function newSupplier(code: string) {
  const s = ok(await purchasing.send('POST', '/api/suppliers', { code, legalName: `${code} Test Works (fictional)`, category: 'Machining' }), 201);
  const p1 = ok(await purchasing.send('POST', `/api/suppliers/${s.id}/sites`, { code: 'P1', name: `${code} Plant 1` }), 201);
  const p2 = ok(await purchasing.send('POST', `/api/suppliers/${s.id}/sites`, { code: 'P2', name: `${code} Plant 2` }), 201);
  return { supplierId: s.id as string, site1: p1.id as string, site2: p2.id as string };
}

async function qualifySite(supplierId: string, siteId: string | null) {
  const q = ok(
    await purchasing.send('POST', `/api/suppliers/${supplierId}/qualifications`, {
      siteId,
      kind: 'INITIAL',
      scope: 'Machining of engine components',
      findings: 'Process audit complete; capable equipment; fictional findings.',
      proposedResult: 'QUALIFIED',
    }),
    201,
  );
  ok(await quality.send('POST', `/api/qualifications/${q.id}/decide`, { expectedVersion: 1, decision: 'QUALIFIED', rationale: 'Assessment evidence reviewed', validUntil: '2028-12-31' }));
  return q.id as string;
}

async function releasedBaseline(partId: string, ownership: string, label: string, chars: unknown[], baseRevisionId?: string) {
  const b = ok(
    await purchasing.send('POST', `/api/parts/${partId}/baselines`, {
      title: `${ownership} spec ${label} (fictional)`,
      ownership,
      revisionLabel: label,
      baseRevisionId,
      documentRef: `DOC-${label}`,
    }),
    201,
  );
  if (chars.length) ok(await purchasing.send('PUT', `/api/baseline-revisions/${b.revisionId}/characteristics`, { characteristics: chars }));
  ok(await purchasing.send('POST', `/api/baseline-revisions/${b.revisionId}/submit`));
  ok(await engineering.send('POST', `/api/baseline-revisions/${b.revisionId}/release`, { rationale: 'Checked against drawing (fictional)' }));
  return { baselineId: b.baselineId as string, revisionId: b.revisionId as string };
}

async function satisfyAll(requestId: string, skip: string[] = []) {
  const detail = ok(await purchasing.get(`/api/sourcing/${requestId}`));
  for (const r of detail.requirements.filter((x: { applicability: string; status: string; code: string }) => x.applicability === 'REQUIRED' && x.status === 'OPEN' && !skip.includes(x.code))) {
    ok(await purchasing.upload(`/api/evidence/EVIDENCE_REQUIREMENT/${r.id}`, await makePdf(r.code), `${r.code}.pdf`, 'application/pdf'), 201);
    ok(await purchasing.send('POST', `/api/requirements/${r.id}/satisfy`, { expectedVersion: r.version, note: 'Fictional evidence' }));
  }
  return detail;
}

const gateMap = (gates: Array<{ code: string; status: string; detail: string }>) => Object.fromEntries(gates.map((g) => [g.code, g.status]));

describe('AT-09 / AT-08 / AT-12 / AT-17 — Path A new PDI design', () => {
  let sourceId: string;
  let requestId: string;
  let decision: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  let sup: Awaited<ReturnType<typeof newSupplier>>;

  it('runs intake → risk → checklist → preliminary draft that cannot govern', async () => {
    sup = await newSupplier('AXM');
    const part = ok(await purchasing.send('POST', '/api/parts', { partNumber: 'TQ-SPC-9001', description: 'Exhaust manifold spacer (reverse engineered)', defaultFormNumber: 'PDI-IQI-016' }), 201);
    const req = ok(
      await purchasing.send('POST', '/api/sourcing', {
        title: 'Reverse-engineered manifold spacer',
        pathway: 'A',
        partId: part.id,
        supplierId: sup.supplierId,
        siteId: sup.site1,
        supplierPartNumber: 'AXM-77',
      }),
      201,
    );
    requestId = req.id;
    expect(ok(await purchasing.send('POST', `/api/sourcing/${requestId}/risk`, { inputs: HIGH, rationale: 'Engine-critical gasket face' })).result).toBe('HIGH');
    const detail = ok(await purchasing.get(`/api/sourcing/${requestId}`));
    const required = detail.requirements.filter((r: { applicability: string }) => r.applicability === 'REQUIRED').map((r: { code: string }) => r.code);
    // AT-17: a high-risk source lists PPAP-style elements.
    expect(required).toEqual(expect.arrayContaining(['ENG-01', 'ENG-08', 'VAL-01', 'VAL-03', 'SUP-03', 'VAL-06', 'VAL-07', 'VAL-08', 'VAL-09']));

    // Preliminary reverse-engineered draft.
    const draft = ok(
      await purchasing.send('POST', `/api/parts/${part.id}/baselines`, { title: 'PDI drawing TQ-SPC-9001 (fictional)', ownership: 'PDI', revisionLabel: 'X1' }),
      201,
    );
    ok(
      await purchasing.send('PUT', `/api/baseline-revisions/${draft.revisionId}/characteristics`, {
        characteristics: [
          { charKey: 'overall_thickness', name: 'Overall Thickness', charType: 'DIMENSIONAL', formRowRef: 'dimensional:overall_thickness', unit: 'mm', lower: '11.90', upper: '12.10' },
          { charKey: 'flange_flatness', name: 'Flange Face Flatness', charType: 'DIMENSIONAL', formRowRef: 'dimensional:flange_face_flatness', unit: 'mm', upper: '0.05' },
          { charKey: 'gas_passages', name: 'Gas passage profile', charType: 'VISUAL', limitText: 'Free of flash and inclusions' },
        ],
      }),
    );
    const src = ok(await purchasing.send('POST', `/api/sourcing/${requestId}/source`, { expectedVersion: (await purchasing.get(`/api/sourcing/${requestId}`)).json.request.version, baselineRevisionId: draft.revisionId }), 201);
    sourceId = src.sourceId;
    const s = ok(await purchasing.get(`/api/sources/${sourceId}`));
    expect(gateMap(s.gates).BASELINE_RELEASED).toBe('FAIL');
    expect(s.gates.find((g: { code: string }) => g.code === 'BASELINE_RELEASED').detail).toMatch(/draft, not released/);

    // An inspection on this source must not use draft limits.
    const insp = ok(
      await inspector.send('POST', '/api/inspections', { partId: part.id, formRevisionId: await formRevisionId(inspector, 'PDI-IQI-016'), unitCount: 1, dateReceived: '2026-10-19', sourceId }),
      201,
    );
    expect(ok(await inspector.get(`/api/inspections/${insp.id}`)).baseline).toBeNull();

    // AT-12: approval with an unqualified site, draft baseline, no FAI, no acknowledgment, missing evidence → explicit failures.
    const r = await manager.send('POST', `/api/sources/${sourceId}/decision`, { decision: 'APPROVED', scope: 'Production supply', rationale: 'Attempt' });
    expect(r.status).toBe(422);
    const failing = r.json.error.details.gates.filter((g: { status: string }) => g.status === 'FAIL').map((g: { code: string }) => g.code);
    expect(failing).toEqual(expect.arrayContaining(['BASELINE_RELEASED', 'SITE_QUALIFIED', 'SUPPLIER_ACKNOWLEDGED', 'FAI_ACCEPTED', 'EVIDENCE_COMPLETE']));
    expect(r.json.error.details.gates.every((g: { label: string; detail: string }) => g.label && g.detail)).toBe(true);
    const failed = await h.pool.query(`SELECT 1 FROM audit_event WHERE entity_id = $1 AND action = 'source.decide' AND outcome = 'FAILED'`, [sourceId]);
    expect(failed.rowCount).toBe(1);
  });

  it('releases the drawing independently and qualifies the exact site', async () => {
    const s = ok(await purchasing.get(`/api/sources/${sourceId}`));
    const revId = s.revision.id;
    ok(await purchasing.send('POST', `/api/baseline-revisions/${revId}/submit`));
    // Purchasing authored it and lacks release authority; engineering releases.
    expect((await purchasing.send('POST', `/api/baseline-revisions/${revId}/release`, { rationale: 'self decision' })).status).toBe(403);
    ok(await engineering.send('POST', `/api/baseline-revisions/${revId}/release`, { rationale: 'Dimensions verified against sample (fictional)' }));
    await expect(h.pool.query(`UPDATE baseline_characteristic SET upper_limit = 99 WHERE revision_id = $1`, [revId])).rejects.toThrow(/cannot be changed/);

    // Supplier-level qualification does not qualify a site.
    await qualifySite(sup.supplierId, null);
    let gates = gateMap(ok(await purchasing.get(`/api/sources/${sourceId}`)).gates);
    expect(gates.SITE_QUALIFIED).toBe('FAIL');
    // Assessor cannot decide their own assessment; purchasing lacks the authority anyway.
    const q = ok(
      await purchasing.send('POST', `/api/suppliers/${sup.supplierId}/qualifications`, {
        siteId: sup.site1,
        kind: 'INITIAL',
        scope: 'Spacer machining',
        findings: 'Fictional on-site audit',
        proposedResult: 'QUALIFIED',
      }),
      201,
    );
    expect((await purchasing.send('POST', `/api/qualifications/${q.id}/decide`, { expectedVersion: 1, decision: 'QUALIFIED', rationale: 'self decision' })).status).toBe(403);
    expect(
      (await quality.send('POST', `/api/qualifications/${q.id}/decide`, { expectedVersion: 1, decision: 'CONDITIONALLY_QUALIFIED', rationale: 'Missing conditions' })).status,
    ).toBe(422);
    ok(await quality.send('POST', `/api/qualifications/${q.id}/decide`, { expectedVersion: 1, decision: 'QUALIFIED', rationale: 'Audit evidence reviewed', validUntil: '2028-06-30' }));
    await expect(h.pool.query(`UPDATE supplier_qualification SET decision = 'REJECTED' WHERE id = $1`, [q.id])).rejects.toThrow(/immutable/);
    gates = gateMap(ok(await purchasing.get(`/api/sources/${sourceId}`)).gates);
    expect(gates.BASELINE_RELEASED).toBe('PASS');
    expect(gates.SITE_QUALIFIED).toBe('PASS');
  });

  it('FAI: rejected first article stays on record; resubmission needs corrective rationale (AT-08, FR-034)', async () => {
    const f1 = ok(await purchasing.send('POST', `/api/sources/${sourceId}/fai`, { sampleType: 'INITIAL_FAI', receivedDate: '2026-10-10', serialNumbers: 'S-001' }), 201);
    ok(
      await purchasing.send('PUT', `/api/fai/${f1.id}/results`, {
        results: [
          { charKey: 'overall_thickness', value: '12.14' },
          { charKey: 'flange_flatness', value: '0.03' },
          { charKey: 'gas_passages', visualResult: 'DOES_NOT_CONFORM', note: 'Casting flash in port' },
        ],
      }),
    );
    // Cannot accept nonconforming results.
    expect((await quality.send('POST', `/api/fai/${f1.id}/decide`, { expectedVersion: 2, decision: 'ACCEPTED', rationale: 'Try to accept' })).status).toBe(422);
    ok(await quality.send('POST', `/api/fai/${f1.id}/decide`, { expectedVersion: 2, decision: 'REJECTED', defects: 'Oversize thickness; casting flash in gas passage', rationale: 'Two nonconformities' }));
    await expect(h.pool.query(`UPDATE fai_result SET value_text = '12.00' WHERE fai_id = $1`, [f1.id])).rejects.toThrow(/frozen/);

    expect((await purchasing.send('POST', `/api/sources/${sourceId}/fai`, { sampleType: 'INITIAL_FAI', receivedDate: '2026-10-15' })).status).toBe(422);
    expect((await purchasing.send('POST', `/api/sources/${sourceId}/fai`, { sampleType: 'RESUBMITTED_FAI', receivedDate: '2026-10-15', correctiveRationale: 'fixed' })).status).toBe(422);
    const f2 = ok(
      await purchasing.send('POST', `/api/sources/${sourceId}/fai`, {
        sampleType: 'RESUBMITTED_FAI',
        receivedDate: '2026-10-15',
        serialNumbers: 'S-014',
        correctiveRationale: 'Root cause: worn facing tool and missing deflash step. Tool replaced, deflash added to router; sample taken from first production-rate run.',
      }),
      201,
    );
    ok(
      await purchasing.send('PUT', `/api/fai/${f2.id}/results`, {
        results: [
          { charKey: 'overall_thickness', value: '12.02' },
          { charKey: 'flange_flatness', value: '0.02' },
          { charKey: 'gas_passages', visualResult: 'CONFORMS' },
        ],
      }),
    );
    // Independence: a person who recorded the sample cannot decide it, even when granted the authority.
    ok(await admin.send('POST', `/api/admin/users/${h.ids.users.purchasing}/grants`, { capabilities: ['validation.decide'], reason: 'Cross-trained (test)' }));
    const self = await purchasing.send('POST', `/api/fai/${f2.id}/decide`, { expectedVersion: 2, decision: 'ACCEPTED', rationale: 'self decision' });
    expect(self.status).toBe(403);
    expect(self.json.error.message).toMatch(/registered or measured/);
    ok(await quality.send('POST', `/api/fai/${f2.id}/decide`, { expectedVersion: 2, decision: 'ACCEPTED', rationale: 'All characteristics conform' }));
    const s = ok(await purchasing.get(`/api/sources/${sourceId}`));
    expect(s.fais.map((f: { decision: string }) => f.decision)).toEqual(['REJECTED', 'ACCEPTED']);
    expect(gateMap(s.gates).FAI_ACCEPTED).toBe('PASS');
    expect(s.gates.find((g: { code: string }) => g.code === 'FAI_ACCEPTED').detail).toMatch(/after 1 rejected sample/);
  });

  it('acknowledgment of the exact revision, evidence and waivers, then approval with a frozen manifest', async () => {
    const ack = ok(await purchasing.send('POST', `/api/sources/${sourceId}/acknowledgments`, { sentVia: 'EMAIL', sentTo: 'quality@axm.example', sentAt: '2026-10-16' }), 201);
    expect(gateMap(ok(await purchasing.get(`/api/sources/${sourceId}`)).gates).SUPPLIER_ACKNOWLEDGED).toBe('FAIL');
    ok(await purchasing.send('POST', `/api/acknowledgments/${ack.id}/response`, { response: 'ACKNOWLEDGED', representative: 'Pat Example (AXM QA)', respondedAt: '2026-10-17' }));
    await expect(h.pool.query(`UPDATE supplier_acknowledgment SET response = 'OBJECTED' WHERE id = $1`, [ack.id])).rejects.toThrow(/recorded once/);

    const detail = await satisfyAll(requestId, ['VAL-09']);
    const msa = detail.requirements.find((r: { code: string }) => r.code === 'VAL-09');
    expect((await purchasing.send('POST', `/api/requirements/${msa.id}/waive`, { expectedVersion: msa.version, reason: 'Gauges are standard calibrated micrometers' })).status).toBe(403);
    ok(await quality.send('POST', `/api/requirements/${msa.id}/waive`, { expectedVersion: msa.version, reason: 'Gauges are standard calibrated micrometers; MSA not justified (fictional)' }));
    // Satisfying requires an attached file.
    const sup03 = detail.requirements.find((r: { code: string }) => r.code === 'SUP-05');
    expect((await purchasing.send('POST', `/api/requirements/${sup03.id}/satisfy`, { expectedVersion: sup03.version })).status).toBe(422);

    const s = ok(await purchasing.get(`/api/sources/${sourceId}`));
    expect(s.gates.filter((g: { status: string }) => g.status === 'FAIL')).toEqual([]);
    // The request owner cannot approve (and lacks authority); the manager can.
    expect((await purchasing.send('POST', `/api/sources/${sourceId}/decision`, { decision: 'APPROVED', scope: 'x', rationale: 'self decision' })).status).toBe(403);
    ok(await purchasing.send('POST', `/api/sources/${sourceId}/request-approval`));
    decision = ok(
      await manager.send('POST', `/api/sources/${sourceId}/decision`, {
        decision: 'APPROVED',
        scope: 'Production supply of TQ-SPC-9001 from AXM Plant 1 per Rev X1',
        validUntil: '2028-06-30',
        rationale: 'All gates met; rejected FAI corrected and verified',
      }),
      201,
    );
    expect(decision.number).toMatch(/^PSA-\d{4}-\d{5}$/);
    const after = ok(await purchasing.get(`/api/sources/${sourceId}`));
    expect(after.status.status).toBe('APPROVED');
    expect(ok(await purchasing.get(`/api/sourcing/${requestId}`)).request.status).toBe('APPROVED');
  });

  it('frozen evidence cannot change and the approval record PDF lists the exact package (AT-12, AT-17)', async () => {
    await expect(h.pool.query(`UPDATE source_approval_decision SET decision = 'REJECTED' WHERE id = $1`, [decision.id])).rejects.toThrow(/immutable/);
    await expect(h.pool.query(`UPDATE source SET site_id = (SELECT id FROM supplier_site WHERE name = 'AXM Plant 2') WHERE id = $1`, [sourceId])).rejects.toThrow(/immutable/);
    const detail = ok(await purchasing.get(`/api/sourcing/${requestId}`));
    const satisfied = detail.requirements.find((r: { status: string }) => r.status === 'SATISFIED');
    expect((await purchasing.upload(`/api/evidence/EVIDENCE_REQUIREMENT/${satisfied.id}`, await makePdf('late'), 'late.pdf', 'application/pdf')).status).toBe(409);
    const stored = await h.pool.query(`SELECT manifest_sha256 FROM source_approval_decision WHERE id = $1`, [decision.id]);
    expect(stored.rows[0].manifest_sha256).toBe(decision.manifestSha256);

    expect(await h.svc.worker!.drain()).toBe(1);
    const s = ok(await purchasing.get(`/api/sources/${sourceId}`));
    const report = s.decisions[0].report;
    const pdf = (await purchasing.get(`/api/files/${report.fileId}`)).raw;
    const file = path.join(OUT, 'source-approval-record.pdf');
    writeFileSync(file, pdf);
    const text = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
    for (const expected of ['PRODUCT & SUPPLIER APPROVAL RECORD', 'DECISION: APPROVED', 'AXM Plant 1', 'Rev X1', 'REJECTED', 'Root cause: worn facing tool', 'Waived:', decision.manifestSha256]) {
      expect(text).toContain(expected);
    }
  });

  it('AT-13: suspending the site blocks the approved source without editing the decision; reinstatement restores it', async () => {
    expect((await purchasing.send('POST', `/api/suppliers/${sup.supplierId}/restrictions`, { siteId: sup.site1, reason: 'x' })).status).toBe(403);
    const r = ok(await manager.send('POST', `/api/suppliers/${sup.supplierId}/restrictions`, { siteId: sup.site1, reason: 'Repeat coating escapes under investigation' }), 201);
    expect(r.affectedSources).toBe(1);
    let s = ok(await purchasing.get(`/api/sources/${sourceId}`));
    expect(s.status.status).toBe('SUSPENDED');
    expect(s.decisions[0].decision).toBe('APPROVED');
    expect(gateMap(s.gates).SUPPLIER_NOT_RESTRICTED).toBe('FAIL');
    // Receipts against the suspended source are flagged at start.
    const part = s.source.part_id;
    const insp = ok(
      await inspector.send('POST', '/api/inspections', { partId: part, formRevisionId: await formRevisionId(inspector, 'PDI-IQI-016'), unitCount: 1, dateReceived: '2026-10-20', sourceId }),
      201,
    );
    expect(ok(await inspector.get(`/api/inspections/${insp.id}`)).sourceState).toBe('SUSPENDED');
    ok(await manager.send('POST', `/api/restrictions/${r.id}/lift`, { reason: 'Containment verified; root cause closed (fictional)' }));
    s = ok(await purchasing.get(`/api/sources/${sourceId}`));
    expect(s.status.status).toBe('APPROVED');
  });
});

describe('AT-10 / NEG-04 — Path B supplier-standard product, low risk', () => {
  it('needs only proportionate evidence and approves one exact site, never the sibling site', async () => {
    const parts = ok(await purchasing.get('/api/parts?q=TQ-PRK-3003'));
    const nwr = (await h.pool.query(`SELECT id FROM supplier WHERE code = 'NWR'`)).rows[0].id;
    const sites = (await h.pool.query(`SELECT id, code FROM supplier_site WHERE supplier_id = $1`, [nwr])).rows;
    const p1 = sites.find((s) => s.code === 'P1').id;
    const req = ok(
      await purchasing.send('POST', '/api/sourcing', {
        title: 'Catalog ring kit from NWR',
        pathway: 'B',
        partId: parts[0].id,
        supplierId: nwr,
        siteId: p1,
        supplierPartNumber: 'NR-3003',
      }),
      201,
    );
    ok(await purchasing.send('POST', `/api/sourcing/${req.id}/risk`, { inputs: LOW }));
    let detail = ok(await purchasing.get(`/api/sourcing/${req.id}`));
    const required = detail.requirements.filter((r: { applicability: string }) => r.applicability === 'REQUIRED').map((r: { code: string }) => r.code);
    expect(required.sort()).toEqual(['ENG-04', 'ENG-05']);
    expect(detail.requirements.filter((r: { code: string; applicability: string }) => r.code.startsWith('VAL-0') && ['VAL-06', 'VAL-07', 'VAL-08', 'VAL-09'].includes(r.code)).every((r: { applicability: string }) => r.applicability === 'NOT_APPLICABLE')).toBe(true);
    // Links the existing seeded source governed by the supplier baseline S1.
    const s1 = (await h.pool.query(`SELECT r.id FROM baseline_revision r JOIN technical_baseline b ON b.id = r.baseline_id WHERE b.title LIKE 'NWR catalog spec%'`)).rows[0].id;
    const created = ok(await purchasing.send('POST', `/api/sourcing/${req.id}/source`, { expectedVersion: detail.request.version, baselineRevisionId: s1 }), 201);
    expect(created.sourceId).toBe(h.ids.sources.ringNwr1);
    await qualifySite(nwr, p1);
    await satisfyAll(req.id);
    const s = ok(await purchasing.get(`/api/sources/${created.sourceId}`));
    expect(gateMap(s.gates)).toMatchObject({ SUPPLIER_ACKNOWLEDGED: 'NOT_APPLICABLE', FAI_ACCEPTED: 'NOT_APPLICABLE' });
    ok(await manager.send('POST', `/api/sources/${created.sourceId}/decision`, { decision: 'APPROVED', scope: 'Catalog ring kit NR-3003 from Riverton Plant 1', rationale: 'Low-risk catalog item' }), 201);
    detail = ok(await purchasing.get(`/api/sourcing/${req.id}`));
    expect(detail.sourceStatus.status).toBe('APPROVED');

    // NEG-04: the same part from Plant 2 does not inherit Plant 1's approval.
    const form = await formRevisionId(inspector, 'PDI-IQI-004');
    const at2 = ok(await inspector.send('POST', '/api/inspections', { partId: parts[0].id, formRevisionId: form, unitCount: 1, dateReceived: '2026-10-20', sourceId: h.ids.sources.ringNwr2 }), 201);
    const at1 = ok(await inspector.send('POST', '/api/inspections', { partId: parts[0].id, formRevisionId: form, unitCount: 1, dateReceived: '2026-10-20', sourceId: h.ids.sources.ringNwr1 }), 201);
    expect(ok(await inspector.get(`/api/inspections/${at2.id}`)).sourceState).toBe('NOT_APPROVED');
    expect(ok(await inspector.get(`/api/inspections/${at1.id}`)).sourceState).toBe('APPROVED');
  });
});

describe('AT-11 — Path C modified supplier product', () => {
  it('keeps the PDI delta on the exact supplier base; a later supplier revision does not replace it', async () => {
    const part = ok(await purchasing.get('/api/parts?q=TQ-PST-1001'))[0];
    const base = await releasedBaseline(part.id, 'SUPPLIER', 'S1', [
      { charKey: 'skirt_od', name: 'Skirt OD', charType: 'DIMENSIONAL', formRowRef: 'dimensional:skirt_od', unit: 'mm', lower: '136.90', upper: '137.00' },
      { charKey: 'skirt_coating', name: 'Skirt coating', charType: 'VISUAL', limitText: 'Standard phosphate' },
    ]);
    const delta = ok(
      await purchasing.send('POST', `/api/parts/${part.id}/baselines`, {
        title: 'PDI delta: graphite skirt coating (fictional)',
        ownership: 'SUPPLIER_PLUS_DELTA',
        revisionLabel: 'D1',
        baseRevisionId: base.revisionId,
      }),
      201,
    );
    let chars = ok(await purchasing.get(`/api/baseline-revisions/${delta.revisionId}`)).characteristics;
    expect(chars.map((c: { charKey: string }) => c.charKey).sort()).toEqual(['skirt_coating', 'skirt_od']);
    // No delta flagged → cannot submit.
    expect((await purchasing.send('POST', `/api/baseline-revisions/${delta.revisionId}/submit`)).status).toBe(422);
    chars = chars.map((c: { charKey: string }) =>
      c.charKey === 'skirt_coating' ? { ...c, limitText: 'Graphite coating 100% coverage, 8–12 µm', isDelta: true } : c,
    );
    ok(await purchasing.send('PUT', `/api/baseline-revisions/${delta.revisionId}/characteristics`, { characteristics: chars }));
    ok(await purchasing.send('POST', `/api/baseline-revisions/${delta.revisionId}/submit`));
    ok(await engineering.send('POST', `/api/baseline-revisions/${delta.revisionId}/release`, { rationale: 'Delta reviewed' }));

    // Supplier later releases a new standard revision S2.
    const s2 = ok(await purchasing.send('POST', `/api/baselines/${base.baselineId}/revisions`, { revisionLabel: 'S2' }), 201);
    ok(await purchasing.send('POST', `/api/baseline-revisions/${s2.revisionId}/submit`));
    ok(await engineering.send('POST', `/api/baseline-revisions/${s2.revisionId}/release`, { rationale: 'Supplier catalog update' }));

    const d = ok(await purchasing.get(`/api/baseline-revisions/${delta.revisionId}`));
    expect(d.revision.status).toBe('RELEASED');
    expect(d.base.revisionLabel).toBe('S1');
    expect(d.base.newerReleasedLabel).toBe('S2');
    expect(d.characteristics.find((c: { charKey: string }) => c.charKey === 'skirt_coating').limitText).toMatch(/Graphite/);

    const sup = await newSupplier('CXP');
    const req = ok(
      await purchasing.send('POST', '/api/sourcing', { title: 'Coated piston', pathway: 'C', partId: part.id, supplierId: sup.supplierId, siteId: sup.site1, supplierPartNumber: 'CXP-PST' }),
      201,
    );
    const detail = ok(await purchasing.get(`/api/sourcing/${req.id}`));
    // Path C must be governed by the delta, not the supplier's standard baseline.
    expect((await purchasing.send('POST', `/api/sourcing/${req.id}/source`, { expectedVersion: detail.request.version, baselineRevisionId: base.revisionId })).status).toBe(422);
    const created = ok(await purchasing.send('POST', `/api/sourcing/${req.id}/source`, { expectedVersion: detail.request.version, baselineRevisionId: delta.revisionId }), 201);
    const s = ok(await purchasing.get(`/api/sources/${created.sourceId}`));
    const g = s.gates.find((x: { code: string }) => x.code === 'DELTA_RELEASED');
    expect(g.status).toBe('PASS');
    expect(g.detail).toMatch(/released Rev S2; it does not replace the PDI configuration/);
    expect(gateMap(s.gates).SUPPLIER_ACKNOWLEDGED).toBe('FAIL');

    // Inspection limits come from the delta revision (which carries the supplier's dimensions plus the PDI delta).
    const insp = ok(
      await inspector.send('POST', '/api/inspections', { partId: part.id, formRevisionId: await formRevisionId(inspector, 'PDI-IQI-001'), unitCount: 1, dateReceived: '2026-10-20', sourceId: created.sourceId }),
      201,
    );
    const i = ok(await inspector.get(`/api/inspections/${insp.id}`));
    expect(i.baseline.revisionLabel).toBe('D1');
    expect(i.limits['dimensional:skirt_od']).toMatchObject({ lower: '136.90', upper: '137.00', unit: 'mm' });
  });
});

describe('independence, authority and evidence safety', () => {
  it('an engineering author cannot release their own baseline', async () => {
    const part = ok(await purchasing.get('/api/parts?q=TQ-WPM-7007'))[0];
    const b = ok(await engineering.send('POST', `/api/parts/${part.id}/baselines`, { title: 'Water pump drawing (fictional)', ownership: 'PDI', revisionLabel: 'A', documentRef: 'DWG-7007' }), 201);
    ok(await engineering.send('POST', `/api/baseline-revisions/${b.revisionId}/submit`));
    const r = await engineering.send('POST', `/api/baseline-revisions/${b.revisionId}/release`, { rationale: 'self release' });
    expect(r.status).toBe(403);
    const denied = await h.pool.query(`SELECT 1 FROM audit_event WHERE entity_id = $1 AND outcome = 'DENIED' AND action = 'baseline.release'`, [b.revisionId]);
    expect(denied.rowCount).toBe(1);
  });

  it('rejects active-content PDFs and disguised files; accepts genuine documents and images', async () => {
    const sup = await newSupplier('DOC');
    const cert = ok(await purchasing.send('POST', `/api/suppliers/${sup.supplierId}/certificates`, { certType: 'ISO 9001 certificate (fictional)', validUntil: '2027-03-31' }), 201);
    const url = `/api/evidence/CERTIFICATE/${cert.id}`;
    let r = await purchasing.upload(url, MALICIOUS_PDF, 'cert.pdf', 'application/pdf');
    expect(r.status).toBe(422);
    expect(r.json.error.message).toMatch(/active or embedded content/);
    r = await purchasing.upload(url, Buffer.from('<html><script>x</script></html>'), 'cert.pdf', 'application/pdf');
    expect(r.status).toBe(422);
    ok(await purchasing.upload(url, await makePdf('ISO cert'), 'iso.pdf', 'application/pdf'), 201);
    ok(await purchasing.upload(url, makePng(), 'scan.png', 'image/png'), 201);
    // Inspectors cannot attach supplier evidence.
    expect((await inspector.upload(url, await makePdf('x'), 'x.pdf', 'application/pdf')).status).toBe(403);
    const supDetail = ok(await purchasing.get(`/api/suppliers/${sup.supplierId}`));
    expect(supDetail.certificates[0].files).toHaveLength(2);
    expect(supDetail.sites.map((s: { qualification: { status: string } }) => s.qualification.status)).toEqual(['NOT_ASSESSED', 'NOT_ASSESSED']);
  });

  it('work items route to the right queue and link to the record', async () => {
    const sup = await newSupplier('WRK');
    const q = ok(
      await purchasing.send('POST', `/api/suppliers/${sup.supplierId}/qualifications`, {
        siteId: sup.site1,
        kind: 'INITIAL',
        scope: 'Queue routing check',
        findings: 'Fictional',
        proposedResult: 'QUALIFIED',
      }),
      201,
    );
    const work = ok(await quality.get('/api/home')).work as Array<{ kind: string; subjectId: string; link: string }>;
    const item = work.find((w) => w.kind === 'QUALIFICATION_DECISION' && w.subjectId === q.id);
    expect(item?.link).toBe(`/suppliers/${sup.supplierId}`);
    // Not in the inspector's queue (no qualification authority).
    expect((ok(await inspector.get('/api/home')).work as Array<{ subjectId: string }>).some((w) => w.subjectId === q.id)).toBe(false);
  });
});
