import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

/**
 * Fictional stand-ins for documents PDI has not supplied: they let the pilot and the tests exercise
 * the agreement workflow end to end. Every page says it is synthetic. They hold structure only: no
 * legal terms, and no acceptance criteria, tolerances, classes or sampling plans.
 */
export const SYNTHETIC_MARK = 'SYNTHETIC TEST DOCUMENT - NOT AN APPROVED PDI DOCUMENT - NOT FOR SUPPLIER USE';

export interface SyntheticClause {
  ref: string;
  title: string;
}

/** Clause structure of the synthetic SCS-001 (headings only; content is PDI's to approve). */
export const SCS001_CLAUSES: SyntheticClause[] = [
  { ref: '§1', title: 'Scope' },
  { ref: '§2', title: 'Referenced documents' },
  { ref: '§3', title: 'Terms and definitions' },
  { ref: '§4', title: 'Supplier responsibilities' },
  { ref: '§5', title: 'Material and process control' },
  { ref: '§6', title: 'Casting quality' },
  { ref: '§6.1', title: 'Visual condition' },
  { ref: '§6.2', title: 'Dimensional conformance' },
  { ref: '§6.3', title: 'Internal soundness' },
  { ref: '§7', title: 'Identification and marking' },
  { ref: '§7.1', title: 'Part identification' },
  { ref: '§7.2', title: 'PDI logo' },
  { ref: '§7.3', title: 'Heat and lot traceability' },
  { ref: '§8', title: 'Inspection records' },
  { ref: '§9', title: 'Nonconforming product' },
  { ref: '§10', title: 'Packaging and preservation' },
];

/** Section structure of the synthetic MSA-001 (a proposed outline; the legal text is PDI counsel's). */
export const MSA001_SECTIONS: SyntheticClause[] = [
  { ref: '1', title: 'Parties and recitals' },
  { ref: '2', title: 'Definitions' },
  { ref: '3', title: 'Incorporated documents and order of precedence' },
  { ref: '4', title: 'Orders and forecasts' },
  { ref: '5', title: 'Quality requirements (Supplier Quality Agreement)' },
  { ref: '6', title: 'Specifications and part-specific schedules' },
  { ref: '7', title: 'Changes and notification' },
  { ref: '8', title: 'Term, renewal and termination' },
  { ref: '9', title: 'Amendments' },
  { ref: '10', title: 'General provisions' },
];

export async function syntheticDocumentPdf(opts: { number: string; title: string; revision: string; kind: 'SPECIFICATION' | 'AGREEMENT'; clauses: SyntheticClause[] }): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const red = rgb(0.78, 0.23, 0.2);
  const text = rgb(0.12, 0.16, 0.22);
  const placeholder =
    opts.kind === 'AGREEMENT'
      ? '[Legal text to be drafted and approved by PDI counsel. TQM supplies no contractual wording.]'
      : '[Requirements of the approved SCS-001 are not reproduced. Acceptance criteria, classes, tolerances and sampling come only from PDI-approved engineering documents.]';
  const perPage = 7;
  const pages = Math.max(1, Math.ceil(opts.clauses.length / perPage));
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage([612, 792]);
    page.drawRectangle({ x: 36, y: 740, width: 540, height: 22, color: rgb(1, 0.93, 0.9) });
    page.drawText(SYNTHETIC_MARK, { x: 44, y: 747, size: 8.5, font: bold, color: red });
    page.drawText(`${opts.number}  ${opts.title}`, { x: 44, y: 712, size: 13, font: bold, color: text });
    page.drawText(`Revision ${opts.revision}  -  ${opts.kind === 'AGREEMENT' ? 'Proposed structure for review' : 'Synthetic structure for workflow testing'}`, { x: 44, y: 694, size: 9, font: regular, color: text });
    let y = 660;
    for (const c of opts.clauses.slice(p * perPage, (p + 1) * perPage)) {
      page.drawText(`${c.ref}  ${c.title}`, { x: 44, y, size: 11, font: bold, color: text });
      y -= 16;
      page.drawText(placeholder.slice(0, 105), { x: 58, y, size: 8.5, font: regular, color: rgb(0.42, 0.45, 0.5) });
      if (placeholder.length > 105) {
        y -= 12;
        page.drawText(placeholder.slice(105), { x: 58, y, size: 8.5, font: regular, color: rgb(0.42, 0.45, 0.5) });
      }
      y -= 30;
    }
    page.drawText(`${opts.number} Rev ${opts.revision}  -  Page ${p + 1} of ${pages}  -  ${SYNTHETIC_MARK}`, { x: 44, y: 30, size: 6.5, font: regular, color: red });
  }
  doc.setTitle(`${opts.number} ${opts.title} Rev ${opts.revision} (synthetic)`);
  doc.setProducer('PDI TQM synthetic fixture');
  // Fixed dates keep the bytes (and so the SHA-256) stable for a given revision.
  doc.setCreationDate(new Date('2026-11-01T00:00:00Z'));
  doc.setModificationDate(new Date('2026-11-01T00:00:00Z'));
  return Buffer.from(await doc.save());
}

export const syntheticScs001 = (revision = '1.0') =>
  syntheticDocumentPdf({ number: 'SCS-001', title: 'Cast Component Quality & Identification Standard', revision, kind: 'SPECIFICATION', clauses: SCS001_CLAUSES });

export const syntheticMsa001 = (revision = '01') => syntheticDocumentPdf({ number: 'MSA-001', title: 'Master Supplier Agreement', revision, kind: 'AGREEMENT', clauses: MSA001_SECTIONS });

/** A fictional "signed copy" for the pilot: it stands in for the counter-signed agreement PDF. */
export async function syntheticSignedCopy(agreementNumber: string, signedOn: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([612, 792]);
  page.drawRectangle({ x: 36, y: 740, width: 540, height: 22, color: rgb(1, 0.93, 0.9) });
  page.drawText('FICTIONAL SIGNED COPY - TEST ENVIRONMENT - NOT A REAL AGREEMENT', { x: 44, y: 747, size: 9, font: bold, color: rgb(0.78, 0.23, 0.2) });
  page.drawText(`Signed copy of ${agreementNumber} (pilot illustration)`, { x: 44, y: 700, size: 13, font: bold });
  page.drawText(`Signatures shown are fictional and dated ${signedOn}. No legal effect.`, { x: 44, y: 680, size: 10, font: regular });
  doc.setTitle(`${agreementNumber} signed copy (fictional)`);
  doc.setCreationDate(new Date(`${signedOn}T12:00:00Z`));
  doc.setModificationDate(new Date(`${signedOn}T12:00:00Z`));
  return Buffer.from(await doc.save());
}
