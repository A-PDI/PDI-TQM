import { PDFDict, PDFDocument, PDFDropdown, type PDFField, PDFHexString, PDFName, PDFString, PDFTextField } from 'pdf-lib';
import {
  DECISION_SECTION,
  type FieldInput,
  type FieldRole,
  type Requirement,
  SIGNATURE_FIELD,
  SYSTEM_FIELD,
  type TemplateColumn,
  type TemplateField,
  type TemplateSchedule,
  type TemplateSchema,
} from '../../shared/controlled-forms.js';
import { canonicalJson } from '../../shared/forms.js';
import { type TextRun, contentStreamHashes, pageContentHash, pageText, sha256 } from './pdf-text.js';

/**
 * Derives the data-entry definition of a controlled form from the released PDF itself: the AcroForm
 * field tree (names, labels in the tooltip, required/conditional/optional, choices, length limits,
 * page positions) plus the static page text for section headings, printed checklist rows and the
 * document-control band and footer. The PDF stays the single source of truth for every revision.
 */
export const DERIVER = 'ACROFORM-1' as const;

const SCHEDULE_FIELD = /^(.+?)__r(\d{2,3})__([a-z0-9_]+)$/;
const FOOTER_LIMIT = 66; // master form standard: body content stays above 66 pt

interface RawField {
  name: string;
  key: string;
  label: string;
  requirement: Requirement;
  input: FieldInput;
  options: string[] | null;
  maxLength: number | null;
  page: number;
  rect: [number, number, number, number];
}

function tooltip(field: PDFField): string {
  const tu = field.acroField.dict.lookup(PDFName.of('TU'));
  if (tu instanceof PDFString || tu instanceof PDFHexString) return tu.decodeText();
  return '';
}

function parseTooltip(tu: string, fallback: string): { label: string; requirement: Requirement } {
  const parts = tu.split(' | ');
  const tail = parts.length > 1 ? parts[parts.length - 1]!.trim() : '';
  const requirement: Requirement = /^required/i.test(tail) ? 'REQUIRED' : tail === 'O' || /^optional/i.test(tail) ? 'OPTIONAL' : tail === 'C' || /^cond/i.test(tail) ? 'CONDITIONAL' : 'OPTIONAL';
  const label = (parts.length > 1 ? parts.slice(0, -1).join(' | ') : tu).trim() || fallback;
  return { label, requirement };
}

const humanKey = (key: string) => key.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

function inputFor(field: PDFField, key: string, label: string, maxLength: number | null, height: number): { input: FieldInput; options: string[] | null } {
  if (field instanceof PDFDropdown) return { input: 'choice', options: field.getOptions().filter((o) => o.trim() && o !== '--') };
  if ((/(^|_)date$/.test(key) || /\bdate\b/i.test(label)) && maxLength === 10) return { input: 'date', options: null };
  if (field instanceof PDFTextField && field.isMultiline() && height >= 30) return { input: 'multiline', options: null };
  return { input: 'text', options: null };
}

