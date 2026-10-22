/**
 * Controlled quality-system document library (FR-008, FR-090, FR-091). Document identity is read
 * from the owner's file naming convention, `<CODE>_<Title>_Rev<NN>.pdf`:
 *   OPS-06_Nonconformance_Report_Rev03.pdf      → form OPS-06, revision 03
 *   OPS-07_actions_Continuation_Rev03.pdf       → continuation sheet OPS-07/actions
 *   PDI_Master_Form_Standard_Rev03.pdf          → library document PDI-Master-Form-Standard
 */
export type DocumentKind = 'FORM' | 'CONTINUATION' | 'LIBRARY';

export interface ParsedDocumentName {
  number: string;
  typeCode: string | null;
  family: string;
  kind: DocumentKind;
  title: string;
  revisionLabel: string;
}

/** Appendix B record and document types (B2), by business code. */
export const DOCUMENT_TYPES: Record<string, string> = {
  'INT-01': 'Product Sourcing Request (PSR)',
  'INT-02': 'Sourcing Path & Risk Assessment (SPRA)',
  'SUP-01': 'Supplier Qualification Questionnaire (SQQ)',
  'SUP-02': 'Supplier Capability / Process Assessment (SCA)',
  'SUP-03': 'Supplier Quality Agreement (SQA)',
  'SUP-04': 'Non-Disclosure Agreement (NDA)',
  'SUP-05': 'Sub-tier / Critical Process Disclosure',
  'ENG-01': 'Customer-Controlled Drawing / TDP Checklist (TDP)',
  'ENG-02': 'Design Review & Engineering Release (DRR)',
  'ENG-03': 'Physical Sample / Reverse Engineering Intake (REI)',
  'ENG-04': 'Supplier Baseline Product Specification (SBPS)',
  'ENG-05': 'Supplier Part Cross-Reference & Configuration Record (SPCR)',
  'ENG-06': 'Customer-Specific Requirements / Delta Specification',
  'ENG-07': 'Altered / Selected Item Drawing (AID / SID)',
  'ENG-08': 'Critical Characteristics & Acceptance Matrix (CCM)',
  'ENG-09': 'Specification / Revision Change Record (ECR / ECN)',
  'VAL-01': 'Product Qualification & Validation Plan (PQP)',
  'VAL-02': 'First Article Inspection Report (FAI / FAIR)',
  'VAL-03': 'Functional / Performance Test Report (PTR)',
  'VAL-04': 'Material / Coating / Special Process Certificate Checklist',
  'VAL-05': 'PPAP Applicability & Submission Requirements',
  'VAL-06': 'Part Submission Warrant (PSW)',
  'VAL-07': 'Process Failure Mode and Effects Analysis (PFMEA)',
  'VAL-08': 'Production Control Plan (CP)',
  'VAL-09': 'Measurement System Analysis (MSA / GRR)',
  'VAL-10': 'Process Capability / SPC Study',
  'VAL-11': 'Product & Supplier Approval Record (PSAR)',
  'OPS-01': 'Incoming Inspection Plan (IIP)',
  'OPS-02': 'Incoming Inspection Report (IIR)',
  'OPS-03': 'Supplier Product / Process Change Request (SCR / PCN)',
  'OPS-04': 'Change Impact & Requalification Decision (CIRD)',
  'OPS-05': 'Temporary Deviation / Concession Request (DCR)',
  'OPS-06': 'Nonconformance Report (NCR)',
  'OPS-07': 'Supplier Corrective Action Request (SCAR)',
  'OPS-08': 'Structured Problem-Solving Report (8D)',
  'OPS-09': 'Supplier Performance Scorecard (SPS)',
  'SYS-01': 'Document Type / Retention & Approval Rules (DRM)',
};

export const DOCUMENT_FAMILIES: Record<string, string> = {
  INT: 'Sourcing intake',
  SUP: 'Supplier',
  ENG: 'Engineering',
  VAL: 'Validation & approval',
  OPS: 'Operations & quality',
  PRS: 'Product requirements',
  SYS: 'System administration',
  PDI: 'Library',
};

