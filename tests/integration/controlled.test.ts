import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateOutput } from '../../src/server/controlled/validate.js';
import { CONTROLLED_TYPES, EVIDENCE_SCHEDULE, continuationNumber, fieldPrefix } from '../../src/shared/controlled-forms.js';
import { DOCUMENT_TYPES } from '../../src/shared/documents.js';
import { makePdf } from '../fixtures/documents.js';
import { buildStandIn, revisedSchema, standInFiles, templateFixture } from '../fixtures/controlled-templates.js';
import { makePng } from '../fixtures/images.js';
import { type Harness, type Session, formRevisionId, passAll, save, startHarness, version } from './harness.js';

/**
 * Controlled documents drive the work: the released PDF revision defines the data-entry screen,
 * records bind to the revision in force when opened, and the generated output is that revision
 * filled in (plus continuation sheets), validated against the template.
 */
let h: Harness;
let admin: Session;
let inspector: Session;
let quality: Session;
let engineering: Session;
let manager: Session;
let purchasing: Session;
const OUT = path.resolve(import.meta.dirname, '../../var/report-samples');
let today: string;
let yesterday: string;

const ok = (r: { status: number; json: unknown }, status = 200) => {
  expect(r.status, JSON.stringify(r.json)).toBe(status);
  return r.json as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
};

async function importFiles(files: Array<{ name: string; bytes: Buffer }>, effectiveFrom: string) {
  for (const f of files) {
    const r = await admin.upload(`/api/documents/import?effectiveFrom=${effectiveFrom}`, f.bytes, f.name, 'application/pdf');
    expect([200, 201], `${f.name}: ${JSON.stringify(r.json)}`).toContain(r.status);
  }
}

beforeAll(async () => {
  h = await startHarness();
  [admin, inspector, quality, engineering, manager, purchasing] = await Promise.all([h.login('admin'), h.login('inspector'), h.login('quality'), h.login('engineering'), h.login('manager'), h.login('purchasing')]);
  mkdirSync(OUT, { recursive: true });
  today = (await h.pool.query(`SELECT (now() AT TIME ZONE $1)::date AS d`, [h.svc.config.displayTimeZone])).rows[0].d;
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  yesterday = d.toISOString().slice(0, 10);
  await importFiles(await standInFiles(['OPS-06', 'SUP-03']), yesterday);
});
afterAll(async () => h?.close());

describe('the 37 registered document types', () => {
  it('each type is mapped to one module and handled as an in-app form (A) or a signed attachment (B)', () => {
    expect(CONTROLLED_TYPES.map((t) => t.code).sort()).toEqual(Object.keys(DOCUMENT_TYPES).sort());
    expect(CONTROLLED_TYPES).toHaveLength(37);
    const counts = { FORM: 0, ATTACHMENT: 0 };
    for (const t of CONTROLLED_TYPES) {
      counts[t.category] += 1;
      expect(t.authors.length, t.code).toBeGreaterThan(0);
      expect(t.module, t.code).toBeTruthy();
      if (t.category === 'FORM') expect(t.steps.length, t.code).toBeGreaterThan(0);
      else expect(t.signatures.length, t.code).toBeGreaterThan(0);
    }
    expect(counts).toEqual({ FORM: 28, ATTACHMENT: 9 });
    const families = new Set(CONTROLLED_TYPES.map((t) => t.family));
    for (const f of ['Sourcing', 'Supplier', 'Engineering', 'Inspection', 'FAI', 'Concession', 'Nonconformance', 'Corrective action']) expect(families, f).toContain(f);
  });

  it('every type matches its approved template: field prefix, approval blocks, and a released continuation for every schedule', () => {
    const fixture = templateFixture();
    const byNumber = new Map(fixture.map((e) => [e.number, e]));
    for (const t of CONTROLLED_TYPES) {
      const base = byNumber.get(t.code);
      expect(base, `${t.code} approved template`).toBeTruthy();
      expect(base!.schema.prefix).toBe(fieldPrefix(t.code));
      expect(base!.source).toBe('APPROVED_PDF');
      expect(base!.schema.footer[0], t.code).toMatch(new RegExp(`^${t.code} \\| Rev 0\\.3 \\| Effective: pending \\| Owner: `));
      for (const s of t.steps) {
        expect(base!.schema.fields.find((f) => f.key === s.field)?.role, `${t.code} ${s.field}`).toBe('SIGNATURE');
        expect(base!.schema.fields.find((f) => f.key === s.dateField)?.role, `${t.code} ${s.dateField}`).toBe('SIGNATURE');
      }
      for (const s of base!.schema.schedules) {
        const cont = byNumber.get(continuationNumber(t.code, s.key));
        expect(cont, `${t.code} ${s.key} continuation`).toBeTruthy();
        const contSched = cont!.schema.schedules.find((x) => x.key === s.key)!;
        // A checklist continues with one extra column naming the added row; otherwise columns match.
        const extra = contSched.columns.filter((c) => !s.columns.some((b) => b.key === c.key)).map((c) => c.key);
        if (s.key === EVIDENCE_SCHEDULE) expect(extra).toEqual(['association', 'added_by']);
        else expect(extra.length, `${t.code} ${s.key}`).toBe(s.rowLabels ? 1 : 0);
      }
    }
  });
});