export async function deriveTemplate(bytes: Uint8Array): Promise<TemplateSchema> {
  const empty = (reason: string): TemplateSchema => ({
    deriver: DERIVER,
    interactive: false,
    reason,
    prefix: null,
    title: null,
    controlLine: null,
    footer: [],
    pages: [],
    sections: [],
    fields: [],
    schedules: [],
    fieldTreeSha256: sha256(''),
  });
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    return empty(`The PDF could not be read (${(err as Error).message.slice(0, 120)})`);
  }
  const pages = doc.getPages();
  const text: TextRun[][] = pages.map((p) => pageText(doc, p));
  const pageDefs = pages.map((p, i) => {
    const { width, height } = p.getSize();
    return {
      page: i + 1,
      width: Math.round(width),
      height: Math.round(height),
      contentSha256: pageContentHash(p),
      streamSha256: contentStreamHashes(p),
      headings: headings(text[i]!).map((h) => h.text),
    };
  });

  // Widget → page, through each page's /Annots.
  const widgetPage = new Map<PDFDict, number>();
  pages.forEach((p, i) => {
    const annots = p.node.Annots();
    if (!annots) return;
    for (let k = 0; k < annots.size(); k += 1) {
      const a = annots.lookup(k);
      if (a instanceof PDFDict) widgetPage.set(a, i + 1);
    }
  });

  let fields: PDFField[] = [];
  try {
    fields = doc.getForm().getFields();
  } catch {
    fields = [];
  }
  const raw: RawField[] = [];
  for (const f of fields) {
    if (!(f instanceof PDFTextField) && !(f instanceof PDFDropdown)) continue;
    const widget = f.acroField.getWidgets()[0];
    if (!widget) continue;
    const r = widget.getRectangle();
    const rect: [number, number, number, number] = [r.x, r.y, r.x + r.width, r.y + r.height].map((v) => Math.round(v * 10) / 10) as [number, number, number, number];
    const name = f.getName();
    const key = name.includes('__') ? name.slice(name.indexOf('__') + 2) : name;
    const { label, requirement } = parseTooltip(tooltip(f), humanKey(key.split('__').pop()!));
    const maxLength = f instanceof PDFTextField ? (f.getMaxLength() ?? null) : null;
    const { input, options } = inputFor(f, key.split('__').pop()!, label, maxLength, r.height);
    raw.push({ name, key, label, requirement, input, options, maxLength, page: widgetPage.get(widget.dict) ?? 1, rect });
  }
  if (!raw.length) return { ...empty('The PDF has no fillable fields, so it can be used only as a reference document'), pages: pageDefs };

  const prefixes = new Set(raw.map((f) => (f.name.includes('__') ? f.name.slice(0, f.name.indexOf('__')) : '')));
  const prefix = prefixes.size === 1 ? [...prefixes][0]! || null : null;

  const page1 = text[0] ?? [];
  const title = page1.filter((t) => t.bold && t.size >= 12.5).sort((a, b) => b.y - a.y)[0]?.text ?? null;
  const controlLine = page1.find((t) => /\|\s*REV\s/i.test(t.text) && t.y > (pageDefs[0]?.height ?? 792) - 140)?.text ?? null;
  const footer = page1
    .filter((t) => t.y < FOOTER_LIMIT && !/^Page \d+ of \d+$/i.test(t.text))
    .sort((a, b) => b.y - a.y || a.x - b.x)
    .map((t) => t.text);

  const allHeadings = text.flatMap((runs, i) => headings(runs).map((h) => ({ page: i + 1, x: h.x, y: h.y, title: h.text })));
  const sectionFor = (page: number, top: number): string | null => {
    const onPage = allHeadings.filter((h) => h.page === page && h.y >= top - 2).sort((a, b) => a.y - b.y)[0];
    if (onPage) return onPage.title;
    const before = allHeadings.filter((h) => h.page < page).sort((a, b) => b.page - a.page || a.y - b.y)[0];
    return before?.title ?? null;
  };
  // A field belongs to the closest heading drawn above it; fields above the first heading identify the record.
  const sectionAbove = (page: number, top: number): string | null => {
    const above = allHeadings.filter((h) => h.page === page && h.y > top).sort((a, b) => a.y - b.y)[0];
    if (above) return above.title;
    const earlier = allHeadings.filter((h) => h.page < page).sort((a, b) => b.page - a.page || a.y - b.y)[0];
    return page === 1 ? null : (earlier?.title ?? null);
  };

  const singles: TemplateField[] = [];
  const grouped = new Map<string, Map<number, RawField[]>>();
  for (const f of raw) {
    const m = SCHEDULE_FIELD.exec(f.key);
    if (m) {
      const [, schedule, row] = m as unknown as [string, string, string];
      const rows = grouped.get(schedule) ?? new Map<number, RawField[]>();
      rows.set(Number(row), [...(rows.get(Number(row)) ?? []), f]);
      grouped.set(schedule, rows);
      continue;
    }
    const section = sectionAbove(f.page, f.rect[3]);
    const role: FieldRole = SYSTEM_FIELD.test(f.key) ? 'SYSTEM' : SIGNATURE_FIELD.test(f.key) ? 'SIGNATURE' : section && DECISION_SECTION.test(section) ? 'DECISION' : 'ENTRY';
    singles.push({ ...f, section, role });
  }

  const schedules: TemplateSchedule[] = [];
  for (const [key, rows] of grouped) {
    const ordered = [...rows.entries()].sort((a, b) => a[0] - b[0]);
    const first = ordered[0]![1].sort((a, b) => a.rect[0] - b.rect[0]);
    const columns: TemplateColumn[] = first.map((f) => {
      const col = SCHEDULE_FIELD.exec(f.key)![3]!;
      return { key: col, label: f.label, requirement: f.requirement, input: f.input, options: f.options, maxLength: f.maxLength };
    });
    const labels = ordered.map(([, widgets]) => rowLabel(text[widgets[0]!.page - 1] ?? [], widgets));
    const top = Math.max(...first.map((f) => f.rect[3]));
    schedules.push({
      key,
      title: sectionFor(first[0]!.page, top),
      columns,
      capacity: ordered.length,
      pages: [...new Set(ordered.map(([, w]) => w[0]!.page))],
      rowPages: ordered.map(([, w]) => w[0]!.page),
      rowRects: ordered.map(([, w]) => [Math.min(...w.map((f) => f.rect[0])), Math.min(...w.map((f) => f.rect[1])), Math.max(...w.map((f) => f.rect[2])), Math.max(...w.map((f) => f.rect[3]))] as [number, number, number, number]),
      rowLabels: labels.every((l) => l) ? (labels as string[]) : null,
    });
  }

  const tree = raw
    .map((f) => [f.name, f.input === 'choice' ? 'choice' : 'text', f.options ?? [], f.maxLength ?? 0, f.page])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

  return {
    deriver: DERIVER,
    interactive: true,
    reason: null,
    prefix,
    title,
    controlLine,
    footer,
    pages: pageDefs,
    sections: allHeadings.map((h) => ({ title: h.title, page: h.page, x: h.x, y: h.y })),
    fields: singles,
    schedules,
    fieldTreeSha256: sha256(canonicalJson(tree)),
  };
}

/** Bold 10-point lines are section headings in the master form standard. */
function headings(runs: TextRun[]): TextRun[] {
  return runs.filter((r) => r.bold && r.size >= 9.5 && r.size <= 10.5 && r.y > FOOTER_LIMIT).sort((a, b) => b.y - a.y);
}

/** Text printed in the row band to the left of the row's first entry box (checklist rows). */
function rowLabel(runs: TextRun[], widgets: RawField[]): string | null {
  const bottom = Math.min(...widgets.map((w) => w.rect[1]));
  const top = Math.max(...widgets.map((w) => w.rect[3]));
  const left = Math.min(...widgets.map((w) => w.rect[0]));
  const parts = runs.filter((r) => r.y >= bottom - 1 && r.y <= top + 1 && r.x < left - 2).sort((a, b) => b.y - a.y || a.x - b.x);
  const label = parts.map((p) => p.text).join(' ').replace(/\s+/g, ' ').trim();
  return label || null;
}
