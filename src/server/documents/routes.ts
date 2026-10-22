import { readFile } from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { DOCUMENT_USAGE, FILENAME_RULE, type ParsedDocumentName, parseDocumentFilename } from '../../shared/documents.js';
import { RECORD_TYPES } from '../../shared/sourcing.js';
import { audit } from '../audit.js';
import { requireCapability } from '../auth.js';
import { type Queryable, many, one, withTransaction } from '../db.js';
import { AppError, badRequest, conflict, notFound, unprocessable } from '../errors.js';
import { sanitizeFilename, validateDocument } from '../file-validation.js';
import type { Services } from '../services.js';
import { FileTooLargeError, type StagedFile } from '../storage.js';

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date in YYYY-MM-DD form');
const revisionLabel = z.string().trim().regex(/^[0-9A-Za-z]{1,6}$/, 'Revision is 1–6 letters or digits, e.g. 04');

type RevisionStatus = 'CURRENT' | 'PENDING' | 'SUPERSEDED';

interface RevisionRow {
  id: string;
  revisionLabel: string;
  effectiveFrom: string;
  changeSummary: string;
  fileId: string;
  sha256: string;
  byteSize: number;
  originalName: string | null;
  releasedBy: string;
  releasedAt: string;
}

async function today(db: Queryable, tz: string): Promise<string> {
  return (await one<{ d: string }>(db, `SELECT (now() AT TIME ZONE $1)::date AS d`, [tz]))!.d;
}

/** Newest first; the first revision already in effect is current, later-dated ones are pending, older ones superseded. */
function withStatus(revisions: RevisionRow[], asOf: string): Array<RevisionRow & { status: RevisionStatus }> {
  let currentSeen = false;
  return revisions.map((r) => {
    if (r.effectiveFrom > asOf) return { ...r, status: 'PENDING' as const };
    if (!currentSeen) {
      currentSeen = true;
      return { ...r, status: 'CURRENT' as const };
    }
    return { ...r, status: 'SUPERSEDED' as const };
  });
}

