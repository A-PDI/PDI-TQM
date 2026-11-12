import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CLASSIFICATIONS,
  type Classification,
  DEFAULT_CLASSIFICATION,
  DEFAULT_PRECEDENCE,
  type DocumentRole,
  ROLE_OF,
  lineApplies,
  specificationMatches,
} from '../../shared/agreements.js';
import { audit } from '../audit.js';
import { requireCapability } from '../auth.js';
import { type Queryable, many, one, withTransaction } from '../db.js';
import { conflict, notFound, unprocessable } from '../errors.js';
import type { Services } from '../services.js';

/**
 * Controlled technical and quality specifications live in the Document Library. This module adds
 * their classification (configurable categories and applicability), their clauses, the revision
 * impact on executed agreements, and the resolver that tells operational records which agreement
 * documents and exact revisions govern a part from a supplier site.
 */
const uuid = z.string().uuid();
const words = z.array(z.string().trim().min(1).max(80)).max(30);

export interface ClassificationRow {
  documentId: string;
  number: string;
  title: string;
  classification: Classification;
  categoryCode: string | null;
  categoryLabel: string | null;
  productFamilies: string[];
  materials: string[];
  processes: string[];
  defaultPrecedence: number;
  scopeNote: string | null;
  version: number | null;
  explicit: boolean;
}

const CLASSIFIED_SELECT = `
  SELECT d.id AS "documentId", d.number, d.title, c.classification, c.category_code AS "categoryCode", sc.label AS "categoryLabel",
         coalesce(c.product_families, '{}') AS "productFamilies", coalesce(c.materials, '{}') AS materials, coalesce(c.processes, '{}') AS processes,
         c.default_precedence AS "defaultPrecedence", c.scope_note AS "scopeNote", c.version, (c.document_id IS NOT NULL) AS explicit
    FROM controlled_document d
    LEFT JOIN document_classification c ON c.document_id = d.id
    LEFT JOIN specification_category sc ON sc.code = c.category_code`;

function withDefaults(r: Omit<ClassificationRow, 'classification' | 'defaultPrecedence'> & { classification: Classification | null; defaultPrecedence: number | null }): ClassificationRow | null {
  const classification = r.classification ?? DEFAULT_CLASSIFICATION[r.number] ?? null;
  if (!classification) return null;
  return { ...r, classification, defaultPrecedence: r.defaultPrecedence ?? DEFAULT_PRECEDENCE[ROLE_OF[classification]] };
}

/** Every document that takes part in supplier agreements (explicitly classified, or SUP-03 by default). */
export async function classifiedDocuments(db: Queryable): Promise<ClassificationRow[]> {
  const rows = await many<Parameters<typeof withDefaults>[0]>(db, `${CLASSIFIED_SELECT} WHERE c.document_id IS NOT NULL OR d.number = ANY($1::text[]) ORDER BY d.number`, [Object.keys(DEFAULT_CLASSIFICATION)]);
  return rows.map(withDefaults).filter((r): r is ClassificationRow => r !== null);
}

export async function classificationOf(db: Queryable, documentId: string): Promise<ClassificationRow | null> {
  const r = await one<Parameters<typeof withDefaults>[0]>(db, `${CLASSIFIED_SELECT} WHERE d.id = $1`, [documentId]);
  return r ? withDefaults(r) : null;
}

/** The revision of a document in force on a date (Document Library rule: latest already effective). */
export async function revisionInForceById(db: Queryable, documentId: string, asOf: string) {
  return one<{ id: string; revisionLabel: string; sha256: string; effectiveFrom: string; fileId: string }>(
    db,
    `SELECT id, revision_label AS "revisionLabel", sha256, effective_from::text AS "effectiveFrom", file_id AS "fileId" FROM controlled_document_revision
      WHERE document_id = $1 AND effective_from <= $2 ORDER BY effective_from DESC, released_at DESC LIMIT 1`,
    [documentId, asOf],
  );
}

