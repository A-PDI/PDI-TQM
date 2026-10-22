import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { sectionRows } from '../shared/forms.js';
import { audit } from './audit.js';
import { requireCapability } from './auth.js';
import { one, withTransaction } from './db.js';
import { AppError, badRequest, conflict, forbidden, notFound, unprocessable } from './errors.js';
import { sanitizeFilename, validatePhoto } from './file-validation.js';
import { loadInspection } from './inspections/state.js';
import type { Services } from './services.js';
import { FileTooLargeError } from './storage.js';

const photoQuery = z.object({
  unitIndex: z.coerce.number().int().min(0).max(100).optional(),
  sectionKey: z.string().max(64).optional(),
  rowKey: z.string().max(80).optional(),
  caption: z.string().max(300).optional(),
});

const uuid = z.string().uuid();

export function registerEvidenceRoutes(app: FastifyInstance, svc: Services) {
  const { db, storage, config } = svc;

  app.post('/api/inspections/:id/photos', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'inspection.perform', { action: 'evidence.upload', entityType: 'inspection', entityId: id });
    const q = photoQuery.parse(req.query);
    const state = await loadInspection(db, id);
    if (!['DRAFT', 'PARTIAL'].includes(state.row.status)) throw conflict('Photographs can only be added while the inspection is open');
    if (state.row.inspector_id !== auth.userId) throw forbidden('Only the assigned inspector can add photographs');

    // Validate the row context against the frozen form before accepting any bytes.
    if (q.sectionKey || q.rowKey) {
      const section = state.row.form_snapshot.sections.find((s) => s.key === q.sectionKey);
      if (!section || q.unitIndex === undefined) throw badRequest('Unknown section for photograph');
      if (section.scope === 'inspection' ? q.unitIndex !== 0 : q.unitIndex < 1 || q.unitIndex > state.row.unit_count) {
        throw badRequest('Section does not apply to this unit');
      }
      if (!sectionRows(section).some((r) => r.key === q.rowKey)) throw badRequest('Unknown characteristic for photograph');
    }

    const health = await storage.check();
    if (!health.ok) throw new AppError(503, 'STORAGE_UNAVAILABLE', 'Evidence storage is unavailable; the photograph was not saved. Try again shortly.');

    const part = await req.file({ limits: { fileSize: config.maxPhotoBytes + 1, files: 1 } });
    if (!part) throw badRequest('No file was uploaded');
    const originalName = sanitizeFilename(part.filename);
    let staged;
    try {
      staged = await storage.stage(part.file, config.maxPhotoBytes);
    } catch (err) {
      if (err instanceof FileTooLargeError) {
        await recordRejected(svc, req, auth.userId, originalName, err.message);
        throw new AppError(413, 'FILE_TOO_LARGE', err.message);
      }
      throw err;
    }
    const check = validatePhoto(staged.head, staged.size);
    if (!check.ok) {
      await storage.discard(staged);
      await recordRejected(svc, req, auth.userId, originalName, check.reason);
      throw unprocessable(check.reason);
    }
    const storageKey = await storage.finalize(staged);
    try {
      const result = await withTransaction(db, async (tx) => {
        const fresh = await loadInspection(tx, id, { lock: true });
        if (!['DRAFT', 'PARTIAL'].includes(fresh.row.status)) throw conflict('Inspection was submitted while the photograph uploaded');
        const file = await one<{ id: string }>(
          tx,
          `INSERT INTO file_object (kind, status, sha256, byte_size, mime_type, original_name, storage_key, width, height, uploaded_by)
           VALUES ('PHOTO', 'AVAILABLE', $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [staged.sha256, staged.size, check.mime, originalName, storageKey, check.width, check.height, auth.userId],
        );
        const link = await one<{ id: string }>(
          tx,
          `INSERT INTO evidence_link (file_id, entity_type, entity_id, inspection_id, unit_index, section_key, row_key, caption, linked_by)
           VALUES ($1, 'INSPECTION', $2, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [file!.id, id, q.unitIndex ?? null, q.sectionKey ?? null, q.rowKey ?? null, q.caption?.trim() || null, auth.userId],
        );
        await audit(tx, {
          actorId: auth.userId,
          action: 'evidence.upload',
          entityType: 'inspection',
          entityId: id,
          summary: `Photograph ${originalName} (${check.width}×${check.height}) added to ${fresh.row.number}`,
          after: { fileId: file!.id, sha256: staged.sha256, unitIndex: q.unitIndex ?? null, sectionKey: q.sectionKey ?? null, rowKey: q.rowKey ?? null },
          requestId: req.id,
        });
        return { linkId: link!.id, fileId: file!.id, sha256: staged.sha256, width: check.width, height: check.height, mime: check.mime };
      });
      return reply.code(201).send(result);
    } catch (err) {
      await storage.removeOrphan(storageKey);
      throw err;
    }
  });

  app.delete('/api/inspections/:id/photos/:linkId', async (req) => {
    const { id, linkId } = req.params as { id: string; linkId: string };
    if (!uuid.safeParse(linkId).success) throw notFound('Photograph');
    const auth = await requireCapability(db, req, 'inspection.perform', { action: 'evidence.unlink', entityType: 'inspection', entityId: id });
    return withTransaction(db, async (tx) => {
      const state = await loadInspection(tx, id, { lock: true });
      if (!['DRAFT', 'PARTIAL'].includes(state.row.status)) throw conflict('Photographs of a submitted inspection cannot be removed');
      if (state.row.inspector_id !== auth.userId) throw forbidden('Only the assigned inspector can remove photographs');
      const res = await tx.query(
        `UPDATE evidence_link SET unlinked_at = now(), unlinked_by = $3, unlink_reason = 'Removed by inspector before submission'
          WHERE id = $1 AND inspection_id = $2 AND unlinked_at IS NULL`,
        [linkId, id, auth.userId],
      );
      if (!res.rowCount) throw notFound('Photograph');
      await audit(tx, { actorId: auth.userId, action: 'evidence.unlink', entityType: 'inspection', entityId: id, summary: `Photograph link ${linkId} removed`, requestId: req.id });
      return { ok: true };
    });
  });

  // Authenticated, session-checked streaming; URLs carry no authority of their own.
  app.get('/api/files/:fileId', async (req, reply) => {
    const { fileId } = req.params as { fileId: string };
    await requireCapability(db, req, 'records.read', { action: 'evidence.download', entityType: 'file', entityId: fileId, consequential: false });
    if (!uuid.safeParse(fileId).success) throw notFound('File');
    const file = await one<{ id: string; status: string; mime_type: string; storage_key: string; sha256: string; byte_size: string; original_name: string | null; kind: string }>(
      db,
      `SELECT f.* FROM file_object f
        WHERE f.id = $1 AND f.status = 'AVAILABLE'
          AND (EXISTS (SELECT 1 FROM evidence_link l WHERE l.file_id = f.id)
               OR EXISTS (SELECT 1 FROM report_rendition r WHERE r.file_id = f.id)
               OR EXISTS (SELECT 1 FROM controlled_document_revision d WHERE d.file_id = f.id))`,
      [fileId],
    );
    if (!file) throw notFound('File');
    const download = (req.query as { download?: string }).download === '1';
    const inline = !download && (file.mime_type.startsWith('image/') || file.mime_type === 'application/pdf');
    const safeName = (file.original_name ?? `${file.id}`).replace(/["\\]/g, '_');
    reply
      .header('Content-Type', file.mime_type)
      .header('Content-Length', file.byte_size)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox")
      .header('Cache-Control', 'private, no-store')
      .header('ETag', `"${file.sha256}"`)
      .header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`);
    return reply.send(storage.openRead(file.storage_key));
  });
}

async function recordRejected(svc: Services, req: FastifyRequest, actorId: string, name: string, reason: string) {
  await svc.db.query(
    `INSERT INTO file_object (kind, status, original_name, rejection_reason, uploaded_by) VALUES ('PHOTO', 'REJECTED', $1, $2, $3)`,
    [name, reason, actorId],
  );
  await audit(svc.db, {
    actorId,
    action: 'evidence.upload',
    outcome: 'FAILED',
    entityType: 'file',
    summary: `Upload rejected: ${reason}`,
    requestId: req.id,
  });
}
