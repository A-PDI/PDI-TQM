import type { GateResult } from '../../shared/sourcing.js';
import { audit } from '../audit.js';
import { one, withTransaction } from '../db.js';
import { type JobRow, PermanentJobError } from '../jobs.js';
import { type RecordReportSnapshot, renderRecordReport } from '../pdf/record-report.js';
import { formatDateTime } from '../pdf/text.js';
import type { Services } from '../services.js';
import { snapshotHash } from '../inspections/report-snapshot.js';
import type { GateContext } from './gates.js';

interface Manifest {
  source: GateContext['source'];
  governingRevision: (NonNullable<GateContext['revision']> & { characteristics: GateContext['characteristics']; contentSha256: string }) | null;
  baseRevision: GateContext['baseRevision'];
  siteQualification: GateContext['siteQualification'];
  acknowledgment: GateContext['acknowledgment'];
  firstArticles: GateContext['fais'];
  risk: GateContext['risk'];
  sourcingRequest: GateContext['request'];
  evidence: GateContext['requirements'];
  policies: Record<string, string>;
}

const d = (v: unknown) => (v ? String(v instanceof Date ? v.toISOString() : v).slice(0, 10) : '—');

/** Product & Supplier Approval Record (Appendix B VAL-11) built from the frozen decision manifest. */
export function buildApprovalReportSnapshot(input: {
  number: string;
  decision: string;
  scope: string;
  conditions: string | null;
  validUntil: string | null;
  rationale: string;
  approver: string;
  decidedAt: string;
  gates: GateResult[];
  manifest: Manifest;
  manifestSha256: string;
  displayTimeZone: string;
}): RecordReportSnapshot {
  const m = input.manifest;
  const s = m.source;
  const rev = m.governingRevision;
  return {
    kind: 'RECORD_REPORT',
    schemaVersion: 1,
    title: 'Product & Supplier Approval Record',
    docCode: 'VAL-11',
    number: input.number,
    edition: 1,
    generatedAt: input.decidedAt,
    displayTimeZone: input.displayTimeZone,
    outcome: {
      label: `DECISION: ${input.decision.replaceAll('_', ' ')}`,
      tone: input.decision === 'APPROVED' ? 'good' : input.decision === 'REJECTED' ? 'bad' : 'warn',
      note: 'Authorizes only this exact part / supplier / site / supplier part / configuration / revision within the stated scope. Not a lot release.',
    },
    meta: [
      ['Company part', `${s.part_number} — ${s.part_description}`],
      ['Decision no.', input.number],
      ['Supplier', s.supplier_name],
      ['Manufacturing site', s.site_name],
      ['Supplier part', s.supplier_part_number],
      ['Configuration', s.configuration],
      ['Sourcing path', s.pathway],
      ['Governing revision', rev ? `${rev.title} Rev ${rev.revision_label}` : '—'],
      ['Approver', input.approver],
      ['Decided', formatDateTime(input.decidedAt, input.displayTimeZone)],
      ['Valid until', input.validUntil ?? 'Until changed or revoked'],
      ['Sourcing request', m.sourcingRequest?.number ?? '—'],
    ],
    sections: [
      {
        title: 'SCOPE, CONDITIONS AND RATIONALE',
        kind: 'text',
        paragraphs: [`Scope: ${input.scope}`, ...(input.conditions ? [`Conditions: ${input.conditions}`] : []), `Rationale: ${input.rationale}`],
      },
      {
        title: 'APPROVAL GATES EVALUATED AT DECISION TIME',
        kind: 'table',
        columns: [
          { header: 'Gate', width: 0.36 },
          { header: 'Result', width: 0.12 },
          { header: 'Evidence / detail', width: 0.52 },
        ],
        rows: input.gates.map((g) => [g.label, g.status === 'NOT_APPLICABLE' ? 'N/A' : g.status, g.detail]),
      },
      {
        title: `GOVERNING TECHNICAL BASELINE${rev ? ` — ${rev.title} REV ${rev.revision_label}` : ''}`,
        kind: 'table',
        columns: [
          { header: 'Characteristic', width: 0.34 },
          { header: 'Type', width: 0.14 },
          { header: 'Limit', width: 0.32 },
          { header: 'PDI delta', width: 0.2 },
        ],
        rows: (rev?.characteristics ?? []).map((c) => [
          c.name,
          c.char_type.toLowerCase(),
          c.lower_limit !== null || c.upper_limit !== null ? `${c.lower_limit ?? '—'} – ${c.upper_limit ?? '—'} ${c.unit ?? ''}` : (c.limit_text ?? 'Criterion per document'),
          c.is_delta ? 'Yes' : '',
        ]),
      },
      {
        title: 'QUALIFICATION, ACKNOWLEDGMENT AND RISK',
        kind: 'table',
        columns: [
          { header: 'Record', width: 0.3 },
          { header: 'Status', width: 0.25 },
          { header: 'Detail', width: 0.45 },
        ],
        rows: [
          ['Site qualification', m.siteQualification.status, `${m.siteQualification.number ?? '—'}${m.siteQualification.validUntil ? `, valid until ${m.siteQualification.validUntil}` : ''}`],
          m.acknowledgment
            ? ['Supplier acknowledgment', m.acknowledgment.response, `Rev ${m.acknowledgment.revision_label} by ${m.acknowledgment.representative ?? '—'} on ${d(m.acknowledgment.responded_at)}`]
            : ['Supplier acknowledgment', 'N/A', 'Not required for this path and risk'],
          m.baseRevision ? ['Supplier base revision', m.baseRevision.status, `${m.baseRevision.title} Rev ${m.baseRevision.revision_label}`] : ['Supplier base revision', 'N/A', '—'],
          m.risk ? ['Risk assessment', m.risk.result, `Score ${m.risk.score}; ${m.risk.rule_version}`] : ['Risk assessment', 'FAIL', 'Not assessed'],
        ],
      },
      {
        title: 'FIRST ARTICLE / VALIDATION HISTORY (INCLUDING REJECTED SAMPLES)',
        kind: 'table',
        columns: [
          { header: 'Sample', width: 0.16 },
          { header: 'Type', width: 0.17 },
          { header: 'Decision', width: 0.14 },
          { header: 'Defects / conditions / corrective rationale', width: 0.53 },
        ],
        rows: m.firstArticles.map((f) => [
          f.number,
          f.sample_type.replaceAll('_', ' ').toLowerCase().replace(/\bfai\b/, 'FAI'),
          f.decision ?? 'OPEN',
          [f.defects && `Defects: ${f.defects}`, f.conditions && `Conditions: ${f.conditions}`, f.corrective_rationale && `Correction: ${f.corrective_rationale}`, f.decided_by_name && `Decided by ${f.decided_by_name} ${d(f.decided_at)}`]
            .filter(Boolean)
            .join(' · '),
        ]),
      },
      {
        title: 'EVIDENCE PACKAGE (EXACT FILES)',
        kind: 'table',
        columns: [
          { header: 'Item', width: 0.32 },
          { header: 'Applicability', width: 0.14 },
          { header: 'Status', width: 0.12 },
          { header: 'Files (SHA-256 prefix) / waiver reason', width: 0.42 },
        ],
        rows: m.evidence
          .filter((e) => e.applicability !== 'NOT_APPLICABLE')
          .map((e) => [
            `${e.code} ${e.title}`,
            e.applicability.toLowerCase(),
            e.status,
            e.status === 'WAIVED' ? `Waived: ${e.waiver_reason}` : e.files.map((f) => `${f.name} (${f.sha256.slice(0, 12)})`).join(', ') || '—',
          ]),
      },
      {
        title: 'FROZEN MANIFEST',
        kind: 'text',
        paragraphs: [
          `Manifest SHA-256: ${input.manifestSha256}`,
          `Governing characteristics SHA-256: ${rev?.contentSha256 ?? '—'}`,
          `Rules applied: ${Object.values(m.policies).join('; ')}.`,
          'Later edits, suspensions or new revisions do not change this record; dynamic restrictions are shown on the live source status.',
        ],
      },
    ],
  };
}

