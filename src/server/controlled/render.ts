import { PDFArray, PDFDict, type PDFDocument as PDFDocumentType, PDFDocument, PDFDropdown, PDFName, PDFRef, PDFTextField, StandardFonts } from 'pdf-lib';
import {
  EVIDENCE_SCHEDULE,
  ROW_LABEL,
  type RecordData,
  type TemplateSchedule,
  type TemplateSchema,
  toWinAnsi,
} from '../../shared/controlled-forms.js';

/**
 * Assembles the controlled output of a FORM record from the exact template revisions it is bound
 * to: the base form filled in, then one continuation sheet per block of rows that does not fit,
 * narrative continuations for text longer than a field allows, and evidence-index continuations.
 * Fields are flattened, so the output has no duplicate interactive field names; the static page
 * content of every template page is carried over unchanged (see validate.ts).
 */
export interface SheetTemplate {
  documentNumber: string;
  revisionId: string;
  revisionLabel: string;
  sha256: string;
  bytes: Uint8Array;
  schema: TemplateSchema;
}

export interface RenderRequest {
  number: string;
  recordRevision: string;
  title: string;
  base: SheetTemplate;
  continuations: Record<string, SheetTemplate | undefined>;
  evidence: SheetTemplate | null;
  narrative: SheetTemplate | null;
  data: RecordData;
  preparedBy: string;
  completedDate: string;
  generatedAt: Date;
}

export type SheetKind = 'BASE' | 'CONTINUATION' | 'NARRATIVE' | 'EVIDENCE';

export interface PlannedSheet {
  kind: SheetKind;
  template: SheetTemplate;
  sheetId: string | null;
  sequence: string | null;
  schedule: string | null;
  /** AcroForm field name → value to show. */
  values: Record<string, string>;
}

export interface PagePlan {
  page: number;
  kind: SheetKind;
  documentNumber: string;
  revisionId: string;
  revisionLabel: string;
  templatePage: number;
  sheetId: string | null;
}

export interface ExpectedText {
  page: number;
  field: string;
  text: string;
}

export class RenderProblem extends Error {}

const NARRATIVE_MAX = 3366;
/** Visual capacity of the narrative text box, used when several short overflows share one sheet. */
const NARRATIVE_LINES = 28;
const NARRATIVE_LINE_CHARS = 105;
const AUTO_ROW = '_auto';
const ENTRY_PT = 9;
const ENTRY_PT_MULTILINE = 8.5;
/** Helvetica in the standard's body-text colour #202D3C. */
const entryAppearance = (pt: number) => `/Helv ${pt} Tf 0.12549 0.176471 0.235294 rg`;
const clip = (text: string, max: number | null) => (max && text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text);
const two = (n: number) => String(n).padStart(2, '0');

function fieldName(schema: TemplateSchema, key: string) {
  return schema.prefix ? `${schema.prefix}__${key}` : key;
}

function rowFieldName(schema: TemplateSchema, schedule: string, row: number, col: string) {
  return fieldName(schema, `${schedule}__r${two(row)}__${col}`);
}

/** The continuation column that names an added checklist row (absent from the base sheet). */
function labelColumn(base: TemplateSchedule | undefined, cont: TemplateSchedule): string | null {
  const own = new Set((base?.columns ?? []).map((c) => c.key));
  return cont.columns.find((c) => !own.has(c.key))?.key ?? null;
}

const singleMax = (schema: TemplateSchema, key: string) => schema.fields.find((f) => f.key === key)?.maxLength ?? null;

