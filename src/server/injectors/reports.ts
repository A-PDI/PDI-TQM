import { BENCH_ADAPTER_NOTE } from '../../shared/injectors.js';
import { type Queryable, many, one } from '../db.js';
import type { RecordReportSnapshot } from '../pdf/record-report.js';
import { formatDateTime } from '../pdf/text.js';
import type { Comparison } from './routes.js';

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const words = (s: string) => s.replaceAll('_', ' ').toLowerCase();

function base(title: string, number: string, tz: string): Omit<RecordReportSnapshot, 'outcome' | 'meta' | 'sections'> {
  // VAL-03 Functional / Performance Test Report (Appendix B catalogue).
  return { kind: 'RECORD_REPORT', schemaVersion: 1, title, docCode: 'VAL-03', number, edition: 0, generatedAt: new Date().toISOString(), displayTimeZone: tz };
}

/** First vs latest bench values for up to 12 injectors, values exactly as recorded. */
export function buildComparisonReport(c: Comparison, number: string, tz: string): RecordReportSnapshot {
  const tested = c.injectors.filter((i) => i.first);
  const valueWidth = 0.62 / Math.max(1, c.injectors.length);
  const cell = (v: { value: string; evaluation: string } | null) => (v ? `${v.value}${v.evaluation === 'OUTSIDE' || v.evaluation === 'FAIL' ? ' (!)' : ''}` : '—');
  return {
    ...base('Injector Test Comparison', number, tz),
    outcome: {
      label: `${c.injectors.length} INJECTOR${c.injectors.length === 1 ? '' : 'S'}`,
      tone: 'neutral',
      note: `${tested.length} of ${c.injectors.length} have bench data. A comparison is informational; it is not a PDI verdict or a material release.`,
    },
    meta: [
      ['Injectors', c.injectors.map((i) => i.serialNumber).join(', ')],
      ['Parts', [...new Set(c.injectors.map((i) => i.partNumber))].join(', ')],
      ['Data source', BENCH_ADAPTER_NOTE],
    ],
    sections: [
      {
        title: 'TESTS COMPARED',
        kind: 'table',
        columns: [
          { header: 'Serial', width: 0.18 },
          { header: 'Part', width: 0.14 },
          { header: 'Tests', width: 0.08 },
          { header: 'First test (machine / PDI)', width: 0.3 },
          { header: 'Latest test (machine / PDI)', width: 0.3 },
        ],
        rows: c.injectors.map((i) => [
          i.serialNumber,
          i.partNumber,
          String(i.tests),
          i.first ? `${formatDateTime(iso(i.first.testedAt), tz)} — ${words(i.first.machineVerdict)} / ${words(i.first.pdiEvaluation)}` : 'Not tested',
          i.latest ? `${formatDateTime(iso(i.latest.testedAt), tz)} — ${words(i.latest.machineVerdict)} / ${words(i.latest.pdiEvaluation)}${i.latest.afterRepair ? ' (after repair)' : ''}` : '—',
        ]),
      },
      {
        title: 'VALUES: FIRST → LATEST',
        kind: 'table',
        columns: [
          { header: 'Condition / parameter', width: 0.26 },
          { header: 'Unit', width: 0.12 },
          ...c.injectors.map((i) => ({ header: i.serialNumber, width: valueWidth })),
        ],
        rows: c.rows.length
          ? c.rows.map((r) => [
              `${r.condition} / ${r.parameter}`,
              r.unit ?? '—',
              ...r.values.map((v) => (v.latest ? `${cell(v.first)} → ${cell(v.latest)}` : cell(v.first))),
            ])
          : [['No bench values recorded', '', ...c.injectors.map(() => '')]],
      },
      {
        title: 'NOTES',
        kind: 'text',
        paragraphs: [
          '(!) marks a value outside the released PDI criteria, or a machine FAIL where no PDI criteria are released.',
          'Machine verdicts are reported by the bench; PDI evaluations use released PDI criteria only. The two are never merged.',
        ],
      },
    ],
  };
}

/** Frozen shipment evaluation (not a material release). */
export async function buildShipmentReport(db: Queryable, id: string, tz: string): Promise<RecordReportSnapshot> {
  const e = (await one<{ number: string; reference: string; note: string | null; conclusion: string; evaluated_at: Date; evaluated_by_name: string }>(
    db,
    'SELECT e.number, e.reference, e.note, e.conclusion, e.evaluated_at, u.display_name AS evaluated_by_name FROM shipment_evaluation e JOIN app_user u ON u.id = e.evaluated_by WHERE e.id = $1',
    [id],
  ))!;
  const items = await many<{ position: number; result: string; basis: string; serial_number: string; part_number: string; tested_at: Date | null; machine_id: string | null }>(
    db,
    `SELECT i.position, i.result, i.basis, j.serial_number, p.part_number, t.tested_at, t.machine_id
       FROM shipment_evaluation_item i JOIN injector j ON j.id = i.injector_id JOIN company_part p ON p.id = j.part_id LEFT JOIN injector_test t ON t.id = i.test_id
      WHERE i.evaluation_id = $1 ORDER BY i.position`,
    [id],
  );
  const count = (r: string) => items.filter((i) => i.result === r).length;
  const allPass = e.conclusion === 'ALL_PASS';
  return {
    ...base('Injector Shipment Evaluation', e.number, tz),
    outcome: {
      label: allPass ? 'ALL PASS' : 'EXCEPTIONS',
      tone: allPass ? 'good' : count('FAIL') ? 'bad' : 'warn',
      note: `${count('PASS')} pass, ${count('FAIL')} fail, ${count('NO_CRITERIA')} without complete PDI criteria, ${count('NOT_TESTED')} not tested. This evaluation does not release material.`,
    },
    meta: [
      ['Reference', e.reference],
      ['Evaluated by', `${e.evaluated_by_name}, ${formatDateTime(iso(e.evaluated_at), tz)}`],
      ['Basis', 'Latest recorded bench test of each injector at the time of evaluation'],
      ['Data source', BENCH_ADAPTER_NOTE],
    ],
    sections: [
      {
        title: 'INJECTORS EVALUATED',
        kind: 'table',
        columns: [
          { header: '#', width: 0.05 },
          { header: 'Serial', width: 0.16 },
          { header: 'Part', width: 0.13 },
          { header: 'Latest test', width: 0.2 },
          { header: 'Result', width: 0.11 },
          { header: 'Basis', width: 0.35 },
        ],
        rows: items.map((i) => [
          String(i.position),
          i.serial_number,
          i.part_number,
          i.tested_at ? `${formatDateTime(iso(i.tested_at), tz)} (${i.machine_id})` : '—',
          words(i.result),
          i.basis,
        ]),
      },
      ...(e.note ? [{ title: 'NOTE', kind: 'text' as const, paragraphs: [e.note] }] : []),
    ],
  };
}
