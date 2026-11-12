/**
 * Supplier agreements and controlled quality specifications (owner request, 12 Nov 2026).
 * One package per supplier agreement: Layer A (master agreement, quality agreement), Layer B
 * (controlled technical specifications) and Layer C (part-specific schedules = technical baselines).
 */

export const AGREEMENT_KINDS = ['AGREEMENT', 'AMENDMENT', 'RENEWAL'] as const;
export type AgreementKind = (typeof AGREEMENT_KINDS)[number];

export const AGREEMENT_STATUSES = ['DRAFT', 'IN_REVIEW', 'AWAITING_EXECUTION', 'EXECUTED', 'SUPERSEDED', 'TERMINATED', 'CANCELLED'] as const;
export type AgreementStatus = (typeof AGREEMENT_STATUSES)[number];
/** Stored status plus EXPIRED, derived for an executed agreement whose expiry date has passed. */
export type AgreementState = AgreementStatus | 'EXPIRED';

export const AGREEMENT_STATE_TEXT: Record<AgreementState, string> = {
  DRAFT: 'Draft',
  IN_REVIEW: 'Internal review',
  AWAITING_EXECUTION: 'Approved — awaiting signatures',
  EXECUTED: 'Executed',
  EXPIRED: 'Expired',
  SUPERSEDED: 'Superseded',
  TERMINATED: 'Terminated',
  CANCELLED: 'Cancelled',
};

export function agreementState(a: { status: AgreementStatus; expires_on?: string | null; expiresOn?: string | null }, today: string): AgreementState {
  const expires = a.expires_on ?? a.expiresOn ?? null;
  return a.status === 'EXECUTED' && expires && expires < today ? 'EXPIRED' : a.status;
}

export const DOCUMENT_ROLES = ['MASTER_AGREEMENT', 'QUALITY_AGREEMENT', 'SPECIFICATION', 'PART_SCHEDULE', 'EXHIBIT'] as const;
export type DocumentRole = (typeof DOCUMENT_ROLES)[number];

export const ROLE_TEXT: Record<DocumentRole, string> = {
  MASTER_AGREEMENT: 'Master Supplier Agreement',
  QUALITY_AGREEMENT: 'Supplier Quality Agreement',
  SPECIFICATION: 'Controlled specification',
  PART_SCHEDULE: 'Part-specific schedule',
  EXHIBIT: 'Exhibit',
};

/** Default precedence by role (lower governs); a document classification may set its own. */
export const DEFAULT_PRECEDENCE: Record<DocumentRole, number> = {
  MASTER_AGREEMENT: 10,
  QUALITY_AGREEMENT: 20,
  SPECIFICATION: 30,
  PART_SCHEDULE: 40,
  EXHIBIT: 90,
};

