import PDFDocument from 'pdfkit';

/** A small, genuine (fabricated-content) PDF document for evidence uploads. */
export async function makePdf(title: string): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'LETTER', info: { CreationDate: new Date('2026-01-01T00:00:00Z') } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => doc.on('end', () => resolve()));
  doc.fontSize(14).text(`FICTIONAL TEST DOCUMENT — ${title}`);
  doc.end();
  await done;
  return Buffer.concat(chunks);
}

/** A PDF carrying JavaScript in an OpenAction — must be rejected. */
export const MALICIOUS_PDF = Buffer.from(
  '%PDF-1.7\n1 0 obj << /Type /Catalog /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n',
  'latin1',
);
