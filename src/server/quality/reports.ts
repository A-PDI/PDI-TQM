import { CHANGE_ACTION_TEXT, CHANGE_CATEGORY_TEXT, DISPOSITION_TEXT, IMPACT_AREA_TEXT, diffCharacteristics } from '../../shared/quality.js';
import { type Queryable, many, one } from '../db.js';
import type { RecordReportSnapshot } from '../pdf/record-report.js';
import { formatDateTime } from '../pdf/text.js';

type Section = RecordReportSnapshot['sections'][number];
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const val = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v));

function base(title: string, docCode: string, number: string, tz: string): Omit<RecordReportSnapshot, 'outcome' | 'meta' | 'sections'> {
  return { kind: 'RECORD_REPORT', schemaVersion: 1, title, docCode, number, edition: 0, generatedAt: new Date().toISOString(), displayTimeZone: tz };
}

async function historySection(db: Queryable, entityType: string, id: string, tz: string): Promise<Section> {
  const rows = await many<{ occurred_at: Date; summary: string; reason: string | null; actor: string | null; outcome: string }>(
    db,
    `SELECT a.occurred_at, a.summary, a.reason, a.outcome, u.display_name AS actor FROM audit_event a LEFT JOIN app_user u ON u.id = a.actor_id
      WHERE a.entity_type = $1 AND a.entity_id = $2 ORDER BY a.id`,
    [entityType, id],
  );
  return {
    title: 'RECORD HISTORY',
    kind: 'table',
    columns: [
      { header: 'When', width: 0.18 },
      { header: 'Who', width: 0.17 },
      { header: 'Event', width: 0.65 },
    ],
    rows: rows.map((r) => [
      formatDateTime(iso(r.occurred_at), tz),
      r.actor ?? 'System',
      `${r.outcome !== 'SUCCESS' ? `[${r.outcome}] ` : ''}${r.summary}${r.reason ? ` — ${r.reason}` : ''}`,
    ]),
  };
}

async function filesSection(db: Queryable, entityType: string, id: string): Promise<Section> {
  const files = await many<{ original_name: string | null; sha256: string; caption: string | null }>(
    db,
    `SELECT f.original_name, f.sha256, l.caption FROM evidence_link l JOIN file_object f ON f.id = l.file_id
      WHERE l.entity_type = $1 AND l.entity_id = $2 AND l.unlinked_at IS NULL AND f.status = 'AVAILABLE' ORDER BY l.linked_at`,
    [entityType, id],
  );
  return {
    title: 'LINKED EVIDENCE (ORIGINAL FILES, SHA-256)',
    kind: 'table',
    columns: [
      { header: 'File', width: 0.4 },
      { header: 'Caption', width: 0.25 },
      { header: 'SHA-256 (first 24)', width: 0.35 },
    ],
    rows: files.length ? files.map((f) => [val(f.original_name), val(f.caption), f.sha256.slice(0, 24)]) : [['No files linked', '', '']],
  };
}

