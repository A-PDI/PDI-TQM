import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AGREEMENT_STATE_TEXT,
  type AgreementKind,
  type AgreementStatus,
  type Conflict,
  type ConflictLine,
  DEFAULT_PRECEDENCE,
  DOCUMENT_ROLES,
  type DocumentRole,
  RENEWAL_NOTICE_DAYS,
  ROLE_OF,
  agreementState,
  detectConflicts,
  specificationMatches,
} from '../../shared/agreements.js';
import { canonicalJson } from '../../shared/forms.js';
import { audit } from '../audit.js';
import { auditedDenial, has, recheckCapability, requireAuth, requireCapability } from '../auth.js';
import { type Queryable, many, one, withTransaction } from '../db.js';
import { conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { nextRecordNumber } from '../numbering.js';
import { sha256 } from '../controlled/pdf-text.js';
import { todayIn } from '../controlled/service.js';
import type { Services } from '../services.js';
import { AGREEMENT_SUBJECT, PACKAGE_NOTICE, type PackageLine, type PackageSnapshot, type PackageStage, appliesText, queuePackage, renderPackage, scheduleContent, scheduleDigest } from './package.js';
import { type ManifestLine, classificationOf, classifiedDocuments, effectiveLines, lineIdentity, manifestLines, revisionInForceById } from './specifications.js';

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date in YYYY-MM-DD form');
const words = z.array(z.string().trim().min(1).max(80)).max(30);
const reason = z.string().trim().min(5).max(2000);
const OPEN_STATUSES = ['DRAFT', 'IN_REVIEW', 'AWAITING_EXECUTION'] as const;

export interface AgreementRow {
  id: string;
  number: string;
  supplierId: string;
  kind: AgreementKind;
  parentId: string | null;
  title: string;
  legalEntity: string;
  productFamilies: string[];
  changeSummary: string | null;
  exceptions: string | null;
  effectiveFrom: string | null;
  expiresOn: string | null;
  status: AgreementStatus;
  cycle: number;
  manifestSha256: string | null;
  preparedBy: string;
  preparedByName: string;
  createdAt: string;
  submittedBy: string | null;
  submittedAt: string | null;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: string | null;
  conflictResolution: string | null;
  executedAt: string | null;
  executedFileId: string | null;
  supersededById: string | null;
  supersededAt: string | null;
  terminatedAt: string | null;
  terminationReason: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  version: number;
}

const AGREEMENT_SELECT = `
  SELECT a.id, a.number, a.supplier_id AS "supplierId", a.kind, a.parent_id AS "parentId", a.title, a.legal_entity AS "legalEntity",
         a.product_families AS "productFamilies", a.change_summary AS "changeSummary", a.exceptions, a.effective_from::text AS "effectiveFrom",
         a.expires_on::text AS "expiresOn", a.status, a.cycle, a.manifest_sha256 AS "manifestSha256", a.prepared_by AS "preparedBy",
         pu.display_name AS "preparedByName", a.created_at AS "createdAt", a.submitted_by AS "submittedBy", a.submitted_at AS "submittedAt",
         a.approved_by AS "approvedBy", au.display_name AS "approvedByName", a.approved_at AS "approvedAt", a.conflict_resolution AS "conflictResolution",
         a.executed_at AS "executedAt", a.executed_file_id AS "executedFileId", a.superseded_by_id AS "supersededById", a.superseded_at AS "supersededAt",
         a.terminated_at AS "terminatedAt", a.termination_reason AS "terminationReason", a.cancelled_at AS "cancelledAt", a.cancel_reason AS "cancelReason", a.version
    FROM supplier_agreement a
    JOIN app_user pu ON pu.id = a.prepared_by
    LEFT JOIN app_user au ON au.id = a.approved_by`;

export async function loadAgreement(db: Queryable, id: string, lock = false): Promise<AgreementRow | null> {
  if (!uuid.safeParse(id).success) return null;
  if (lock) await db.query('SELECT 1 FROM supplier_agreement WHERE id = $1 FOR UPDATE', [id]);
  return one<AgreementRow>(db, `${AGREEMENT_SELECT} WHERE a.id = $1`, [id]);
}

const sitesOf = (db: Queryable, agreementId: string) =>
  many<{ id: string; code: string; name: string; country: string | null }>(
    db,
    `SELECT s.id, s.code, s.name, s.country FROM supplier_agreement_site x JOIN supplier_site s ON s.id = x.site_id WHERE x.agreement_id = $1 ORDER BY s.code`,
    [agreementId],
  );

async function closeWork(tx: Queryable, agreementId: string, kinds: string[], actorId: string, why: string, status: 'DONE' | 'CANCELLED' = 'DONE') {
  await tx.query(
    `UPDATE work_item SET status = $4, closed_at = now(), closed_by = $3, closed_reason = $5
      WHERE subject_type = 'SUPPLIER_AGREEMENT' AND subject_id = $1 AND kind = ANY($2::text[]) AND status = 'OPEN'`,
    [agreementId, kinds, actorId, status, why],
  );
}

async function openWork(tx: Queryable, agreementId: string, kind: string, title: string, capability: string) {
  await tx.query(
    `INSERT INTO work_item (kind, title, subject_type, subject_id, required_capability) VALUES ($1, $2, 'SUPPLIER_AGREEMENT', $3, $4)
     ON CONFLICT (kind, subject_type, subject_id) WHERE status = 'OPEN' DO NOTHING`,
    [kind, title.slice(0, 200), agreementId, capability],
  );
}

/** A standalone SUP-03 controlled record still open for this supplier (the package path would duplicate it). */
async function openStandaloneSqa(db: Queryable, supplierId: string) {
  return one<{ number: string }>(db, `SELECT number FROM controlled_record WHERE type_code = 'SUP-03' AND entity_type = 'SUPPLIER' AND entity_id = $1 AND status IN ('DRAFT', 'SUBMITTED') LIMIT 1`, [supplierId]);
}

/** An agreement (open or executed) that incorporates SUP-03 for the supplier: its approval and execution path for the SQA. */
export async function agreementCarryingSqa(db: Queryable, supplierId: string) {
  return one<{ number: string; status: string }>(
    db,
    `SELECT a.number, a.status FROM supplier_agreement a
      WHERE a.supplier_id = $1 AND a.status IN ('DRAFT', 'IN_REVIEW', 'AWAITING_EXECUTION', 'EXECUTED')
        AND EXISTS (SELECT 1 FROM supplier_agreement_document l WHERE l.agreement_id = a.id AND l.document_number = 'SUP-03' AND l.action <> 'REMOVE')
      ORDER BY a.created_at DESC LIMIT 1`,
    [supplierId],
  );
}

// ---------------------------------------------------------------- manifest lines
const lineInput = z
  .object({
    role: z.enum(DOCUMENT_ROLES),
    action: z.enum(['INCORPORATE', 'REPLACE', 'REMOVE']).default('INCORPORATE'),
    documentRevisionId: uuid.nullable().optional(),
    baselineRevisionId: uuid.nullable().optional(),
    fileId: uuid.nullable().optional(),
    precedence: z.number().int().min(1).max(999).nullable().optional(),
    contractualRef: z.string().trim().min(1).max(80),
    siteIds: z.array(uuid).max(50).default([]),
    partIds: z.array(uuid).max(500).default([]),
    productFamilies: words.default([]),
    applicabilityNote: z.string().trim().max(1000).nullable().optional(),
  })
  .refine((l) => [l.documentRevisionId, l.baselineRevisionId, l.fileId].filter(Boolean).length === 1, 'Each line incorporates exactly one document revision, part schedule or exhibit file');
type LineInput = z.infer<typeof lineInput>;

interface ResolvedLine {
  role: DocumentRole;
  action: LineInput['action'];
  documentRevisionId: string | null;
  baselineRevisionId: string | null;
  fileId: string | null;
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

async function resolveLine(tx: Queryable, a: AgreementRow, siteIds: Set<string>, l: LineInput, today: string): Promise<ResolvedLine> {
  if (a.kind !== 'AMENDMENT' && l.action !== 'INCORPORATE') throw unprocessable('Only an amendment replaces or removes documents');
  for (const s of l.siteIds) if (!siteIds.has(s)) throw unprocessable('A line can only apply to sites the agreement covers');
  if (l.partIds.length) {
    const n = (await one<{ n: number }>(tx, 'SELECT count(*)::int AS n FROM company_part WHERE id = ANY($1::uuid[])', [l.partIds]))!.n;
    if (n !== new Set(l.partIds).size) throw unprocessable('A part on the line does not exist');
  }
  const base = { action: l.action, contractualRef: l.contractualRef, siteIds: l.siteIds, partIds: l.partIds, productFamilies: l.productFamilies, applicabilityNote: l.applicabilityNote ?? null };
  if (l.documentRevisionId) {
    const r = await one<{ document_id: string; number: string; title: string; revision_label: string; sha256: string; effective_from: string }>(
      tx,
      `SELECT r.document_id, d.number, d.title, r.revision_label, r.sha256, r.effective_from::text FROM controlled_document_revision r JOIN controlled_document d ON d.id = r.document_id WHERE r.id = $1`,
      [l.documentRevisionId],
    );
    if (!r) throw unprocessable('Document revision not found');
    const cls = await classificationOf(tx, r.document_id);
    if (!cls) throw unprocessable(`${r.number} is not classified for supplier agreements; Document Control classifies it in the Document Library`);
    const role = ROLE_OF[cls.classification];
    if (l.role !== role) throw unprocessable(`${r.number} is classified as ${role.toLowerCase().replaceAll('_', ' ')}, not ${l.role.toLowerCase().replaceAll('_', ' ')}`);
    if (l.action !== 'REMOVE') {
      const inForce = await revisionInForceById(tx, r.document_id, today);
      if (r.effective_from <= today && inForce && inForce.id !== l.documentRevisionId) {
        throw unprocessable(`${r.number} Rev ${r.revision_label} is superseded by Rev ${inForce.revisionLabel}; incorporate the revision in force`);
      }
    }
    if (r.number === 'SUP-03' && l.action !== 'REMOVE') {
      const open = await openStandaloneSqa(tx, a.supplierId);
      if (open) throw conflict(`SUP-03 record ${open.number} is open for this supplier; complete or void it before incorporating SUP-03 into an agreement`);
    }
    return { ...base, role, documentRevisionId: l.documentRevisionId, baselineRevisionId: null, fileId: null, documentNumber: r.number, title: r.title, revisionLabel: r.revision_label, sha256: r.sha256, precedence: l.precedence ?? cls.defaultPrecedence };
  }
  if (l.baselineRevisionId) {
    if (l.role !== 'PART_SCHEDULE') throw unprocessable('A technical baseline revision is incorporated as a part-specific schedule');
    const r = await one<{ status: string; revision_label: string; part_id: string; part_number: string; title: string }>(
      tx,
      `SELECT br.status, br.revision_label, b.part_id, p.part_number, b.title FROM baseline_revision br JOIN technical_baseline b ON b.id = br.baseline_id JOIN company_part p ON p.id = b.part_id WHERE br.id = $1`,
      [l.baselineRevisionId],
    );
    if (!r) throw unprocessable('Part schedule (baseline revision) not found');
    if (l.action !== 'REMOVE' && r.status !== 'RELEASED') throw unprocessable(`${r.part_number} Rev ${r.revision_label} is ${r.status.toLowerCase()}; only a released baseline revision can be incorporated`);
    if (l.partIds.some((p) => p !== r.part_id)) throw unprocessable(`A part schedule applies only to its own part (${r.part_number})`);
    return {
      ...base,
      role: 'PART_SCHEDULE',
      partIds: [r.part_id],
      documentRevisionId: null,
      baselineRevisionId: l.baselineRevisionId,
      fileId: null,
      documentNumber: r.part_number,
      title: r.title,
      revisionLabel: r.revision_label,
      sha256: await scheduleDigest(tx, l.baselineRevisionId),
      precedence: l.precedence ?? DEFAULT_PRECEDENCE.PART_SCHEDULE,
    };
  }
  if (l.role !== 'EXHIBIT') throw unprocessable('An attached file is incorporated as an exhibit');
  const f = await one<{ original_name: string | null; sha256: string }>(
    tx,
    `SELECT f.original_name, f.sha256 FROM evidence_link e JOIN file_object f ON f.id = e.file_id
      WHERE e.file_id = $1 AND e.entity_type = 'SUPPLIER_AGREEMENT' AND e.entity_id = $2 AND e.unlinked_at IS NULL AND f.status = 'AVAILABLE'`,
    [l.fileId, a.id],
  );
  if (!f) throw unprocessable('Attach the exhibit to this agreement first; exhibits are files held on the agreement');
  return { ...base, role: 'EXHIBIT', documentRevisionId: null, baselineRevisionId: null, fileId: l.fileId!, documentNumber: 'Exhibit', title: f.original_name ?? 'Exhibit', revisionLabel: '-', sha256: f.sha256, precedence: l.precedence ?? DEFAULT_PRECEDENCE.EXHIBIT };
}

/** The lines conflict detection and package rendering see: for an amendment, its parent's effective lines with the amendment applied. */
async function resultingLines(db: Queryable, a: AgreementRow, today: string): Promise<{ lines: ManifestLine[]; own: Set<string> }> {
  const ownLines = await manifestLines(db, a.id);
  const own = new Set(ownLines.map((l) => l.id));
  if (a.kind !== 'AMENDMENT' || !a.parentId) return { lines: ownLines.filter((l) => l.action !== 'REMOVE'), own };
  let lines = await effectiveLines(db, a.parentId, today);
  for (const l of ownLines) {
    const id = lineIdentity(l);
    if (l.action !== 'INCORPORATE') lines = lines.filter((x) => lineIdentity(x) !== id);
    if (l.action !== 'REMOVE') lines.push(l);
  }
  return { lines, own };
}

export async function agreementConflicts(db: Queryable, a: AgreementRow, today: string): Promise<Conflict[]> {
  const { lines, own } = await resultingLines(db, a, today);
  const docIds = lines.map((l) => l.documentId).filter((x): x is string => !!x);
  const cats = new Map(
    (await many<{ document_id: string; category_code: string | null }>(db, 'SELECT document_id, category_code FROM document_classification WHERE document_id = ANY($1::uuid[])', [docIds])).map((r) => [r.document_id, r.category_code]),
  );
  const input: ConflictLine[] = lines.map((l) => ({
    key: l.id,
    identity: lineIdentity(l),
    role: l.role,
    documentNumber: l.documentNumber,
    revisionLabel: l.revisionLabel,
    precedence: l.precedence,
    category: l.documentId ? (cats.get(l.documentId) ?? null) : null,
    siteIds: l.siteIds,
    partIds: l.partIds,
    productFamilies: l.productFamilies,
  }));
  return detectConflicts(input).filter((c) => c.keys.some((k) => own.has(k)));
}

/** Lines whose document has a newer revision in force, or whose part schedule has a newer release. */
async function staleLines(db: Queryable, lines: ManifestLine[], today: string) {
  const out: Array<{ lineId: string; message: string }> = [];
  for (const l of lines) {
    if (l.action === 'REMOVE') continue;
    if (l.documentId) {
      const cur = await revisionInForceById(db, l.documentId, today);
      if (cur && cur.id !== l.documentRevisionId && cur.revisionLabel !== l.revisionLabel) out.push({ lineId: l.id, message: `${l.documentNumber} Rev ${cur.revisionLabel} is now in force (line incorporates Rev ${l.revisionLabel})` });
    } else if (l.baselineId) {
      const cur = await one<{ id: string; revision_label: string }>(db, `SELECT id, revision_label FROM baseline_revision WHERE baseline_id = $1 AND status = 'RELEASED' ORDER BY released_at DESC LIMIT 1`, [l.baselineId]);
      if (cur && cur.id !== l.baselineRevisionId) out.push({ lineId: l.id, message: `${l.documentNumber} schedule Rev ${cur.revision_label} is now released (line incorporates Rev ${l.revisionLabel})` });
    }
  }
  return out;
}

/** The canonical manifest the approval freezes: header plus every line, exact revisions and hashes. */
async function manifestOf(db: Queryable, a: AgreementRow) {
  const sites = await sitesOf(db, a.id);
  const lines = await manifestLines(db, a.id);
  return {
    number: a.number,
    kind: a.kind,
    supplierId: a.supplierId,
    parentId: a.parentId,
    legalEntity: a.legalEntity,
    title: a.title,
    productFamilies: a.productFamilies,
    exceptions: a.exceptions,
    changeSummary: a.changeSummary,
    expiresOn: a.expiresOn,
    siteIds: sites.map((s) => s.id).sort(),
    lines: lines.map((l) => ({
      role: l.role,
      action: l.action,
      documentRevisionId: l.documentRevisionId,
      baselineRevisionId: l.baselineRevisionId,
      fileId: l.fileId,
      documentNumber: l.documentNumber,
      revisionLabel: l.revisionLabel,
      sha256: l.sha256,
      precedence: l.precedence,
      contractualRef: l.contractualRef,
      siteIds: [...l.siteIds].sort(),
      partIds: [...l.partIds].sort(),
      productFamilies: l.productFamilies,
      applicabilityNote: l.applicabilityNote,
    })),
  };
}

/** Builds the frozen content of a package edition (or a draft preview). */
export async function packageSnapshot(db: Queryable, a: AgreementRow, stage: PackageStage, today: string): Promise<Omit<PackageSnapshot, 'edition'>> {
  const supplier = (await one<{ code: string }>(db, 'SELECT code FROM supplier WHERE id = $1', [a.supplierId]))!;
  const sites = await sitesOf(db, a.id);
  const siteCode = new Map(sites.map((s) => [s.id, s.code]));
  const lines = await manifestLines(db, a.id);
  const partIds = [...new Set(lines.flatMap((l) => l.partIds))];
  const partNo = new Map((await many<{ id: string; part_number: string }>(db, 'SELECT id, part_number FROM company_part WHERE id = ANY($1::uuid[])', [partIds])).map((p) => [p.id, p.part_number]));
  const pkgLines: PackageLine[] = [];
  for (const l of lines) {
    let source: PackageLine['source'];
    if (l.documentRevisionId) source = { kind: 'DOCUMENT', revisionId: l.documentRevisionId };
    else if (l.baselineRevisionId) source = { kind: 'SCHEDULE', baselineRevisionId: l.baselineRevisionId, schedule: await scheduleContent(db, l.baselineRevisionId) };
    else {
      const f = (await one<{ mime_type: string }>(db, 'SELECT mime_type FROM file_object WHERE id = $1', [l.fileId]))!;
      source = { kind: 'EXHIBIT', fileId: l.fileId!, mime: f.mime_type };
    }
    pkgLines.push({
      key: l.id,
      role: l.role,
      action: l.action,
      documentNumber: l.documentNumber,
      title: l.title,
      revisionLabel: l.revisionLabel,
      sha256: l.sha256,
      precedence: l.precedence,
      contractualRef: l.contractualRef,
      appliesTo: appliesText({ siteCodes: l.siteIds.map((s) => siteCode.get(s) ?? s), partNumbers: l.partIds.map((p) => partNo.get(p) ?? p), productFamilies: l.productFamilies }),
      source,
    });
  }
  const sigs = await many<{ role: PackageSnapshot['signatures'][number]['role']; mode: string; name: string; title: string | null; signedOn: string; reference: string | null }>(
    db,
    `SELECT role, mode, signer_name AS name, signer_title AS title, signed_on::text AS "signedOn", reference FROM supplier_agreement_signature s WHERE agreement_id = $1 AND cycle = $2 ORDER BY created_at, array_position(ARRAY['PDI_APPROVAL','LEGAL_REVIEW','PDI_SIGNATORY','SUPPLIER_SIGNATORY'], s.role)`,
    [a.id, a.cycle],
  );
  const parent = a.parentId ? await one<{ number: string }>(db, 'SELECT number FROM supplier_agreement WHERE id = $1', [a.parentId]) : null;
  const executedCopy = a.executedFileId ? await one<{ sha256: string }>(db, 'SELECT sha256 FROM file_object WHERE id = $1', [a.executedFileId]) : null;
  return {
    schemaVersion: 1,
    stage,
    number: a.number,
    kind: a.kind,
    title: a.title,
    parentNumber: parent?.number ?? null,
    supplier: { code: supplier.code, legalEntity: a.legalEntity },
    sites: sites.map((s) => ({ code: s.code, name: s.name, country: s.country })),
    productFamilies: a.productFamilies,
    effectiveFrom: a.effectiveFrom,
    expiresOn: a.expiresOn,
    exceptions: a.exceptions,
    changeSummary: a.changeSummary,
    manifestSha256: a.manifestSha256,
    conflicts: (await agreementConflicts(db, a, today)).map((c) => c.message),
    conflictResolution: a.conflictResolution,
    lines: pkgLines,
    signatures: sigs,
    executedCopySha256: executedCopy?.sha256 ?? null,
    generatedAt: new Date().toISOString(),
    notice: PACKAGE_NOTICE,
  };
}

/** Recommended lines for a draft: master agreement, SUP-03, matching specifications and released part schedules of the covered sites. */
async function recommendations(db: Queryable, a: AgreementRow, today: string) {
  const sites = await sitesOf(db, a.id);
  const siteIds = sites.map((s) => s.id);
  const present = await manifestLines(db, a.id);
  const has = (pred: (l: ManifestLine) => boolean) => present.some(pred);
  const out: Array<{ role: DocumentRole; documentRevisionId?: string; baselineRevisionId?: string; documentNumber: string; title: string; revisionLabel: string; precedence: number; reason: string; partIds: string[]; present: boolean; contractualRef: string }> = [];
  const parts = await many<{ id: string; part_number: string; family: string | null; material: string | null; process: string | null; site_id: string; baseline_revision_id: string | null; revision_label: string | null; status: string | null; baseline_title: string | null }>(
    db,
    `SELECT DISTINCT ON (p.id, s.site_id) p.id, p.part_number, p.family, p.material, p.manufacturing_process AS process, s.site_id,
            br.id AS baseline_revision_id, br.revision_label, br.status, b.title AS baseline_title
       FROM source s JOIN company_part p ON p.id = s.part_id
       LEFT JOIN baseline_revision br ON br.id = s.baseline_revision_id
       LEFT JOIN technical_baseline b ON b.id = br.baseline_id
      WHERE s.supplier_id = $1 AND s.site_id = ANY($2::uuid[])
      ORDER BY p.id, s.site_id, s.created_at DESC`,
    [a.supplierId, siteIds],
  );
  let specRef = 0;
  for (const d of await classifiedDocuments(db)) {
    const rev = await revisionInForceById(db, d.documentId, today);
    if (!rev) continue;
    const role = ROLE_OF[d.classification];
    let why: string | null = null;
    let partIds: string[] = [];
    if (d.classification === 'MASTER_AGREEMENT') why = 'Master Supplier Agreement in force';
    else if (d.classification === 'QUALITY_AGREEMENT') why = 'Supplier Quality Agreement in force';
    else {
      const matching = parts.filter((p) => specificationMatches(d, { family: p.family, material: p.material, process: p.process }));
      const familyMatch = a.productFamilies.some((f) => d.productFamilies.map((x) => x.toUpperCase()).includes(f.toUpperCase()));
      if (!matching.length && !familyMatch) continue;
      partIds = [...new Set(matching.map((p) => p.id))];
      why = matching.length ? `Applies to ${[...new Set(matching.map((p) => p.part_number))].join(', ')} supplied from the covered sites` : `Applies to product family ${a.productFamilies.join(', ')}`;
    }
    specRef += role === 'SPECIFICATION' ? 1 : 0;
    out.push({
      role,
      documentRevisionId: rev.id,
      documentNumber: d.number,
      title: d.title,
      revisionLabel: rev.revisionLabel,
      precedence: d.defaultPrecedence,
      reason: why,
      partIds,
      present: has((l) => l.documentRevisionId === rev.id),
      contractualRef: role === 'MASTER_AGREEMENT' ? 'Agreement' : role === 'QUALITY_AGREEMENT' ? 'Schedule A' : `Schedule B${specRef}`,
    });
  }
  let schedRef = 0;
  for (const p of parts) {
    if (!p.baseline_revision_id || p.status !== 'RELEASED') continue;
    if (out.some((o) => o.baselineRevisionId === p.baseline_revision_id)) continue;
    schedRef += 1;
    out.push({
      role: 'PART_SCHEDULE',
      baselineRevisionId: p.baseline_revision_id,
      documentNumber: p.part_number,
      title: p.baseline_title ?? p.part_number,
      revisionLabel: p.revision_label ?? '',
      precedence: DEFAULT_PRECEDENCE.PART_SCHEDULE,
      reason: 'Released technical baseline governing an exact source at a covered site',
      partIds: [p.id],
      present: has((l) => l.baselineRevisionId === p.baseline_revision_id),
      contractualRef: `Annex A${schedRef}`,
    });
  }
  return out;
}

export function registerAgreementRoutes(app: FastifyInstance, svc: Services) {
  const { db, config } = svc;
  const today = (q: Queryable = db) => todayIn(q, config.displayTimeZone);

  const draftOnly = (a: AgreementRow) => {
    if (a.status !== 'DRAFT') throw conflict(`${a.number} is ${AGREEMENT_STATE_TEXT[a.status].toLowerCase()}; its contents can only change in draft`);
  };

  // ------------------------------------------------------------------ create
  app.post('/api/suppliers/:id/agreements', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'supplier.manage', { action: 'agreement.create', entityType: 'supplier', entityId: id });
    if (!uuid.safeParse(id).success) throw notFound('Supplier');
    const body = z
      .object({
        title: z.string().trim().min(3).max(200),
        siteIds: z.array(uuid).min(1, 'Choose at least one manufacturing site').max(50),
        productFamilies: words.default([]),
        expiresOn: date.nullable().optional(),
        exceptions: z.string().trim().max(4000).nullable().optional(),
      })
      .parse(req.body);
    const created = await withTransaction(db, async (tx) => {
      const s = await one<{ legal_name: string; status: string }>(tx, 'SELECT legal_name, status FROM supplier WHERE id = $1', [id]);
      if (!s) throw notFound('Supplier');
      if (s.status === 'INACTIVE') throw conflict('The supplier is inactive; reactivate it before preparing a new agreement');
      const number = await nextRecordNumber(tx, 'SA');
      const a = await one<{ id: string }>(
        tx,
        `INSERT INTO supplier_agreement (number, supplier_id, kind, title, legal_entity, product_families, expires_on, exceptions, prepared_by)
         VALUES ($1,$2,'AGREEMENT',$3,$4,$5,$6,$7,$8) RETURNING id`,
        [number, id, body.title, s.legal_name, body.productFamilies, body.expiresOn ?? null, body.exceptions ?? null, auth.userId],
      );
      for (const site of new Set(body.siteIds)) await tx.query('INSERT INTO supplier_agreement_site (agreement_id, site_id) VALUES ($1, $2)', [a!.id, site]);
      await audit(tx, { actorId: auth.userId, action: 'agreement.create', entityType: 'supplier_agreement', entityId: a!.id, summary: `${number} drafted for ${s.legal_name}`, requestId: req.id });
      return { id: a!.id, number };
    });
    return reply.code(201).send(created);
  });

  // ------------------------------------------------------------------ supplier section
  app.get('/api/suppliers/:id/agreements', async (req) => {
    const auth = await requireCapability(db, req, 'records.read', { action: 'agreement.list', consequential: false });
    const { id } = req.params as { id: string };
    if (!uuid.safeParse(id).success) throw notFound('Supplier');
    const supplier = await one<{ id: string; legal_name: string; status: string }>(db, 'SELECT id, legal_name, status FROM supplier WHERE id = $1', [id]);
    if (!supplier) throw notFound('Supplier');
    const t = await today();
    const rows = await many<AgreementRow>(db, `${AGREEMENT_SELECT} WHERE a.supplier_id = $1 ORDER BY a.created_at DESC`, [id]);
    const withSites = await Promise.all(
      rows.map(async (a) => ({
        ...a,
        state: agreementState(a, t),
        sites: await sitesOf(db, a.id),
        lineCount: (await one<{ n: number }>(db, 'SELECT count(*)::int AS n FROM supplier_agreement_document WHERE agreement_id = $1', [a.id]))!.n,
      })),
    );
    const active = withSites.filter((a) => a.kind !== 'AMENDMENT' && a.state === 'EXECUTED');
    const effective = [];
    for (const a of active) for (const l of await effectiveLines(db, a.id, t)) effective.push({ ...l, agreementId: a.id, agreementNumber: a.number });
    const current = active[0] ?? null;
    const master = current ? effective.find((l) => l.agreementId === current.id && l.role === 'MASTER_AGREEMENT') : null;
    const acknowledgments = await many<{ id: string; documentNumber: string; revisionLabel: string; documentRevisionId: string; site: string | null; siteId: string | null; response: string; sentAt: string; sentTo: string; representative: string | null; respondedAt: string | null; exceptions: string | null }>(
      db,
      `SELECT k.id, d.number AS "documentNumber", r.revision_label AS "revisionLabel", r.id AS "documentRevisionId", ss.code AS site, k.site_id AS "siteId", k.response,
              k.sent_at AS "sentAt", k.sent_to AS "sentTo", k.representative, k.responded_at AS "respondedAt", k.exceptions
         FROM supplier_acknowledgment k JOIN controlled_document_revision r ON r.id = k.document_revision_id JOIN controlled_document d ON d.id = r.document_id
         LEFT JOIN supplier_site ss ON ss.id = k.site_id
        WHERE k.supplier_id = $1 ORDER BY k.sent_at DESC`,
      [id],
    );
    const incorporated = new Map(effective.filter((l) => l.documentRevisionId).map((l) => [l.documentRevisionId!, l.agreementNumber]));
    const supporting = await many(
      db,
      `SELECT e.id AS "linkId", f.id AS "fileId", f.original_name AS name, f.sha256, e.caption, e.linked_at AS "linkedAt", a.number AS "agreementNumber", a.id AS "agreementId",
              (a.executed_file_id = f.id) AS "signedCopy"
         FROM evidence_link e JOIN file_object f ON f.id = e.file_id JOIN supplier_agreement a ON a.id = e.entity_id
        WHERE e.entity_type = 'SUPPLIER_AGREEMENT' AND e.unlinked_at IS NULL AND a.supplier_id = $1 ORDER BY e.linked_at DESC`,
      [id],
    );
    const auditTrail = await many(
      db,
      `SELECT e.id, e.occurred_at AS "occurredAt", e.action, e.outcome, e.summary, u.display_name AS actor
         FROM audit_event e LEFT JOIN app_user u ON u.id = e.actor_id
        WHERE e.entity_type = 'supplier_agreement' AND e.entity_id IN (SELECT id::text FROM supplier_agreement WHERE supplier_id = $1)
        ORDER BY e.occurred_at DESC LIMIT 60`,
      [id],
    );
    const restrictions = await many<{ reason: string; site: string | null }>(
      db,
      `SELECT r.reason, ss.code AS site FROM supplier_restriction r LEFT JOIN supplier_site ss ON ss.id = r.site_id WHERE r.supplier_id = $1 AND r.lifted_at IS NULL`,
      [id],
    );
    const renewalDue = current?.expiresOn ? (await one<{ due: boolean }>(db, `SELECT ($1::date - $2::date) <= $3 AS due`, [current.expiresOn, t, RENEWAL_NOTICE_DAYS]))!.due : false;
    const historicalStates = ['SUPERSEDED', 'TERMINATED', 'CANCELLED', 'EXPIRED'];
    return {
      supplier: { id: supplier.id, legalName: supplier.legal_name, status: supplier.status },
      today: t,
      summary: current
        ? {
            agreementId: current.id,
            number: current.number,
            masterDocument: master ? `${master.documentNumber} Rev ${master.revisionLabel}` : null,
            state: current.state,
            effectiveFrom: current.effectiveFrom,
            expiresOn: current.expiresOn,
            renewalDue,
            legalEntity: current.legalEntity,
            sites: current.sites,
            productFamilies: current.productFamilies,
            specificationCount: effective.filter((l) => l.agreementId === current.id && l.role === 'SPECIFICATION').length,
            exceptions: current.exceptions,
          }
        : null,
      counts: {
        pendingSignatures: withSites.filter((a) => a.status === 'AWAITING_EXECUTION').length,
        pendingAcknowledgments: acknowledgments.filter((k) => k.response === 'PENDING').length,
        outstandingAmendments: withSites.filter((a) => a.kind === 'AMENDMENT' && (OPEN_STATUSES as readonly string[]).includes(a.status)).length,
      },
      restrictions,
      active,
      drafts: withSites.filter((a) => a.status === 'DRAFT' || a.status === 'IN_REVIEW'),
      pendingExecution: withSites.filter((a) => a.status === 'AWAITING_EXECUTION'),
      specifications: effective.filter((l) => l.role !== 'PART_SCHEDULE' && l.role !== 'EXHIBIT'),
      partSchedules: effective.filter((l) => l.role === 'PART_SCHEDULE'),
      amendments: withSites.filter((a) => a.kind === 'AMENDMENT'),
      historical: withSites.filter((a) => historicalStates.includes(a.state)),
      acknowledgments: acknowledgments.map((k) => ({ ...k, acceptedThrough: incorporated.get(k.documentRevisionId) ?? null })),
      supporting,
      audit: auditTrail,
      permissions: { canPrepare: has(auth, 'supplier.manage'), canApprove: has(auth, 'supplier.qualify'), canClassify: has(auth, 'documents.control') },
    };
  });

  // ------------------------------------------------------------------ agreement detail
  app.get('/api/agreements/:id', async (req) => {
    const auth = await requireCapability(db, req, 'records.read', { action: 'agreement.read', consequential: false });
    const { id } = req.params as { id: string };
    const a = await loadAgreement(db, id);
    if (!a) throw notFound('Agreement');
    const t = await today();
    const supplier = (await one<{ id: string; code: string; legal_name: string; status: string }>(db, 'SELECT id, code, legal_name, status FROM supplier WHERE id = $1', [a.supplierId]))!;
    const lines = await manifestLines(db, a.id);
    const partIds = [...new Set(lines.flatMap((l) => l.partIds))];
    const parts = await many<{ id: string; partNumber: string }>(db, 'SELECT id, part_number AS "partNumber" FROM company_part WHERE id = ANY($1::uuid[])', [partIds]);
    const signatures = await many(
      db,
      `SELECT s.id, s.cycle, s.role, s.mode, s.signer_name AS "signerName", s.signer_title AS "signerTitle", s.signed_on::text AS "signedOn", s.reference, s.statement,
              s.manifest_sha256 AS "manifestSha256", u.display_name AS "recordedBy", s.created_at AS "createdAt"
         FROM supplier_agreement_signature s JOIN app_user u ON u.id = s.signer_id WHERE s.agreement_id = $1 ORDER BY s.created_at, s.cycle, array_position(ARRAY['PDI_APPROVAL','LEGAL_REVIEW','PDI_SIGNATORY','SUPPLIER_SIGNATORY'], s.role)`,
      [a.id],
    );
    const attachments = await many(
      db,
      `SELECT e.id AS "linkId", f.id AS "fileId", f.original_name AS name, f.mime_type AS mime, f.sha256, e.caption, e.linked_at AS "linkedAt", u.display_name AS "linkedBy"
         FROM evidence_link e JOIN file_object f ON f.id = e.file_id JOIN app_user u ON u.id = e.linked_by
        WHERE e.entity_type = 'SUPPLIER_AGREEMENT' AND e.entity_id = $1 AND e.unlinked_at IS NULL ORDER BY e.linked_at`,
      [a.id],
    );
    const renditions = await many(
      db,
      `SELECT s.edition, s.snapshot->>'stage' AS stage, s.created_at AS "createdAt", r.file_id AS "fileId", r.sha256, r.page_count AS "pageCount", r.rendered_at AS "renderedAt",
              v.ok AS validated, v.result AS validation
         FROM report_snapshot s LEFT JOIN report_rendition r ON r.snapshot_id = s.id LEFT JOIN controlled_output_validation v ON v.rendition_id = r.id
        WHERE s.subject_type = $1 AND s.subject_id = $2 ORDER BY s.edition DESC`,
      [AGREEMENT_SUBJECT, a.id],
    );
    const related = await many<AgreementRow>(db, `${AGREEMENT_SELECT} WHERE a.parent_id = $1 OR a.id = $2 OR a.id = (SELECT superseded_by_id FROM supplier_agreement WHERE id = $3) ORDER BY a.created_at`, [a.id, a.parentId, a.id]);
    const history = await many(
      db,
      `SELECT e.id, e.occurred_at AS "occurredAt", e.action, e.outcome, e.summary, e.reason, u.display_name AS actor
         FROM audit_event e LEFT JOIN app_user u ON u.id = e.actor_id WHERE e.entity_type = 'supplier_agreement' AND e.entity_id = $1 ORDER BY e.occurred_at DESC`,
      [a.id],
    );
    const work = await many(db, `SELECT id, kind, title, status, created_at AS "createdAt" FROM work_item WHERE subject_type = 'SUPPLIER_AGREEMENT' AND subject_id = $1 ORDER BY created_at DESC`, [a.id]);
    const state = agreementState(a, t);
    const independent = a.preparedBy !== auth.userId && a.submittedBy !== auth.userId;
    const conflicts = await agreementConflicts(db, a, t);
    return {
      agreement: { ...a, state },
      supplier: { id: supplier.id, code: supplier.code, legalName: supplier.legal_name, status: supplier.status },
      sites: await sitesOf(db, a.id),
      supplierSites: await many(db, 'SELECT id, code, name, status FROM supplier_site WHERE supplier_id = $1 ORDER BY code', [a.supplierId]),
      lines,
      parts,
      effective: a.kind === 'AMENDMENT' || state !== 'EXECUTED' ? (await resultingLines(db, a, t)).lines : await effectiveLines(db, a.id, t),
      conflicts,
      stale: await staleLines(db, lines, t),
      signatures,
      attachments,
      renditions,
      related: related.map((r) => ({ ...r, state: agreementState(r, t) })),
      history,
      work,
      permissions: {
        canEdit: a.status === 'DRAFT' && has(auth, 'supplier.manage'),
        canSubmit: a.status === 'DRAFT' && has(auth, 'supplier.manage'),
        canApprove: a.status === 'IN_REVIEW' && has(auth, 'supplier.qualify') && independent,
        approveBlockedReason: a.status === 'IN_REVIEW' && has(auth, 'supplier.qualify') && !independent ? 'You prepared or submitted this agreement; another approver must decide (POL-01)' : null,
        canReturn: a.status === 'IN_REVIEW' && has(auth, 'supplier.qualify'),
        canRecordExecution: a.status === 'AWAITING_EXECUTION' && has(auth, 'supplier.manage'),
        canCancel: (OPEN_STATUSES as readonly string[]).includes(a.status) && (has(auth, 'supplier.manage') || has(auth, 'supplier.qualify')),
        canTerminate: a.status === 'EXECUTED' && a.kind !== 'AMENDMENT' && has(auth, 'supplier.qualify'),
        canAmend: state === 'EXECUTED' && a.kind !== 'AMENDMENT' && has(auth, 'supplier.manage'),
        canRenew: (state === 'EXECUTED' || state === 'EXPIRED') && a.kind !== 'AMENDMENT' && has(auth, 'supplier.manage'),
        canAttach: !['CANCELLED', 'SUPERSEDED', 'TERMINATED'].includes(a.status) && has(auth, 'supplier.manage'),
        canCloseRevisionReview: has(auth, 'supplier.qualify') && work.some((w) => (w as { kind: string; status: string }).kind === 'AGREEMENT_REVISION_REVIEW' && (w as { status: string }).status === 'OPEN'),
      },
    };
  });

  app.patch('/api/agreements/:id', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'supplier.manage', { action: 'agreement.edit', entityType: 'supplier_agreement', entityId: id });
    const body = z
      .object({
        version: z.number().int(),
        title: z.string().trim().min(3).max(200).optional(),
        productFamilies: words.optional(),
        expiresOn: date.nullable().optional(),
        exceptions: z.string().trim().max(4000).nullable().optional(),
        changeSummary: z.string().trim().max(4000).nullable().optional(),
        siteIds: z.array(uuid).min(1).max(50).optional(),
      })
      .parse(req.body);
    return withTransaction(db, async (tx) => {
      const a = await loadAgreement(tx, id, true);
      if (!a) throw notFound('Agreement');
      draftOnly(a);
      if (a.version !== body.version) throw conflict('The agreement changed since you opened it; reload and try again');
      if (body.siteIds && a.kind === 'AMENDMENT') throw unprocessable('An amendment covers the sites of the agreement it amends');
      await tx.query(
        `UPDATE supplier_agreement SET title = coalesce($2, title), product_families = coalesce($3, product_families),
           expires_on = CASE WHEN $4 THEN $5::date ELSE expires_on END, exceptions = CASE WHEN $6 THEN $7 ELSE exceptions END,
           change_summary = CASE WHEN $8 THEN $9 ELSE change_summary END, version = version + 1, updated_at = now() WHERE id = $1`,
        [id, body.title ?? null, body.productFamilies ?? null, body.expiresOn !== undefined, body.expiresOn ?? null, body.exceptions !== undefined, body.exceptions ?? null, body.changeSummary !== undefined, body.changeSummary ?? null],
      );
      if (body.siteIds) {
        const keep = new Set(body.siteIds);
        const lines = await manifestLines(tx, id);
        if (lines.some((l) => l.siteIds.some((s) => !keep.has(s)))) throw unprocessable('A manifest line applies to a site you are removing; change the line first');
        await tx.query('DELETE FROM supplier_agreement_site WHERE agreement_id = $1 AND NOT (site_id = ANY($2::uuid[]))', [id, [...keep]]);
        for (const s of keep) await tx.query('INSERT INTO supplier_agreement_site (agreement_id, site_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, s]);
      }
      await audit(tx, { actorId: auth.userId, action: 'agreement.edit', entityType: 'supplier_agreement', entityId: id, summary: `${a.number} draft terms updated`, after: body, requestId: req.id });
      return { ok: true };
    });
  });

  /** Replaces the draft manifest. Each line is snapshotted from its source (number, revision, SHA-256). */
  app.put('/api/agreements/:id/documents', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'supplier.manage', { action: 'agreement.manifest', entityType: 'supplier_agreement', entityId: id });
    const body = z.object({ version: z.number().int(), lines: z.array(lineInput).max(200) }).parse(req.body);
    return withTransaction(db, async (tx) => {
      const a = await loadAgreement(tx, id, true);
      if (!a) throw notFound('Agreement');
      draftOnly(a);
      if (a.version !== body.version) throw conflict('The agreement changed since you opened it; reload and try again');
      const t = await today(tx);
      const sites = new Set((await sitesOf(tx, id)).map((s) => s.id));
      const resolved: ResolvedLine[] = [];
      for (const l of body.lines) resolved.push(await resolveLine(tx, a, sites, l, t));
      const seen = new Set<string>();
      for (const r of resolved) {
        const k = canonicalJson([r.documentRevisionId, r.baselineRevisionId, r.fileId, r.action, [...r.siteIds].sort(), [...r.partIds].sort(), [...r.productFamilies].sort()]);
        if (seen.has(k)) throw unprocessable(`${r.documentNumber} Rev ${r.revisionLabel} is listed twice for the same scope`);
        seen.add(k);
      }
      await tx.query('DELETE FROM supplier_agreement_document WHERE agreement_id = $1', [id]);
      let order = 0;
      for (const r of resolved) {
        order += 1;
        await tx.query(
          `INSERT INTO supplier_agreement_document (agreement_id, role, action, document_revision_id, baseline_revision_id, file_id, document_number, title, revision_label, sha256,
             precedence, contractual_ref, applies_site_ids, applies_part_ids, applies_product_families, applicability_note, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [id, r.role, r.action, r.documentRevisionId, r.baselineRevisionId, r.fileId, r.documentNumber, r.title, r.revisionLabel, r.sha256, r.precedence, r.contractualRef, r.siteIds, r.partIds, r.productFamilies, r.applicabilityNote, order],
        );
      }
      await tx.query('UPDATE supplier_agreement SET version = version + 1, updated_at = now() WHERE id = $1', [id]);
      await audit(tx, {
        actorId: auth.userId,
        action: 'agreement.manifest',
        entityType: 'supplier_agreement',
        entityId: id,
        summary: `${a.number} manifest set: ${resolved.map((r) => `${r.documentNumber} Rev ${r.revisionLabel}`).join(', ') || 'empty'}`,
        requestId: req.id,
      });
      return { ok: true, conflicts: await agreementConflicts(tx, a, t) };
    });
  });

  app.get('/api/agreements/:id/recommendations', async (req) => {
    await requireCapability(db, req, 'records.read', { action: 'agreement.recommendations', consequential: false });
    const { id } = req.params as { id: string };
    const a = await loadAgreement(db, id);
    if (!a) throw notFound('Agreement');
    return recommendations(db, a, await today());
  });

  /** A draft preview of the package; not stored, not for signature. */
  app.get('/api/agreements/:id/preview.pdf', async (req, reply) => {
    await requireCapability(db, req, 'records.read', { action: 'agreement.preview', consequential: false });
    const { id } = req.params as { id: string };
    const a = await loadAgreement(db, id);
    if (!a) throw notFound('Agreement');
    const snap = await packageSnapshot(db, a, a.status === 'EXECUTED' ? 'EXECUTED' : a.manifestSha256 ? 'APPROVED' : 'DRAFT', await today());
    const rendered = await renderPackage(svc, { ...snap, stage: 'DRAFT', edition: 0 });
    reply
      .header('Content-Type', 'application/pdf')
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', `inline; filename="${a.number}-preview.pdf"`);
    return reply.send(Buffer.from(rendered.bytes));
  });

  // ------------------------------------------------------------------ lifecycle
  app.post('/api/agreements/:id/submit', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'supplier.manage', { action: 'agreement.submit', entityType: 'supplier_agreement', entityId: id });
    const body = z.object({ version: z.number().int() }).parse(req.body);
    return withTransaction(db, async (tx) => {
      const a = await loadAgreement(tx, id, true);
      if (!a) throw notFound('Agreement');
      draftOnly(a);
      if (a.version !== body.version) throw conflict('The agreement changed since you opened it; reload and try again');
      const lines = await manifestLines(tx, id);
      if (!lines.length) throw unprocessable('Add the documents the agreement incorporates before submitting');
      if (!(await sitesOf(tx, id)).length) throw unprocessable('Choose the manufacturing sites the agreement covers');
      if (a.kind !== 'AMENDMENT' && !lines.some((l) => l.role === 'MASTER_AGREEMENT')) throw unprocessable('An agreement incorporates the Master Supplier Agreement (Layer A)');
      if (a.kind === 'AMENDMENT' && !a.changeSummary) throw unprocessable('Describe what the amendment changes');
      if (a.parentId) {
        const p = await loadAgreement(tx, a.parentId);
        if (p?.status !== 'EXECUTED') throw conflict(`${p?.number ?? 'The parent agreement'} is no longer executed; this ${a.kind.toLowerCase()} cannot proceed`);
      }
      const t = await today(tx);
      if (a.expiresOn && a.expiresOn < t) throw unprocessable('The expiry date has already passed');
      for (const l of lines) {
        if (l.documentRevisionId && l.action !== 'REMOVE') {
          const inForce = await revisionInForceById(tx, l.documentId!, t);
          const own = await one<{ effective_from: string }>(tx, 'SELECT effective_from::text FROM controlled_document_revision WHERE id = $1', [l.documentRevisionId]);
          if (own!.effective_from <= t && inForce && inForce.id !== l.documentRevisionId) throw unprocessable(`${l.documentNumber} Rev ${l.revisionLabel} has been superseded by Rev ${inForce.revisionLabel}; update the manifest`);
        }
      }
      await tx.query(`UPDATE supplier_agreement SET status = 'IN_REVIEW', submitted_by = $2, submitted_at = now(), version = version + 1, updated_at = now() WHERE id = $1`, [id, auth.userId]);
      await openWork(tx, id, 'AGREEMENT_REVIEW', `Review and approve ${a.number}: ${a.title}`, 'supplier.qualify');
      await audit(tx, { actorId: auth.userId, action: 'agreement.submit', entityType: 'supplier_agreement', entityId: id, summary: `${a.number} submitted for PDI internal review (${lines.length} documents)`, requestId: req.id });
      return { status: 'IN_REVIEW' };
    });
  });

  app.post('/api/agreements/:id/return', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'supplier.qualify', { action: 'agreement.return', entityType: 'supplier_agreement', entityId: id });
    const body = z.object({ reason }).parse(req.body);
    return withTransaction(db, async (tx) => {
      const a = await loadAgreement(tx, id, true);
      if (!a) throw notFound('Agreement');
      if (a.status !== 'IN_REVIEW') throw conflict(`${a.number} is not in review`);
      await tx.query(`UPDATE supplier_agreement SET status = 'DRAFT', cycle = cycle + 1, submitted_by = NULL, submitted_at = NULL, version = version + 1, updated_at = now() WHERE id = $1`, [id]);
      await closeWork(tx, id, ['AGREEMENT_REVIEW'], auth.userId, 'Returned to draft');
      await audit(tx, { actorId: auth.userId, action: 'agreement.return', entityType: 'supplier_agreement', entityId: id, summary: `${a.number} returned to draft`, reason: body.reason, requestId: req.id });
      return { status: 'DRAFT' };
    });
  });

  /** PDI internal approval: independent of preparer and submitter; legal review recorded; manifest frozen. Not execution. */
  app.post('/api/agreements/:id/approve', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'supplier.qualify', { action: 'agreement.approve', entityType: 'supplier_agreement', entityId: id });
    const body = z
      .object({
        version: z.number().int(),
        legalReviewer: z.string().trim().min(2).max(200),
        legalReference: z.string().trim().min(2).max(300),
        legalReviewedOn: date,
        conflictResolution: z.string().trim().max(4000).nullable().optional(),
        statement: z.string().trim().max(2000).nullable().optional(),
      })
      .parse(req.body);
    const pre = await loadAgreement(db, id);
    if (!pre) throw notFound('Agreement');
    if (pre.preparedBy === auth.userId || pre.submittedBy === auth.userId) {
      throw await auditedDenial(db, req, auth.userId, 'agreement.approve', 'supplier_agreement', id, 'The approver must be independent of whoever prepared or submitted the agreement (POL-01)');
    }
    return withTransaction(db, async (tx) => {
      if (!(await recheckCapability(tx, auth.userId, 'supplier.qualify'))) throw forbidden('Your supplier.qualify authority is no longer active');
      const a = await loadAgreement(tx, id, true);
      if (!a) throw notFound('Agreement');
      if (a.status !== 'IN_REVIEW') throw conflict(`${a.number} is not awaiting approval`);
      if (a.version !== body.version) throw conflict('The agreement changed since you opened it; reload and try again');
      const t = await today(tx);
      if (body.legalReviewedOn > t) throw unprocessable('The legal review date cannot be in the future');
      const conflicts = await agreementConflicts(tx, a, t);
      if (conflicts.length && !body.conflictResolution) throw unprocessable(`Record how the ${conflicts.length} precedence conflict(s) are resolved before approving`, { conflicts });
      const manifestSha = sha256(canonicalJson(await manifestOf(tx, a)));
      await tx.query(
        `UPDATE supplier_agreement SET status = 'AWAITING_EXECUTION', approved_by = $2, approved_at = now(), manifest_sha256 = $3, conflict_resolution = $4, version = version + 1, updated_at = now() WHERE id = $1`,
        [id, auth.userId, manifestSha, conflicts.length ? body.conflictResolution : null],
      );
      await tx.query(
        `INSERT INTO supplier_agreement_signature (agreement_id, cycle, role, mode, signer_id, signer_name, signed_on, statement, manifest_sha256, grants_used)
         VALUES ($1,$2,'PDI_APPROVAL','INTERNAL',$3,$4,$5,$6,$7,ARRAY['supplier.qualify'])`,
        [id, a.cycle, auth.userId, auth.displayName, t, body.statement ?? 'Approved for execution', manifestSha],
      );
      await tx.query(
        `INSERT INTO supplier_agreement_signature (agreement_id, cycle, role, mode, signer_id, signer_name, signed_on, reference, statement, manifest_sha256)
         VALUES ($1,$2,'LEGAL_REVIEW','EXTERNAL',$3,$4,$5,$6,'Legal review recorded by the approver',$7)`,
        [id, a.cycle, auth.userId, body.legalReviewer, body.legalReviewedOn, body.legalReference, manifestSha],
      );
      await closeWork(tx, id, ['AGREEMENT_REVIEW'], auth.userId, 'Approved');
      await openWork(tx, id, 'AGREEMENT_EXECUTION', `Obtain signatures and record execution of ${a.number}`, 'supplier.manage');
      const approved = (await loadAgreement(tx, id))!;
      const pkg = await queuePackage(tx, id, await packageSnapshot(tx, approved, 'APPROVED', t));
      await audit(tx, {
        actorId: auth.userId,
        action: 'agreement.approve',
        entityType: 'supplier_agreement',
        entityId: id,
        summary: `${a.number} approved by PDI for execution; manifest ${manifestSha.slice(0, 12)} frozen; package edition ${pkg.edition} queued. Approval is not execution.`,
        reason: conflicts.length ? body.conflictResolution : null,
        requestId: req.id,
      });
      return { status: 'AWAITING_EXECUTION', manifestSha256: manifestSha, edition: pkg.edition };
    });
  });

  /** Execution recorded from the signed agreement: signed copy attached, signatories attested, effective date entered. */
  app.post('/api/agreements/:id/execution', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'supplier.manage', { action: 'agreement.execute', entityType: 'supplier_agreement', entityId: id });
    const signatory = z.object({ name: z.string().trim().min(2).max(200), title: z.string().trim().min(2).max(200), signedOn: date });
    const body = z
      .object({ version: z.number().int(), signedFileId: uuid, effectiveFrom: date, pdiSignatory: signatory, supplierSignatory: signatory, note: z.string().trim().max(2000).nullable().optional() })
      .parse(req.body);
    return withTransaction(db, async (tx) => {
      if (!(await recheckCapability(tx, auth.userId, 'supplier.manage'))) throw forbidden('Your supplier.manage authority is no longer active');
      const a = await loadAgreement(tx, id, true);
      if (!a) throw notFound('Agreement');
      if (a.status !== 'AWAITING_EXECUTION') throw conflict(`${a.number} is not awaiting execution`);
      if (a.version !== body.version) throw conflict('The agreement changed since you opened it; reload and try again');
      const t = await today(tx);
      for (const s of [body.pdiSignatory, body.supplierSignatory]) if (s.signedOn > t) throw unprocessable('A signature date cannot be in the future');
      if (a.expiresOn && body.effectiveFrom > a.expiresOn) throw unprocessable('The effective date is after the expiry date');
      const file = await one<{ sha256: string; mime_type: string }>(
        tx,
        `SELECT f.sha256, f.mime_type FROM evidence_link e JOIN file_object f ON f.id = e.file_id
          WHERE e.file_id = $1 AND e.entity_type = 'SUPPLIER_AGREEMENT' AND e.entity_id = $2 AND e.unlinked_at IS NULL AND f.status = 'AVAILABLE'`,
        [body.signedFileId, id],
      );
      if (!file) throw unprocessable('Attach the signed agreement to this record, then select it');
      if (file.mime_type !== 'application/pdf') throw unprocessable('The signed agreement must be a PDF');
      await tx.query(
        `UPDATE supplier_agreement SET status = 'EXECUTED', executed_at = now(), execution_recorded_by = $2, effective_from = $3, executed_file_id = $4, version = version + 1, updated_at = now() WHERE id = $1`,
        [id, auth.userId, body.effectiveFrom, body.signedFileId],
      );
      const statement = 'Attested from the signed agreement recorded in TQM; not an electronic signature';
      for (const [role, s] of [['PDI_SIGNATORY', body.pdiSignatory], ['SUPPLIER_SIGNATORY', body.supplierSignatory]] as const) {
        await tx.query(
          `INSERT INTO supplier_agreement_signature (agreement_id, cycle, role, mode, signer_id, signer_name, signer_title, signed_on, reference, statement, manifest_sha256)
           VALUES ($1,$2,$3,'EXTERNAL',$4,$5,$6,$7,$8,$9,$10)`,
          [id, a.cycle, role, auth.userId, s.name, s.title, s.signedOn, `Signed copy SHA-256 ${file.sha256}`, statement, a.manifestSha256],
        );
      }
      const superseded: string[] = [];
      if (a.kind === 'RENEWAL' && a.parentId) {
        const chain = await many<{ id: string; number: string }>(
          tx,
          `SELECT id, number FROM supplier_agreement WHERE (id = $1 OR (parent_id = $1 AND kind = 'AMENDMENT')) AND status = 'EXECUTED' FOR UPDATE`,
          [a.parentId],
        );
        for (const c of chain) {
          await tx.query(`UPDATE supplier_agreement SET status = 'SUPERSEDED', superseded_by_id = $2, superseded_at = now(), version = version + 1, updated_at = now() WHERE id = $1`, [c.id, id]);
          await closeWork(tx, c.id, ['AGREEMENT_REVISION_REVIEW'], auth.userId, `Superseded by ${a.number}`);
          await audit(tx, { actorId: auth.userId, action: 'agreement.supersede', entityType: 'supplier_agreement', entityId: c.id, summary: `${c.number} superseded by executed renewal ${a.number}`, requestId: req.id });
          superseded.push(c.number);
        }
        const open = await many<{ id: string; number: string }>(tx, `SELECT id, number FROM supplier_agreement WHERE parent_id = $1 AND kind = 'AMENDMENT' AND status = ANY($2::text[])`, [a.parentId, [...OPEN_STATUSES]]);
        for (const o of open) {
          await tx.query(`UPDATE supplier_agreement SET status = 'CANCELLED', cancelled_by = $2, cancelled_at = now(), cancel_reason = $3, version = version + 1, updated_at = now() WHERE id = $1`, [o.id, auth.userId, `Parent superseded by renewal ${a.number}`]);
          await closeWork(tx, o.id, ['AGREEMENT_REVIEW', 'AGREEMENT_EXECUTION'], auth.userId, 'Parent superseded', 'CANCELLED');
        }
      }
      await closeWork(tx, id, ['AGREEMENT_EXECUTION'], auth.userId, 'Execution recorded');
      // An executed amendment is the response to the parent's open revision review.
      if (a.kind === 'AMENDMENT' && a.parentId) await closeWork(tx, a.parentId, ['AGREEMENT_REVISION_REVIEW'], auth.userId, `Amendment ${a.number} executed`);
      const executed = (await loadAgreement(tx, id))!;
      const pkg = await queuePackage(tx, id, await packageSnapshot(tx, executed, 'EXECUTED', t));
      await audit(tx, {
        actorId: auth.userId,
        action: 'agreement.execute',
        entityType: 'supplier_agreement',
        entityId: id,
        summary: `${a.number} execution recorded from the signed copy (${body.pdiSignatory.name} for PDI, ${body.supplierSignatory.name} for the supplier), effective ${body.effectiveFrom}${superseded.length ? `; supersedes ${superseded.join(', ')}` : ''}; package edition ${pkg.edition} queued`,
        reason: body.note ?? null,
        after: { signedCopySha256: file.sha256 },
        requestId: req.id,
      });
      return { status: 'EXECUTED', edition: pkg.edition, superseded };
    });
  });

  app.post('/api/agreements/:id/terminate', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'supplier.qualify', { action: 'agreement.terminate', entityType: 'supplier_agreement', entityId: id });
    const body = z.object({ reason }).parse(req.body);
    return withTransaction(db, async (tx) => {
      if (!(await recheckCapability(tx, auth.userId, 'supplier.qualify'))) throw forbidden('Your supplier.qualify authority is no longer active');
      const a = await loadAgreement(tx, id, true);
      if (!a) throw notFound('Agreement');
      if (a.status !== 'EXECUTED' || a.kind === 'AMENDMENT') throw conflict('Only an executed agreement (with its amendments) is terminated');
      const chain = await many<{ id: string; number: string }>(tx, `SELECT id, number FROM supplier_agreement WHERE (id = $1 OR (parent_id = $1 AND kind = 'AMENDMENT')) AND status = 'EXECUTED' FOR UPDATE`, [id]);
      for (const c of chain) {
        await tx.query(`UPDATE supplier_agreement SET status = 'TERMINATED', terminated_by = $2, terminated_at = now(), termination_reason = $3, version = version + 1, updated_at = now() WHERE id = $1`, [c.id, auth.userId, body.reason]);
        await closeWork(tx, c.id, ['AGREEMENT_REVISION_REVIEW'], auth.userId, 'Agreement terminated', 'CANCELLED');
      }
      const open = await many<{ id: string }>(tx, `SELECT id FROM supplier_agreement WHERE parent_id = $1 AND status = ANY($2::text[])`, [id, [...OPEN_STATUSES]]);
      for (const o of open) {
        await tx.query(`UPDATE supplier_agreement SET status = 'CANCELLED', cancelled_by = $2, cancelled_at = now(), cancel_reason = $3, version = version + 1, updated_at = now() WHERE id = $1`, [o.id, auth.userId, `Parent ${a.number} terminated`]);
        await closeWork(tx, o.id, ['AGREEMENT_REVIEW', 'AGREEMENT_EXECUTION'], auth.userId, 'Parent terminated', 'CANCELLED');
      }
      await audit(tx, { actorId: auth.userId, action: 'agreement.terminate', entityType: 'supplier_agreement', entityId: id, summary: `${chain.map((c) => c.number).join(', ')} terminated; history retained`, reason: body.reason, requestId: req.id });
      return { status: 'TERMINATED' };
    });
  });

  app.post('/api/agreements/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    const auth = requireAuth(req);
    if (!has(auth, 'supplier.manage') && !has(auth, 'supplier.qualify')) {
      throw await auditedDenial(db, req, auth.userId, 'agreement.cancel', 'supplier_agreement', id, 'Cancelling an agreement requires supplier.manage or supplier.qualify');
    }
    const body = z.object({ reason }).parse(req.body);
    return withTransaction(db, async (tx) => {
      const a = await loadAgreement(tx, id, true);
      if (!a) throw notFound('Agreement');
      if (!(OPEN_STATUSES as readonly string[]).includes(a.status)) throw conflict(`${a.number} is ${AGREEMENT_STATE_TEXT[a.status].toLowerCase()} and cannot be cancelled`);
      await tx.query(`UPDATE supplier_agreement SET status = 'CANCELLED', cancelled_by = $2, cancelled_at = now(), cancel_reason = $3, version = version + 1, updated_at = now() WHERE id = $1`, [id, auth.userId, body.reason]);
      await closeWork(tx, id, ['AGREEMENT_REVIEW', 'AGREEMENT_EXECUTION'], auth.userId, 'Agreement cancelled', 'CANCELLED');
      await audit(tx, { actorId: auth.userId, action: 'agreement.cancel', entityType: 'supplier_agreement', entityId: id, summary: `${a.number} cancelled before execution`, reason: body.reason, requestId: req.id });
      return { status: 'CANCELLED' };
    });
  });

  /** Closes an open revision review without amending: the executed agreement stays on its revisions, with the reason recorded. */
  app.post('/api/agreements/:id/revision-review', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'supplier.qualify', { action: 'agreement.revision_review', entityType: 'supplier_agreement', entityId: id });
    const body = z.object({ reason }).parse(req.body);
    return withTransaction(db, async (tx) => {
      const a = await loadAgreement(tx, id, true);
      if (!a) throw notFound('Agreement');
      const open = await one<{ id: string }>(tx, `SELECT id FROM work_item WHERE kind = 'AGREEMENT_REVISION_REVIEW' AND subject_type = 'SUPPLIER_AGREEMENT' AND subject_id = $1 AND status = 'OPEN'`, [id]);
      if (!open) throw conflict(`${a.number} has no open revision review`);
      await closeWork(tx, id, ['AGREEMENT_REVISION_REVIEW'], auth.userId, `Reviewed: no amendment (${body.reason})`.slice(0, 500));
      await audit(tx, { actorId: auth.userId, action: 'agreement.revision_review', entityType: 'supplier_agreement', entityId: id, summary: `${a.number} reviewed against newer revisions; kept unchanged`, reason: body.reason, requestId: req.id });
      return { ok: true };
    });
  });

  app.post('/api/agreements/:id/amendments', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'supplier.manage', { action: 'agreement.amend', entityType: 'supplier_agreement', entityId: id });
    const body = z.object({ changeSummary: z.string().trim().min(5).max(4000) }).parse(req.body);
    const created = await withTransaction(db, async (tx) => {
      const p = await loadAgreement(tx, id, true);
      if (!p) throw notFound('Agreement');
      const t = await today(tx);
      if (p.kind === 'AMENDMENT' || agreementState(p, t) !== 'EXECUTED') throw conflict('Only an executed, unexpired agreement is amended; renew an expired one');
      const open = await one<{ number: string }>(tx, `SELECT number FROM supplier_agreement WHERE parent_id = $1 AND kind = 'AMENDMENT' AND status = ANY($2::text[])`, [id, [...OPEN_STATUSES]]);
      if (open) throw conflict(`Amendment ${open.number} is already in progress`);
      const n = (await one<{ n: number }>(tx, `SELECT count(*)::int + 1 AS n FROM supplier_agreement WHERE parent_id = $1 AND kind = 'AMENDMENT'`, [id]))!.n;
      const number = `${p.number}-A${n}`;
      const a = await one<{ id: string }>(
        tx,
        `INSERT INTO supplier_agreement (number, supplier_id, kind, parent_id, title, legal_entity, product_families, change_summary, expires_on, prepared_by)
         VALUES ($1,$2,'AMENDMENT',$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [number, p.supplierId, id, `Amendment ${n} to ${p.number}`, p.legalEntity, p.productFamilies, body.changeSummary, p.expiresOn, auth.userId],
      );
      await tx.query('INSERT INTO supplier_agreement_site (agreement_id, site_id) SELECT $1, site_id FROM supplier_agreement_site WHERE agreement_id = $2', [a!.id, id]);
      await audit(tx, { actorId: auth.userId, action: 'agreement.amend', entityType: 'supplier_agreement', entityId: a!.id, summary: `${number} drafted to amend ${p.number}; the executed agreement is unchanged`, reason: body.changeSummary, requestId: req.id });
      return { id: a!.id, number };
    });
    return reply.code(201).send(created);
  });

  app.post('/api/agreements/:id/renewal', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'supplier.manage', { action: 'agreement.renew', entityType: 'supplier_agreement', entityId: id });
    const body = z.object({ expiresOn: date.nullable().optional(), title: z.string().trim().min(3).max(200).optional() }).parse(req.body ?? {});
    const created = await withTransaction(db, async (tx) => {
      const p = await loadAgreement(tx, id, true);
      if (!p) throw notFound('Agreement');
      if (p.kind === 'AMENDMENT' || p.status !== 'EXECUTED') throw conflict('Only an executed (or expired) agreement is renewed');
      const open = await one<{ number: string }>(tx, `SELECT number FROM supplier_agreement WHERE parent_id = $1 AND kind = 'RENEWAL' AND status = ANY($2::text[])`, [id, [...OPEN_STATUSES]]);
      if (open) throw conflict(`Renewal ${open.number} is already in progress`);
      const s = (await one<{ legal_name: string }>(tx, 'SELECT legal_name FROM supplier WHERE id = $1', [p.supplierId]))!;
      const t = await today(tx);
      const number = await nextRecordNumber(tx, 'SA');
      const a = await one<{ id: string }>(
        tx,
        `INSERT INTO supplier_agreement (number, supplier_id, kind, parent_id, title, legal_entity, product_families, exceptions, expires_on, prepared_by)
         VALUES ($1,$2,'RENEWAL',$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [number, p.supplierId, id, body.title ?? p.title, s.legal_name, p.productFamilies, p.exceptions, body.expiresOn ?? null, auth.userId],
      );
      await tx.query('INSERT INTO supplier_agreement_site (agreement_id, site_id) SELECT $1, site_id FROM supplier_agreement_site WHERE agreement_id = $2', [a!.id, id]);
      // Carry the effective documents forward at the revisions now in force; exhibits stay with their agreement.
      let order = 0;
      const carried: string[] = [];
      for (const l of await effectiveLines(tx, id, t)) {
        if (l.role === 'EXHIBIT') continue;
        let revId = l.documentRevisionId;
        let baseId = l.baselineRevisionId;
        let label = l.revisionLabel;
        let hash = l.sha256;
        if (l.documentId) {
          const cur = await revisionInForceById(tx, l.documentId, t);
          if (cur) [revId, label, hash] = [cur.id, cur.revisionLabel, cur.sha256];
        } else if (l.baselineId) {
          const cur = await one<{ id: string; revision_label: string }>(tx, `SELECT id, revision_label FROM baseline_revision WHERE baseline_id = $1 AND status = 'RELEASED' ORDER BY released_at DESC LIMIT 1`, [l.baselineId]);
          if (cur) [baseId, label, hash] = [cur.id, cur.revision_label, await scheduleDigest(tx, cur.id)];
        }
        order += 1;
        await tx.query(
          `INSERT INTO supplier_agreement_document (agreement_id, role, action, document_revision_id, baseline_revision_id, document_number, title, revision_label, sha256,
             precedence, contractual_ref, applies_site_ids, applies_part_ids, applies_product_families, applicability_note, sort_order)
           VALUES ($1,$2,'INCORPORATE',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [a!.id, l.role, revId, baseId, l.documentNumber, l.title, label, hash, l.precedence, l.contractualRef, l.siteIds, l.partIds, l.productFamilies, l.applicabilityNote, order],
        );
        carried.push(`${l.documentNumber} Rev ${label}`);
      }
      await audit(tx, { actorId: auth.userId, action: 'agreement.renew', entityType: 'supplier_agreement', entityId: a!.id, summary: `${number} drafted to renew ${p.number}, carrying ${carried.join(', ') || 'no documents'}`, requestId: req.id });
      return { id: a!.id, number };
    });
    return reply.code(201).send(created);
  });

  // ------------------------------------------------------------------ specification acknowledgments (extends supplier_acknowledgment)
  app.post('/api/suppliers/:id/acknowledgments', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'supplier.manage', { action: 'acknowledgment.send', entityType: 'supplier', entityId: id });
    if (!uuid.safeParse(id).success) throw notFound('Supplier');
    const body = z
      .object({
        documentRevisionId: uuid,
        siteId: uuid.nullable().optional(),
        sentVia: z.enum(['EMAIL', 'PORTAL', 'MEETING', 'MAIL', 'OTHER']),
        sentTo: z.string().trim().min(2).max(300),
        sentAt: date,
      })
      .parse(req.body);
    const created = await withTransaction(db, async (tx) => {
      const s = await one<{ legal_name: string }>(tx, 'SELECT legal_name FROM supplier WHERE id = $1 FOR UPDATE', [id]);
      if (!s) throw notFound('Supplier');
      if (body.siteId && !(await one(tx, 'SELECT 1 FROM supplier_site WHERE id = $1 AND supplier_id = $2', [body.siteId, id]))) throw unprocessable('The site is not one of this supplier');
      const rev = await one<{ document_id: string; number: string; revision_label: string }>(
        tx,
        'SELECT r.document_id, d.number, r.revision_label FROM controlled_document_revision r JOIN controlled_document d ON d.id = r.document_id WHERE r.id = $1',
        [body.documentRevisionId],
      );
      if (!rev) throw unprocessable('Document revision not found');
      if (!(await classificationOf(tx, rev.document_id))) throw unprocessable(`${rev.number} is not classified as a supplier agreement document or specification`);
      const t = await today(tx);
      for (const a of await many<{ id: string; number: string }>(tx, `SELECT id, number FROM supplier_agreement WHERE supplier_id = $1 AND kind <> 'AMENDMENT' AND status = 'EXECUTED' AND (expires_on IS NULL OR expires_on >= $2)`, [id, t])) {
        const covered = body.siteId ? await one(tx, 'SELECT 1 FROM supplier_agreement_site WHERE agreement_id = $1 AND site_id = $2', [a.id, body.siteId]) : true;
        if (covered && (await effectiveLines(tx, a.id, t)).some((l) => l.documentRevisionId === body.documentRevisionId)) {
          throw conflict(`${rev.number} Rev ${rev.revision_label} is already incorporated in executed agreement ${a.number}; a separate acknowledgment is not needed`);
        }
      }
      const k = await one<{ id: string }>(
        tx,
        `INSERT INTO supplier_acknowledgment (supplier_id, site_id, document_revision_id, sent_via, sent_to, sent_at, sent_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [id, body.siteId ?? null, body.documentRevisionId, body.sentVia, body.sentTo, `${body.sentAt}T12:00:00Z`, auth.userId],
      );
      await tx.query(
        `INSERT INTO work_item (kind, title, subject_type, subject_id, assignee_id) VALUES ('SUPPLIER_RESPONSE', $1, 'SUPPLIER_ACKNOWLEDGMENT', $2, $3)`,
        [`Record ${s.legal_name} response to ${rev.number} Rev ${rev.revision_label}`.slice(0, 200), k!.id, auth.userId],
      );
      await audit(tx, { actorId: auth.userId, action: 'acknowledgment.send', entityType: 'supplier', entityId: id, summary: `${rev.number} Rev ${rev.revision_label} sent to ${body.sentTo} for acknowledgment (not proof of compliance)`, requestId: req.id });
      return { id: k!.id };
    });
    return reply.code(201).send(created);
  });
}