export function recordReportHandler(svc: Services) {
  return async (job: JobRow) => {
    const snapshotId = String(job.payload.snapshotId ?? '');
    const snap = await one<{ id: string; subject_type: string; subject_id: string; edition: number; snapshot: RecordReportSnapshot; sha256: string }>(
      svc.db,
      'SELECT id, subject_type, subject_id, edition, snapshot, sha256 FROM report_snapshot WHERE id = $1',
      [snapshotId],
    );
    if (!snap) throw new PermanentJobError(`Report snapshot ${snapshotId} not found`);
    if (await one(svc.db, 'SELECT 1 FROM report_rendition WHERE snapshot_id = $1', [snap.id])) return;
    if (snapshotHash(snap.snapshot) !== snap.sha256) throw new PermanentJobError('Report snapshot failed integrity verification');
    const { bytes, pageCount } = await renderRecordReport(snap.snapshot, svc.logo);
    const staged = await svc.storage.stageBuffer(bytes);
    const storageKey = await svc.storage.finalize(staged);
    try {
      await withTransaction(svc.db, async (tx) => {
        const file = await one<{ id: string }>(
          tx,
          `INSERT INTO file_object (kind, status, sha256, byte_size, mime_type, original_name, storage_key) VALUES ('REPORT','AVAILABLE',$1,$2,'application/pdf',$3,$4) RETURNING id`,
          [staged.sha256, staged.size, `${snap.snapshot.number}-E${snap.edition}.pdf`, storageKey],
        );
        await tx.query(
          `INSERT INTO report_rendition (snapshot_id, subject_type, subject_id, edition, file_id, sha256, page_count) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [snap.id, snap.subject_type, snap.subject_id, snap.edition, file!.id, staged.sha256, pageCount],
        );
        await audit(tx, {
          actorId: null,
          action: 'report.render',
          entityType: snap.subject_type.toLowerCase(),
          entityId: snap.subject_id,
          summary: `Rendered ${snap.snapshot.docCode} ${snap.snapshot.number} edition ${snap.edition} (${pageCount} pages)`,
          after: { sha256: staged.sha256 },
        });
      });
    } catch (err) {
      await svc.storage.removeOrphan(storageKey);
      if (await one(svc.db, 'SELECT 1 FROM report_rendition WHERE snapshot_id = $1', [snap.id])) return;
      throw err;
    }
  };
}