describe('templates drive the data-entry definition', () => {
  it('importing a controlled form derives its fields, sections, schedules and document control from the PDF', async () => {
    const list = ok(await quality.get('/api/documents'));
    const doc = list.documents.find((d: { number: string }) => d.number === 'OPS-06');
    expect(doc.controlled).toMatchObject({ category: 'FORM', module: 'Nonconformance reports', entity: 'NCR' });
    const detail = ok(await quality.get(`/api/documents/${doc.id}`));
    expect(detail.template).toMatchObject({
      revisionLabel: '03',
      interactive: true,
      title: 'Nonconformance Report',
      controlLine: 'OPS-06 | REV 0.3 | DRAFT - REVIEW ONLY',
      footer: ['OPS-06 | Rev 0.3 | Effective: pending | Owner: Quality', 'DRAFT - NOT RELEASED | Uncontrolled when printed | PDI master record governs'],
      pages: 4,
    });
    expect(detail.template.schedules).toEqual([
      { key: 'containment', title: '02 Stock containment and disposition ledger', capacity: 6, printedRows: 0, columns: 7 },
      { key: 'evidence', title: 'Supporting evidence and continuation index', capacity: 2, printedRows: 0, columns: 5 },
    ]);
    const types = ok(await quality.get('/api/controlled/types'));
    expect(types.types.find((t: { code: string }) => t.code === 'OPS-06')).toMatchObject({ category: 'FORM', interactive: true, revision: { revisionLabel: '03' } });
    expect(types.types.find((t: { code: string }) => t.code === 'VAL-02').revision).toBeNull();
  });

  it('a PDF without fields imports as a reference and cannot drive a form', async () => {
    await importFiles([{ name: 'OPS-09_Supplier_Performance_Scorecard_Rev03.pdf', bytes: await makePdf('scorecard scan') }], yesterday);
    const types = ok(await purchasing.get('/api/controlled/types'));
    expect(types.types.find((t: { code: string }) => t.code === 'OPS-09')).toMatchObject({ interactive: false });
    const supplierId = (await h.pool.query(`SELECT id FROM supplier WHERE code = 'NWR'`)).rows[0].id;
    const r = await purchasing.send('POST', '/api/controlled/records', { typeCode: 'OPS-09', entityId: supplierId });
    expect(r.status).toBe(409);
    expect(r.json.error.message).toMatch(/has no fillable fields/);
  });
});

