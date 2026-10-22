/**
 * CarbonZapp test-bench reports (owner decision 22 Oct 2026). Step naming, bench error text and
 * the PASS / FAIL / DNF / UNKNOWN classification follow the owner's existing injector module
 * (INJECTOR_TESTS_TECHNICAL_DESCRIPTION, §7–§9): a result is judged against the bench's GREEN
 * acceptance band, never against the bench's own `result_pass` flag (which reflects the tighter
 * blue band); a bench error never renames a step; flush (FL(W)) is internal and never reported.
 */

export const CARBONZAPP_ADAPTER = 'CARBONZAPP-API-1';
export const CARBONZAPP_NOTE = 'CarbonZapp cloud API (getReports); one result per injector per bench slot';

export type BenchOutcome = 'PASS' | 'FAIL' | 'DNF' | 'UNKNOWN';
type StepOutcome = BenchOutcome | 'SKIP';
type TankStatus = 'pass' | 'fail' | 'skip';

const EPS = 1e-6;

/** Fields copied from the bench report that identify customers or jobs; they are never stored. */
export const PRIVATE_FIELDS = ['job', 'drs_id', 'customer_name', 'customer_phone', 'customer_mail', 'customer_notes'] as const;

export interface CzTank {
  tank_name?: string | null;
  tank_unit?: string | null;
  text_green?: string | null;
  min_green?: string | number | null;
  max_green?: string | number | null;
  target_blue?: string | number | null;
  tol_blue?: string | number | null;
  AvrResult?: string | number | null;
  results?: string | null;
  result_pass?: number | string | null;
}

export interface CzTestInfo {
  test_name?: string | null;
  test_order?: number | string | null;
  status?: number | string | null;
  test_category_id?: number | string | null;
  rpm?: string | number | null;
  hp?: string | number | null;
  lp?: string | number | null;
  inj_1?: string | number | null;
  strk?: string | number | null;
}

