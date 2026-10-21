import { METRICS_VERSION, METRIC_DEFINITIONS } from '../../shared/reports.js';
import { dayIn } from '../../shared/quality.js';
import { type Queryable, many, one } from '../db.js';
import { injectorAnalytics } from '../injectors/routes.js';
import { siteQualifications } from '../sourcing/status.js';

/** Latest amended outcome, else the outcome at completion (alias `i` = inspection). */
export const EFFECTIVE_OUTCOME_SQL = `coalesce((SELECT a.resulting_outcome FROM inspection_amendment a WHERE a.inspection_id = i.id ORDER BY a.amendment_no DESC LIMIT 1), i.outcome)`;

/** Completion date of an inspection in the display time zone ($tz is the parameter placeholder). */
export const completedOn = (tz: string) => `(i.completed_at AT TIME ZONE ${tz})::date`;

export interface CurrentCounts {
  awaiting_review: number;
  open_concerns: number;
  open_inspections: number;
  open_ncrs: number;
  open_scars: number;
  overdue_scars: number;
  open_commitments: number;
  overdue_commitments: number;
  undated_commitments: number;
}

/** "Now" counts shared by Home and the reports overview so both always agree. */
export async function currentCounts(db: Queryable, timeZone: string): Promise<CurrentCounts> {
  return (await one<CurrentCounts>(
    db,
    `SELECT (SELECT count(*)::int FROM inspection WHERE status = 'READY_FOR_REVIEW') AS awaiting_review,
            (SELECT count(*)::int FROM quality_event WHERE status IN ('CAPTURED', 'TRIAGED')) AS open_concerns,
            (SELECT count(*)::int FROM inspection WHERE status IN ('DRAFT', 'PARTIAL')) AS open_inspections,
            (SELECT count(*)::int FROM ncr WHERE status <> 'CLOSED') AS open_ncrs,
            (SELECT count(*)::int FROM scar WHERE status <> 'CLOSED') AS open_scars,
            (SELECT count(*)::int FROM scar WHERE status = 'ISSUED' AND response_due < $1::date) AS overdue_scars,
            (SELECT count(*)::int FROM supplier_commitment WHERE status IN ('OPEN', 'SUPPLIER_CLAIMS_DONE')) AS open_commitments,
            (SELECT count(*)::int FROM supplier_commitment WHERE status IN ('OPEN', 'SUPPLIER_CLAIMS_DONE') AND due_date < $1::date) AS overdue_commitments,
            (SELECT count(*)::int FROM supplier_commitment WHERE status IN ('OPEN', 'SUPPLIER_CLAIMS_DONE') AND due_date IS NULL) AS undated_commitments`,
    [dayIn(timeZone)],
  ))!;
}

export interface Period {
  from: string;
  to: string;
  timeZone: string;
}

const qs = (o: Record<string, string>) => new URLSearchParams(o).toString();

