/**
 * Action-scoped capabilities (FR-001, FR-111). A person may hold several; role bundles
 * are only a convenience for granting a typical set and carry no authority themselves.
 */
export const CAPABILITIES = {
  'records.read': { description: 'Read operational records, evidence and reports', sensitive: false },
  'inspection.perform': { description: 'Start and perform receiving inspections', sensitive: false },
  'inspection.assign': { description: 'Assign or reassign inspections', sensitive: false },
  'inspection.review': { description: 'Independently review exceptional inspection results', sensitive: true },
  'inspection.review_accepted': { description: 'Confirm Accepted (nonconforming) inspection results in review', sensitive: true },
  'inspection.amend': { description: 'Record attributable amendments to completed inspections', sensitive: true },
  'quality.capture': { description: 'Record quick quality concerns', sensitive: false },
  'quality.triage': { description: 'Triage quality concerns', sensitive: true },
  'masterdata.edit': { description: 'Create and maintain parts and aliases', sensitive: false },
  'forms.publish': { description: 'Draft and release controlled inspection form revisions', sensitive: true },
  'engineering.author': { description: 'Draft technical baseline revisions and characteristics', sensitive: false },
  'engineering.release': { description: 'Release technical baseline revisions', sensitive: true },
  'supplier.manage': { description: 'Maintain suppliers, sites, supplier parts and certificates; record assessments', sensitive: false },
  'supplier.qualify': { description: 'Decide supplier and site qualification', sensitive: true },
  'supplier.restrict': { description: 'Suspend and reinstate suppliers or sites', sensitive: true },
  'sourcing.manage': { description: 'Run sourcing requests, exact sources, acknowledgments and first-article samples', sensitive: false },
  'validation.decide': { description: 'Decide first-article and validation samples', sensitive: true },
  'requirement.waive': { description: 'Waive a required evidence item with a recorded reason', sensitive: true },
  'source.approve': { description: 'Approve or reject an exact product source', sensitive: true },
  'work.view_team': { description: 'View team-wide and unassigned work', sensitive: false },
  'reports.export': { description: 'Export operational data', sensitive: false },
  'admin.users': { description: 'Manage user accounts and authority grants', sensitive: true },
  'admin.system': { description: 'View system health, jobs and audit', sensitive: true },
} as const;

export type Capability = keyof typeof CAPABILITIES;
export const CAPABILITY_CODES = Object.keys(CAPABILITIES) as Capability[];

export const ROLE_BUNDLES: Record<string, { label: string; capabilities: Capability[] }> = {
  inspector: {
    label: 'Receiving inspector',
    capabilities: ['records.read', 'inspection.perform', 'quality.capture'],
  },
  quality: {
    label: 'Quality',
    capabilities: ['records.read', 'inspection.review', 'quality.capture', 'quality.triage', 'work.view_team', 'validation.decide', 'supplier.qualify', 'requirement.waive'],
  },
  engineering: {
    label: 'Engineering',
    capabilities: [
      'records.read',
      'inspection.review',
      'quality.capture',
      'quality.triage',
      'engineering.author',
      'engineering.release',
      'forms.publish',
      'sourcing.manage',
    ],
  },
  manager: {
    label: 'Management',
    capabilities: [
      'records.read',
      'inspection.assign',
      'inspection.review',
      'inspection.review_accepted',
      'inspection.amend',
      'quality.capture',
      'quality.triage',
      'work.view_team',
      'reports.export',
      'supplier.qualify',
      'supplier.restrict',
      'validation.decide',
      'requirement.waive',
      'source.approve',
    ],
  },
  purchasing: {
    label: 'Purchasing / sourcing',
    capabilities: ['records.read', 'quality.capture', 'masterdata.edit', 'supplier.manage', 'sourcing.manage', 'engineering.author'],
  },
  administrator: {
    label: 'Administrator',
    capabilities: ['records.read', 'admin.users', 'admin.system'],
  },
};
