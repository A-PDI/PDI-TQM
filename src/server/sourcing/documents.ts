import { readFile } from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Capability } from '../../shared/capabilities.js';
import { audit } from '../audit.js';
import { requireCapability } from '../auth.js';
import { type Queryable, one, withTransaction } from '../db.js';
import { AppError, badRequest, conflict, notFound, unprocessable } from '../errors.js';
import { sanitizeFilename, validateDocument } from '../file-validation.js';
import type { Services } from '../services.js';
import { FileTooLargeError } from '../storage.js';

const uuid = z.string().uuid();

interface EntityRule {
  capability: Capability;
  /** Returns whether files may be added/removed now, plus the record the audit entry belongs to. */
  resolve: (db: Queryable, id: string) => Promise<{ open: boolean; closedReason: string; auditType: string; auditId: string } | null>;
}

const RULES: Record<string, EntityRule> = {
  EVIDENCE_REQUIREMENT: {
    capability: 'sourcing.manage',
    resolve: async (db, id) => {
      const r = await one<{ status: string; sourcing_request_id: string }>(db, 'SELECT status, sourcing_request_id FROM evidence_requirement WHERE id = $1', [id]);
      return r && { open: r.status === 'OPEN', closedReason: `The item is ${r.status.toLowerCase()}`, auditType: 'sourcing_request', auditId: r.sourcing_request_id };
    },
  },
  ACKNOWLEDGMENT: {
    capability: 'sourcing.manage',
    resolve: async (db, id) => {
      const r = await one<{ response: string; source_id: string }>(db, 'SELECT response, source_id FROM supplier_acknowledgment WHERE id = $1', [id]);
      return r && { open: true, closedReason: '', auditType: 'source', auditId: r.source_id };
    },
  },
  FAI: {
    capability: 'sourcing.manage',
    resolve: async (db, id) => {
      const r = await one<{ status: string; source_id: string }>(db, 'SELECT status, source_id FROM fai_sample WHERE id = $1', [id]);
      return r && { open: r.status === 'OPEN', closedReason: 'The sample has been decided', auditType: 'source', auditId: r.source_id };
    },
  },
  QUALIFICATION: {
    capability: 'supplier.manage',
    resolve: async (db, id) => {
      const r = await one<{ status: string; supplier_id: string }>(db, 'SELECT status, supplier_id FROM supplier_qualification WHERE id = $1', [id]);
      return r && { open: r.status === 'UNDER_REVIEW', closedReason: 'The assessment has been decided', auditType: 'supplier', auditId: r.supplier_id };
    },
  },
  CERTIFICATE: {
    capability: 'supplier.manage',
    resolve: async (db, id) => {
      const r = await one<{ supplier_id: string }>(db, 'SELECT supplier_id FROM supplier_certificate WHERE id = $1', [id]);
      return r && { open: true, closedReason: '', auditType: 'supplier', auditId: r.supplier_id };
    },
  },
  NCR: {
    capability: 'ncr.manage',
    resolve: async (db, id) => {
      const r = await one<{ status: string }>(db, 'SELECT status FROM ncr WHERE id = $1', [id]);
      return r && { open: r.status !== 'CLOSED', closedReason: 'The NCR is closed', auditType: 'ncr', auditId: id };
    },
  },
  MATERIAL_SCOPE: {
    capability: 'containment.verify',
    resolve: async (db, id) => {
      const r = await one<{ state: string; ncr_id: string; ncr_status: string }>(
        db,
        'SELECT m.state, m.ncr_id, n.status AS ncr_status FROM material_scope m JOIN ncr n ON n.id = m.ncr_id WHERE m.id = $1',
        [id],
      );
      return r && { open: r.ncr_status !== 'CLOSED' && r.state !== 'RELEASED', closedReason: 'The material is released or the NCR is closed', auditType: 'ncr', auditId: r.ncr_id };
    },
  },
  DISPOSITION: {
    capability: 'disposition.verify',
    resolve: async (db, id) => {
      const r = await one<{ voided_at: Date | null; ncr_id: string; ncr_status: string }>(
        db,
        'SELECT d.voided_at, m.ncr_id, n.status AS ncr_status FROM disposition_decision d JOIN material_scope m ON m.id = d.scope_id JOIN ncr n ON n.id = m.ncr_id WHERE d.id = $1',
        [id],
      );
      return r && { open: !r.voided_at && r.ncr_status !== 'CLOSED', closedReason: 'The disposition is void or the NCR is closed', auditType: 'ncr', auditId: r.ncr_id };
    },
  },
  CONCESSION: {
    capability: 'concession.request',
    resolve: async (db, id) => {
      const r = await one<{ status: string }>(db, 'SELECT status FROM concession WHERE id = $1', [id]);
      return r && { open: r.status === 'REQUESTED', closedReason: 'The concession has been decided', auditType: 'concession', auditId: id };
    },
  },
  SCAR: {
    capability: 'scar.manage',
    resolve: async (db, id) => {
      const r = await one<{ status: string }>(db, 'SELECT status FROM scar WHERE id = $1', [id]);
      return r && { open: r.status !== 'CLOSED', closedReason: 'The SCAR is closed', auditType: 'scar', auditId: id };
    },
  },
  COMMITMENT: {
    capability: 'commitment.manage',
    resolve: async (db, id) => {
      const r = await one<{ status: string }>(db, 'SELECT status FROM supplier_commitment WHERE id = $1', [id]);
      return r && { open: r.status === 'OPEN' || r.status === 'SUPPLIER_CLAIMS_DONE', closedReason: 'The commitment is closed', auditType: 'supplier_commitment', auditId: id };
    },
  },
  CHANGE: {
    capability: 'change.manage',
    resolve: async (db, id) => {
      const r = await one<{ status: string }>(db, 'SELECT status FROM change_request WHERE id = $1', [id]);
      return r && { open: !['REJECTED', 'IMPLEMENTATION_VERIFIED', 'CANCELLED'].includes(r.status), closedReason: 'The change is closed', auditType: 'change_request', auditId: id };
    },
  },
  BASELINE_REVISION: {
    capability: 'engineering.author',
    resolve: async (db, id) => {
      const r = await one<{ status: string }>(db, 'SELECT status FROM baseline_revision WHERE id = $1', [id]);
      return r && { open: r.status === 'DRAFT', closedReason: 'Only draft revisions accept new documents', auditType: 'baseline_revision', auditId: id };
    },
  },
};

