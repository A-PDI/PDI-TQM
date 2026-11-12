/**
 * Controlled-document workflows (owner request, 11 Nov 2026). Each of the 37 registered document
 * types is mapped to the module where its work happens and handled in one of two ways:
 *
 *   FORM        — category A: completed inside TQM. The data-entry screen is derived from the
 *                 AcroForm field tree of the exact released revision of the controlled PDF; the
 *                 controlled output is that revision filled in, with as many continuation sheets
 *                 as the record needs.
 *   ATTACHMENT  — category B: a controlled reference or external evidence. The completed or
 *                 executed document stays an attachment, bound to the template revision in force,
 *                 and the record completes only when every required acknowledgment/signature is in.
 *
 * Records bind to the released revisions in force when they are created; later revisions never
 * change an existing record or its generated PDF.
 */
import type { Capability } from './capabilities.js';

export type Requirement = 'REQUIRED' | 'CONDITIONAL' | 'OPTIONAL';
export type FieldInput = 'text' | 'multiline' | 'choice' | 'date';

/** How a template field is filled: by the preparer, by the system, or by an approver when signing. */
export type FieldRole = 'ENTRY' | 'SYSTEM' | 'DECISION' | 'SIGNATURE';

export interface TemplateField {
  /** Fully qualified AcroForm name, e.g. OPS06__problem. */
  name: string;
  /** Name without the document prefix, e.g. problem. */
  key: string;
  label: string;
  requirement: Requirement;
  input: FieldInput;
  /** Choice values without the blank "--" entry. */
  options: string[] | null;
  maxLength: number | null;
  page: number;
  rect: [number, number, number, number];
  section: string | null;
  role: FieldRole;
}

export interface TemplateColumn {
  key: string;
  label: string;
  requirement: Requirement;
  input: FieldInput;
  options: string[] | null;
  maxLength: number | null;
}

export interface TemplateSchedule {
  key: string;
  title: string | null;
  columns: TemplateColumn[];
  /** Rows this sheet holds. */
  capacity: number;
  pages: number[];
  /** Page of each row, in row order. */
  rowPages: number[];
  /** Bounding box of each row's entry boxes [x1, y1, x2, y2], in row order. */
  rowRects: Array<[number, number, number, number]>;
  /** Row labels printed on the sheet (checklists); null when rows are free-form. */
  rowLabels: string[] | null;
}

export interface TemplatePage {
  page: number;
  width: number;
  height: number;
  /** SHA-256 of the page's decoded content stream(s): the static, controlled layout. */
  contentSha256: string;
  /** SHA-256 of each decoded content stream, in drawing order. */
  streamSha256: string[];
  headings: string[];
}

export interface TemplateSchema {
  deriver: 'ACROFORM-1';
  interactive: boolean;
  /** Why the file cannot drive a form (no fields, unreadable…). */
  reason: string | null;
  prefix: string | null;
  title: string | null;
  /** Document identity band, e.g. "OPS-06 | REV 0.3 | DRAFT - REVIEW ONLY". */
  controlLine: string | null;
  /** Footer lines carrying document ID, template revision, effective date and owner. */
  footer: string[];
  pages: TemplatePage[];
  sections: Array<{ title: string; page: number; x: number; y: number }>;
  fields: TemplateField[];
  schedules: TemplateSchedule[];
  /** SHA-256 over the canonical field tree (names, kinds, options, limits, pages). */
  fieldTreeSha256: string;
}

/** Entered content of a FORM record. Rows beyond a sheet's capacity continue on continuation sheets. */
export interface RecordData {
  fields: Record<string, string>;
  schedules: Record<string, Array<Record<string, string>>>;
}

/** Row keys that are not template columns. `_label` names an added checklist row; `_fileId` links an attached file. */
export const ROW_LABEL = '_label';
export const ROW_FILE = '_fileId';
/** Identity of a row that comes from the module record (inspection reading, NCR scope, FAI characteristic…). */
export const ROW_KEY = '_key';

