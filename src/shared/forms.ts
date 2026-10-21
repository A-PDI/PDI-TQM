import { z } from 'zod';

/** Section patterns from Appendix A §A2. */
export const SECTION_PATTERNS = [
  'pfn_checklist',
  'pass_fail_checklist',
  'pfn_visual',
  'dimensional',
  'general_measurements',
  'camshaft_bore',
  'fire_ring_protrusion',
  'groove_specs',
  'valve_recession',
  'vacuum_test',
] as const;
export type SectionPattern = (typeof SECTION_PATTERNS)[number];

export const RESPONSE_STATUSES = ['P', 'F', 'A', 'N'] as const;
export type ResponseStatus = (typeof RESPONSE_STATUSES)[number];

export const STATUS_LABEL: Record<ResponseStatus, string> = {
  P: 'Pass',
  F: 'Fail',
  A: 'Accepted',
  N: 'N/A',
};

const rowSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]+$/),
  name: z.string().min(1),
  acceptance: z.string().optional(),
  location: z.string().optional(),
  specText: z.string().optional(),
  unit: z.string().optional(),
  limitNote: z.string().optional(),
});
export type FormRow = z.infer<typeof rowSchema>;

const sectionSchema = z.object({
  key: z.string().regex(/^[A-Za-z0-9_]+$/),
  letter: z.string(),
  title: z.string().min(1),
  pattern: z.enum(SECTION_PATTERNS),
  scope: z.enum(['inspection', 'unit']),
  optional: z.boolean(),
  rows: z.array(rowSchema),
  params: z
    .object({
      boreCount: z.number().int().min(1).max(20).optional(),
      cylinderCount: z.number().int().min(1).max(16).optional(),
      intakeCount: z.number().int().min(1).max(4).optional(),
      exhaustCount: z.number().int().min(1).max(4).optional(),
    })
    .optional(),
});
export type FormSection = z.infer<typeof sectionSchema>;

export const formDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    formNumber: z.string().regex(/^PDI-IQI-[0-9A-Z]+$/),
    component: z.string().min(1),
    revisionLabel: z.string().nullable(),
    /** Governed one-off form built for a single inspection (FR-042); never a released template. */
    oneOff: z.boolean().optional(),
    sections: z.array(sectionSchema).min(1),
  })
  .superRefine((def, ctx) => {
    const keys = new Set<string>();
    for (const section of def.sections) {
      if (keys.has(section.key)) ctx.addIssue({ code: 'custom', message: `duplicate section key ${section.key}` });
      keys.add(section.key);
      const rowKeys = new Set<string>();
      for (const row of section.rows) {
        if (rowKeys.has(row.key)) ctx.addIssue({ code: 'custom', message: `duplicate row ${section.key}.${row.key}` });
        rowKeys.add(row.key);
      }
      if (section.scope === 'inspection' && section.pattern !== 'pfn_checklist') {
        ctx.addIssue({ code: 'custom', message: `section ${section.key}: only checklist sections may be inspection-scope` });
      }
    }
  });
export type FormDefinition = z.infer<typeof formDefinitionSchema>;

/**
 * Every row pattern accepts P/F/A/N. Appendix A uses N/A on the shared receiving
 * checklist; other patterns contain conditional rows (e.g. "two-piece only") that need a
 * deliberate N/A, so outside the receiving checklist an N/A requires a reason note.
 */
export function allowedStatuses(_pattern: SectionPattern): ResponseStatus[] {
  return ['P', 'F', 'A', 'N'];
}

export function noteRequired(pattern: SectionPattern, status: ResponseStatus | null): boolean {
  if (status === 'F' || status === 'A') return true;
  return status === 'N' && pattern !== 'pfn_checklist';
}

/** Fail/Accepted checklist rows need a directly associated photograph (FR-044/FR-047). */
export function photoRequired(pattern: SectionPattern, status: ResponseStatus | null): boolean {
  return isChecklist(pattern) && (status === 'F' || status === 'A');
}

export function isChecklist(pattern: SectionPattern): boolean {
  return pattern === 'pfn_checklist' || pattern === 'pass_fail_checklist' || pattern === 'pfn_visual';
}

/** Checklist sections that "Pass All" may fill. Measurement sections are never filled. */
export function isPassAllEligible(section: FormSection): boolean {
  return isChecklist(section.pattern);
}

/**
 * An answerable row within a section: checklist/measurement rows come from the form;
 * specialized series sections expand to per-bore/per-cylinder rows.
 */
export interface AnswerRow {
  key: string;
  label: string;
  /** Reading keys captured for this row (empty for pure checklists). */
  readingKeys: string[];
  readingLabels: string[];
  /** All readings must be entered when the row is answered. */
  allReadingsRequired: boolean;
  /** Key used to resolve a governing limit from the technical baseline. */
  limitRef: string | null;
  /** Vacuum valve sub-result: only applicable when the parent cylinder fails. */
  parentKey?: string;
  source?: FormRow;
}