/** Lays out the sheets; throws RenderProblem when the record needs a sheet that has no released template. */
export function planSheets(req: RenderRequest): PlannedSheet[] {
  const { base, data, number } = req;
  const baseSchema = base.schema;
  const fields = { ...data.fields };
  // Overflowing text continues on narrative sheets. Short overflows (an identifier wider than its box)
  // share a sheet, each under the label and field it continues; long text gets sheets of its own.
  const narratives: Array<{ sheetId: string; refs: string[]; text: string }> = [];
  let narrativeSeq = 0;
  const openNarrative = () => {
    narrativeSeq += 1;
    const sheet = { sheetId: `${number}-N${two(narrativeSeq)}`, refs: [] as string[], text: '' };
    narratives.push(sheet);
    return sheet;
  };
  const lines = (text: string) => text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / NARRATIVE_LINE_CHARS)), 0);

  const overflow = (ref: string, label: string, text: string, max: number | null): string => {
    const value = toWinAnsi(text);
    if (!max || value.length <= max) return value;
    if (!req.narrative) throw new RenderProblem(`${label} is longer than the template allows (${max} characters) and no narrative continuation sheet is released`);
    const entry = toWinAnsi(`${label} (${ref}):\n${value}`);
    let first: string;
    if (entry.length <= NARRATIVE_MAX && lines(entry) <= NARRATIVE_LINES) {
      let sheet = narratives[narratives.length - 1];
      const joined = sheet?.text ? `${sheet.text}\n\n${entry}` : entry;
      if (!sheet || joined.length > NARRATIVE_MAX || lines(joined) > NARRATIVE_LINES) sheet = openNarrative();
      sheet.text = sheet.text ? `${sheet.text}\n\n${entry}` : entry;
      sheet.refs.push(ref);
      first = sheet.sheetId;
    } else {
      first = '';
      for (let i = 0; i < value.length; i += NARRATIVE_MAX) {
        const sheet = openNarrative();
        sheet.refs.push(ref);
        sheet.text = value.slice(i, i + NARRATIVE_MAX);
        first ||= sheet.sheetId;
      }
    }
    const pointer = ` [continued on ${first}]`;
    return pointer.length + 8 <= max ? `${value.slice(0, max - pointer.length)}${pointer}` : clip(`See ${first}`, max);
  };

  const baseValues: Record<string, string> = {};
  for (const f of baseSchema.fields) {
    const v = fields[f.key];
    if (v === undefined || v === '') continue;
    baseValues[f.name] = f.input === 'choice' ? v : overflow(f.name, f.label, v, f.maxLength);
  }

  const sheets: PlannedSheet[] = [{ kind: 'BASE', template: base, sheetId: null, sequence: null, schedule: null, values: baseValues }];
  const continuationSheets: PlannedSheet[] = [];
  let contSeq = 0;
  const siteValue = fields.supplier_site ?? '';
  const configuration = [fields.pdi_part, fields.engineering_revision && `Rev ${fields.engineering_revision}`, fields.configuration ?? fields.configuration_id].filter(Boolean).join(' / ');

  const header = (t: SheetTemplate, sheetId: string, sequence: string): Record<string, string> => {
    const s = t.schema;
    const put: Record<string, string> = {};
    const set = (key: string, value: string) => {
      if (s.fields.some((f) => f.key === key)) put[fieldName(s, key)] = clip(toWinAnsi(value), singleMax(s, key));
    };
    set('parent_record', number);
    set('parent_revision', req.recordRevision);
    set('sheet_id', sheetId);
    set('sheet_sequence', sequence);
    set('part_configuration', configuration);
    set('supplier_site', siteValue);
    set('completed_by', req.preparedBy);
    set('completed_date', req.completedDate);
    set('date', req.completedDate);
    return put;
  };

  // `first` is the logical row number of rows[0] across the base form and its continuation sheets.
  const fillRows = (s: TemplateSchema, schedule: TemplateSchedule, rows: Array<Record<string, string>>, into: Record<string, string>, label: string | null, first = 1, colMap: Record<string, string> = {}) => {
    rows.forEach((row, i) => {
      for (const c of schedule.columns) {
        const sourceKey = c.key === label ? ROW_LABEL : (colMap[c.key] ?? c.key);
        const v = row[sourceKey];
        if (v === undefined || v === '') continue;
        // Rows the system adds (the continuation index) are identifiers: shortened, never continued.
        into[rowFieldName(s, schedule.key, i + 1, c.key)] =
          c.input === 'choice'
            ? v
            : row[AUTO_ROW]
              ? clip(toWinAnsi(v), c.maxLength)
              : overflow(rowFieldName(baseSchema, schedule.key, first + i, c.key), `${schedule.title ?? schedule.key} row ${first + i} ${c.label}`, v, c.maxLength);
      }
    });
  };

  for (const sched of baseSchema.schedules) {
    if (sched.key === EVIDENCE_SCHEDULE) continue;
    const rows = data.schedules[sched.key] ?? [];
    fillRows(baseSchema, sched, rows.slice(0, sched.capacity), baseValues, null);
    const extra = rows.slice(sched.capacity);
    if (!extra.length) continue;
    const cont = req.continuations[sched.key];
    const contSched = cont?.schema.schedules.find((x) => x.key === sched.key);
    if (!cont || !contSched) throw new RenderProblem(`${sched.title ?? sched.key} has ${rows.length} rows but the form holds ${sched.capacity} and no continuation sheet is released for it`);
    const label = sched.rowLabels ? labelColumn(sched, contSched) : null;
    const total = Math.ceil(extra.length / contSched.capacity);
    for (let k = 0; k < total; k += 1) {
      contSeq += 1;
      const sheetId = `${number}-C${two(contSeq)}`;
      const values = header(cont, sheetId, `${k + 1} of ${total}`);
      fillRows(cont.schema, contSched, extra.slice(k * contSched.capacity, (k + 1) * contSched.capacity), values, label, sched.capacity + k * contSched.capacity + 1);
      continuationSheets.push({ kind: 'CONTINUATION', template: cont, sheetId, sequence: `${k + 1} of ${total}`, schedule: sched.key, values });
    }
  }

  const narrativeSheets: PlannedSheet[] = narratives.map((n, i) => {
    const t = req.narrative!;
    const values = header(t, n.sheetId, `${i + 1} of ${narratives.length}`);
    const s = t.schema;
    const textField = [...s.fields].filter((f) => f.input === 'multiline').sort((a, b) => (b.maxLength ?? 0) - (a.maxLength ?? 0))[0];
    const refField = s.fields.find((f) => /section|field|row/i.test(f.label) && f.input !== 'multiline');
    if (textField) values[textField.name] = n.text;
    if (refField) values[refField.name] = clip(n.refs.length > 1 ? `${n.refs.length} entries, each labelled below` : n.refs[0]!, refField.maxLength);
    return { kind: 'NARRATIVE' as const, template: t, sheetId: n.sheetId, sequence: `${i + 1} of ${narratives.length}`, schedule: null, values };
  });

  // The evidence index lists attached evidence and every continuation sheet of the record set.
  const evidenceRows: Array<Record<string, string>> = [...(data.schedules[EVIDENCE_SCHEDULE] ?? [])];
  for (const s of [...continuationSheets, ...narrativeSheets]) {
    const schedTitle = s.schedule ? (baseSchema.schedules.find((x) => x.key === s.schedule)?.title ?? s.schedule) : 'narrative';
    evidenceRows.push({
      [AUTO_ROW]: '1',
      evidence_id: s.sheetId!.slice(number.length + 1),
      file_ref: `${s.sheetId} (${s.template.documentNumber} Rev ${s.template.revisionLabel})`,
      caption: `Continuation ${s.sequence} - ${schedTitle}`,
      association: `${number} / ${s.schedule ?? 'narrative'}`,
      date: req.completedDate,
      uploaded_by: req.preparedBy,
    });
  }
  const evidenceSched = baseSchema.schedules.find((x) => x.key === EVIDENCE_SCHEDULE);
  const evidenceSheets: PlannedSheet[] = [];
  if (evidenceSched) {
    fillRows(baseSchema, evidenceSched, evidenceRows.slice(0, evidenceSched.capacity), baseValues, null);
    const extra = evidenceRows.slice(evidenceSched.capacity);
    if (extra.length) {
      const t = req.evidence;
      const s = t?.schema.schedules.find((x) => x.key === EVIDENCE_SCHEDULE);
      if (!t || !s) throw new RenderProblem(`The evidence index has ${evidenceRows.length} entries but the form holds ${evidenceSched.capacity} and no evidence continuation sheet is released`);
      const total = Math.ceil(extra.length / s.capacity);
      for (let k = 0; k < total; k += 1) {
        const sheetId = `${number}-E${two(k + 1)}`;
        const values = header(t, sheetId, `${k + 1} of ${total}`);
        const rows = extra.slice(k * s.capacity, (k + 1) * s.capacity).map((r) => ({ ...r, association: r.association || `${number}`, added_by: r.added_by || r.uploaded_by || '' }));
        fillRows(t.schema, s, rows, values, null, evidenceSched.capacity + k * s.capacity + 1);
        evidenceSheets.push({ kind: 'EVIDENCE', template: t, sheetId, sequence: `${k + 1} of ${total}`, schedule: EVIDENCE_SCHEDULE, values });
      }
    }
  }
  return [...sheets, ...continuationSheets, ...narrativeSheets, ...evidenceSheets];
}