export const EVIDENCE_SCHEDULE = 'evidence';
export const EVIDENCE_CONTINUATION = 'PDI-Evidence-Continuation';
export const NARRATIVE_CONTINUATION = 'PDI-Narrative-Continuation';

/** Fields filled by the system on every sheet (identity and continuation control). */
export const SYSTEM_FIELD = /^(record_id|submission_date|page\d+_record_ref|page\d+_sheet_ref|parent_record|parent_revision|sheet_id|sheet_sequence|completed_by|completed_date)$/;
/** Fields filled when an approver signs. */
export const SIGNATURE_FIELD = /^(approver\d|approval\d_date|pdi_authorization_ref)$/;
export const DECISION_SECTION = /^PDI review and authori[sz]ation$/i;

export type ControlledCategory = 'FORM' | 'ATTACHMENT';
export type ControlledEntity = 'SOURCING_REQUEST' | 'SUPPLIER' | 'SOURCE' | 'FAI' | 'CHANGE' | 'INSPECTION' | 'CONCESSION' | 'NCR' | 'SCAR' | 'SYSTEM';

export const ENTITY_ROUTES: Record<ControlledEntity, { label: string; route: (id: string) => string }> = {
  SOURCING_REQUEST: { label: 'Sourcing request', route: (id) => `/sourcing/${id}` },
  SUPPLIER: { label: 'Supplier', route: (id) => `/suppliers/${id}` },
  SOURCE: { label: 'Exact source', route: (id) => `/sources/${id}` },
  // A first article is shown on its source; the server resolves the source when it returns the route.
  FAI: { label: 'First article', route: () => '/sources' },
  CHANGE: { label: 'Change', route: (id) => `/changes/${id}` },
  INSPECTION: { label: 'Inspection', route: (id) => `/inspections/${id}` },
  CONCESSION: { label: 'Concession', route: (id) => `/quality/concessions/${id}` },
  NCR: { label: 'NCR', route: (id) => `/quality/ncrs/${id}` },
  SCAR: { label: 'SCAR', route: (id) => `/quality/scars/${id}` },
  SYSTEM: { label: 'Quality system', route: () => '/documents' },
};

/** An approval block on the form (approverN + approvalN_date), signed in the app. */
export interface ApprovalStep {
  field: 'approver1' | 'approver2';
  dateField: 'approval1_date' | 'approval2_date';
  /** Holding any of these authorities allows signing. */
  capabilities: Capability[];
  /** The first approver records the PDI decision; later ones concur. */
  decides: boolean;
  /** "When required" approvals may be marked not required by the deciding approver. */
  optional: boolean;
}

/** A required acknowledgment/signature on an ATTACHMENT record. */
export interface SignatureRole {
  key: string;
  label: string;
  /** INTERNAL: signed in TQM by an authorized user. EXTERNAL: attested from the executed document (signer, title, date). */
  mode: 'INTERNAL' | 'EXTERNAL';
  capabilities: Capability[];
}

export interface ControlledTypeDef {
  code: string;
  category: ControlledCategory;
  family: 'Sourcing' | 'Supplier' | 'Engineering' | 'Validation' | 'FAI' | 'Inspection' | 'Change' | 'Concession' | 'Nonconformance' | 'Corrective action' | 'Performance' | 'System';
  /** Module where the record is started and listed. */
  module: string;
  moduleRoute: string;
  entity: ControlledEntity;
  /** Holding any of these authorities allows preparing the record. */
  authors: Capability[];
  steps: ApprovalStep[];
  signatures: SignatureRole[];
  rationale: string;
}

const step = (n: 1 | 2, capabilities: Capability[], opts: { optional?: boolean } = {}): ApprovalStep => ({
  field: `approver${n}`,
  dateField: `approval${n}_date`,
  capabilities,
  decides: n === 1,
  optional: opts.optional ?? false,
});

