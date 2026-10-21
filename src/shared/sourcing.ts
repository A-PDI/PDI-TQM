/**
 * Sourcing rules shared by server and browser. The risk weights and checklist applicability
 * below are INTERIM conservative defaults recorded under POL-04 (POLICY OPEN); every stored
 * assessment and checklist row records the rule version that produced it.
 */

export type Pathway = 'A' | 'B' | 'C';
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export const PATHWAYS: Record<Pathway, { title: string; explanation: string }> = {
  A: {
    title: 'A — PDI-defined design',
    explanation:
      'The supplier makes the part to PDI technical requirements (including a reverse-engineered sample). Engineering must release the drawing/specification before the source can be approved; FAI and supplier acknowledgment of the exact revision are required.',
  },
  B: {
    title: 'B — Supplier-standard product',
    explanation:
      "PDI buys the supplier's established catalog item unmodified. The supplier's specification is the baseline; validation is proportionate to risk, but the exact supplier/site/part still needs an explicit source approval.",
  },
  C: {
    title: 'C — Modified supplier product',
    explanation:
      "A supplier-standard item with a PDI-controlled change (material, coating, machining, heat treatment, critical values). PDI's delta specification is released on top of the supplier baseline; the supplier must acknowledge the exact delta revision and the change must be verified.",
  },
};

export const RISK_RULE_VERSION = 'RISK-INTERIM-1 (POL-04 open)';

export const RISK_FACTORS = [
  { key: 'criticality', label: 'Engine / reliability criticality', low: 'Non-critical', high: 'Safety or engine-critical' },
  { key: 'severity', label: 'Failure severity', low: 'Minor inconvenience', high: 'Engine damage or downtime' },
  { key: 'supplierMaturity', label: 'Supplier / process maturity', low: 'Proven with this process', high: 'New supplier or unproven process' },
  { key: 'newness', label: 'Product newness', low: 'Carry-over', high: 'New or reverse-engineered' },
  { key: 'manufacturingChange', label: 'Manufacturing change', low: 'None', high: 'Significant change' },
  { key: 'verificationDifficulty', label: 'Verification difficulty', low: 'Simple visual / gauge', high: 'Destructive or specialized test' },
  { key: 'qualityHistory', label: 'Known quality history', low: 'Good history', high: 'Poor or unknown history' },
] as const;
export type RiskFactor = (typeof RISK_FACTORS)[number]['key'];
export type RiskInputs = Record<RiskFactor, 1 | 2 | 3>;

/** Interim scoring: sum of seven 1–3 factors; criticality and severity both 3 forces HIGH. */
export function assessRisk(inputs: RiskInputs): { score: number; result: RiskLevel } {
  const score = RISK_FACTORS.reduce((acc, f) => acc + inputs[f.key], 0);
  if (inputs.criticality === 3 && inputs.severity === 3) return { score, result: 'HIGH' };
  return { score, result: score >= 15 ? 'HIGH' : score >= 10 ? 'MEDIUM' : 'LOW' };
}

export const CHECKLIST_RULE_VERSION = 'CHECKLIST-INTERIM-1 (POL-04 open)';

export type Applicability = 'REQUIRED' | 'CONDITIONAL' | 'NOT_APPLICABLE';

/** Appendix B record types that are evidenced by documents (native records are separate gates). */
export const RECORD_TYPES: Record<string, string> = {
  'SUP-03': 'Supplier Quality Agreement (SQA)',
  'SUP-05': 'Sub-tier / Critical Process Disclosure',
  'ENG-01': 'Customer-Controlled Drawing / TDP Checklist',
  'ENG-03': 'Physical Sample / Reverse Engineering Intake',
  'ENG-04': 'Supplier Baseline Product Specification',
  'ENG-05': 'Supplier Part Cross-Reference & Configuration Record',
  'ENG-08': 'Critical Characteristics & Acceptance Matrix',
  'VAL-01': 'Product Qualification & Validation Plan',
  'VAL-03': 'Functional / Performance Test Report',
  'VAL-04': 'Material / Coating / Special Process Certificate',
  'VAL-06': 'Part Submission Warrant (PSW)',
  'VAL-07': 'Process FMEA',
  'VAL-08': 'Production Control Plan',
  'VAL-09': 'Measurement System Analysis',
};

export interface ChecklistItem {
  code: string;
  title: string;
  applicability: Applicability;
  rationale: string;
}

const atLeast = (risk: RiskLevel, min: RiskLevel) => ['LOW', 'MEDIUM', 'HIGH'].indexOf(risk) >= ['LOW', 'MEDIUM', 'HIGH'].indexOf(min);

