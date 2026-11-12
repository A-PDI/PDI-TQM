import { PDFDocument, type PDFFont, type PDFImage, type PDFPage, StandardFonts, rgb } from 'pdf-lib';
import { ROLE_TEXT, type DocumentRole, SCHEDULE_FIELDS, SIGNATURE_TEXT, type SignatureRole } from '../../shared/agreements.js';
import { canonicalJson } from '../../shared/forms.js';
import { audit } from '../audit.js';
import { type Queryable, many, one, withTransaction } from '../db.js';
import { enqueueJob, type JobRow, PermanentJobError } from '../jobs.js';
import { pageContentHash, sha256 } from '../controlled/pdf-text.js';
import { pdfText } from '../pdf/text.js';
import type { Services } from '../services.js';
import { EvidenceIntegrityError } from '../storage.js';

export const AGREEMENT_SUBJECT = 'SUPPLIER_AGREEMENT';

/**
 * Text printed on every generated page. TQM assembles the package from controlled documents; it
 * does not author contractual terms, and recorded execution is attestation from the signed copy.
 */
export const PACKAGE_NOTICE =
  'Assembled by TQM from controlled documents at the exact revisions listed. TQM does not author contractual terms. ' +
  'Execution details are recorded from the signed agreement; TQM applies no electronic signature.';

export type PackageStage = 'DRAFT' | 'APPROVED' | 'EXECUTED';

export interface PackageLine {
  key: string;
  role: DocumentRole;
  action: 'INCORPORATE' | 'REPLACE' | 'REMOVE';
  documentNumber: string;
  title: string;
  revisionLabel: string;
  sha256: string;
  precedence: number;
  contractualRef: string;
  appliesTo: string;
  source:
    | { kind: 'DOCUMENT'; revisionId: string }
    | { kind: 'SCHEDULE'; baselineRevisionId: string; schedule: ScheduleContent }
    | { kind: 'EXHIBIT'; fileId: string; mime: string };
}

export interface ScheduleContent {
  partNumber: string;
  partDescription: string;
  baselineTitle: string;
  documentRef: string | null;
  releasedAt: string | null;
  governingSpec: string | null;
  fields: Record<string, string>;
  characteristics: Array<{ key: string; name: string; type: string; requirement: string; method: string | null; specReference: string | null; special: boolean }>;
}

export interface PackageSnapshot {
  schemaVersion: 1;
  edition: number;
  stage: PackageStage;
  number: string;
  kind: string;
  title: string;
  parentNumber: string | null;
  supplier: { code: string; legalEntity: string };
  sites: Array<{ code: string; name: string; country: string | null }>;
  productFamilies: string[];
  effectiveFrom: string | null;
  expiresOn: string | null;
  exceptions: string | null;
  changeSummary: string | null;
  manifestSha256: string | null;
  conflicts: string[];
  conflictResolution: string | null;
  lines: PackageLine[];
  signatures: Array<{ role: SignatureRole; mode: string; name: string; title: string | null; signedOn: string; reference: string | null }>;
  executedCopySha256: string | null;
  generatedAt: string;
  notice: string;
}

/** Human description of a line's applicability. */
export function appliesText(l: { siteCodes: string[]; partNumbers: string[]; productFamilies: string[] }): string {
  const parts = [
    l.siteCodes.length ? `Sites ${l.siteCodes.join(', ')}` : 'All covered sites',
    l.partNumbers.length ? `Parts ${l.partNumbers.join(', ')}` : null,
    l.productFamilies.length ? `Families ${l.productFamilies.join(', ')}` : null,
  ].filter(Boolean);
  return parts.join('; ');
}

const limitText = (c: { lower_limit: string | null; upper_limit: string | null; nominal: string | null; unit: string | null; limit_text: string | null }) => {
  if (c.limit_text) return c.limit_text;
  const u = c.unit ? ` ${c.unit}` : '';
  if (c.lower_limit !== null && c.upper_limit !== null) return `${c.lower_limit} to ${c.upper_limit}${u}${c.nominal !== null ? ` (nominal ${c.nominal})` : ''}`;
  if (c.lower_limit !== null) return `>= ${c.lower_limit}${u}`;
  if (c.upper_limit !== null) return `<= ${c.upper_limit}${u}`;
  return c.nominal !== null ? `${c.nominal}${u}` : 'As released';
};