/**
 * Where a document type is handled in the application. GENERATED: the app produces this record and
 * its numbered PDF; RECORDED: the record is captured on that screen without a dedicated PDF.
 */
export const DOCUMENT_USAGE: Record<string, { how: 'GENERATED' | 'RECORDED'; route: string; screen: string }> = {
  'INT-01': { how: 'RECORDED', route: '/sourcing', screen: 'Sourcing requests' },
  'INT-02': { how: 'RECORDED', route: '/sourcing', screen: 'Sourcing requests (path and risk)' },
  'SUP-01': { how: 'RECORDED', route: '/suppliers', screen: 'Supplier qualification' },
  'SUP-02': { how: 'RECORDED', route: '/suppliers', screen: 'Supplier assessments' },
  'VAL-02': { how: 'RECORDED', route: '/sourcing', screen: 'First-article samples' },
  'VAL-03': { how: 'GENERATED', route: '/injectors', screen: 'Injector test reports' },
  'VAL-11': { how: 'GENERATED', route: '/sources', screen: 'Source approval records' },
  'OPS-01': { how: 'RECORDED', route: '/forms', screen: 'Inspection forms' },
  'OPS-02': { how: 'GENERATED', route: '/inspections', screen: 'Incoming inspections' },
  'OPS-03': { how: 'GENERATED', route: '/changes', screen: 'Changes' },
  'OPS-04': { how: 'GENERATED', route: '/changes', screen: 'Changes' },
  'OPS-05': { how: 'GENERATED', route: '/quality/concessions', screen: 'Concessions' },
  'OPS-06': { how: 'GENERATED', route: '/quality/ncrs', screen: 'Nonconformance reports' },
  'OPS-07': { how: 'GENERATED', route: '/quality/scars', screen: 'Supplier corrective actions' },
  'OPS-08': { how: 'GENERATED', route: '/quality/scars', screen: 'Supplier corrective actions (8D)' },
};

const humanize = (s: string) =>
  s
    .split('_')
    .filter(Boolean)
    .map((w) => (w === w.toLowerCase() ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');

/** Reads document identity from a file name; returns null when it does not follow the convention. */
export function parseDocumentFilename(fileName: string): ParsedDocumentName | null {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const m = /^(.+)_Rev([0-9A-Za-z]{1,6})\.pdf$/i.exec(base);
  if (!m) return null;
  const [, stem, revisionLabel] = m as unknown as [string, string, string];

  const coded = /^([A-Z]{3})-(\d{2,3})_([A-Za-z0-9_&-]+)$/.exec(stem);
  if (coded) {
    const [, family, num, rest] = coded as unknown as [string, string, string, string];
    const code = `${family}-${num}`;
    const continuation = /^([a-z0-9_]+)_Continuation$/.exec(rest);
    if (continuation) {
      const section = continuation[1]!;
      return { number: `${code}/${section.replace(/_/g, '-')}`, typeCode: code, family, kind: 'CONTINUATION', title: `Continuation sheet — ${humanize(section)}`, revisionLabel };
    }
    return { number: code, typeCode: code, family, kind: 'FORM', title: DOCUMENT_TYPES[code] ?? humanize(rest), revisionLabel };
  }

  const library = /^PDI_([A-Za-z0-9_&-]+)$/.exec(stem);
  if (library) {
    const rest = library[1]!;
    return { number: `PDI-${rest.replace(/_/g, '-')}`, typeCode: null, family: 'PDI', kind: 'LIBRARY', title: humanize(rest), revisionLabel };
  }
  return null;
}

export const FILENAME_RULE = 'Name files <CODE>_<Title>_Rev<NN>.pdf (for example OPS-06_Nonconformance_Report_Rev03.pdf), <CODE>_<section>_Continuation_Rev<NN>.pdf, or PDI_<Title>_Rev<NN>.pdf';
