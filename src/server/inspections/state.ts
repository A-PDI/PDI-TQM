import type { FormDefinition, ResponseStatus } from '../../shared/forms.js';
import {
  type EntryState,
  type Evaluation,
  type Outcome,
  activationId,
  evaluateInspection,
  readingId,
  rowId,
} from '../../shared/inspection.js';
import type { GoverningLimit } from '../../shared/measurement.js';
import { type Queryable, many, one } from '../db.js';
import { notFound } from '../errors.js';

export interface BaselineSnapshot {
  revisionId: string;
  baselineTitle: string;
  ownership: string;
  revisionLabel: string;
  synthetic: boolean;
  releasedAt: string;
  releasedBy: string;
  characteristics: Array<{
    charKey: string;
    name: string;
    formRowRef: string | null;
    unit: string | null;
    lower: string | null;
    upper: string | null;
    nominal: string | null;
    limitText: string | null;
    method: string | null;
  }>;
}

export interface InspectionRow {
  id: string;
  number: string;
  form_revision_id: string;
  form_snapshot: FormDefinition;
  form_snapshot_sha256: string;
  form_revision_sequence: number;
  baseline_revision_id: string | null;
  baseline_snapshot: BaselineSnapshot | null;
  part_id: string | null;
  part_number: string;
  part_description: string;
  source_id: string | null;
  supplier_id: string | null;
  supplier_name: string | null;
  site_id: string | null;
  site_name: string | null;
  source_state_at_start: string;
  po_number: string | null;
  date_received: string;
  lot_number: string | null;
  lot_size: number | null;
  sampling_note: string | null;
  unit_count: number;
  inspector_id: string;
  inspector_name: string;
  created_at: Date;
  status: 'DRAFT' | 'PARTIAL' | 'READY_FOR_REVIEW' | 'COMPLETED' | 'VOID';
  outcome: Outcome | null;
  review_reasons: unknown;
  submitted_at: Date | null;
  completed_at: Date | null;
  completed_by: string | null;
  completed_by_name: string | null;
  amendment_count: number;
  version: number;
  updated_at: Date;
}

export interface PhotoRow {
  link_id: string;
  file_id: string;
  unit_index: number | null;
  section_key: string | null;
  row_key: string | null;
  caption: string | null;
  mime_type: string;
  sha256: string;
  storage_key: string;
  width: number | null;
  height: number | null;
  byte_size: string;
  original_name: string | null;
  linked_at: Date;
  linked_by_name: string;
}

export interface LoadedInspection {
  row: InspectionRow;
  units: Array<{ unit_index: number; serial_number: string | null; disposition_note: string | null }>;
  activated: string[];
  responses: Record<string, { status: ResponseStatus | null; note: string | null; amendmentNo: number }>;
  readings: Record<string, { text: string; amendmentNo: number }>;
  photos: PhotoRow[];
  limits: Record<string, GoverningLimit>;
  entry: EntryState;
  evaluation: Evaluation;
  effectiveOutcome: Outcome | null;
}

export function limitsFromBaseline(snapshot: BaselineSnapshot | null): Record<string, GoverningLimit> {
  const limits: Record<string, GoverningLimit> = {};
  if (!snapshot) return limits;
  for (const c of snapshot.characteristics) {
    if (!c.formRowRef || !c.unit || (c.lower === null && c.upper === null)) continue;
    limits[c.formRowRef] = {
      charKey: c.charKey,
      name: c.name,
      unit: c.unit,
      lower: c.lower,
      upper: c.upper,
      baselineRevision: snapshot.revisionLabel,
      synthetic: snapshot.synthetic,
    };
  }
  return limits;
}

