// Suggested digital tokens (Drawing B6) — reference approximation pending approved brand guide (POL-07).
export const C = {
  navy: '#1E2D50',
  navyDark: '#152440',
  slate: '#4B5563',
  muted: '#8A93A3',
  text: '#1F2937',
  border: '#D8DDE5',
  section: '#ECEFF3',
  stripe: '#F8F9FB',
  green: '#229A61',
  amber: '#BB8427',
  red: '#C63B33',
  white: '#FFFFFF',
};

export const PAGE = { width: 612, height: 792 };
export const MARGIN = 36; // 0.5 in
export const CONTENT_W = PAGE.width - MARGIN * 2;
export const FOOTER_H = 22;

/**
 * Band printed under the masthead of summary and worksheet PDFs that are not the controlled record,
 * so they cannot be mistaken for controlled output. Snapshots without a notice (issued before it was
 * introduced) render exactly as they were issued.
 */
export function drawNoticeBand(doc: PDFKit.PDFDocument, y: number, text: string): number {
  doc.font('Helvetica-Bold').fontSize(7.6);
  const h = Math.max(20, doc.heightOfString(text, { width: CONTENT_W - 20 }) + 10);
  doc.rect(MARGIN, y, CONTENT_W, h).fill('#FFF4E0');
  doc.rect(MARGIN, y, 3, h).fill(C.amber);
  doc.fillColor('#7A5310').text(text, MARGIN + 12, y + 5, { width: CONTENT_W - 20 });
  return y + h + 8;
}

export const SUMMARY_FOOTER = 'Summary - not a controlled document';
