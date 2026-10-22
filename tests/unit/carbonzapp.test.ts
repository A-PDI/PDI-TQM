import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type CzReport,
  averageOfRawResults,
  exclusionReasons,
  formatErrorDescription,
  formatErrorValue,
  injectorOutcome,
  normaliseStepCode,
  normaliseSteps,
  readReport,
  reportsFromPayload,
  sanitiseReport,
  specText,
  splitStepName,
  stepDisplayName,
} from '../../src/shared/carbonzapp.js';

// Structure and measurements of the owner's two-injector bench payload; identities are fictional.
const sample = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../fixtures/carbonzapp-sample.json'), 'utf8')) as CzReport[];
const clone = (r: CzReport): CzReport => JSON.parse(JSON.stringify(r));

describe('step codes, names and bench error text', () => {
  it('normalises step codes', () => {
    expect(['iVM.01', 'IVM01', 'IVM 01', 'ivm1'].map(normaliseStepCode)).toEqual(['IVM01', 'IVM01', 'IVM01', 'IVM01']);
    expect(['eRL', 'Warm Up', 'FL(W)', 'LKT.01', 'iVM.06 : HP ERROR'].map(normaliseStepCode)).toEqual(['ERL', 'WARMUP', 'FLW', 'LKT01', 'IVM06']);
  });
  it('names steps as the owner reports print them', () => {
    expect(stepDisplayName('iVM.06', 'primary', '[D]')).toBe('Peak Torque - Delivery');
    expect(stepDisplayName('iVM.06', 'secondary', '[R]')).toBe('Peak Torque - Return');
    expect(stepDisplayName('iVM.01', 'secondary', '[R]')).toBe('Peak HP [R]');
    expect(stepDisplayName('LKT.01', 'primary', '[R]')).toBe('Leak Test 200 bar [R]');
    expect(stepDisplayName('eRL', 'secondary', null)).toBe('Inductance');
    expect(stepDisplayName('XYZ.9', 'primary', '[D]')).toBe('XYZ09');
  });
  it('reads bench notes without renaming the step', () => {
    expect(splitStepName('eRL : SKIPPED')).toMatchObject({ base: 'eRL', skipped: true, errored: false });
    expect(splitStepName('iVM.06 : HP ERROR (out of range) #1000')).toMatchObject({ base: 'iVM.06', errored: true });
    expect(splitStepName('Custom : note')).toMatchObject({ base: 'Custom : note', errored: false });
    expect(formatErrorDescription('HP ERROR (out of range) #1000')).toBe('Out of Range');
    expect(formatErrorDescription('ERROR: Communication Failure')).toBe('Communication Failure');
    expect(formatErrorDescription('HP ERROR #12')).toBe('HP Error');
    expect(formatErrorDescription('EXCESS RETURN')).toBe('Excess Return');
    expect(formatErrorDescription('')).toBe('Test Error');
    expect(formatErrorValue('Out of Range')).toBe('Error: Out of Range');
    expect(formatErrorValue('Excess Return')).toBe('Excess Return');
    expect(averageOfRawResults('273.2~273.1~273.0')).toBe('273.1');
    expect(averageOfRawResults('—')).toBe('');
  });
});

describe('reference output of the owner sample (§23)', () => {
  it('reads both injectors of one bench run as PASS with 10 of 10 points', () => {
    const a = readReport(sample[0]!);
    const b = readReport(sample[1]!);
    if (!a.ok || !b.ok) throw new Error('sample reports must be readable');
    expect(a.report).toMatchObject({ reportId: 'f1c7105e00000000000000a1', slot: 0, serial: 'TQ-SN-0455', outcome: 'PASS', stepsTotal: 10, stepsPassed: 10, stepsFailed: 0 });
    expect(b.report).toMatchObject({ slot: 2, serial: 'TQ-SN-0447', outcome: 'PASS', stepsTotal: 10, stepsPassed: 10 });
    expect(a.report.testedAt).toBe('2026-06-30T13:40:56.000Z');
    expect(a.report.brand).toBe('Cummins');
    expect(a.report.injectorType).toBe('XPI-CRIN');
  });

  it('produces the custom-report rows: names, green band and readings', () => {
    const r = readReport(sample[0]!);
    if (!r.ok) throw new Error(r.reason);
    const rows = r.report.results.map((x) => [x.condition, specText(x), x.value, x.bench.outcome]);
    expect(rows).toEqual([
      ['Leak Test 200 bar [R]', '0.0 – 20.0 ml/min', '0.0', 'PASS'],
      ['Leak Test 1800 bar [R]', '0.0 – 20.0 ml/min', '0.0', 'PASS'],
      ['Warm Up', '0.0 – 500.0 mm3/STRK', '254.6', 'PASS'],
      ['Peak HP', '220.9 – 249.1 mm3/STRK', '230.3', 'PASS'],
      ['Peak HP [R]', '0.0 – 80.0 mm3/STRK', '25.4', 'PASS'],
      ['Emissions', '24.6 – 34.6 mm3/STRK', '28.7', 'PASS'],
      // Outside the bench's blue target (result_pass 2) but inside the green acceptance band.
      ['Low Idle', '4.0 – 13.0 mm3/STRK', '12.6', 'PASS'],
      ['Mid-Range', '66.3 – 82.3 mm3/STRK', '72.0', 'PASS'],
      ['Cranking', '29.2 – 41.2 mm3/STRK', '36.2', 'PASS'],
      ['Peak Torque - Delivery', '0.0 – 500.0 mm3/STRK', '273.1', 'PASS'],
      ['Peak Torque - Return', '0.0 – 80.0 mm3/STRK', '28.4', 'PASS'],
      ['Response Time', '290.0 – 690.0 usec', '465', 'PASS'],
    ]);
    expect(r.report.results[3]).toMatchObject({ parameter: 'Delivery', unit: 'mm3/STRK', verdict: 'PASS', bench: { spec: '235.0 +/- 14.1 mm3/STRK', lower: '220.9', upper: '249.1' } });
    expect(r.report.results[4]!.parameter).toBe('Return');
    expect(r.report.results[11]!.parameter).toBe('Response time');
    // Skipped steps and the internal flush are never result rows.
    expect(r.report.results.some((x) => /Resistance|Flush|Opening/.test(x.condition))).toBe(false);
  });
});