/** The released content of a part schedule (technical baseline revision), frozen into the package. */
export async function scheduleContent(db: Queryable, baselineRevisionId: string): Promise<ScheduleContent> {
  const r = await one<{ part_number: string; description: string; title: string; document_ref: string | null; released_at: string | null; schedule: Record<string, unknown>; spec: string | null }>(
    db,
    `SELECT p.part_number, p.description, b.title, br.document_ref, br.released_at::text, br.schedule,
            (SELECT d.number || ' Rev ' || cr.revision_label FROM controlled_document_revision cr JOIN controlled_document d ON d.id = cr.document_id WHERE cr.id = br.governing_spec_revision_id) AS spec
       FROM baseline_revision br JOIN technical_baseline b ON b.id = br.baseline_id JOIN company_part p ON p.id = b.part_id WHERE br.id = $1`,
    [baselineRevisionId],
  );
  if (!r) throw new PermanentJobError('Part schedule not found');
  const chars = await many<{ char_key: string; name: string; char_type: string; lower_limit: string | null; upper_limit: string | null; nominal: string | null; unit: string | null; limit_text: string | null; method: string | null; spec_reference: string | null; special: boolean }>(
    db,
    `SELECT char_key, name, char_type, lower_limit::text, upper_limit::text, nominal::text, unit, limit_text, method, spec_reference, special
       FROM baseline_characteristic WHERE revision_id = $1 ORDER BY char_key`,
    [baselineRevisionId],
  );
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(r.schedule ?? {})) if (typeof v === 'string' && v.trim()) fields[k] = v.trim();
  return {
    partNumber: r.part_number,
    partDescription: r.description,
    baselineTitle: r.title,
    documentRef: r.document_ref,
    releasedAt: r.released_at,
    governingSpec: r.spec,
    fields,
    characteristics: chars.map((c) => ({ key: c.char_key, name: c.name, type: c.char_type, requirement: limitText(c), method: c.method, specReference: c.spec_reference, special: c.special })),
  };
}

/** SHA-256 identifying the released content of a part schedule. */
export async function scheduleDigest(db: Queryable, baselineRevisionId: string): Promise<string> {
  const head = await one<{ id: string; baseline_id: string; revision_label: string; status: string }>(db, 'SELECT id, baseline_id, revision_label, status FROM baseline_revision WHERE id = $1', [baselineRevisionId]);
  if (!head) throw new PermanentJobError('Part schedule not found');
  return sha256(canonicalJson({ ...head, content: await scheduleContent(db, baselineRevisionId) }));
}

// ---------------------------------------------------------------- rendering
const W = 612;
const H = 792;
const M = 42;
const CW = W - 2 * M;
const NAVY = rgb(0x1e / 255, 0x2d / 255, 0x50 / 255);
const MUTED = rgb(0.42, 0.45, 0.5);
const TEXT = rgb(0.12, 0.16, 0.22);
const BORDER = rgb(0.85, 0.87, 0.9);
const BAND = rgb(1, 0.957, 0.878);

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  mono: PDFFont;
}

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of pdfText(text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width) {
        line = next;
        continue;
      }
      if (line) out.push(line);
      // Break words longer than the column (hashes, identifiers).
      let rest = word;
      while (font.widthOfTextAtSize(rest, size) > width) {
        let n = rest.length;
        while (n > 1 && font.widthOfTextAtSize(rest.slice(0, n), size) > width) n -= 1;
        out.push(rest.slice(0, n));
        rest = rest.slice(n);
      }
      line = rest;
    }
    out.push(line);
  }
  return out;
}

/** Flowing writer for the generated pages of a package. */
class Writer {
  page!: PDFPage;
  y = 0;
  readonly generated: PDFPage[] = [];
  constructor(
    readonly doc: PDFDocument,
    readonly f: Fonts,
    readonly s: PackageSnapshot,
    readonly logo: PDFImage | null,
  ) {}