/** OPS-06 Nonconformance Report. */
export async function buildNcrReport(db: Queryable, id: string, tz: string): Promise<RecordReportSnapshot> {
  const n = (await one<Record<string, unknown> & { number: string; status: string; severity: string }>(
    db,
    `SELECT n.*, p.part_number, p.description AS part_description, s.legal_name AS supplier, ss.name AS site, o.display_name AS owner, c.display_name AS confirmed_by_name,
            cl.display_name AS closed_by_name, e.number AS event_number, i.number AS inspection_number
       FROM ncr n JOIN quality_event e ON e.id = n.quality_event_id LEFT JOIN company_part p ON p.id = n.part_id LEFT JOIN supplier s ON s.id = n.supplier_id
       LEFT JOIN supplier_site ss ON ss.id = n.site_id JOIN app_user o ON o.id = n.owner_id JOIN app_user c ON c.id = n.confirmed_by
       LEFT JOIN app_user cl ON cl.id = n.closed_by LEFT JOIN inspection i ON i.id = n.inspection_id WHERE n.id = $1`,
    [id],
  ))!;
  const scopes = await many<Record<string, unknown> & { id: string }>(db, 'SELECT * FROM material_scope WHERE ncr_id = $1 ORDER BY created_at', [id]);
  const decisions = await many<Record<string, unknown> & { outcome: keyof typeof DISPOSITION_TEXT }>(
    db,
    `SELECT d.*, m.lot_number, u.display_name AS decided_by_name, c.number AS concession_number,
            (SELECT v.result || ' by ' || vu.display_name || ' (' || v.method || ')' FROM disposition_verification v JOIN app_user vu ON vu.id = v.verified_by
              WHERE v.decision_id = d.id ORDER BY v.verified_at DESC LIMIT 1) AS verification
       FROM disposition_decision d JOIN material_scope m ON m.id = d.scope_id JOIN app_user u ON u.id = d.decided_by LEFT JOIN concession c ON c.id = d.concession_id
      WHERE m.ncr_id = $1 ORDER BY d.decided_at`,
    [id],
  );
  const scars = await many<{ number: string; status: string; relation: string }>(
    db,
    'SELECT s.number, s.status, x.relation FROM scar_ncr x JOIN scar s ON s.id = x.scar_id WHERE x.ncr_id = $1',
    [id],
  );
  const closed = n.status === 'CLOSED';
  return {
    ...base('Nonconformance Report', 'OPS-06', n.number, tz),
    outcome: {
      label: n.status.replaceAll('_', ' '),
      tone: closed ? 'good' : n.status === 'VERIFIED_RESOLVED' ? 'warn' : 'bad',
      note: closed
        ? `Closed after verified material resolution.${scars.some((s) => s.status !== 'CLOSED') ? ' Linked SCAR remains open.' : ''}`
        : 'Material is not authorized for use until its disposition is verified and released.',
    },
    meta: [
      ['Part', `${val(n.part_number)} — ${val(n.part_description)}`],
      ['Severity', n.severity],
      ['Supplier / site', `${val(n.supplier)} / ${val(n.site)}`],
      ['Lot / PO', `${val(n.lot_number)} / ${val(n.po_number)}`],
      ['Origin', `${val(n.event_number)}${n.inspection_number ? ` from inspection ${String(n.inspection_number)}` : ''}`],
      ['Owner', val(n.owner)],
      ['Confirmed by', `${val(n.confirmed_by_name)}, ${formatDateTime(iso(n.confirmed_at as Date), tz)}`],
      ['Closed', closed ? `${val(n.closed_by_name)}, ${formatDateTime(iso(n.closed_at as Date), tz)}` : 'Open'],
    ],
    sections: [
      {
        title: 'NONCONFORMANCE',
        kind: 'text',
        paragraphs: [
          `Title: ${val(n.title)}`,
          `Description: ${val(n.defect_description)}`,
          `Characteristic: ${val(n.characteristic)}. Expected: ${val(n.expected)}. Actual: ${val(n.actual)}.`,
          `Failure mode: ${val(n.failure_mode)}`,
          `Confirmation rationale: ${val(n.confirmation_rationale)}`,
        ],
      },
      {
        title: 'AFFECTED MATERIAL AND CONTAINMENT',
        kind: 'table',
        columns: [
          { header: 'Material', width: 0.26 },
          { header: 'Lot / qty', width: 0.16 },
          { header: 'Serials', width: 0.18 },
          { header: 'Containment / segregation', width: 0.28 },
          { header: 'State', width: 0.12 },
        ],
        rows: scopes.map((m) => [
          val(m.label),
          `${val(m.lot_number)} / ${val(m.quantity)}`,
          (m.serial_numbers as string[]).join(', ') || '—',
          `${val(m.containment_action)}${m.segregation_note ? ` — verified: ${String(m.segregation_note)}` : ' — segregation not verified'}`,
          String(m.state).replaceAll('_', ' ').toLowerCase(),
        ]),
      },
      {
        title: 'DISPOSITION DECISIONS AND VERIFICATION',
        kind: 'table',
        columns: [
          { header: 'Disposition', width: 0.2 },
          { header: 'Lot / qty', width: 0.14 },
          { header: 'Decided by', width: 0.16 },
          { header: 'Rationale / concession', width: 0.28 },
          { header: 'Verification', width: 0.22 },
        ],
        rows: decisions.map((d) => [
          `${DISPOSITION_TEXT[d.outcome].label}${d.voided_at ? ' (VOID)' : ''}`,
          `${val(d.lot_number)} / ${val(d.quantity)}`,
          val(d.decided_by_name),
          `${val(d.rationale)}${d.concession_number ? ` — under ${String(d.concession_number)}` : ''}${d.void_reason ? ` — voided: ${String(d.void_reason)}` : ''}`,
          val(d.verification),
        ]),
      },
      {
        title: 'SUPPLIER CORRECTIVE ACTION',
        kind: 'table',
        columns: [
          { header: 'SCAR', width: 0.3 },
          { header: 'Relation', width: 0.3 },
          { header: 'Status', width: 0.4 },
        ],
        rows: scars.length ? scars.map((s) => [s.number, s.relation.toLowerCase(), s.status.replaceAll('_', ' ').toLowerCase()]) : [['None linked', '', '']],
      },
      await filesSection(db, 'NCR', id),
      await historySection(db, 'ncr', id, tz),
    ],
  };
}

