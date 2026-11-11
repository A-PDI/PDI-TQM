import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFRawStream, PDFArray } from 'pdf-lib';
import { type PlannedSheet, type SheetTemplate, planSheets, renderSheets } from '../../src/server/controlled/render.js';
import { deriveTemplate } from '../../src/server/controlled/template.js';
import { contentStreamHashes } from '../../src/server/controlled/pdf-text.js';
import { validateOutput } from '../../src/server/controlled/validate.js';
import { CONTROLLED_TYPES, EVIDENCE_CONTINUATION, NARRATIVE_CONTINUATION, completionProblems, continuationNumber, toWinAnsi } from '../../src/shared/controlled-forms.js';
import { sampleRecord } from '../fixtures/controlled-sample.js';
import { buildStandIn, templateFixture } from '../fixtures/controlled-templates.js';

/**
 * CI coverage for every category-A form: the stand-in of each approved template (same field tree,
 * labels, sections, checklist rows and document control) drives a complete record that overflows
 * every schedule onto its continuation sheet, and the generated PDF validates against the template.
 */
const fixture = templateFixture();
const byNumber = new Map(fixture.map((e) => [e.number, e]));
const sheetCache = new Map<string, SheetTemplate>();

async function sheet(number: string): Promise<SheetTemplate> {
  const cached = sheetCache.get(number);
  if (cached) return cached;
  const e = byNumber.get(number)!;
  const bytes = await buildStandIn(e.schema);
  const t = { documentNumber: number, revisionId: `rev-${number}`, revisionLabel: e.revisionLabel, sha256: createHash('sha256').update(bytes).digest('hex'), bytes, schema: await deriveTemplate(bytes) };
  sheetCache.set(number, t);
  return t;
}

describe('stand-ins reproduce the approved templates', () => {
  it('every approved form and continuation sheet derives to the recorded schema (apart from page-content hashes)', async () => {
    const strip = (s: (typeof fixture)[number]['schema']) => ({ ...s, pages: s.pages.map((p) => ({ ...p, contentSha256: '', streamSha256: [] })) });
    expect(fixture.length).toBe(83);
    for (const e of fixture) {
      const derived = await deriveTemplate(await buildStandIn(e.schema));
      expect(strip(derived), e.number).toEqual(strip(e.schema));
    }
  });
});

describe('every category-A form renders and validates against its template', () => {
  for (const def of CONTROLLED_TYPES.filter((t) => t.category === 'FORM')) {
    it(`${def.code}: base form, continuation sheets, narrative and evidence index`, async () => {
      const base = await sheet(def.code);
      const continuations: Record<string, SheetTemplate> = {};
      for (const s of base.schema.schedules) if (s.key !== 'evidence') continuations[s.key] = await sheet(continuationNumber(def.code, s.key));
      const evidence = await sheet(EVIDENCE_CONTINUATION);
      const narrative = await sheet(NARRATIVE_CONTINUATION);
      const contCap = (key: string) => continuations[key]?.schema.schedules.find((s) => s.key === key)?.capacity ?? 0;
      const number = `${def.code}-2026-00042`;
      const data = sampleRecord(base.schema, contCap, { number, date: '2026-11-10' });
      expect(completionProblems(base.schema, data), def.code).toEqual([]);
      const sheets: PlannedSheet[] = planSheets({ number, recordRevision: '1', title: base.schema.title ?? def.code, base, continuations, evidence, narrative, data, preparedBy: 'Casey Morgan', completedDate: '2026-11-10', generatedAt: new Date('2026-11-10T12:00:00Z') });
      const kinds = sheets.map((s) => s.kind);
      const schedules = base.schema.schedules.filter((s) => s.key !== 'evidence').length;
      expect(kinds.filter((k) => k === 'CONTINUATION').length, def.code).toBe(schedules);
      expect(kinds.filter((k) => k === 'NARRATIVE').length, def.code).toBeGreaterThanOrEqual(base.schema.fields.some((f) => f.role === 'ENTRY' && f.input === 'multiline' && (f.maxLength ?? 0) > 100) ? 1 : 0);
      const out = await renderSheets(sheets, { number, title: base.schema.title ?? def.code, generatedAt: new Date('2026-11-10T12:00:00Z') });
      const schemas = new Map([base, ...Object.values(continuations), evidence, narrative].map((t) => [t.revisionId, t.schema]));
      const v = await validateOutput(out.bytes, out.pages, out.expected, schemas);
      expect(v.checks.filter((c) => !c.ok), def.code).toEqual([]);
      expect(out.pages.length).toBe(base.schema.pages.length + sheets.length - 1 + sheets.filter((s) => s.kind !== 'BASE').reduce((n, s) => n + s.template.schema.pages.length - 1, 0));
    });
  }
});

describe('the validator', () => {
  it('detects a page whose controlled template content was altered', async () => {
    const base = await sheet('OPS-03');
    const number = 'OPS-03-2026-00001';
    const data = sampleRecord(base.schema, () => 0, { number, date: '2026-11-10' });
    data.schedules.change_comparison = data.schedules.change_comparison!.slice(0, 2);
    const sheets = planSheets({ number, recordRevision: '1', title: 'x', base, continuations: {}, evidence: await sheet(EVIDENCE_CONTINUATION), narrative: await sheet(NARRATIVE_CONTINUATION), data, preparedBy: 'A', completedDate: '2026-11-10', generatedAt: new Date('2026-11-10T00:00:00Z') });
    const out = await renderSheets(sheets, { number, title: 'x', generatedAt: new Date('2026-11-10T00:00:00Z') });
    const schemas = new Map([[base.revisionId, base.schema], [`rev-${EVIDENCE_CONTINUATION}`, (await sheet(EVIDENCE_CONTINUATION)).schema], [`rev-${NARRATIVE_CONTINUATION}`, (await sheet(NARRATIVE_CONTINUATION)).schema]]);
    expect((await validateOutput(out.bytes, out.pages, out.expected, schemas)).ok).toBe(true);

    // Replace the template's own content stream on page 1 with different drawing operators.
    const doc = await PDFDocument.load(out.bytes);
    const page = doc.getPage(0);
    const contents = page.node.lookup(PDFName.of('Contents'));
    expect(contents).toBeInstanceOf(PDFArray);
    const refs = (contents as PDFArray).asArray();
    const hashes = contentStreamHashes(page);
    const target = refs[hashes.indexOf(base.schema.pages[0]!.streamSha256[0]!)]!;
    expect(target).toBeTruthy();
    doc.context.assign(target as never, PDFRawStream.of(doc.context.obj({}), new TextEncoder().encode('BT /F1 9 Tf 40 40 Td (forged) Tj ET')));
    const tampered = await doc.save();
    const v = await validateOutput(tampered, out.pages, out.expected, schemas);
    expect(v.checks.find((c) => c.name === 'template layout')).toMatchObject({ ok: false });
    expect(v.ok).toBe(false);
  });

  it('only standard-font characters reach the PDF', () => {
    expect(toWinAnsi('Bore ≤ 52.03 mm ± 0.01 — µm, “ok”\tdone 🙂')).toBe('Bore <= 52.03 mm ± 0.01 — µm, “ok” done ?');
  });
});