export async function clausesOf(db: Queryable, revisionIds: string[]) {
  if (!revisionIds.length) return new Map<string, Array<{ clauseRef: string; title: string }>>();
  const rows = await many<{ revision_id: string; clauseRef: string; title: string }>(
    db,
    `SELECT revision_id, clause_ref AS "clauseRef", title FROM document_clause WHERE revision_id = ANY($1::uuid[]) ORDER BY sort_order`,
    [revisionIds],
  );
  const out = new Map<string, Array<{ clauseRef: string; title: string }>>();
  for (const r of rows) out.set(r.revision_id, [...(out.get(r.revision_id) ?? []), { clauseRef: r.clauseRef, title: r.title }]);
  return out;
}

export interface ManifestLine {
  id: string;
  agreementId: string;
  agreementNumber: string;
  role: DocumentRole;
  action: 'INCORPORATE' | 'REPLACE' | 'REMOVE';
  documentRevisionId: string | null;
  baselineRevisionId: string | null;
  fileId: string | null;
  documentId: string | null;
  baselineId: string | null;
  documentNumber: string;
  title: string;
  revisionLabel: string;
  sha256: string;
  precedence: number;
  contractualRef: string;
  siteIds: string[];
  partIds: string[];
  productFamilies: string[];
  applicabilityNote: string | null;
}

const LINE_SELECT = `
  SELECT l.id, l.agreement_id AS "agreementId", a.number AS "agreementNumber", l.role, l.action, l.document_revision_id AS "documentRevisionId",
         l.baseline_revision_id AS "baselineRevisionId", l.file_id AS "fileId", r.document_id AS "documentId", br.baseline_id AS "baselineId",
         l.document_number AS "documentNumber", l.title, l.revision_label AS "revisionLabel", l.sha256, l.precedence, l.contractual_ref AS "contractualRef",
         l.applies_site_ids AS "siteIds", l.applies_part_ids AS "partIds", l.applies_product_families AS "productFamilies", l.applicability_note AS "applicabilityNote"
    FROM supplier_agreement_document l
    JOIN supplier_agreement a ON a.id = l.agreement_id
    LEFT JOIN controlled_document_revision r ON r.id = l.document_revision_id
    LEFT JOIN baseline_revision br ON br.id = l.baseline_revision_id`;

export async function manifestLines(db: Queryable, agreementId: string): Promise<ManifestLine[]> {
  return many<ManifestLine>(db, `${LINE_SELECT} WHERE l.agreement_id = $1 ORDER BY l.sort_order`, [agreementId]);
}

/** Identity of the document a line incorporates, independent of revision. */
export const lineIdentity = (l: Pick<ManifestLine, 'documentId' | 'baselineId' | 'fileId'>) => l.documentId ?? l.baselineId ?? l.fileId ?? '';

/**
 * The documents an executed agreement incorporates as of a date: its own manifest with its executed
 * amendments applied in order (an amendment line incorporates, replaces or removes a document).
 */
export async function effectiveLines(db: Queryable, agreementId: string, asOf: string): Promise<ManifestLine[]> {
  let lines = (await manifestLines(db, agreementId)).filter((l) => l.action === 'INCORPORATE');
  const amendments = await many<{ id: string }>(
    db,
    `SELECT id FROM supplier_agreement WHERE parent_id = $1 AND kind = 'AMENDMENT' AND status IN ('EXECUTED', 'SUPERSEDED') AND effective_from <= $2
      ORDER BY effective_from, executed_at`,
    [agreementId, asOf],
  );
  for (const a of amendments) {
    for (const l of await manifestLines(db, a.id)) {
      const id = lineIdentity(l);
      if (l.action !== 'INCORPORATE') lines = lines.filter((x) => lineIdentity(x) !== id);
      if (l.action !== 'REMOVE') lines.push(l);
    }
  }
  return lines.sort((a, b) => a.precedence - b.precedence);
}

