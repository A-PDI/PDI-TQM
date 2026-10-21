import { GATE_LABELS, type GateResult, type Pathway, type RiskLevel } from '../../shared/sourcing.js';
import { type Queryable, many, one } from '../db.js';
import { NCR_BLOCKING_RULE } from '../../shared/quality.js';
import { activeRestrictions, siteQualifications } from './status.js';

export interface GateContext {
  source: {
    id: string;
    pathway: Pathway;
    configuration: string;
    part_id: string;
    part_number: string;
    part_description: string;
    supplier_id: string;
    supplier_name: string;
    site_id: string;
    site_name: string;
    supplier_part_number: string;
    baseline_revision_id: string | null;
  };
  revision: {
    id: string;
    revision_label: string;
    status: string;
    released_at: Date | null;
    released_by_name: string | null;
    base_revision_id: string | null;
    title: string;
    ownership: string;
    document_ref: string | null;
  } | null;
  baseRevision: { id: string; revision_label: string; status: string; title: string; newerReleased: string | null } | null;
  characteristics: Array<{ char_key: string; name: string; char_type: string; unit: string | null; lower_limit: string | null; upper_limit: string | null; limit_text: string | null; is_delta: boolean }>;
  request: { id: string; number: string; owner_id: string; status: string } | null;
  risk: { result: RiskLevel; score: number; rule_version: string; assessed_at: Date } | null;
  siteQualification: Awaited<ReturnType<typeof siteQualifications>> extends Map<string, infer V> ? V : never;
  restrictions: Array<{ id: string; site_id: string | null; source_id: string | null; reason: string }>;
  acknowledgment: { id: string; baseline_revision_id: string; revision_label: string; response: string; representative: string | null; responded_at: Date | null; sent_at: Date } | null;
  fais: Array<{ id: string; number: string; sequence: number; sample_type: string; status: string; decision: string | null; defects: string | null; conditions: string | null; corrective_rationale: string | null; decided_at: Date | null; decided_by_name: string | null; baseline_revision_id: string }>;
  requirements: Array<{ id: string; code: string; title: string; applicability: string; status: string; waiver_reason: string | null; files: Array<{ fileId: string; name: string; sha256: string }> }>;
  blockingConcerns: Array<{ id: string; number: string; status: string; severity: string | null }>;
  openNcrs: Array<{ id: string; number: string; status: string; severity: string }>;
  concessions: Array<{ id: string; number: string; valid_until: string; valid_from: string; ncr_open: boolean }>;
  openChanges: Array<{ id: string; number: string; status: string; requalification_required: boolean | null }>;
}

export interface GateEvaluation {
  gates: GateResult[];
  approvable: boolean;
  /** Approvable only as APPROVED_CONDITIONAL (a conditional prerequisite exists). */
  conditionalOnly: boolean;
  context: GateContext;
}