export function registerControlledDocumentRoutes(app: FastifyInstance, svc: Services) {
  const { db, storage, config } = svc;

  app.get('/api/documents', async (req) => {
    await requireCapability(db, req, 'records.read', { action: 'documents.list', consequential: false });
    const asOf = await today(db, config.displayTimeZone);
    const rows = await many(
      db,
      `SELECT d.id, d.number, d.type_code AS "typeCode", d.family, d.kind, d.title, d.owner_role AS "ownerRole",
              cur.revision_label AS "currentRevision", cur.effective_from AS "currentEffective", cur.file_id AS "currentFileId",
              nxt.revision_label AS "pendingRevision", nxt.effective_from AS "pendingEffective", nxt.file_id AS "pendingFileId",
              (SELECT count(*)::int FROM controlled_document_revision r WHERE r.document_id = d.id) AS "revisionCount"
         FROM controlled_document d
         LEFT JOIN LATERAL (SELECT r.revision_label, r.effective_from, r.file_id FROM controlled_document_revision r
                             WHERE r.document_id = d.id AND r.effective_from <= $1
                             ORDER BY r.effective_from DESC, r.released_at DESC LIMIT 1) cur ON true
         LEFT JOIN LATERAL (SELECT r.revision_label, r.effective_from, r.file_id FROM controlled_document_revision r
                             WHERE r.document_id = d.id AND r.effective_from > $1
                             ORDER BY r.effective_from, r.released_at LIMIT 1) nxt ON true
        ORDER BY d.kind = 'LIBRARY', d.type_code, d.kind <> 'FORM', d.number`,
      [asOf],
    );
    return { asOf, documents: rows.map((r) => ({ ...r, usage: r.typeCode ? (DOCUMENT_USAGE[r.typeCode as string] ?? null) : null })) };
  });

  app.get('/api/documents/:id', async (req) => {
    const { id } = req.params as { id: string };
    await requireCapability(db, req, 'records.read', { action: 'documents.read', entityType: 'controlled_document', entityId: id, consequential: false });
    if (!uuid.safeParse(id).success) throw notFound('Document');
    const doc = await one<{ id: string; number: string; typeCode: string | null; family: string; kind: string; title: string; ownerRole: string; retentionClass: string | null; createdAt: string }>(
      db,
      `SELECT id, number, type_code AS "typeCode", family, kind, title, owner_role AS "ownerRole", retention_class AS "retentionClass", created_at AS "createdAt"
         FROM controlled_document WHERE id = $1`,
      [id],
    );
    if (!doc) throw notFound('Document');
    const asOf = await today(db, config.displayTimeZone);
    const revisions = await many<RevisionRow>(
      db,
      `SELECT r.id, r.revision_label AS "revisionLabel", r.effective_from AS "effectiveFrom", r.change_summary AS "changeSummary",
              r.file_id AS "fileId", r.sha256, f.byte_size::int AS "byteSize", f.original_name AS "originalName",
              u.display_name AS "releasedBy", r.released_at AS "releasedAt"
         FROM controlled_document_revision r
         JOIN file_object f ON f.id = r.file_id
         JOIN app_user u ON u.id = r.released_by
        WHERE r.document_id = $1
        ORDER BY r.effective_from DESC, r.released_at DESC`,
      [id],
    );
    const related = doc.typeCode
      ? await many(db, `SELECT id, number, kind, title FROM controlled_document WHERE type_code = $1 AND id <> $2 ORDER BY kind = 'CONTINUATION', number`, [doc.typeCode, id])
      : [];
    return {
      ...doc,
      asOf,
      revisions: withStatus(revisions, asOf),
      related,
      usage: doc.typeCode ? (DOCUMENT_USAGE[doc.typeCode] ?? null) : null,
      evidenceType: doc.typeCode && RECORD_TYPES[doc.typeCode] ? RECORD_TYPES[doc.typeCode] : null,
    };
  });

  /** Bulk import, one file per request: identity and revision are read from the file name. Re-importing the same bytes is a no-op. */
  app.post('/api/documents/import', async (req, reply) => {
    const auth = await requireCapability(db, req, 'documents.control', { action: 'documents.import' });
    const q = z.object({ effectiveFrom: date }).parse(req.query);
    const { staged, name } = await receivePdf(svc, req, auth.userId);
    const parsed = parseDocumentFilename(name);
    if (!parsed) {
      await storage.discard(staged);
      throw unprocessable(`${name}: ${FILENAME_RULE}`);
    }
    return storeRevision(svc, req, auth.userId, staged, name, {
      parsed,
      revisionLabel: parsed.revisionLabel,
      effectiveFrom: q.effectiveFrom,
      changeSummary: `Imported from ${name}`,
    }).then((r) => reply.code(r.status === 'UNCHANGED' ? 200 : 201).send(r));
  });

  app.post('/api/documents/:id/revisions', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'documents.control', { action: 'documents.revise', entityType: 'controlled_document', entityId: id });
    if (!uuid.safeParse(id).success) throw notFound('Document');
    const q = z.object({ revisionLabel, effectiveFrom: date, changeSummary: z.string().trim().min(5).max(1000) }).parse(req.query);
    const doc = await one<{ number: string }>(db, 'SELECT number FROM controlled_document WHERE id = $1', [id]);
    if (!doc) throw notFound('Document');
    const { staged, name } = await receivePdf(svc, req, auth.userId);
    const parsed = parseDocumentFilename(name);
    if (parsed && parsed.number !== doc.number) {
      await storage.discard(staged);
      throw unprocessable(`${name} is named for ${parsed.number}, not ${doc.number}`);
    }
    if (parsed && parsed.revisionLabel.toUpperCase() !== q.revisionLabel.toUpperCase()) {
      await storage.discard(staged);
      throw unprocessable(`${name} is named Rev ${parsed.revisionLabel}, but Rev ${q.revisionLabel} was entered`);
    }
    return storeRevision(svc, req, auth.userId, staged, name, { documentId: id, ...q }).then((r) => {
      if (r.status === 'UNCHANGED') throw conflict(`Rev ${q.revisionLabel} is already recorded with this file`);
      return reply.code(201).send(r);
    });
  });
}

async function recordRejected(svc: Services, req: FastifyRequest, actorId: string, name: string, reason: string) {
  await svc.db.query(`INSERT INTO file_object (kind, status, original_name, rejection_reason, uploaded_by) VALUES ('DOCUMENT','REJECTED',$1,$2,$3)`, [name, reason, actorId]);
  await audit(svc.db, { actorId, action: 'documents.upload', outcome: 'FAILED', entityType: 'file', summary: `Document upload rejected: ${name}: ${reason}`, requestId: req.id });
}

