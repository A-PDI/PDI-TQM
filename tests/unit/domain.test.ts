import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { commitmentEscalation, concessionState, daysBetween, diffCharacteristics, isUsableOutcome, needsReinspection } from '../../src/shared/quality.js';
import { type FormDefinition, formDefinitionSchema, sectionRows } from '../../src/shared/forms.js';
import { type EntryState, evaluateInspection, passAllTargets, readingId, rowId, worstOutcome } from '../../src/shared/inspection.js';
import { type GoverningLimit, compareDecimal, evaluateReading, parseReading } from '../../src/shared/measurement.js';
import { sanitizeFilename, sniffImage, validatePhoto } from '../../src/server/file-validation.js';
import { pdfText } from '../../src/server/pdf/text.js';
import { makeBombPngHeader, makePng } from '../fixtures/images.js';

const catalogue = JSON.parse(readFileSync('seed/forms/appendix-a-v1.0.json', 'utf8')) as {
  entries: Array<{ formNumber: string; revisionLabel: string | null; availability: string; definition: FormDefinition }>;
};
const form = (n: string, rev: string | null = null) => catalogue.entries.find((e) => e.formNumber === n && e.revisionLabel === rev)!.definition;
const empty = (): EntryState => ({ responses: {}, readings: {}, photoCounts: {}, activated: [] });
const limit = (lower: string | null, upper: string | null, unit = 'mm'): GoverningLimit => ({
  charKey: 'k',
  name: 'k',
  unit,
  lower,
  upper,
  baselineRevision: 'S1',
  synthetic: true,
});

describe('measurement decimals', () => {
  it('parses and keeps recorded precision', () => {
    const p = parseReading(' 0.0300 ');
    expect(p.ok && p.value).toMatchObject({ text: '0.0300', canonical: '0.0300', decimals: 4 });
    expect(parseReading('.5').ok && parseReading('.5')).toMatchObject({ value: { canonical: '0.5' } });
    expect(parseReading('-007.25').ok && parseReading('-007.25')).toMatchObject({ value: { canonical: '-7.25' } });
  });
  it('rejects non-numeric, exponent and unit-suffixed input', () => {
    for (const bad of ['1e3', '12mm', 'abc', '', '1.2.3', '0x10']) expect(parseReading(bad).ok).toBe(false);
  });
  it('compares exactly without float rounding', () => {
    expect(compareDecimal('0.1', '0.10')).toBe(0);
    expect(compareDecimal('0.0305', '0.031')).toBe(-1);
    expect(compareDecimal('0.31000000000000001', '0.31')).toBe(1);
    expect(compareDecimal('-1', '0')).toBe(-1);
  });
  it('never rounds a recorded fail into tolerance', () => {
    expect(evaluateReading('0.0311', limit('0.029', '0.031'))).toBe('OUTSIDE');
    expect(evaluateReading('0.0310', limit('0.029', '0.031'))).toBe('WITHIN');
    expect(evaluateReading('0.95', limit('0.10', '0.20'))).toBe('OUTSIDE'); // legacy WT-11 regression
    expect(evaluateReading('5', null)).toBe('NO_LIMIT');
  });
});

describe('outcome derivation', () => {
  it('uses FAIL > ACCEPTED > PASS', () => {
    expect(worstOutcome(['PASS', 'ACCEPTED', 'PASS'])).toBe('ACCEPTED');
    expect(worstOutcome(['ACCEPTED', 'FAIL'])).toBe('FAIL');
    expect(worstOutcome([null, undefined])).toBeNull();
  });
});

describe('owner-supplied forms', () => {
  const owner = JSON.parse(readFileSync('seed/forms/owner-additions-2026-10.json', 'utf8')) as typeof catalogue;
  it('adds Head Bolt (PDI-IQI-030) and Bellows Kit (PDI-IQI-031) as schema-valid active forms', () => {
    expect(owner.entries.map((e) => `${e.formNumber} ${e.availability}`)).toEqual(['PDI-IQI-030 ACTIVE', 'PDI-IQI-031 ACTIVE']);
    for (const e of owner.entries) {
      expect(() => formDefinitionSchema.parse(e.definition)).not.toThrow();
      expect(e.definition.sections[0]).toMatchObject({ key: 'A', scope: 'inspection', pattern: 'pfn_checklist' });
    }
  });
  it('records Head Bolt dimensions in mm without inventing limits', () => {
    const dims = owner.entries[0]!.definition.sections.find((s) => s.pattern === 'dimensional')!;
    expect(dims.rows.map((r) => r.name)).toEqual(['Body Diameter', 'Flange Head Diameter', 'Head Size', 'Shoulder Length', 'Thread Length']);
    for (const r of dims.rows) expect(r).toMatchObject({ unit: 'mm', limitNote: 'Not supplied; resolve to authorized product specification' });
  });
  it('does not reuse an Appendix A form number', () => {
    const existing = new Set(catalogue.entries.map((e) => e.formNumber));
    for (const e of owner.entries) expect(existing.has(e.formNumber)).toBe(false);
  });
});

