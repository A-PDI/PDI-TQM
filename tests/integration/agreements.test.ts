import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SCS001_CLAUSES, syntheticDocumentPdf, syntheticMsa001, syntheticScs001 } from '../../src/server/agreements/synthetic-documents.js';
import { makePdf } from '../fixtures/documents.js';
import { type Harness, type Session, formRevisionId, startHarness } from './harness.js';

/**
 * Supplier agreements and controlled quality specifications (owner scenarios A to I; J is the
 * existing regression suite). Fictional suppliers and synthetic documents only.
 */
let h: Harness;
let admin: Session;
let quality: Session;
let manager: Session;
let purchasing: Session;
let inspector: Session;
let today: string;
let yesterday: string;
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
const docs: Record<string, { documentId: string; revisionId: string }> = {};
let gff: { supplierId: string; siteId: string; headPart: string; crankPart: string; headBaseline: string };

async function importDoc(name: string, bytes: Buffer, effectiveFrom = yesterday) {
  const r = ok(await admin.upload(`/api/documents/import?effectiveFrom=${effectiveFrom}`, bytes, name, 'application/pdf'), 201);
  docs[r.number] = { documentId: r.documentId, revisionId: r.revisionId };
  return r;
}

async function lines(agreementId: string) {
  return ok(await purchasing.get(`/api/agreements/${agreementId}`));
}

/** Prepares, submits, approves (quality) and records execution (purchasing) of an agreement draft. */
async function approveAndExecute(id: string, lineInput: Json[], opts: { conflictResolution?: string; effectiveFrom?: string } = {}) {
  let a = await lines(id);
  if (lineInput.length) ok(await purchasing.send('PUT', `/api/agreements/${id}/documents`, { version: a.agreement.version, lines: lineInput }));
  a = await lines(id);
  ok(await purchasing.send('POST', `/api/agreements/${id}/submit`, { version: a.agreement.version }));
  a = await lines(id);
  ok(
    await quality.send('POST', `/api/agreements/${id}/approve`, {
      version: a.agreement.version,
      legalReviewer: 'Counsel (fictional)',
      legalReference: 'Fictional legal review memo LR-1',
      legalReviewedOn: today,
      conflictResolution: opts.conflictResolution ?? null,
    }),
  );
  const signed = ok(await purchasing.upload(`/api/evidence/SUPPLIER_AGREEMENT/${id}?caption=${encodeURIComponent('Signed agreement')}`, await makePdf(`Signed ${id}`), 'signed.pdf', 'application/pdf'), 201);
  a = await lines(id);
  ok(
    await purchasing.send('POST', `/api/agreements/${id}/execution`, {
      version: a.agreement.version,
      signedFileId: signed.fileId,
      effectiveFrom: opts.effectiveFrom ?? today,
      pdiSignatory: { name: 'Pat Example', title: 'VP Operations (fictional)', signedOn: today },
      supplierSignatory: { name: 'Lee Sample', title: 'General Manager (fictional)', signedOn: today },
    }),
  );
  await h.svc.worker!.drain();
  return signed.fileId as string;
}

const recommendedLines = (recs: Json[]) =>
  recs.map((r) => ({
    role: r.role,
    documentRevisionId: r.documentRevisionId ?? null,
    baselineRevisionId: r.baselineRevisionId ?? null,
    contractualRef: r.contractualRef,
    partIds: r.role === 'PART_SCHEDULE' ? r.partIds : [],
    precedence: r.precedence,
  }));

