/**
 * Exact decimal handling for recorded measurements. Values are kept as the text the
 * inspector entered; comparisons use scaled BigInt arithmetic so a recorded value is
 * never rounded into or out of tolerance.
 */

const DECIMAL_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;
export const MAX_READING_LENGTH = 24;

export interface ParsedReading {
  /** Text as entered (trimmed). */
  text: string;
  /** Canonical decimal string suitable for a PostgreSQL numeric column. */
  canonical: string;
  /** Number of decimal places recorded (source precision). */
  decimals: number;
}

export type ParseResult = { ok: true; value: ParsedReading } | { ok: false; error: string };

export function parseReading(raw: string): ParseResult {
  const text = raw.trim();
  if (text.length === 0) return { ok: false, error: 'Reading is empty' };
  if (text.length > MAX_READING_LENGTH) return { ok: false, error: 'Reading is too long' };
  if (!DECIMAL_RE.test(text)) return { ok: false, error: `"${text}" is not a number` };
  const negative = text.startsWith('-');
  const unsigned = text.replace(/^[+-]/, '');
  const [intPartRaw = '', fracPart = ''] = unsigned.split('.');
  const intPart = intPartRaw.replace(/^0+(?=\d)/, '') || '0';
  const canonical = `${negative ? '-' : ''}${intPart}${fracPart ? `.${fracPart}` : ''}`;
  return { ok: true, value: { text, canonical, decimals: fracPart.length } };
}

interface Scaled {
  digits: bigint;
  scale: number;
}

function toScaled(decimal: string): Scaled {
  const negative = decimal.startsWith('-');
  const unsigned = decimal.replace(/^[+-]/, '');
  const [i = '0', f = ''] = unsigned.split('.');
  const digits = BigInt(`${i || '0'}${f}`);
  return { digits: negative ? -digits : digits, scale: f.length };
}

/** Compare two decimal strings exactly. Returns -1, 0 or 1. */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const x = toScaled(a);
  const y = toScaled(b);
  const scale = Math.max(x.scale, y.scale);
  const xd = x.digits * 10n ** BigInt(scale - x.scale);
  const yd = y.digits * 10n ** BigInt(scale - y.scale);
  return xd < yd ? -1 : xd > yd ? 1 : 0;
}

export interface GoverningLimit {
  /** Characteristic key in the released baseline. */
  charKey: string;
  name: string;
  unit: string;
  lower: string | null;
  upper: string | null;
  baselineRevision: string;
  synthetic: boolean;
}

export type ReadingEvaluation = 'WITHIN' | 'OUTSIDE' | 'NO_LIMIT';

export function evaluateReading(canonical: string, limit: GoverningLimit | null | undefined): ReadingEvaluation {
  if (!limit || (limit.lower === null && limit.upper === null)) return 'NO_LIMIT';
  if (limit.lower !== null && compareDecimal(canonical, limit.lower) < 0) return 'OUTSIDE';
  if (limit.upper !== null && compareDecimal(canonical, limit.upper) > 0) return 'OUTSIDE';
  return 'WITHIN';
}

export function formatLimit(limit: GoverningLimit): string {
  if (limit.lower !== null && limit.upper !== null) return `${limit.lower} – ${limit.upper} ${limit.unit}`;
  if (limit.lower !== null) return `≥ ${limit.lower} ${limit.unit}`;
  if (limit.upper !== null) return `≤ ${limit.upper} ${limit.unit}`;
  return 'No numeric limit';
}
