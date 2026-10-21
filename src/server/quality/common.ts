import { createHash } from 'node:crypto';
import { z } from 'zod';
import { canonicalJson } from '../../shared/forms.js';
import type { Capability } from '../../shared/capabilities.js';
import { activeCapabilities } from '../auth.js';
import { type Queryable, many, one } from '../db.js';
import { enqueueJob } from '../jobs.js';
import type { RecordReportSnapshot } from '../pdf/record-report.js';

export const uuid = z.string().uuid();
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Opens a unified work item unless the same open item already exists. */
export async function openWork(
  db: Queryable,
  w: { kind: string; title: string; subjectType: string; subjectId: string; assigneeId?: string | null; capability?: Capability | null; dueAt?: string | null },
): Promise<void> {
  await db.query(
    `INSERT INTO work_item (kind, title, subject_type, subject_id, assignee_id, required_capability, due_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (kind, subject_type, subject_id) WHERE status = 'OPEN' DO NOTHING`,
    [w.kind, w.title.slice(0, 200), w.subjectType, w.subjectId, w.assigneeId ?? null, w.capability ?? null, w.dueAt ?? null],
  );
}

/** Closes open work items for a subject; only domain actions call this (no generic "done" endpoint, NEG-18). */
export async function closeWork(db: Queryable, kinds: string[], subjectType: string, subjectId: string, actorId: string | null, reason: string): Promise<void> {
  await db.query(
    `UPDATE work_item SET status = 'DONE', closed_at = now(), closed_by = $4, closed_reason = $5
      WHERE subject_type = $2 AND subject_id = $3 AND kind = ANY($1::text[]) AND status = 'OPEN'`,
    [kinds, subjectType, subjectId, actorId, reason.slice(0, 500)],
  );
}

export async function history(db: Queryable, entityType: string, entityIds: string[]) {
  return many(
    db,
    `SELECT a.occurred_at AS "occurredAt", a.action, a.outcome, a.summary, a.reason, u.display_name AS actor
       FROM audit_event a LEFT JOIN app_user u ON u.id = a.actor_id
      WHERE a.entity_type = $1 AND a.entity_id = ANY($2::text[]) ORDER BY a.id`,
    [entityType, entityIds],
  );
}

export async function linkedFiles(db: Queryable, entityType: string, entityId: string) {
  return many<{ linkId: string; fileId: string; name: string | null; mimeType: string; sha256: string; caption: string | null; linkedAt: Date }>(
    db,
    `SELECT l.id AS "linkId", f.id AS "fileId", f.original_name AS name, f.mime_type AS "mimeType", f.sha256, l.caption, l.linked_at AS "linkedAt"
       FROM evidence_link l JOIN file_object f ON f.id = l.file_id
      WHERE l.entity_type = $1 AND l.entity_id = $2 AND l.unlinked_at IS NULL AND f.status = 'AVAILABLE' ORDER BY l.linked_at`,
    [entityType, entityId],
  );
}

export async function renditions(db: Queryable, subjectType: string, subjectId: string) {
  return many<{ edition: number; fileId: string | null; sha256: string | null; pageCount: number | null; createdAt: Date }>(
    db,
    `SELECT s.edition, r.file_id AS "fileId", r.sha256, r.page_count AS "pageCount", s.created_at AS "createdAt"
       FROM report_snapshot s LEFT JOIN report_rendition r ON r.snapshot_id = s.id
      WHERE s.subject_type = $1 AND s.subject_id = $2 ORDER BY s.edition`,
    [subjectType, subjectId],
  );
}

/** Freezes a controlled-record snapshot as the next numbered edition and queues its PDF. */
export async function issueRecordEdition(
  db: Queryable,
  subjectType: string,
  subjectId: string,
  build: (edition: number) => RecordReportSnapshot,
): Promise<{ edition: number; snapshotId: string }> {
  const prior = await one<{ max: number | null }>(db, 'SELECT max(edition) AS max FROM report_snapshot WHERE subject_type = $1 AND subject_id = $2', [
    subjectType,
    subjectId,
  ]);
  const edition = (prior?.max ?? 0) + 1;
  const snapshot = build(edition);
  const snap = await one<{ id: string }>(
    db,
    `INSERT INTO report_snapshot (subject_type, subject_id, edition, snapshot, sha256) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [subjectType, subjectId, edition, JSON.stringify(snapshot), createHash('sha256').update(canonicalJson(snapshot)).digest('hex')],
  );
  await enqueueJob(db, 'record_report', `record_report:${snap!.id}`, { snapshotId: snap!.id });
  return { edition, snapshotId: snap!.id };
}

export const userName = async (db: Queryable, id: string | null) =>
  id ? ((await one<{ display_name: string }>(db, 'SELECT display_name FROM app_user WHERE id = $1', [id]))?.display_name ?? '—') : '—';

/** True when the person exists, is active and (optionally) currently holds the capability. */
export async function isActiveUser(db: Queryable, id: string, cap?: Capability): Promise<boolean> {
  const user = await one(db, 'SELECT 1 FROM app_user WHERE id = $1 AND active', [id]);
  if (!user) return false;
  return cap ? (await activeCapabilities(db, id)).has(cap) : true;
}