/** Inspection → concern → NCR with one material scope, as quality does in the NCR module. */
async function makeNcr(lot: string): Promise<{ ncrId: string; ncrNumber: string }> {
  const partId = (await h.pool.query(`SELECT id FROM company_part WHERE part_number = 'TQ-PRK-3003'`)).rows[0].id;
  const insp = ok(
    await inspector.send('POST', '/api/inspections', { partId, formRevisionId: await formRevisionId(inspector, 'PDI-IQI-004'), unitCount: 2, poNumber: 'PO-55120', dateReceived: today, sourceId: h.ids.sources.ringNwr1, lotNumber: lot }),
    201,
  );
  await passAll(inspector, insp.id, 0, 'A');
  for (const u of [1, 2]) {
    await passAll(inspector, insp.id, u, 'B');
    ok(await save(inspector, insp.id, Object.entries({ free_end_gap_relaxed: '10.05', installed_end_gap: '0.52', axial_width_ring_height: '2.980', radial_wall_thickness: '4.20' }).map(([rowKey, a1]) => ({ unitIndex: u, sectionKey: 'C', rowKey, status: 'P', readings: { a1 } })), [{ unitIndex: u, serialNumber: `${lot}-${u}` }]));
  }
  ok(await save(inspector, insp.id, [{ unitIndex: 2, sectionKey: 'B', rowKey: 'running_face_coating', status: 'F', note: 'Running face uncoated' }]));
  ok(await inspector.upload(`/api/inspections/${insp.id}/photos?unitIndex=2&sectionKey=B&rowKey=running_face_coating`, makePng(90, 60, [140, 40, 40]), 'coating.png', 'image/png'), 201);
  ok(await inspector.send('POST', `/api/inspections/${insp.id}/complete`, { expectedVersion: await version(inspector, insp.id) }));
  const ev = ok(await inspector.send('POST', `/api/inspections/${insp.id}/concerns`, { unitIndex: 2, sectionKey: 'B', rowKey: 'running_face_coating', ownerId: h.ids.users.quality }), 201);
  ok(await quality.send('POST', `/api/quality/events/${ev.id}/triage`, { expectedVersion: 1, decision: 'TRIAGED', ownerId: h.ids.users.quality, severity: 'HIGH' }));
  const ncr = ok(await manager.send('POST', `/api/quality/events/${ev.id}/confirm-ncr`, { expectedVersion: 2, severity: 'HIGH', ownerId: h.ids.users.quality, failureMode: 'Missing coating', rationale: 'Coating absent on item 2 (fictional)' }), 201);
  ok(
    await quality.send('POST', `/api/ncrs/${ncr.id}/scopes`, { label: 'Ring kits on shelf R-7', lotNumber: lot, poNumber: 'PO-55120', inspectionId: insp.id, quantity: 2, serialNumbers: [`${lot}-1`, `${lot}-2`], location: 'Receiving shelf R-7', containmentAction: 'Red tag, quarantine cage Q-2' }),
    201,
  );
  return { ncrId: ncr.id, ncrNumber: ncr.number };
}

async function fillRequired(s: Session, id: string, extra: (rec: Record<string, any>) => void = () => undefined) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const rec = ok(await s.get(`/api/controlled/records/${id}`));
  const data = structuredClone(rec.data);
  for (const f of rec.schema.fields) {
    if (f.role !== 'ENTRY' || f.requirement !== 'REQUIRED' || data.fields[f.key]) continue;
    data.fields[f.key] = f.input === 'choice' ? f.options[0] : f.input === 'date' ? today : `NA - fictional test entry for ${f.label}`.slice(0, f.maxLength ?? 60);
  }
  extra(data);
  return ok(await s.send('PATCH', `/api/controlled/records/${id}`, { expectedVersion: rec.version, data }));
}