  newPage() {
    this.page = this.doc.addPage([W, H]);
    this.generated.push(this.page);
    let y = H - M;
    if (this.logo) {
      const scale = 26 / this.logo.height;
      this.page.drawImage(this.logo, { x: M, y: y - 26, width: this.logo.width * scale, height: 26 });
    }
    const head = `${this.s.number}  -  Supplier agreement package  -  Edition ${this.s.edition}`;
    this.page.drawText(pdfText(head), { x: W - M - this.f.bold.widthOfTextAtSize(pdfText(head), 9), y: y - 12, size: 9, font: this.f.bold, color: NAVY });
    const stage = this.s.stage === 'DRAFT' ? 'DRAFT PREVIEW - NOT FOR SIGNATURE' : this.s.stage === 'APPROVED' ? 'Approved by PDI - for execution' : 'Executed';
    this.page.drawText(stage, { x: W - M - this.f.regular.widthOfTextAtSize(stage, 8), y: y - 24, size: 8, font: this.s.stage === 'DRAFT' ? this.f.bold : this.f.regular, color: this.s.stage === 'DRAFT' ? rgb(0.78, 0.23, 0.2) : MUTED });
    y -= 34;
    this.page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1, color: NAVY });
    y -= 8;
    const lines = wrap(this.s.notice, this.f.regular, 7, CW - 12);
    const h = lines.length * 9 + 8;
    this.page.drawRectangle({ x: M, y: y - h, width: CW, height: h, color: BAND });
    lines.forEach((l, i) => this.page.drawText(l, { x: M + 6, y: y - 10 - i * 9, size: 7, font: this.f.regular, color: TEXT }));
    this.y = y - h - 14;
  }

  ensure(h: number) {
    if (this.y - h < M + 24) this.newPage();
  }

  heading(text: string) {
    this.ensure(30);
    this.page.drawText(pdfText(text), { x: M, y: this.y - 12, size: 13, font: this.f.bold, color: NAVY });
    this.y -= 22;
  }

  para(text: string, opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; indent?: number } = {}) {
    const size = opts.size ?? 9;
    const font = opts.bold ? this.f.bold : this.f.regular;
    for (const l of wrap(text, font, size, CW - (opts.indent ?? 0))) {
      this.ensure(size + 4);
      this.page.drawText(l, { x: M + (opts.indent ?? 0), y: this.y - size, size, font, color: opts.color ?? TEXT });
      this.y -= size + 3;
    }
    this.y -= 4;
  }

  fields(rows: Array<[string, string]>) {
    for (const [k, v] of rows) {
      const lines = wrap(v || '-', this.f.regular, 9, CW - 150);
      this.ensure(lines.length * 12 + 2);
      this.page.drawText(pdfText(k), { x: M, y: this.y - 9, size: 9, font: this.f.bold, color: MUTED });
      lines.forEach((l, i) => this.page.drawText(l, { x: M + 150, y: this.y - 9 - i * 12, size: 9, font: this.f.regular, color: TEXT }));
      this.y -= lines.length * 12 + 3;
    }
    this.y -= 6;
  }

  table(cols: Array<{ title: string; width: number; mono?: boolean }>, rows: string[][], size = 7.5) {
    const total = cols.reduce((a, c) => a + c.width, 0);
    const widths = cols.map((c) => (c.width / total) * CW);
    const drawHeader = () => {
      this.ensure(16);
      this.page.drawRectangle({ x: M, y: this.y - 14, width: CW, height: 14, color: NAVY });
      let x = M;
      cols.forEach((c, i) => {
        this.page.drawText(pdfText(c.title), { x: x + 3, y: this.y - 10, size: 7.5, font: this.f.bold, color: rgb(1, 1, 1) });
        x += widths[i]!;
      });
      this.y -= 14;
    };
    drawHeader();
    for (const row of rows) {
      const cells = row.map((v, i) => wrap(v || '-', cols[i]!.mono ? this.f.mono : this.f.regular, size, widths[i]! - 6));
      const h = Math.max(...cells.map((c) => c.length)) * (size + 2.5) + 5;
      if (this.y - h < M + 24) {
        this.newPage();
        drawHeader();
      }
      let x = M;
      cells.forEach((lines, i) => {
        lines.forEach((l, j) => this.page.drawText(l, { x: x + 3, y: this.y - size - 2 - j * (size + 2.5), size, font: cols[i]!.mono ? this.f.mono : this.f.regular, color: TEXT }));
        x += widths[i]!;
      });
      this.y -= h;
      this.page.drawLine({ start: { x: M, y: this.y }, end: { x: W - M, y: this.y }, thickness: 0.5, color: BORDER });
    }
    this.y -= 10;
  }

  signatureBlock(label: string, filled: { name: string; title: string | null; signedOn: string; reference: string | null } | null) {
    this.ensure(54);
    this.page.drawRectangle({ x: M, y: this.y - 48, width: CW, height: 48, borderColor: BORDER, borderWidth: 0.8 });
    this.page.drawText(pdfText(label), { x: M + 6, y: this.y - 12, size: 8.5, font: this.f.bold, color: NAVY });
    if (filled) {
      this.page.drawText(pdfText(`${filled.name}${filled.title ? `, ${filled.title}` : ''}`), { x: M + 6, y: this.y - 26, size: 9, font: this.f.regular, color: TEXT });
      this.page.drawText(pdfText(`Date ${filled.signedOn}${filled.reference ? `   Reference ${filled.reference}` : ''}`.slice(0, 130)), { x: M + 6, y: this.y - 39, size: 8, font: this.f.regular, color: MUTED });
    } else {
      this.page.drawText('Name / title: ______________________________   Signature: ____________________   Date: ____________', { x: M + 6, y: this.y - 32, size: 8.5, font: this.f.regular, color: MUTED });
    }
    this.y -= 56;
  }
}