describe('Appendix A catalogue', () => {
  it('contains 31 definitions with 28 active forms, all schema-valid', () => {
    expect(catalogue.entries).toHaveLength(31);
    expect(catalogue.entries.filter((e) => e.availability === 'ACTIVE')).toHaveLength(28);
    for (const e of catalogue.entries) expect(() => formDefinitionSchema.parse(e.definition)).not.toThrow();
  });
  it('keeps the shared receiving section once per inspection on active forms', () => {
    for (const e of catalogue.entries.filter((x) => x.availability === 'ACTIVE')) {
      const a = e.definition.sections[0]!;
      expect(a.scope).toBe('inspection');
      expect(a.rows.map((r) => r.name)).toContain('Outer Carton Condition');
    }
  });
  it('models the cylinder head Rev B specialized sections', () => {
    const def = form('PDI-IQI-005', 'B');
    const keys = def.sections.map((s) => `${s.key}:${s.pattern}:${s.optional}`);
    expect(keys).toEqual([
      'A:pfn_checklist:false',
      'B:pfn_checklist:false',
      'C_general:general_measurements:true',
      'C_fire_ring:groove_specs:true',
      'C_valve_recession:valve_recession:true',
      'C_vacuum_test:vacuum_test:true',
    ]);
    const vr = sectionRows(def.sections[4]!);
    expect(vr).toHaveLength(6);
    expect(vr[0]!.readingKeys).toEqual(['int1', 'int2', 'exh1', 'exh2']);
    const vac = sectionRows(def.sections[5]!);
    expect(vac.filter((r) => !r.parentKey)).toHaveLength(6);
    expect(vac.filter((r) => r.parentKey === 'c3')).toHaveLength(4);
  });
  it('does not invent numeric limits for "Not supplied" dimensions', () => {
    const piston = form('PDI-IQI-001');
    const c = piston.sections.find((s) => s.key === 'C')!;
    expect(c.rows.every((r) => r.limitNote?.startsWith('Not supplied'))).toBe(true);
  });
});