/** Management overview for a period (FR-102/FR-104). Every figure carries a drill-down link. */
export async function overview(db: Queryable, p: Period, horizonDays: number) {
  const args = [p.from, p.to, p.timeZone];
  const inPeriod = (col: string) => `(${col} AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date`;
  const today = dayIn(p.timeZone);
  const horizon = dayIn(p.timeZone, new Date(Date.parse(`${today}T12:00:00Z`) + horizonDays * 86_400_000));
  const period = { completedFrom: p.from, completedTo: p.to };

  // Inspections.
  const outcomes = await many<{ outcome: string; n: number }>(
    db,
    `SELECT ${EFFECTIVE_OUTCOME_SQL} AS outcome, count(*)::int AS n FROM inspection i
      WHERE i.status = 'COMPLETED' AND ${completedOn('$3')} BETWEEN $1::date AND $2::date GROUP BY 1`,
    args,
  );
  const started = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM inspection i WHERE i.status <> 'VOID' AND ${inPeriod('i.created_at')}`, args);
  const weekly = await many<{ week: string; pass: number; fail: number; accepted: number }>(
    db,
    `SELECT to_char(date_trunc('week', i.completed_at AT TIME ZONE $3), 'YYYY-MM-DD') AS week,
            count(*) FILTER (WHERE o.outcome = 'PASS')::int AS pass, count(*) FILTER (WHERE o.outcome = 'FAIL')::int AS fail,
            count(*) FILTER (WHERE o.outcome = 'ACCEPTED')::int AS accepted
       FROM inspection i CROSS JOIN LATERAL (SELECT ${EFFECTIVE_OUTCOME_SQL} AS outcome) o
      WHERE i.status = 'COMPLETED' AND ${completedOn('$3')} BETWEEN $1::date AND $2::date GROUP BY 1 ORDER BY 1`,
    args,
  );
  const defects = await many<{ section_key: string; row_key: string; name: string; section: string; fail: number; accepted: number; inspections: number; parts: string[] }>(
    db,
    `WITH done AS (
       SELECT i.id, i.part_number FROM inspection i WHERE i.status = 'COMPLETED' AND ${completedOn('$3')} BETWEEN $1::date AND $2::date),
     latest AS (
       SELECT DISTINCT ON (r.inspection_id, r.unit_index, r.section_key, r.row_key) r.inspection_id, r.section_key, r.row_key, r.status
         FROM inspection_response r JOIN done d ON d.id = r.inspection_id
        ORDER BY r.inspection_id, r.unit_index, r.section_key, r.row_key, r.amendment_no DESC),
     g AS (
       SELECT l.section_key, l.row_key, count(*) FILTER (WHERE l.status = 'F')::int AS fail, count(*) FILTER (WHERE l.status = 'A')::int AS accepted,
              count(DISTINCT l.inspection_id)::int AS inspections, (array_agg(l.inspection_id))[1] AS sample_id, array_agg(DISTINCT d.part_number) AS parts
         FROM latest l JOIN done d ON d.id = l.inspection_id WHERE l.status IN ('F', 'A') GROUP BY 1, 2)
     SELECT g.section_key, g.row_key, g.fail, g.accepted, g.inspections, g.parts,
            coalesce(jsonb_path_query_first(s.form_snapshot, '$.sections[*] ? (@.key == $s).rows[*] ? (@.key == $r).name', jsonb_build_object('s', g.section_key, 'r', g.row_key)) #>> '{}', g.row_key) AS name,
            coalesce(jsonb_path_query_first(s.form_snapshot, '$.sections[*] ? (@.key == $s).title', jsonb_build_object('s', g.section_key)) #>> '{}', g.section_key) AS section
       FROM g JOIN inspection s ON s.id = g.sample_id ORDER BY g.fail + g.accepted DESC, name LIMIT 20`,
    args,
  );
  const count = (o: string) => outcomes.find((x) => x.outcome === o)?.n ?? 0;
  const completed = outcomes.reduce((a, x) => a + x.n, 0);

  // Supplier quality.
  const suppliers = await many<{
    id: string;
    code: string;
    name: string;
    completed: number;
    failed: number;
    accepted: number;
    ncrs: number;
    open_ncrs: number;
    open_scars: number;
    overdue_commitments: number;
    site_ids: string[];
  }>(
    db,
    `WITH insp AS (
       SELECT i.supplier_id, ${EFFECTIVE_OUTCOME_SQL} AS outcome FROM inspection i
        WHERE i.status = 'COMPLETED' AND i.supplier_id IS NOT NULL AND ${completedOn('$3')} BETWEEN $1::date AND $2::date)
     SELECT s.id, s.code, s.legal_name AS name,
            (SELECT count(*)::int FROM insp WHERE insp.supplier_id = s.id) AS completed,
            (SELECT count(*)::int FROM insp WHERE insp.supplier_id = s.id AND outcome = 'FAIL') AS failed,
            (SELECT count(*)::int FROM insp WHERE insp.supplier_id = s.id AND outcome = 'ACCEPTED') AS accepted,
            (SELECT count(*)::int FROM ncr n WHERE n.supplier_id = s.id AND ${inPeriod('n.confirmed_at')}) AS ncrs,
            (SELECT count(*)::int FROM ncr n WHERE n.supplier_id = s.id AND n.status <> 'CLOSED') AS open_ncrs,
            (SELECT count(*)::int FROM scar x WHERE x.supplier_id = s.id AND x.status <> 'CLOSED') AS open_scars,
            (SELECT count(*)::int FROM supplier_commitment c WHERE c.supplier_id = s.id AND c.status IN ('OPEN', 'SUPPLIER_CLAIMS_DONE') AND c.due_date < $4::date) AS overdue_commitments,
            coalesce((SELECT array_agg(ss.id) FROM supplier_site ss WHERE ss.supplier_id = s.id), '{}') AS site_ids
       FROM supplier s ORDER BY s.code`,
    [...args, today],
  );
  const activeSuppliers = suppliers.filter((s) => s.completed || s.ncrs || s.open_ncrs || s.open_scars || s.overdue_commitments);
  const sites = await siteQualifications(db, activeSuppliers.flatMap((s) => s.site_ids));

  // Corrective actions (now).
  const counts = await currentCounts(db, p.timeZone);
  const ncrBySeverity = await many<{ severity: string; status: string; n: number }>(
    db,
    `SELECT severity, status, count(*)::int AS n FROM ncr WHERE status <> 'CLOSED' GROUP BY 1, 2 ORDER BY 1, 2`,
  );
  const overdueItems = await many<{ type: string; id: string; number: string; title: string; due: string; owner: string; link: string }>(
    db,
    `(SELECT 'SCAR' AS type, x.id, x.number, x.title, x.response_due::text AS due, u.display_name AS owner, '/quality/scars/' || x.id AS link
        FROM scar x JOIN app_user u ON u.id = x.owner_id WHERE x.status = 'ISSUED' AND x.response_due < $1::date)
     UNION ALL
     (SELECT 'Commitment', c.id, c.number, c.promised_action, c.due_date::text, u.display_name, '/commitments/' || c.id
        FROM supplier_commitment c JOIN app_user u ON u.id = c.owner_id WHERE c.status IN ('OPEN', 'SUPPLIER_CLAIMS_DONE') AND c.due_date < $1::date)
     ORDER BY due LIMIT 50`,
    [today],
  );
  const ncrsConfirmed = await one<{ n: number; closed: number }>(
    db,
    `SELECT count(*) FILTER (WHERE ${inPeriod('confirmed_at')})::int AS n, count(*) FILTER (WHERE closed_at IS NOT NULL AND ${inPeriod('closed_at')})::int AS closed FROM ncr`,
    args,
  );

  // Qualification and expiry (now, with a reporting horizon).
  const allSites = await many<{ id: string; name: string; supplier: string; supplier_id: string }>(
    db,
    'SELECT ss.id, ss.name, s.legal_name AS supplier, s.id AS supplier_id FROM supplier_site ss JOIN supplier s ON s.id = ss.supplier_id ORDER BY s.code, ss.name',
  );
  const siteStates = await siteQualifications(db, allSites.map((s) => s.id));
  const qualificationCounts: Record<string, number> = {};
  for (const s of allSites) {
    const st = siteStates.get(s.id)!.status;
    qualificationCounts[st] = (qualificationCounts[st] ?? 0) + 1;
  }
  const expiring = await many<{ type: string; label: string; supplier: string; supplier_id: string; valid_until: string; expired: boolean }>(
    db,
    `(SELECT 'Certificate' AS type, c.cert_type || coalesce(' ' || c.cert_number, '') AS label, s.legal_name AS supplier, s.id AS supplier_id,
             c.valid_until::text AS valid_until, c.valid_until < $1::date AS expired
        FROM supplier_certificate c JOIN supplier s ON s.id = c.supplier_id
       WHERE c.valid_until IS NOT NULL AND c.valid_until <= $2::date
         AND NOT EXISTS (SELECT 1 FROM supplier_certificate n WHERE n.supplier_id = c.supplier_id AND n.site_id IS NOT DISTINCT FROM c.site_id
                          AND n.cert_type = c.cert_type AND n.recorded_at > c.recorded_at))
     UNION ALL
     (SELECT DISTINCT ON (q.site_id) 'Site qualification', q.number || ' ' || ss.name, s.legal_name, s.id, q.valid_until::text, q.valid_until < $1::date
        FROM supplier_qualification q JOIN supplier s ON s.id = q.supplier_id JOIN supplier_site ss ON ss.id = q.site_id
       WHERE q.status = 'DECIDED' AND q.decision <> 'REJECTED' AND q.valid_until IS NOT NULL
         AND q.decided_at = (SELECT max(q2.decided_at) FROM supplier_qualification q2 WHERE q2.site_id = q.site_id AND q2.status = 'DECIDED')
         AND q.valid_until <= $2::date ORDER BY q.site_id)
     UNION ALL
     (SELECT 'Source approval', d.number, s.legal_name, s.id, d.valid_until::text, d.valid_until < $1::date
        FROM source_approval_decision d JOIN source src ON src.id = d.source_id JOIN supplier s ON s.id = src.supplier_id
       WHERE d.decision <> 'REJECTED' AND d.valid_until IS NOT NULL AND d.valid_until <= $2::date
         AND d.decided_at = (SELECT max(d2.decided_at) FROM source_approval_decision d2 WHERE d2.source_id = d.source_id))
     ORDER BY valid_until`,
    [today, horizon],
  );

  // Changes.
  const changeStatus = await many<{ status: string; n: number }>(db, 'SELECT status, count(*)::int AS n FROM change_request GROUP BY 1 ORDER BY 1');
  const changePeriod = await one<{ requested: number; decided: number }>(
    db,
    `SELECT count(*) FILTER (WHERE ${inPeriod('requested_at')})::int AS requested, count(*) FILTER (WHERE decided_at IS NOT NULL AND ${inPeriod('decided_at')})::int AS decided FROM change_request`,
    args,
  );

  // Approval history.
  const approvals = await many<{ type: string; number: string; decision: string; decided_at: Date; decided_by: string; subject: string; link: string }>(
    db,
    `(SELECT 'Source approval' AS type, d.number, d.decision, d.decided_at, u.display_name AS decided_by, p.part_number || ' / ' || s.legal_name AS subject, '/sources/' || d.source_id AS link
        FROM source_approval_decision d JOIN app_user u ON u.id = d.approver_id JOIN source src ON src.id = d.source_id
        JOIN company_part p ON p.id = src.part_id JOIN supplier s ON s.id = src.supplier_id WHERE ${inPeriod('d.decided_at')})
     UNION ALL
     (SELECT 'Site qualification', q.number, q.decision, q.decided_at, u.display_name, s.legal_name || coalesce(' / ' || ss.name, ''), '/suppliers/' || q.supplier_id
        FROM supplier_qualification q JOIN app_user u ON u.id = q.decided_by JOIN supplier s ON s.id = q.supplier_id LEFT JOIN supplier_site ss ON ss.id = q.site_id
       WHERE q.status = 'DECIDED' AND ${inPeriod('q.decided_at')})
     UNION ALL
     (SELECT 'FAI', f.number, f.decision, f.decided_at, u.display_name, p.part_number || ' / ' || s.legal_name, '/sources/' || f.source_id
        FROM fai_sample f JOIN app_user u ON u.id = f.decided_by JOIN source src ON src.id = f.source_id JOIN company_part p ON p.id = src.part_id
        JOIN supplier s ON s.id = src.supplier_id WHERE f.status = 'DECIDED' AND ${inPeriod('f.decided_at')})
     UNION ALL
     (SELECT 'Concession', c.number, c.status, c.decided_at, u.display_name, p.part_number || ' lot ' || c.lot_number, '/quality/concessions/' || c.id
        FROM concession c JOIN app_user u ON u.id = c.decided_by JOIN company_part p ON p.id = c.part_id WHERE c.decided_at IS NOT NULL AND ${inPeriod('c.decided_at')})
     UNION ALL
     (SELECT 'Change', c.number, CASE WHEN c.status = 'REJECTED' THEN 'REJECTED' ELSE 'APPROVED' END, c.decided_at, u.display_name, c.title, '/changes/' || c.id
        FROM change_request c JOIN app_user u ON u.id = c.decided_by WHERE c.decided_at IS NOT NULL AND ${inPeriod('c.decided_at')})
     ORDER BY decided_at DESC LIMIT 200`,
    args,
  );

  // Recurrence (FR-104).
  const recurrence = await many<{ part_id: string | null; part_number: string | null; supplier_id: string | null; supplier: string | null; characteristic: string; failure_mode: string; ncrs: Array<{ id: string; number: string }> }>(
    db,
    `SELECT n.part_id, p.part_number, n.supplier_id, s.legal_name AS supplier, coalesce(lower(n.characteristic), '') AS characteristic, coalesce(lower(n.failure_mode), '') AS failure_mode,
            json_agg(json_build_object('id', n.id, 'number', n.number) ORDER BY n.confirmed_at) AS ncrs
       FROM ncr n LEFT JOIN company_part p ON p.id = n.part_id LEFT JOIN supplier s ON s.id = n.supplier_id
      WHERE ${inPeriod('n.confirmed_at')}
      GROUP BY n.part_id, p.part_number, n.supplier_id, s.legal_name, 5, 6 HAVING count(*) >= 2 ORDER BY count(*) DESC`,
    args,
  );
  const faiRepeats = await many<{ ncr_id: string; ncr_number: string; characteristic: string; fai_number: string; fai_source_id: string; fai_decided_at: Date; evaluation: string; lot_number: string | null }>(
    db,
    `SELECT n.id AS ncr_id, n.number AS ncr_number, n.characteristic, f.number AS fai_number, f.source_id AS fai_source_id, f.decided_at AS fai_decided_at, r.evaluation, n.lot_number
       FROM ncr n JOIN source src ON src.part_id = n.part_id AND src.supplier_id = n.supplier_id
       JOIN fai_sample f ON f.source_id = src.id AND f.decision = 'REJECTED'
       JOIN fai_result r ON r.fai_id = f.id AND r.evaluation IN ('OUTSIDE', 'DOES_NOT_CONFORM')
      WHERE ${inPeriod('n.confirmed_at')} AND n.characteristic IS NOT NULL AND lower(trim(r.char_name)) = lower(trim(n.characteristic))
      ORDER BY n.confirmed_at`,
    args,
  );

  const injectors = await injectorAnalytics(db, p.from, p.to, p.timeZone);

  return {
    period: p,
    generatedAt: new Date().toISOString(),
    definitionsVersion: METRICS_VERSION,
    definitions: METRIC_DEFINITIONS,
    horizon: { days: horizonDays, until: horizon },
    inspections: {
      completed,
      started: started!.n,
      outcomes: { PASS: count('PASS'), FAIL: count('FAIL'), ACCEPTED: count('ACCEPTED') },
      failRate: completed ? Math.round((1000 * count('FAIL')) / completed) / 10 : null,
      weekly,
      defects,
      links: {
        completed: `/inspections?${qs({ ...period, status: 'COMPLETED' })}`,
        PASS: `/inspections?${qs({ ...period, status: 'COMPLETED', outcome: 'PASS' })}`,
        FAIL: `/inspections?${qs({ ...period, status: 'COMPLETED', outcome: 'FAIL' })}`,
        ACCEPTED: `/inspections?${qs({ ...period, status: 'COMPLETED', outcome: 'ACCEPTED' })}`,
      },
    },
    suppliers: activeSuppliers.map((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      completed: s.completed,
      failed: s.failed,
      accepted: s.accepted,
      failRate: s.completed ? Math.round((1000 * s.failed) / s.completed) / 10 : null,
      ncrs: s.ncrs,
      openNcrs: s.open_ncrs,
      openScars: s.open_scars,
      overdueCommitments: s.overdue_commitments,
      sites: s.site_ids.map((id) => sites.get(id)?.status ?? 'NOT_ASSESSED'),
      link: `/suppliers/${s.id}`,
      inspectionsLink: `/inspections?${qs({ ...period, status: 'COMPLETED', supplierId: s.id })}`,
    })),
    corrective: {
      counts,
      ncrsConfirmed: ncrsConfirmed!.n,
      ncrsClosed: ncrsConfirmed!.closed,
      ncrBySeverity,
      overdue: overdueItems,
    },
    qualification: {
      sites: allSites.length,
      byStatus: qualificationCounts,
      expiring: expiring.map((e) => ({ ...e, link: `/suppliers/${e.supplier_id}` })),
    },
    changes: { byStatus: changeStatus, requested: changePeriod!.requested, decided: changePeriod!.decided },
    approvals,
    recurrence: {
      groups: recurrence.map((r) => ({ ...r, link: r.supplier_id ? `/suppliers/${r.supplier_id}` : null })),
      faiRepeats: faiRepeats.map((f) => ({ ...f, link: `/quality/ncrs/${f.ncr_id}`, faiLink: `/sources/${f.fai_source_id}` })),
    },
    injectors,
  };
}

export type Overview = Awaited<ReturnType<typeof overview>>;