export async function loadInspection(db: Queryable, id: string, opts: { lock?: boolean } = {}): Promise<LoadedInspection> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Inspection');
  if (opts.lock) await db.query('SELECT 1 FROM inspection WHERE id = $1 FOR UPDATE', [id]);
  const row = await one<InspectionRow>(
    db,
    `SELECT i.*, fr.sequence AS form_revision_sequence, u.display_name AS inspector_name,
            s.legal_name AS supplier_name, ss.name AS site_name, cu.display_name AS completed_by_name
       FROM inspection i
       JOIN form_revision fr ON fr.id = i.form_revision_id
       JOIN app_user u ON u.id = i.inspector_id
       LEFT JOIN supplier s ON s.id = i.supplier_id
       LEFT JOIN supplier_site ss ON ss.id = i.site_id
       LEFT JOIN app_user cu ON cu.id = i.completed_by
      WHERE i.id = $1`,
    [id],
  );
  if (!row) throw notFound('Inspection');

  const [units, activations, responseRows, measurementRows, photos, amendments] = await Promise.all([
    many<LoadedInspection['units'][number]>(
      db,
      'SELECT unit_index, serial_number, disposition_note FROM inspection_unit WHERE inspection_id = $1 ORDER BY unit_index',
      [id],
    ),
    many<{ unit_index: number; section_key: string }>(
      db,
      'SELECT unit_index, section_key FROM inspection_section_activation WHERE inspection_id = $1',
      [id],
    ),
    many<{ unit_index: number; section_key: string; row_key: string; status: ResponseStatus | null; note: string | null; amendment_no: number }>(
      db,
      `SELECT DISTINCT ON (unit_index, section_key, row_key) unit_index, section_key, row_key, status, note, amendment_no
         FROM inspection_response WHERE inspection_id = $1
        ORDER BY unit_index, section_key, row_key, amendment_no DESC`,
      [id],
    ),
    many<{ unit_index: number; section_key: string; row_key: string; reading_key: string; value_text: string | null; amendment_no: number }>(
      db,
      `SELECT DISTINCT ON (unit_index, section_key, row_key, reading_key)
              unit_index, section_key, row_key, reading_key, value_text, amendment_no
         FROM inspection_measurement WHERE inspection_id = $1
        ORDER BY unit_index, section_key, row_key, reading_key, amendment_no DESC`,
      [id],
    ),
    many<PhotoRow>(
      db,
      `SELECT l.id AS link_id, f.id AS file_id, l.unit_index, l.section_key, l.row_key, l.caption, f.mime_type, f.sha256,
              f.storage_key, f.width, f.height, f.byte_size, f.original_name, l.linked_at, u.display_name AS linked_by_name
         FROM evidence_link l JOIN file_object f ON f.id = l.file_id JOIN app_user u ON u.id = l.linked_by
        WHERE l.inspection_id = $1 AND l.entity_type = 'INSPECTION' AND l.unlinked_at IS NULL AND f.status = 'AVAILABLE'
        ORDER BY l.linked_at, l.id`,
      [id],
    ),
    many<{ resulting_outcome: Outcome }>(
      db,
      'SELECT resulting_outcome FROM inspection_amendment WHERE inspection_id = $1 ORDER BY amendment_no DESC LIMIT 1',
      [id],
    ),
  ]);

  const responses: LoadedInspection['responses'] = {};
  for (const r of responseRows) {
    responses[rowId(r.unit_index, r.section_key, r.row_key)] = { status: r.status, note: r.note, amendmentNo: r.amendment_no };
  }
  const readings: LoadedInspection['readings'] = {};
  for (const m of measurementRows) {
    if (m.value_text === null) continue;
    readings[readingId(m.unit_index, m.section_key, m.row_key, m.reading_key)] = { text: m.value_text, amendmentNo: m.amendment_no };
  }
  const photoCounts: Record<string, number> = {};
  for (const p of photos) {
    if (p.section_key && p.row_key && p.unit_index !== null) {
      const key = rowId(p.unit_index, p.section_key, p.row_key);
      photoCounts[key] = (photoCounts[key] ?? 0) + 1;
    }
  }
  const activated = activations.map((a) => activationId(a.unit_index, a.section_key));
  const entry: EntryState = {
    responses: Object.fromEntries(Object.entries(responses).map(([k, v]) => [k, { status: v.status, note: v.note }])),
    readings: Object.fromEntries(Object.entries(readings).map(([k, v]) => [k, v.text])),
    photoCounts,
    activated,
  };
  const limits = limitsFromBaseline(row.baseline_snapshot);
  const evaluation = evaluateInspection({ definition: row.form_snapshot, unitCount: row.unit_count, limits }, entry);
  const effectiveOutcome = amendments[0]?.resulting_outcome ?? row.outcome;
  return { row, units, activated, responses, readings, photos, limits, entry, evaluation, effectiveOutcome };
}
