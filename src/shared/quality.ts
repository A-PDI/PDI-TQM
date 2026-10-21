/**
 * Stage 3 domain vocabulary and pure rules shared by server and browser: NCR and material
 * scope states, disposition outcomes, concessions, SCAR, supplier commitments and change
 * control. Interim policy rules carry a version string so a decision records which rule
 * applied (POLICY OPEN items stay visible in the policy register).
 */

export const NCR_BLOCKING_RULE = 'NCR-BLOCK-INTERIM-1 (POL-14 open)';
export const REMINDER_RULE = 'REMINDER-INTERIM-1 (POL-04 open)';
export const DISPOSITION_RULE = 'DISPOSITION-INTERIM-1 (POL-05 open)';

export const NCR_STATUS_TEXT: Record<string, string> = {
  OPEN: 'Open — material not yet contained',
  CONTAINED: 'Contained — awaiting disposition',
  DISPOSITIONED: 'Dispositioned — awaiting verification',
  VERIFIED_RESOLVED: 'Verified and resolved — ready to close',
  CLOSED: 'Closed',
};

export const SCOPE_STATE_TEXT: Record<string, string> = {
  ON_HOLD: 'On hold (physical segregation not yet verified)',
  SEGREGATED_VERIFIED: 'Segregation verified',
  DECIDED: 'Disposition decided',
  VERIFIED_RESOLVED: 'Disposition verified',
  RELEASED: 'Released from TQMS hold',
};

export const DISPOSITION_OUTCOMES = ['RETURN_TO_SUPPLIER', 'SCRAP', 'REWORK', 'REPAIR', 'USE_AS_IS'] as const;
export type DispositionOutcome = (typeof DISPOSITION_OUTCOMES)[number];

export const DISPOSITION_TEXT: Record<DispositionOutcome, { label: string; verification: string; usable: boolean }> = {
  RETURN_TO_SUPPLIER: { label: 'Return to supplier', verification: 'Return shipment or supplier receipt recorded by PDI', usable: false },
  SCRAP: { label: 'Scrap', verification: 'Scrapping witnessed or scrap record by PDI', usable: false },
  REWORK: {
    label: 'Rework',
    verification: 'PDI reinspection of the same lot showing the failed characteristic now conforms',
    usable: true,
  },
  REPAIR: {
    label: 'Repair',
    verification: 'PDI reinspection of the same lot showing the failed characteristic now conforms',
    usable: true,
  },
  USE_AS_IS: { label: 'Use as is (under concession)', verification: 'Concession current, quantity within limit and conditions applied', usable: true },
};

/** Material that may be released after verification (returned or scrapped material leaves). */
export const isUsableOutcome = (o: string) => DISPOSITION_TEXT[o as DispositionOutcome]?.usable ?? false;
export const needsReinspection = (o: string) => o === 'REWORK' || o === 'REPAIR';

export type ConcessionState = 'REQUESTED' | 'CURRENT' | 'NOT_YET_VALID' | 'EXPIRED' | 'EXHAUSTED' | 'REJECTED' | 'WITHDRAWN';

export const CONCESSION_STATE_TEXT: Record<ConcessionState, string> = {
  REQUESTED: 'Requested — not yet authorized',
  CURRENT: 'Approved and current',
  NOT_YET_VALID: 'Approved — not yet valid',
  EXPIRED: 'Expired',
  EXHAUSTED: 'Quantity used up',
  REJECTED: 'Rejected',
  WITHDRAWN: 'Withdrawn',
};

/**
 * A concession authorizes only its named lot, quantity and dates (FR-073, AT-14). Expired or
 * exhausted concessions never authorize further material.
 */
export function concessionState(
  c: { status: string; valid_from: string; valid_until: string; quantity_limit: number },
  used: number,
  today: string,
): ConcessionState {
  if (c.status !== 'APPROVED') return c.status as ConcessionState;
  if (today < c.valid_from) return 'NOT_YET_VALID';
  if (today > c.valid_until) return 'EXPIRED';
  if (used >= c.quantity_limit) return 'EXHAUSTED';
  return 'CURRENT';
}

export const SCAR_STATUS_TEXT: Record<string, string> = {
  ISSUED: 'Issued — awaiting supplier response',
  RESPONSE_RECEIVED: 'Supplier responded — PDI verification of implementation pending',
  IMPLEMENTATION_VERIFIED: 'Implementation verified by PDI — effectiveness pending',
  EFFECTIVENESS_VERIFIED: 'Effectiveness verified — ready to close',
  CLOSED: 'Closed',
};

export const COMMITMENT_STATUS_TEXT: Record<string, string> = {
  OPEN: 'Open',
  SUPPLIER_CLAIMS_DONE: 'Supplier says done — PDI verification pending',
  VERIFIED: 'Verified by PDI',
  CANCELLED: 'Cancelled',
};

export const COMMUNICATION_CHANNELS = ['CALL', 'EMAIL', 'MEETING', 'VISIT', 'PORTAL', 'OTHER'] as const;

/**
 * Interim reminder/escalation rule (FR-013: proportional to severity). Reminders are in-app
 * only; e-mail stays disabled until approved.
 */
export function commitmentEscalation(severity: string, daysOverdue: number): { remind: boolean; escalate: boolean } {
  if (daysOverdue <= 0) return { remind: false, escalate: false };
  if (severity === 'HIGH') return { remind: true, escalate: true };
  if (severity === 'MEDIUM') return { remind: true, escalate: daysOverdue >= 7 };
  return { remind: true, escalate: false };
}