const ENG: Capability = 'engineering.release';
const SQ: Capability = 'supplier.qualify';
const VD: Capability = 'validation.decide';

const form = (
  code: string,
  family: ControlledTypeDef['family'],
  module: string,
  moduleRoute: string,
  entity: ControlledEntity,
  authors: Capability[],
  steps: ApprovalStep[],
  rationale: string,
): ControlledTypeDef => ({ code, category: 'FORM', family, module, moduleRoute, entity, authors, steps, signatures: [], rationale });

const attachment = (
  code: string,
  family: ControlledTypeDef['family'],
  module: string,
  moduleRoute: string,
  entity: ControlledEntity,
  authors: Capability[],
  signatures: SignatureRole[],
  rationale: string,
): ControlledTypeDef => ({ code, category: 'ATTACHMENT', family, module, moduleRoute, entity, authors, steps: [], signatures, rationale });

const internal = (key: string, label: string, capabilities: Capability[]): SignatureRole => ({ key, label, mode: 'INTERNAL', capabilities });
const external = (key: string, label: string): SignatureRole => ({ key, label, mode: 'EXTERNAL', capabilities: [] });

/** The 37 registered types (Appendix B), mapped to modules with an A/B decision each. */
export const CONTROLLED_TYPES: ControlledTypeDef[] = [
  form('INT-01', 'Sourcing', 'Sourcing requests', '/sourcing', 'SOURCING_REQUEST', ['sourcing.manage'], [step(1, ['sourcing.manage']), step(2, [ENG, SQ])],
    'PDI opens the request; its data drives the sourcing workflow.'),
  form('INT-02', 'Sourcing', 'Sourcing requests', '/sourcing', 'SOURCING_REQUEST', ['sourcing.manage'], [step(1, [ENG]), step(2, [SQ])],
    'PDI sets the path and proportionate evidence; it decides what the source must prove.'),
  form('SUP-01', 'Supplier', 'Suppliers', '/suppliers', 'SUPPLIER', ['supplier.manage'], [step(1, [SQ])],
    'Supplier answers are transcribed with evidence references and PDI reviews each response in the app.'),
  form('SUP-02', 'Supplier', 'Suppliers', '/suppliers', 'SUPPLIER', ['supplier.manage'], [step(1, [SQ]), step(2, [ENG])],
    'PDI assessors record the process assessment, findings and actions.'),
  attachment('SUP-03', 'Supplier', 'Suppliers', '/suppliers', 'SUPPLIER', ['supplier.manage'],
    [external('legal', 'Legal approval (counsel reference)'), external('pdi_signatory', 'PDI authorized signatory / title'), external('supplier_signatory', 'Supplier authorized signatory / title'), internal('quality', 'Quality approver', [SQ])],
    'Legal instrument drafted and executed outside the app; the executed agreement is the record.'),
  attachment('SUP-04', 'Supplier', 'Suppliers', '/suppliers', 'SUPPLIER', ['supplier.manage'],
    [external('legal', 'Legal approval (counsel reference)'), external('pdi_signatory', 'PDI authorized signatory / title'), external('supplier_signatory', 'Supplier authorized signatory / title'), internal('pdi_representative', 'Authorized PDI representative', [SQ])],
    'Legal instrument executed outside the app; the signed NDA is the record.'),
  attachment('SUP-05', 'Supplier', 'Suppliers', '/suppliers', 'SUPPLIER', ['supplier.manage'],
    [external('supplier_ack', 'Supplier disclosure acknowledgment'), internal('engineering', 'Engineering approver', [ENG]), internal('quality', 'Supplier Quality approver', [SQ])],
    'Supplier-authored disclosure of its sub-tiers; PDI acknowledges and reviews the returned document.'),
  form('ENG-01', 'Engineering', 'Exact sources', '/sources', 'SOURCE', ['engineering.author'], [step(1, [ENG]), step(2, [SQ])],
    'Engineering checks the customer-controlled TDP for the exact source.'),
  form('ENG-02', 'Engineering', 'Exact sources', '/sources', 'SOURCE', ['engineering.author'], [step(1, [ENG]), step(2, [SQ])],
    'Engineering records discipline reviews, actions and the release decision.'),
  form('ENG-03', 'Engineering', 'Exact sources', '/sources', 'SOURCE', ['engineering.author'], [step(1, [ENG]), step(2, [VD])],
    'Engineering records sample custody and observations in the app.'),
  form('ENG-04', 'Engineering', 'Exact sources', '/sources', 'SOURCE', ['engineering.author'], [step(1, [ENG]), step(2, [SQ])],
    'The accepted supplier baseline is frozen as a PDI record for Path B/C sources.'),
  form('ENG-05', 'Engineering', 'Exact sources', '/sources', 'SOURCE', ['engineering.author'], [step(1, [ENG]), step(2, ['sourcing.manage', SQ])],
    'PDI keeps the part/supplier/site/configuration mapping.'),
  form('ENG-06', 'Engineering', 'Exact sources', '/sources', 'SOURCE', ['engineering.author'], [step(1, [ENG]), step(2, [SQ])],
    'PDI authors the delta specification for Path C sources.'),
  form('ENG-07', 'Engineering', 'Exact sources', '/sources', 'SOURCE', ['engineering.author'], [step(1, [ENG]), step(2, [SQ])],
    'PDI records the altered/selected item features it controls.'),
  form('ENG-08', 'Engineering', 'Exact sources', '/sources', 'SOURCE', ['engineering.author'], [step(1, [ENG]), step(2, [SQ])],
    'PDI defines critical characteristics and acceptance for the source.'),
  form('ENG-09', 'Change', 'Changes', '/changes', 'CHANGE', ['change.manage', 'engineering.author'], [step(1, [ENG]), step(2, [SQ])],
    'Specification revisions are part of change control.'),
  form('VAL-01', 'Validation', 'Exact sources', '/sources', 'SOURCE', ['sourcing.manage', 'engineering.author'], [step(1, [ENG]), step(2, [VD])],
    'PDI plans the qualification tests for the source.'),
  form('VAL-02', 'FAI', 'Exact sources (first articles)', '/sources', 'FAI', ['sourcing.manage'], [step(1, [ENG]), step(2, [VD])],
    'First-article measurements are recorded and decided in the app.'),
  form('VAL-03', 'Validation', 'Exact sources', '/sources', 'SOURCE', ['sourcing.manage', 'injector.test'], [step(1, [ENG]), step(2, [VD])],
    'PDI records functional test results against the plan.'),
  form('VAL-04', 'Validation', 'Exact sources', '/sources', 'SOURCE', ['sourcing.manage'], [step(1, [ENG]), step(2, [VD])],
    'PDI checks each certificate against the specification; the certificates are attached evidence.'),
  form('VAL-05', 'Validation', 'Exact sources', '/sources', 'SOURCE', ['sourcing.manage'], [step(1, [VD]), step(2, [ENG])],
    'PDI sets which PPAP elements apply to the source.'),
  attachment('VAL-06', 'Validation', 'Exact sources', '/sources', 'SOURCE', ['sourcing.manage'],
    [external('supplier_warrant', 'Supplier authorized representative (warrant)'), internal('quality', 'Supplier Quality approver', [VD]), internal('engineering', 'Engineering approver', [ENG])],
    'The warrant is the supplier’s signed declaration; PDI dispositions the returned package.'),
  attachment('VAL-07', 'Validation', 'Exact sources', '/sources', 'SOURCE', ['sourcing.manage'],
    [external('supplier_owner', 'Supplier PFMEA owner'), internal('engineering', 'Manufacturing / Engineering approver', [ENG]), internal('quality', 'Supplier Quality approver', [VD])],
    'Supplier-prepared process analysis; the supplier file is the record and PDI reviews it.'),
  attachment('VAL-08', 'Validation', 'Exact sources', '/sources', 'SOURCE', ['sourcing.manage'],
    [external('supplier_owner', 'Supplier process owner'), internal('quality', 'Supplier Quality approver', [VD])],
    'Supplier-owned control plan; PDI reviews and acknowledges the submitted plan.'),
  attachment('VAL-09', 'Validation', 'Exact sources', '/sources', 'SOURCE', ['sourcing.manage'],
    [external('metrology', 'Metrology approver'), internal('quality', 'Supplier Quality approver', [VD])],
    'Gage study computed in metrology software; the study report is the record.'),
  attachment('VAL-10', 'Validation', 'Exact sources', '/sources', 'SOURCE', ['sourcing.manage'],
    [external('statistician', 'Qualified statistical reviewer'), internal('quality', 'Supplier Quality approver', [VD])],
    'Capability study computed in statistical software; the study report is the record.'),
  form('VAL-11', 'Validation', 'Exact sources (approval)', '/sources', 'SOURCE', ['sourcing.manage'], [step(1, [ENG]), step(2, ['source.approve'])],
    'The exact-source purchasing release gate is decided in the app.'),
  form('OPS-01', 'Inspection', 'Exact sources (receiving plan)', '/sources', 'SOURCE', ['forms.publish', 'engineering.author', 'sourcing.manage'], [step(1, ['forms.publish'])],
    'PDI defines receiving rules for the source.'),
  form('OPS-02', 'Inspection', 'Incoming inspections', '/inspections', 'INSPECTION', ['inspection.perform'], [step(1, ['inspection.review'])],
    'Receiving results are measured and decided in the app.'),
  form('OPS-03', 'Change', 'Changes', '/changes', 'CHANGE', ['change.manage'], [step(1, ['change.approve'])],
    'Supplier change notifications are logged and triaged in change control.'),
  form('OPS-04', 'Change', 'Changes', '/changes', 'CHANGE', ['change.manage'], [step(1, [ENG]), step(2, ['change.approve'])],
    'Impact and requalification are decided in change control.'),
  form('OPS-05', 'Concession', 'Concessions', '/quality/concessions', 'CONCESSION', ['concession.request'], [step(1, [ENG]), step(2, ['concession.approve'])],
    'Deviation scope, quantities and expiry are controlled in the app.'),
  form('OPS-06', 'Nonconformance', 'Nonconformance reports', '/quality/ncrs', 'NCR', ['ncr.manage'], [step(1, ['ncr.manage']), step(2, [ENG], { optional: true })],
    'Containment and disposition are executed in the NCR module.'),
  form('OPS-07', 'Corrective action', 'Supplier corrective actions', '/quality/scars', 'SCAR', ['scar.manage'], [step(1, ['scar.close'])],
    'SCAR responses and verification are tracked in the app.'),
  form('OPS-08', 'Corrective action', 'Supplier corrective actions (8D)', '/quality/scars', 'SCAR', ['scar.manage'], [step(1, ['scar.close']), step(2, [ENG], { optional: true })],
    'The 8D is recorded against the SCAR and verified by PDI.'),
  form('OPS-09', 'Performance', 'Suppliers', '/suppliers', 'SUPPLIER', ['supplier.manage', 'reports.export'], [step(1, [SQ]), step(2, ['sourcing.manage'])],
    'PDI computes the scorecard from approved source metrics.'),
  attachment('SYS-01', 'System', 'Document Library', '/documents', 'SYSTEM', ['documents.control'],
    [internal('quality_systems', 'Quality Systems approver', ['documents.control']), external('legal_process_owners', 'Legal / process owners approver')],
    'Governance rules for the library itself; a controlled reference acknowledged by its owners.'),
];