/** Executed, unexpired agreements (with their amendments) in effect for a supplier site on a date. */
export async function agreementsInEffect(db: Queryable, supplierId: string, siteId: string | null, asOf: string) {
  return many<{ id: string; number: string; title: string; effectiveFrom: string; expiresOn: string | null }>(
    db,
    `SELECT a.id, a.number, a.title, a.effective_from::text AS "effectiveFrom", a.expires_on::text AS "expiresOn"
       FROM supplier_agreement a
      WHERE a.supplier_id = $1 AND a.kind IN ('AGREEMENT', 'RENEWAL') AND a.status = 'EXECUTED'
        AND a.effective_from <= $3 AND (a.expires_on IS NULL OR a.expires_on >= $3)
        AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM supplier_agreement_site s WHERE s.agreement_id = a.id AND s.site_id = $2))
      ORDER BY a.effective_from`,
    [supplierId, siteId, asOf],
  );
}

export interface GoverningSnapshot {
  asOf: string;
  agreements: Array<{ id: string; number: string; title: string }>;
  requirements: Array<{
    agreementNumber: string;
    role: DocumentRole;
    documentNumber: string;
    title: string;
    revisionLabel: string;
    documentRevisionId: string | null;
    baselineRevisionId: string | null;
    contractualRef: string;
    precedence: number;
    clauses: Array<{ clauseRef: string; title: string }>;
  }>;
}

/**
 * What governs a part from a supplier site on a date: the documents and exact revisions incorporated
 * by the executed agreements covering that site and applicable to that part. Without a site, every
 * covered site is considered. Null when none applies.
 */
export async function governingRequirements(db: Queryable, q: { supplierId: string | null; siteId: string | null; partId: string | null; asOf: string }): Promise<GoverningSnapshot | null> {
  if (!q.supplierId || !q.partId) return null;
  const part = await one<{ family: string | null; material: string | null; process: string | null }>(db, 'SELECT family, material, manufacturing_process AS process FROM company_part WHERE id = $1', [q.partId]);
  if (!part) return null;
  const agreements = await agreementsInEffect(db, q.supplierId, q.siteId, q.asOf);
  if (!agreements.length) return null;
  const requirements: GoverningSnapshot['requirements'] = [];
  for (const a of agreements) {
    const lines = await effectiveLines(db, a.id, q.asOf);
    const rules = await specificationRules(db, lines.map((l) => l.documentId).filter((x): x is string => !!x));
    for (const l of lines) {
      if (l.role === 'EXHIBIT' || !lineApplies(l, { siteId: q.siteId, partId: q.partId, family: part.family })) continue;
      // A specification line not limited to named parts governs only parts its own applicability rules match.
      const r = l.documentId ? rules.get(l.documentId) : undefined;
      if (l.role === 'SPECIFICATION' && !l.partIds.length && r && !specificationMatches(r, part)) continue;
      requirements.push({
        agreementNumber: a.number,
        role: l.role,
        documentNumber: l.documentNumber,
        title: l.title,
        revisionLabel: l.revisionLabel,
        documentRevisionId: l.documentRevisionId,
        baselineRevisionId: l.baselineRevisionId,
        contractualRef: l.contractualRef,
        precedence: l.precedence,
        clauses: [],
      });
    }
  }
  const clauses = await clausesOf(db, requirements.map((r) => r.documentRevisionId).filter((x): x is string => !!x));
  for (const r of requirements) r.clauses = r.documentRevisionId ? (clauses.get(r.documentRevisionId) ?? []) : [];
  return { asOf: q.asOf, agreements: agreements.map((a) => ({ id: a.id, number: a.number, title: a.title })), requirements };
}

/** Applicability rules of classified technical specifications that configure any (others are absent from the map). */
export async function specificationRules(db: Queryable, documentIds: string[]) {
  const rows = await many<{ document_id: string; productFamilies: string[]; materials: string[]; processes: string[] }>(
    db,
    `SELECT document_id, product_families AS "productFamilies", materials, processes FROM document_classification
      WHERE document_id = ANY($1::uuid[]) AND classification = 'TECHNICAL_SPECIFICATION'
        AND (cardinality(product_families) + cardinality(materials) + cardinality(processes)) > 0`,
    [documentIds],
  );
  return new Map(rows.map((r) => [r.document_id, r]));
}