describe('completion rules', () => {
  const ring = form('PDI-IQI-004');
  const ctx = (limits: Record<string, GoverningLimit> = {}) => ({ definition: ring, unitCount: 2, limits });
  const answerAll = (state: EntryState, status: 'P' | 'N' = 'P') => {
    for (const s of ring.sections) {
      for (const u of s.scope === 'inspection' ? [0] : [1, 2]) {
        for (const r of sectionRows(s)) {
          state.responses[rowId(u, s.key, r.key)] = { status, note: null };
          for (const rk of r.readingKeys.slice(0, 1)) state.readings[readingId(u, s.key, r.key, rk)] = '10.00';
        }
      }
    }
  };

  it('blank is not N/A; every required row is listed with an exact path (NEG-24)', () => {
    const state = empty();
    answerAll(state);
    state.responses[rowId(0, 'A', 'part_marking')] = { status: 'N', note: null };
    delete state.responses[rowId(0, 'A', 'quantity_verification')];
    const ev = evaluateInspection(ctx(), state);
    expect(ev.errors.map((e) => `${e.path}: ${e.message}`)).toEqual(['Receiving → Receiving & Documentation → Quantity Verification: result is required (blank is not N/A)']);
  });

  it('Fail requires an observation and a row photograph (AT-01)', () => {
    const state = empty();
    answerAll(state);
    state.responses[rowId(2, 'B', 'running_face_coating')] = { status: 'F', note: null };
    let ev = evaluateInspection(ctx(), state);
    expect(ev.errors.map((e) => `${e.path}: ${e.message}`)).toEqual([
      'Item 2 → Visual → Running Face Coating: observation note is required',
      'Item 2 → Visual → Running Face Coating: photograph of this characteristic is required',
    ]);
    state.responses[rowId(2, 'B', 'running_face_coating')]!.note = 'Coating flaking at gap';
    state.photoCounts[rowId(2, 'B', 'running_face_coating')] = 1;
    ev = evaluateInspection(ctx(), state);
    expect(ev.errors).toEqual([]);
    expect(ev.overall).toBe('FAIL');
    expect(ev.unitOutcomes).toEqual({ 1: 'PASS', 2: 'FAIL' });
    expect(ev.reviewReasons[0]!.message).toMatch(/independent review/);
  });

  it('without a released limit, readings are observations needing Engineering review (NEG-16)', () => {
    const state = empty();
    answerAll(state);
    const ev = evaluateInspection(ctx(), state);
    expect(ev.errors).toEqual([]);
    expect(ev.overall).toBe('PASS');
    expect(ev.reviewReasons.some((r) => r.message.includes('Specification not released'))).toBe(true);
  });

  it('a reading outside a released limit cannot be recorded as Pass', () => {
    const state = empty();
    answerAll(state);
    const limits = {
      'dimensional:free_end_gap_relaxed': limit('9.80', '10.40'),
      'dimensional:installed_end_gap': limit('9', '11'),
      'dimensional:axial_width_ring_height': limit('9', '11'),
      'dimensional:radial_wall_thickness': limit('9', '11'),
    };
    state.readings[readingId(1, 'C', 'free_end_gap_relaxed', 'a2')] = '10.41';
    const ev = evaluateInspection(ctx(limits), state);
    expect(ev.errors.map((e) => e.message)).toEqual(['reading outside the released limit — result cannot be Pass']);
    expect(ev.rows[rowId(1, 'C', 'free_end_gap_relaxed')]!.measurement).toBe('OUTSIDE');
    state.readings[readingId(1, 'C', 'free_end_gap_relaxed', 'a2')] = '10.40';
    const ok = evaluateInspection(ctx(limits), state);
    expect(ok.errors).toEqual([]);
    expect(ok.reviewReasons).toEqual([]);
  });

  it('N/A outside the receiving checklist needs a reason', () => {
    const state = empty();
    answerAll(state);
    state.responses[rowId(1, 'B', 'orientation_mark')] = { status: 'N', note: null };
    expect(evaluateInspection(ctx(), state).errors[0]!.message).toBe('reason for N/A is required');
  });

  it('Pass All never targets measurements and reports answers it would overwrite (NEG-23)', () => {
    const state = empty();
    state.responses[rowId(1, 'B', 'ring_body')] = { status: 'F', note: 'kinked' };
    const t = passAllTargets(ring.sections[1]!, 1, state);
    expect(t.fill).toEqual(['running_face_coating', 'gap_end_faces', 'orientation_mark']);
    expect(t.overwrite).toEqual([{ rowKey: 'ring_body', status: 'F' }]);
  });

  it('vacuum valve sub-results are required only for a failed cylinder; valve recession uses separate limits', () => {
    const head = form('PDI-IQI-005', 'B');
    const state = empty();
    state.activated = ['1|C_vacuum_test', '1|C_valve_recession'];
    for (const s of head.sections) {
      for (const u of s.scope === 'inspection' ? [0] : [1]) {
        if (s.optional && !state.activated.includes(`${u}|${s.key}`)) continue;
        for (const r of sectionRows(s)) {
          if (r.parentKey) continue;
          state.responses[rowId(u, s.key, r.key)] = { status: 'P', note: null };
          for (const rk of r.readingKeys) state.readings[readingId(u, s.key, r.key, rk)] = rk.startsWith('int') ? '0.040' : '0.045';
        }
      }
    }
    const limits = { 'valve_recession:intake': limit('0.030', '0.050', 'in'), 'valve_recession:exhaust': limit('0.030', '0.044', 'in') };
    let ev = evaluateInspection({ definition: head, unitCount: 1, limits }, state);
    // Exhaust 0.045 exceeds the exhaust limit only.
    expect(ev.errors.filter((e) => e.sectionKey === 'C_valve_recession')).toHaveLength(6);
    state.responses[rowId(1, 'C_vacuum_test', 'c3')] = { status: 'F', note: 'leak' };
    ev = evaluateInspection({ definition: head, unitCount: 1, limits }, state);
    expect(ev.errors.filter((e) => e.sectionKey === 'C_vacuum_test').map((e) => e.rowKey)).toEqual(['c3_int1', 'c3_int2', 'c3_exh1', 'c3_exh2']);
  });
});

