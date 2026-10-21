import {
  type AnswerRow,
  type FormDefinition,
  type FormSection,
  type ResponseStatus,
  noteRequired,
  photoRequired,
  readingLimitRef,
  sectionRows,
} from './forms.js';
import { type GoverningLimit, type ReadingEvaluation, evaluateReading, parseReading } from './measurement.js';

export type Outcome = 'PASS' | 'FAIL' | 'ACCEPTED';

const OUTCOME_RANK: Record<Outcome, number> = { PASS: 0, ACCEPTED: 1, FAIL: 2 };

/** Worst-case rule: FAIL > ACCEPTED > PASS. Returns null when nothing is decided. */
export function worstOutcome(outcomes: Array<Outcome | null | undefined>): Outcome | null {
  let worst: Outcome | null = null;
  for (const o of outcomes) {
    if (!o) continue;
    if (worst === null || OUTCOME_RANK[o] > OUTCOME_RANK[worst]) worst = o;
  }
  return worst;
}

export function statusOutcome(status: ResponseStatus | null | undefined): Outcome | null {
  if (status === 'P') return 'PASS';
  if (status === 'F') return 'FAIL';
  if (status === 'A') return 'ACCEPTED';
  return null;
}

export const rowId = (unitIndex: number, sectionKey: string, rowKey: string) => `${unitIndex}|${sectionKey}|${rowKey}`;
export const readingId = (unitIndex: number, sectionKey: string, rowKey: string, readingKey: string) =>
  `${unitIndex}|${sectionKey}|${rowKey}|${readingKey}`;
export const activationId = (unitIndex: number, sectionKey: string) => `${unitIndex}|${sectionKey}`;

export interface EntryState {
  responses: Record<string, { status: ResponseStatus | null; note: string | null }>;
  readings: Record<string, string>;
  photoCounts: Record<string, number>;
  activated: string[];
}

export interface EvaluationContext {
  definition: FormDefinition;
  unitCount: number;
  /** Governing limits from the released technical baseline, keyed by limit reference. */
  limits: Record<string, GoverningLimit>;
}

export interface Issue {
  unitIndex: number;
  sectionKey: string;
  rowKey: string | null;
  path: string;
  message: string;
}

export interface RowEvaluation {
  /** Measurement comparison against released limits (null for checklists). */
  measurement: ReadingEvaluation | 'INCOMPLETE' | null;
  readingResults: Record<string, ReadingEvaluation>;
}

export interface Evaluation {
  errors: Issue[];
  reviewReasons: Issue[];
  rows: Record<string, RowEvaluation>;
  unitOutcomes: Record<number, Outcome | null>;
  sharedOutcome: Outcome | null;
  overall: Outcome | null;
  requiredRows: number;
  answeredRows: number;
}

export function sectionIsActive(section: FormSection, unitIndex: number, activated: Set<string>): boolean {
  return !section.optional || activated.has(activationId(unitIndex, section.key));
}

function shortTitle(section: FormSection): string {
  // "DIMENSIONAL INSPECTION — Valve Recession" -> "Valve Recession"; "VISUAL INSPECTION" -> "Visual"
  const parts = section.title.split('—').map((s) => s.trim());
  const tail = parts.length > 1 ? parts[parts.length - 1]! : parts[0]!;
  const words = tail.replace(/ INSPECTION$/i, '').replace(/ VERIFICATION$/i, '').toLowerCase();
  return words.replace(/\b\w/g, (c) => c.toUpperCase());
}

export function issuePath(unitIndex: number, section: FormSection, rowLabel: string | null): string {
  const unit = unitIndex === 0 ? 'Receiving' : `Item ${unitIndex}`;
  return [unit, shortTitle(section), rowLabel].filter(Boolean).join(' → ');
}

export function evaluateInspection(ctx: EvaluationContext, state: EntryState): Evaluation {
  const activated = new Set(state.activated);
  const errors: Issue[] = [];
  const reviewReasons: Issue[] = [];
  const rows: Record<string, RowEvaluation> = {};
  const unitOutcomes: Record<number, Outcome | null> = {};
  const sharedStatuses: Array<Outcome | null> = [];
  let requiredRows = 0;
  let answeredRows = 0;

  const units = Array.from({ length: ctx.unitCount }, (_, i) => i + 1);

  for (const section of ctx.definition.sections) {
    const targets = section.scope === 'inspection' ? [0] : units;
    for (const unitIndex of targets) {
      if (!sectionIsActive(section, unitIndex, activated)) continue;
      const answerRows = sectionRows(section);
      for (const row of answerRows) {
        const id = rowId(unitIndex, section.key, row.key);
        const response = state.responses[id];
        const status = response?.status ?? null;
        const note = response?.note?.trim() ?? '';
        const issue = (message: string): Issue => ({
          unitIndex,
          sectionKey: section.key,
          rowKey: row.key,
          path: issuePath(unitIndex, section, row.label),
          message,
        });

        if (row.parentKey) {
          // Vacuum valve sub-result: required only when the cylinder failed.
          const parent = state.responses[rowId(unitIndex, section.key, row.parentKey)]?.status ?? null;
          if (parent === 'F') {
            requiredRows += 1;
            if (status === 'P' || status === 'F') answeredRows += 1;
            else errors.push(issue('valve result is required for a failed cylinder'));
          }
          continue;
        }

        requiredRows += 1;
        if (!status) {
          errors.push(issue('result is required (blank is not N/A)'));
        } else {
          answeredRows += 1;
          if (noteRequired(section.pattern, status) && !note) {
            errors.push(issue(status === 'N' ? 'reason for N/A is required' : 'observation note is required'));
          }
          if (photoRequired(section.pattern, status) && (state.photoCounts[id] ?? 0) < 1) {
            errors.push(issue('photograph of this characteristic is required'));
          }
        }

        const rowEval = evaluateMeasurements(ctx, state, unitIndex, section, row, status, issue, errors, reviewReasons);
        rows[id] = rowEval;

        const outcome = statusOutcome(status);
        if (unitIndex === 0) sharedStatuses.push(outcome);
        else unitOutcomes[unitIndex] = worstOutcome([unitOutcomes[unitIndex], outcome]);
        if (status === 'A') {
          reviewReasons.push(issue('Accepted condition — authorized review required'));
        }
      }
    }
  }

  const sharedOutcome = worstOutcome(sharedStatuses);
  for (const u of units) if (!(u in unitOutcomes)) unitOutcomes[u] = null;
  const overall = worstOutcome([sharedOutcome, ...units.map((u) => unitOutcomes[u])]);
  if (overall === 'FAIL') {
    reviewReasons.unshift({
      unitIndex: 0,
      sectionKey: '',
      rowKey: null,
      path: 'Inspection',
      message: 'Outcome FAIL — independent review required',
    });
  }
  return { errors, reviewReasons, rows, unitOutcomes, sharedOutcome, overall, requiredRows, answeredRows };
}

