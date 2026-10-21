import { audit } from '../audit.js';
import { one, withTransaction } from '../db.js';
import { type JobRow, PermanentJobError } from '../jobs.js';
import { renderInspectionReport } from '../pdf/inspection-report.js';
import type { Services } from '../services.js';
import { type InspectionReportSnapshot, snapshotHash } from './report-snapshot.js';

export async function loadPhotoBytes(svc: Services, snapshot: InspectionReportSnapshot): Promise<Map<string, Buffer>> {
  const bytes = new Map<string, Buffer>();
  for (const p of snapshot.photos) {
    // Hash-verified: a corrupted or substituted evidence object fails the job visibly.
    bytes.set(p.fileId, await svc.storage.readVerified(p.storageKey, p.sha256));
  }
  return bytes;
}

/** Renders one frozen report snapshot into an immutable PDF edition. Idempotent per snapshot. */
export function inspectionReportHandler(svc: Services) {
  return async (job: JobRow) => {
    const snapshotId = String(job.payload.snapshotId ?? '');
    const snap = await one<{ id: string; subject_id: string; edition: number; snapshot: InspectionReportSnapshot; sha256: string }>(
      svc.db,
      'SELECT id, subject_id, edition, snapshot, sha256 FROM report_snapshot WHERE id = $1',
      [snapshotId],
    );
    if (!snap) throw new PermanentJobError(`Report snapshot ${snapshotId} not found`);
    const existing = await one(svc.db, 'SELECT 1 FROM report_rendition WHERE snapshot_id = $1', [snap.id]);
    if (existing) return;
    if (snapshotHash(snap.snapshot) !== snap.sha256) {
      throw new PermanentJobError('Report snapshot failed integrity verification');
    }
    const photoBytes = await loadPhotoBytes(svc, snap.snapshot);
    const { bytes, pageCount } = await renderInspectionReport({ snapshot: snap.snapshot, logo: svc.logo, photoBytes });
    const staged = await svc.storage.stageBuffer(bytes);
    const storageKey = await svc.storage.finalize(staged);
    try {
      await withTransaction(svc.db, async (tx) => {
        const file = await one<{ id: string }>(
          tx,
          `INSERT INTO file_object (kind, status, sha256, byte_size, mime_type, original_name, storage_key)
           VALUES ('REPORT', 'AVAILABLE', $1, $2, 'application/pdf', $3, $4) RETURNING id`,
          [staged.sha256, staged.size, `${snap.snapshot.inspection.number}-E${snap.edition}.pdf`, storageKey],
        );
        await tx.query(
          `INSERT INTO report_rendition (snapshot_id, subject_type, subject_id, edition, file_id, sha256, page_count)
           VALUES ($1, 'INSPECTION', $2, $3, $4, $5, $6)`,
          [snap.id, snap.subject_id, snap.edition, file!.id, staged.sha256, pageCount],
        );
        await audit(tx, {
          actorId: null,
          action: 'report.render',
          entityType: 'inspection',
          entityId: snap.subject_id,
          summary: `Rendered ${snap.snapshot.inspection.number} edition ${snap.edition} (${pageCount} pages)`,
          after: { sha256: staged.sha256, snapshotSha256: snap.sha256 },
        });
      });
    } catch (err) {
      await svc.storage.removeOrphan(storageKey);
      const again = await one(svc.db, 'SELECT 1 FROM report_rendition WHERE snapshot_id = $1', [snap.id]);
      if (again) return; // another worker finished the same edition
      throw err;
    }
  };
}
