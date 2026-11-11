import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef } from 'pdf-lib';
import type { TemplateSchema } from '../../shared/controlled-forms.js';
import { contentStreamHashes, pageText, squash } from './pdf-text.js';
import type { ExpectedText, PagePlan } from './render.js';

/**
 * Checks a generated controlled PDF against the approved template revisions it was built from:
 * page sequence and size, the template's static page content (layout, headings, document-control
 * band and footer) carried over byte-for-byte, the document-control text present on every page,
 * every entered value, signature and continuation identifier visible on its page, and no
 * interactive fields left behind.
 */
export interface ValidationCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ValidationResult {
  ok: boolean;
  validator: 'CONTROLLED-OUTPUT-1';
  pageCount: number;
  templates: Array<{ documentNumber: string; revisionId: string; revisionLabel: string; pages: number }>;
  checks: ValidationCheck[];
}

const containsInOrder = (haystack: string[], needle: string[]) => {
  if (!needle.length) return true;
  for (let i = 0; i + needle.length <= haystack.length; i += 1) {
    if (needle.every((n, k) => haystack[i + k] === n)) return true;
  }
  return false;
};

export async function validateOutput(bytes: Uint8Array, plan: PagePlan[], expected: ExpectedText[], templates: Map<string, TemplateSchema>): Promise<ValidationResult> {
  const checks: ValidationCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (err) {
    add('readable', false, `The generated PDF cannot be read: ${(err as Error).message}`);
    return { ok: false, validator: 'CONTROLLED-OUTPUT-1', pageCount: 0, templates: [], checks };
  }
  const pages = doc.getPages();
  add('page count', pages.length === plan.length, `${pages.length} page(s) generated, ${plan.length} planned`);

  const texts = pages.map((p) => pageText(doc, p));
  const squashed = texts.map((runs) => squash(runs.map((r) => r.text).join(' ')));

  const layoutFailures: string[] = [];
  const controlFailures: string[] = [];
  const sizeFailures: string[] = [];
  plan.forEach((entry, i) => {
    const page = pages[i];
    const schema = templates.get(entry.revisionId);
    if (!page || !schema) {
      layoutFailures.push(`page ${i + 1}: no template ${entry.documentNumber} Rev ${entry.revisionLabel}`);
      return;
    }
    const tp = schema.pages[entry.templatePage - 1];
    if (!tp) {
      layoutFailures.push(`page ${i + 1}: template page ${entry.templatePage} missing`);
      return;
    }
    const { width, height } = page.getSize();
    if (Math.round(width) !== tp.width || Math.round(height) !== tp.height) sizeFailures.push(`page ${i + 1}: ${Math.round(width)}×${Math.round(height)} vs ${tp.width}×${tp.height}`);
    if (!containsInOrder(contentStreamHashes(page), tp.streamSha256)) layoutFailures.push(`page ${i + 1} (${entry.documentNumber} p${entry.templatePage})`);
    const control = [...schema.footer, ...(schema.controlLine ? [schema.controlLine] : [])];
    const missing = control.filter((line) => !squashed[i]!.includes(squash(line)));
    if (missing.length) controlFailures.push(`page ${i + 1}: ${missing.join(' / ')}`);
  });
  add('page size', sizeFailures.length === 0, sizeFailures.length ? sizeFailures.join('; ') : 'Every page has its template page size');
  add('template layout', layoutFailures.length === 0, layoutFailures.length ? `Static template content altered on ${layoutFailures.join('; ')}` : 'Every page carries its template page content unchanged');
  add('document control', controlFailures.length === 0, controlFailures.length ? `Missing document-control text on ${controlFailures.join('; ')}` : 'Document ID, revision, status and owner shown on every page');

  const missingValues = expected.filter((e) => {
    const target = squash(e.text);
    return target.length > 0 && !(squashed[e.page - 1] ?? '').includes(target);
  });
  add(
    'entered values',
    missingValues.length === 0,
    missingValues.length ? `Not visible: ${missingValues.slice(0, 8).map((m) => `${m.field} on page ${m.page}`).join(', ')}${missingValues.length > 8 ? '…' : ''}` : `${expected.length} value(s) visible on their pages`,
  );

  const acroForm = doc.catalog.get(PDFName.of('AcroForm'));
  let widgets = 0;
  let dangling = 0;
  for (const p of pages) {
    const annots = p.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) continue;
    for (let k = 0; k < annots.size(); k += 1) {
      const raw = annots.get(k);
      const a = raw instanceof PDFRef ? doc.context.lookup(raw) : raw;
      if (!a) dangling += 1;
      else if (a instanceof PDFDict && a.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() === 'Widget') widgets += 1;
    }
  }
  add('references', dangling === 0, dangling ? `${dangling} annotation reference(s) point to missing objects` : 'Every page reference resolves');
  const fieldCount = acroForm instanceof PDFDict ? (acroForm.lookupMaybe(PDFName.of('Fields'), PDFArray)?.size() ?? 0) : 0;
  add('flattened', widgets === 0 && fieldCount === 0, widgets || fieldCount ? `${widgets} widget(s) and ${fieldCount} interactive field(s) remain` : 'No interactive fields remain (no duplicate field names)');

  const byTemplate = new Map<string, { documentNumber: string; revisionId: string; revisionLabel: string; pages: number }>();
  for (const e of plan) {
    const t = byTemplate.get(e.revisionId) ?? { documentNumber: e.documentNumber, revisionId: e.revisionId, revisionLabel: e.revisionLabel, pages: 0 };
    t.pages += 1;
    byTemplate.set(e.revisionId, t);
  }
  return { ok: checks.every((c) => c.ok), validator: 'CONTROLLED-OUTPUT-1', pageCount: pages.length, templates: [...byTemplate.values()], checks };
}