/** Fills and flattens each sheet and concatenates them; returns the page plan and the text each page must show. */
export async function renderSheets(sheets: PlannedSheet[], meta: { number: string; title: string; generatedAt: Date }): Promise<{ bytes: Uint8Array; pages: PagePlan[]; expected: ExpectedText[] }> {
  const out = await PDFDocument.create({ updateMetadata: false });
  out.setTitle(`${meta.number} - ${toWinAnsi(meta.title)}`);
  out.setSubject(sheets.map((s) => `${s.template.documentNumber} Rev ${s.template.revisionLabel}`).filter((v, i, a) => a.indexOf(v) === i).join('; '));
  out.setProducer('TQM controlled forms');
  out.setCreator('TQM');
  out.setCreationDate(meta.generatedAt);
  out.setModificationDate(meta.generatedAt);
  const pages: PagePlan[] = [];
  const expected: ExpectedText[] = [];
  for (const sheet of sheets) {
    const doc = await PDFDocument.load(sheet.template.bytes, { updateMetadata: false });
    const form = doc.getForm();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const startPage = pages.length;
    for (const [name, raw] of Object.entries(sheet.values)) {
      const field = form.getFieldMaybe(name);
      if (!field) throw new RenderProblem(`${sheet.template.documentNumber} Rev ${sheet.template.revisionLabel} has no field ${name}`);
      if (field instanceof PDFDropdown) {
        if (!field.getOptions().includes(raw)) throw new RenderProblem(`${name}: "${raw}" is not one of the template's choices`);
        field.acroField.setDefaultAppearance(entryAppearance(ENTRY_PT));
        field.select(raw);
      } else if (field instanceof PDFTextField) {
        const text = clip(toWinAnsi(raw), field.getMaxLength() ?? null);
        // Master form standard: entered text is 8.5–9 pt (the templates leave the size to the viewer).
        field.acroField.setDefaultAppearance(entryAppearance(field.isMultiline() ? ENTRY_PT_MULTILINE : ENTRY_PT));
        field.setText(text);
        expected.push({ page: startPage + widgetPage(sheet, name, 1), field: name, text });
        continue;
      } else {
        throw new RenderProblem(`${name} is not a text or choice field`);
      }
      expected.push({ page: startPage + widgetPage(sheet, name, 1), field: name, text: raw });
    }
    form.updateFieldAppearances(font);
    form.flatten({ updateFieldAppearances: false });
    pruneAnnotations(doc);
    const copied = await out.copyPages(doc, doc.getPageIndices());
    copied.forEach((p, i) => {
      out.addPage(p);
      pages.push({
        page: pages.length + 1,
        kind: sheet.kind,
        documentNumber: sheet.template.documentNumber,
        revisionId: sheet.template.revisionId,
        revisionLabel: sheet.template.revisionLabel,
        templatePage: i + 1,
        sheetId: sheet.sheetId,
      });
    });
  }
  const bytes = await out.save({ useObjectStreams: false });
  return { bytes, pages, expected };
}