export interface CzReport {
  _id?: string | number | null;
  machine_name?: string | null;
  machine_sn?: string | number | null;
  actuator_code?: string | null;
  actuator_Brand?: string | null;
  actuator_type?: string | null;
  datetime?: string | null;
  created_at?: string | null;
  status?: number | string | null;
  job?: string | null;
  drs_id?: string | number | null;
  SlotsData?: { position?: number | string | null; sn?: string | null } | null;
  AllTests?: Array<{ TestInfo?: CzTestInfo | null; PrimaryTank?: CzTank | null; SecondaryTank?: CzTank | null }> | null;
  [key: string]: unknown;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (!s || !/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

// ---- §8 Step codes, names and bench error text --------------------------------------------

/** `iVM.01`, `IVM 01`, `ivm1` → `IVM01`; `Warm Up` → `WARMUP`; `FL(W)` → `FLW`. */
export function normaliseStepCode(name: string): string {
  const code = name.split(':')[0]!.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return code.replace(/^([A-Z]+)(\d)$/, '$10$2');
}

const STEP_NAMES: Record<string, string | { primary: string; secondary: string }> = {
  ERL: { primary: 'Resistance', secondary: 'Inductance' },
  LKT01: 'Leak Test 200 bar',
  LKT02: 'Leak Test 1800 bar',
  LKT04: 'Leak Test 2400 bar',
  WARMUP: 'Warm Up',
  IVM01: 'Peak HP',
  IVM02: 'Emissions',
  IVM03: 'Low Idle',
  IVM04: 'Mid-Range',
  IVM05: 'Cranking',
  IVM06: 'Peak Torque',
  RSP: 'Response Time',
  ANOP: 'Opening Pressure',
  FLW: 'Flush',
};
const FLUSH = 'FLW';

const ERROR_HINTS = /(error|fail|out\s*of\s*range|invalid|timeout|timed\s*out|communication|abort|overflow|no\s*result|not\s*measured)/i;
const NAMED_CONDITIONS: Array<[RegExp, string]> = [[/excess\s*return/i, 'Excess Return']];
const SMALL_WORDS = new Set(['of', 'the', 'a', 'an', 'and', 'or', 'in', 'to', 'at', 'by', 'for', 'on', 'with', 'from']);

/** `"eRL : SKIPPED"` → skipped; `"iVM.06 : HP ERROR (out of range) #1000"` → errored with its note. */
export function splitStepName(raw: string): { base: string; errored: boolean; skipped: boolean; errorRaw: string } {
  const idx = raw.indexOf(':');
  if (idx < 0) return { base: raw.trim(), errored: false, skipped: false, errorRaw: '' };
  const base = raw.slice(0, idx).trim();
  const suffix = raw.slice(idx + 1).trim();
  if (/^skipped$/i.test(suffix)) return { base, errored: false, skipped: true, errorRaw: '' };
  if (ERROR_HINTS.test(suffix) || normaliseStepCode(base) in STEP_NAMES) return { base, errored: true, skipped: false, errorRaw: suffix };
  return { base: raw.trim(), errored: false, skipped: false, errorRaw: '' };
}

export function formatErrorDescription(raw: string): string {
  const s = raw.trim();
  if (!s) return 'Test Error';
  for (const [re, name] of NAMED_CONDITIONS) if (re.test(s)) return name;
  const paren = /\(([^)]*[A-Za-z][^)]*)\)/.exec(s)?.[1];
  let d = paren ?? s.replace(/#\d+/g, '').replace(/\berrors?\b/gi, '').replace(/[:;,]/g, '');
  d = d.replace(/#\d+/g, '').replace(/\s+/g, ' ').trim();
  if (!d) return 'Test Error';
  if (/^[A-Z]{1,3}$/.test(d)) return `${d} Error`;
  return d
    .split(' ')
    .map((w, i) => {
      if (/^[A-Z0-9]{2,}$/.test(w)) return w;
      const lower = w.toLowerCase();
      if (i > 0 && SMALL_WORDS.has(lower)) return lower;
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

export function formatErrorValue(description: string): string {
  if (!description) return 'Error: Test Error';
  if (NAMED_CONDITIONS.some(([, name]) => name === description)) return description;
  return `Error: ${description}`;
}

/** The measured quantity of a tank: delivery `[D]`, return `[R]`, response time `[RSP]`. */
function tankQuantity(code: string, role: 'primary' | 'secondary', tankName: string): string {
  if (code === 'ERL') return role === 'primary' ? 'Resistance' : 'Inductance';
  const t = tankName.replace(/[[\]\s]/g, '').toUpperCase();
  if (t === 'D') return 'Delivery';
  if (t === 'R') return 'Return';
  if (t === 'RSP') return 'Response time';
  return t || (role === 'primary' ? 'Result' : 'Secondary');
}

/** Display name as the owner's reports print it, e.g. `Peak HP [R]`, `Peak Torque - Return`, `Leak Test 200 bar [R]`. */
export function stepDisplayName(base: string, role: 'primary' | 'secondary', tankName: string | null | undefined): string {
  const code = normaliseStepCode(base);
  const tank = text(tankName).replace(/[[\]\s]/g, '').toUpperCase();
  if (code === 'IVM06') return tank === 'R' || role === 'secondary' ? 'Peak Torque - Return' : 'Peak Torque - Delivery';
  const entry = STEP_NAMES[code];
  if (entry && typeof entry === 'object') return entry[role];
  const label = entry ?? (code || base.trim());
  return tank === 'R' ? `${label} [R]` : label;
}

// ---- §7 Normalised steps and tanks --------------------------------------------------------

export interface TankView {
  role: 'primary' | 'secondary';
  tankName: string;
  unit: string;
  /** Bench green-band text with its unit, e.g. `235.0 +/- 14.1 mm3/STRK`. */
  spec: string;
  min: number | null;
  max: number | null;
  /** Band limits exactly as the bench wrote them (keeps its decimals). */
  minText: string | null;
  maxText: string | null;
  /** Average reading as the bench reported it (or the mean of the raw readings). */
  value: string;
  status: TankStatus;
}

export interface Step {
  code: string;
  base: string;
  order: number;
  flush: boolean;
  skipped: boolean;
  errored: boolean;
  errorDescription: string;
  conditions: string;
  /** Preliminary status from the tanks; the step outcome replaces it (§9). */
  status: TankStatus;
  primary: TankView | null;
  secondary: TankView | null;
}

function decimalsOf(s: string): number {
  const m = /\.(\d+)$/.exec(s.trim());
  return m ? m[1]!.length : 0;
}

/** Mean of `"273.2~273.1~273.0"`, rounded to the most decimals seen (at most 4). */
export function averageOfRawResults(results: string | null | undefined): string {
  const parts = text(results)
    .split(/[~,;|]/)
    .map((p) => p.trim())
    .filter(Boolean);
  const values = parts.map((p) => ({ p, n: num(p) })).filter((x) => x.n !== null) as Array<{ p: string; n: number }>;
  if (!values.length) return '';
  const decimals = Math.min(4, Math.max(...values.map((v) => decimalsOf(v.p))));
  return (values.reduce((a, v) => a + v.n, 0) / values.length).toFixed(decimals);
}

function tankStatus(tank: CzTank): TankStatus {
  const avr = num(tank.AvrResult);
  const lo = num(tank.min_green);
  const hi = num(tank.max_green);
  if (avr !== null && (lo !== null || hi !== null)) {
    return (lo === null || avr >= lo - EPS) && (hi === null || avr <= hi + EPS) ? 'pass' : 'fail';
  }
  const rp = num(tank.result_pass);
  return rp === 1 ? 'pass' : rp === 2 ? 'fail' : 'skip';
}

function tankView(tank: CzTank | null | undefined, role: 'primary' | 'secondary', errored: boolean, errorValue: string): TankView | null {
  if (!tank && !errored) return null;
  const t = tank ?? {};
  const unit = text(t.tank_unit);
  const green = text(t.text_green);
  const avr = num(t.AvrResult);
  const value = avr !== null ? text(t.AvrResult) : averageOfRawResults(t.results) || (errored ? errorValue : '');
  return {
    role,
    tankName: text(t.tank_name),
    unit,
    spec: green ? `${green}${unit ? ` ${unit}` : ''}` : unit,
    min: num(t.min_green),
    max: num(t.max_green),
    minText: num(t.min_green) === null ? null : text(t.min_green),
    maxText: num(t.max_green) === null ? null : text(t.max_green),
    value,
    status: tankStatus(t),
  };
}

function conditionsText(info: CzTestInfo): string {
  return (
    [
      ['RPM', info.rpm],
      ['HP', info.hp],
      ['LP', info.lp],
      ['Inj', info.inj_1],
      ['Strk', info.strk],
    ] as const
  )
    .filter(([, v]) => text(v) && text(v) !== '--')
    .map(([k, v]) => `${k} ${text(v)}`)
    .join(' · ');
}

export function normaliseSteps(report: CzReport): Step[] {
  return (report.AllTests ?? []).map((t, index) => {
    const info = t?.TestInfo ?? {};
    const parsed = splitStepName(text(info.test_name));
    const errored = parsed.errored;
    const skipped = num(info.status) === 1 && !errored;
    const errorDescription = errored ? formatErrorDescription(parsed.errorRaw) : '';
    const errorValue = errored ? formatErrorValue(errorDescription) : '';
    const primary = tankView(t?.PrimaryTank, 'primary', errored, errorValue);
    const secondary = t?.SecondaryTank ? tankView(t.SecondaryTank, 'secondary', errored, errorValue) : null;
    const tanks = [primary, secondary].filter(Boolean) as TankView[];
    let status: TankStatus = 'skip';
    if (!skipped && primary && !errored) status = tanks.some((x) => x.status === 'fail') ? 'fail' : tanks.some((x) => x.status === 'pass') ? 'pass' : 'skip';
    const code = normaliseStepCode(parsed.base);
    return {
      code,
      base: parsed.base,
      order: num(info.test_order) ?? index,
      flush: code === FLUSH,
      skipped,
      errored,
      errorDescription,
      conditions: conditionsText(info),
      status,
      primary,
      secondary,
    };
  });
}

// ---- §9 Classification ---------------------------------------------------------------------

const isErrorValue = (v: string) => /^error/i.test(v) || NAMED_CONDITIONS.some(([, name]) => name === v);

function measured(tank: TankView): number | null {
  return isErrorValue(tank.value) ? null : num(tank.value);
}

function tankWasEvaluated(step: Step, tank: TankView): boolean {
  const v = measured(tank);
  // CarbonZapp writes 0 into interrupted steps that never ran.
  return v !== null && !(step.errored && Math.abs(v) <= EPS);
}

const hasRange = (tank: TankView) => tank.min !== null || tank.max !== null;

function outOfBounds(step: Step, tank: TankView): boolean {
  if (!tankWasEvaluated(step, tank) || !hasRange(tank)) return false;
  const v = measured(tank)!;
  return (tank.min !== null && v < tank.min - EPS) || (tank.max !== null && v > tank.max + EPS);
}

export function measurementOutcome(step: Step, tank: TankView | null): BenchOutcome {
  if (!tank) return step.errored ? 'DNF' : 'UNKNOWN';
  if (step.errored) {
    if (outOfBounds(step, tank)) return 'FAIL';
    return tankWasEvaluated(step, tank) && hasRange(tank) ? 'PASS' : 'DNF';
  }
  return tank.status === 'pass' ? 'PASS' : tank.status === 'fail' ? 'FAIL' : 'UNKNOWN';
}

const tanksOf = (step: Step) => [step.primary, step.secondary].filter(Boolean) as TankView[];

function explicitFailure(step: Step): boolean {
  if (step.errored) return tanksOf(step).some((t) => outOfBounds(step, t));
  return step.status === 'fail' || tanksOf(step).some((t) => t.status === 'fail');
}

export function stepOutcome(step: Step): StepOutcome {
  if (step.skipped) return 'SKIP';
  if (explicitFailure(step)) return 'FAIL';
  if (step.errored) return 'DNF';
  if (step.status === 'skip') return 'SKIP';
  if (tanksOf(step).some((t) => measurementOutcome(step, t) === 'PASS') || step.status === 'pass') return 'PASS';
  return 'UNKNOWN';
}

/** One injector's result: the first bench error decides between FAIL (a real failure first) and DNF. */
export function injectorOutcome(steps: Step[]): BenchOutcome {
  if (!steps.length) return 'UNKNOWN';
  const ordered = steps.map((s, i) => ({ s, i })).sort((a, b) => a.s.order - b.s.order || a.i - b.i).map((x) => x.s);
  const firstError = ordered.findIndex((s) => s.errored);
  if (firstError >= 0) {
    const earlierFailure = ordered.slice(0, firstError).some((s) => !s.flush && explicitFailure(s));
    const errored = ordered[firstError]!;
    return earlierFailure || (!errored.flush && explicitFailure(errored)) ? 'FAIL' : 'DNF';
  }
  const customer = ordered.filter((s) => !s.flush);
  if (customer.some(explicitFailure)) return 'FAIL';
  if (customer.some((s) => stepOutcome(s) === 'PASS')) return 'PASS';
  return 'UNKNOWN';
}

/** Scored points: customer steps that ran and have a measurement or a bench error. */
export function scorecard(steps: Step[]) {
  const points = steps.filter((s) => !s.flush && !s.skipped && (s.primary || s.errored));
  return {
    outcome: injectorOutcome(steps),
    total: points.length,
    passed: points.filter((s) => stepOutcome(s) === 'PASS').length,
    failed: points.filter(explicitFailure).length,
  };
}

// ---- Reading a report ----------------------------------------------------------------------

export interface BenchResultRow {
  /** Display name as the owner's reports print it (unique within one test). */
  condition: string;
  parameter: string;
  unit: string | null;
  value: string;
  verdict: 'PASS' | 'FAIL' | null;
  bench: { position: number; spec: string | null; lower: string | null; upper: string | null; outcome: BenchOutcome; note: string | null; conditions: string | null };
}

export interface ReadReport {
  reportId: string;
  slot: number;
  serial: string;
  partNumber: string;
  brand: string | null;
  injectorType: string | null;
  machineName: string | null;
  machineSerial: string;
  testedAt: string;
  outcome: BenchOutcome;
  stepsTotal: number;
  stepsPassed: number;
  stepsFailed: number;
  results: BenchResultRow[];
}

export type ExclusionReason = 'serial_starts_with_r' | 'job_contains_rma';

/** Fixed import exclusions (§6.2): repair re-run serials starting with R, and RMA jobs. */
export function exclusionReasons(r: CzReport): ExclusionReason[] {
  const reasons: ExclusionReason[] = [];
  if (/^R/i.test(text(r.SlotsData?.sn))) reasons.push('serial_starts_with_r');
  if (/RMA/i.test(text(r.job) || text(r.drs_id))) reasons.push('job_contains_rma');
  return reasons;
}

export const EXCLUSION_TEXT: Record<ExclusionReason, string> = {
  serial_starts_with_r: 'Serial number starts with R (repair re-run)',
  job_contains_rma: 'Job number contains RMA',
};

/** The report without job and customer fields, which are never stored. */
export function sanitiseReport(r: CzReport): CzReport {
  const copy: CzReport = { ...r };
  for (const f of PRIVATE_FIELDS) delete copy[f];
  return copy;
}

/** Validates the identity of one bench report and turns its steps into result rows. */
export function readReport(r: CzReport): { ok: true; report: ReadReport } | { ok: false; reason: string } {
  if (!r || typeof r !== 'object') return { ok: false, reason: 'Not a bench report object' };
  const reportId = text(r._id);
  if (!reportId) return { ok: false, reason: 'Report has no _id' };
  const serial = text(r.SlotsData?.sn);
  if (!serial || serial === '-') return { ok: false, reason: 'No injector serial number' };
  const partNumber = text(r.actuator_code);
  if (!partNumber || partNumber === '-') return { ok: false, reason: 'No injector part number (actuator_code)' };
  const when = text(r.datetime) || text(r.created_at);
  const time = when ? new Date(when) : null;
  if (!time || Number.isNaN(time.getTime())) return { ok: false, reason: `Test time "${when}" is not a valid date` };
  const slot = num(r.SlotsData?.position) ?? 0;
  if (!Number.isInteger(slot) || slot < 0) return { ok: false, reason: 'Slot position is not a whole number' };

  const steps = normaliseSteps(r);
  const card = scorecard(steps);
  const results: BenchResultRow[] = [];
  const seen = new Set<string>();
  let position = 0;
  for (const step of [...steps].sort((a, b) => a.order - b.order)) {
    if (step.flush || step.skipped || !(step.primary || step.errored)) continue;
    const tanks: Array<TankView | null> = step.primary || step.secondary ? [step.primary, step.secondary] : [null];
    for (const tank of tanks) {
      if (tank === null && (step.primary || step.secondary)) continue;
      const role = tank?.role ?? 'primary';
      let condition = stepDisplayName(step.base, role, tank?.tankName);
      const parameter = tank ? tankQuantity(step.code, role, tank.tankName) : 'Result';
      // Two identical names in one report (a repeated step) stay distinct.
      if (seen.has(`${condition}|${parameter}`.toLowerCase())) condition = `${condition} (step ${step.order})`;
      seen.add(`${condition}|${parameter}`.toLowerCase());
      const outcome = measurementOutcome(step, tank);
      const value = tank?.value || (step.errored ? formatErrorValue(step.errorDescription) : '');
      results.push({
        condition,
        parameter,
        unit: tank?.unit || null,
        value: value || 'No result',
        verdict: outcome === 'PASS' || outcome === 'FAIL' ? outcome : null,
        bench: {
          position: position++,
          spec: tank?.spec || null,
          lower: tank?.minText ?? null,
          upper: tank?.maxText ?? null,
          outcome,
          note: step.errored ? step.errorDescription : null,
          conditions: step.conditions || null,
        },
      });
    }
  }
  return {
    ok: true,
    report: {
      reportId,
      slot,
      serial,
      partNumber,
      brand: text(r.actuator_Brand) || null,
      injectorType: text(r.actuator_type) || null,
      machineName: text(r.machine_name) || null,
      machineSerial: text(r.machine_sn) || text(r.machine_name) || 'CARBONZAPP',
      testedAt: time.toISOString(),
      outcome: card.outcome,
      stepsTotal: card.total,
      stepsPassed: card.passed,
      stepsFailed: card.failed,
      results,
    },
  };
}

/** Accepted payload shapes (§5.2): an array, an object holding one in data/reports/results, or one report. */
export function reportsFromPayload(payload: unknown): CzReport[] | null {
  if (Array.isArray(payload)) return payload as CzReport[];
  if (payload && typeof payload === 'object') {
    const o = payload as Record<string, unknown>;
    for (const k of ['data', 'reports', 'results']) if (Array.isArray(o[k])) return o[k] as CzReport[];
    if ('_id' in o) return [o as CzReport];
  }
  return null;
}

/** Same key the bench uses to tell injectors of one run apart. */
export const reportKey = (r: CzReport) => `${text(r._id)}|${num(r.SlotsData?.position) ?? 0}`;

export function reportTime(r: CzReport): Date | null {
  const when = text(r.datetime) || text(r.created_at);
  const d = when ? new Date(when) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

/** Inclusive green band as text, e.g. `220.9 – 249.1 mm3/STRK`; the bench text when no band is given. */
export function specText(row: { unit: string | null; bench: { spec: string | null; lower: string | null; upper: string | null } | null }): string {
  const b = row.bench;
  if (!b) return '';
  const unit = row.unit ? ` ${row.unit}` : '';
  if (b.lower !== null && b.upper !== null) return `${b.lower} – ${b.upper}${unit}`;
  if (b.lower !== null) return `≥ ${b.lower}${unit}`;
  if (b.upper !== null) return `≤ ${b.upper}${unit}`;
  return b.spec ?? '';
}