export const CHANGE_CATEGORIES = [
  'DESIGN',
  'DIMENSION',
  'MATERIAL',
  'COATING',
  'HEAT_TREATMENT',
  'PROCESS',
  'EQUIPMENT',
  'TOOLING',
  'SUB_TIER',
  'SITE',
  'TEST_METHOD',
  'ADMINISTRATIVE',
] as const;

export const CHANGE_CATEGORY_TEXT: Record<(typeof CHANGE_CATEGORIES)[number], string> = {
  DESIGN: 'Design',
  DIMENSION: 'Critical dimension',
  MATERIAL: 'Material',
  COATING: 'Coating / finish',
  HEAT_TREATMENT: 'Heat treatment',
  PROCESS: 'Manufacturing process',
  EQUIPMENT: 'Equipment',
  TOOLING: 'Tooling',
  SUB_TIER: 'Sub-tier supplier',
  SITE: 'Manufacturing site',
  TEST_METHOD: 'Test method',
  ADMINISTRATIVE: 'Administrative only',
};

export const IMPACT_AREAS = [
  'DRAWING',
  'VALIDATION_FAI',
  'INSPECTION_PLAN',
  'SOURCE_APPROVAL',
  'SUPPLIER_ACKNOWLEDGMENT',
  'STOCK_WIP',
  'SUPPLIER_COMMITMENTS',
] as const;

export const IMPACT_AREA_TEXT: Record<(typeof IMPACT_AREAS)[number], string> = {
  DRAWING: 'Drawing / specification',
  VALIDATION_FAI: 'Validation and first article',
  INSPECTION_PLAN: 'Receiving inspection plan and form',
  SOURCE_APPROVAL: 'Exact source approvals',
  SUPPLIER_ACKNOWLEDGMENT: 'Supplier acknowledgment of the new revision',
  STOCK_WIP: 'Stock, work in progress and open orders',
  SUPPLIER_COMMITMENTS: 'Open supplier commitments',
};

export const CHANGE_ACTION_KINDS = [
  'BASELINE_RELEASE',
  'REQUALIFY_FAI',
  'NEW_ACKNOWLEDGMENT',
  'SOURCE_REAPPROVAL',
  'UPDATE_INSPECTION_FORM',
  'STOCK_REVIEW',
  'OTHER',
] as const;

export const CHANGE_ACTION_TEXT: Record<(typeof CHANGE_ACTION_KINDS)[number], string> = {
  BASELINE_RELEASE: 'Release the new baseline revision',
  REQUALIFY_FAI: 'New first article / validation',
  NEW_ACKNOWLEDGMENT: 'Supplier acknowledgment of the new revision',
  SOURCE_REAPPROVAL: 'Approve the changed source',
  UPDATE_INSPECTION_FORM: 'Update the receiving inspection form',
  STOCK_REVIEW: 'Review stock and open orders',
  OTHER: 'Other action',
};

/** Actions that must be done before a change becomes effective (the rest before verification). */
export const PRE_EFFECTIVE_ACTIONS = new Set(['BASELINE_RELEASE', 'NEW_ACKNOWLEDGMENT']);

export const CHANGE_STATUS_TEXT: Record<string, string> = {
  PROPOSED: 'Proposed — impact assessment needed',
  IMPACT_ASSESSED: 'Impact assessed — decision needed',
  APPROVED: 'Approved — not yet effective',
  REJECTED: 'Rejected',
  EFFECTIVE: 'Effective — implementation verification pending',
  IMPLEMENTATION_VERIFIED: 'Implementation verified',
  CANCELLED: 'Cancelled',
};

export interface CharacteristicDiffRow {
  charKey: string;
  name: string;
  change: 'ADDED' | 'REMOVED' | 'CHANGED' | 'UNCHANGED';
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  fields: string[];
}

const DIFF_FIELDS = ['name', 'charType', 'formRowRef', 'unit', 'lower', 'upper', 'limitText', 'method', 'special', 'isDelta'] as const;

/** Side-by-side difference between two baseline revisions' characteristics (FR-083). */
export function diffCharacteristics(
  before: Array<Record<string, unknown> & { charKey: string }>,
  after: Array<Record<string, unknown> & { charKey: string }>,
): CharacteristicDiffRow[] {
  const out: CharacteristicDiffRow[] = [];
  const b = new Map(before.map((c) => [c.charKey, c]));
  const a = new Map(after.map((c) => [c.charKey, c]));
  for (const key of [...new Set([...b.keys(), ...a.keys()])]) {
    const x = b.get(key) ?? null;
    const y = a.get(key) ?? null;
    const norm = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));
    const fields = x && y ? DIFF_FIELDS.filter((f) => norm(x[f]) !== norm(y[f])) : [];
    out.push({
      charKey: key,
      name: String((y ?? x)!.name ?? key),
      change: !x ? 'ADDED' : !y ? 'REMOVED' : fields.length ? 'CHANGED' : 'UNCHANGED',
      before: x,
      after: y,
      fields: [...fields],
    });
  }
  const order = { CHANGED: 0, ADDED: 1, REMOVED: 2, UNCHANGED: 3 };
  return out.sort((p, q) => order[p.change] - order[q.change] || p.charKey.localeCompare(q.charKey));
}

/** Calendar day (YYYY-MM-DD) in the display time zone. */
export function dayIn(timeZone: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** Whole days from `from` to `to` (both YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