/**
 * After flattening, a page may still list annotation references whose widgets were removed (pdf-lib
 * keeps them for some field layouts). Keep only annotations that still exist and are not widgets.
 */
function pruneAnnotations(doc: PDFDocumentType) {
  for (const page of doc.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) continue;
    const keep: PDFRef[] = [];
    for (let i = 0; i < annots.size(); i += 1) {
      const ref = annots.get(i);
      const obj = ref instanceof PDFRef ? doc.context.lookup(ref) : ref;
      if (ref instanceof PDFRef && obj instanceof PDFDict && obj.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() !== 'Widget') keep.push(ref);
    }
    if (keep.length) page.node.set(PDFName.of('Annots'), doc.context.obj(keep));
    else page.node.delete(PDFName.of('Annots'));
  }
}

/** 1-based page of the field within its sheet. */
function widgetPage(sheet: PlannedSheet, name: string, fallback: number): number {
  const single = sheet.template.schema.fields.find((f) => f.name === name);
  if (single) return single.page;
  const m = /__([a-z0-9_]+?)__r(\d+)__/.exec(name);
  if (!m) return fallback;
  const sched = sheet.template.schema.schedules.find((s) => s.key === m[1]);
  if (!sched) return fallback;
  return sched.rowPages[Number(m[2]) - 1] ?? sched.pages[0] ?? fallback;
}