export const CONTROLLED_TYPE_BY_CODE: Record<string, ControlledTypeDef> = Object.fromEntries(CONTROLLED_TYPES.map((t) => [t.code, t]));

/**
 * One approval path per module event (owner request, 11 Nov 2026). The event's controlled record is
 * opened in the same transaction as the event, bound to the revisions then in force; facts the module
 * holds are carried onto the form and cannot be retyped; and the module's own decision signs the
 * form's deciding approval block, completes the record and generates the controlled PDF. Other
 * approval blocks on the form (concurrence) are signed on the record before that decision.
 */
export interface EventBinding {
  code: string;
  entity: ControlledEntity;
  /** The module event that opens the record. */
  opensWhen: string;
  /** Module action that submits the record; null when the preparer submits the completed form for decision. */
  submitAction: { action: string; label: string } | null;
  /** Module decision that signs the deciding block; null when the form's deciding approval is the decision and drives the module. */
  decision: { action: string; label: string; module: string; block: 'approver1' | 'approver2' } | null;
  /** When a "when required" concurrence must be signed; otherwise the deciding approver records it as not required. */
  requiredWhen: string | null;
  /** Not opened automatically: started from the module record when the document is used, then decided with it. */
  companion: boolean;
}

const bind = (
  code: string,
  entity: ControlledEntity,
  opensWhen: string,
  submitAction: EventBinding['submitAction'],
  decision: EventBinding['decision'],
  opts: { requiredWhen?: string; companion?: boolean } = {},
): EventBinding => ({ code, entity, opensWhen, submitAction, decision, requiredWhen: opts.requiredWhen ?? null, companion: opts.companion ?? false });

