import { describe, expect, it } from 'vitest';
import { evaluateTest, parseBenchFile } from '../../src/server/injectors/bench.js';
import { criteriaRef, csvCell, normalizeSerial, parseCsv, toCsv } from '../../src/shared/injectors.js';
import { GOOD_ROWS, benchCsv } from '../fixtures/bench.js';

describe('CSV handling (RFC 4180, C10)', () => {
  it('parses quoted fields, doubled quotes, embedded separators and a BOM', () => {
    expect(parseCsv('﻿a,"b,1","say ""hi""","x\r\ny"\r\n\r\n2,,3,\n')).toEqual([
      ['a', 'b,1', 'say "hi"', 'x\r\ny'],
      ['2', '', '3', ''],
    ]);
    expect(() => parseCsv('a,"open')).toThrow(/Unterminated/);
  });

  it('neutralizes formula triggers but keeps plain numbers numeric', () => {
    expect(csvCell('=SUM(A1)')).toBe(`"'=SUM(A1)"`);
    expect(csvCell('+1-2')).toBe(`"'+1-2"`);
    expect(csvCell('@cmd')).toBe(`"'@cmd"`);
    expect(csvCell('-0.25')).toBe('"-0.25"');
    expect(csvCell('+12')).toBe('"+12"');
    expect(csvCell(null)).toBe('');
    expect(toCsv([['a', 'b"c']])).toBe('"a","b""c"\r\n');
  });

  it('normalizes serials and criteria references', () => {
    expect(normalizeSerial(' inj-syn 0001 ')).toBe('INJSYN0001');
    expect(criteriaRef('Rated ', 'Return flow')).toBe('injector:rated__return_flow');
  });
});

describe('bench file parsing and evaluation (POL-08 interim adapter)', () => {
  it('groups rows into tests and excludes a whole test when any of its rows is invalid', () => {
    const parsed = parseBenchFile(
      benchCsv([
        { serial: 'A-1', testedAt: '2026-10-01T08:00:00-05:00', rows: GOOD_ROWS },
        { serial: 'A-2', testedAt: '2026-10-01T08:00:00', rows: GOOD_ROWS },
        { serial: 'A-3', testedAt: '2026-10-01T08:00:00Z', rows: [...GOOD_ROWS, ['Rated', 'Delivery', 'mm3/stroke', '99.0', 'PASS']] },
      ]),
    );
    expect(parsed.tests.map((t) => t.serial)).toEqual(['A-1']);
    expect(parsed.tests[0]!.testedAt).toBe('2026-10-01T13:00:00.000Z');
    expect(parsed.excluded.map((e) => e.reason)).toEqual([expect.stringMatching(/time zone/), expect.stringMatching(/appears twice/)]);
  });

  it('rejects a file that is not the interim layout or not text', () => {
    expect(() => parseBenchFile(Buffer.from('serial,value\r\nX,1\r\n'))).toThrow(/Unrecognized layout/);
    expect(() => parseBenchFile(Buffer.from([0xff, 0xfe, 0x00]))).toThrow(/UTF-8/);
  });

  it('keeps machine and PDI verdicts separate and compares exact decimals within the same unit only', () => {
    const criteria = {
      revisionId: 'rev',
      limits: new Map([
        [criteriaRef('Rated', 'Delivery'), { lower: '95.0', upper: '105.0', unit: 'mm3/stroke' }],
        [criteriaRef('Idle', 'Delivery'), { lower: '8.0', upper: '12.0', unit: 'mm3/stroke' }],
      ]),
    };
    const edge = evaluateTest(
      [
        { condition: 'Rated', parameter: 'Delivery', unit: 'mm3/stroke', value: '105.0', result: 'FAIL' },
        { condition: 'Idle', parameter: 'Delivery', unit: 'mm3/stroke', value: '8.00', result: 'PASS' },
      ],
      criteria,
    );
    expect(edge).toMatchObject({ pdi: 'PASS', machine: 'FAIL', criteriaRevisionId: 'rev' });
    const over = evaluateTest([{ condition: 'Rated', parameter: 'Delivery', unit: 'mm3/stroke', value: '105.01', result: null }], criteria);
    expect(over).toMatchObject({ pdi: 'FAIL', machine: 'NOT_REPORTED' });
    const otherUnit = evaluateTest([{ condition: 'Rated', parameter: 'Delivery', unit: 'mm3/s', value: '200', result: 'PASS' }], criteria);
    expect(otherUnit).toMatchObject({ pdi: 'NO_CRITERIA', criteriaRevisionId: null });
    const none = evaluateTest(GOOD_ROWS.map(([condition, parameter, unit, value]) => ({ condition, parameter, unit, value, result: null })), { revisionId: null, limits: new Map() });
    expect(none.pdi).toBe('NO_CRITERIA');
  });
});
