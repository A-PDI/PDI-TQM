import { BENCH_COLUMNS, csvCell } from '../../src/shared/injectors.js';

/** One synthetic bench test in the interim TQMS-BENCH-CSV-1 layout (fictional machines, serials and values). */
export interface BenchTestFixture {
  machine?: string;
  plan?: string;
  serial: string;
  part?: string;
  testedAt: string;
  seq?: string;
  operator?: string;
  /** [condition, parameter, unit, value, machine result] */
  rows: Array<[string, string, string, string, 'PASS' | 'FAIL' | '']>;
}

export const INJECTOR_PART = 'TQ-INJ-9009';

/** Values inside the synthetic PDI criteria (rated delivery 95–105, idle 8–12, return 10–30 mm3/stroke). */
export const GOOD_ROWS: BenchTestFixture['rows'] = [
  ['Rated', 'Delivery', 'mm3/stroke', '100.4', 'PASS'],
  ['Idle', 'Delivery', 'mm3/stroke', '10.1', 'PASS'],
  ['Rated', 'Return flow', 'mm3/stroke', '18.0', 'PASS'],
];

export function benchCsv(tests: BenchTestFixture[], extraLines: string[] = []): Buffer {
  const lines = [BENCH_COLUMNS.join(',')];
  for (const t of tests) {
    for (const [condition, parameter, unit, value, result] of t.rows) {
      lines.push(
        [t.machine ?? 'BENCH-SYN-01', t.plan ?? 'SYN-PLAN-CR-1', t.serial, t.part ?? INJECTOR_PART, t.testedAt, t.seq ?? '1', t.operator ?? 'Op. Demo', condition, parameter, unit, value, result]
          .map((v) => (/[",\r\n]/.test(v) ? csvCell(v) : v))
          .join(','),
      );
    }
  }
  return Buffer.from([...lines, ...extraLines].join('\r\n') + '\r\n', 'utf8');
}
