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
  'engineering.release': { description: 'Release technical baseline revisions', sensitive: true },
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
    capabilities: ['records.read', 'inspection.review', 'quality.capture', 'quality.triage', 'work.view_team'],
  },
  engineering: {
    label: 'Engineering',
    capabilities: ['records.read', 'inspection.review', 'quality.capture', 'quality.triage', 'engineering.release', 'forms.publish'],
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
    ],
  },
  purchasing: {
    label: 'Purchasing / sourcing',
    capabilities: ['records.read', 'quality.capture', 'masterdata.edit'],
  },
  administrator: {
    label: 'Administrator',
    capabilities: ['records.read', 'admin.users', 'admin.system'],
  },
};