async function fontsFor(doc: PDFDocument): Promise<Fonts> {
  return { regular: await doc.embedFont(StandardFonts.Helvetica), bold: await doc.embedFont(StandardFonts.HelveticaBold), mono: await doc.embedFont(StandardFonts.Courier) };
}

/** Front matter: cover and scope, document index, manifest, approval and execution record. */
async function frontMatter(s: PackageSnapshot, logoBytes: Buffer | null, startPages: Map<string, number> | null) {
  const doc = await PDFDocument.create();
  const f = await fontsFor(doc);
  const logo = logoBytes ? await doc.embedPng(logoBytes).catch(() => null) : null;
  const w = new Writer(doc, f, s, logo);
  w.newPage();
  w.heading(`${s.kind === 'AMENDMENT' ? 'Amendment' : s.kind === 'RENEWAL' ? 'Renewal agreement' : 'Supplier agreement'} ${s.number}`);
  w.para(s.title, { size: 11, bold: true });
  w.fields([
    ['Supplier (legal entity)', `${s.supplier.legalEntity} (${s.supplier.code})`],
    ['Manufacturing sites covered', s.sites.map((x) => `${x.code} ${x.name}${x.country ? `, ${x.country}` : ''}`).join('; ')],
    ['Product families', s.productFamilies.join(', ') || 'Not restricted'],
    ...(s.parentNumber ? ([[s.kind === 'AMENDMENT' ? 'Amends' : 'Renews and supersedes', s.parentNumber]] as Array<[string, string]>) : []),
    ['Effective date', s.effectiveFrom ?? (s.stage === 'EXECUTED' ? '-' : 'Set when executed')],
    ['Expiry / renewal date', s.expiresOn ?? 'None stated'],
    ...(s.changeSummary ? ([['Change summary', s.changeSummary]] as Array<[string, string]>) : []),
    ...(s.exceptions ? ([['Exceptions and restrictions', s.exceptions]] as Array<[string, string]>) : []),
    ['Manifest SHA-256', s.manifestSha256 ?? 'Assigned at PDI approval'],
  ]);
  w.heading('Document index and order of precedence');
  w.para('Where incorporated documents conflict, the document with the lower precedence number governs for the scope stated, unless the approved conflict resolution below says otherwise.', { size: 8.5, color: MUTED });
  const ordered = [...s.lines].sort((a, b) => a.precedence - b.precedence);
  w.table(
    [
      { title: 'Prec.', width: 6 },
      { title: 'Reference', width: 13 },
      { title: 'Role', width: 16 },
      { title: 'Document', width: 14 },
      { title: 'Rev', width: 6 },
      { title: 'Title', width: 25 },
      { title: 'Applies to', width: 20 },
      { title: 'Page', width: 6 },
    ],
    ordered.map((l) => [
      String(l.precedence),
      l.contractualRef,
      `${ROLE_TEXT[l.role]}${l.action !== 'INCORPORATE' ? ` (${l.action.toLowerCase()})` : ''}`,
      l.documentNumber,
      l.revisionLabel,
      l.title,
      l.appliesTo,
      l.action === 'REMOVE' ? 'Removed' : startPages?.get(l.key) ? String(startPages.get(l.key)) : '-',
    ]),
  );
  w.heading('Manifest');
  w.para('Each line binds one exact revision. The SHA-256 is that of the stored original (or, for a part schedule, of its released content).', { size: 8.5, color: MUTED });
  w.table(
    [
      { title: 'Document / Rev', width: 22 },
      { title: 'SHA-256', width: 58, mono: true },
      { title: 'Reference', width: 20 },
    ],
    ordered.map((l) => [`${l.documentNumber} Rev ${l.revisionLabel}`, l.sha256, l.contractualRef]),
    7,
  );
  if (s.conflicts.length) {
    w.heading('Precedence conflicts identified');
    for (const c of s.conflicts) w.para(`- ${c}`, { size: 8.5 });
    w.para(`Resolution recorded at approval: ${s.conflictResolution ?? 'Not yet recorded'}`, { size: 8.5, bold: true });
  }
  w.newPage();
  w.heading('PDI approval and execution');
  const sig = (role: SignatureRole) => s.signatures.find((x) => x.role === role) ?? null;
  w.para('Internal approval and legal review are PDI controls recorded in TQM. They are not execution of the agreement.', { size: 8.5, color: MUTED });
  w.signatureBlock(SIGNATURE_TEXT.PDI_APPROVAL, sig('PDI_APPROVAL'));
  w.signatureBlock(SIGNATURE_TEXT.LEGAL_REVIEW, sig('LEGAL_REVIEW'));
  w.para(
    s.stage === 'EXECUTED'
      ? `Execution recorded from the signed agreement (SHA-256 ${s.executedCopySha256 ?? '-'}). The signatures below are attested from that document; TQM applies no electronic signature.`
      : 'Execution: the authorized signatories sign the agreement outside TQM. The signed copy is then recorded in TQM against this manifest.',
    { size: 8.5, color: MUTED },
  );
  w.signatureBlock(SIGNATURE_TEXT.PDI_SIGNATORY, sig('PDI_SIGNATORY'));
  w.signatureBlock(`${SIGNATURE_TEXT.SUPPLIER_SIGNATORY} - ${s.supplier.legalEntity}`, sig('SUPPLIER_SIGNATORY'));
  return { doc, w, f };
}

