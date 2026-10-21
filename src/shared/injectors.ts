/**
 * Injector bench data vocabulary. No bench protocol or authoritative pass/fail rule has been
 * provided yet (POL-08), so imports use an interim, PDI-defined CSV layout. It is not a
 * CarbonZapp format and must be validated against real bench samples before production use.
 */

export const BENCH_ADAPTER = 'TQMS-BENCH-CSV-1';
export const BENCH_ADAPTER_NOTE = 'Interim synthetic CSV layout (POL-08 open) — not a CarbonZapp or live-bench integration';

/** Required header, one row per measured parameter of a test. */
export const BENCH_COLUMNS = [
  'machine_id',
  'test_plan',
  'serial_number',
  'part_number',
  'tested_at',
  'test_seq',
  'operator',
  'condition',
  'parameter',
  'unit',
  'value',
  'result',
] as const;

export const REPAIR_ACTION_TYPES = ['ADJUSTMENT', 'COMPONENT_REPLACEMENT', 'CLEANING', 'OTHER'] as const;
export const REPAIR_ACTION_TEXT: Record<(typeof REPAIR_ACTION_TYPES)[number], string> = {
  ADJUSTMENT: 'Adjustment',
  COMPONENT_REPLACEMENT: 'Component replaced',
  CLEANING: 'Cleaning',
  OTHER: 'Other',
};

/** Labels offered for quick workshop entry; they carry no limits. */
export const QUICK_MEASUREMENTS = ['Shim thickness', 'Spring preload', 'Needle lift', 'Armature stroke', 'Opening pressure'];

export const METRICS_VERSION = 'METRICS-INTERIM-1';

const slug = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

/**
 * A released baseline characteristic governs a bench result when its form-row reference is
 * `injector:<condition>__<parameter>` (FUNCTIONAL characteristics on the injector part).
 */
export const criteriaRef = (condition: string, parameter: string) => `injector:${slug(condition)}__${slug(parameter)}`;

export const normalizeSerial = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and CR/LF inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  while (i < src.length) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      row.push(field);
      field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
      if (c === '\r' && src[i + 1] === '\n') i += 1;
    } else {
      field += c;
    }
    i += 1;
  }
  if (quoted) throw new Error('Unterminated quoted field');
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

/** CSV cell for export: quoted, with spreadsheet formula triggers neutralized (C10). */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = value instanceof Date ? value.toISOString() : String(value);
  // Plain numbers (e.g. -0.25) stay numeric; anything else starting with a formula trigger is prefixed.
  if (/^[=+\-@\t\r]/.test(s) && !/^[-+]?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return `"${s.replaceAll('"', '""')}"`;
}

export const toCsv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