/** Stages the uploaded file and accepts it only if it is a PDF without active content. */
async function receivePdf(svc: Services, req: FastifyRequest, actorId: string): Promise<{ staged: StagedFile; name: string }> {
  const { storage, config } = svc;
  const health = await storage.check();
  if (!health.ok) throw new AppError(503, 'STORAGE_UNAVAILABLE', 'Document storage is unavailable; the file was not saved.');
  const part = await req.file({ limits: { fileSize: config.maxDocumentBytes + 1, files: 1 } });
  if (!part) throw badRequest('No file was uploaded');
  const name = sanitizeFilename(part.filename);
  let staged: StagedFile;
  try {
    staged = await storage.stage(part.file, config.maxDocumentBytes);
  } catch (err) {
    if (err instanceof FileTooLargeError) {
      await recordRejected(svc, req, actorId, name, err.message);
      throw new AppError(413, 'FILE_TOO_LARGE', `${name}: ${err.message}`);
    }
    throw err;
  }
  const check = validateDocument(await readFile(staged.stagingPath));
  const reason = !check.ok ? check.reason : check.mime !== 'application/pdf' ? 'Controlled documents must be PDF files' : null;
  if (reason) {
    await storage.discard(staged);
    await recordRejected(svc, req, actorId, name, reason);
    throw unprocessable(`${name}: ${reason}`);
  }
  return { staged, name };
}

type Target =
  | { parsed: ParsedDocumentName; documentId?: undefined; revisionLabel: string; effectiveFrom: string; changeSummary: string }
  | { documentId: string; parsed?: undefined; revisionLabel: string; effectiveFrom: string; changeSummary: string };

async function storeRevision(svc: Services, req: FastifyRequest, actorId: string, staged: StagedFile, name: string, t: Target) {
  const { db, storage } = svc;
  const storageKey = await storage.finalize(staged);
  try {
    const result = await withTransaction(db, async (tx) => {
      let documentId = t.documentId;
      let created = false;
      if (t.parsed) {
        const p = t.parsed;
        const inserted = await one<{ id: string }>(
          tx,
          `INSERT INTO controlled_document (number, type_code, family, kind, title, created_by) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (number) DO NOTHING RETURNING id`,
          [p.number, p.typeCode, p.family, p.kind, p.title, actorId],
        );
        created = Boolean(inserted);
        documentId = inserted?.id ?? (await one<{ id: string }>(tx, 'SELECT id FROM controlled_document WHERE number = $1', [p.number]))!.id;
      }
      const doc = (await one<{ id: string; number: string }>(tx, 'SELECT id, number FROM controlled_document WHERE id = $1 FOR UPDATE', [documentId]))!;
      const label = t.revisionLabel.toUpperCase();
      const same = await one<{ sha256: string }>(tx, 'SELECT sha256 FROM controlled_document_revision WHERE document_id = $1 AND upper(revision_label) = $2', [doc.id, label]);
      if (same) {
        if (same.sha256 === staged.sha256) return { status: 'UNCHANGED' as const, documentId: doc.id, number: doc.number, revisionLabel: label };
        throw conflict(`${doc.number} Rev ${label} is already recorded with a different file; issue a new revision instead`);
      }
      const latest = await one<{ effective_from: string; revision_label: string }>(
        tx,
        'SELECT effective_from, revision_label FROM controlled_document_revision WHERE document_id = $1 ORDER BY effective_from DESC, released_at DESC LIMIT 1',
        [doc.id],
      );
      if (latest && t.effectiveFrom < latest.effective_from) {
        throw unprocessable(`The effective date cannot be earlier than Rev ${latest.revision_label} (${latest.effective_from})`);
      }
      const file = await one<{ id: string }>(
        tx,
        `INSERT INTO file_object (kind, status, sha256, byte_size, mime_type, original_name, storage_key, uploaded_by)
         VALUES ('DOCUMENT', 'AVAILABLE', $1, $2, 'application/pdf', $3, $4, $5) RETURNING id`,
        [staged.sha256, staged.size, name, storageKey, actorId],
      );
      const rev = await one<{ id: string }>(
        tx,
        `INSERT INTO controlled_document_revision (document_id, revision_label, file_id, sha256, effective_from, change_summary, released_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [doc.id, label, file!.id, staged.sha256, t.effectiveFrom, t.changeSummary, actorId],
      );
      await audit(tx, {
        actorId,
        action: created ? 'documents.import' : 'documents.revise',
        entityType: 'controlled_document',
        entityId: doc.id,
        summary: `${doc.number} Rev ${label} released, effective ${t.effectiveFrom}${created ? ' (new document)' : ''}`,
        after: { revisionId: rev!.id, fileId: file!.id, sha256: staged.sha256, file: name },
        requestId: req.id,
      });
      return { status: created ? ('CREATED' as const) : ('ADDED_REVISION' as const), documentId: doc.id, number: doc.number, revisionLabel: label };
    });
    if (result.status === 'UNCHANGED') await storage.removeOrphan(storageKey);
    return result;
  } catch (err) {
    await storage.removeOrphan(storageKey);
    throw err;
  }
}