async function schedulePages(s: PackageSnapshot, line: PackageLine, schedule: ScheduleContent, logoBytes: Buffer | null) {
  const doc = await PDFDocument.create();
  const f = await fontsFor(doc);
  const logo = logoBytes ? await doc.embedPng(logoBytes).catch(() => null) : null;
  const w = new Writer(doc, f, s, logo);
  w.newPage();
  w.heading(`${line.contractualRef}: part-specific schedule ${schedule.partNumber}`);
  w.fields([
    ['Part', `${schedule.partNumber} - ${schedule.partDescription}`],
    ['Technical baseline', `${schedule.baselineTitle}, Rev ${line.revisionLabel}`],
    ['Released', schedule.releasedAt?.slice(0, 10) ?? '-'],
    ['Drawing / document', schedule.documentRef ?? '-'],
    ['Governing specification', schedule.governingSpec ?? '-'],
    ...Object.entries(schedule.fields).map(([k, v]) => [SCHEDULE_FIELDS.find((f) => f.key === k)?.label ?? k, v] as [string, string]),
  ]);
  w.para('Requirements below are the released baseline characteristics; TQM does not add acceptance criteria.', { size: 8.5, color: MUTED });
  w.table(
    [
      { title: 'Key', width: 12 },
      { title: 'Characteristic', width: 26 },
      { title: 'Requirement', width: 24 },
      { title: 'Method', width: 18 },
      { title: 'Spec clause', width: 14 },
      { title: 'Special', width: 6 },
    ],
    schedule.characteristics.map((c) => [c.key, c.name, c.requirement, c.method ?? '-', c.specReference ?? '-', c.special ? 'Yes' : '']),
  );
  return { doc, generated: w.generated.length };
}

export interface RenderedPackage {
  bytes: Uint8Array;
  pageCount: number;
  validation: { ok: boolean; checks: Array<{ name: string; ok: boolean; detail: string }> };
}