/** OPS-07 SCAR with 8D-style responses and OPS-08 effectiveness verification. */
export async function buildScarReport(db: Queryable, id: string, tz: string): Promise<RecordReportSnapshot> {
  const s = (await one<Record<string, unknown> & { number: string; status: string; cycle: number }>(
    db,
    `SELECT s.*, s.response_due::text AS response_due, sup.legal_name AS supplier, ss.name AS site, p.part_number, o.display_name AS owner, i.display_name AS issued_by_name
       FROM scar s JOIN supplier sup ON sup.id = s.supplier_id LEFT JOIN supplier_site ss ON ss.id = s.site_id LEFT JOIN company_part p ON p.id = s.part_id
       JOIN app_user o ON o.id = s.owner_id JOIN app_user i ON i.id = s.issued_by WHERE s.id = $1`,
    [id],
  ))!;
  const responses = await many<Record<string, unknown>>(db, 'SELECT * FROM scar_response WHERE scar_id = $1 ORDER BY revision', [id]);
  const verifications = await many<Record<string, unknown>>(
    db,
    `SELECT v.*, u.display_name AS verified_by_name, (SELECT string_agg(i.number, ', ') FROM inspection i WHERE i.id = ANY(v.inspection_ids)) AS inspections
       FROM scar_verification v JOIN app_user u ON u.id = v.verified_by WHERE v.scar_id = $1 ORDER BY v.verified_at`,
    [id],
  );
  const ncrs = await many<{ number: string; relation: string; status: string }>(db, 'SELECT n.number, x.relation, n.status FROM scar_ncr x JOIN ncr n ON n.id = x.ncr_id WHERE x.scar_id = $1', [id]);
  const closed = s.status === 'CLOSED';
  return {
    ...base('Supplier Corrective Action Request', 'OPS-07 / OPS-08', s.number, tz),
    outcome: {
      label: s.status.replaceAll('_', ' '),
      tone: closed ? 'good' : s.status === 'EFFECTIVENESS_VERIFIED' ? 'warn' : 'bad',
      note: closed ? `Closed after PDI-verified effectiveness (cycle ${s.cycle}).` : 'Supplier statements are recorded as their position; only PDI verification advances this record.',
    },
    meta: [
      ['Supplier / site', `${val(s.supplier)} / ${val(s.site)}`],
      ['Part', val(s.part_number)],
      ['Issued', `${val(s.issued_by_name)}, ${formatDateTime(iso(s.issued_at as Date), tz)}`],
      ['Sent to', `${val(s.sent_to)} via ${String(s.sent_via).toLowerCase()}`],
      ['Response due', val(s.response_due)],
      ['PDI owner', val(s.owner)],
      ['Cycle', String(s.cycle)],
      ['Nonconformances', ncrs.map((n) => `${n.number} (${n.relation.toLowerCase()})`).join(', ') || '—'],
    ],
    sections: [
      { title: 'PROBLEM STATEMENT AND REQUESTED ACTIONS', kind: 'text', paragraphs: [val(s.problem_statement), `Requested: ${val(s.requested_actions)}`] },
      {
        title: 'SUPPLIER RESPONSES (8D-STYLE, AS STATED BY THE SUPPLIER)',
        kind: 'table',
        columns: [
          { header: 'Rev / cycle', width: 0.1 },
          { header: 'From', width: 0.14 },
          { header: 'Containment', width: 0.19 },
          { header: 'Root cause', width: 0.19 },
          { header: 'Corrective / preventive action', width: 0.28 },
          { header: 'Claims done', width: 0.1 },
        ],
        rows: responses.map((r) => [
          `${val(r.revision)} / ${val(r.cycle)}`,
          `${val(r.representative)}, ${formatDateTime(iso(r.received_at as Date), tz)}`,
          val(r.containment),
          val(r.root_cause),
          `${val(r.corrective_action)}${r.prevention ? ` Prevention: ${String(r.prevention)}` : ''}`,
          r.supplier_claims_done ? 'Yes (claim)' : 'No',
        ]),
      },
      { title: 'EFFECTIVENESS VERIFICATION PLAN (OPS-08)', kind: 'text', paragraphs: [val(s.effectiveness_plan)] },
      {
        title: 'PDI VERIFICATION',
        kind: 'table',
        columns: [
          { header: 'Kind / cycle', width: 0.16 },
          { header: 'Result', width: 0.12 },
          { header: 'Verifier', width: 0.16 },
          { header: 'Method / evidence', width: 0.4 },
          { header: 'Inspections', width: 0.16 },
        ],
        rows: verifications.length
          ? verifications.map((v) => [
              `${String(v.kind).toLowerCase()} / ${val(v.cycle)}`,
              String(v.result).replace('_', ' '),
              `${val(v.verified_by_name)}, ${formatDateTime(iso(v.verified_at as Date), tz)}`,
              `${val(v.method)}: ${val(v.evidence)}${v.population_note ? ` Population: ${String(v.population_note)}` : ''}`,
              val(v.inspections),
            ])
          : [['None yet', '', '', '', '']],
      },
      await filesSection(db, 'SCAR', id),
      await historySection(db, 'scar', id, tz),
    ],
  };
}

