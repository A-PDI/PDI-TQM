import { createHash } from 'node:crypto';
import { type FormSection, type SectionPattern, canonicalJson, readingLimitRef, sectionRows, sectionTitle } from '../../shared/forms.js';
import { type Outcome, activationId, readingId, rowId } from '../../shared/inspection.js';
import { formatLimit } from '../../shared/measurement.js';
import type { LoadedInspection } from './state.js';

export interface ReportReading {
  label: string;
  value: string | null;
  outside: boolean;
}

export interface ReportRow {
  key: string;
  label: string;
  criterion: string | null;
  location: string | null;
  spec: string | null;
  specReleased: boolean;
  status: 'P' | 'F' | 'A' | 'N' | null;
  note: string | null;
  readings: ReportReading[];
  photoNumbers: number[];
  valves?: Array<{ label: string; status: 'P' | 'F' | 'A' | 'N' | null }>;
}

export interface ReportSection {
  key: string;
  title: string;
  pattern: SectionPattern;
  readingLabels: string[];
  limitSummary: string | null;
  rows: ReportRow[];
}

export interface ReportPhoto {
  number: number;
  fileId: string;
  sha256: string;
  storageKey: string;
  mime: string;
  caption: string;
  context: string;
}

export interface InspectionReportSnapshot {
  kind: 'INSPECTION_REPORT';
  schemaVersion: 1;
  edition: number;
  draft: boolean;
  displayTimeZone: string;
  generatedAt: string;
  inspection: {
    number: string;
    status: string;
    outcome: Outcome | null;
    partNumber: string;
    partDescription: string;
    poNumber: string | null;
    dateReceived: string;
    lotNumber: string | null;
    lotSize: number | null;
    samplingNote: string | null;
    unitCount: number;
    inspector: string;
    supplier: string | null;
    site: string | null;
    sourceState: string;
    startedAt: string;
    completedAt: string | null;
  };
  form: { formNumber: string; component: string; revisionLabel: string | null; sha256: string };
  baseline: { title: string; revisionLabel: string; synthetic: boolean } | null;
  review: { decision: string; reviewer: string; reviewedAt: string; comment: string | null; reasons: string[] } | null;
  amendment: { number: number; reason: string; by: string; at: string } | null;
  shared: ReportSection[];
  units: Array<{ unitIndex: number; serial: string | null; outcome: Outcome | null; dispositionNote: string | null; sections: ReportSection[] }>;
  photos: ReportPhoto[];
}

export interface SnapshotExtras {
  edition: number;
  draft: boolean;
  displayTimeZone: string;
  generatedAt: Date;
  review: InspectionReportSnapshot['review'];
  amendment: InspectionReportSnapshot['amendment'];
  outcome: Outcome | null;
}

function limitSummary(section: FormSection, state: LoadedInspection): string | null {
  if (section.pattern !== 'valve_recession') return null;
  const intake = state.limits['valve_recession:intake'];
  const exhaust = state.limits['valve_recession:exhaust'];
  const fmt = (l: typeof intake) => (l ? formatLimit(l) : 'not released');
  return `Intake limit: ${fmt(intake)} · Exhaust limit: ${fmt(exhaust)}`;
}

