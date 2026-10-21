import type { Queryable } from './db.js';

/** Issues the next human-friendly record number, e.g. IR-2026-00001, under row lock. */
export async function nextRecordNumber(db: Queryable, prefix: string, at: Date = new Date()): Promise<string> {
  const year = at.getUTCFullYear();
  const res = await db.query<{ value: number }>(
    `INSERT INTO record_sequence (prefix, year, next_value) VALUES ($1, $2, 2)
     ON CONFLICT (prefix, year) DO UPDATE SET next_value = record_sequence.next_value + 1
     RETURNING next_value - 1 AS value`,
    [prefix, year],
  );
  const value = res.rows[0]!.value;
  return `${prefix}-${year}-${String(value).padStart(5, '0')}`;
}
