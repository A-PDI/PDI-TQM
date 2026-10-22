import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FILENAME_RULE, parseDocumentFilename } from '../../src/shared/documents.js';
import { MALICIOUS_PDF, makePdf } from '../fixtures/documents.js';
import { makePng } from '../fixtures/images.js';
import { type Harness, type Session, startHarness } from './harness.js';

/** Controlled document library (FR-008, FR-090, FR-091): owner-named PDFs, effective-dated immutable revisions. */
let h: Harness;
let admin: Session;
let quality: Session;
let inspector: Session;
let day: (offset: number) => string;

beforeAll(async () => {
  h = await startHarness();
  [admin, quality, inspector] = await Promise.all([h.login('admin'), h.login('quality'), h.login('inspector')]);
  const today = (await h.pool.query(`SELECT (now() AT TIME ZONE $1)::date AS d`, [h.svc.config.displayTimeZone])).rows[0].d as string;
  day = (offset: number) => {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + offset);
    return d.toISOString().slice(0, 10);
  };
});
afterAll(async () => h?.close());

const importDoc = (who: Session, name: string, bytes: Buffer, effectiveFrom: string) =>
  who.upload(`/api/documents/import?effectiveFrom=${effectiveFrom}`, bytes, name, 'application/pdf');

describe('file naming convention', () => {
  it('reads form, continuation sheet and library document identity from the owner file names', () => {
    expect(parseDocumentFilename('OPS-06_Nonconformance_Report_Rev03.pdf')).toEqual({
      number: 'OPS-06', typeCode: 'OPS-06', family: 'OPS', kind: 'FORM', title: 'Nonconformance Report (NCR)', revisionLabel: '03',
    });
    expect(parseDocumentFilename('OPS-07_verified_causes_Continuation_Rev03.pdf')).toMatchObject({
      number: 'OPS-07/verified-causes', typeCode: 'OPS-07', kind: 'CONTINUATION', title: 'Continuation sheet — Verified Causes',
    });
    expect(parseDocumentFilename('PRS-001_Product_Requirements_Specification_Rev03.pdf')).toMatchObject({ number: 'PRS-001', family: 'PRS', title: 'Product Requirements Specification' });
    expect(parseDocumentFilename('PDI_Master_Form_Standard_Rev03.pdf')).toMatchObject({ number: 'PDI-Master-Form-Standard', typeCode: null, kind: 'LIBRARY', title: 'Master Form Standard' });
    for (const bad of ['Nonconformance Report.pdf', 'OPS-06_Nonconformance_Report.pdf', 'OPS-06_Report_Rev03.docx', 'ops-06_Report_Rev03.pdf']) {
      expect(parseDocumentFilename(bad), bad).toBeNull();
    }
  });
});