export function buildReportSnapshot(state: LoadedInspection, extras: SnapshotExtras): InspectionReportSnapshot {
  const { row } = state;
  const def = row.form_snapshot;
  const photos: ReportPhoto[] = [];
  const photoNumber = new Map<string, number>();
  const sectionByKey = new Map(def.sections.map((s) => [s.key, s]));

  // Number photographs in report order: shared section, then units, then general.
  const ordered = [...state.photos].sort((a, b) => {
    const ua = a.unit_index ?? 999;
    const ub = b.unit_index ?? 999;
    if (ua !== ub) return ua - ub;
    const sa = a.section_key ? def.sections.findIndex((s) => s.key === a.section_key) : 999;
    const sb = b.section_key ? def.sections.findIndex((s) => s.key === b.section_key) : 999;
    if (sa !== sb) return sa - sb;
    return a.linked_at.getTime() - b.linked_at.getTime();
  });
  for (const p of ordered) {
    const n = photos.length + 1;
    photoNumber.set(p.link_id, n);
    const section = p.section_key ? sectionByKey.get(p.section_key) : undefined;
    const answer = section ? sectionRows(section).find((r) => r.key === p.row_key) : undefined;
    const unit = p.unit_index === null ? 'General' : p.unit_index === 0 ? 'Receiving' : `Item ${p.unit_index}`;
    photos.push({
      number: n,
      fileId: p.file_id,
      sha256: p.sha256,
      storageKey: p.storage_key,
      mime: p.mime_type,
      caption: p.caption ?? '',
      context: [unit, section ? sectionTitle(section) : null, answer?.label].filter(Boolean).join(' · '),
    });
  }

  const buildSection = (section: FormSection, unitIndex: number): ReportSection => {
    const answerRows = sectionRows(section);
    const rows: ReportRow[] = [];
    for (const ar of answerRows) {
      if (ar.parentKey) continue;
      const id = rowId(unitIndex, section.key, ar.key);
      const response = state.responses[id];
      const rowLimitRef = ar.limitRef && ar.limitRef !== 'valve_recession' ? ar.limitRef : null;
      const limit = rowLimitRef ? state.limits[rowLimitRef] : undefined;
      const readings: ReportReading[] = ar.readingKeys.map((rk, i) => {
        const text = state.readings[readingId(unitIndex, section.key, ar.key, rk)]?.text ?? null;
        const ref = readingLimitRef(ar, rk);
        const evalResult = state.evaluation.rows[id]?.readingResults[rk];
        return { label: ar.readingLabels[i] ?? rk, value: text, outside: Boolean(ref) && evalResult === 'OUTSIDE' };
      });
      let spec: string | null = null;
      let specReleased = false;
      if (ar.readingKeys.length > 0) {
        if (section.pattern === 'valve_recession') {
          specReleased = Boolean(state.limits['valve_recession:intake'] && state.limits['valve_recession:exhaust']);
        } else if (limit) {
          spec = formatLimit(limit);
          specReleased = true;
        } else {
          spec = ar.source?.specText ? `${ar.source.specText} (reference text)` : null;
        }
      }
      const photoNumbers = state.photos
        .filter((p) => p.unit_index === unitIndex && p.section_key === section.key && p.row_key === ar.key)
        .map((p) => photoNumber.get(p.link_id)!)
        .sort((a, b) => a - b);
      const out: ReportRow = {
        key: ar.key,
        label: ar.label,
        criterion: ar.source?.acceptance ?? null,
        location: ar.source?.location ?? null,
        spec,
        specReleased,
        status: response?.status ?? null,
        note: response?.note ?? null,
        readings,
        photoNumbers,
      };
      if (section.pattern === 'vacuum_test') {
        out.valves = answerRows
          .filter((v) => v.parentKey === ar.key)
          .map((v) => ({ label: v.label.split('—').pop()!.trim(), status: state.responses[rowId(unitIndex, section.key, v.key)]?.status ?? null }));
      }
      rows.push(out);
    }
    return {
      key: section.key,
      title: sectionTitle(section),
      pattern: section.pattern,
      readingLabels: answerRows.find((r) => !r.parentKey)?.readingLabels ?? [],
      limitSummary: limitSummary(section, state),
      rows,
    };
  };

  const activated = new Set(state.activated);
  const shared = def.sections.filter((s) => s.scope === 'inspection').map((s) => buildSection(s, 0));
  const units = Array.from({ length: row.unit_count }, (_, i) => i + 1).map((unitIndex) => {
    const unit = state.units.find((u) => u.unit_index === unitIndex);
    return {
      unitIndex,
      serial: unit?.serial_number ?? null,
      outcome: state.evaluation.unitOutcomes[unitIndex] ?? null,
      dispositionNote: unit?.disposition_note ?? null,
      sections: def.sections
        .filter((s) => s.scope === 'unit' && (!s.optional || activated.has(activationId(unitIndex, s.key))))
        .map((s) => buildSection(s, unitIndex)),
    };
  });

  return {
    kind: 'INSPECTION_REPORT',
    schemaVersion: 1,
    edition: extras.edition,
    draft: extras.draft,
    displayTimeZone: extras.displayTimeZone,
    generatedAt: extras.generatedAt.toISOString(),
    inspection: {
      number: row.number,
      status: row.status,
      outcome: extras.outcome,
      partNumber: row.part_number,
      partDescription: row.part_description,
      poNumber: row.po_number,
      dateReceived: row.date_received,
      lotNumber: row.lot_number,
      lotSize: row.lot_size,
      samplingNote: row.sampling_note,
      unitCount: row.unit_count,
      inspector: row.inspector_name,
      supplier: row.supplier_name,
      site: row.site_name,
      sourceState: row.source_state_at_start,
      startedAt: row.created_at.toISOString(),
      completedAt: row.completed_at ? row.completed_at.toISOString() : null,
    },
    form: { formNumber: def.formNumber, component: def.component, revisionLabel: def.revisionLabel, sha256: row.form_snapshot_sha256 },
    baseline: row.baseline_snapshot
      ? { title: row.baseline_snapshot.baselineTitle, revisionLabel: row.baseline_snapshot.revisionLabel, synthetic: row.baseline_snapshot.synthetic }
      : null,
    review: extras.review,
    amendment: extras.amendment,
    shared,
    units,
    photos,
  };
}

export function snapshotHash(snapshot: unknown): string {
  return createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
}
