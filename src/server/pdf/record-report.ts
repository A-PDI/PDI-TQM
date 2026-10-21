import PDFDocument from 'pdfkit';
import { formatDate, pdfText } from './text.js';
import { C, CONTENT_W, FOOTER_H, MARGIN, PAGE } from './theme.js';

/** Structured, immutable content for a PDI-branded controlled record (approval, NCR, SCAR …). */
export interface RecordReportSnapshot {
  kind: 'RECORD_REPORT';
  schemaVersion: 1;
  title: string;
  docCode: string;
  number: string;
  edition: number;
  generatedAt: string;
  displayTimeZone: string;
  outcome: { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral'; note: string };
  meta: Array<[string, string]>;
  sections: Array<
    | { title: string; kind: 'table'; columns: Array<{ header: string; width: number }>; rows: string[][] }
    | { title: string; kind: 'text'; paragraphs: string[] }
  >;
}

const BOTTOM = PAGE.height - MARGIN - FOOTER_H;
const TONE = { good: C.green, warn: C.amber, bad: C.red, neutral: C.slate };

export async function renderRecordReport(s: RecordReportSnapshot, logo: Buffer | null): Promise<{ bytes: Buffer; pageCount: number }> {
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    bufferPages: true,
    info: { Title: `${s.title} ${s.number}`, Author: 'PDI Quality Control', Subject: s.docCode, Creator: 'PDI TQMS', CreationDate: new Date(s.generatedAt) },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    doc.on('end', () => resolve());
    doc.on('error', reject);
  });
  const font = (name = 'Helvetica', size = 8, color = C.text) => doc.font(name).fontSize(size).fillColor(color);
  let y = MARGIN;

  const masthead = (first: boolean) => {
    const h = first ? 54 : 26;
    doc.rect(MARGIN, MARGIN, CONTENT_W, h).fill(C.navy);
    if (first) {
      if (logo) {
        doc.roundedRect(MARGIN + 10, MARGIN + 9, 98, 36, 3).fill(C.white);
        doc.image(logo, MARGIN + 12, MARGIN + 10, { fit: [94, 34], align: 'center', valign: 'center' });
      }
      font('Helvetica-Bold', 13, C.white).text(pdfText(s.title.toUpperCase()), MARGIN + 110, MARGIN + 14, { width: CONTENT_W - 220, align: 'center' });
      font('Helvetica', 7.5, '#C9D1E0').text(pdfText(`${s.docCode} · ${s.number} · Edition ${s.edition}`), MARGIN, MARGIN + 34, { width: CONTENT_W, align: 'center' });
    } else {
      font('Helvetica-Bold', 8.5, C.white).text(pdfText(s.title.toUpperCase()), MARGIN + 10, MARGIN + 9, { lineBreak: false });
      font('Helvetica', 7.5, '#C9D1E0').text(pdfText(`${s.number} · continued`), MARGIN, MARGIN + 9.5, { width: CONTENT_W - 10, align: 'right' });
    }
    y = MARGIN + h + 12;
  };
  const newPage = () => {
    doc.addPage();
    masthead(false);
  };
  const sectionBar = (title: string) => {
    if (y + 40 > BOTTOM) newPage();
    doc.rect(MARGIN, y, CONTENT_W, 18).fill(C.section);
    doc.rect(MARGIN, y, 3, 18).fill(C.navy);
    font('Helvetica-Bold', 8.5, C.navy).text(pdfText(title), MARGIN + 10, y + 5, { width: CONTENT_W - 20, lineBreak: false });
    y += 22;
  };

  masthead(true);
  const colW = CONTENT_W / 2;
  for (let r = 0; r < s.meta.length; r += 2) {
    const pair = [s.meta[r]!, s.meta[r + 1]];
    font('Helvetica', 8.5);
    const h = Math.max(...pair.map((m) => (m ? doc.heightOfString(pdfText(m[1]), { width: colW - 120 }) : 0)));
    const rowH = Math.max(18, h + 8);
    pair.forEach((m, ci) => {
      if (!m) return;
      const x = MARGIN + ci * colW;
      doc.rect(x, y, colW, rowH).lineWidth(0.5).strokeColor(C.border).stroke();
      font('Helvetica-Bold', 6.5, C.muted).text(pdfText(m[0].toUpperCase()), x + 6, y + 6, { width: 104, lineBreak: false });
      font('Helvetica', 8.5, C.text).text(pdfText(m[1]), x + 112, y + 4.5, { width: colW - 120 });
    });
    y += rowH;
  }
  y += 10;
  const tone = TONE[s.outcome.tone];
  doc.rect(MARGIN, y, CONTENT_W, 26).fill(C.white).lineWidth(1).strokeColor(tone).stroke();
  doc.rect(MARGIN, y, 6, 26).fill(tone);
  font('Helvetica-Bold', 11, tone).text(pdfText(s.outcome.label), MARGIN + 14, y + 8, { lineBreak: false });
  font('Helvetica', 7, C.slate).text(pdfText(s.outcome.note), MARGIN + 250, y + 6, { width: CONTENT_W - 258 });
  y += 36;

  for (const section of s.sections) {
    // Keep a section title with its first content: title (22) + table header (14) + first row, or the first paragraph.
    font('Helvetica', section.kind === 'table' ? 7.5 : 8);
    const firstH =
      section.kind === 'table'
        ? 14 +
          (section.rows[0]
            ? Math.max(16, ...section.rows[0].map((cell, i) => doc.heightOfString(pdfText(cell) || ' ', { width: section.columns[i]!.width * CONTENT_W - 8, lineGap: 1 }) + 8))
            : 18)
        : section.paragraphs[0]
          ? doc.heightOfString(pdfText(section.paragraphs[0]), { width: CONTENT_W - 8 }) + 4
          : 0;
    if (y + 22 + firstH > BOTTOM) newPage();
    sectionBar(section.title);
    if (section.kind === 'text') {
      for (const p of section.paragraphs) {
        font('Helvetica', 8, C.text);
        const h = doc.heightOfString(pdfText(p), { width: CONTENT_W - 8 });
        if (y + h > BOTTOM) newPage();
        doc.text(pdfText(p), MARGIN + 4, y, { width: CONTENT_W - 8 });
        y += h + 4;
      }
      y += 6;
      continue;
    }
    const widths = section.columns.map((c) => c.width * CONTENT_W);
    const header = () => {
      doc.rect(MARGIN, y, CONTENT_W, 14).fill('#E4E8EE');
      let x = MARGIN;
      section.columns.forEach((c, i) => {
        font('Helvetica-Bold', 6.8, C.slate).text(pdfText(c.header), x + 4, y + 4, { width: widths[i]! - 8, lineBreak: false });
        x += widths[i]!;
      });
      y += 14;
    };
    header();
    if (!section.rows.length) {
      font('Helvetica-Oblique', 7.5, C.muted).text('None recorded.', MARGIN + 4, y + 4);
      y += 18;
    }
    section.rows.forEach((row, ri) => {
      font('Helvetica', 7.5);
      const rowH = Math.max(16, ...row.map((cell, i) => doc.heightOfString(pdfText(cell) || ' ', { width: widths[i]! - 8, lineGap: 1 }) + 8));
      if (y + rowH > BOTTOM) {
        newPage();
        sectionBar(`${section.title} (continued)`);
        header();
      }
      if (ri % 2 === 1) doc.rect(MARGIN, y, CONTENT_W, rowH).fill(C.stripe);
      let x = MARGIN;
      row.forEach((cell, i) => {
        const statusColor = /^(PASS|ACCEPTED|ACKNOWLEDGED|SATISFIED|QUALIFIED)\b/.test(cell)
          ? C.green
          : /^(FAIL|REJECTED|OBJECTED)\b/.test(cell)
            ? C.red
            : /^(WARN|CONDITIONAL|WAIVED|CONDITIONALLY)/.test(cell)
              ? C.amber
              : C.text;
        font(statusColor === C.text ? 'Helvetica' : 'Helvetica-Bold', 7.5, statusColor).text(pdfText(cell), x + 4, y + 4, { width: widths[i]! - 8, lineGap: 1 });
        x += widths[i]!;
      });
      doc.moveTo(MARGIN, y + rowH).lineTo(MARGIN + CONTENT_W, y + rowH).lineWidth(0.5).strokeColor(C.border).stroke();
      y += rowH;
    });
    y += 10;
  }

  const range = doc.bufferedPageRange();
  for (let p = range.start; p < range.start + range.count; p += 1) {
    doc.switchToPage(p);
    const bm = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const fy = PAGE.height - MARGIN - 10;
    doc.moveTo(MARGIN, fy - 6).lineTo(MARGIN + CONTENT_W, fy - 6).lineWidth(0.5).strokeColor(C.border).stroke();
    font('Helvetica', 6.8, C.muted).text(pdfText(`PDI Quality Control · ${s.docCode} · ${s.number} · Edition ${s.edition}`), MARGIN, fy, { width: CONTENT_W / 2, lineBreak: false });
    font('Helvetica', 6.8, C.muted).text(`Page ${p - range.start + 1} of ${range.count} · Issued ${formatDate(s.generatedAt, s.displayTimeZone)}`, MARGIN + CONTENT_W / 2, fy, {
      width: CONTENT_W / 2,
      align: 'right',
      lineBreak: false,
    });
    doc.page.margins.bottom = bm;
  }
  doc.end();
  await done;
  return { bytes: Buffer.concat(chunks), pageCount: range.count };
}
