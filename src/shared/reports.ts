import { METRICS_VERSION } from './injectors.js';

export { METRICS_VERSION };

/**
 * Calculation definitions shared by Home, the reports overview, CSV exports and issued
 * management reports (FR-102). Changing any of these requires a new METRICS_VERSION.
 */
export const METRIC_DEFINITIONS: Record<string, string[]> = {
  period: [
    'A period is a range of whole calendar dates, both ends included, in the display time zone.',
    'Period counts use the date of the event named in each metric (completion, confirmation, decision, bench test).',
    '"Now" counts (open, overdue, current status) ignore the period and describe the records as they are at generation time.',
  ],
  inspections: [
    'Completed: inspections whose completion date falls in the period. Voided inspections are excluded.',
    'Outcome: the latest amended outcome where an amendment exists, otherwise the outcome at completion.',
    'Defect types: checklist rows answered Fail or Accepted-with-deviation (latest answer per unit and row) on completed inspections in the period, counted per unit.',
  ],
  suppliers: [
    'Supplier quality lists every supplier with at least one completed inspection or confirmed NCR in the period, or open NCR/SCAR/commitment now.',
    'Fail rate = completed inspections with outcome Fail ÷ completed inspections for that supplier in the period.',
  ],
  corrective: [
    'Open NCR: any status other than Closed. Open SCAR: any status other than Closed.',
    'Overdue SCAR: issued and awaiting the supplier response with a response due date before today.',
    'Overdue commitment: open or supplier-claims-done with a due date before today. Commitments without a date are listed as undated, never overdue.',
  ],
  qualification: [
    'Site qualification: the latest qualification decision for the site; a decided qualification past its validity date reads Expired.',
    'Expiring: certificates and qualifications with a validity date on or before today plus the selected horizon. The horizon is a reporting window, not a policy limit.',
  ],
  changes: ['Changes by status are counted now. Requested and decided counts use the request and decision dates in the period.'],
  approvals: ['Approval history lists source approvals, site qualification decisions, FAI decisions, concession decisions and change decisions dated in the period.'],
  recurrence: [
    'Recurrence groups NCRs confirmed in the period by part, supplier, characteristic and failure mode; a group is listed when it holds two or more NCRs.',
    'Repeated FAI defect: an NCR in the period whose characteristic matches (case-insensitive) a characteristic that was outside limits or nonconforming on a rejected FAI sample for the same part and supplier.',
  ],
};