export const CLASSIFICATIONS = ['MASTER_AGREEMENT', 'QUALITY_AGREEMENT', 'TECHNICAL_SPECIFICATION'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export const CLASSIFICATION_TEXT: Record<Classification, string> = {
  MASTER_AGREEMENT: 'Master supplier agreement template',
  QUALITY_AGREEMENT: 'Supplier quality agreement',
  TECHNICAL_SPECIFICATION: 'Controlled technical / quality specification',
};

/** The role a classified document takes in a package. */
export const ROLE_OF: Record<Classification, DocumentRole> = {
  MASTER_AGREEMENT: 'MASTER_AGREEMENT',
  QUALITY_AGREEMENT: 'QUALITY_AGREEMENT',
  TECHNICAL_SPECIFICATION: 'SPECIFICATION',
};

/** Appendix B SUP-03 is the Supplier Quality Agreement unless document control classifies it otherwise. */
export const DEFAULT_CLASSIFICATION: Record<string, Classification> = { 'SUP-03': 'QUALITY_AGREEMENT' };

export const SIGNATURE_ROLES = ['PDI_APPROVAL', 'LEGAL_REVIEW', 'PDI_SIGNATORY', 'SUPPLIER_SIGNATORY'] as const;
export type SignatureRole = (typeof SIGNATURE_ROLES)[number];
export const SIGNATURE_TEXT: Record<SignatureRole, string> = {
  PDI_APPROVAL: 'PDI internal approval',
  LEGAL_REVIEW: 'Legal review',
  PDI_SIGNATORY: 'Authorized PDI signatory',
  SUPPLIER_SIGNATORY: 'Supplier authorized signatory',
};

/** Applicability of one manifest line: empty lists mean "not restricted on that axis". */
export interface Applicability {
  siteIds: string[];
  partIds: string[];
  productFamilies: string[];
}

const norm = (s: string) => s.trim().toUpperCase();
const overlap = (a: string[], b: string[]) => a.length === 0 || b.length === 0 || a.some((x) => b.map(norm).includes(norm(x)));

/** Whether two lines can govern the same product at the same site. */
export function applicabilityOverlaps(a: Applicability, b: Applicability): boolean {
  return overlap(a.siteIds, b.siteIds) && overlap(a.partIds, b.partIds) && overlap(a.productFamilies, b.productFamilies);
}

/** A part (with its classification) at a site falls under a line. */
export function lineApplies(line: Applicability, target: { siteId: string | null; partId: string; family: string | null }): boolean {
  // An unknown site (e.g. a concern raised without one) is not excluded on the site axis.
  if (line.siteIds.length && target.siteId && !line.siteIds.includes(target.siteId)) return false;
  if (line.partIds.length && !line.partIds.includes(target.partId)) return false;
  if (line.productFamilies.length && !(target.family && line.productFamilies.map(norm).includes(norm(target.family)))) return false;
  return true;
}

/** A classified specification's rules match a part when any configured axis matches (or none is configured). */
export function specificationMatches(rules: { productFamilies: string[]; materials: string[]; processes: string[] }, part: { family: string | null; material: string | null; process: string | null }): boolean {
  const axes: Array<[string[], string | null]> = [
    [rules.productFamilies, part.family],
    [rules.materials, part.material],
    [rules.processes, part.process],
  ];
  const configured = axes.filter(([r]) => r.length > 0);
  if (!configured.length) return false;
  return configured.some(([r, v]) => v !== null && r.map(norm).includes(norm(v)));
}

/** One manifest line as conflict detection sees it. */
export interface ConflictLine extends Applicability {
  key: string;
  /** Document identity independent of revision (document, baseline or file id). */
  identity: string;
  role: DocumentRole;
  documentNumber: string;
  revisionLabel: string;
  precedence: number;
  category: string | null;
}

export type ConflictKind = 'REVISIONS' | 'CATEGORY' | 'PRECEDENCE';
export interface Conflict {
  kind: ConflictKind;
  keys: [string, string];
  message: string;
}

/**
 * Precedence conflicts are reported, never resolved: two revisions of one document, two
 * specifications of one category, or equal precedence across different roles, wherever their
 * applicability overlaps. The approver must record how each is resolved.
 */
export function detectConflicts(lines: ConflictLine[]): Conflict[] {
  const out: Conflict[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i]!;
      const b = lines[j]!;
      if (!applicabilityOverlaps(a, b)) continue;
      const pair: [string, string] = [a.key, b.key];
      if (a.identity === b.identity) {
        if (a.revisionLabel !== b.revisionLabel) {
          out.push({ kind: 'REVISIONS', keys: pair, message: `${a.documentNumber} is incorporated at Rev ${a.revisionLabel} and Rev ${b.revisionLabel} for overlapping scope` });
        }
        continue;
      }
      if (a.role === 'SPECIFICATION' && b.role === 'SPECIFICATION' && a.category && a.category === b.category) {
        out.push({ kind: 'CATEGORY', keys: pair, message: `${a.documentNumber} and ${b.documentNumber} are both ${a.category.toLowerCase().replaceAll('_', ' ')} specifications for overlapping scope` });
      }
      if (a.role !== b.role && a.precedence === b.precedence && a.role !== 'EXHIBIT' && b.role !== 'EXHIBIT') {
        out.push({ kind: 'PRECEDENCE', keys: pair, message: `${a.documentNumber} (${ROLE_TEXT[a.role]}) and ${b.documentNumber} (${ROLE_TEXT[b.role]}) share precedence ${a.precedence}` });
      }
    }
  }
  return out;
}

/** Renewal reminder window shown on the supplier page (days before expiry). */
export const RENEWAL_NOTICE_DAYS = 90;

/** Structured content of a part-specific schedule (Annex A), stored on the technical baseline revision. */
export const SCHEDULE_FIELDS = [
  { key: 'material', label: 'Material requirements' },
  { key: 'process', label: 'Manufacturing process requirements' },
  { key: 'identification', label: 'Identification and marking' },
  { key: 'logo', label: 'Logo requirements' },
  { key: 'additionalInspection', label: 'Additional inspection requirements' },
  { key: 'authorizedExceptions', label: 'Authorized exceptions' },
] as const;