describe('file validation', () => {
  it('identifies images by signature and rejects disguised HTML (NEG-10)', () => {
    expect(sniffImage(makePng())).toBe('image/png');
    expect(validatePhoto(Buffer.from('<html><script>alert(1)</script></html>'), 40)).toEqual({ ok: false, reason: 'File is not a JPEG, PNG or WebP photograph' });
    expect(validatePhoto(Buffer.from('%PDF-1.7 fake'), 12).ok).toBe(false);
  });
  it('rejects decompression-bomb dimensions', () => {
    const r = validatePhoto(makeBombPngHeader(), 100);
    expect(r.ok).toBe(false);
  });
  it('accepts a valid fabricated PNG and sanitizes traversal names', () => {
    expect(validatePhoto(makePng(80, 60), 500)).toEqual({ ok: true, mime: 'image/png', width: 80, height: 60 });
    expect(sanitizeFilename('../../etc/passwd.png')).toBe('passwd.png');
    expect(sanitizeFilename('..\\..\\win.ini')).toBe('win.ini');
  });
});

describe('PDF text safety', () => {
  it('maps characters the standard fonts cannot draw', () => {
    expect(pdfText('≤ 0.05″ → ok — 25°')).toBe('<= 0.05" -> ok — 25°');
    expect(pdfText('漢')).toBe('?');
  });
});

describe('canonical JSON', () => {
  it('is key-order independent and keeps dates', async () => {
    const { canonicalJson } = await import('../../src/shared/forms.js');
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }));
    expect(canonicalJson({ at: new Date('2026-10-21T00:00:00Z') })).toBe('{"at":"2026-10-21T00:00:00.000Z"}');
  });
});

describe('Stage 3 rules', () => {
  const c = { status: 'APPROVED', valid_from: '2026-10-01', valid_until: '2026-10-31', quantity_limit: 5 };
  it('a concession authorizes only inside its dates and quantity (AT-14)', () => {
    expect(concessionState(c, 0, '2026-10-15')).toBe('CURRENT');
    expect(concessionState(c, 4, '2026-10-31')).toBe('CURRENT');
    expect(concessionState(c, 5, '2026-10-15')).toBe('EXHAUSTED');
    expect(concessionState(c, 0, '2026-11-01')).toBe('EXPIRED');
    expect(concessionState(c, 0, '2026-09-30')).toBe('NOT_YET_VALID');
    expect(concessionState({ ...c, status: 'REQUESTED' }, 0, '2026-10-15')).toBe('REQUESTED');
  });

  it('reminders and escalation are proportional to severity (FR-013)', () => {
    expect(commitmentEscalation('HIGH', 0)).toEqual({ remind: false, escalate: false });
    expect(commitmentEscalation('HIGH', 1)).toEqual({ remind: true, escalate: true });
    expect(commitmentEscalation('MEDIUM', 6)).toEqual({ remind: true, escalate: false });
    expect(commitmentEscalation('MEDIUM', 7)).toEqual({ remind: true, escalate: true });
    expect(commitmentEscalation('LOW', 30)).toEqual({ remind: true, escalate: false });
    expect(daysBetween('2026-10-19', '2026-10-21')).toBe(2);
  });

  it('dispositions: only rework/repair need reinspection; returned or scrapped material is never released', () => {
    expect(needsReinspection('REWORK') && needsReinspection('REPAIR')).toBe(true);
    expect(needsReinspection('USE_AS_IS')).toBe(false);
    expect(['RETURN_TO_SUPPLIER', 'SCRAP'].map(isUsableOutcome)).toEqual([false, false]);
    expect(['REWORK', 'REPAIR', 'USE_AS_IS'].map(isUsableOutcome)).toEqual([true, true, true]);
  });

  it('baseline comparison lists changed, added and removed characteristics (FR-083)', () => {
    const before = [
      { charKey: 'a', name: 'Bore', lower: '10.00', upper: '10.02', unit: 'mm' },
      { charKey: 'b', name: 'Finish', limitText: 'Ra 0.8' },
    ];
    const after = [
      { charKey: 'a', name: 'Bore', lower: '10.00', upper: '10.01', unit: 'mm' },
      { charKey: 'c', name: 'Coating', limitText: 'PVD present' },
    ];
    expect(diffCharacteristics(before, after).map((r) => [r.charKey, r.change, r.fields])).toEqual([
      ['a', 'CHANGED', ['upper']],
      ['c', 'ADDED', []],
      ['b', 'REMOVED', []],
    ]);
  });
});
