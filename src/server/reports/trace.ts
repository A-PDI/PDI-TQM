import { z } from 'zod';
import { normalizeSerial } from '../../shared/injectors.js';
import { dayIn } from '../../shared/quality.js';
import { type Queryable, many, one } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { isoDate, uuid } from '../quality/common.js';
import { effectiveSourceStatuses } from '../sourcing/status.js';

export const traceQuery = z.object({
  partId: uuid.optional(),
  lot: z.string().trim().max(60).optional(),
  serial: z.string().trim().max(60).optional(),
  date: isoDate.optional(),
});

/** SQL expression normalizing a serial column the same way as normalizeSerial(). */
const norm = (col: string) => `upper(regexp_replace(coalesce(${col}, ''), '[^A-Za-z0-9]', '', 'g'))`;

/**
 * Traceability for part + lot or a serial (AT-20, FR-010): the requirements and source approval
 * that applied on a date, the inspections, FAI history, quality and change records, and bench
 * test/repair history. Only read access is needed; nothing here changes a record.
 */
export async function trace(db: Queryable, raw: unknown, timeZone: string) {
  const q = traceQuery.parse(raw);
  const lot = q.lot || null;
  const serial = q.serial ? normalizeSerial(q.serial) : null;
  if (!serial && !(q.partId && lot)) throw badRequest('Enter a serial number, or a part and a lot number');
  if (q.serial && !serial) throw badRequest('The serial number has no letters or digits');
  const date = q.date ?? dayIn(timeZone);
  // Instant at the end of the requested date in the display time zone.
  const endOfDay = (await one<{ t: Date }>(db, `SELECT (($1::date + 1)::timestamp AT TIME ZONE $2) AS t`, [date, timeZone]))!.t;

  if (q.partId && !(await one(db, 'SELECT 1 FROM company_part WHERE id = $1', [q.partId]))) throw notFound('Part');

  const inspections = await many<{
    id: string;
    number: string;
    status: string;
    outcome: string | null;
    part_id: string | null;
    part_number: string;
    source_id: string | null;
    supplier: string | null;
    site: string | null;
    lot_number: string | null;
    po_number: string | null;
    date_received: string;
    completed_at: Date | null;
    form_number: string;
    form_revision: string | null;
    baseline_label: string | null;
    baseline_revision_id: string | null;
    source_state_at_start: string;
    units: string[];
    photos: number;
    flagged_rows: number;
  }>(
    db,
    `SELECT i.id, i.number, i.status, coalesce((SELECT a.resulting_outcome FROM inspection_amendment a WHERE a.inspection_id = i.id ORDER BY a.amendment_no DESC LIMIT 1), i.outcome) AS outcome,
            i.part_id, i.part_number, i.source_id, s.legal_name AS supplier, ss.name AS site, i.lot_number, i.po_number, i.date_received::text, i.completed_at,
            i.form_snapshot->>'formNumber' AS form_number, fr.revision_label AS form_revision,
            (SELECT b.title || ' Rev ' || r.revision_label FROM baseline_revision r JOIN technical_baseline b ON b.id = r.baseline_id WHERE r.id = i.baseline_revision_id) AS baseline_label,
            i.baseline_revision_id, i.source_state_at_start,
            coalesce((SELECT array_agg(u.serial_number ORDER BY u.unit_index) FROM inspection_unit u WHERE u.inspection_id = i.id AND u.serial_number IS NOT NULL), '{}') AS units,
            (SELECT count(*)::int FROM evidence_link l WHERE l.inspection_id = i.id AND l.unlinked_at IS NULL) AS photos,
            (SELECT count(*)::int FROM (SELECT DISTINCT ON (r.unit_index, r.section_key, r.row_key) r.status FROM inspection_response r WHERE r.inspection_id = i.id
                ORDER BY r.unit_index, r.section_key, r.row_key, r.amendment_no DESC) x WHERE x.status IN ('F', 'A')) AS flagged_rows
       FROM inspection i JOIN form_revision fr ON fr.id = i.form_revision_id LEFT JOIN supplier s ON s.id = i.supplier_id LEFT JOIN supplier_site ss ON ss.id = i.site_id
      WHERE i.status <> 'VOID'
        AND ($1::uuid IS NULL OR i.part_id = $1)
        AND ($2::text IS NULL OR lower(i.lot_number) = lower($2))
        AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM inspection_unit u WHERE u.inspection_id = i.id AND ${norm('u.serial_number')} = $3))
      ORDER BY i.date_received, i.created_at`,
    [q.partId ?? null, lot, serial],
  );

  const injectors = serial
    ? await many<{ id: string; serial_number: string; part_id: string; part_number: string; tests: number; repairs: number; latest: Record<string, unknown> | null }>(
        db,
        `SELECT j.id, j.serial_number, j.part_id, p.part_number,
                (SELECT count(*)::int FROM injector_test t WHERE t.injector_id = j.id) AS tests,
                (SELECT count(*)::int FROM repair_case c WHERE c.injector_id = j.id) AS repairs,
                (SELECT row_to_json(x) FROM (SELECT t.tested_at AS "testedAt", t.machine_verdict AS "machineVerdict", t.pdi_evaluation AS "pdiEvaluation"
                    FROM injector_test t WHERE t.injector_id = j.id ORDER BY t.tested_at DESC, t.recorded_at DESC LIMIT 1) x) AS latest
           FROM injector j JOIN company_part p ON p.id = j.part_id WHERE j.normalized_serial = $1 AND ($2::uuid IS NULL OR j.part_id = $2)`,
        [serial, q.partId ?? null],
      )
    : [];

  const partIds = [...new Set([q.partId, ...inspections.map((i) => i.part_id), ...injectors.map((j) => j.part_id)].filter((x): x is string => Boolean(x)))];
  const parts = await many<{ id: string; part_number: string; description: string }>(db, 'SELECT id, part_number, description FROM company_part WHERE id = ANY($1::uuid[]) ORDER BY part_number', [partIds]);

  // Sources: those the inspections were received against; otherwise every source of the part(s).
  const inspectedSources = [...new Set(inspections.map((i) => i.source_id).filter((x): x is string => Boolean(x)))];
  const sourceRows = await many<{ id: string; part_id: string; part_number: string; supplier_id: string; supplier: string; site_id: string; site: string; configuration: string }>(
    db,
    `SELECT src.id, src.part_id, p.part_number, src.supplier_id, s.legal_name AS supplier, src.site_id, ss.name AS site, src.configuration
       FROM source src JOIN company_part p ON p.id = src.part_id JOIN supplier s ON s.id = src.supplier_id JOIN supplier_site ss ON ss.id = src.site_id
      WHERE ${inspectedSources.length ? 'src.id = ANY($1::uuid[])' : 'src.part_id = ANY($1::uuid[])'} ORDER BY p.part_number, s.legal_name`,
    [inspectedSources.length ? inspectedSources : partIds],
  );
  const sourceIds = sourceRows.map((s) => s.id);
  const current = await effectiveSourceStatuses(db, sourceIds);
  const approvalsAt = await many<{ source_id: string; id: string; number: string; decision: string; valid_until: string | null; conditions: string | null; decided_at: Date; approver: string }>(
    db,
    `SELECT DISTINCT ON (d.source_id) d.source_id, d.id, d.number, d.decision, d.valid_until::text, d.conditions, d.decided_at, u.display_name AS approver
       FROM source_approval_decision d JOIN app_user u ON u.id = d.approver_id
      WHERE d.source_id = ANY($1::uuid[]) AND d.decided_at < $2 ORDER BY d.source_id, d.decided_at DESC`,
    [sourceIds, endOfDay],
  );
  const restrictionsAt = await many<{ supplier_id: string; site_id: string | null; source_id: string | null; kind: string; reason: string; decided_at: Date; lifted_at: Date | null }>(
    db,
    `SELECT supplier_id, site_id, source_id, kind, reason, decided_at, lifted_at FROM supplier_restriction
      WHERE supplier_id = ANY($1::uuid[]) AND decided_at < $2 AND (lifted_at IS NULL OR lifted_at >= $2)`,
    [[...new Set(sourceRows.map((s) => s.supplier_id))], endOfDay],
  );
  const qualificationsAt = await many<{ site_id: string; number: string; decision: string; valid_until: string | null }>(
    db,
    `SELECT DISTINCT ON (site_id) site_id, number, decision, valid_until::text FROM supplier_qualification
      WHERE status = 'DECIDED' AND site_id = ANY($1::uuid[]) AND decided_at < $2 ORDER BY site_id, decided_at DESC`,
    [[...new Set(sourceRows.map((s) => s.site_id))], endOfDay],
  );
  const sources = sourceRows.map((s) => {
    const a = approvalsAt.find((x) => x.source_id === s.id) ?? null;
    const restrictions = restrictionsAt.filter((r) => r.supplier_id === s.supplier_id && (r.source_id ? r.source_id === s.id : r.site_id === null || r.site_id === s.site_id));
    const qual = qualificationsAt.find((x) => x.site_id === s.site_id) ?? null;
    const approvedAtDate = Boolean(a && a.decision !== 'REJECTED' && (!a.valid_until || a.valid_until >= date));
    const qualifiedAtDate = Boolean(qual && qual.decision !== 'REJECTED' && (!qual.valid_until || qual.valid_until >= date));
    return {
      ...s,
      link: `/sources/${s.id}`,
      approvalAtDate: a,
      approvedAtDate,
      restrictionsAtDate: restrictions,
      siteQualificationAtDate: qual,
      qualifiedAtDate,
      // Plain statement for the date; the current effective status is reported separately.
      appliedAtDate: !a
        ? 'No source approval decision on or before this date'
        : !approvedAtDate
          ? a.decision === 'REJECTED'
            ? `Latest decision ${a.number} rejected the source`
            : `Approval ${a.number} had expired (${a.valid_until})`
          : restrictions.length
            ? `Approved under ${a.number}, but ${restrictions.map((r) => r.kind.toLowerCase()).join(' and ')} on this date`
            : `Approved under ${a.number}${a.decision === 'APPROVED_CONDITIONAL' ? ' with conditions' : ''}${qualifiedAtDate ? '' : '; site qualification not current'}`,
      currentStatus: current.get(s.id)?.status ?? 'NOT_APPROVED',
      currentReasons: current.get(s.id)?.reasons ?? [],
    };
  });

  // Requirements in force: per baseline, the latest revision released on or before the date.
  const baselines = await many<{ baseline_id: string; title: string; revision_id: string; revision_label: string; status: string; released_at: Date; effective_from: string | null; part_number: string }>(
    db,
    `SELECT DISTINCT ON (b.id) b.id AS baseline_id, b.title, r.id AS revision_id, r.revision_label, r.status, r.released_at, r.effective_from::text, p.part_number
       FROM technical_baseline b JOIN baseline_revision r ON r.baseline_id = b.id JOIN company_part p ON p.id = b.part_id
      WHERE b.part_id = ANY($1::uuid[]) AND r.status IN ('RELEASED', 'SUPERSEDED') AND r.released_at < $2
      ORDER BY b.id, r.released_at DESC`,
    [partIds, endOfDay],
  );

  const fai = await many<{ id: string; number: string; source_id: string; sample_type: string; status: string; decision: string | null; defects: string | null; lot_number: string | null; received_date: string; decided_at: Date | null; nonconforming: string[] }>(
    db,
    `SELECT f.id, f.number, f.source_id, f.sample_type, f.status, f.decision, f.defects, f.lot_number, f.received_date::text, f.decided_at,
            coalesce((SELECT array_agg(r.char_name || ' (' || lower(r.evaluation) || ')' ORDER BY r.char_name) FROM fai_result r WHERE r.fai_id = f.id AND r.evaluation IN ('OUTSIDE', 'DOES_NOT_CONFORM')), '{}') AS nonconforming
       FROM fai_sample f WHERE f.source_id = ANY($1::uuid[]) ORDER BY f.received_date, f.sequence`,
    [sourceIds],
  );

  const inspectionIds = inspections.map((i) => i.id);
  // Lots in scope: the requested lot plus the lots of the matched inspections.
  const lots = [...new Set([lot, ...inspections.map((i) => i.lot_number)].filter((x): x is string => Boolean(x)).map((x) => x.toLowerCase()))];
  const ncrs = await many<{ id: string; number: string; title: string; status: string; severity: string; confirmed_at: Date; lot_number: string | null; scopes: Array<Record<string, unknown>> }>(
    db,
    `SELECT n.id, n.number, n.title, n.status, n.severity, n.confirmed_at, n.lot_number,
            coalesce((SELECT json_agg(json_build_object('label', m.label, 'lot', m.lot_number, 'quantity', m.quantity, 'state', m.state, 'serials', m.serial_numbers,
                       'decisions', coalesce((SELECT json_agg(json_build_object('outcome', d.outcome, 'quantity', d.quantity, 'void', d.voided_at IS NOT NULL) ORDER BY d.decided_at)
                                  FROM disposition_decision d WHERE d.scope_id = m.id), '[]'),
                       'released', coalesce((SELECT sum(r.quantity)::int FROM material_release r WHERE r.scope_id = m.id), 0)) ORDER BY m.created_at)
                      FROM material_scope m WHERE m.ncr_id = n.id), '[]') AS scopes
       FROM ncr n
      WHERE n.inspection_id = ANY($4::uuid[])
         OR (($1::uuid IS NULL OR n.part_id = $1) AND $2::text IS NOT NULL AND (lower(n.lot_number) = lower($2)
             OR EXISTS (SELECT 1 FROM material_scope m WHERE m.ncr_id = n.id AND lower(m.lot_number) = lower($2))))
         OR ($3::text IS NOT NULL AND EXISTS (SELECT 1 FROM material_scope m, unnest(m.serial_numbers) sn WHERE m.ncr_id = n.id AND ${norm('sn')} = $3))
      ORDER BY n.confirmed_at`,
    [q.partId ?? null, lot, serial, inspectionIds],
  );
  const events = await many<{ id: string; number: string; title: string; status: string; reported_at: Date }>(
    db,
    `SELECT e.id, e.number, e.title, e.status, e.reported_at FROM quality_event e
      WHERE e.inspection_id = ANY($4::uuid[])
         OR (($1::uuid IS NULL OR e.part_id = $1) AND $2::text IS NOT NULL AND lower(e.lot_number) = lower($2))
         OR ($3::text IS NOT NULL AND ${norm('e.serial_number')} = $3)
      ORDER BY e.reported_at`,
    [q.partId ?? null, lot, serial, inspectionIds],
  );
  const concessions = await many<{ id: string; number: string; status: string; characteristic: string; lot_number: string; valid_from: string; valid_until: string; in_force: boolean }>(
    db,
    `SELECT c.id, c.number, c.status, c.characteristic, c.lot_number, c.valid_from::text, c.valid_until::text,
            (c.status = 'APPROVED' AND $3::date BETWEEN c.valid_from AND c.valid_until) AS in_force
       FROM concession c WHERE c.part_id = ANY($1::uuid[]) AND (lower(c.lot_number) = ANY($2::text[]) OR c.inspection_id = ANY($4::uuid[]))
      ORDER BY c.requested_at`,
    [partIds, lots, date, inspectionIds],
  );
  const changes = await many<{ id: string; number: string; title: string; status: string; effective_date: string | null; effective_lot: string | null; in_effect: boolean }>(
    db,
    `SELECT c.id, c.number, c.title, c.status, c.effective_date::text, c.effective_lot,
            (c.status IN ('EFFECTIVE', 'IMPLEMENTATION_VERIFIED') AND c.effective_date <= $2::date) AS in_effect
       FROM change_request c WHERE c.part_id = ANY($1::uuid[]) ORDER BY c.requested_at`,
    [partIds, date],
  );

  return {
    query: { partId: q.partId ?? null, lot, serial: q.serial ?? null, date, timeZone },
    parts,
    appliedOn: {
      date,
      baselines: baselines.map((b) => ({ ...b, link: `/baselines/${b.revision_id}` })),
      sources,
      concessionsInForce: concessions.filter((c) => c.in_force),
      changesInEffect: changes.filter((c) => c.in_effect),
    },
    inspections: inspections.map((i) => ({ ...i, link: `/inspections/${i.id}` })),
    fai: fai.map((f) => ({ ...f, link: `/sources/${f.source_id}` })),
    ncrs: ncrs.map((n) => ({ ...n, link: `/quality/ncrs/${n.id}` })),
    events: events.map((e) => ({ ...e, link: `/quality/${e.id}` })),
    concessions: concessions.map((c) => ({ ...c, link: `/quality/concessions/${c.id}` })),
    changes: changes.map((c) => ({ ...c, link: `/changes/${c.id}` })),
    injectors: injectors.map((j) => ({ ...j, link: `/injectors/${j.id}` })),
  };
}