describe('classification against the green band', () => {
  const setTest = (r: CzReport, name: string, patch: (t: NonNullable<CzReport['AllTests']>[number]) => void) => {
    const t = r.AllTests!.find((x) => x.TestInfo?.test_name === name)!;
    patch(t);
    return r;
  };

  it('fails an injector whose reading is outside the green band', () => {
    const r = setTest(clone(sample[0]!), 'iVM.03', (t) => {
      t.PrimaryTank!.AvrResult = '13.4';
    });
    const out = readReport(r);
    if (!out.ok) throw new Error(out.reason);
    expect(out.report.outcome).toBe('FAIL');
    expect(out.report.stepsFailed).toBe(1);
    expect(out.report.results.find((x) => x.condition === 'Low Idle')).toMatchObject({ verdict: 'FAIL', bench: { outcome: 'FAIL' } });
  });

  it('marks an interrupted run DNF, but FAIL when a real failure came first', () => {
    const dnf = setTest(clone(sample[0]!), 'iVM.06', (t) => {
      t.TestInfo!.test_name = 'iVM.06 : HP ERROR (out of range) #1000';
      t.PrimaryTank!.AvrResult = '0.0';
      t.SecondaryTank = null;
    });
    const a = readReport(dnf);
    if (!a.ok) throw new Error(a.reason);
    expect(a.report.outcome).toBe('DNF');
    expect(a.report.results.find((x) => x.condition === 'Peak Torque - Delivery')).toMatchObject({ value: '0.0', verdict: null, bench: { outcome: 'DNF', note: 'Out of Range' } });

    const fail = setTest(clone(dnf), 'iVM.02', (t) => {
      t.PrimaryTank!.AvrResult = '40.0';
    });
    expect(injectorOutcome(normaliseSteps(fail))).toBe('FAIL');
  });

  it('shows the error value for an errored step without a measurement', () => {
    const r = setTest(clone(sample[0]!), 'RSP', (t) => {
      t.TestInfo!.test_name = 'RSP : EXCESS RETURN';
      t.PrimaryTank = null;
    });
    const out = readReport(r);
    if (!out.ok) throw new Error(out.reason);
    expect(out.report.outcome).toBe('DNF');
    expect(out.report.results.at(-1)).toMatchObject({ condition: 'Response Time', parameter: 'Result', value: 'Excess Return', bench: { outcome: 'DNF' } });
  });

  it('is UNKNOWN when nothing was scored', () => {
    const r = clone(sample[0]!);
    for (const t of r.AllTests!) t.TestInfo!.status = 1;
    const out = readReport(r);
    if (!out.ok) throw new Error(out.reason);
    expect(out.report).toMatchObject({ outcome: 'UNKNOWN', stepsTotal: 0, results: [] });
  });
});

describe('import rules', () => {
  it('excludes repair re-run serials and RMA jobs', () => {
    expect(exclusionReasons(sample[0]!)).toEqual([]);
    expect(exclusionReasons({ ...clone(sample[0]!), SlotsData: { position: 0, sn: ' r26098' } })).toEqual(['serial_starts_with_r']);
    expect(exclusionReasons({ ...clone(sample[0]!), job: 'rma-1182' })).toEqual(['job_contains_rma']);
    expect(exclusionReasons({ ...clone(sample[0]!), job: null, drs_id: 'RMA77' })).toEqual(['job_contains_rma']);
  });
  it('never keeps job or customer fields', () => {
    const s = sanitiseReport({ ...clone(sample[0]!), job: 'J-1', customer_name: 'Someone' });
    expect(Object.keys(s)).not.toContain('job');
    expect(Object.keys(s).filter((k) => k.startsWith('customer'))).toEqual([]);
    expect(s.actuator_code).toBe('OEINJ559009PX');
  });
  it('refuses reports without identity', () => {
    expect(readReport({ ...clone(sample[0]!), _id: null })).toEqual({ ok: false, reason: 'Report has no _id' });
    expect(readReport({ ...clone(sample[0]!), SlotsData: { position: 0, sn: '-' } })).toMatchObject({ ok: false });
    expect(readReport({ ...clone(sample[0]!), datetime: 'yesterday', created_at: null })).toMatchObject({ ok: false });
  });
  it('accepts the documented payload shapes', () => {
    expect(reportsFromPayload(sample)).toHaveLength(2);
    expect(reportsFromPayload({ data: sample })).toHaveLength(2);
    expect(reportsFromPayload({ results: [] })).toEqual([]);
    expect(reportsFromPayload(sample[0])).toHaveLength(1);
    expect(reportsFromPayload({ message: 'nope' })).toBeNull();
    expect(reportsFromPayload('x')).toBeNull();
  });
});
