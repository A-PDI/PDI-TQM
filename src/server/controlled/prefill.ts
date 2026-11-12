import { type ControlledEntity, ROW_KEY, type RecordData, type TemplateSchema } from '../../shared/controlled-forms.js';
import { type Queryable, many, one } from '../db.js';

/**
 * Facts the module record holds, mapped onto the controlled form. On a record opened by a module event
 * they are carried over and locked (the module is where they are entered); on other records they are
 * starting values. Rows that come from the module carry a stable `_key` so supplementary entries on
 * them (equipment, verification…) stay attached to the right row. Only keys that exist on the bound
 * template revision are kept.
 */
export interface EntityContext {
  label: string;
  fields: Record<string, string>;
  schedules: Record<string, Array<Record<string, string>>>;
  /** The module page that shows the record (a first article is shown on its source). */
  route?: string;
}

const d = (v: unknown) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : '');
const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));

interface SourceRow {
  part_number: string;
  part_description: string;
  supplier_code: string;
  supplier_name: string;
  site_code: string;
  site_name: string;
  supplier_part_number: string;
  configuration: string;
  pathway: string;
  baseline_title: string | null;
  revision_label: string | null;
  baseline_revision_id: string | null;
  request_number: string | null;
}

async function sourceRow(db: Queryable, sourceId: string): Promise<SourceRow | null> {
  return one<SourceRow>(
    db,
    `SELECT p.part_number, p.description AS part_description, su.code AS supplier_code, su.legal_name AS supplier_name,
            st.code AS site_code, st.name AS site_name, sp.supplier_part_number, s.configuration, s.pathway,
            tb.title AS baseline_title, br.revision_label, s.baseline_revision_id,
            (SELECT r.number FROM sourcing_request r WHERE r.source_id = s.id ORDER BY r.created_at DESC LIMIT 1) AS request_number
       FROM source s
       JOIN company_part p ON p.id = s.part_id
       JOIN supplier su ON su.id = s.supplier_id
       JOIN supplier_site st ON st.id = s.site_id
       JOIN supplier_part sp ON sp.id = s.supplier_part_id
       LEFT JOIN baseline_revision br ON br.id = s.baseline_revision_id
       LEFT JOIN technical_baseline tb ON tb.id = br.baseline_id
      WHERE s.id = $1`,
    [sourceId],
  );
}

const sourceHeader = (r: SourceRow): Record<string, string> => ({
  supplier_legal_name: r.supplier_name,
  supplier_id: r.supplier_code,
  supplier_site: `${r.site_code} - ${r.site_name}`,
  pdi_part: r.part_number,
  engineering_revision: r.revision_label ?? '',
  supplier_part: r.supplier_part_number,
  project_ref: r.request_number ?? '',
  baseline_ref: r.baseline_title ? `${r.baseline_title} Rev ${r.revision_label}` : '',
  configuration_id: r.configuration,
  candidate_path: r.pathway,
});

async function partySite(db: Queryable, supplierId: string | null, siteId: string | null, partId: string | null) {
  const supplier = supplierId ? await one<{ code: string; legal_name: string }>(db, 'SELECT code, legal_name FROM supplier WHERE id = $1', [supplierId]) : null;
  const site = siteId ? await one<{ code: string; name: string }>(db, 'SELECT code, name FROM supplier_site WHERE id = $1', [siteId]) : null;
  const part = partId ? await one<{ part_number: string; description: string }>(db, 'SELECT part_number, description FROM company_part WHERE id = $1', [partId]) : null;
  return {
    ...(supplier ? { supplier_legal_name: supplier.legal_name, supplier_id: supplier.code } : {}),
    ...(site ? { supplier_site: `${site.code} - ${site.name}` } : {}),
    ...(part ? { pdi_part: part.part_number } : {}),
  };
}

const DISPOSITION: Record<string, string> = { RETURN_TO_SUPPLIER: 'Return', SCRAP: 'Scrap', REWORK: 'Rework', REPAIR: 'Repair', USE_AS_IS: 'Use-as-is' };
const SEVERITY_CLASS: Record<string, string> = { CRITICAL: 'Critical', HIGH: 'Major', MEDIUM: 'Major', LOW: 'Minor' };
const RESPONSE_RESULT: Record<string, string> = { P: 'Pass', F: 'Fail', A: 'Hold', N: 'NA' };