/** Evaluates every approval gate for an exact source from current records (FR-036). */
export async function evaluateGates(db: Queryable, sourceId: string, timeZone = 'UTC'): Promise<GateEvaluation | null> {
  const day = (d: Date | null | undefined) => (d ? new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d) : '—');
  const source = await one<GateContext['source']>(
    db,
    `SELECT s.id, s.pathway, s.configuration, s.part_id, p.part_number, p.description AS part_description, s.supplier_id, sup.legal_name AS supplier_name,
            s.site_id, ss.name AS site_name, sp.supplier_part_number, s.baseline_revision_id
       FROM source s JOIN company_part p ON p.id = s.part_id JOIN supplier sup ON sup.id = s.supplier_id
       JOIN supplier_site ss ON ss.id = s.site_id JOIN supplier_part sp ON sp.id = s.supplier_part_id
      WHERE s.id = $1`,
    [sourceId],
  );
  if (!source) return null;
  const revision = source.baseline_revision_id
    ? await one<NonNullable<GateContext['revision']>>(
        db,
        `SELECT r.id, r.revision_label, r.status, r.released_at, u.display_name AS released_by_name, r.base_revision_id, b.title, b.ownership, r.document_ref
           FROM baseline_revision r JOIN technical_baseline b ON b.id = r.baseline_id LEFT JOIN app_user u ON u.id = r.released_by WHERE r.id = $1`,
        [source.baseline_revision_id],
      )
    : null;
  const baseRevision = revision?.base_revision_id
    ? await one<NonNullable<GateContext['baseRevision']>>(
        db,
        `SELECT r.id, r.revision_label, r.status, b.title,
                (SELECT n.revision_label FROM baseline_revision n WHERE n.baseline_id = r.baseline_id AND n.status = 'RELEASED' AND n.id <> r.id LIMIT 1) AS "newerReleased"
           FROM baseline_revision r JOIN technical_baseline b ON b.id = r.baseline_id WHERE r.id = $1`,
        [revision.base_revision_id],
      )
    : null;
  const characteristics = revision
    ? await many<GateContext['characteristics'][number]>(
        db,
        `SELECT char_key, name, char_type, unit, lower_limit, upper_limit, limit_text, is_delta FROM baseline_characteristic WHERE revision_id = $1 ORDER BY char_key`,
        [revision.id],
      )
    : [];
  const request = await one<NonNullable<GateContext['request']>>(
    db,
    `SELECT id, number, owner_id, status FROM sourcing_request WHERE source_id = $1 AND status <> 'CANCELLED' ORDER BY created_at DESC LIMIT 1`,
    [sourceId],
  );
  const risk = request
    ? await one<NonNullable<GateContext['risk']>>(
        db,
        `SELECT result, score, rule_version, assessed_at FROM risk_assessment WHERE sourcing_request_id = $1 ORDER BY assessed_at DESC LIMIT 1`,
        [request.id],
      )
    : null;
  const siteQualification = (await siteQualifications(db, [source.site_id])).get(source.site_id)!;
  const restrictions = (await activeRestrictions(db, [source.supplier_id])).filter(
    (r) => (r.source_id === null && (r.site_id === null || r.site_id === source.site_id)) || r.source_id === source.id,
  );
  const acknowledgment = revision
    ? await one<NonNullable<GateContext['acknowledgment']>>(
        db,
        `SELECT a.id, a.baseline_revision_id, r.revision_label, a.response, a.representative, a.responded_at, a.sent_at
           FROM supplier_acknowledgment a JOIN baseline_revision r ON r.id = a.baseline_revision_id
          WHERE a.source_id = $1 ORDER BY (a.baseline_revision_id = $2) DESC, a.sent_at DESC LIMIT 1`,
        [sourceId, revision.id],
      )
    : null;
  const fais = await many<GateContext['fais'][number]>(
    db,
    `SELECT f.id, f.number, f.sequence, f.sample_type, f.status, f.decision, f.defects, f.conditions, f.corrective_rationale, f.decided_at,
            u.display_name AS decided_by_name, f.baseline_revision_id
       FROM fai_sample f LEFT JOIN app_user u ON u.id = f.decided_by WHERE f.source_id = $1 AND f.status <> 'WITHDRAWN' ORDER BY f.sequence`,
    [sourceId],
  );
  const requirements = request
    ? await many<GateContext['requirements'][number]>(
        db,
        `SELECT r.id, r.code, r.title, r.applicability, r.status, r.waiver_reason,
                coalesce((SELECT json_agg(json_build_object('fileId', f.id, 'name', f.original_name, 'sha256', f.sha256) ORDER BY l.linked_at)
                            FROM evidence_link l JOIN file_object f ON f.id = l.file_id
                           WHERE l.entity_type = 'EVIDENCE_REQUIREMENT' AND l.entity_id = r.id AND l.unlinked_at IS NULL AND f.status = 'AVAILABLE'), '[]') AS files
           FROM evidence_requirement r WHERE r.sourcing_request_id = $1 ORDER BY r.code`,
        [request.id],
      )
    : [];
  const blockingConcerns = await many<GateContext['blockingConcerns'][number]>(
    db,
    `SELECT id, number, status, severity FROM quality_event
      WHERE source_id = $1 AND (status = 'CAPTURED' OR (status = 'TRIAGED' AND severity IN ('HIGH', 'CRITICAL')))`,
    [sourceId],
  );

  const openNcrs = await many<GateContext['openNcrs'][number]>(
    db,
    `SELECT id, number, status, severity FROM ncr WHERE source_id = $1 AND status NOT IN ('VERIFIED_RESOLVED', 'CLOSED') ORDER BY confirmed_at`,
    [sourceId],
  );
  const concessions = await many<GateContext['concessions'][number]>(
    db,
    `SELECT c.id, c.number, c.valid_until::text AS valid_until, c.valid_from::text AS valid_from,
            coalesce(n.status NOT IN ('VERIFIED_RESOLVED', 'CLOSED'), false) AS ncr_open
       FROM concession c LEFT JOIN ncr n ON n.id = c.ncr_id
      WHERE c.source_id = $1 AND c.status = 'APPROVED' ORDER BY c.valid_until`,
    [sourceId],
  );
  const openChanges = await many<GateContext['openChanges'][number]>(
    db,
    `SELECT c.id, c.number, c.status, c.requalification_required FROM change_source cs JOIN change_request c ON c.id = cs.change_id
      WHERE cs.source_id = $1 AND c.status IN ('PROPOSED', 'IMPACT_ASSESSED', 'APPROVED', 'EFFECTIVE') ORDER BY c.requested_at`,
    [sourceId],
  );

  const context: GateContext = {
    source,
    revision,
    baseRevision,
    characteristics,
    request,
    risk,
    siteQualification,
    restrictions,
    acknowledgment,
    fais,
    requirements,
    blockingConcerns,
    openNcrs,
    concessions,
    openChanges,
  };
  const gates: GateResult[] = [];
  const gate = (code: string, status: GateResult['status'], detail: string, link?: string) =>
    gates.push({ code, label: GATE_LABELS[code]!, status, detail, link });
  const pathway = source.pathway;
  const srcLink = `/sources/${source.id}`;

  // 1. Released technical baseline of the right ownership for the pathway.
  const expectedOwnership = { A: 'PDI', B: 'SUPPLIER', C: 'SUPPLIER_PLUS_DELTA' }[pathway];
  if (!revision) gate('BASELINE_RELEASED', 'FAIL', 'No governing technical baseline revision is linked to this source.', srcLink);
  else if (revision.status !== 'RELEASED')
    gate('BASELINE_RELEASED', 'FAIL', `Governing revision ${revision.title} Rev ${revision.revision_label} is ${revision.status.toLowerCase().replace('_', ' ')}, not released.`, `/baselines/${revision.id}`);
  else if (revision.ownership !== expectedOwnership)
    gate('BASELINE_RELEASED', 'FAIL', `Path ${pathway} needs a ${expectedOwnership.replaceAll('_', ' ').toLowerCase()} baseline; ${revision.title} is ${revision.ownership.toLowerCase()}.`, `/baselines/${revision.id}`);
  else gate('BASELINE_RELEASED', 'PASS', `${revision.title} Rev ${revision.revision_label}, released ${day(revision.released_at)} by ${revision.released_by_name}.`);

  // 2. Path C: PDI delta on top of an exact supplier base revision.
  if (pathway === 'C') {
    const deltas = characteristics.filter((c) => c.is_delta).length;
    if (!revision?.base_revision_id || !baseRevision) gate('DELTA_RELEASED', 'FAIL', 'The delta revision does not reference a supplier base revision.', revision ? `/baselines/${revision.id}` : srcLink);
    else if (deltas === 0) gate('DELTA_RELEASED', 'FAIL', 'The delta revision defines no PDI-controlled delta characteristics.', `/baselines/${revision.id}`);
    else if (baseRevision.newerReleased)
      gate(
        'DELTA_RELEASED',
        'PASS',
        `Delta of ${deltas} characteristic(s) on supplier base Rev ${baseRevision.revision_label}. Supplier has since released Rev ${baseRevision.newerReleased}; it does not replace the PDI configuration without change control.`,
      );
    else gate('DELTA_RELEASED', 'PASS', `Delta of ${deltas} characteristic(s) on supplier base ${baseRevision.title} Rev ${baseRevision.revision_label}.`);
  }

  // 3. Supplier / site restrictions.
  if (restrictions.length) gate('SUPPLIER_NOT_RESTRICTED', 'FAIL', restrictions.map((r) => `${r.source_id ? 'This source restricted' : r.site_id ? 'Site suspended' : 'Supplier suspended'}: ${r.reason}`).join('; '), `/suppliers/${source.supplier_id}`);
  else gate('SUPPLIER_NOT_RESTRICTED', 'PASS', 'No active suspension.');

  // 4. This exact site's qualification.
  const sq = siteQualification;
  if (sq.status === 'QUALIFIED') gate('SITE_QUALIFIED', 'PASS', `${source.site_name}: ${sq.number} qualified${sq.validUntil ? ` until ${sq.validUntil}` : ''}.`);
  else if (sq.status === 'CONDITIONALLY_QUALIFIED')
    gate('SITE_QUALIFIED', 'WARN', `${source.site_name}: ${sq.number} conditionally qualified until ${sq.validUntil} — ${sq.conditions}.`);
  else gate('SITE_QUALIFIED', 'FAIL', `${source.site_name} is ${sq.status.replaceAll('_', ' ').toLowerCase()}; another site's or the parent supplier's qualification does not count.`, `/suppliers/${source.supplier_id}`);

  // 5. Supplier acknowledgment of the exact governing revision.
  const riskLevel = risk?.result ?? null;
  const ackRequired = pathway !== 'B' || riskLevel === 'HIGH';
  const ack = acknowledgment;
  if (!ackRequired) gate('SUPPLIER_ACKNOWLEDGED', 'NOT_APPLICABLE', 'Supplier-standard product below high risk: the supplier owns the specification.');
  else if (!ack) gate('SUPPLIER_ACKNOWLEDGED', 'FAIL', 'No acknowledgment of the governing revision has been requested.', srcLink);
  else if (ack.baseline_revision_id !== revision?.id) gate('SUPPLIER_ACKNOWLEDGED', 'FAIL', `Supplier acknowledged Rev ${ack.revision_label}, not the governing Rev ${revision?.revision_label}.`, srcLink);
  else if (ack.response === 'PENDING') gate('SUPPLIER_ACKNOWLEDGED', 'FAIL', `Rev ${ack.revision_label} sent ${day(ack.sent_at)}; no response yet.`, srcLink);
  else if (ack.response === 'OBJECTED') gate('SUPPLIER_ACKNOWLEDGED', 'FAIL', `Supplier objected to Rev ${ack.revision_label}; resolve and re-send.`, srcLink);
  else gate('SUPPLIER_ACKNOWLEDGED', 'PASS', `Rev ${ack.revision_label} acknowledged by ${ack.representative} on ${day(ack.responded_at)}.`);

  // 6. First article / validation against the governing revision.
  const faiRequired = pathway !== 'B' || riskLevel !== 'LOW';
  const forRevision = fais.filter((f) => f.baseline_revision_id === revision?.id);
  const latest = forRevision[forRevision.length - 1];
  if (!faiRequired) gate('FAI_ACCEPTED', 'NOT_APPLICABLE', 'Low-risk supplier-standard product: receiving inspection evidence is proportionate.');
  else if (!latest) gate('FAI_ACCEPTED', 'FAIL', `No first article registered against Rev ${revision?.revision_label ?? '—'}.`, srcLink);
  else if (latest.status !== 'DECIDED') gate('FAI_ACCEPTED', 'FAIL', `${latest.number} awaits a decision.`, srcLink);
  else if (latest.decision === 'REJECTED') gate('FAI_ACCEPTED', 'FAIL', `${latest.number} rejected: ${latest.defects}. Register a resubmitted sample with corrective rationale.`, srcLink);
  else if (latest.decision === 'CONDITIONAL') gate('FAI_ACCEPTED', 'WARN', `${latest.number} accepted with conditions: ${latest.conditions}.`);
  else {
    const rejected = forRevision.filter((f) => f.decision === 'REJECTED').length;
    gate('FAI_ACCEPTED', 'PASS', `${latest.number} accepted${rejected ? ` after ${rejected} rejected sample(s), kept on record` : ''}.`);
  }

  // 7. Risk assessed on the sourcing request.
  if (!request) gate('RISK_ASSESSED', 'FAIL', 'This source is not linked to a sourcing request; start one to record risk and evidence.', '/sourcing');
  else if (!risk) gate('RISK_ASSESSED', 'FAIL', `${request.number} has no risk assessment.`, `/sourcing/${request.id}`);
  else gate('RISK_ASSESSED', 'PASS', `Risk ${risk.result} (score ${risk.score}, ${risk.rule_version}).`);

  // 8. Required evidence satisfied (with available files) or waived with authority.
  if (request) {
    const required = requirements.filter((r) => r.applicability === 'REQUIRED');
    const missing = required.filter((r) => !(r.status === 'WAIVED' || (r.status === 'SATISFIED' && r.files.length > 0)));
    if (!required.length && !risk) gate('EVIDENCE_COMPLETE', 'FAIL', 'Checklist not generated yet (assess risk first).', `/sourcing/${request.id}`);
    else if (missing.length) gate('EVIDENCE_COMPLETE', 'FAIL', `Missing: ${missing.map((m) => `${m.code} ${m.title}`).join('; ')}.`, `/sourcing/${request.id}`);
    else gate('EVIDENCE_COMPLETE', 'PASS', `${required.length} required item(s) satisfied or waived.`);
  }

  // 9. Open concerns and nonconformances on this source (NCR-BLOCK-INTERIM-1, POL-14).
  const blockingNcrs = openNcrs.filter((n) => n.severity === 'HIGH' || n.severity === 'CRITICAL');
  const otherNcrs = openNcrs.filter((n) => !blockingNcrs.includes(n));
  if (blockingConcerns.length || blockingNcrs.length) {
    const items = [
      ...blockingNcrs.map((n) => `${n.number} (${n.severity.toLowerCase()} nonconformance, ${n.status.replaceAll('_', ' ').toLowerCase()})`),
      ...blockingConcerns.map((c) => `${c.number} (${c.status === 'CAPTURED' ? 'awaiting triage' : c.severity})`),
    ];
    const link = blockingNcrs.length ? `/quality/ncrs/${blockingNcrs[0]!.id}` : `/quality/${blockingConcerns[0]!.id}`;
    gate('NO_BLOCKING_QUALITY', 'FAIL', `Open: ${items.join(', ')}. Resolve and verify the material, or close with a documented outcome.`, link);
  } else if (otherNcrs.length)
    gate('NO_BLOCKING_QUALITY', 'WARN', `Open lower-severity nonconformance: ${otherNcrs.map((n) => n.number).join(', ')}. Only a conditional approval is possible (${NCR_BLOCKING_RULE}).`, `/quality/ncrs/${otherNcrs[0]!.id}`);
  else gate('NO_BLOCKING_QUALITY', 'PASS', 'None open.');

  // 10. Concessions: an expired one relied on by open nonconformance blocks; a current one limits approval to conditional.
  const today = day(new Date());
  const expired = concessions.filter((c) => c.valid_until < today && c.ncr_open);
  const current = concessions.filter((c) => c.valid_from <= today && c.valid_until >= today);
  if (expired.length)
    gate('CONCESSIONS_CURRENT', 'FAIL', `${expired.map((c) => `${c.number} expired ${c.valid_until}`).join(', ')} while its nonconformance is still open. Disposition the material another way or request a new concession.`, `/quality/concessions/${expired[0]!.id}`);
  else if (current.length)
    gate('CONCESSIONS_CURRENT', 'WARN', `Active deviation ${current.map((c) => `${c.number} (until ${c.valid_until})`).join(', ')}; a concession is not a specification change, so only a conditional approval is possible.`, `/quality/concessions/${current[0]!.id}`);
  else gate('CONCESSIONS_CURRENT', 'PASS', 'No concession relied on.');

  // 11. Change control: a change needing requalification must be verified first.
  const requal = openChanges.filter((c) => (c.status === 'APPROVED' || c.status === 'EFFECTIVE') && c.requalification_required);
  if (requal.length)
    gate('CHANGE_CONTROL', 'FAIL', `${requal.map((c) => c.number).join(', ')} requires requalification and its implementation is not yet verified.`, `/changes/${requal[0]!.id}`);
  else if (openChanges.length)
    gate('CHANGE_CONTROL', 'WARN', `Pending change ${openChanges.map((c) => `${c.number} (${c.status.replaceAll('_', ' ').toLowerCase()})`).join(', ')}; only a conditional approval is possible until it is decided.`, `/changes/${openChanges[0]!.id}`);
  else gate('CHANGE_CONTROL', 'PASS', 'No pending change on this source.');

  const approvable = !gates.some((g) => g.status === 'FAIL');
  const conditionalOnly = gates.some((g) => g.status === 'WARN');
  return { gates, approvable, conditionalOnly, context };
}