export const EVENT_BINDINGS: Record<string, EventBinding> = Object.fromEntries(
  [
    bind('INT-01', 'SOURCING_REQUEST', 'the sourcing request is started', null, null),
    bind('VAL-11', 'SOURCE', 'approval of the source is requested', null, { action: 'source.decide', label: 'Decide source approval', module: 'exact source', block: 'approver2' }),
    bind('VAL-02', 'FAI', 'the first-article sample is registered', null, { action: 'fai.decide', label: 'Decide first article', module: 'first article', block: 'approver2' }),
    bind('OPS-02', 'INSPECTION', 'the inspection is launched', { action: 'inspection.complete', label: 'Complete inspection' }, { action: 'inspection.review', label: 'Confirm review', module: 'inspection', block: 'approver1' }),
    bind('OPS-04', 'CHANGE', 'the change is proposed', null, { action: 'change.decide', label: 'Decide change', module: 'change', block: 'approver2' }),
    bind('OPS-05', 'CONCESSION', 'the concession is requested', null, { action: 'concession.decide', label: 'Decide concession', module: 'concession', block: 'approver2' }),
    bind('OPS-06', 'NCR', 'the NCR is confirmed', null, { action: 'ncr.close', label: 'Close NCR', module: 'NCR', block: 'approver1' }, { requiredWhen: 'a repair or use-as-is disposition was decided' }),
    bind('OPS-07', 'SCAR', 'the SCAR is issued', null, { action: 'scar.close', label: 'Close SCAR', module: 'SCAR', block: 'approver1' }),
    bind('OPS-08', 'SCAR', 'an 8D is started from the SCAR', null, { action: 'scar.close', label: 'Close SCAR', module: 'SCAR', block: 'approver1' }, { companion: true }),
  ].map((b) => [b.code, b]),
);