/** Reads the module record; null when it does not exist. */
export async function entityContext(db: Queryable, entity: ControlledEntity, id: string | null, typeCode: string, tz = 'UTC'): Promise<EntityContext | null> {
  switch (entity) {
    case 'SYSTEM':
      return { label: 'Quality system', fields: {}, schedules: {} };
    case 'SOURCE': {
      if (!id) return null;
      const r = await sourceRow(db, id);
      if (!r) return null;
      const fields = sourceHeader(r);
      const schedules: EntityContext['schedules'] = {};
      if (typeCode === 'VAL-11') {
        const risk = await one<{ number: string | null; result: string; score: number }>(
          db,
          `SELECT r.number, ra.result, ra.score FROM risk_assessment ra JOIN sourcing_request r ON r.id = ra.sourcing_request_id
            WHERE r.source_id = $1 ORDER BY ra.assessed_at DESC LIMIT 1`,
          [id],
        );
        Object.assign(fields, {
          sourcing_path: r.pathway,
          approved_configuration: r.configuration,
          ...(risk ? { risk_ref: `${risk.number} risk ${risk.result} (score ${risk.score})` } : {}),
        });
      }
      if (['ENG-04', 'ENG-08', 'PRS-001', 'OPS-01'].includes(typeCode) && r.baseline_revision_id) {
        const chars = await many<{ char_key: string; name: string; char_type: string; unit: string | null; lower_limit: string | null; upper_limit: string | null; limit_text: string | null; method: string | null; special: boolean }>(
          db,
          `SELECT char_key, name, char_type, unit, lower_limit, upper_limit, limit_text, method, special FROM baseline_characteristic WHERE revision_id = $1 ORDER BY char_key`,
          [r.baseline_revision_id],
        );
        const limits = (c: (typeof chars)[number]) => (c.lower_limit !== null || c.upper_limit !== null ? `${c.lower_limit ?? ''} - ${c.upper_limit ?? ''} ${c.unit ?? ''}`.trim() : s(c.limit_text));
        if (typeCode === 'OPS-01') schedules.inspection_controls = chars.map((c) => ({ characteristic: `${c.char_key} ${c.name}`, limits: limits(c), method: s(c.method) }));
        else if (typeCode === 'ENG-08') schedules.characteristics = chars.filter((c) => c.special).map((c) => ({ characteristic_id: c.char_key, limits: limits(c), method: s(c.method) }));
        else schedules.requirements = chars.map((c) => ({ requirement_id: c.char_key, source: fields.baseline_ref ?? '', requirement: `${c.name}: ${limits(c)}`, criticality: c.special ? 'Critical' : 'Normal', verification: s(c.method) }));
      }
      return { label: `${r.part_number} · ${r.supplier_name} · ${r.site_code}`, fields, schedules };
    }
    case 'FAI': {
      if (!id) return null;
      const fai = await one<{ id: string; number: string; source_id: string; sample_type: string; lot_number: string | null; serial_numbers: string | null; received_date: string; description: string | null; recorder: string }>(
        db,
        `SELECT f.id, f.number, f.source_id, f.sample_type, f.lot_number, f.serial_numbers, f.received_date, f.description, u.display_name AS recorder
           FROM fai_sample f JOIN app_user u ON u.id = f.recorded_by WHERE f.id = $1`,
        [id],
      );
      if (!fai) return null;
      const r = await sourceRow(db, fai.source_id);
      if (!r) return null;
      const results = await many<{ char_key: string; char_name: string; unit: string | null; lower_limit: string | null; upper_limit: string | null; value_text: string | null; visual_result: string | null; evaluation: string; recorder: string; recorded_at: string }>(
        db,
        `SELECT x.char_key, x.char_name, x.unit, x.lower_limit, x.upper_limit, x.value_text, x.visual_result, x.evaluation, u.display_name AS recorder, x.recorded_at
           FROM fai_result x JOIN app_user u ON u.id = x.recorded_by WHERE x.fai_id = $1 ORDER BY x.char_key`,
        [id],
      );
      const required = (await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM baseline_characteristic c JOIN fai_sample f ON f.baseline_revision_id = c.revision_id WHERE f.id = $1`, [id]))!.n;
      const failed = results.filter((x) => x.evaluation === 'OUTSIDE' || x.evaluation === 'DOES_NOT_CONFORM').length;
      const lastMeasured = results.reduce<string>((m, x) => (d(x.recorded_at) > m ? d(x.recorded_at) : m), '');
      const fields: Record<string, string> = {
        ...sourceHeader(r),
        lot: s(fai.lot_number),
        fai_reason: [fai.sample_type.replaceAll('_', ' ').toLowerCase(), fai.description].filter(Boolean).join(': '),
        plan_ref: fai.number,
        required_characteristics: String(required),
        evaluated_characteristics: String(results.length),
        failed_characteristics: String(failed),
        not_evaluated: String(Math.max(0, required - results.length)),
        ...(results.length ? { inspection_date: lastMeasured, inspector: [...new Set(results.map((x) => x.recorder))].join(', ') } : {}),
      };
      return {
        label: `${fai.number} ${r.part_number} · ${r.supplier_name}`,
        route: `/sources/${fai.source_id}`,
        fields,
        schedules: {
          measurements: results.map((x) => ({
            [ROW_KEY]: x.char_key,
            characteristic_id: `${x.char_key} ${x.char_name}`,
            sample_id: fai.serial_numbers || fai.number,
            lower_limit: s(x.lower_limit),
            upper_limit: s(x.upper_limit),
            units: s(x.unit),
            actual: s(x.value_text),
            attribute_result: x.visual_result === 'CONFORMS' ? 'Conforms' : x.visual_result === 'DOES_NOT_CONFORM' ? 'Does not conform' : '',
            result: x.evaluation === 'WITHIN' || x.evaluation === 'CONFORMS' ? 'Pass' : x.evaluation === 'NO_LIMIT' ? 'NE' : 'Fail',
          })),
        },
      };
    }
    case 'SOURCING_REQUEST': {
      if (!id) return null;
      const r = await one<{ number: string; title: string; pathway: string; part_id: string | null; proposed_part_number: string | null; description: string | null; supplier_id: string | null; site_id: string | null; supplier_part_number: string | null; configuration: string; commercial_rationale: string | null; quantity_note: string | null; target_date: string | null; owner: string }>(
        db,
        `SELECT r.number, r.title, r.pathway, r.part_id, r.proposed_part_number, r.description, r.supplier_id, r.site_id, r.supplier_part_number, r.configuration,
                r.commercial_rationale, r.quantity_note, r.target_date, u.display_name AS owner
           FROM sourcing_request r JOIN app_user u ON u.id = r.owner_id WHERE r.id = $1`,
        [id],
      );
      if (!r) return null;
      const fields: Record<string, string> = {
        ...(await partySite(db, r.supplier_id, r.site_id, r.part_id)),
        project_ref: r.number,
        supplier_part: s(r.supplier_part_number),
        requested_by: r.owner,
        need_date: d(r.target_date),
        intended_use: s(r.description),
        business_case: s(r.commercial_rationale),
        candidate_path: r.pathway,
        configuration_id: r.configuration,
      };
      if (!fields.pdi_part && r.proposed_part_number) fields.pdi_part = r.proposed_part_number;
      return { label: `${r.number} ${r.title}`, fields, schedules: {} };
    }
    case 'SUPPLIER': {
      if (!id) return null;
      const r = await one<{ code: string; legal_name: string; category: string | null }>(db, 'SELECT code, legal_name, category FROM supplier WHERE id = $1', [id]);
      if (!r) return null;
      const sites = await many<{ code: string; name: string; address: string | null }>(db, `SELECT code, name, address FROM supplier_site WHERE supplier_id = $1 ORDER BY code`, [id]);
      const fields: Record<string, string> = { supplier_legal_name: r.legal_name, supplier_id: r.code, product_scope: s(r.category) };
      if (sites.length === 1) Object.assign(fields, { supplier_site: `${sites[0]!.code} - ${sites[0]!.name}`, site_address: s(sites[0]!.address) });
      return { label: `${r.code} ${r.legal_name}`, fields, schedules: {} };
    }
    case 'CHANGE': {
      if (!id) return null;
      const r = await one<{ number: string; title: string; description: string; justification: string; part_id: string; supplier_id: string | null; site_id: string | null; supplier_reference: string | null; cur: string | null; prop: string | null; affected_stock: string | null; desired: string | null }>(
        db,
        `SELECT c.number, c.title, c.description, c.justification, c.part_id, c.supplier_id, c.site_id, c.supplier_reference,
                cr.revision_label AS cur, pr.revision_label AS prop, c.affected_stock, c.desired_effective_date AS desired
           FROM change_request c
           LEFT JOIN baseline_revision cr ON cr.id = c.current_revision_id
           LEFT JOIN baseline_revision pr ON pr.id = c.proposed_revision_id
          WHERE c.id = $1`,
        [id],
      );
      if (!r) return null;
      const fields: Record<string, string> = { ...(await partySite(db, r.supplier_id, r.site_id, r.part_id)), project_ref: r.number, engineering_revision: s(r.cur), supplier_change_id: s(r.supplier_reference) };
      const schedules: EntityContext['schedules'] = {};
      if (r.cur || r.prop) {
        if (typeCode === 'ENG-09') schedules.changed_baselines = [{ object: r.title, old_revision: s(r.cur), new_revision: s(r.prop), inventory: s(r.affected_stock), effectivity: d(r.desired) }];
        if (typeCode === 'OPS-03') schedules.change_comparison = [{ object: r.title, current: s(r.cur), proposed: `${s(r.prop)} ${r.description}`.trim() }];
      }
      return { label: `${r.number} ${r.title}`, fields, schedules };
    }
    case 'INSPECTION': {
      if (!id) return null;
      const r = await one<{ number: string; part_id: string | null; part_number: string; supplier_id: string | null; site_id: string | null; po_number: string | null; date_received: string; lot_number: string | null; lot_size: number | null; unit_count: number; inspector: string; outcome: string | null; started_on: string; baseline_snapshot: { baselineTitle: string; revisionLabel: string; characteristics: Array<{ charKey: string; name: string; formRowRef: string | null; unit: string | null; lower: string | null; upper: string | null; nominal: string | null }> } | null; form_snapshot: { formNumber?: string } }>(
        db,
        `SELECT i.number, i.part_id, i.part_number, i.supplier_id, i.site_id, i.po_number, i.date_received, i.lot_number, i.lot_size, i.unit_count,
                u.display_name AS inspector, i.outcome, i.baseline_snapshot, i.form_snapshot, (i.created_at AT TIME ZONE $2)::date::text AS started_on
           FROM inspection i JOIN app_user u ON u.id = i.inspector_id WHERE i.id = $1`,
        [id, tz],
      );
      if (!r) return null;
      const units = await many<{ unit_index: number; serial_number: string | null }>(db, 'SELECT unit_index, serial_number FROM inspection_unit WHERE inspection_id = $1', [id]);
      const serial = new Map(units.map((u) => [u.unit_index, u.serial_number]));
      const readings = await many<{ unit_index: number; section_key: string; row_key: string; reading_key: string; value_text: string; unit: string | null; status: string | null }>(
        db,
        `SELECT m.unit_index, m.section_key, m.row_key, m.reading_key, m.value_text, m.unit,
                (SELECT x.status FROM inspection_response x WHERE x.inspection_id = m.inspection_id AND x.unit_index = m.unit_index AND x.section_key = m.section_key AND x.row_key = m.row_key ORDER BY x.amendment_no DESC LIMIT 1) AS status
           FROM inspection_measurement m
          WHERE m.inspection_id = $1
            AND m.amendment_no = (SELECT max(y.amendment_no) FROM inspection_measurement y WHERE y.inspection_id = m.inspection_id AND y.unit_index = m.unit_index AND y.section_key = m.section_key AND y.row_key = m.row_key AND y.reading_key = m.reading_key)
          ORDER BY m.unit_index, m.section_key, m.row_key, m.reading_key`,
        [id],
      );
      const chars = r.baseline_snapshot?.characteristics ?? [];
      // Latest answer of every item (amendments supersede earlier answers).
      const failed = await many<{ unit_index: number }>(
        db,
        `SELECT x.unit_index FROM inspection_response x
          WHERE x.inspection_id = $1 AND x.status = 'F'
            AND x.amendment_no = (SELECT max(y.amendment_no) FROM inspection_response y WHERE y.inspection_id = x.inspection_id AND y.unit_index = x.unit_index AND y.section_key = x.section_key AND y.row_key = x.row_key)`,
        [id],
      );
      const nonconforming = new Set(failed.map((x) => x.unit_index)).size;
      const fields: Record<string, string> = {
        ...(await partySite(db, r.supplier_id, r.site_id, r.part_id)),
        pdi_part: r.part_number,
        project_ref: r.number,
        engineering_revision: s(r.baseline_snapshot?.revisionLabel),
        baseline_ref: r.baseline_snapshot ? `${r.baseline_snapshot.baselineTitle} Rev ${r.baseline_snapshot.revisionLabel}` : '',
        purchase_order: s(r.po_number),
        receipt_date: d(r.date_received),
        supplier_lot: s(r.lot_number),
        received_qty: r.lot_size ? String(r.lot_size) : '',
        inspection_plan: s(r.form_snapshot?.formNumber),
        sampled_qty: String(r.unit_count),
        inspector: r.inspector,
        inspection_date: r.started_on,
        nonconforming_units: String(nonconforming),
        defect_count: String(failed.length),
        held_units: String(nonconforming),
      };
      return {
        label: `${r.number} ${r.part_number}`,
        fields,
        schedules: {
          measurements: readings.map((x) => {
            const c = chars.find((k) => k.formRowRef !== null && (k.formRowRef === x.row_key || k.formRowRef.split(':').pop() === x.row_key));
            return {
              [ROW_KEY]: `${x.unit_index}|${x.section_key}|${x.row_key}|${x.reading_key}`,
              characteristic_id: `${x.row_key}${x.reading_key === 'a1' ? '' : ` ${x.reading_key}`}`,
              sample_id: serial.get(x.unit_index) || `Unit ${x.unit_index}`,
              nominal: s(c?.nominal),
              lower_limit: s(c?.lower),
              upper_limit: s(c?.upper),
              units: s(x.unit ?? c?.unit),
              actual: x.value_text,
              result: RESPONSE_RESULT[x.status ?? ''] ?? '',
            };
          }),
        },
      };
    }
    case 'CONCESSION': {
      if (!id) return null;
      const r = await one<{ number: string; part_id: string; source_id: string | null; lot_number: string; po_number: string | null; quantity_limit: number; characteristic: string; permitted_exception: string; conditions: string | null; justification: string; valid_from: string; valid_until: string; ncr_number: string | null; used: number }>(
        db,
        `SELECT c.number, c.part_id, c.source_id, c.lot_number, c.po_number, c.quantity_limit, c.characteristic, c.permitted_exception, c.conditions,
                c.justification, c.valid_from, c.valid_until, n.number AS ncr_number,
                COALESCE((SELECT sum(u.quantity)::int FROM concession_use u WHERE u.concession_id = c.id), 0) AS used
           FROM concession c LEFT JOIN ncr n ON n.id = c.ncr_id WHERE c.id = $1`,
        [id],
      );
      if (!r) return null;
      const src = r.source_id ? await sourceRow(db, r.source_id) : null;
      const fields: Record<string, string> = {
        ...(src ? sourceHeader(src) : await partySite(db, null, null, r.part_id)),
        project_ref: r.number,
        request_type: r.ncr_number ? 'Existing nonconformance' : 'Planned deviation',
        ncr_ref: s(r.ncr_number),
        required: r.characteristic,
        actual: r.permitted_exception,
        risk: r.justification,
        requested_qty: String(r.quantity_limit),
        requested_start: d(r.valid_from),
        requested_expiry: d(r.valid_until),
        return_standard: s(r.conditions),
      };
      return {
        label: `${r.number} lot ${r.lot_number}`,
        fields,
        // The concession authorizes exactly the requested quantity; its decision approves or rejects it.
        schedules: { limited_lots: [{ [ROW_KEY]: 'lot', lot: r.lot_number, requested: String(r.quantity_limit), authorized: String(r.quantity_limit), used: String(r.used), remaining: String(Math.max(0, r.quantity_limit - r.used)), traceability: s(r.po_number) }] },
      };
    }
    case 'NCR': {
      if (!id) return null;
      const r = await one<{ number: string; title: string; defect_description: string; characteristic: string | null; expected: string | null; actual: string | null; part_id: string | null; supplier_id: string | null; site_id: string | null; source_id: string | null; inspection_id: string | null; lot_number: string | null; severity: string; confirmed_at: string; reporter: string; governing: string | null }>(
        db,
        `SELECT n.number, n.title, n.defect_description, n.characteristic, n.expected, n.actual, n.part_id, n.supplier_id, n.site_id, n.source_id, n.inspection_id,
                n.lot_number, n.severity, n.confirmed_at, ru.display_name AS reporter,
                nullif(concat_ws(' ', (SELECT d.number || ' Rev ' || cr.revision_label FROM controlled_document_revision cr JOIN controlled_document d ON d.id = cr.document_id WHERE cr.id = n.governing_revision_id),
                                 n.governing_clause,
                                 (SELECT 'part schedule ' || p.part_number || ' Rev ' || br.revision_label FROM baseline_revision br JOIN technical_baseline tb ON tb.id = br.baseline_id JOIN company_part p ON p.id = tb.part_id WHERE br.id = n.governing_baseline_revision_id)), '') AS governing
           FROM ncr n JOIN quality_event q ON q.id = n.quality_event_id JOIN app_user ru ON ru.id = q.reported_by WHERE n.id = $1`,
        [id],
      );
      if (!r) return null;
      const scopes = await many<{ id: string; label: string; lot_number: string; quantity: number; serial_numbers: string[]; location: string | null; containment_action: string; state: string }>(
        db,
        `SELECT id, label, lot_number, quantity, serial_numbers, location, containment_action, state FROM material_scope WHERE ncr_id = $1 ORDER BY created_at`,
        [id],
      );
      const decisions = await many<{ scope_id: string; outcome: string; concession: string | null; instructions: string | null }>(
        db,
        `SELECT d.scope_id, d.outcome, c.number AS concession, d.instructions FROM disposition_decision d LEFT JOIN concession c ON c.id = d.concession_id
          WHERE d.scope_id = ANY($1::uuid[]) AND d.voided_at IS NULL ORDER BY d.decided_at`,
        [scopes.map((x) => x.id)],
      );
      const src = r.source_id ? await sourceRow(db, r.source_id) : null;
      const population = scopes.reduce((n, x) => n + x.quantity, 0);
      const problem = [r.characteristic && `${r.characteristic}:`, r.expected && `required ${r.expected}`, r.actual && `actual ${r.actual}.`, r.defect_description, r.governing && `Governing requirement: ${r.governing}.`].filter(Boolean).join(' ');
      const fields: Record<string, string> = {
        ...(src ? sourceHeader(src) : await partySite(db, r.supplier_id, r.site_id, r.part_id)),
        project_ref: r.number,
        detected_date: d(r.confirmed_at),
        detected_by: r.reporter,
        detection_point: r.inspection_id ? 'Receiving' : '',
        defect_class: SEVERITY_CLASS[r.severity] ?? 'Unclassified',
        problem,
        scope: scopes.length ? scopes.map((x) => `${x.lot_number}: ${x.quantity} pcs${x.serial_numbers.length ? ` (${x.serial_numbers.join(', ')})` : ''}`).join('; ') : s(r.lot_number),
        population: population ? String(population) : '',
      };
      return {
        label: `${r.number} ${r.title}`,
        fields,
        schedules: {
          containment: scopes.map((x) => {
            const dec = decisions.filter((k) => k.scope_id === x.id);
            const last = dec[dec.length - 1];
            return {
              [ROW_KEY]: x.id,
              location: s(x.location) || 'PDI',
              lot: `${x.lot_number}${x.serial_numbers.length ? ` / ${x.serial_numbers.join(', ')}` : ''}`,
              quantity: String(x.quantity),
              hold: x.label,
              disposition: last ? (DISPOSITION[last.outcome] ?? 'Pending') : 'Pending',
              authority: s(last?.concession ?? last?.instructions),
            };
          }),
        },
      };
    }
    case 'SCAR': {
      if (!id) return null;
      const r = await one<{ number: string; title: string; problem_statement: string; requested_actions: string | null; supplier_id: string; site_id: string | null; source_id: string | null; part_id: string | null; response_due: string; owner: string; effectiveness_plan: string | null; sent_to: string }>(
        db,
        `SELECT s.number, s.title, s.problem_statement, s.requested_actions, s.supplier_id, s.site_id, s.source_id, s.part_id, s.response_due,
                u.display_name AS owner, s.effectiveness_plan, s.sent_to
           FROM scar s JOIN app_user u ON u.id = s.owner_id WHERE s.id = $1`,
        [id],
      );
      if (!r) return null;
      const src = r.source_id ? await sourceRow(db, r.source_id) : null;
      const ncrs = await many<{ number: string }>(db, `SELECT n.number FROM scar_ncr x JOIN ncr n ON n.id = x.ncr_id WHERE x.scar_id = $1 ORDER BY n.confirmed_at`, [id]);
      const fields: Record<string, string> = {
        ...(src ? sourceHeader(src) : await partySite(db, r.supplier_id, r.site_id, r.part_id)),
        project_ref: r.number,
        ncr_ref: ncrs.map((n) => n.number).join(', '),
        problem: r.problem_statement,
        supplier_owner: r.sent_to,
        pdi_owner: r.owner,
        response_due: d(r.response_due),
        effectiveness_plan: s(r.effectiveness_plan),
      };
      if (typeCode === 'OPS-08') Object.assign(fields, { problem_description: r.problem_statement, team: r.owner });
      // The supplier's latest response and PDI's verification of this cycle, as recorded in the SCAR.
      const resp = await one<{ representative: string; containment: string; root_cause: string; corrective_action: string; prevention: string | null; team: string | null }>(
        db,
        `SELECT representative, containment, root_cause, corrective_action, prevention, team FROM scar_response
          WHERE scar_id = $1 AND cycle = (SELECT cycle FROM scar WHERE id = $1) ORDER BY revision DESC LIMIT 1`,
        [id],
      );
      const verified = await many<{ kind: string; method: string; evidence: string; verifier: string; verified_on: string }>(
        db,
        `SELECT v.kind, v.method, v.evidence, u.display_name AS verifier, (v.verified_at AT TIME ZONE $2)::date::text AS verified_on
           FROM scar_verification v JOIN app_user u ON u.id = v.verified_by
          WHERE v.scar_id = $1 AND v.result = 'VERIFIED' AND v.cycle = (SELECT cycle FROM scar WHERE id = $1) ORDER BY v.verified_at`,
        [id, tz],
      );
      const effective = verified.find((v) => v.kind === 'EFFECTIVENESS');
      const implemented = verified.find((v) => v.kind === 'IMPLEMENTATION');
      const schedules: EntityContext['schedules'] = {};
      if (resp) {
        Object.assign(fields, { containment: resp.containment, ...(typeCode === 'OPS-08' && resp.team ? { team: resp.team } : {}) });
        schedules.verified_causes = [{ [ROW_KEY]: 'root_cause', cause: resp.root_cause }];
        const status = effective ? 'Verified' : implemented ? 'Done' : 'Open';
        const verifiedBy = effective ? `${effective.verifier} ${effective.verified_on}` : '';
        schedules.actions = [
          { [ROW_KEY]: 'corrective', action_id: 'CA-1', action: resp.corrective_action, owner: resp.representative, status, evidence: s(implemented?.evidence), verified_by: verifiedBy },
          ...(resp.prevention ? [{ [ROW_KEY]: 'preventive', action_id: 'PA-1', action: resp.prevention, owner: resp.representative, status, verified_by: verifiedBy }] : []),
        ];
      }
      if (effective) fields.actual_effectiveness = `${effective.method}: ${effective.evidence}`;
      return { label: `${r.number} ${r.title}`, fields, schedules };
    }
    default:
      return null;
  }
}

/** Keeps only values the template has a place for. */
export function fitToTemplate(schema: TemplateSchema, ctx: EntityContext, extra: Record<string, string>): RecordData {
  const fields: Record<string, string> = {};
  for (const f of schema.fields) {
    if (f.role !== 'ENTRY') continue;
    const v = extra[f.key] ?? ctx.fields[f.key];
    if (v === undefined || v === '') continue;
    if (f.input === 'choice' && !f.options?.includes(v)) continue;
    fields[f.key] = v;
  }
  const schedules: RecordData['schedules'] = {};
  for (const sc of schema.schedules) {
    const rows = ctx.schedules[sc.key];
    if (!rows) continue;
    schedules[sc.key] = rows.map((row) => {
      const out: Record<string, string> = row[ROW_KEY] ? { [ROW_KEY]: row[ROW_KEY] } : {};
      for (const c of sc.columns) {
        const v = row[c.key];
        if (v === undefined || v === '') continue;
        if (c.input === 'choice' && !c.options?.includes(v)) continue;
        out[c.key] = v;
      }
      return out;
    });
  }
  return { fields, schedules };
}