/** Load a stored original by its revision, verifying the stored bytes against the recorded SHA-256. */
async function originalFor(svc: Services, line: PackageLine): Promise<{ bytes: Buffer; doc: PDFDocument } | null> {
  if (line.source.kind === 'DOCUMENT') {
    const r = await one<{ storage_key: string; sha256: string }>(svc.db, `SELECT f.storage_key, r.sha256 FROM controlled_document_revision r JOIN file_object f ON f.id = r.file_id WHERE r.id = $1`, [line.source.revisionId]);
    if (!r || r.sha256 !== line.sha256) throw new PermanentJobError(`${line.documentNumber} Rev ${line.revisionLabel} is not the incorporated revision`);
    const bytes = await svc.storage.readVerified(r.storage_key, r.sha256);
    return { bytes, doc: await PDFDocument.load(bytes, { updateMetadata: false }) };
  }
  if (line.source.kind === 'EXHIBIT' && line.source.mime === 'application/pdf') {
    const r = await one<{ storage_key: string; sha256: string }>(svc.db, 'SELECT storage_key, sha256 FROM file_object WHERE id = $1', [line.source.fileId]);
    if (!r || r.sha256 !== line.sha256) throw new PermanentJobError(`Exhibit ${line.title} is not the incorporated file`);
    const bytes = await svc.storage.readVerified(r.storage_key, r.sha256);
    return { bytes, doc: await PDFDocument.load(bytes, { updateMetadata: false }) };
  }
  return null;
}

/**
 * Renders the package: generated front matter, then each incorporated document in precedence order
 * appended page for page from its stored original (never altered), part schedules as generated
 * pages. The output is validated: every appended page must carry its original's content unchanged.
 */
export async function renderPackage(svc: Services, s: PackageSnapshot): Promise<RenderedPackage> {
  const ordered = [...s.lines].filter((l) => l.action !== 'REMOVE').sort((a, b) => a.precedence - b.precedence);
  const sections: Array<{ line: PackageLine; original: { bytes: Buffer; doc: PDFDocument } | null; schedule: PDFDocument | null; pages: number }> = [];
  for (const line of ordered) {
    let original: { bytes: Buffer; doc: PDFDocument } | null = null;
    try {
      original = await originalFor(svc, line);
    } catch (err) {
      if (err instanceof EvidenceIntegrityError) throw new PermanentJobError(`${line.documentNumber}: ${err.message}. Restore the file from backup.`);
      throw err;
    }
    const schedule = line.source.kind === 'SCHEDULE' ? (await schedulePages(s, line, line.source.schedule, svc.logo)).doc : null;
    sections.push({ line, original, schedule, pages: original ? original.doc.getPageCount() : schedule ? schedule.getPageCount() : 0 });
  }
  // Pass 1 counts the front matter so the index can give each document's first page.
  const frontCount = (await frontMatter(s, svc.logo, null)).doc.getPageCount();
  const starts = new Map<string, number>();
  let next = frontCount + 1;
  for (const sec of sections) {
    if (!sec.pages) continue;
    starts.set(sec.line.key, next);
    next += sec.pages;
  }
  const { doc, w } = await frontMatter(s, svc.logo, starts);
  if (doc.getPageCount() !== frontCount) throw new PermanentJobError('Package front matter changed length between layout passes');
  const generated = new Set<PDFPage>(w.generated);
  const appended: Array<{ line: PackageLine; first: number; originalHashes: string[] }> = [];
  for (const sec of sections) {
    const src = sec.original?.doc ?? sec.schedule;
    if (!src) continue;
    const first = doc.getPageCount();
    const pages = await doc.copyPages(src, src.getPageIndices());
    for (const p of pages) {
      doc.addPage(p);
      if (!sec.original) generated.add(p);
    }
    if (sec.original) appended.push({ line: sec.line, first, originalHashes: sec.original.doc.getPages().map((p) => pageContentHash(p)) });
  }
  const total = doc.getPageCount();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.getPages().forEach((p, i) => {
    if (!generated.has(p)) return;
    const text = pdfText(`${s.number} - Edition ${s.edition} - Page ${i + 1} of ${total}`);
    p.drawText(text, { x: (W - font.widthOfTextAtSize(text, 7.5)) / 2, y: 22, size: 7.5, font, color: MUTED });
  });
  doc.setTitle(pdfText(`${s.number} supplier agreement package, edition ${s.edition}`));
  doc.setProducer('PDI TQM');
  doc.setCreationDate(new Date(s.generatedAt));
  doc.setModificationDate(new Date(s.generatedAt));
  const bytes = await doc.save();

  // Validation: reload the output and compare every appended page with its original.
  const out = await PDFDocument.load(bytes, { updateMetadata: false });
  const outPages = out.getPages();
  const checks: RenderedPackage['validation']['checks'] = [
    { name: 'Page count', ok: out.getPageCount() === total, detail: `${out.getPageCount()} pages` },
    { name: 'Manifest', ok: s.stage === 'DRAFT' || !!s.manifestSha256, detail: s.manifestSha256 ?? 'Draft preview' },
  ];
  for (const a of appended) {
    const same = a.originalHashes.every((h, i) => outPages[a.first + i] && pageContentHash(outPages[a.first + i]!) === h);
    checks.push({
      name: `${a.line.documentNumber} Rev ${a.line.revisionLabel}`,
      ok: same,
      detail: same ? `${a.originalHashes.length} page(s) appended unaltered from the original (SHA-256 ${a.line.sha256.slice(0, 16)}...)` : 'An appended page differs from the stored original',
    });
  }
  return { bytes, pageCount: total, validation: { ok: checks.every((c) => c.ok), checks } };
}