/** OPS-05 Temporary Deviation / Concession. */
export async function buildConcessionReport(db: Queryable, id: string, tz: string): Promise<RecordReportSnapshot> {
  const c = (await one<Record<string, unknown> & { number: string; status: string }>(
    db,
    `SELECT c.*, c.valid_from::text AS valid_from, c.valid_until::text AS valid_until, p.part_number, p.description AS part_description, n.number AS ncr_number,
            i.number AS inspection_number, r.display_name AS requested_by_name, d.display_name AS decided_by_name,
            (SELECT coalesce(sum(quantity), 0)::int FROM concession_use x WHERE x.concession_id = c.id AND x.released_at IS NULL) AS used
       FROM concession c JOIN company_part p ON p.id = c.part_id LEFT JOIN ncr n ON n.id = c.ncr_id LEFT JOIN inspection i ON i.id = c.inspection_id
       JOIN app_user r ON r.id = c.requested_by LEFT JOIN app_user d ON d.id = c.decided_by WHERE c.id = $1`,
    [id],
  ))!;
  return {
    ...base('Temporary Deviation / Concession', 'OPS-05', c.number, tz),
    outcome: {
      label: c.status,
      tone: c.status === 'APPROVED' ? 'warn' : c.status === 'REJECTED' ? 'bad' : 'neutral',
      note: 'Authorizes only the named lot, quantity and dates. It is not a specification change and does not carry to other shipments.',
    },
    meta: [
      ['Part', `${val(c.part_number)} — ${val(c.part_description)}`],
      ['Lot / PO', `${val(c.lot_number)} / ${val(c.po_number)}`],
      ['Quantity', `${val(c.used)} used of ${val(c.quantity_limit)}`],
      ['Valid', `${val(c.valid_from)} to ${val(c.valid_until)}`],
      ['Characteristic', val(c.characteristic)],
      ['Origin', [c.ncr_number, c.inspection_number].filter(Boolean).join(', ') || '—'],
      ['Requested by', `${val(c.requested_by_name)}, ${formatDateTime(iso(c.requested_at as Date), tz)}`],
      ['Decided by', c.decided_by_name ? `${String(c.decided_by_name)}, ${formatDateTime(iso(c.decided_at as Date), tz)}` : 'Not decided'],
    ],
    sections: [
      {
        title: 'PERMITTED EXCEPTION AND CONDITIONS',
        kind: 'text',
        paragraphs: [`Exception: ${val(c.permitted_exception)}`, `Conditions: ${val(c.conditions)}`, `Justification: ${val(c.justification)}`, `Decision rationale: ${val(c.decision_rationale)}`],
      },
      await filesSection(db, 'CONCESSION', id),
      await historySection(db, 'concession', id, tz),
    ],
  };
}