/** Risk- and pathway-proportionate document checklist (no universal PPAP burden). */
export function buildChecklist(pathway: Pathway, risk: RiskLevel): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const add = (code: string, applicability: Applicability, rationale: string) => items.push({ code, title: RECORD_TYPES[code]!, applicability, rationale });
  const high = risk === 'HIGH';
  const medium = atLeast(risk, 'MEDIUM');

  if (pathway === 'A') {
    add('ENG-01', 'REQUIRED', 'PDI owns the design: the technical data package must be complete before release.');
    add('ENG-03', 'CONDITIONAL', 'Needed when the design was reverse engineered from a physical sample.');
    add('ENG-08', medium ? 'REQUIRED' : 'CONDITIONAL', medium ? `Risk ${risk}: critical characteristics must be identified.` : 'Low risk: needed only if critical characteristics exist.');
    add('VAL-01', 'REQUIRED', 'A new PDI design needs a validation plan.');
  } else {
    add('ENG-04', 'REQUIRED', "The supplier's authoritative specification is the baseline.");
    add('ENG-05', 'REQUIRED', 'Cross-reference between supplier part, configuration and the PDI part.');
    add('ENG-08', high ? 'REQUIRED' : 'NOT_APPLICABLE', high ? 'High risk: critical characteristics must be identified.' : 'Not required below high risk for supplier-baseline products.');
    add('VAL-01', pathway === 'C' && medium ? 'REQUIRED' : high ? 'REQUIRED' : 'CONDITIONAL', pathway === 'C' ? 'The PDI delta must be validated in proportion to risk.' : 'Validation plan proportionate to risk.');
  }
  add(
    'VAL-04',
    pathway === 'C' ? 'REQUIRED' : 'CONDITIONAL',
    pathway === 'C' ? 'Delta changes usually concern material, coating or special processes: certificates prove them.' : 'Needed when material/coating/special processes are specified.',
  );
  add('VAL-03', high ? 'REQUIRED' : 'CONDITIONAL', high ? 'High risk: functional performance must be demonstrated.' : 'Needed when performance is specified.');
  add('SUP-03', high ? 'REQUIRED' : 'CONDITIONAL', high ? 'High risk: quality expectations must be agreed in writing.' : 'Recommended for repeat supply.');
  add('SUP-05', 'CONDITIONAL', 'Needed when critical processes are subcontracted.');
  for (const code of ['VAL-06', 'VAL-07', 'VAL-08', 'VAL-09']) {
    add(code, high ? 'REQUIRED' : 'NOT_APPLICABLE', high ? 'High risk: PPAP-style element required.' : 'PPAP elements are not imposed below high risk.');
  }
  return items;
}

export type GateStatus = 'PASS' | 'FAIL' | 'WARN' | 'NOT_APPLICABLE';

export interface GateResult {
  code: string;
  label: string;
  status: GateStatus;
  detail: string;
  /** Where to resolve it in the application. */
  link?: string;
}

export const GATE_LABELS: Record<string, string> = {
  BASELINE_RELEASED: 'Released technical baseline governs this source',
  DELTA_RELEASED: 'PDI delta specification released on the supplier baseline',
  SUPPLIER_NOT_RESTRICTED: 'Supplier is not suspended',
  SITE_QUALIFIED: 'This manufacturing site is qualified and current',
  SUPPLIER_ACKNOWLEDGED: 'Supplier acknowledged the exact governing revision',
  FAI_ACCEPTED: 'First article / validation accepted for the governing revision',
  EVIDENCE_COMPLETE: 'Required evidence satisfied or waived',
  NO_BLOCKING_QUALITY: 'No blocking nonconformance or untriaged concern on this source',
  CONCESSIONS_CURRENT: 'No expired concession relied on by open nonconformances',
  CHANGE_CONTROL: 'No pending change requiring requalification',
  RISK_ASSESSED: 'Risk assessed for this sourcing request',
};

export type EffectiveSourceStatus =
  | 'NOT_APPROVED'
  | 'IN_REVIEW'
  | 'APPROVED'
  | 'APPROVED_CONDITIONAL'
  | 'SUSPENDED'
  | 'RESTRICTED'
  | 'EXPIRED'
  | 'AT_RISK'
  | 'REQUALIFICATION_REQUIRED';

export const SOURCE_STATUS_TEXT: Record<EffectiveSourceStatus, string> = {
  NOT_APPROVED: 'Not approved',
  IN_REVIEW: 'Approval in review',
  APPROVED: 'Approved',
  APPROVED_CONDITIONAL: 'Approved with conditions',
  SUSPENDED: 'Suspended — supplier or site restricted',
  EXPIRED: 'Approval expired',
  AT_RISK: 'At risk — site qualification no longer current',
  RESTRICTED: 'Restricted — this exact source is on hold',
  REQUALIFICATION_REQUIRED: 'Requalification required — an approved change is not yet verified',
};