beforeAll(async () => {
  h = await startHarness();
  [admin, quality, manager, purchasing, inspector] = await Promise.all([h.login('admin'), h.login('quality'), h.login('manager'), h.login('purchasing'), h.login('inspector')]);
  today = (await h.pool.query(`SELECT (now() AT TIME ZONE $1)::date::text AS d`, [h.svc.config.displayTimeZone])).rows[0].d;
  yesterday = plusDays(-1);
  await importDoc('MSA-001_Master_Supplier_Agreement_Rev01.pdf', await syntheticMsa001('01'));
  await importDoc('SCS-001_Cast_Component_Quality_Identification_Standard_Rev1.0.pdf', await syntheticScs001('1.0'));
  await importDoc('SFS-002_Forged_Component_Quality_Standard_RevA.pdf', await syntheticDocumentPdf({ number: 'SFS-002', title: 'Forged Component Quality Standard', revision: 'A', kind: 'SPECIFICATION', clauses: [{ ref: '§1', title: 'Scope' }] }));
  await importDoc('SFC-010_Fuel_System_Cleanliness_Standard_Rev01.pdf', await syntheticDocumentPdf({ number: 'SFC-010', title: 'Fuel System Cleanliness Standard', revision: '01', kind: 'SPECIFICATION', clauses: [{ ref: '§1', title: 'Scope' }] }));
  await importDoc('SUP-03_Supplier_Quality_Agreement_Rev02.pdf', await makePdf('SUP-03 Supplier Quality Agreement (fictional stand-in)'));

  // Document Control classifies the agreement documents and specifications (data, not code).
  const classify = (n: string, body: Json) => admin.send('PUT', `/api/documents/${docs[n]!.documentId}/classification`, body);
  ok(await classify('MSA-001', { classification: 'MASTER_AGREEMENT' }));
  ok(await classify('SCS-001', { classification: 'TECHNICAL_SPECIFICATION', categoryCode: 'CASTING', processes: ['Casting'], productFamilies: ['Cylinder heads'] }));
  ok(await classify('SFS-002', { classification: 'TECHNICAL_SPECIFICATION', categoryCode: 'FORGING', processes: ['Forging'] }));
  ok(await classify('SFC-010', { classification: 'TECHNICAL_SPECIFICATION', categoryCode: 'FUEL_CLEANLINESS', productFamilies: ['Injectors'] }));
  ok(await admin.send('POST', `/api/document-revisions/${docs['SCS-001']!.revisionId}/clauses`, { clauses: SCS001_CLAUSES.map((c) => ({ clauseRef: c.ref, title: c.title })) }), 201);

  // Purchasing records part applicability (material / process) as master data.
  const part = async (pn: string) => (await h.pool.query(`SELECT id FROM company_part WHERE part_number = $1`, [pn])).rows[0].id as string;
  const headPart = await part('TQ-CYH-4004');
  const crankPart = await part('TQ-CRK-6006');
  ok(await purchasing.send('PUT', `/api/parts/${headPart}/classification`, { material: 'Gray iron (fictional)', manufacturingProcess: 'Casting' }));
  ok(await purchasing.send('PUT', `/api/parts/${crankPart}/classification`, { material: 'Steel (fictional)', manufacturingProcess: 'Forging' }));

  // A fictional supplier that supplies both cast and forged components from one site.
  const s = ok(await purchasing.send('POST', '/api/suppliers', { code: 'GFF', legalName: 'Granite Forge & Foundry LLC (fictional)', category: 'Castings and forgings' }), 201);
  const site = ok(await purchasing.send('POST', `/api/suppliers/${s.id}/sites`, { code: 'W1', name: 'Works 1', country: 'US' }), 201);
  const headBaseline = (await h.pool.query(`SELECT r.id FROM baseline_revision r JOIN technical_baseline b ON b.id = r.baseline_id WHERE b.part_id = $1 AND r.status = 'RELEASED' LIMIT 1`, [headPart])).rows[0].id as string;
  // Fictional exact sources (the sourcing workflow itself is covered by sourcing.test.ts).
  for (const [p, spn, base] of [[headPart, 'GFF-H-1', headBaseline], [crankPart, 'GFF-C-1', null]] as const) {
    const sp = ok(await purchasing.send('POST', `/api/suppliers/${s.id}/parts`, { supplierPartNumber: spn, description: 'Fictional item' }), 201);
    await h.pool.query(`INSERT INTO source (part_id, supplier_id, site_id, supplier_part_id, baseline_revision_id, pathway, is_synthetic) VALUES ($1,$2,$3,$4,$5,'A',true)`, [p, s.id, site.id, sp.id, base]);
  }
  gff = { supplierId: s.id, siteId: site.id, headPart, crankPart, headBaseline };
});
afterAll(async () => h?.close());

describe('Document Library extensions', () => {
  it('imports dotted revision labels as specifications and lists the classified documents', async () => {
    const scs = ok(await admin.get(`/api/documents/${docs['SCS-001']!.documentId}`));
    expect(scs.kind).toBe('SPECIFICATION');
    expect(scs.revisions[0].revisionLabel).toBe('1.0');
    expect(scs.agreements.classification).toMatchObject({ classification: 'TECHNICAL_SPECIFICATION', categoryCode: 'CASTING' });
    expect(scs.agreements.clauses[docs['SCS-001']!.revisionId]).toHaveLength(SCS001_CLAUSES.length);
    const specs = ok(await quality.get('/api/specifications')) as Json[];
    expect(specs.map((x) => x.number).sort()).toEqual(['MSA-001', 'SCS-001', 'SFC-010', 'SFS-002', 'SUP-03']);
    expect(specs.find((x) => x.number === 'SUP-03')!.classification).toBe('QUALITY_AGREEMENT');
  });

  it('keeps categories configurable by Document Control only, and clauses immutable once recorded', async () => {
    expect((await purchasing.send('POST', '/api/specification-categories', { code: 'HEAT_TREATMENT', label: 'Heat treatment' })).status).toBe(403);
    ok(await admin.send('POST', '/api/specification-categories', { code: 'HEAT_TREATMENT', label: 'Heat treatment' }), 201);
    expect((await admin.send('POST', '/api/specification-categories', { code: 'HEAT_TREATMENT', label: 'Again' })).status).toBe(409);
    expect((await admin.send('PUT', `/api/documents/${docs['SFS-002']!.documentId}/classification`, { classification: 'TECHNICAL_SPECIFICATION' })).status).toBe(422);
    expect((await admin.send('POST', `/api/document-revisions/${docs['SCS-001']!.revisionId}/clauses`, { clauses: [{ clauseRef: '§6.3', title: 'Changed' }] })).status).toBe(409);
    await expect(h.pool.query(`UPDATE document_clause SET title = 'x' WHERE revision_id = $1`, [docs['SCS-001']!.revisionId])).rejects.toThrow(/immutable/);
  });
});