/** OPS-03/OPS-04 change request and impact/requalification decision (ENG-09 for revisions). */
export async function buildChangeReport(db: Queryable, id: string, tz: string): Promise<RecordReportSnapshot> {
  const c = (await one<Record<string, unknown> & { number: string; status: string; categories: string[]; current_revision_id: string | null; proposed_revision_id: string | null }>(
    db,
    `SELECT c.*, c.effective_date::text AS effective_date, p.part_number, s.legal_name AS supplier, rq.display_name AS requested_by_name, d.display_name AS decided_by_name,
            cr.revision_label AS current_label, pr.revision_label AS proposed_label, ii.number AS implementation_inspection
       FROM change_request c JOIN company_part p ON p.id = c.part_id LEFT JOIN supplier s ON s.id = c.supplier_id JOIN app_user rq ON rq.id = c.requested_by
       LEFT JOIN app_user d ON d.id = c.decided_by LEFT JOIN baseline_revision cr ON cr.id = c.current_revision_id LEFT JOIN baseline_revision pr ON pr.id = c.proposed_revision_id
       LEFT JOIN inspection ii ON ii.id = c.implementation_inspection_id WHERE c.id = $1`,
    [id],
  ))!;
  const impact = await many<{ area: keyof typeof IMPACT_AREA_TEXT; affected: boolean; assessment: string }>(db, 'SELECT area, affected, assessment FROM change_impact_item WHERE change_id = $1', [id]);
  const actions = await many<{ kind: keyof typeof CHANGE_ACTION_TEXT; title: string; status: string; completion_note: string | null }>(
    db,
    'SELECT kind, title, status, completion_note FROM change_action WHERE change_id = $1 ORDER BY created_at',
    [id],
  );
  const chars = (rev: string | null) =>
    rev
      ? many<Record<string, unknown> & { charKey: string }>(
          db,
          `SELECT char_key AS "charKey", name, char_type AS "charType", unit, lower_limit::text AS lower, upper_limit::text AS upper, limit_text AS "limitText", method, special, is_delta AS "isDelta"
             FROM baseline_characteristic WHERE revision_id = $1`,
          [rev],
        )
      : Promise.resolve([]);
  const diff = diffCharacteristics(await chars(c.current_revision_id), await chars(c.proposed_revision_id)).filter((r) => r.change !== 'UNCHANGED');
  const limit = (x: Record<string, unknown> | null) => (x ? `${val(x.lower)} – ${val(x.upper)} ${x.unit ?? ''}${x.limitText ? ` ${String(x.limitText)}` : ''}`.trim() : '—');
  return {
    ...base('Change Impact & Requalification Decision', 'OPS-03 / OPS-04', c.number, tz),
    outcome: {
      label: c.status.replaceAll('_', ' '),
      tone: c.status === 'IMPLEMENTATION_VERIFIED' ? 'good' : c.status === 'REJECTED' || c.status === 'CANCELLED' ? 'bad' : 'warn',
      note: 'Approval and effectivity are separate from verified implementation on the first conforming lot.',
    },
    meta: [
      ['Part', val(c.part_number)],
      ['Origin', `${String(c.origin)}${c.supplier ? ` — ${String(c.supplier)}` : ''}${c.supplier_reference ? ` (${String(c.supplier_reference)})` : ''}`],
      ['Categories', c.categories.map((k) => CHANGE_CATEGORY_TEXT[k as keyof typeof CHANGE_CATEGORY_TEXT] ?? k).join(', ')],
      ['Revision', `${val(c.current_label)} → ${val(c.proposed_label)}`],
      ['Requested by', `${val(c.requested_by_name)}, ${formatDateTime(iso(c.requested_at as Date), tz)}`],
      ['Decision', c.decided_by_name ? `${c.status === 'REJECTED' ? 'Rejected' : 'Approved'} by ${String(c.decided_by_name)}` : 'Not decided'],
      ['Effective', c.effective_date ? `${String(c.effective_date)}${c.effective_lot ? `, first lot ${String(c.effective_lot)}` : ''}` : 'Not effective'],
      ['Implementation', c.implementation_inspection ? `Verified by ${String(c.implementation_inspection)}` : 'Not verified'],
    ],
    sections: [
      {
        title: 'DESCRIPTION, JUSTIFICATION AND DECISION',
        kind: 'text',
        paragraphs: [
          val(c.description),
          `Justification: ${val(c.justification)}`,
          `Affected stock / orders: ${val(c.affected_stock)}`,
          `Impact summary: ${val(c.impact_summary)} Requalification ${c.requalification_required ? 'required' : 'not required'}.`,
          `Decision rationale: ${val(c.decision_rationale)}${c.conditions ? ` Conditions: ${String(c.conditions)}` : ''}`,
        ],
      },
      {
        title: 'BEFORE / AFTER — CHANGED CHARACTERISTICS',
        kind: 'table',
        columns: [
          { header: 'Characteristic', width: 0.28 },
          { header: 'Change', width: 0.12 },
          { header: 'Before', width: 0.3 },
          { header: 'After', width: 0.3 },
        ],
        rows: diff.length ? diff.map((r) => [r.name, r.change.toLowerCase(), limit(r.before), limit(r.after)]) : [['No characteristic differences', '', '', '']],
      },
      {
        title: 'IMPACT ASSESSMENT',
        kind: 'table',
        columns: [
          { header: 'Area', width: 0.3 },
          { header: 'Affected', width: 0.12 },
          { header: 'Assessment', width: 0.58 },
        ],
        rows: impact.map((i) => [IMPACT_AREA_TEXT[i.area] ?? i.area, i.affected ? 'Yes' : 'No', i.assessment]),
      },
      {
        title: 'REQUALIFICATION AND IMPLEMENTATION ACTIONS',
        kind: 'table',
        columns: [
          { header: 'Action', width: 0.4 },
          { header: 'Status', width: 0.15 },
          { header: 'Outcome', width: 0.45 },
        ],
        rows: actions.length ? actions.map((a) => [a.title, a.status.toLowerCase(), val(a.completion_note)]) : [['None', '', '']],
      },
      await filesSection(db, 'CHANGE', id),
      await historySection(db, 'change_request', id, tz),
    ],
  };
}