async function recordRejected(svc: Services, req: FastifyRequest, actorId: string, name: string, reason: string) {
  await svc.db.query(`INSERT INTO file_object (kind, status, original_name, rejection_reason, uploaded_by) VALUES ('DOCUMENT','REJECTED',$1,$2,$3)`, [name, reason, actorId]);
  await audit(svc.db, { actorId, action: 'evidence.upload', outcome: 'FAILED', entityType: 'file', summary: `Upload rejected: ${reason}`, requestId: req.id });
}

export function registerDocumentRoutes(app: FastifyInstance, svc: Services) {
  const { db, storage, config } = svc;

  app.post('/api/evidence/:entityType/:entityId', async (req, reply) => {
    const { entityType, entityId } = req.params as { entityType: string; entityId: string };
    const rule = RULES[entityType];
    if (!rule) throw badRequest('Unsupported evidence target');
    if (!uuid.safeParse(entityId).success) throw notFound('Record');
    const auth = await requireCapability(db, req, rule.capability, { action: 'evidence.upload', entityType, entityId });
    const target = await rule.resolve(db, entityId);
    if (!target) throw notFound('Record');
    if (!target.open) throw conflict(target.closedReason);
    const caption = z.string().max(300).optional().parse((req.query as { caption?: string }).caption);
    const health = await storage.check();
    if (!health.ok) throw new AppError(503, 'STORAGE_UNAVAILABLE', 'Evidence storage is unavailable; the file was not saved.');
    const part = await req.file({ limits: { fileSize: config.maxDocumentBytes + 1, files: 1 } });
    if (!part) throw badRequest('No file was uploaded');
    const name = sanitizeFilename(part.filename);
    let staged;
    try {
      staged = await storage.stage(part.file, config.maxDocumentBytes);
    } catch (err) {
      if (err instanceof FileTooLargeError) {
        await recordRejected(svc, req, auth.userId, name, err.message);
        throw new AppError(413, 'FILE_TOO_LARGE', err.message);
      }
      throw err;
    }
    const check = validateDocument(await readFile(staged.stagingPath));
    if (!check.ok) {
      await storage.discard(staged);
      await recordRejected(svc, req, auth.userId, name, check.reason);
      throw unprocessable(check.reason);
    }
    const storageKey = await storage.finalize(staged);
    try {
      const result = await withTransaction(db, async (tx) => {
        const again = await rule.resolve(tx, entityId);
        if (!again?.open) throw conflict('The record closed while the file uploaded');
        const file = await one<{ id: string }>(
          tx,
          `INSERT INTO file_object (kind, status, sha256, byte_size, mime_type, original_name, storage_key, width, height, uploaded_by)
           VALUES ('DOCUMENT','AVAILABLE',$1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
          [staged.sha256, staged.size, check.mime, name, storageKey, check.width ?? null, check.height ?? null, auth.userId],
        );
        const link = await one<{ id: string }>(
          tx,
          `INSERT INTO evidence_link (file_id, entity_type, entity_id, caption, linked_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [file!.id, entityType, entityId, caption ?? null, auth.userId],
        );
        await audit(tx, {
          actorId: auth.userId,
          action: 'evidence.upload',
          entityType: target.auditType,
          entityId: target.auditId,
          summary: `Evidence ${name} attached to ${entityType.toLowerCase().replaceAll('_', ' ')}`,
          after: { fileId: file!.id, sha256: staged.sha256 },
          requestId: req.id,
        });
        return { linkId: link!.id, fileId: file!.id, sha256: staged.sha256, name };
      });
      return reply.code(201).send(result);
    } catch (err) {
      await storage.removeOrphan(storageKey);
      throw err;
    }
  });

  app.delete('/api/evidence/links/:linkId', async (req) => {
    const { linkId } = req.params as { linkId: string };
    if (!uuid.safeParse(linkId).success) throw notFound('Link');
    const link = await one<{ entity_type: string; entity_id: string; unlinked_at: Date | null }>(
      db,
      'SELECT entity_type, entity_id, unlinked_at FROM evidence_link WHERE id = $1',
      [linkId],
    );
    const rule = link ? RULES[link.entity_type] : undefined;
    if (!link || !rule || link.unlinked_at) throw notFound('Link');
    const auth = await requireCapability(db, req, rule.capability, { action: 'evidence.unlink', entityType: link.entity_type, entityId: link.entity_id });
    return withTransaction(db, async (tx) => {
      const target = await rule.resolve(tx, link.entity_id);
      if (!target?.open || link.entity_type === 'ACKNOWLEDGMENT') throw conflict('Evidence on this record can no longer be removed');
      await tx.query(`UPDATE evidence_link SET unlinked_at = now(), unlinked_by = $2, unlink_reason = 'Removed before decision' WHERE id = $1`, [linkId, auth.userId]);
      await audit(tx, { actorId: auth.userId, action: 'evidence.unlink', entityType: target.auditType, entityId: target.auditId, summary: 'Evidence link removed (file retained)', requestId: req.id });
      return { ok: true };
    });
  });
}
