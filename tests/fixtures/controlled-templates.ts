import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PDFDocument, PDFHexString, PDFName, StandardFonts } from 'pdf-lib';
import type { TemplateSchema } from '../../src/shared/controlled-forms.js';

/**
 * The approved controlled templates live in PDI's Drive folder and are not committed. Their structure
 * (field tree, labels, choices, limits, section headings, printed checklist rows, document-control band
 * and footer, page sizes and the SHA-256 of each approved file) is recorded in
 * controlled-templates.json by `npx tsx scripts/controlled-templates-fixture.ts <folder>`.
 *
 * Tests import stand-ins rebuilt from that structure, so the application derives exactly the schema it
 * derives from the approved PDF; `tests/integration/controlled-approved.test.ts` proves that against the
 * real files whenever CONTROLLED_DOCS_DIR points at them.
 */
export interface TemplateFixtureEntry {
  fileName: string;
  number: string;
  kind: 'FORM' | 'CONTINUATION';
  revisionLabel: string;
  /** SHA-256 of the approved PDF, or null when the structure was transcribed from it. */
  sha256: string | null;
  byteSize: number | null;
  source: 'APPROVED_PDF' | 'TRANSCRIBED';
  schema: TemplateSchema;
}

const FIXTURE = path.resolve(import.meta.dirname, 'controlled-templates.json');
let cache: TemplateFixtureEntry[] | null = null;

export function templateFixture(): TemplateFixtureEntry[] {
  cache ??= JSON.parse(readFileSync(FIXTURE, 'utf8')) as TemplateFixtureEntry[];
  return cache;
}

export const STAND_IN_MARK = 'TEST STAND-IN - structure of the approved template, not a controlled document';

const tooltip = (label: string, req: string) => `${label} | ${req === 'REQUIRED' ? 'Required at completion' : req === 'CONDITIONAL' ? 'C' : 'O'}`;

/** A PDF that carries the template's field tree and static identity text at the same positions. */
export async function buildStandIn(schema: TemplateSchema, opts: { mark?: string } = {}): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(STAND_IN_MARK);
  doc.setCreationDate(new Date('2026-11-01T00:00:00Z'));
  doc.setModificationDate(new Date('2026-11-01T00:00:00Z'));
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const form = doc.getForm();
  const pages = schema.pages.map((p) => doc.addPage([p.width, p.height]));
  pages.forEach((page, i) => {
    const { width, height } = schema.pages[i]!;
    page.drawText(opts.mark ?? STAND_IN_MARK, { x: 36, y: height - 12, size: 7, font: regular });
    if (i === 0 && schema.title) page.drawText(schema.title, { x: 132, y: height - 60, size: 13, font: bold });
    if (schema.controlLine) page.drawText(schema.controlLine, { x: 43, y: height - 92, size: 8, font: bold });
    schema.footer.forEach((line, k) => page.drawText(line, { x: 36, y: 37 - k * 12, size: 7.4, font: regular }));
    page.drawText(`Page ${i + 1} of ${pages.length}`, { x: width - 74, y: 25, size: 7.4, font: regular });
  });
  for (const s of schema.sections) pages[s.page - 1]!.drawText(s.title, { x: s.x, y: s.y, size: 10, font: bold });

  const addText = (name: string, label: string, req: string, maxLength: number | null, multiline: boolean, page: number, r: [number, number, number, number]) => {
    const f = form.createTextField(name);
    if (maxLength) f.setMaxLength(maxLength);
    if (multiline) f.enableMultiline();
    f.addToPage(pages[page - 1]!, { x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1], font: regular, borderWidth: 0 });
    f.acroField.dict.set(PDFName.of('TU'), PDFHexString.fromText(tooltip(label, req)));
  };
  const addChoice = (name: string, label: string, req: string, options: string[], page: number, r: [number, number, number, number]) => {
    const f = form.createDropdown(name);
    f.addOptions(['--', ...options]);
    f.addToPage(pages[page - 1]!, { x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1], font: regular, borderWidth: 0 });
    f.acroField.dict.set(PDFName.of('TU'), PDFHexString.fromText(tooltip(label, req)));
  };

  for (const f of schema.fields) {
    if (f.input === 'choice') addChoice(f.name, f.label, f.requirement, f.options ?? [], f.page, f.rect);
    else addText(f.name, f.label, f.requirement, f.maxLength, f.input === 'multiline', f.page, f.rect);
  }
  for (const s of schema.schedules) {
    s.rowRects.forEach((box, i) => {
      const page = s.rowPages[i]!;
      const label = s.rowLabels?.[i];
      if (label) pages[page - 1]!.drawText(label, { x: 40, y: box[3] - 10, size: 8, font: regular });
      const width = (box[2] - box[0]) / s.columns.length;
      s.columns.forEach((c, k) => {
        const x1 = Math.round((box[0] + k * width) * 10) / 10;
        const x2 = k === s.columns.length - 1 ? box[2] : Math.round((box[0] + (k + 1) * width - 2) * 10) / 10;
        const rect: [number, number, number, number] = [x1, box[1], x2, box[3]];
        const name = `${schema.prefix}__${s.key}__r${String(i + 1).padStart(2, '0')}__${c.key}`;
        if (c.input === 'choice') addChoice(name, c.label, c.requirement, c.options ?? [], page, rect);
        else addText(name, c.label, c.requirement, c.maxLength, c.input === 'multiline', page, rect);
      });
    });
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/** Stand-in files (owner file names) for the given type codes: base forms, their continuations and the universal continuations. */
export async function standInFiles(codes: string[]): Promise<Array<{ name: string; bytes: Buffer }>> {
  const wanted = templateFixture().filter((e) => codes.some((c) => e.number === c || e.number.startsWith(`${c}/`)) || e.number.startsWith('PDI-'));
  return Promise.all(wanted.map(async (e) => ({ name: e.fileName, bytes: await buildStandIn(e.schema) })));
}

/** A later revision of a template: same structure, new revision label in its identity text, e.g. Rev 04. */
export function revisedSchema(schema: TemplateSchema, from: string, to: string): TemplateSchema {
  const swap = (s: string) => s.replace(`REV ${from}`, `REV ${to}`).replace(`Rev ${from}`, `Rev ${to}`);
  return { ...schema, controlLine: schema.controlLine ? swap(schema.controlLine) : null, footer: schema.footer.map(swap) };
}
