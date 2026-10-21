/**
 * Converts the authoritative Appendix A markdown (docs/requirements) into versioned,
 * schema-validated form definitions (seed/forms/appendix-a-v1.0.json).
 *
 * Usage: npm run catalogue:import
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type FormDefinition, type FormRow, type FormSection, type SectionPattern, formDefinitionSchema } from '../src/shared/forms.js';

const SOURCE = 'docs/requirements/PDI_TQMS_Appendix_A_Inspection_Forms_and_Interaction_Rules_v1.0.md';
const OUTPUT = 'seed/forms/appendix-a-v1.0.json';

const PATTERNS: Record<string, SectionPattern> = {
  'pfn checklist': 'pfn_checklist',
  'pass fail checklist': 'pass_fail_checklist',
  'pfn visual': 'pfn_visual',
  dimensional: 'dimensional',
  'general measurements': 'general_measurements',
  'camshaft bore': 'camshaft_bore',
  'fire ring protrusion': 'fire_ring_protrusion',
  'groove specs': 'groove_specs',
  'valve recession': 'valve_recession',
  'vacuum test': 'vacuum_test',
};

export interface CatalogueEntry {
  formNumber: string;
  component: string;
  revisionLabel: string | null;
  sequence: number;
  availability: 'ACTIVE' | 'HISTORICAL';
  definition: FormDefinition;
}

function slug(text: string, max = 48): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max)
    .replace(/_+$/g, '');
}

function parseRow(line: string): FormRow {
  const body = line.replace(/^-\s+/, '').trim();
  const parts = body.split(/; (?=(?:Acceptance|Location|Numerical acceptance limit|Specification|Unit): )/);
  const row: FormRow = { key: '', name: parts[0]!.trim() };
  for (const part of parts.slice(1)) {
    const idx = part.indexOf(': ');
    const label = part.slice(0, idx);
    const value = part.slice(idx + 2).trim();
    if (label === 'Acceptance') row.acceptance = value;
    else if (label === 'Location') row.location = value;
    else if (label === 'Numerical acceptance limit') row.limitNote = value;
    else if (label === 'Specification') row.specText = value;
    else if (label === 'Unit') row.unit = value;
  }
  row.key = slug(row.name);
  return row;
}

function parseParams(line: string): FormSection['params'] {
  const m = /\(([^)]*)\)/.exec(line);
  const params: NonNullable<FormSection['params']> = {};
  for (const kv of (m?.[1] ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [k, v] = kv.split('=').map((s) => s.trim());
    const n = Number(v);
    if (k === 'bore count') params.boreCount = n;
    if (k === 'cylinder count') params.cylinderCount = n;
    if (k === 'intake count') params.intakeCount = n;
    if (k === 'exhaust count') params.exhaustCount = n;
  }
  return params;
}

export function parseAppendixA(markdown: string): CatalogueEntry[] {
  const lines = markdown.split(/\r?\n/);
  const entries: CatalogueEntry[] = [];
  let current: { formNumber: string; component: string; revisionLabel: string | null; availability: CatalogueEntry['availability']; sections: FormSection[] } | null = null;
  let section: FormSection | null = null;

  const flush = () => {
    if (!current) return;
    const sequence = entries.filter((e) => e.formNumber === current!.formNumber).length + 1;
    const definition = formDefinitionSchema.parse({
      schemaVersion: 1,
      formNumber: current.formNumber,
      component: current.component,
      revisionLabel: current.revisionLabel,
      sections: current.sections,
    });
    entries.push({
      formNumber: current.formNumber,
      component: current.component,
      revisionLabel: current.revisionLabel,
      sequence,
      availability: current.availability,
      definition,
    });
  };

  for (const line of lines) {
    const heading = /^### (PDI-IQI-[0-9A-Z]+)(?: Rev ([A-Z0-9]+))? — (.+)$/.exec(line);
    if (heading) {
      flush();
      current = { formNumber: heading[1]!, revisionLabel: heading[2] ?? null, component: heading[3]!.trim(), availability: 'ACTIVE', sections: [] };
      section = null;
      continue;
    }
    if (!current) continue;
    if (line.startsWith('## ')) {
      flush();
      current = null;
      continue;
    }
    if (line.startsWith('**Availability:**')) {
      current.availability = /Active\/selectable/.test(line) ? 'ACTIVE' : 'HISTORICAL';
      continue;
    }
    const sec = /^\*\*(?:([A-Z])\. )?([^*]+)\*\* — ([a-z ]+); once per (inspection|item)(; \*\*optional\/conditional\*\*)?\.?$/.exec(line);
    if (sec) {
      const letter = sec[1] ?? '';
      const title = sec[2]!.trim();
      const pattern = PATTERNS[sec[3]!.trim()];
      if (!pattern) throw new Error(`Unknown section pattern in line: ${line}`);
      const dash = title.split('—');
      const key = letter ? (dash.length > 1 ? `${letter}_${slug(dash[dash.length - 1]!, 24)}` : letter) : slug(title, 32);
      section = { key, letter, title, pattern, scope: sec[4] === 'inspection' ? 'inspection' : 'unit', optional: Boolean(sec[5]), rows: [] };
      current.sections.push(section);
      continue;
    }
    if (section && /^\s+- Enter pattern-specific results/.test(line)) {
      const params = parseParams(line);
      if (params && Object.keys(params).length) section.params = params;
      continue;
    }
    if (section && line.startsWith('- ')) {
      const row = parseRow(line);
      let key = row.key;
      for (let n = 2; section.rows.some((r) => r.key === key); n += 1) key = `${row.key}_${n}`;
      section.rows.push({ ...row, key });
    }
  }
  flush();
  return entries;
}

function main() {
  const markdown = readFileSync(SOURCE, 'utf8');
  const entries = parseAppendixA(markdown);
  const active = entries.filter((e) => e.availability === 'ACTIVE').length;
  if (entries.length !== 31 || active !== 28) {
    throw new Error(`Expected 31 catalogued definitions / 28 active, parsed ${entries.length} / ${active}`);
  }
  const out = {
    source: { file: SOURCE, sha256: createHash('sha256').update(markdown).digest('hex'), release: 'Appendix A v1.0 (17 October 2026)' },
    entries,
  };
  writeFileSync(OUTPUT, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`Wrote ${entries.length} form definitions (${active} active) to ${path.resolve(OUTPUT)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) main();
