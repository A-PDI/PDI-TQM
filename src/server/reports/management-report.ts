import type { RecordReportSnapshot } from '../pdf/record-report.js';
import { formatDate, formatDateTime } from '../pdf/text.js';
import type { Overview } from './metrics.js';

const words = (s: string) => s.replaceAll('_', ' ').toLowerCase();
const pct = (v: number | null) => (v === null ? 'n/a' : `${v}%`);
const ratio = (r: { pass: number | undefined; of: number | undefined; percent: number | null }) => (r.of ? `${r.pass} of ${r.of} (${pct(r.percent)})` : 'no tests on this basis');

/** Frozen management report edition: the overview figures, filters and definitions as issued. */
export function buildManagementReport(o: Overview, number: string, filters: string): RecordReportSnapshot {
  const tz = o.period.timeZone;
  const c = o.corrective.counts;
  const inj = o.injectors;
  return {
    kind: 'RECORD_REPORT',
    schemaVersion: 1,
    title: 'Quality Management Report',
    docCode: 'TQMS-MR',
    number,
    edition: 0,
    generatedAt: o.generatedAt,
    displayTimeZone: tz,
    outcome: {
      label: `${formatDate(o.period.from, tz)} – ${formatDate(o.period.to, tz)}`,
      tone: 'neutral',
      note: `Definitions ${o.definitionsVersion}. Period figures use whole dates in ${tz}; "now" figures are as of ${formatDateTime(o.generatedAt, tz)}.`,
    },
    meta: [
      ['Period', `${o.period.from} to ${o.period.to} (${tz})`],
      ['Filters', filters],
      ['Expiry horizon', `${o.horizon.days} days (until ${o.horizon.until}); reporting window, not a policy limit`],
      ['Definitions', o.definitionsVersion],
    ],
    sections: [
      {
        title: 'INSPECTION THROUGHPUT AND OUTCOMES',
        kind: 'table',
        columns: [
          { header: 'Measure', width: 0.6 },
          { header: 'Value', width: 0.4 },
        ],
        rows: [
          ['Inspections started in period', String(o.inspections.started)],
          ['Inspections completed in period', String(o.inspections.completed)],
          ['Outcome pass', String(o.inspections.outcomes.PASS)],
          ['Outcome accepted with deviation', String(o.inspections.outcomes.ACCEPTED)],
          ['Outcome fail', String(o.inspections.outcomes.FAIL)],
          ['Fail rate (fail ÷ completed)', pct(o.inspections.failRate)],
          ['Awaiting review now', String(c.awaiting_review)],
        ],
      },
      {
        title: 'DEFECT TYPES (FLAGGED CHECKLIST ROWS)',
        kind: 'table',
        columns: [
          { header: 'Section', width: 0.25 },
          { header: 'Row', width: 0.33 },
          { header: 'Fail', width: 0.08 },
          { header: 'Accepted', width: 0.1 },
          { header: 'Inspections', width: 0.1 },
          { header: 'Parts', width: 0.14 },
        ],
        rows: o.inspections.defects.length
          ? o.inspections.defects.map((d) => [d.section, d.name, String(d.fail), String(d.accepted), String(d.inspections), d.parts.join(', ')])
          : [['No flagged rows in the period', '', '', '', '', '']],
      },
      {
        title: 'SUPPLIER QUALITY',
        kind: 'table',
        columns: [
          { header: 'Supplier', width: 0.26 },
          { header: 'Completed', width: 0.1 },
          { header: 'Fail (rate)', width: 0.12 },
          { header: 'NCRs', width: 0.1 },
          { header: 'Open NCR/SCAR', width: 0.12 },
          { header: 'Overdue cmts', width: 0.12 },
          { header: 'Site qualification', width: 0.18 },
        ],
        rows: o.suppliers.length
          ? o.suppliers.map((s) => [
              `${s.code} ${s.name}`,
              String(s.completed),
              `${s.failed} (${pct(s.failRate)})`,
              String(s.ncrs),
              `${s.openNcrs} / ${s.openScars}`,
              String(s.overdueCommitments),
              s.sites.map(words).join(', ') || '—',
            ])
          : [['No supplier activity in the period', '', '', '', '', '', '']],
      },
      {
        title: 'CORRECTIVE ACTIONS (NOW)',
        kind: 'table',
        columns: [
          { header: 'Measure', width: 0.6 },
          { header: 'Value', width: 0.4 },
        ],
        rows: [
          ['NCRs confirmed in period / closed in period', `${o.corrective.ncrsConfirmed} / ${o.corrective.ncrsClosed}`],
          ['Open NCRs', String(c.open_ncrs)],
          ...o.corrective.ncrBySeverity.map((r): string[] => [`  ${words(r.severity)} — ${words(r.status)}`, String(r.n)]),
          ['Open SCARs / overdue responses', `${c.open_scars} / ${c.overdue_scars}`],
          ['Open commitments / overdue / undated', `${c.open_commitments} / ${c.overdue_commitments} / ${c.undated_commitments}`],
        ],
      },
      {
        title: 'OVERDUE ITEMS',
        kind: 'table',
        columns: [
          { header: 'Type', width: 0.12 },
          { header: 'Number', width: 0.16 },
          { header: 'Subject', width: 0.4 },
          { header: 'Due', width: 0.14 },
          { header: 'Owner', width: 0.18 },
        ],
        rows: o.corrective.overdue.length ? o.corrective.overdue.map((r) => [r.type, r.number, r.title, formatDate(r.due, tz), r.owner]) : [['None overdue', '', '', '', '']],
      },
      {
        title: 'QUALIFICATION AND EXPIRING EVIDENCE',
        kind: 'table',
        columns: [
          { header: 'Type', width: 0.18 },
          { header: 'Item', width: 0.32 },
          { header: 'Supplier', width: 0.3 },
          { header: 'Valid until', width: 0.2 },
        ],
        rows: [
          ['Sites by qualification', Object.entries(o.qualification.byStatus).map(([k, v]) => `${words(k)} ${v}`).join(', ') || 'No sites', `${o.qualification.sites} site(s)`, ''],
          ...o.qualification.expiring.map((e) => [e.type, e.label, e.supplier, `${formatDate(e.valid_until, tz)}${e.expired ? ' (expired)' : ''}`]),
        ],
      },
      {
        title: 'CHANGES AND APPROVAL DECISIONS',
        kind: 'table',
        columns: [
          { header: 'Type', width: 0.16 },
          { header: 'Number', width: 0.15 },
          { header: 'Decision', width: 0.16 },
          { header: 'Subject', width: 0.3 },
          { header: 'Decided', width: 0.23 },
        ],
        rows: [
          [
            'Changes',
            '',
            `${o.changes.requested} requested, ${o.changes.decided} decided`,
            o.changes.byStatus.map((s) => `${words(s.status)} ${s.n}`).join(', ') || 'none',
            '',
          ],
          ...o.approvals.map((a) => [a.type, a.number, words(a.decision), a.subject, `${formatDateTime(new Date(a.decided_at).toISOString(), tz)} ${a.decided_by}`]),
        ],
      },
      {
        title: 'RECURRENCE',
        kind: 'table',
        columns: [
          { header: 'Part / supplier', width: 0.3 },
          { header: 'Characteristic / failure mode', width: 0.35 },
          { header: 'Records', width: 0.35 },
        ],
        rows: [
          ...o.recurrence.groups.map((g) => [`${g.part_number ?? '—'} / ${g.supplier ?? '—'}`, `${g.characteristic || '—'} / ${g.failure_mode || '—'}`, g.ncrs.map((n) => n.number).join(', ')]),
          ...o.recurrence.faiRepeats.map((f) => [`Repeats rejected FAI ${f.fai_number}`, f.characteristic, `${f.ncr_number}${f.lot_number ? ` lot ${f.lot_number}` : ''}`]),
          ...(o.recurrence.groups.length || o.recurrence.faiRepeats.length ? [] : [['No recurrence in the period', '', '']]),
        ],
      },
      {
        title: 'INJECTOR TEST AND REPAIR PERFORMANCE',
        kind: 'table',
        columns: [
          { header: 'Measure', width: 0.6 },
          { header: 'Value', width: 0.4 },
        ],
        rows: [
          ['Bench tests / injectors / retests', `${inj.tests} / ${inj.injectors} / ${inj.retests}`],
          ['First-pass yield, machine verdict', ratio(inj.firstPassYield.machine)],
          ['First-pass yield, PDI criteria', ratio(inj.firstPassYield.pdi)],
          ['Post-repair yield, machine verdict', ratio(inj.postRepairYield.machine)],
          ['Post-repair yield, PDI criteria', ratio(inj.postRepairYield.pdi)],
          ...inj.failureModes.slice(0, 8).map((f) => [`Failure: ${String(f.condition)} / ${String(f.parameter)}`, `${String(f.failures)} (PDI outside ${String(f.outside_pdi)}, machine fail ${String(f.machine_fail)})`]),
        ],
      },
      {
        title: 'CALCULATION DEFINITIONS',
        kind: 'text',
        paragraphs: [...Object.values(o.definitions).flat(), ...inj.definitions],
      },
    ],
  };
}