describe('import', () => {
  it('an administrator imports forms, continuation sheets and library documents with one effective date', async () => {
    const future = day(10);
    for (const name of ['OPS-06_Nonconformance_Report_Rev03.pdf', 'OPS-06_containment_Continuation_Rev03.pdf', 'PDI_Library_User_Guide_Rev03.pdf']) {
      const res = await importDoc(admin, name, await makePdf(name), future);
      expect(res.status, JSON.stringify(res.json)).toBe(201);
      expect(res.json).toMatchObject({ status: 'CREATED', revisionLabel: '03' });
    }
    const list = await inspector.get('/api/documents');
    expect(list.status).toBe(200);
    const ncr = list.json.documents.find((d: { number: string }) => d.number === 'OPS-06');
    // Not yet effective: no current revision, Rev 03 pending from the chosen date.
    expect(ncr).toMatchObject({ kind: 'FORM', ownerRole: 'administrator', currentRevision: null, pendingRevision: '03', pendingEffective: future });
    expect(ncr.usage).toEqual({ how: 'GENERATED', route: '/quality/ncrs', screen: 'Nonconformance reports' });
    expect(list.json.documents.map((d: { number: string }) => d.number)).toEqual(['OPS-06', 'OPS-06/containment', 'PDI-Library-User-Guide']);

    const detail = await inspector.get(`/api/documents/${ncr.id}`);
    expect(detail.json.related).toEqual([expect.objectContaining({ number: 'OPS-06/containment', kind: 'CONTINUATION' })]);
    expect(detail.json.revisions).toEqual([expect.objectContaining({ revisionLabel: '03', status: 'PENDING', effectiveFrom: future, releasedBy: 'Avery Patel' })]);
    // The original bytes are downloadable by anyone who can read records.
    const original = await makePdf('OPS-06_Nonconformance_Report_Rev03.pdf');
    const file = await inspector.get(`/api/files/${detail.json.revisions[0].fileId}`);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(file.raw.equals(original)).toBe(true);
  });

  it('re-importing the same file changes nothing; different bytes under the same revision are refused', async () => {
    const name = 'OPS-06_Nonconformance_Report_Rev03.pdf';
    const before = (await h.pool.query(`SELECT count(*)::int AS n FROM controlled_document_revision`)).rows[0].n;
    const again = await importDoc(admin, name, await makePdf(name), day(10));
    expect(again.status).toBe(200);
    expect(again.json.status).toBe('UNCHANGED');
    const changed = await importDoc(admin, name, await makePdf('different content'), day(10));
    expect(changed.status).toBe(409);
    expect(changed.json.error.message).toMatch(/already recorded with a different file; issue a new revision/);
    expect((await h.pool.query(`SELECT count(*)::int AS n FROM controlled_document_revision`)).rows[0].n).toBe(before);
  });

  it('refuses badly named files, non-PDF files and PDFs with active content, and records the rejection', async () => {
    const badName = await importDoc(admin, 'Nonconformance Report.pdf', await makePdf('x'), day(10));
    expect(badName.status).toBe(422);
    expect(badName.json.error.message).toContain(FILENAME_RULE);
    const image = await importDoc(admin, 'OPS-05_Temporary_Deviation_Concession_Request_Rev03.pdf', makePng(), day(10));
    expect(image.status).toBe(422);
    expect(image.json.error.message).toMatch(/must be PDF files/);
    const active = await importDoc(admin, 'OPS-05_Temporary_Deviation_Concession_Request_Rev03.pdf', MALICIOUS_PDF, day(10));
    expect(active.status).toBe(422);
    expect(active.json.error.message).toMatch(/active or embedded content/);
    expect((await h.pool.query(`SELECT count(*)::int AS n FROM controlled_document WHERE number = 'OPS-05'`)).rows[0].n).toBe(0);
    expect((await h.pool.query(`SELECT count(*)::int AS n FROM audit_event WHERE action = 'documents.upload' AND outcome = 'FAILED'`)).rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it('only document owners (administrators) can import or revise; the refusal is audited', async () => {
    const res = await importDoc(quality, 'OPS-05_Temporary_Deviation_Concession_Request_Rev03.pdf', await makePdf('x'), day(10));
    expect(res.status).toBe(403);
    const denied = await h.pool.query(`SELECT count(*)::int AS n FROM audit_event WHERE action = 'documents.import' AND outcome = 'DENIED' AND actor_id = $1`, [h.ids.users.quality]);
    expect(denied.rows[0].n).toBe(1);
  });
});

describe('revisions', () => {
  it('the current revision follows the effective dates; earlier ones are superseded, later ones pending', async () => {
    const created = await importDoc(admin, 'VAL-07_Process_Failure_Mode_Effects_Analysis_PFMEA_Rev03.pdf', await makePdf('PFMEA 03'), day(-10));
    expect(created.status).toBe(201);
    const id = created.json.documentId as string;
    const revise = async (label: string, effectiveFrom: string, name = `PFMEA Rev ${label}.pdf`) =>
      admin.upload(`/api/documents/${id}/revisions?revisionLabel=${label}&effectiveFrom=${effectiveFrom}&changeSummary=${encodeURIComponent(`Fictional change for Rev ${label}`)}`, await makePdf(`PFMEA ${label}`), name, 'application/pdf');

    expect((await revise('04', day(-5))).status).toBe(201);
    expect((await revise('05', day(30))).status).toBe(201);
    const earlier = await revise('06', day(20));
    expect(earlier.status).toBe(422);
    expect(earlier.json.error.message).toMatch(/cannot be earlier than Rev 05/);
    const misnamed = await revise('06', day(40), 'VAL-08_Production_Control_Plan_Rev06.pdf');
    expect(misnamed.status).toBe(422);
    expect(misnamed.json.error.message).toMatch(/named for VAL-08, not VAL-07/);
    expect((await revise('05', day(40))).status).toBe(409);

    const detail = (await inspector.get(`/api/documents/${id}`)).json;
    expect(detail.revisions.map((r: { revisionLabel: string; status: string }) => `${r.revisionLabel} ${r.status}`)).toEqual(['05 PENDING', '04 CURRENT', '03 SUPERSEDED']);
    expect(detail.evidenceType).toBe('Process FMEA');
    const listed = (await inspector.get('/api/documents')).json.documents.find((d: { id: string }) => d.id === id);
    expect(listed).toMatchObject({ currentRevision: '04', pendingRevision: '05', revisionCount: 3 });
  });

  it('released revisions and document identity cannot be altered or deleted in the database', async () => {
    const doc = (await h.pool.query(`SELECT id FROM controlled_document WHERE number = 'VAL-07'`)).rows[0];
    await expect(h.pool.query(`UPDATE controlled_document_revision SET effective_from = effective_from - 1 WHERE document_id = $1`, [doc.id])).rejects.toThrow(/immutable/);
    await expect(h.pool.query(`DELETE FROM controlled_document_revision WHERE document_id = $1`, [doc.id])).rejects.toThrow(/immutable/);
    await expect(h.pool.query(`UPDATE controlled_document SET number = 'VAL-99' WHERE id = $1`, [doc.id])).rejects.toThrow(/immutable/);
    await expect(h.pool.query(`DELETE FROM controlled_document WHERE id = $1`, [doc.id])).rejects.toThrow(/cannot be deleted/);
  });
});