/** SQL parameter for a snapshot column: SQL NULL (not JSON null) when nothing governs. */
export const snapshotJson = (g: GoverningSnapshot | null) => (g ? JSON.stringify(g) : null);

/**
 * Contractual coverage of an exact source, shown on the source page. Informational only: it is not
 * a source-approval gate and never changes a historical approval (no approved PDI policy for that).
 */
export async function sourceCoverage(db: Queryable, sourceId: string, asOf: string) {
  const s = await one<{ supplier_id: string; site_id: string; part_id: string }>(db, 'SELECT supplier_id, site_id, part_id FROM source WHERE id = $1', [sourceId]);
  if (!s) return null;
  const governing = await governingRequirements(db, { supplierId: s.supplier_id, siteId: s.site_id, partId: s.part_id, asOf });
  const pending = await many<{ number: string; status: string }>(
    db,
    `SELECT a.number, a.status FROM supplier_agreement a JOIN supplier_agreement_site x ON x.agreement_id = a.id
      WHERE a.supplier_id = $1 AND x.site_id = $2 AND a.status IN ('DRAFT', 'IN_REVIEW', 'AWAITING_EXECUTION') ORDER BY a.created_at`,
    [s.supplier_id, s.site_id],
  );
  return { informational: true, governing, pending };
}

/**
 * Releasing a new revision of a classified document never changes an executed package. It opens a
 * review for each executed agreement that incorporates an earlier revision of it.
 */
export async function openRevisionImpactReviews(tx: Queryable, documentId: string, newRevisionId: string, actorId: string, requestId?: string) {
  if (!(await classificationOf(tx, documentId))) return 0;
  const affected = await agreementsIncorporating(tx, documentId, newRevisionId);
  for (const a of affected) {
    await tx.query(
      `INSERT INTO work_item (kind, title, subject_type, subject_id, required_capability)
       VALUES ('AGREEMENT_REVISION_REVIEW', $1, 'SUPPLIER_AGREEMENT', $2, 'supplier.qualify')
       ON CONFLICT (kind, subject_type, subject_id) WHERE status = 'OPEN' DO NOTHING`,
      [`${a.number} (${a.supplierCode}): ${a.documentNumber} Rev ${a.incorporatedRevision} has a newer revision — review whether to amend`.slice(0, 200), a.agreementId],
    );
    await audit(tx, {
      actorId,
      action: 'agreement.revision_impact',
      entityType: 'supplier_agreement',
      entityId: a.agreementId,
      summary: `${a.documentNumber} has a new revision; ${a.number} still incorporates Rev ${a.incorporatedRevision} until amended`,
      requestId,
    });
  }
  return affected.length;
}

/** Executed agreements still incorporating a revision of the document other than the given one. */
export async function agreementsIncorporating(db: Queryable, documentId: string, otherThanRevisionId: string | null) {
  // Executed agreements (or their executed amendments) with a line for the document.
  const roots = await many<{ agreementId: string; number: string; supplierId: string; supplierCode: string; supplierName: string }>(
    db,
    `SELECT DISTINCT root.id AS "agreementId", root.number, s.id AS "supplierId", s.code AS "supplierCode", s.legal_name AS "supplierName"
       FROM supplier_agreement_document l
       JOIN controlled_document_revision r ON r.id = l.document_revision_id
       JOIN supplier_agreement a ON a.id = l.agreement_id
       JOIN supplier_agreement root ON root.id = CASE WHEN a.kind = 'AMENDMENT' THEN a.parent_id ELSE a.id END
       JOIN supplier s ON s.id = root.supplier_id
      WHERE r.document_id = $1 AND a.status = 'EXECUTED' AND root.status = 'EXECUTED'
      ORDER BY root.number`,
    [documentId],
  );
  const today = (await one<{ d: string }>(db, 'SELECT current_date::text AS d'))!.d;
  const out = [];
  // Judged on what each agreement incorporates now (amendments applied): one review per agreement, none once it is on the revision.
  for (const r of roots) {
    const current = (await effectiveLines(db, r.agreementId, today)).filter((l) => l.documentId === documentId);
    if (!current.length) continue;
    if (otherThanRevisionId && current.every((l) => l.documentRevisionId === otherThanRevisionId)) continue;
    const stale = current.find((l) => l.documentRevisionId !== otherThanRevisionId) ?? current[0]!;
    out.push({ ...r, documentNumber: stale.documentNumber, incorporatedRevision: stale.revisionLabel, revisionId: stale.documentRevisionId! });
  }
  return out;
}