describe('Scenarios A and B: new agreement for a cast and forged supplier', () => {
  let agreementId: string;

  it('recommends the master agreement, SUP-03, matching specifications and part schedules, excluding unrelated documents', async () => {
    const a = ok(await purchasing.send('POST', `/api/suppliers/${gff.supplierId}/agreements`, { title: 'Supply agreement, castings and forgings', siteIds: [gff.siteId], productFamilies: ['Cylinder heads', 'Crankshafts'], expiresOn: plusDays(730) }), 201);
    agreementId = a.id;
    expect(a.number).toMatch(/^SA-\d{4}-\d{5}$/);
    const recs = ok(await purchasing.get(`/api/agreements/${agreementId}/recommendations`)) as Json[];
    const numbers = recs.map((r) => r.documentNumber);
    expect(numbers).toEqual(expect.arrayContaining(['MSA-001', 'SUP-03', 'SCS-001', 'SFS-002', 'TQ-CYH-4004']));
    expect(numbers).not.toContain('SFC-010');
    expect(recs.find((r) => r.documentNumber === 'SCS-001')!.partIds).toEqual([gff.headPart]);
    expect(recs.find((r) => r.documentNumber === 'SFS-002')!.partIds).toEqual([gff.crankPart]);
  });

  it('builds the manifest from exact revisions with SHA-256 and applicability', async () => {
    const recs = ok(await purchasing.get(`/api/agreements/${agreementId}/recommendations`)) as Json[];
    const a = await lines(agreementId);
    const put = ok(await purchasing.send('PUT', `/api/agreements/${agreementId}/documents`, { version: a.agreement.version, lines: recommendedLines(recs) }));
    expect(put.conflicts).toEqual([]);
    const detail = await lines(agreementId);
    const scs = detail.lines.find((l: Json) => l.documentNumber === 'SCS-001');
    expect(scs).toMatchObject({ revisionLabel: '1.0', role: 'SPECIFICATION', documentRevisionId: docs['SCS-001']!.revisionId });
    expect(scs.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(detail.lines.find((l: Json) => l.role === 'PART_SCHEDULE').partIds).toEqual([gff.headPart]);
    // A line may not apply to a site outside the agreement, nor cite an unclassified document.
    const otherSite = (await h.pool.query(`SELECT id FROM supplier_site WHERE code = 'FA'`)).rows[0].id;
    expect((await purchasing.send('PUT', `/api/agreements/${agreementId}/documents`, { version: detail.agreement.version, lines: [{ role: 'SPECIFICATION', documentRevisionId: docs['SCS-001']!.revisionId, contractualRef: 'B', siteIds: [otherSite] }] })).status).toBe(422);
  });

  it('approval is independent and separate from execution; execution needs the signed copy', async () => {
    let a = await lines(agreementId);
    ok(await purchasing.send('POST', `/api/agreements/${agreementId}/submit`, { version: a.agreement.version }));
    a = await lines(agreementId);
    expect((await purchasing.send('POST', `/api/agreements/${agreementId}/approve`, { version: a.agreement.version, legalReviewer: 'x', legalReference: 'y', legalReviewedOn: today })).status).toBe(403);
    expect((await quality.send('POST', `/api/agreements/${agreementId}/approve`, { version: a.agreement.version, legalReviewer: 'Counsel (fictional)', legalReference: 'LR-1', legalReviewedOn: plusDays(3) })).status).toBe(422);
    const approved = ok(await quality.send('POST', `/api/agreements/${agreementId}/approve`, { version: a.agreement.version, legalReviewer: 'Counsel (fictional)', legalReference: 'Fictional memo LR-1', legalReviewedOn: today }));
    expect(approved.status).toBe('AWAITING_EXECUTION');
    a = await lines(agreementId);
    expect(a.agreement.state).toBe('AWAITING_EXECUTION');
    expect(a.signatures.map((s: Json) => s.role)).toEqual(['PDI_APPROVAL', 'LEGAL_REVIEW']);
    // The manifest is frozen once approved.
    expect((await purchasing.send('PUT', `/api/agreements/${agreementId}/documents`, { version: a.agreement.version, lines: [] })).status).toBe(409);
    await expect(h.pool.query(`DELETE FROM supplier_agreement_document WHERE agreement_id = $1`, [agreementId])).rejects.toThrow(/frozen/);
    // Execution without a signed copy on the record is refused.
    const notLinked = (await h.pool.query(`SELECT id FROM file_object LIMIT 1`)).rows[0].id;
    const sig = { name: 'Pat Example', title: 'VP (fictional)', signedOn: today };
    expect((await purchasing.send('POST', `/api/agreements/${agreementId}/execution`, { version: a.agreement.version, signedFileId: notLinked, effectiveFrom: today, pdiSignatory: sig, supplierSignatory: sig })).status).toBe(422);
  });

  it('generates the approved package: front matter plus every original appended unaltered and validated', async () => {
    await h.svc.worker!.drain();
    const a = await lines(agreementId);
    const r = a.renditions.find((x: Json) => x.edition === 1);
    expect(r).toMatchObject({ stage: 'APPROVED', validated: true });
    const pdf = await h.svc.storage.readVerified((await h.pool.query(`SELECT storage_key FROM file_object WHERE id = $1`, [r.fileId])).rows[0].storage_key, r.sha256);
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBe(r.pageCount);
    const checks = r.validation.checks as Json[];
    expect(checks.map((c) => c.name)).toEqual(expect.arrayContaining(['MSA-001 Rev 01', 'SCS-001 Rev 1.0', 'SFS-002 Rev A', 'SUP-03 Rev 02']));
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it('records execution and shows the agreement as active on the supplier record', async () => {
    const signed = ok(await purchasing.upload(`/api/evidence/SUPPLIER_AGREEMENT/${agreementId}?caption=Signed`, await makePdf('Signed GFF agreement'), 'signed-gff.pdf', 'application/pdf'), 201);
    const a = await lines(agreementId);
    ok(
      await purchasing.send('POST', `/api/agreements/${agreementId}/execution`, {
        version: a.agreement.version,
        signedFileId: signed.fileId,
        effectiveFrom: today,
        pdiSignatory: { name: 'Pat Example', title: 'VP Operations (fictional)', signedOn: today },
        supplierSignatory: { name: 'Lee Sample', title: 'General Manager (fictional)', signedOn: today },
      }),
    );
    await h.svc.worker!.drain();
    const sec = ok(await quality.get(`/api/suppliers/${gff.supplierId}/agreements`));
    expect(sec.summary).toMatchObject({ agreementId, masterDocument: 'MSA-001 Rev 01', state: 'EXECUTED', specificationCount: 2, legalEntity: 'Granite Forge & Foundry LLC (fictional)' });
    expect(sec.active.map((x: Json) => x.id)).toEqual([agreementId]);
    expect(sec.specifications.map((l: Json) => l.documentNumber).sort()).toEqual(['MSA-001', 'SCS-001', 'SFS-002', 'SUP-03']);
    expect(sec.partSchedules.map((l: Json) => l.documentNumber)).toEqual(['TQ-CYH-4004']);
    expect(sec.supporting.find((f: Json) => f.signedCopy)).toBeTruthy();
    const detail = await lines(agreementId);
    expect(detail.renditions.map((x: Json) => x.stage)).toEqual(['EXECUTED', 'APPROVED']);
    // SUP-03 travels with the package: a separate SUP-03 record would be a second path.
    const sqa = await purchasing.send('POST', '/api/controlled/records', { typeCode: 'SUP-03', entityId: gff.supplierId });
    expect(sqa.status).toBe(409);
    expect(sqa.json.error.message).toMatch(/approved and executed through agreement/);
  });

  it('does not ask for a redundant acknowledgment of an incorporated revision, but accepts one for another', async () => {
    const dup = await purchasing.send('POST', `/api/suppliers/${gff.supplierId}/acknowledgments`, { documentRevisionId: docs['SCS-001']!.revisionId, sentVia: 'EMAIL', sentTo: 'quality@gff.example', sentAt: today });
    expect(dup.status).toBe(409);
    const k = ok(await purchasing.send('POST', `/api/suppliers/${gff.supplierId}/acknowledgments`, { documentRevisionId: docs['SFC-010']!.revisionId, siteId: gff.siteId, sentVia: 'EMAIL', sentTo: 'quality@gff.example', sentAt: today }), 201);
    expect((await purchasing.send('POST', `/api/suppliers/${gff.supplierId}/acknowledgments`, { documentRevisionId: docs['SFC-010']!.revisionId, siteId: gff.siteId, sentVia: 'EMAIL', sentTo: 'again', sentAt: today })).status).toBe(409);
    ok(await purchasing.send('POST', `/api/acknowledgments/${k.id}/response`, { response: 'ACKNOWLEDGED', representative: 'Lee Sample (fictional)', respondedAt: today, exceptions: 'Cleanliness sampling at W1 per supplier plan pending PDI review (fictional)' }));
    const sec = ok(await quality.get(`/api/suppliers/${gff.supplierId}/agreements`));
    expect(sec.acknowledgments[0]).toMatchObject({ documentNumber: 'SFC-010', revisionLabel: '01', response: 'ACKNOWLEDGED', acceptedThrough: null });
    expect(sec.acknowledgments[0].exceptions).toMatch(/pending PDI review/);
  });
});

describe('Scenario C: draft history', () => {
  it('shows a revised draft and its audit history on the supplier record', async () => {
    const a = ok(await purchasing.send('POST', `/api/suppliers/${gff.supplierId}/agreements`, { title: 'Draft for review', siteIds: [gff.siteId] }), 201);
    let d = await lines(a.id);
    ok(await purchasing.send('PATCH', `/api/agreements/${a.id}`, { version: d.agreement.version, title: 'Draft for review (revised)', exceptions: 'Fictional exception note' }));
    d = await lines(a.id);
    ok(await purchasing.send('PUT', `/api/agreements/${a.id}/documents`, { version: d.agreement.version, lines: [{ role: 'MASTER_AGREEMENT', documentRevisionId: docs['MSA-001']!.revisionId, contractualRef: 'Agreement' }] }));
    expect((await purchasing.send('PATCH', `/api/agreements/${a.id}`, { version: d.agreement.version, title: 'Stale' })).status).toBe(409);
    const sec = ok(await quality.get(`/api/suppliers/${gff.supplierId}/agreements`));
    expect(sec.drafts.find((x: Json) => x.id === a.id)).toMatchObject({ title: 'Draft for review (revised)', state: 'DRAFT', lineCount: 1 });
    const actions = sec.audit.filter((e: Json) => e.summary.includes(a.number)).map((e: Json) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['agreement.create', 'agreement.edit', 'agreement.manifest']));
    d = await lines(a.id);
    ok(await purchasing.send('POST', `/api/agreements/${a.id}/cancel`, { reason: 'Superseded by the executed agreement (fictional)' }));
    const after = ok(await quality.get(`/api/suppliers/${gff.supplierId}/agreements`));
    expect(after.historical.find((x: Json) => x.id === a.id).state).toBe('CANCELLED');
  });
});

describe('Scenarios E and F: specification revision impact and amendment', () => {
  let base: Json;

  it('a newer SCS-001 revision leaves the executed agreement unchanged and opens a revision review', async () => {
    base = ok(await quality.get(`/api/suppliers/${gff.supplierId}/agreements`)).active[0];
    const res = ok(
      await admin.upload(
        `/api/documents/${docs['SCS-001']!.documentId}/revisions?revisionLabel=1.1&effectiveFrom=${today}&changeSummary=${encodeURIComponent('Fictional clarification')}`,
        await syntheticScs001('1.1'),
        'SCS-001_Cast_Component_Quality_Identification_Standard_Rev1.1.pdf',
        'application/pdf',
      ),
      201,
    );
    expect(res.impactedAgreements).toBe(1);
    const a = await lines(base.id);
    expect(a.agreement.state).toBe('EXECUTED');
    expect(a.lines.find((l: Json) => l.documentNumber === 'SCS-001').revisionLabel).toBe('1.0');
    expect(a.stale.map((s: Json) => s.message)).toEqual([expect.stringContaining('Rev 1.1 is now in force')]);
    expect(a.work.find((w: Json) => w.kind === 'AGREEMENT_REVISION_REVIEW')).toMatchObject({ status: 'OPEN' });
    const impact = ok(await quality.get(`/api/documents/${docs['SCS-001']!.documentId}/impact`));
    expect(impact.latest.revisionLabel).toBe('1.1');
    expect(impact.affected).toHaveLength(1);
    expect(impact.affected[0]).toMatchObject({ number: base.number, supplierCode: 'GFF', incorporatedRevision: '1.0' });
    expect(impact.affected[0].parts.map((p: Json) => p.partNumber)).toEqual(['TQ-CYH-4004']);
    docs['SCS-001-1.1'] = { documentId: docs['SCS-001']!.documentId, revisionId: res.revisionId };
    const home = ok(await quality.get('/api/home'));
    expect(home.work.find((w: Json) => w.kind === 'AGREEMENT_REVISION_REVIEW').link).toBe(`/agreements/${base.id}`);
  });

  it('an amendment replaces the revision once executed, linked to the same supplier and original agreement', async () => {
    const am = ok(await purchasing.send('POST', `/api/agreements/${base.id}/amendments`, { changeSummary: 'Incorporate SCS-001 Rev 1.1 (fictional)' }), 201);
    expect(am.number).toBe(`${base.number}-A1`);
    expect((await purchasing.send('POST', `/api/agreements/${base.id}/amendments`, { changeSummary: 'Second at once' })).status).toBe(409);
    // A superseded revision cannot be incorporated.
    const d = await lines(am.id);
    expect((await purchasing.send('PUT', `/api/agreements/${am.id}/documents`, { version: d.agreement.version, lines: [{ role: 'SPECIFICATION', documentRevisionId: docs['SCS-001']!.revisionId, contractualRef: 'Schedule B1' }] })).status).toBe(422);
    await approveAndExecute(am.id, [{ role: 'SPECIFICATION', action: 'REPLACE', documentRevisionId: docs['SCS-001-1.1']!.revisionId, contractualRef: 'Schedule B1', partIds: [gff.headPart] }]);
    const amended = await lines(am.id);
    expect(amended.agreement).toMatchObject({ kind: 'AMENDMENT', parentId: base.id, supplierId: gff.supplierId, state: 'EXECUTED' });
    const parent = await lines(base.id);
    expect(parent.lines.find((l: Json) => l.documentNumber === 'SCS-001').revisionLabel).toBe('1.0');
    expect(parent.effective.filter((l: Json) => l.documentNumber === 'SCS-001').map((l: Json) => l.revisionLabel)).toEqual(['1.1']);
    const sec = ok(await quality.get(`/api/suppliers/${gff.supplierId}/agreements`));
    expect(sec.amendments.map((x: Json) => x.number)).toEqual([am.number]);
    expect(sec.specifications.find((l: Json) => l.documentNumber === 'SCS-001').revisionLabel).toBe('1.1');
    const impact = ok(await quality.get(`/api/documents/${docs['SCS-001']!.documentId}/impact`));
    expect(impact.affected).toHaveLength(0);
    // Executing the amendment answered the review; a later revision opens one review on the agreement, not one per amendment.
    expect(parent.work.find((w: Json) => w.kind === 'AGREEMENT_REVISION_REVIEW').status).toBe('DONE');
    const next = ok(
      await admin.upload(
        `/api/documents/${docs['SCS-001']!.documentId}/revisions?revisionLabel=1.2&effectiveFrom=${plusDays(5)}&changeSummary=${encodeURIComponent('Fictional future revision')}`,
        await syntheticScs001('1.2'),
        'SCS-001_Cast_Component_Quality_Identification_Standard_Rev1.2.pdf',
        'application/pdf',
      ),
      201,
    );
    expect(next.impactedAgreements).toBe(1);
    const open = (await h.pool.query(`SELECT subject_id FROM work_item WHERE kind = 'AGREEMENT_REVISION_REVIEW' AND status = 'OPEN'`)).rows.map((r) => r.subject_id);
    expect(open).toEqual([base.id]);
    expect((await purchasing.send('POST', `/api/agreements/${base.id}/revision-review`, { reason: 'Not mine to decide' })).status).toBe(403);
    ok(await quality.send('POST', `/api/agreements/${base.id}/revision-review`, { reason: 'Rev 1.2 is not yet effective; review at effectivity (fictional)' }));
    expect((await quality.send('POST', `/api/agreements/${base.id}/revision-review`, { reason: 'Again' })).status).toBe(409);
  });
});

describe('Scenario H: operational traceability of the casting specification', () => {
  it('inspection, FAI, NCR and SCAR reference the governing specification for the part and site', async () => {
    const source = (await h.pool.query(`SELECT id FROM source WHERE supplier_id = $1 AND part_id = $2`, [gff.supplierId, gff.headPart])).rows[0].id;
    const insp = ok(await inspector.send('POST', '/api/inspections', { partId: gff.headPart, formRevisionId: await formRevisionId(inspector, 'PDI-IQI-005'), unitCount: 1, poNumber: 'PO-77001', dateReceived: today, sourceId: source, lotNumber: 'GFF-LOT-1' }), 201);
    const snap = (await h.pool.query(`SELECT specification_snapshot FROM inspection WHERE id = $1`, [insp.id])).rows[0].specification_snapshot;
    expect(snap.requirements.map((r: Json) => `${r.documentNumber} ${r.revisionLabel}`)).toEqual(expect.arrayContaining(['SCS-001 1.1', 'MSA-001 01', 'TQ-CYH-4004 A']));
    expect(snap.requirements.map((r: Json) => r.documentNumber)).not.toContain('SFS-002');
    const fai = ok(await purchasing.send('POST', `/api/sources/${source}/fai`, { sampleType: 'INITIAL_FAI', receivedDate: today, lotNumber: 'GFF-FAI-1' }), 201);
    const faiSnap = (await h.pool.query(`SELECT specification_snapshot FROM fai_sample WHERE id = $1`, [fai.id])).rows[0].specification_snapshot;
    expect(faiSnap.requirements.find((r: Json) => r.documentNumber === 'SCS-001').clauses).toHaveLength(0); // Rev 1.1 has no clauses recorded
    const src = ok(await quality.get(`/api/sources/${source}`));
    expect(src.contractualCoverage.informational).toBe(true);
    expect(src.contractualCoverage.governing.agreements).toHaveLength(1);

    // Clauses are recorded for Rev 1.1 so the NCR can cite one.
    ok(await admin.send('POST', `/api/document-revisions/${docs['SCS-001-1.1']!.revisionId}/clauses`, { clauses: SCS001_CLAUSES.map((c) => ({ clauseRef: c.ref, title: c.title })) }), 201);
    const ev = ok(await inspector.send('POST', '/api/quality/events', { title: 'Porosity on head (fictional)', description: 'Porosity at port face (fictional)', partId: gff.headPart, supplierId: gff.supplierId, ownerId: h.ids.users.quality }), 201);
    ok(await quality.send('POST', `/api/quality/events/${ev.id}/triage`, { expectedVersion: 1, decision: 'TRIAGED', ownerId: h.ids.users.quality, severity: 'HIGH' }));
    const ncr = ok(await manager.send('POST', `/api/quality/events/${ev.id}/confirm-ncr`, { expectedVersion: 2, severity: 'HIGH', ownerId: h.ids.users.quality, failureMode: 'Porosity', rationale: 'Confirmed (fictional)' }), 201);
    expect((await quality.send('PUT', `/api/ncrs/${ncr.id}/requirement`, { governingRevisionId: docs['SCS-001-1.1']!.revisionId, governingClause: '§99', governingBaselineRevisionId: null })).status).toBe(422);
    ok(await quality.send('PUT', `/api/ncrs/${ncr.id}/requirement`, { governingRevisionId: docs['SCS-001-1.1']!.revisionId, governingClause: '§6.3', governingBaselineRevisionId: gff.headBaseline }));
    const n = ok(await quality.get(`/api/ncrs/${ncr.id}`));
    expect(n.requirement).toMatchObject({ clause: '§6.3', cited: { documentNumber: 'SCS-001', revisionLabel: '1.1' }, schedule: { partNumber: 'TQ-CYH-4004' } });
    expect(n.requirement.governing.requirements.map((r: Json) => r.documentNumber)).toContain('SCS-001');
    const scar = ok(
      await purchasing.send('POST', '/api/scars', { supplierId: gff.supplierId, partId: gff.headPart, title: 'Porosity (fictional)', problemStatement: 'Porosity at port face (fictional).', sentTo: 'Quality, GFF (fictional)', sentVia: 'EMAIL', responseDue: plusDays(14), ownerId: h.ids.users.purchasing, ncrIds: [ncr.id] }),
      201,
    );
    const sd = ok(await quality.get(`/api/scars/${scar.id}`));
    expect(sd.ncrs[0].governingRequirement).toBe('SCS-001 Rev 1.1 §6.3 part schedule TQ-CYH-4004 Rev A');
  });
});

describe('Scenario D: renewal supersedes the executed agreement; history stays reachable', () => {
  it('keeps the original executed document, manifest and signatures accessible', async () => {
    const original = ok(await quality.get(`/api/suppliers/${gff.supplierId}/agreements`)).active[0];
    const renewal = ok(await purchasing.send('POST', `/api/agreements/${original.id}/renewal`, { expiresOn: plusDays(1100) }), 201);
    const draft = await lines(renewal.id);
    expect(draft.lines.find((l: Json) => l.documentNumber === 'SCS-001').revisionLabel).toBe('1.1');
    await approveAndExecute(renewal.id, []);
    const before = await lines(original.id);
    expect(before.agreement.state).toBe('SUPERSEDED');
    expect(before.agreement.supersededById).toBe(renewal.id);
    expect(before.signatures.map((s: Json) => s.role)).toEqual(['PDI_APPROVAL', 'LEGAL_REVIEW', 'PDI_SIGNATORY', 'SUPPLIER_SIGNATORY']);
    expect(before.lines.find((l: Json) => l.documentNumber === 'SCS-001').revisionLabel).toBe('1.0');
    const signedCopy = await quality.get(`/api/files/${before.agreement.executedFileId}`);
    expect(signedCopy.status).toBe(200);
    for (const r of before.renditions) expect((await quality.get(`/api/files/${r.fileId}`)).status).toBe(200);
    const sec = ok(await quality.get(`/api/suppliers/${gff.supplierId}/agreements`));
    expect(sec.active.map((x: Json) => x.id)).toEqual([renewal.id]);
    const historical = sec.historical.map((x: Json) => `${x.number}:${x.state}`);
    expect(historical).toEqual(expect.arrayContaining([`${original.number}:SUPERSEDED`, `${original.number}-A1:SUPERSEDED`]));
    // The SCS-001 revision review on the superseded agreement is closed with it.
    expect(before.work.find((w: Json) => w.kind === 'AGREEMENT_REVISION_REVIEW').status).toBe('DONE');
  });
});

describe('Scenario G: supplier status change keeps every agreement record', () => {
  it('inactive and suspended suppliers keep their agreements, documents and history', async () => {
    const beforeSec = ok(await quality.get(`/api/suppliers/${gff.supplierId}/agreements`));
    ok(await manager.send('POST', `/api/suppliers/${gff.supplierId}/restrictions`, { reason: 'Fictional suspension for scenario G' }), 201);
    ok(await purchasing.send('POST', `/api/suppliers/${gff.supplierId}/status`, { status: 'INACTIVE', reason: 'Fictional inactivation for scenario G' }));
    const sec = ok(await quality.get(`/api/suppliers/${gff.supplierId}/agreements`));
    expect(sec.supplier.status).toBe('INACTIVE');
    expect(sec.restrictions).toHaveLength(1);
    expect(sec.active.map((x: Json) => x.id)).toEqual(beforeSec.active.map((x: Json) => x.id));
    expect(sec.historical.length).toBe(beforeSec.historical.length);
    expect(sec.audit.length).toBeGreaterThanOrEqual(beforeSec.audit.length);
    for (const f of sec.supporting) expect((await quality.get(`/api/files/${f.fileId}`)).status).toBe(200);
    expect((await purchasing.send('POST', `/api/suppliers/${gff.supplierId}/agreements`, { title: 'New while inactive', siteIds: [gff.siteId] })).status).toBe(409);
    ok(await purchasing.send('POST', `/api/suppliers/${gff.supplierId}/status`, { status: 'ACTIVE', reason: 'Fictional reactivation' }));
  });
});

describe('Scenario I: authorization and historical integrity', () => {
  it('rejects changes to executed agreements, signatures, revisions and associations', async () => {
    const sec = ok(await quality.get(`/api/suppliers/${gff.supplierId}/agreements`));
    const executed = await lines(sec.active[0].id);
    const id = executed.agreement.id;
    expect((await purchasing.send('PATCH', `/api/agreements/${id}`, { version: executed.agreement.version, title: 'Rewritten' })).status).toBe(409);
    expect((await purchasing.send('PUT', `/api/agreements/${id}/documents`, { version: executed.agreement.version, lines: [] })).status).toBe(409);
    expect((await purchasing.send('POST', `/api/agreements/${id}/cancel`, { reason: 'Attempt to cancel executed' })).status).toBe(409);
    expect((await inspector.send('POST', `/api/agreements/${id}/cancel`, { reason: 'Unauthorized attempt' })).status).toBe(403);
    expect((await purchasing.send('POST', `/api/agreements/${id}/terminate`, { reason: 'Unauthorized attempt' })).status).toBe(403);
    expect((await inspector.send('POST', `/api/suppliers/${gff.supplierId}/agreements`, { title: 'x', siteIds: [gff.siteId] })).status).toBe(403);
    expect((await purchasing.send('PUT', `/api/documents/${docs['SCS-001']!.documentId}/classification`, { classification: 'MASTER_AGREEMENT' })).status).toBe(403);
    const signedLink = (await h.pool.query(`SELECT e.id FROM evidence_link e JOIN supplier_agreement a ON a.executed_file_id = e.file_id AND a.id = e.entity_id WHERE a.id = $1`, [id])).rows[0].id;
    expect((await purchasing.send('DELETE', `/api/evidence/links/${signedLink}`)).status).toBe(409);
    await expect(h.pool.query(`UPDATE supplier_agreement SET title = 'x' WHERE id = $1`, [id])).rejects.toThrow(/immutable/);
    await expect(h.pool.query(`UPDATE supplier_agreement SET supplier_id = (SELECT id FROM supplier WHERE code = 'NWR') WHERE id = $1`, [id])).rejects.toThrow(/immutable/);
    await expect(h.pool.query(`DELETE FROM supplier_agreement WHERE id = $1`, [id])).rejects.toThrow(/cannot be deleted/);
    await expect(h.pool.query(`UPDATE supplier_agreement_signature SET signer_name = 'x' WHERE agreement_id = $1`, [id])).rejects.toThrow(/immutable/);
    await expect(h.pool.query(`UPDATE supplier_agreement_document SET revision_label = 'Z' WHERE agreement_id = $1`, [id])).rejects.toThrow(/frozen/);
    await expect(h.pool.query(`UPDATE controlled_document_revision SET sha256 = 'x' WHERE id = $1`, [docs['SCS-001']!.revisionId])).rejects.toThrow();
    const superseded = sec.historical.find((x: Json) => x.state === 'SUPERSEDED');
    await expect(h.pool.query(`UPDATE supplier_agreement SET status = 'EXECUTED' WHERE id = $1`, [superseded.id])).rejects.toThrow(/cannot change/);
    // Approval independence (POL-01): a preparer who also holds supplier.qualify cannot approve their own draft.
    await h.pool.query(`INSERT INTO authority_grant (user_id, capability_code, reason, granted_by) VALUES ($1, 'supplier.manage', 'Fictional test grant', $1)`, [h.ids.users.quality]);
    const own = ok(await quality.send('POST', `/api/suppliers/${gff.supplierId}/agreements`, { title: 'Self-approval attempt', siteIds: [gff.siteId] }), 201);
    let d = await lines(own.id);
    ok(await quality.send('PUT', `/api/agreements/${own.id}/documents`, { version: d.agreement.version, lines: [{ role: 'MASTER_AGREEMENT', documentRevisionId: docs['MSA-001']!.revisionId, contractualRef: 'Agreement' }] }));
    d = await lines(own.id);
    ok(await quality.send('POST', `/api/agreements/${own.id}/submit`, { version: d.agreement.version }));
    d = ok(await quality.get(`/api/agreements/${own.id}`));
    expect(d.permissions.approveBlockedReason).toMatch(/POL-01/);
    expect((await quality.send('POST', `/api/agreements/${own.id}/approve`, { version: d.agreement.version, legalReviewer: 'x y', legalReference: 'ref', legalReviewedOn: today })).status).toBe(403);
    const denied = (await h.pool.query(`SELECT 1 FROM audit_event WHERE action = 'agreement.approve' AND outcome = 'DENIED' AND entity_id = $1`, [own.id])).rowCount;
    expect(denied).toBe(1);
  });

  it('flags precedence conflicts and requires a recorded resolution before approval', async () => {
    const a = ok(await purchasing.send('POST', `/api/suppliers/${gff.supplierId}/agreements`, { title: 'Conflict check', siteIds: [gff.siteId] }), 201);
    let d = await lines(a.id);
    const put = ok(
      await purchasing.send('PUT', `/api/agreements/${a.id}/documents`, {
        version: d.agreement.version,
        lines: [
          { role: 'MASTER_AGREEMENT', documentRevisionId: docs['MSA-001']!.revisionId, contractualRef: 'Agreement' },
          { role: 'SPECIFICATION', documentRevisionId: docs['SCS-001-1.1']!.revisionId, contractualRef: 'Schedule B1', precedence: 20 },
          { role: 'QUALITY_AGREEMENT', documentRevisionId: (await h.pool.query(`SELECT r.id FROM controlled_document_revision r JOIN controlled_document d ON d.id = r.document_id WHERE d.number = 'SUP-03'`)).rows[0].id, contractualRef: 'Schedule A' },
        ],
      }),
    );
    expect(put.conflicts.map((c: Json) => c.kind)).toEqual(['PRECEDENCE']);
    d = await lines(a.id);
    ok(await purchasing.send('POST', `/api/agreements/${a.id}/submit`, { version: d.agreement.version }));
    d = await lines(a.id);
    const r = await manager.send('POST', `/api/agreements/${a.id}/approve`, { version: d.agreement.version, legalReviewer: 'Counsel (fictional)', legalReference: 'LR-2', legalReviewedOn: today });
    expect(r.status).toBe(422);
    expect(r.json.error.message).toMatch(/precedence conflict/);
    ok(await manager.send('POST', `/api/agreements/${a.id}/return`, { reason: 'Fix precedence (fictional)' }));
    d = await lines(a.id);
    expect(d.agreement).toMatchObject({ status: 'DRAFT', cycle: 2 });
    ok(await purchasing.send('POST', `/api/agreements/${a.id}/cancel`, { reason: 'Conflict scenario complete (fictional)' }));
  });
});