function evaluateMeasurements(
  ctx: EvaluationContext,
  state: EntryState,
  unitIndex: number,
  section: FormSection,
  row: AnswerRow,
  status: ResponseStatus | null,
  issue: (m: string) => Issue,
  errors: Issue[],
  reviewReasons: Issue[],
): RowEvaluation {
  if (row.readingKeys.length === 0) return { measurement: null, readingResults: {} };
  const readingResults: Record<string, ReadingEvaluation> = {};
  let entered = 0;
  let missingLimit = false;
  let outside = false;
  for (const rk of row.readingKeys) {
    const raw = state.readings[readingId(unitIndex, section.key, row.key, rk)];
    if (raw === undefined || raw.trim() === '') continue;
    const parsed = parseReading(raw);
    if (!parsed.ok) {
      errors.push(issue(`${parsed.error}`));
      continue;
    }
    entered += 1;
    const ref = readingLimitRef(row, rk);
    const limit = ref ? ctx.limits[ref] : undefined;
    const result = evaluateReading(parsed.value.canonical, limit);
    readingResults[rk] = result;
    if (result === 'NO_LIMIT') missingLimit = true;
    if (result === 'OUTSIDE') outside = true;
  }

  const answered = status === 'P' || status === 'F' || status === 'A';
  if (answered) {
    if (row.allReadingsRequired && entered < row.readingKeys.length) {
      errors.push(issue(`${row.readingKeys.length - entered} of ${row.readingKeys.length} readings missing`));
    } else if (!row.allReadingsRequired && entered === 0 && status === 'P') {
      errors.push(issue('at least one reading is required to record Pass'));
    }
  }
  if (outside && status === 'P') {
    errors.push(issue('reading outside the released limit — result cannot be Pass'));
  }
  if (answered && entered > 0 && missingLimit) {
    reviewReasons.push(issue('governing limit unavailable — Specification not released, Engineering review required'));
  }

  let measurement: RowEvaluation['measurement'];
  if (entered === 0) measurement = null;
  else if (outside) measurement = 'OUTSIDE';
  else if (missingLimit) measurement = 'NO_LIMIT';
  else if (entered < row.readingKeys.length && row.allReadingsRequired) measurement = 'INCOMPLETE';
  else measurement = 'WITHIN';
  return { measurement, readingResults };
}

/** Rows that "Pass All" would set for one unit + checklist section. */
export function passAllTargets(
  section: FormSection,
  unitIndex: number,
  state: EntryState,
): { fill: string[]; overwrite: Array<{ rowKey: string; status: ResponseStatus }> } {
  const fill: string[] = [];
  const overwrite: Array<{ rowKey: string; status: ResponseStatus }> = [];
  for (const row of sectionRows(section)) {
    const current = state.responses[rowId(unitIndex, section.key, row.key)]?.status ?? null;
    if (!current) fill.push(row.key);
    else if (current !== 'P') overwrite.push({ rowKey: row.key, status: current });
  }
  return { fill, overwrite };
}

/** Condenses review reasons for display: unreleased-limit rows are grouped by characteristic. */
export function summarizeReviewReasons(reasons: Array<Pick<Issue, 'path' | 'message'>>): string[] {
  const out: string[] = [];
  const unreleased = new Map<string, number>();
  for (const r of reasons) {
    if (r.message.startsWith('governing limit unavailable')) {
      const name = r.path.split(' → ').slice(-1)[0] ?? r.path;
      unreleased.set(name, (unreleased.get(name) ?? 0) + 1);
    } else if (r.path === 'Inspection') {
      out.push(r.message);
    } else {
      out.push(`${r.path}: ${r.message}`);
    }
  }
  if (unreleased.size) {
    const total = [...unreleased.values()].reduce((a, b) => a + b, 0);
    out.push(
      `Specification not released for ${total} recorded measurement(s) — ${[...unreleased.keys()].join(', ')}; readings reviewed as observations, not validated against limits`,
    );
  }
  return out;
}
