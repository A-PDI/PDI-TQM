import { dayIn } from '../../shared/quality.js';
import { type Queryable, many } from '../db.js';

/**
 * Related quality and change records for a source, supplier or part, so a contextual page
 * shows open issues without visiting separate registers (FR-016, FR-076).
 */
export async function qualityContext(db: Queryable, subject: { sourceId?: string; supplierId?: string; partId?: string }, timeZone: string) {
  const col = subject.sourceId ? 'source_id' : subject.supplierId ? 'supplier_id' : 'part_id';
  const id = subject.sourceId ?? subject.supplierId ?? subject.partId;
  const today = dayIn(timeZone);
  const [ncrs, scars, concessions, changes, commitments] = await Promise.all([
    many(
      db,
      `SELECT id, number, title, status, severity, lot_number AS "lotNumber" FROM ncr WHERE ${col} = $1 ORDER BY confirmed_at DESC LIMIT 25`,
      [id],
    ),
    col === 'part_id'
      ? many(db, `SELECT id, number, title, status, cycle FROM scar WHERE part_id = $1 ORDER BY issued_at DESC LIMIT 25`, [id])
      : many(db, `SELECT id, number, title, status, cycle FROM scar WHERE ${col} = $1 ORDER BY issued_at DESC LIMIT 25`, [id]),
    col === 'supplier_id'
      ? many(
          db,
          `SELECT c.id, c.number, c.status, c.lot_number AS "lotNumber", c.valid_until::text AS "validUntil", c.characteristic,
                  (c.status = 'APPROVED' AND c.valid_from <= $2::date AND c.valid_until >= $2::date) AS current
             FROM concession c JOIN source s ON s.id = c.source_id WHERE s.supplier_id = $1 ORDER BY c.requested_at DESC LIMIT 25`,
          [id, today],
        )
      : many(
          db,
          `SELECT c.id, c.number, c.status, c.lot_number AS "lotNumber", c.valid_until::text AS "validUntil", c.characteristic,
                  (c.status = 'APPROVED' AND c.valid_from <= $2::date AND c.valid_until >= $2::date) AS current
             FROM concession c WHERE c.${col} = $1 ORDER BY c.requested_at DESC LIMIT 25`,
          [id, today],
        ),
    col === 'source_id'
      ? many(
          db,
          `SELECT c.id, c.number, c.title, c.status, c.requalification_required AS "requalificationRequired" FROM change_source cs JOIN change_request c ON c.id = cs.change_id
            WHERE cs.source_id = $1 ORDER BY c.requested_at DESC LIMIT 25`,
          [id],
        )
      : many(
          db,
          `SELECT id, number, title, status, requalification_required AS "requalificationRequired" FROM change_request WHERE ${col} = $1 ORDER BY requested_at DESC LIMIT 25`,
          [id],
        ),
    many(
      db,
      `SELECT id, number, promised_action AS "promisedAction", status, due_date::text AS "dueDate", representative,
              (status IN ('OPEN', 'SUPPLIER_CLAIMS_DONE') AND due_date < $2::date) AS overdue
         FROM supplier_commitment WHERE ${col} = $1 ORDER BY recorded_at DESC LIMIT 25`,
      [id, today],
    ),
  ]);
  return { ncrs, scars, concessions, changes, commitments };
}