async function outputText(recordId: string, sample: string) {
  await h.svc.worker!.drain();
  const r = (await h.pool.query(`SELECT r.file_id, r.sha256, v.ok, v.result FROM report_rendition r JOIN controlled_output_validation v ON v.rendition_id = r.id WHERE r.subject_type = 'CONTROLLED_RECORD' AND r.subject_id = $1`, [recordId])).rows[0];
  expect(r, 'controlled output rendered').toBeTruthy();
  const file = await quality.get(`/api/files/${r.file_id}`);
  expect(file.status).toBe(200);
  const out = path.join(OUT, sample);
  writeFileSync(out, file.raw);
  return { text: execFileSync('pdftotext', ['-layout', out, '-']).toString(), pages: Number(/Pages:\s+(\d+)/.exec(execFileSync('pdfinfo', [out]).toString())![1]), row: r, bytes: file.raw };
}

describe('OPS-06 from an NCR: one workflow across the base form and its continuation sheets', () => {
  let ncr: { ncrId: string; ncrNumber: string };
  let recordId: string;
  let number: string;

  it('quality opens OPS-06 from the NCR, bound to the revisions in force, prefilled from the NCR', async () => {
    ncr = await makeNcr('LOT-CF1');
    // An inspector cannot prepare an NCR record (ncr.manage); the refusal is audited.
    expect((await inspector.send('POST', '/api/controlled/records', { typeCode: 'OPS-06', entityId: ncr.ncrId })).status).toBe(403);
    const created = ok(await quality.send('POST', '/api/controlled/records', { typeCode: 'OPS-06', entityId: ncr.ncrId }), 201);
    recordId = created.id;
    number = created.number;
    expect(number).toMatch(/^OPS-06-\d{4}-\d{5}$/);
    const rec = ok(await quality.get(`/api/controlled/records/${recordId}`));
    expect(rec).toMatchObject({ status: 'DRAFT', category: 'FORM', entity: { type: 'NCR', id: ncr.ncrId, route: `/quality/ncrs/${ncr.ncrId}` } });
    expect(rec.bindings.map((b: { role: string; documentNumber: string; revisionLabel: string }) => `${b.role} ${b.documentNumber} ${b.revisionLabel}`)).toEqual([
      'BASE OPS-06 03',
      'CONTINUATION OPS-06/containment 03',
      'NARRATIVE PDI-Narrative-Continuation 03',
      'EVIDENCE PDI-Evidence-Continuation 03',
    ]);
    expect(rec.data.fields).toMatchObject({ supplier_id: 'NWR', pdi_part: 'TQ-PRK-3003', project_ref: ncr.ncrNumber, defect_class: 'Major', detection_point: 'Receiving', population: '2' });
    expect(rec.data.schedules.containment).toEqual([expect.objectContaining({ lot: 'LOT-CF1 / LOT-CF1-1, LOT-CF1-2', quantity: '2', hold: 'Ring kits on shelf R-7', disposition: 'Pending', location: 'Receiving shelf R-7' })]);
    expect(rec.continuations.containment).toEqual({ capacity: 5, labelColumn: null, documentNumber: 'OPS-06/containment', revisionLabel: '03' });
    expect(rec.steps.map((s: { key: string; label: string; optional: boolean }) => `${s.key} ${s.label} ${s.optional}`)).toEqual([
      'approver1 Quality / material review authority approver false',
      'approver2 Engineering when required approver true',
    ]);
    expect(rec.problems.length).toBeGreaterThan(5);
  });

  it('submission is refused until every required entry is answered; rows beyond the sheet continue', async () => {
    const early = await quality.send('POST', `/api/controlled/records/${recordId}/submit`, { expectedVersion: ok(await quality.get(`/api/controlled/records/${recordId}`)).version });
    expect(early.status).toBe(422);
    expect(early.json.error.details.map((p: { path: string }) => p.path)).toContain('fields.containment_control');

    const bad = await quality.send('PATCH', `/api/controlled/records/${recordId}`, { expectedVersion: ok(await quality.get(`/api/controlled/records/${recordId}`)).version, data: { fields: { defect_class: 'Catastrophic', detected_date: '2026-02-30' }, schedules: {} } });
    expect(bad.status).toBe(422);
    const messages = bad.json.error.details.map((p: { message: string }) => p.message).join(' ');
    expect(messages).toMatch(/Defect class: choose one of Critical, Major, Minor, Unclassified/);
    expect(messages).toMatch(/Detection date: use a real date/);

    const longProblem = `${'Running face coating absent on serial LOT-CF1-2; base metal visible across the full face. '.repeat(9)}End of description.`;
    expect(longProblem.length).toBeGreaterThan(612);
    await fillRequired(quality, recordId, (data) => {
      data.fields.problem = longProblem;
      data.schedules.containment = [
        ...data.schedules.containment.map((r: Record<string, string>) => ({ ...r, disposition: 'Return', authority: 'MRB-11', verification: 'RMA pending' })),
        ...Array.from({ length: 12 }, (_, i) => ({ location: `Field return bin ${i + 1}`, lot: `LOT-CF1-F${i + 1}`, quantity: '1', hold: `HOLD-F${i + 1}`, disposition: 'Scrap', authority: 'MRB-11', verification: 'Scrap ticket' })),
      ];
      data.schedules.evidence = [{ evidence_id: 'R01', file_ref: 'Supplier 8D draft (email 2026-11-02)', caption: 'Supplier containment statement', date: today, uploaded_by: 'Casey Morgan' }];
    });
    ok(await quality.upload(`/api/controlled/records/${recordId}/attachments?caption=${encodeURIComponent('Uncoated running face, item 2')}`, makePng(80, 60, [150, 40, 40]), 'coating.png', 'image/png'), 201);
    const rec = ok(await quality.get(`/api/controlled/records/${recordId}`));
    expect(rec.problems).toEqual([]);
    expect(rec.composed.schedules.evidence[0]).toMatchObject({ evidence_id: 'E01', caption: 'Uncoated running face, item 2', uploaded_by: 'Casey Morgan' });
    ok(await quality.send('POST', `/api/controlled/records/${recordId}/submit`, { expectedVersion: rec.version }));
    // Submitted data is locked, in the API and in the database.
    expect((await quality.send('PATCH', `/api/controlled/records/${recordId}`, { expectedVersion: rec.version + 1, data: rec.data })).status).toBe(409);
    await expect(h.pool.query(`UPDATE controlled_record SET data = '{}'::jsonb WHERE id = $1`, [recordId])).rejects.toThrow(/submitted for approval/);
  });

  it('approval is independent and on the template’s own approval block; completion generates the validated output', async () => {
    const rec = ok(await quality.get(`/api/controlled/records/${recordId}`));
    // The preparer cannot approve; engineering (the optional second approver) cannot sign before the deciding approval.
    expect((await quality.send('POST', `/api/controlled/records/${recordId}/sign`, { expectedVersion: rec.version, step: 'approver1', decision: 'Close', conditions: 'x' })).status).toBe(403);
    expect((await engineering.send('POST', `/api/controlled/records/${recordId}/sign`, { expectedVersion: rec.version, step: 'approver2' })).status).toBe(409);
    const wrong = await manager.send('POST', `/api/controlled/records/${recordId}/sign`, { expectedVersion: rec.version, step: 'approver1', decision: 'Return', conditions: 'x' });
    expect(wrong.status).toBe(422);
    const signed = ok(
      await manager.send('POST', `/api/controlled/records/${recordId}/sign`, {
        expectedVersion: rec.version,
        step: 'approver1',
        decision: 'Authorize disposition',
        conditions: 'Return lot LOT-CF1 to supplier; scrap field returns; SCAR to follow (fictional)',
        secondApproval: 'NOT_REQUIRED',
      }),
    );
    expect(signed.completed).toBe(true);
    const out = await outputText(recordId, 'controlled-ops-06.pdf');
    expect(out.row.ok).toBe(true);
    expect(out.row.result.checks.map((c: { name: string; ok: boolean }) => `${c.name} ${c.ok}`)).toEqual(['page count true', 'page size true', 'template layout true', 'document control true', 'entered values true', 'references true', 'flattened true']);
    // Base form (4) + 2 containment sheets (13 rows: 6 on the form, 7 continue 5 per sheet) + 1 narrative sheet
    // + 1 evidence sheet (photo, manual reference and the 3 continuation sheets: 2 on the form, 3 continue).
    expect(out.pages).toBe(4 + 2 + 1 + 1);
    expect(out.row.result.templates.map((t: { documentNumber: string; revisionLabel: string; pages: number }) => `${t.documentNumber} ${t.revisionLabel} ${t.pages}`)).toEqual([
      'OPS-06 03 4',
      'OPS-06/containment 03 2',
      'PDI-Narrative-Continuation 03 1',
      'PDI-Evidence-Continuation 03 1',
    ]);
    const text = out.text.replace(/\s+/g, ' ');
    for (const expected of [
      number,
      'OPS-06 | Rev 0.3 | Effective: pending | Owner: Quality',
      'PDI-NARR | Rev 0.3 | Effective: pending | Owner: Quality Systems',
      'PDI-EVID | Rev 0.3 | Effective: pending | Owner: Quality Systems',
      `${number}-C01`,
      `${number}-C02`,
      `${number}-N01`,
      `${number}-E01`,
      '2 of 2',
      'Riley Chen',
      'NA - not required',
      'Authorize disposition',
      'Field return bin 12',
      'End of description.',
    ]) {
      expect(text, expected).toContain(expected);
    }
    expect(execFileSync('pdfinfo', [path.join(OUT, 'controlled-ops-06.pdf')]).toString()).toMatch(/Form:\s+none/);
    // Completed records are frozen in the database.
    await expect(h.pool.query(`UPDATE controlled_record SET title = 'x' WHERE id = $1`, [recordId])).rejects.toThrow(/completed and cannot change/);
    await expect(h.pool.query(`UPDATE controlled_record_binding SET revision_id = revision_id WHERE record_id = $1`, [recordId])).rejects.toThrow(/immutable/);
  });

  it('a later revision binds new records only; existing records and their PDFs keep the revision they were opened on', async () => {
    const before = (await h.pool.query(`SELECT file_id, sha256 FROM report_rendition WHERE subject_id = $1`, [recordId])).rows;
    const draft = ok(await quality.send('POST', '/api/controlled/records', { typeCode: 'OPS-06', entityId: ncr.ncrId }), 201);

    // OPS-06 Rev 04 is released, effective today.
    const fixture = templateFixture().find((e) => e.number === 'OPS-06')!;
    const rev04 = await buildStandIn(revisedSchema(fixture.schema, '0.3', '0.4'));
    const docId = (await h.pool.query(`SELECT id FROM controlled_document WHERE number = 'OPS-06'`)).rows[0].id;
    ok(await admin.upload(`/api/documents/${docId}/revisions?revisionLabel=04&effectiveFrom=${today}&changeSummary=${encodeURIComponent('Fictional Rev 04 for binding test')}`, rev04, 'OPS-06_Nonconformance_Report_Rev04.pdf', 'application/pdf'), 201);

    const fresh = ok(await quality.send('POST', '/api/controlled/records', { typeCode: 'OPS-06', entityId: ncr.ncrId }), 201);
    const freshRec = ok(await quality.get(`/api/controlled/records/${fresh.id}`));
    expect(freshRec.bindings[0]).toMatchObject({ role: 'BASE', revisionLabel: '04' });
    const draftRec = ok(await quality.get(`/api/controlled/records/${draft.id}`));
    expect(draftRec.bindings[0]).toMatchObject({ role: 'BASE', revisionLabel: '03' });

    // The draft opened under Rev 03 completes on Rev 03; the new record completes on Rev 04.
    for (const [id, label, footer] of [
      [draft.id, '03', 'OPS-06 | Rev 0.3 | Effective'],
      [fresh.id, '04', 'OPS-06 | Rev 0.4 | Effective'],
    ] as const) {
      await fillRequired(quality, id);
      ok(await quality.send('POST', `/api/controlled/records/${id}/submit`, { expectedVersion: ok(await quality.get(`/api/controlled/records/${id}`)).version }));
      ok(await manager.send('POST', `/api/controlled/records/${id}/sign`, { expectedVersion: ok(await quality.get(`/api/controlled/records/${id}`)).version, step: 'approver1', decision: 'Hold', conditions: 'Hold pending engineering review (fictional)', secondApproval: 'REQUIRED' }));
      ok(await engineering.send('POST', `/api/controlled/records/${id}/sign`, { expectedVersion: ok(await quality.get(`/api/controlled/records/${id}`)).version, step: 'approver2' }));
      const out = await outputText(id, `controlled-ops-06-rev${label}.pdf`);
      expect(out.row.result.templates[0]).toMatchObject({ documentNumber: 'OPS-06', revisionLabel: label });
      expect(out.text.replace(/\s+/g, ' ')).toContain(footer);
      expect(out.text).toContain('Taylor Brooks');
    }
    // The first record's PDF is untouched.
    expect((await h.pool.query(`SELECT file_id, sha256 FROM report_rendition WHERE subject_id = $1`, [recordId])).rows).toEqual(before);

    // The validator refuses an output checked against the wrong revision.
    const rev04Out = (await h.pool.query(`SELECT r.file_id, v.result FROM report_rendition r JOIN controlled_output_validation v ON v.rendition_id = r.id WHERE r.subject_id = $1`, [fresh.id])).rows[0];
    const bytes = (await quality.get(`/api/files/${rev04Out.file_id}`)).raw;
    const plan = rev04Out.result.pages.map((p: { revisionId: string }) => ({ ...p, revisionId: p.revisionId }));
    const rev03Schema = (await h.pool.query(`SELECT t.schema FROM controlled_template t JOIN controlled_document_revision r ON r.id = t.revision_id JOIN controlled_document d ON d.id = r.document_id WHERE d.number = 'OPS-06' AND r.revision_label = '03'`)).rows[0].schema;
    const schemas = new Map<string, any>(); // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const p of plan) schemas.set(p.revisionId, p.documentNumber === 'OPS-06' ? rev03Schema : (await h.pool.query(`SELECT schema FROM controlled_template WHERE revision_id = $1`, [p.revisionId])).rows[0].schema);
    const check = await validateOutput(bytes, plan, [], schemas);
    expect(check.ok).toBe(false);
    expect(check.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(['template layout', 'document control']);
  });

  it('a returned record starts a new approval cycle; earlier signatures stay on record', async () => {
    const created = ok(await quality.send('POST', '/api/controlled/records', { typeCode: 'OPS-06', entityId: ncr.ncrId }), 201);
    await fillRequired(quality, created.id);
    ok(await quality.send('POST', `/api/controlled/records/${created.id}/submit`, { expectedVersion: ok(await quality.get(`/api/controlled/records/${created.id}`)).version }));
    ok(await manager.send('POST', `/api/controlled/records/${created.id}/sign`, { expectedVersion: ok(await quality.get(`/api/controlled/records/${created.id}`)).version, step: 'approver1', decision: 'Hold', conditions: 'Hold (fictional)', secondApproval: 'REQUIRED' }));
    ok(await engineering.send('POST', `/api/controlled/records/${created.id}/return`, { expectedVersion: ok(await quality.get(`/api/controlled/records/${created.id}`)).version, reason: 'Repair instructions missing (fictional)' }));
    const rec = ok(await quality.get(`/api/controlled/records/${created.id}`));
    expect(rec).toMatchObject({ status: 'DRAFT', cycle: 2 });
    expect(rec.steps.every((s: { signature: unknown }) => s.signature === null)).toBe(true);
    expect(rec.history).toEqual([expect.objectContaining({ role_key: 'approver1', signer_name: 'Riley Chen', cycle: 1 })]);
  });
});

describe('category B: an executed agreement is attached and completes with its required signatures', () => {
  it('SUP-03 binds the template revision, checks the attachment against it and records internal and external signatures', async () => {
    const supplierId = (await h.pool.query(`SELECT id FROM supplier WHERE code = 'NWR'`)).rows[0].id;
    const created = ok(await purchasing.send('POST', '/api/controlled/records', { typeCode: 'SUP-03', entityId: supplierId }), 201);
    const id = created.id;
    let rec = ok(await purchasing.get(`/api/controlled/records/${id}`));
    expect(rec).toMatchObject({ category: 'ATTACHMENT', status: 'DRAFT' });
    expect(rec.bindings).toEqual([expect.objectContaining({ role: 'BASE', documentNumber: 'SUP-03', revisionLabel: '03' })]);
    expect((await purchasing.send('POST', `/api/controlled/records/${id}/submit`, { expectedVersion: rec.version })).status).toBe(422);

    const scan = ok(await purchasing.upload(`/api/controlled/records/${id}/attachments`, await makePdf('Executed SQA scan'), 'SQA-NWR-signed.pdf', 'application/pdf'), 201);
    expect(scan.conformance).toEqual({ conforms: false, detail: 'Not on the controlled template (executed or external format)' });
    const sup03 = templateFixture().find((e) => e.number === 'SUP-03')!;
    const filled = ok(await purchasing.upload(`/api/controlled/records/${id}/attachments`, await buildStandIn(sup03.schema), 'SUP-03_completed.pdf', 'application/pdf'), 201);
    expect(filled.conformance.conforms).toBe(true);
    rec = ok(await purchasing.get(`/api/controlled/records/${id}`));
    ok(await purchasing.send('POST', `/api/controlled/records/${id}/submit`, { expectedVersion: rec.version }));
    rec = ok(await purchasing.get(`/api/controlled/records/${id}`));
    expect(rec.can.attest).toEqual(['legal', 'pdi_signatory', 'supplier_signatory']);
    for (const [role, name] of [['legal', 'Counsel ref LGL-2026-118'], ['pdi_signatory', 'Dana Whitfield, VP Operations'], ['supplier_signatory', 'R. Okoye, Quality Director']]) {
      rec = ok(await purchasing.get(`/api/controlled/records/${id}`));
      ok(await purchasing.send('POST', `/api/controlled/records/${id}/attest`, { expectedVersion: rec.version, role, signerName: name, signedOn: yesterday, reference: 'Executed copy attached' }));
    }
    rec = ok(await purchasing.get(`/api/controlled/records/${id}`));
    expect(rec.status).toBe('SUBMITTED');
    // The quality approval is an in-app signature by someone with supplier qualification authority.
    expect((await purchasing.send('POST', `/api/controlled/records/${id}/sign`, { expectedVersion: rec.version, step: 'quality' })).status).toBe(403);
    ok(await quality.send('POST', `/api/controlled/records/${id}/sign`, { expectedVersion: rec.version, step: 'quality', statement: 'Agreement terms reviewed (fictional)' }));
    rec = ok(await purchasing.get(`/api/controlled/records/${id}`));
    expect(rec.status).toBe('COMPLETED');
    expect(rec.steps.map((s: { key: string; signature: { mode: string; signer_name: string } }) => `${s.key}:${s.signature.mode}:${s.signature.signer_name}`)).toEqual([
      'legal:EXTERNAL:Counsel ref LGL-2026-118',
      'pdi_signatory:EXTERNAL:Dana Whitfield, VP Operations',
      'supplier_signatory:EXTERNAL:R. Okoye, Quality Director',
      'quality:INTERNAL:Casey Morgan',
    ]);
    expect(rec.outputs).toEqual([]);
    expect((await purchasing.send('DELETE', `/api/controlled/records/${id}/attachments/${scan.linkId}`)).status).toBe(409);
  });
});