/** The block whose signer records the PDI decision: the module decision's block, else the first approver. */
export const decisionBlock = (code: string): string => EVENT_BINDINGS[code]?.decision?.block ?? 'approver1';

export type RecordStatus = 'DRAFT' | 'SUBMITTED' | 'COMPLETED' | 'VOID';

/** "OPS-06" → "OPS06" (the AcroForm field prefix). */
export const fieldPrefix = (code: string) => code.replace('-', '');

/** Continuation sheet document number for a schedule, following the Document Library naming rule. */
export const continuationNumber = (code: string, schedule: string) =>
  schedule === EVIDENCE_SCHEDULE ? EVIDENCE_CONTINUATION : `${code}/${schedule.replace(/_/g, '-')}`;

/** Characters the standard PDF fonts can show (WinAnsi); anything else is replaced so output never fails. */
const WIN_ANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
export function toWinAnsi(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFC')) {
    const code = ch.codePointAt(0)!;
    if (ch === '\n' || ch === '\t' || (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.includes(ch)) out += ch === '\t' ? ' ' : ch;
    else if (ch === '\r') continue;
    else if (ch === '≤') out += '<=';
    else if (ch === '≥') out += '>=';
    else if (ch === '≠') out += '!=';
    else if (ch === '−') out += '-';
    else out += '?';
  }
  return out;
}