/** Classification, clauses per revision and the agreements incorporating each revision, for the document page. */
export async function documentAgreementInfo(db: Queryable, documentId: string, revisionIds: string[]) {
  const clauses = await clausesOf(db, revisionIds);
  const incorporatedIn = await many(
    db,
    `SELECT l.document_revision_id AS "revisionId", l.revision_label AS "revisionLabel", a.id AS "agreementId", a.number, a.status, a.kind,
            a.expires_on::text AS "expiresOn", s.id AS "supplierId", s.code AS "supplierCode", s.legal_name AS "supplierName", l.contractual_ref AS "contractualRef"
       FROM supplier_agreement_document l JOIN supplier_agreement a ON a.id = l.agreement_id JOIN supplier s ON s.id = a.supplier_id
      WHERE l.document_revision_id = ANY($1::uuid[]) ORDER BY a.number`,
    [revisionIds],
  );
  return { classification: await classificationOf(db, documentId), clauses: Object.fromEntries(clauses), incorporatedIn };
}

export function registerSpecificationRoutes(app: FastifyInstance, svc: Services) {
  const { db, config } = svc;
  const today = async () => (await one<{ d: string }>(db, `SELECT (now() AT TIME ZONE $1)::date::text AS d`, [config.displayTimeZone]))!.d;

  app.get('/api/specification-categories', async (req) => {
    await requireCapability(db, req, 'records.read', { action: 'specifications.categories', consequential: false });
    return many(db, `SELECT code, label, description, active FROM specification_category ORDER BY active DESC, label`);
  });

  app.post('/api/specification-categories', async (req, reply) => {
    const auth = await requireCapability(db, req, 'documents.control', { action: 'specifications.category_create' });
    const body = z.object({ code: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,30}$/, 'Use capitals, digits and underscores, e.g. HEAT_TREATMENT'), label: z.string().trim().min(3).max(120), description: z.string().trim().max(500).nullable().optional() }).parse(req.body);
    if (await one(db, 'SELECT 1 FROM specification_category WHERE code = $1', [body.code])) throw conflict(`Category ${body.code} already exists`);
    await db.query(`INSERT INTO specification_category (code, label, description, created_by) VALUES ($1,$2,$3,$4)`, [body.code, body.label, body.description ?? null, auth.userId]);
    await audit(db, { actorId: auth.userId, action: 'specifications.category_create', entityType: 'specification_category', summary: `Specification category ${body.code} (${body.label}) added`, requestId: req.id });
    return reply.code(201).send({ code: body.code });
  });

  app.patch('/api/specification-categories/:code', async (req) => {
    const { code } = req.params as { code: string };
    const auth = await requireCapability(db, req, 'documents.control', { action: 'specifications.category_edit' });
    const body = z.object({ label: z.string().trim().min(3).max(120).optional(), description: z.string().trim().max(500).nullable().optional(), active: z.boolean().optional() }).parse(req.body);
    const res = await db.query(
      `UPDATE specification_category SET label = coalesce($2, label), description = CASE WHEN $3 THEN $4 ELSE description END, active = coalesce($5, active) WHERE code = $1`,
      [code, body.label ?? null, body.description !== undefined, body.description ?? null, body.active ?? null],
    );
    if (!res.rowCount) throw notFound('Specification category');
    await audit(db, { actorId: auth.userId, action: 'specifications.category_edit', entityType: 'specification_category', summary: `Specification category ${code} updated`, after: body, requestId: req.id });
    return { ok: true };
  });

  /** Classified documents with the revision in force and where they are incorporated. */
  app.get('/api/specifications', async (req) => {
    await requireCapability(db, req, 'records.read', { action: 'specifications.list', consequential: false });
    const asOf = await today();
    const rows = await classifiedDocuments(db);
    return Promise.all(
      rows.map(async (r) => ({
        ...r,
        current: await revisionInForceById(db, r.documentId, asOf),
        agreements: (await one<{ n: number }>(db, `SELECT count(DISTINCT l.agreement_id)::int AS n FROM supplier_agreement_document l JOIN controlled_document_revision x ON x.id = l.document_revision_id WHERE x.document_id = $1`, [r.documentId]))!.n,
      })),
    );
  });

  app.put('/api/documents/:id/classification', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'documents.control', { action: 'documents.classify', entityType: 'controlled_document', entityId: id });
    if (!uuid.safeParse(id).success) throw notFound('Document');
    const body = z
      .object({
        classification: z.enum(CLASSIFICATIONS),
        categoryCode: z.string().trim().max(32).nullable().optional(),
        productFamilies: words.default([]),
        materials: words.default([]),
        processes: words.default([]),
        defaultPrecedence: z.number().int().min(1).max(999).optional(),
        scopeNote: z.string().trim().max(2000).nullable().optional(),
      })
      .parse(req.body);
    if (body.classification === 'TECHNICAL_SPECIFICATION' && !body.categoryCode) throw unprocessable('A technical specification needs a category');
    if (body.classification !== 'TECHNICAL_SPECIFICATION' && body.categoryCode) throw unprocessable('Only technical specifications have a category');
    return withTransaction(db, async (tx) => {
      const doc = await one<{ number: string; kind: string }>(tx, 'SELECT number, kind FROM controlled_document WHERE id = $1 FOR UPDATE', [id]);
      if (!doc) throw notFound('Document');
      if (doc.kind === 'CONTINUATION') throw unprocessable('A continuation sheet is part of its form and is not classified on its own');
      if (body.categoryCode && !(await one(tx, 'SELECT 1 FROM specification_category WHERE code = $1 AND active', [body.categoryCode]))) throw unprocessable(`Unknown or retired category ${body.categoryCode}`);
      const precedence = body.defaultPrecedence ?? DEFAULT_PRECEDENCE[ROLE_OF[body.classification]];
      const before = await classificationOf(tx, id);
      await tx.query(
        `INSERT INTO document_classification (document_id, classification, category_code, product_families, materials, processes, default_precedence, scope_note, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (document_id) DO UPDATE SET classification = EXCLUDED.classification, category_code = EXCLUDED.category_code, product_families = EXCLUDED.product_families,
           materials = EXCLUDED.materials, processes = EXCLUDED.processes, default_precedence = EXCLUDED.default_precedence, scope_note = EXCLUDED.scope_note,
           updated_by = EXCLUDED.updated_by, updated_at = now(), version = document_classification.version + 1`,
        [id, body.classification, body.categoryCode ?? null, body.productFamilies, body.materials, body.processes, precedence, body.scopeNote ?? null, auth.userId],
      );
      await audit(tx, {
        actorId: auth.userId,
        action: 'documents.classify',
        entityType: 'controlled_document',
        entityId: id,
        summary: `${doc.number} classified as ${body.classification.toLowerCase().replaceAll('_', ' ')}${body.categoryCode ? ` (${body.categoryCode})` : ''}`,
        before: before ?? undefined,
        after: body,
        requestId: req.id,
      });
      return { ok: true };
    });
  });

  /** Clauses of an exact revision; recorded once (immutable) so citations stay stable. */
  app.post('/api/document-revisions/:id/clauses', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'documents.control', { action: 'documents.clauses', entityType: 'controlled_document_revision', entityId: id });
    if (!uuid.safeParse(id).success) throw notFound('Revision');
    const body = z.object({ clauses: z.array(z.object({ clauseRef: z.string().trim().min(1).max(40), title: z.string().trim().min(2).max(300) })).min(1).max(300) }).parse(req.body);
    return withTransaction(db, async (tx) => {
      const rev = await one<{ number: string; revision_label: string }>(tx, `SELECT d.number, r.revision_label FROM controlled_document_revision r JOIN controlled_document d ON d.id = r.document_id WHERE r.id = $1`, [id]);
      if (!rev) throw notFound('Revision');
      const existing = (await one<{ n: number }>(tx, 'SELECT coalesce(max(sort_order), 0)::int AS n FROM document_clause WHERE revision_id = $1', [id]))!.n;
      const refs = new Set<string>();
      for (const c of body.clauses) {
        if (refs.has(c.clauseRef)) throw unprocessable(`Clause ${c.clauseRef} is listed twice`);
        refs.add(c.clauseRef);
        if (await one(tx, 'SELECT 1 FROM document_clause WHERE revision_id = $1 AND clause_ref = $2', [id, c.clauseRef])) throw conflict(`Clause ${c.clauseRef} is already recorded for ${rev.number} Rev ${rev.revision_label}`);
      }
      let order = existing;
      for (const c of body.clauses) {
        order += 1;
        await tx.query(`INSERT INTO document_clause (revision_id, clause_ref, title, sort_order, created_by) VALUES ($1,$2,$3,$4,$5)`, [id, c.clauseRef, c.title, order, auth.userId]);
      }
      await audit(tx, { actorId: auth.userId, action: 'documents.clauses', entityType: 'controlled_document_revision', entityId: id, summary: `${body.clauses.length} clause(s) recorded for ${rev.number} Rev ${rev.revision_label}`, requestId: req.id });
      return reply.code(201).send({ count: body.clauses.length });
    });
  });

  /** Where a newer revision leaves executed agreements: suppliers, sites, parts, acknowledgments and sources to review. */
  app.get('/api/documents/:id/impact', async (req) => {
    await requireCapability(db, req, 'records.read', { action: 'documents.impact', consequential: false });
    const { id } = req.params as { id: string };
    if (!uuid.safeParse(id).success) throw notFound('Document');
    const asOf = await today();
    const current = await revisionInForceById(db, id, asOf);
    const latest = await one<{ id: string; revisionLabel: string }>(db, `SELECT id, revision_label AS "revisionLabel" FROM controlled_document_revision WHERE document_id = $1 ORDER BY effective_from DESC, released_at DESC LIMIT 1`, [id]);
    if (!latest) throw notFound('Document');
    const affected = await agreementsIncorporating(db, id, latest.id);
    const items = [];
    for (const a of affected) {
      const sites = await many<{ id: string; code: string; name: string }>(db, `SELECT ss.id, ss.code, ss.name FROM supplier_agreement_site x JOIN supplier_site ss ON ss.id = x.site_id WHERE x.agreement_id = $1 ORDER BY ss.code`, [a.agreementId]);
      const lines = (await effectiveLines(db, a.agreementId, asOf)).filter((l) => l.documentRevisionId === a.revisionId);
      const cls = await classificationOf(db, id);
      const rules = cls && cls.classification === 'TECHNICAL_SPECIFICATION' && (cls.productFamilies.length || cls.materials.length || cls.processes.length) ? cls : null;
      const candidates = await many<{ id: string; partId: string; partNumber: string; site: string; siteId: string; family: string | null; material: string | null; process: string | null }>(
        db,
        `SELECT s.id, p.id AS "partId", p.part_number AS "partNumber", ss.name AS site, ss.id AS "siteId", p.family, p.material, p.manufacturing_process AS process
           FROM source s JOIN company_part p ON p.id = s.part_id JOIN supplier_site ss ON ss.id = s.site_id
          WHERE s.supplier_id = $1 AND s.site_id = ANY($2::uuid[]) ORDER BY p.part_number`,
        [a.supplierId, sites.map((s) => s.id)],
      );
      // Sources under the incorporated line's applicability and, for a specification, its own applicability rules.
      const sources = candidates
        .filter((c) => lines.some((l) => lineApplies(l, { siteId: c.siteId, partId: c.partId, family: c.family })))
        .filter((c) => !rules || specificationMatches(rules, { family: c.family, material: c.material, process: c.process }))
        .map((c) => ({ id: c.id, partId: c.partId, partNumber: c.partNumber, site: c.site }));
      const partIds = [...new Set([...lines.flatMap((l) => l.partIds), ...sources.map((c) => c.partId)])];
      const families = [...new Set(lines.flatMap((l) => l.productFamilies))];
      const acks = await many<{ id: string; response: string; revisionLabel: string }>(
        db,
        `SELECT k.id, k.response, r.revision_label AS "revisionLabel" FROM supplier_acknowledgment k JOIN controlled_document_revision r ON r.id = k.document_revision_id
          WHERE k.supplier_id = $1 AND r.document_id = $2 ORDER BY k.sent_at DESC`,
        [a.supplierId, id],
      );
      items.push({
        ...a,
        sites,
        productFamilies: families,
        parts: partIds.length ? await many(db, 'SELECT id, part_number AS "partNumber" FROM company_part WHERE id = ANY($1::uuid[]) ORDER BY part_number', [partIds]) : [],
        sources,
        acknowledgments: acks,
        newRevisionAcknowledged: acks.some((k) => k.revisionLabel === latest.revisionLabel && k.response === 'ACKNOWLEDGED'),
        review: await one(db, `SELECT id, status FROM work_item WHERE kind = 'AGREEMENT_REVISION_REVIEW' AND subject_id = $1 ORDER BY created_at DESC LIMIT 1`, [a.agreementId]),
      });
    }
    return { current, latest, affected: items };
  });

  /** Governing specifications and agreements of a part, per exact source (informational). */
  app.get('/api/parts/:id/specifications', async (req) => {
    await requireCapability(db, req, 'records.read', { action: 'part.specifications', consequential: false });
    const { id } = req.params as { id: string };
    if (!uuid.safeParse(id).success) throw notFound('Part');
    const part = await one<{ family: string | null; material: string | null; process: string | null }>(db, 'SELECT family, material, manufacturing_process AS process FROM company_part WHERE id = $1', [id]);
    if (!part) throw notFound('Part');
    const asOf = await today();
    const sources = await many<{ id: string; supplierId: string; supplier: string; siteId: string; site: string }>(
      db,
      `SELECT s.id, sup.id AS "supplierId", sup.legal_name AS supplier, ss.id AS "siteId", ss.name AS site FROM source s
         JOIN supplier sup ON sup.id = s.supplier_id JOIN supplier_site ss ON ss.id = s.site_id WHERE s.part_id = $1 ORDER BY sup.legal_name, ss.name`,
      [id],
    );
    return {
      asOf,
      classification: part,
      sources: await Promise.all(sources.map(async (s) => ({ ...s, governing: await governingRequirements(db, { supplierId: s.supplierId, siteId: s.siteId, partId: id, asOf }) }))),
    };
  });

  /** Applicability attributes of a part beside its product family (master data). */
  app.put('/api/parts/:id/classification', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'masterdata.edit', { action: 'part.classify', entityType: 'company_part', entityId: id });
    if (!uuid.safeParse(id).success) throw notFound('Part');
    const text = z.string().trim().max(80).nullable().optional();
    const body = z.object({ family: text, material: text, manufacturingProcess: text }).parse(req.body);
    const before = await one<{ part_number: string; family: string | null; material: string | null; manufacturing_process: string | null }>(db, 'SELECT part_number, family, material, manufacturing_process FROM company_part WHERE id = $1', [id]);
    if (!before) throw notFound('Part');
    await db.query(
      `UPDATE company_part SET family = CASE WHEN $2 THEN $3 ELSE family END, material = CASE WHEN $4 THEN $5 ELSE material END,
         manufacturing_process = CASE WHEN $6 THEN $7 ELSE manufacturing_process END WHERE id = $1`,
      [id, body.family !== undefined, body.family || null, body.material !== undefined, body.material || null, body.manufacturingProcess !== undefined, body.manufacturingProcess || null],
    );
    await audit(db, { actorId: auth.userId, action: 'part.classify', entityType: 'company_part', entityId: id, summary: `${before.part_number} family/material/process updated`, before, after: body, requestId: req.id });
    return { ok: true };
  });
}
