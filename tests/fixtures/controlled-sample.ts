import { EVIDENCE_SCHEDULE, ROW_LABEL, type RecordData, type TemplateSchema } from '../../src/shared/controlled-forms.js';

/**
 * A complete fictional record for any controlled form: every field filled within its limit, every
 * schedule filled to one row past what the form holds (so a continuation sheet is needed), a narrative
 * longer than its field, and the approval block signed.
 */
export function sampleRecord(schema: TemplateSchema, contCapacity: (schedule: string) => number, opts: { number: string; date: string }): RecordData {
  const fields: Record<string, string> = {};
  for (const f of schema.fields) {
    const v =
      f.input === 'choice'
        ? f.options![0]!
        : f.input === 'date'
          ? opts.date
          : `${f.key.replace(/_/g, ' ')} (fictional)`.slice(0, f.maxLength ?? 60);
    fields[f.key] = v;
  }
  if (fields.record_id !== undefined) fields.record_id = opts.number;
  for (const k of ['approver1', 'approver2']) if (fields[k] !== undefined) fields[k] = k === 'approver1' ? 'Riley Chen' : 'Taylor Brooks';
  // One multiline field longer than its box continues on the narrative sheet.
  const long = schema.fields.find((f) => f.role === 'ENTRY' && f.input === 'multiline' && (f.maxLength ?? 0) > 100);
  if (long) fields[long.key] = `${'Fictional narrative that runs past the printed box. '.repeat(Math.ceil((long.maxLength! + 120) / 52))}END-OF-NARRATIVE`;
  const schedules: RecordData['schedules'] = {};
  for (const s of schema.schedules) {
    const n = s.key === EVIDENCE_SCHEDULE ? 1 : s.capacity + contCapacity(s.key);
    schedules[s.key] = Array.from({ length: n }, (_, i) => {
      const row: Record<string, string> = {};
      for (const c of s.columns) row[c.key] = c.input === 'choice' ? c.options![0]! : c.input === 'date' ? opts.date : `R${i + 1}`.slice(0, c.maxLength ?? 10);
      if (s.rowLabels && i >= s.rowLabels.length) row[ROW_LABEL] = `Added item ${i + 1}`;
      return row;
    });
  }
  return { fields, schedules };
}