function series(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`);
}

export function sectionRows(section: FormSection): AnswerRow[] {
  const p = section.params ?? {};
  switch (section.pattern) {
    case 'pfn_checklist':
    case 'pass_fail_checklist':
    case 'pfn_visual':
      return section.rows.map((row) => ({
        key: row.key,
        label: row.name,
        readingKeys: [],
        readingLabels: [],
        allReadingsRequired: false,
        limitRef: null,
        source: row,
      }));
    case 'dimensional':
      return section.rows.map((row) => ({
        key: row.key,
        label: row.name,
        readingKeys: ['a1', 'a2', 'a3'],
        readingLabels: ['Actual 1', 'Actual 2', 'Actual 3'],
        allReadingsRequired: false,
        limitRef: `dimensional:${row.key}`,
        source: row,
      }));
    case 'general_measurements':
      return section.rows.map((row) => ({
        key: row.key,
        label: row.name,
        readingKeys: ['value'],
        readingLabels: ['Actual'],
        allReadingsRequired: true,
        limitRef: `general_measurements:${row.key}`,
        source: row,
      }));
    case 'camshaft_bore': {
      const n = p.boreCount ?? 7;
      return [
        {
          key: 'bore',
          label: 'Camshaft bore diameter',
          readingKeys: series('b', n),
          readingLabels: series('Bore ', n),
          allReadingsRequired: true,
          limitRef: 'camshaft_bore:bore',
        },
      ];
    }
    case 'fire_ring_protrusion': {
      const n = p.cylinderCount ?? 6;
      return [
        {
          key: 'protrusion',
          label: 'Fire ring protrusion',
          readingKeys: series('c', n),
          readingLabels: series('C', n),
          allReadingsRequired: true,
          limitRef: 'fire_ring_protrusion:protrusion',
        },
      ];
    }
    case 'groove_specs': {
      const n = p.cylinderCount ?? 6;
      return section.rows.map((row) => ({
        key: row.key,
        label: row.name,
        readingKeys: series('c', n),
        readingLabels: series('C', n),
        allReadingsRequired: true,
        limitRef: `groove_specs:${row.key}`,
        source: row,
      }));
    }
    case 'valve_recession': {
      const n = p.cylinderCount ?? 6;
      const ni = p.intakeCount ?? 2;
      const ne = p.exhaustCount ?? 2;
      const keys = [...series('int', ni), ...series('exh', ne)];
      const labels = [...series('Int ', ni), ...series('Exh ', ne)];
      return series('c', n).map((cyl, i) => ({
        key: cyl,
        label: `Cylinder ${i + 1}`,
        readingKeys: keys,
        readingLabels: labels,
        allReadingsRequired: true,
        // Intake and exhaust readings resolve separate limits; see readingLimitRef().
        limitRef: 'valve_recession',
      }));
    }
    case 'vacuum_test': {
      const n = p.cylinderCount ?? 6;
      const ni = p.intakeCount ?? 2;
      const ne = p.exhaustCount ?? 2;
      const rows: AnswerRow[] = [];
      series('c', n).forEach((cyl, i) => {
        rows.push({ key: cyl, label: `Cylinder ${i + 1}`, readingKeys: [], readingLabels: [], allReadingsRequired: false, limitRef: null });
        [...series('int', ni), ...series('exh', ne)].forEach((valve) => {
          const label = valve.startsWith('int') ? `Intake ${valve.slice(3)}` : `Exhaust ${valve.slice(3)}`;
          rows.push({
            key: `${cyl}_${valve}`,
            label: `Cylinder ${i + 1} — ${label} valve`,
            readingKeys: [],
            readingLabels: [],
            allReadingsRequired: false,
            limitRef: null,
            parentKey: cyl,
          });
        });
      });
      return rows;
    }
  }
}

/** Limit reference for an individual reading (valve recession splits intake vs exhaust). */
export function readingLimitRef(row: AnswerRow, readingKey: string): string | null {
  if (row.limitRef === 'valve_recession') {
    return readingKey.startsWith('int') ? 'valve_recession:intake' : 'valve_recession:exhaust';
  }
  return row.limitRef;
}

export function sectionTitle(section: FormSection): string {
  return section.letter ? `${section.letter}. ${section.title}` : section.title;
}

export function formLabel(def: Pick<FormDefinition, 'formNumber' | 'component' | 'revisionLabel'>): string {
  const rev = def.revisionLabel ? ` · Rev ${def.revisionLabel}` : '';
  return `${def.formNumber} · ${def.component}${rev}`;
}

/** Deterministic JSON (sorted object keys) so hashes survive jsonb storage round-trips. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  const withToJson = value as { toJSON?: () => unknown };
  if (typeof withToJson.toJSON === 'function') return canonicalJson(withToJson.toJSON());
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}