/** Freezes a package edition (approved or executed) and queues its rendering. */
export async function queuePackage(tx: Queryable, agreementId: string, snapshot: Omit<PackageSnapshot, 'edition'>) {
  const prior = await one<{ max: number | null }>(tx, 'SELECT max(edition) AS max FROM report_snapshot WHERE subject_type = $1 AND subject_id = $2', [AGREEMENT_SUBJECT, agreementId]);
  const edition = (prior?.max ?? 0) + 1;
  const full: PackageSnapshot = { ...snapshot, edition };
  const snap = await one<{ id: string }>(
    tx,
    `INSERT INTO report_snapshot (subject_type, subject_id, edition, snapshot, sha256) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [AGREEMENT_SUBJECT, agreementId, edition, JSON.stringify(full), sha256(canonicalJson(full))],
  );
  await enqueueJob(tx, 'agreement_package', `agreement_package:${snap!.id}`, { snapshotId: snap!.id });
  return { edition, snapshotId: snap!.id };
}

export function agreementPackageHandler(svc: Services) {
  return async (job: JobRow) => {
    const snapshotId = String(job.payload.snapshotId ?? '');
    const snap = await one<{ id: string; subject_id: string; edition: number; snapshot: PackageSnapshot; sha256: string }>(
      svc.db,
      'SELECT id, subject_id, edition, snapshot, sha256 FROM report_snapshot WHERE id = $1 AND subject_type = $2',
      [snapshotId, AGREEMENT_SUBJECT],
    );
    if (!snap) throw new PermanentJobError(`Agreement package snapshot ${snapshotId} not found`);
    if (await one(svc.db, 'SELECT 1 FROM report_rendition WHERE snapshot_id = $1', [snap.id])) return;
    if (sha256(canonicalJson(snap.snapshot)) !== snap.sha256) throw new PermanentJobError('Agreement package snapshot failed integrity verification');
    const rendered = await renderPackage(svc, snap.snapshot);
    if (!rendered.validation.ok) {
      throw new PermanentJobError(`Package ${snap.snapshot.number} failed validation: ${rendered.validation.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('; ')}`);
    }
    const staged = await svc.storage.stageBuffer(Buffer.from(rendered.bytes));
    const storageKey = await svc.storage.finalize(staged);
    try {
      await withTransaction(svc.db, async (tx) => {
        const file = await one<{ id: string }>(
          tx,
          `INSERT INTO file_object (kind, status, sha256, byte_size, mime_type, original_name, storage_key) VALUES ('REPORT','AVAILABLE',$1,$2,'application/pdf',$3,$4) RETURNING id`,
          [staged.sha256, staged.size, `${snap.snapshot.number}-package-E${snap.edition}.pdf`, storageKey],
        );
        const rendition = await one<{ id: string }>(
          tx,
          `INSERT INTO report_rendition (snapshot_id, subject_type, subject_id, edition, file_id, sha256, page_count) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [snap.id, AGREEMENT_SUBJECT, snap.subject_id, snap.edition, file!.id, staged.sha256, rendered.pageCount],
        );
        await tx.query(`INSERT INTO controlled_output_validation (rendition_id, ok, result) VALUES ($1, $2, $3)`, [rendition!.id, true, JSON.stringify(rendered.validation)]);
        await audit(tx, {
          actorId: null,
          action: 'agreement.render',
          entityType: 'supplier_agreement',
          entityId: snap.subject_id,
          summary: `Rendered ${snap.snapshot.number} package edition ${snap.edition} (${rendered.pageCount} pages; ${rendered.validation.checks.length} checks passed)`,
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
