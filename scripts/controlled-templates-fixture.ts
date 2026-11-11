/**
 * Records the structure of the approved controlled templates for the tests (the PDFs themselves are
 * PDI-controlled and are not committed):
 *
 *   npx tsx scripts/controlled-templates-fixture.ts <folder with the Drive QualitySystemForms PDFs>
 *
 * Writes tests/fixtures/controlled-templates.json with each form and continuation sheet's file name,
 * SHA-256, size and the template schema TQM derives from it. Re-run after PDI releases new revisions.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deriveTemplate } from '../src/server/controlled/template.js';
import { parseDocumentFilename } from '../src/shared/documents.js';
import type { TemplateSchema } from '../src/shared/controlled-forms.js';
import { type TemplateFixtureEntry, buildStandIn } from '../tests/fixtures/controlled-templates.js';

const dir = process.argv[2];
if (!dir || !existsSync(dir)) {
  console.error('Usage: npx tsx scripts/controlled-templates-fixture.ts <folder with the approved PDFs>');
  process.exit(2);
}

/**
 * PDI_Narrative_Continuation_Rev03.pdf, transcribed from the approved file (field names, tooltips,
 * limits and boxes) for environments where only its structure is at hand. Replaced by the real file's
 * derivation whenever the PDF is in the folder.
 */
const NARRATIVE_TRANSCRIBED: TemplateSchema = {
  deriver: 'ACROFORM-1',
  interactive: true,
  reason: null,
  prefix: 'PDINARR',
  title: 'Controlled Narrative / Decision Continuation',
  controlLine: 'PDI-NARR | REV 0.3 | DRAFT - REVIEW ONLY',
  footer: ['PDI-NARR | Rev 0.3 | Effective: pending | Owner: Quality Systems', 'DRAFT - NOT RELEASED | Uncontrolled when printed | PDI master record governs'],
  pages: [{ page: 1, width: 612, height: 792, contentSha256: '', streamSha256: [], headings: [] }],
  sections: [],
  fields: [
    ['parent_record', 'Parent document / record ID', 38, [36, 641.8, 244, 661.8]],
    ['parent_revision', 'Record revision', 18, [254, 641.8, 358, 661.8]],
    ['sheet_id', 'Unique continuation sheet ID', 38, [368, 641.8, 576, 661.8]],
    ['section_ref', 'Parent section / field / row ID', 42, [36, 599.5, 267.1, 619.5]],
    ['completed_by', 'Completed by', 31, [277.1, 599.5, 450.4, 619.5]],
    ['date', 'Date', 10, [460.4, 599.5, 576, 619.5]],
    ['continuation_text', 'Continued text / decision / analysis', 3366, [36, 217.3, 576, 577.3]],
  ].map(([key, label, maxLength, rect]) => ({
    name: `PDINARR__${key}`,
    key: key as string,
    label: label as string,
    requirement: 'REQUIRED' as const,
    input: key === 'continuation_text' ? ('multiline' as const) : key === 'date' ? ('date' as const) : ('text' as const),
    options: null,
    maxLength: maxLength as number,
    page: 1,
    rect: rect as [number, number, number, number],
    section: null,
    role: ['parent_record', 'parent_revision', 'sheet_id', 'completed_by'].includes(key as string) ? ('SYSTEM' as const) : ('ENTRY' as const),
  })),
  schedules: [],
  fieldTreeSha256: '',
};

const entries: TemplateFixtureEntry[] = [];
for (const fileName of readdirSync(dir).sort()) {
  const parsed = parseDocumentFilename(fileName);
  if (!parsed) continue;
  const isUniversal = parsed.kind === 'LIBRARY' && /Continuation$/.test(parsed.number);
  if (parsed.kind === 'LIBRARY' && !isUniversal) continue;
  const bytes = readFileSync(path.join(dir, fileName));
  const schema = await deriveTemplate(bytes);
  if (!schema.interactive) continue;
  entries.push({
    fileName,
    number: parsed.number,
    kind: parsed.kind === 'FORM' ? 'FORM' : 'CONTINUATION',
    revisionLabel: parsed.revisionLabel,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteSize: bytes.length,
    source: 'APPROVED_PDF',
    schema,
  });
}
if (!entries.some((e) => e.number === 'PDI-Narrative-Continuation')) {
  // Derive through a stand-in so the transcribed entry has exactly the shape the deriver produces.
  const schema = await deriveTemplate(await buildStandIn(NARRATIVE_TRANSCRIBED));
  entries.push({ fileName: 'PDI_Narrative_Continuation_Rev03.pdf', number: 'PDI-Narrative-Continuation', kind: 'CONTINUATION', revisionLabel: '03', sha256: null, byteSize: null, source: 'TRANSCRIBED', schema });
}
entries.sort((a, b) => a.number.localeCompare(b.number));
const out = path.resolve(import.meta.dirname, '../tests/fixtures/controlled-templates.json');
writeFileSync(out, `${JSON.stringify(entries)}\n`);
console.log(`${entries.length} templates (${entries.filter((e) => e.kind === 'FORM').length} forms) written to ${path.relative(process.cwd(), out)}`);
