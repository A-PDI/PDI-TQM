import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import { auditedDenial, has, recheckCapability, requireCapability } from '../auth.js';
import { many, one, withTransaction } from '../db.js';
import { conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { nextRecordNumber } from '../numbering.js';
import type { Services } from '../services.js';
import { activeRestrictions, effectiveSourceStatuses, siteQualifications } from './status.js';

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const normalize = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

export function registerSupplierRoutes(app: FastifyInstance, svc: Services) {
  const { db } = svc;

  app.get('/api/suppliers', async (req) => {
    await requireCapability(db, req, 'records.read', { action: 'suppliers.list', consequential: false });
    const rows = await many<{ id: string; code: string; legalName: string; status: string; category: string | null; isSynthetic: boolean; siteCount: number; sourceCount: number }>(
      db,
      `SELECT s.id, s.code, s.legal_name AS "legalName", s.status, s.category, s.is_synthetic AS "isSynthetic",
              (SELECT count(*)::int FROM supplier_site ss WHERE ss.supplier_id = s.id) AS "siteCount",
              (SELECT count(*)::int FROM source x WHERE x.supplier_id = s.id) AS "sourceCount"
         FROM supplier s ORDER BY s.legal_name`,
    );
    const restrictions = await activeRestrictions(db, rows.map((r) => r.id));
    return rows.map((r) => ({ ...r, restricted: restrictions.some((x) => x.supplier_id === r.id) }));
  });

  app.post('/api/suppliers', async (req, reply) => {
    const auth = await requireCapability(db, req, 'supplier.manage', { action: 'supplier.create' });
    const body = z
      .object({
        code: z.string().trim().min(2).max(20).regex(/^[A-Za-z0-9-]+$/),
        legalName: z.string().trim().min(2).max(200),
        tradingName: z.string().trim().max(200).nullable().optional(),
        category: z.string().trim().max(120).nullable().optional(),
        notes: z.string().trim().max(2000).nullable().optional(),
      })
      .parse(req.body);
    const row = await withTransaction(db, async (tx) => {
      const s = await one<{ id: string }>(
        tx,
        `INSERT INTO supplier (code, legal_name, trading_name, category, notes, created_by) VALUES (upper($1),$2,$3,$4,$5,$6) RETURNING id`,
        [body.code, body.legalName, body.tradingName ?? null, body.category ?? null, body.notes ?? null, auth.userId],
      );
      await audit(tx, { actorId: auth.userId, action: 'supplier.create', entityType: 'supplier', entityId: s!.id, summary: `Supplier ${body.legalName} registered (prospective)`, requestId: req.id });
      return s!;
    });
    return reply.code(201).send(row);
  });

  app.post('/api/suppliers/:id/sites', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'supplier.manage', { action: 'supplier.site_create', entityType: 'supplier', entityId: id });
    const body = z
      .object({
        code: z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9-]+$/),
        name: z.string().trim().min(2).max(200),
        address: z.string().trim().max(500).nullable().optional(),
        country: z.string().trim().max(60).nullable().optional(),
      })
      .parse(req.body);
    if (!uuid.safeParse(id).success) throw notFound('Supplier');
    const row = await withTransaction(db, async (tx) => {
      const s = await one<{ id: string }>(
        tx,
        `INSERT INTO supplier_site (supplier_id, code, name, address, country) VALUES ($1, upper($2), $3, $4, $5) RETURNING id`,
        [id, body.code, body.name, body.address ?? null, body.country ?? null],
      );
      await audit(tx, { actorId: auth.userId, action: 'supplier.site_create', entityType: 'supplier', entityId: id, summary: `Site ${body.name} added (not assessed)`, requestId: req.id });
      return s!;
    });
    return reply.code(201).send(row);
  });

  app.post('/api/suppliers/:id/parts', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'supplier.manage', { action: 'supplier.part_create', entityType: 'supplier', entityId: id });
    const body = z.object({ supplierPartNumber: z.string().trim().min(1).max(80), description: z.string().trim().max(200).nullable().optional() }).parse(req.body);
    if (!uuid.safeParse(id).success) throw notFound('Supplier');
    const row = await one<{ id: string }>(
      db,
      `INSERT INTO supplier_part (supplier_id, supplier_part_number, description, normalized) VALUES ($1,$2,$3,$4) RETURNING id`,
      [id, body.supplierPartNumber, body.description ?? null, normalize(body.supplierPartNumber)],
    );
    await audit(db, { actorId: auth.userId, action: 'supplier.part_create', entityType: 'supplier', entityId: id, summary: `Supplier part ${body.supplierPartNumber} added`, requestId: req.id });
    return reply.code(201).send(row);
  });

  app.get('/api/suppliers/:id', async (req) => {
    const auth = await requireCapability(db, req, 'records.read', { action: 'suppliers.read', consequential: false });
    const { id } = req.params as { id: string };
    if (!uuid.safeParse(id).success) throw notFound('Supplier');
    const supplier = await one(
      db,
      `SELECT id, code, legal_name AS "legalName", trading_name AS "tradingName", status, category, notes, is_synthetic AS "isSynthetic" FROM supplier WHERE id = $1`,
      [id],
    );
    if (!supplier) throw notFound('Supplier');
    const [sites, sources, inspections, concerns, qualifications, restrictions, certificates, supplierParts] = await Promise.all([
      many<{ id: string; code: string; name: string; address: string | null; country: string | null }>(
        db,
        `SELECT id, code, name, address, country FROM supplier_site WHERE supplier_id = $1 ORDER BY name`,
        [id],
      ),
      many<{ id: string }>(
        db,
        `SELECT s.id, p.id AS "partId", p.part_number AS "partNumber", p.description, ss.name AS site, sp.supplier_part_number AS "supplierPartNumber",
                s.pathway, s.configuration
           FROM source s JOIN company_part p ON p.id = s.part_id JOIN supplier_site ss ON ss.id = s.site_id JOIN supplier_part sp ON sp.id = s.supplier_part_id
          WHERE s.supplier_id = $1 ORDER BY p.part_number, ss.name`,
        [id],
      ),
      many(
        db,
        `SELECT id, number, part_number AS "partNumber", status, outcome, date_received AS "dateReceived" FROM inspection WHERE supplier_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [id],
      ),
      many(db, `SELECT id, number, title, status FROM quality_event WHERE supplier_id = $1 ORDER BY reported_at DESC LIMIT 20`, [id]),
      many(
        db,
        `SELECT q.id, q.number, q.site_id AS "siteId", ss.name AS "siteName", q.kind, q.scope, q.findings, q.proposed_result AS "proposedResult",
                q.proposed_conditions AS "proposedConditions", q.proposed_valid_until AS "proposedValidUntil", q.status, q.decision, q.conditions,
                q.valid_until AS "validUntil", q.rationale, q.version, q.created_at AS "createdAt", q.decided_at AS "decidedAt",
                a.id AS "assessorId", a.display_name AS assessor, d.display_name AS "decidedBy",
                coalesce((SELECT json_agg(json_build_object('linkId', l.id, 'fileId', f.id, 'name', f.original_name)) FROM evidence_link l
                            JOIN file_object f ON f.id = l.file_id WHERE l.entity_type = 'QUALIFICATION' AND l.entity_id = q.id AND l.unlinked_at IS NULL), '[]') AS files
           FROM supplier_qualification q JOIN app_user a ON a.id = q.assessor_id LEFT JOIN app_user d ON d.id = q.decided_by
           LEFT JOIN supplier_site ss ON ss.id = q.site_id
          WHERE q.supplier_id = $1 ORDER BY q.created_at DESC`,
        [id],
      ),
      many(
        db,
        `SELECT r.id, r.site_id AS "siteId", ss.name AS "siteName", r.reason, r.decided_at AS "decidedAt", u.display_name AS "decidedBy",
                r.lifted_at AS "liftedAt", l.display_name AS "liftedBy", r.lift_reason AS "liftReason"
           FROM supplier_restriction r JOIN app_user u ON u.id = r.decided_by LEFT JOIN app_user l ON l.id = r.lifted_by
           LEFT JOIN supplier_site ss ON ss.id = r.site_id
          WHERE r.supplier_id = $1 ORDER BY r.decided_at DESC`,
        [id],
      ),
      many(
        db,
        `SELECT c.id, c.site_id AS "siteId", ss.name AS "siteName", c.cert_type AS "certType", c.cert_number AS "certNumber", c.issuer,
                c.valid_until AS "validUntil", (c.valid_until IS NOT NULL AND c.valid_until < current_date) AS expired,
                coalesce((SELECT json_agg(json_build_object('linkId', l.id, 'fileId', f.id, 'name', f.original_name)) FROM evidence_link l
                            JOIN file_object f ON f.id = l.file_id WHERE l.entity_type = 'CERTIFICATE' AND l.entity_id = c.id AND l.unlinked_at IS NULL), '[]') AS files
           FROM supplier_certificate c LEFT JOIN supplier_site ss ON ss.id = c.site_id WHERE c.supplier_id = $1 ORDER BY c.valid_until NULLS LAST`,
        [id],
      ),
      many(db, `SELECT id, supplier_part_number AS "supplierPartNumber", description FROM supplier_part WHERE supplier_id = $1 ORDER BY supplier_part_number`, [id]),
    ]);
    const quals = await siteQualifications(db, sites.map((s) => s.id));
    const statuses = await effectiveSourceStatuses(db, sources.map((s) => s.id));
    return {
      supplier,
      sites: sites.map((s) => ({ ...s, qualification: quals.get(s.id) })),
      sources: sources.map((s) => ({ ...s, effective: statuses.get(s.id) })),
      inspections,
      concerns,
      qualifications,
      restrictions,
      certificates,
      supplierParts,
      permissions: {
        canManage: has(auth, 'supplier.manage'),
        canQualify: has(auth, 'supplier.qualify'),
        canRestrict: has(auth, 'supplier.restrict'),
      },
    };
  });

  app.post('/api/suppliers/:id/qualifications', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'supplier.manage', { action: 'qualification.create', entityType: 'supplier', entityId: id });
    const body = z
      .object({
        siteId: uuid.nullable().optional(),
        kind: z.enum(['INITIAL', 'REASSESSMENT']),
        scope: z.string().trim().min(3).max(1000),
        findings: z.string().trim().min(3).max(8000),
        proposedResult: z.enum(['QUALIFIED', 'CONDITIONALLY_QUALIFIED', 'REJECTED']),
        proposedConditions: z.string().trim().max(2000).nullable().optional(),
        proposedValidUntil: date.nullable().optional(),
      })
      .parse(req.body);
    if (!uuid.safeParse(id).success) throw notFound('Supplier');
    const created = await withTransaction(db, async (tx) => {
      if (body.siteId) {
        const site = await one(tx, 'SELECT 1 FROM supplier_site WHERE id = $1 AND supplier_id = $2', [body.siteId, id]);
        if (!site) throw unprocessable('The site does not belong to this supplier');
      }
      const open = await one(
        tx,
        `SELECT 1 FROM supplier_qualification WHERE supplier_id = $1 AND site_id IS NOT DISTINCT FROM $2 AND status = 'UNDER_REVIEW'`,
        [id, body.siteId ?? null],
      );
      if (open) throw conflict('An assessment for this subject is already under review');
      const number = await nextRecordNumber(tx, 'SQ');
      const q = await one<{ id: string }>(
        tx,
        `INSERT INTO supplier_qualification (number, supplier_id, site_id, kind, scope, findings, proposed_result, proposed_conditions, proposed_valid_until, assessor_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [number, id, body.siteId ?? null, body.kind, body.scope, body.findings, body.proposedResult, body.proposedConditions ?? null, body.proposedValidUntil ?? null, auth.userId],
      );
      await tx.query(
        `INSERT INTO work_item (kind, title, subject_type, subject_id, required_capability) VALUES ('QUALIFICATION_DECISION', $1, 'QUALIFICATION', $2, 'supplier.qualify')`,
        [`Decide ${number}: ${body.scope}`.slice(0, 200), q!.id],
      );
      await audit(tx, {
        actorId: auth.userId,
        action: 'qualification.create',
        entityType: 'supplier',
        entityId: id,
        summary: `${number} assessment recorded (${body.siteId ? 'site' : 'supplier level'}); proposed ${body.proposedResult}`,
        requestId: req.id,
      });
      return { id: q!.id, number };
    });
    return reply.code(201).send(created);
  });

  app.post('/api/qualifications/:id/decide', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'supplier.qualify', { action: 'qualification.decide', entityType: 'supplier_qualification', entityId: id });
    const body = z
      .object({
        expectedVersion: z.number().int(),
        decision: z.enum(['QUALIFIED', 'CONDITIONALLY_QUALIFIED', 'REJECTED']),
        conditions: z.string().trim().max(2000).nullable().optional(),
        validUntil: date.nullable().optional(),
        rationale: z.string().trim().min(5).max(4000),
      })
      .parse(req.body);
    if (!uuid.safeParse(id).success) throw notFound('Qualification');
    if (body.decision === 'CONDITIONALLY_QUALIFIED' && (!body.conditions || !body.validUntil)) {
      throw unprocessable('A conditional qualification must state its conditions and validity date');
    }
    if (body.validUntil && body.validUntil < new Date().toISOString().slice(0, 10)) throw unprocessable('Validity date is in the past');
    return withTransaction(db, async (tx) => {
      const q = await one<{ id: string; number: string; supplier_id: string; site_id: string | null; assessor_id: string; status: string; version: number }>(
        tx,
        'SELECT id, number, supplier_id, site_id, assessor_id, status, version FROM supplier_qualification WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!q) throw notFound('Qualification');
      if (q.status !== 'UNDER_REVIEW') throw conflict('This assessment has already been decided');
      if (q.version !== body.expectedVersion) throw conflict('This assessment changed; reload and try again');
      if (q.assessor_id === auth.userId) {
        throw await auditedDenial(db, req, auth.userId, 'qualification.decide', 'supplier_qualification', id, 'the assessor cannot decide their own assessment');
      }
      if (!(await recheckCapability(tx, auth.userId, 'supplier.qualify'))) throw forbidden();
      await tx.query(
        `UPDATE supplier_qualification SET status = 'DECIDED', decision = $2, conditions = $3, valid_until = $4, rationale = $5, decided_by = $6,
            decided_at = now(), grants_used = ARRAY['supplier.qualify'], version = version + 1 WHERE id = $1`,
        [id, body.decision, body.conditions ?? null, body.validUntil ?? null, body.rationale, auth.userId],
      );
      await tx.query(
        `UPDATE work_item SET status = 'DONE', closed_at = now(), closed_by = $2, closed_reason = $3
          WHERE subject_type = 'QUALIFICATION' AND subject_id = $1 AND status = 'OPEN'`,
        [id, auth.userId, `Decided ${body.decision}`],
      );
      if (body.decision !== 'REJECTED') await tx.query(`UPDATE supplier SET status = 'ACTIVE' WHERE id = $1 AND status = 'PROSPECTIVE'`, [q.supplier_id]);
      await audit(tx, {
        actorId: auth.userId,
        action: 'qualification.decide',
        entityType: 'supplier',
        entityId: q.supplier_id,
        summary: `${q.number} decided ${body.decision}${body.validUntil ? ` until ${body.validUntil}` : ''}`,
        reason: body.rationale,
        requestId: req.id,
      });
      return { status: 'DECIDED', decision: body.decision };
    });
  });

  app.post('/api/suppliers/:id/restrictions', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'supplier.restrict', { action: 'supplier.suspend', entityType: 'supplier', entityId: id });
    const body = z.object({ siteId: uuid.nullable().optional(), reason: z.string().trim().min(5).max(2000) }).parse(req.body);
    if (!uuid.safeParse(id).success) throw notFound('Supplier');
    const created = await withTransaction(db, async (tx) => {
      if (body.siteId && !(await one(tx, 'SELECT 1 FROM supplier_site WHERE id = $1 AND supplier_id = $2', [body.siteId, id]))) {
        throw unprocessable('The site does not belong to this supplier');
      }
      const r = await one<{ id: string }>(
        tx,
        `INSERT INTO supplier_restriction (supplier_id, site_id, reason, decided_by) VALUES ($1,$2,$3,$4) RETURNING id`,
        [id, body.siteId ?? null, body.reason, auth.userId],
      );
      const affected = await many<{ id: string }>(
        tx,
        `SELECT s.id FROM source s WHERE s.supplier_id = $1 AND ($2::uuid IS NULL OR s.site_id = $2)
            AND EXISTS (SELECT 1 FROM source_approval_decision d WHERE d.source_id = s.id AND d.decision <> 'REJECTED')`,
        [id, body.siteId ?? null],
      );
      await audit(tx, {
        actorId: auth.userId,
        action: 'supplier.suspend',
        entityType: 'supplier',
        entityId: id,
        summary: `${body.siteId ? 'Site' : 'Supplier'} suspended; ${affected.length} approved source(s) now blocked pending review`,
        reason: body.reason,
        after: { restrictionId: r!.id, affectedSources: affected.map((a) => a.id) },
        requestId: req.id,
      });
      return { id: r!.id, affectedSources: affected.length };
    });
    return reply.code(201).send(created);
  });

  app.post('/api/restrictions/:id/lift', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'supplier.restrict', { action: 'supplier.reinstate', entityType: 'supplier_restriction', entityId: id });
    const body = z.object({ reason: z.string().trim().min(5).max(2000) }).parse(req.body);
    if (!uuid.safeParse(id).success) throw notFound('Restriction');
    return withTransaction(db, async (tx) => {
      const r = await one<{ supplier_id: string; lifted_at: Date | null; decided_by: string }>(
        tx,
        'SELECT supplier_id, lifted_at, decided_by FROM supplier_restriction WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!r) throw notFound('Restriction');
      if (r.lifted_at) throw conflict('This restriction was already lifted');
      await tx.query('UPDATE supplier_restriction SET lifted_at = now(), lifted_by = $2, lift_reason = $3 WHERE id = $1', [id, auth.userId, body.reason]);
      await audit(tx, { actorId: auth.userId, action: 'supplier.reinstate', entityType: 'supplier', entityId: r.supplier_id, summary: 'Suspension lifted (reinstated)', reason: body.reason, requestId: req.id });
      return { ok: true };
    });
  });

  app.post('/api/suppliers/:id/certificates', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'supplier.manage', { action: 'supplier.certificate', entityType: 'supplier', entityId: id });
    const body = z
      .object({
        siteId: uuid.nullable().optional(),
        certType: z.string().trim().min(2).max(120),
        certNumber: z.string().trim().max(120).nullable().optional(),
        issuer: z.string().trim().max(200).nullable().optional(),
        validUntil: date.nullable().optional(),
      })
      .parse(req.body);
    if (!uuid.safeParse(id).success) throw notFound('Supplier');
    const row = await one<{ id: string }>(
      db,
      `INSERT INTO supplier_certificate (supplier_id, site_id, cert_type, cert_number, issuer, valid_until, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [id, body.siteId ?? null, body.certType, body.certNumber ?? null, body.issuer ?? null, body.validUntil ?? null, auth.userId],
    );
    await audit(db, { actorId: auth.userId, action: 'supplier.certificate', entityType: 'supplier', entityId: id, summary: `Certificate ${body.certType} recorded`, requestId: req.id });
    return reply.code(201).send(row);
  });
}