/** Problems that stop a FORM record from being submitted, with the field or row they concern. */
export interface Problem {
  path: string;
  message: string;
}

const filled = (v: string | undefined) => typeof v === 'string' && v.trim().length > 0;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const isRealDate = (v: string) => {
  if (!DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

/** Value checks that apply whenever a value is entered (choice values, dates, length is unlimited thanks to continuations). */
export function valueProblems(schema: TemplateSchema, data: RecordData): Problem[] {
  const out: Problem[] = [];
  const check = (path: string, def: { label: string; input: FieldInput; options: string[] | null }, v: string | undefined) => {
    if (!filled(v)) return;
    if (def.input === 'choice' && def.options && !def.options.includes(v!)) out.push({ path, message: `${def.label}: choose one of ${def.options.join(', ')}` });
    if (def.input === 'date' && !isRealDate(v!.trim())) out.push({ path, message: `${def.label}: use a real date in YYYY-MM-DD form` });
  };
  for (const f of schema.fields) check(`fields.${f.key}`, f, data.fields[f.key]);
  for (const s of schema.schedules) {
    (data.schedules[s.key] ?? []).forEach((row, i) => {
      for (const c of s.columns) check(`schedules.${s.key}.${i}.${c.key}`, c, row[c.key]);
    });
  }
  return out;
}

const rowPopulated = (s: TemplateSchedule, row: Record<string, string>) => filled(row[ROW_LABEL]) || s.columns.some((c) => filled(row[c.key]));

/**
 * Completion rules from the master form standard: every required field outside the approval block is
 * filled (NA plus rationale is an answer), every populated row has its required columns, every printed
 * checklist row is answered, and an added row names what it covers.
 */
export function completionProblems(schema: TemplateSchema, data: RecordData): Problem[] {
  const out: Problem[] = valueProblems(schema, data);
  for (const f of schema.fields) {
    if (f.role !== 'ENTRY' || f.requirement !== 'REQUIRED') continue;
    if (!filled(data.fields[f.key])) out.push({ path: `fields.${f.key}`, message: `${f.label} is required (enter NA with a reason if it does not apply)` });
  }
  for (const s of schema.schedules) {
    if (s.key === EVIDENCE_SCHEDULE) continue;
    const rows = data.schedules[s.key] ?? [];
    const printed = s.rowLabels?.length ?? 0;
    rows.forEach((row, i) => {
      if (i >= printed && !rowPopulated(s, row)) return;
      const name = i < printed ? s.rowLabels![i]! : row[ROW_LABEL] || `row ${i + 1}`;
      if (i >= printed && s.rowLabels && !filled(row[ROW_LABEL])) out.push({ path: `schedules.${s.key}.${i}._label`, message: `${s.title ?? s.key}: name the added row ${i + 1}` });
      for (const c of s.columns) {
        if (c.requirement === 'REQUIRED' && !filled(row[c.key])) out.push({ path: `schedules.${s.key}.${i}.${c.key}`, message: `${s.title ?? s.key} — ${name}: ${c.label} is required` });
      }
    });
    for (let i = rows.length; i < printed; i += 1) {
      out.push({ path: `schedules.${s.key}.${i}`, message: `${s.title ?? s.key} — ${s.rowLabels![i]}: answer this row (NA with a reason if it does not apply)` });
    }
  }
  return out;
}
