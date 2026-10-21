import PDFDocument from 'pdfkit';
import type { InspectionReportSnapshot, ReportRow, ReportSection } from '../inspections/report-snapshot.js';
import { formatDate, formatDateTime, pdfText } from './text.js';
import { C, CONTENT_W, FOOTER_H, MARGIN, PAGE } from './theme.js';

const BOTTOM = PAGE.height - MARGIN - FOOTER_H;

type Status = 'P' | 'F' | 'A' | 'N' | null;

interface Segment {
  text: string;
  font?: 'Helvetica' | 'Helvetica-Bold' | 'Helvetica-Oblique';
  size?: number;
  color?: string;
}

interface Cell {
  segments?: Segment[];
  status?: Status;
  align?: 'left' | 'center' | 'right';
}

interface Column {
  header: string;
  width: number;
  align?: 'left' | 'center' | 'right';
}

export interface RenderInput {
  snapshot: InspectionReportSnapshot;
  logo: Buffer | null;
  photoBytes: Map<string, Buffer>;
}

export interface RenderResult {
  bytes: Buffer;
  pageCount: number;
}

const STATUS_TEXT: Record<'P' | 'F' | 'A' | 'N', string> = { P: 'Pass', F: 'Fail', A: 'Accepted', N: 'N/A' };
const OUTCOME_COLOR: Record<string, string> = { PASS: C.green, FAIL: C.red, ACCEPTED: C.amber };

export async function renderInspectionReport(input: RenderInput): Promise<RenderResult> {
  const { snapshot: s } = input;
  const doc = new PDFDocument({
    size: 'LETTER',
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    bufferPages: true,
    autoFirstPage: true,
    info: {
      Title: `Incoming Quality Inspection ${s.inspection.number}`,
      Author: 'PDI Quality Control',
      Subject: `${s.form.formNumber} ${s.form.component}`,
      Creator: 'PDI TQMS',
      CreationDate: new Date(s.generatedAt),
    },
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    doc.on('end', () => resolve());
    doc.on('error', reject);
  });

  let y = MARGIN;
  const tz = s.displayTimeZone;
  const formSubtitle = [s.form.formNumber, s.form.component.toUpperCase(), s.form.revisionLabel ? `REV ${s.form.revisionLabel}` : null]
    .filter(Boolean)
    .join(' · ');

  const font = (name: Segment['font'] = 'Helvetica', size = 8, color = C.text) => doc.font(name).fontSize(size).fillColor(color);
  const textHeight = (seg: Segment, width: number) => {
    font(seg.font, seg.size ?? 8);
    return doc.heightOfString(pdfText(seg.text) || ' ', { width, lineGap: 1 });
  };

  const masthead = (first: boolean) => {
    const h = first ? 54 : 26;
    doc.rect(MARGIN, MARGIN, CONTENT_W, h).fill(C.navy);
    if (first) {
      if (input.logo) {
        doc.roundedRect(MARGIN + 10, MARGIN + 9, 98, 36, 3).fill(C.white);
        doc.image(input.logo, MARGIN + 12, MARGIN + 10, { fit: [94, 34], align: 'center', valign: 'center' });
      } else {
        font('Helvetica-Bold', 22, C.white).text('PDI', MARGIN + 14, MARGIN + 15, { lineBreak: false });
      }
      font('Helvetica-Bold', 13, C.white).text('INCOMING QUALITY INSPECTION', MARGIN, MARGIN + 14, { width: CONTENT_W, align: 'center' });
      font('Helvetica', 7.5, '#C9D1E0').text(pdfText(formSubtitle), MARGIN, MARGIN + 33, { width: CONTENT_W, align: 'center' });
    } else {
      font('Helvetica-Bold', 8.5, C.white).text('INCOMING QUALITY INSPECTION', MARGIN + 10, MARGIN + 9, { lineBreak: false });
      font('Helvetica', 7.5, '#C9D1E0').text(pdfText(`${s.inspection.number} · ${formSubtitle} · continued`), MARGIN, MARGIN + 9.5, {
        width: CONTENT_W - 10,
        align: 'right',
      });
    }
    y = MARGIN + h + 12;
  };

  const newPage = () => {
    doc.addPage();
    masthead(false);
  };

  const ensure = (h: number) => {
    if (y + h > BOTTOM) newPage();
  };

  const sectionBar = (title: string, continued = false) => {
    ensure(40);
    doc.rect(MARGIN, y, CONTENT_W, 18).fill(C.section);
    doc.rect(MARGIN, y, 3, 18).fill(C.navy);
    font('Helvetica-Bold', 8.5, C.navy).text(pdfText(continued ? `${title} (continued)` : title), MARGIN + 10, y + 5, {
      width: CONTENT_W - 20,
      lineBreak: false,
    });
    y += 22;
  };

  const itemBar = (label: string) => {
    ensure(60);
    doc.rect(MARGIN, y, CONTENT_W, 20).fill(C.navy);
    font('Helvetica-Bold', 9, C.white).text(pdfText(label), MARGIN + 10, y + 6, { width: CONTENT_W - 20, lineBreak: false });
    y += 26;
  };

  const drawStatus = (status: Status, x: number, top: number, width: number) => {
    if (!status) {
      font('Helvetica-Oblique', 7, C.muted).text('Not answered', x, top, { width, align: 'center' });
      return;
    }
    const gx = x + 4;
    const gy = top;
    if (status === 'P') {
      doc.save().lineWidth(1.6).strokeColor(C.green).moveTo(gx, gy + 5).lineTo(gx + 3.5, gy + 8.5).lineTo(gx + 10, gy + 1).stroke().restore();
    } else if (status === 'F') {
      doc.save().lineWidth(1.6).strokeColor(C.red).moveTo(gx + 1, gy + 1).lineTo(gx + 9, gy + 9).moveTo(gx + 9, gy + 1).lineTo(gx + 1, gy + 9).stroke().restore();
    } else if (status === 'A') {
      font('Helvetica-Bold', 10, C.amber).text('A', gx + 1, gy, { lineBreak: false });
    } else {
      font('Helvetica-Bold', 7, C.muted).text('—', gx + 1, gy + 1, { lineBreak: false });
    }
    const color = status === 'P' ? C.green : status === 'F' ? C.red : status === 'A' ? C.amber : C.slate;
    font('Helvetica-Bold', 7.5, color).text(STATUS_TEXT[status], gx + 15, gy + 1.5, { width: width - 20, lineBreak: false });
  };

  const tableHeader = (columns: Column[]) => {
    doc.rect(MARGIN, y, CONTENT_W, 14).fill('#E4E8EE');
    let x = MARGIN;
    for (const col of columns) {
      font('Helvetica-Bold', 6.8, C.slate).text(pdfText(col.header), x + 4, y + 4, { width: col.width - 8, align: col.align ?? 'left', lineBreak: false });
      x += col.width;
    }
    y += 14;
  };

  const table = (title: string, columns: Column[], rows: Cell[][], preamble?: string) => {
    sectionBar(title);
    if (preamble) {
      font('Helvetica', 7.5, C.slate).text(pdfText(preamble), MARGIN + 4, y, { width: CONTENT_W - 8 });
      y += 13;
    }
    tableHeader(columns);
    rows.forEach((cells, index) => {
      const heights = cells.map((cell, ci) => {
        const w = columns[ci]!.width - 8;
        if (cell.status !== undefined) return 12;
        return (cell.segments ?? []).reduce((acc, seg) => acc + textHeight(seg, w) + 1, 0);
      });
      const rowH = Math.max(16, ...heights.map((h) => h + 8));
      if (y + rowH > BOTTOM) {
        newPage();
        sectionBar(title, true);
        tableHeader(columns);
      }
      if (index % 2 === 1) doc.rect(MARGIN, y, CONTENT_W, rowH).fill(C.stripe);
      let x = MARGIN;
      cells.forEach((cell, ci) => {
        const col = columns[ci]!;
        if (cell.status !== undefined) {
          drawStatus(cell.status, x, y + 4, col.width);
        } else {
          let ty = y + 4;
          for (const seg of cell.segments ?? []) {
            font(seg.font, seg.size ?? 8, seg.color ?? C.text).text(pdfText(seg.text), x + 4, ty, {
              width: col.width - 8,
              align: cell.align ?? col.align ?? 'left',
              lineGap: 1,
            });
            ty += textHeight(seg, col.width - 8) + 1;
          }
        }
        x += col.width;
      });
      doc.moveTo(MARGIN, y + rowH).lineTo(MARGIN + CONTENT_W, y + rowH).lineWidth(0.5).strokeColor(C.border).stroke();
      y += rowH;
    });
    y += 10;
  };

  const noteSegments = (row: ReportRow): Segment[] => {
    const segs: Segment[] = [];
    if (row.note) segs.push({ text: row.note });
    if (row.photoNumbers.length) segs.push({ text: `Photo ${row.photoNumbers.join(', ')}`, size: 7, color: C.slate, font: 'Helvetica-Oblique' });
    if (row.valves && row.valves.some((v) => v.status)) {
      segs.push({
        text: row.valves.map((v) => `${v.label}: ${v.status ? STATUS_TEXT[v.status] : '—'}`).join(' · '),
        size: 7,
        color: C.slate,
      });
    }
    return segs;
  };

  const readingSegs = (r: ReportRow['readings'][number]): Segment[] =>
    r.value === null
      ? [{ text: '—', color: C.muted }]
      : [{ text: r.outside ? `${r.value} *` : r.value, font: r.outside ? 'Helvetica-Bold' : 'Helvetica', color: r.outside ? C.red : C.text }];

  const specSegs = (row: ReportRow): Segment[] =>
    row.specReleased
      ? [{ text: row.spec ?? '' }]
      : [
          ...(row.spec ? [{ text: row.spec, size: 7 } as Segment] : []),
          { text: 'Specification not released — Engineering review', font: 'Helvetica-Oblique', size: 6.8, color: C.slate },
        ];

  const renderSection = (section: ReportSection) => {
    const rows = section.rows;
    switch (section.pattern) {
      case 'pfn_checklist':
      case 'pass_fail_checklist':
      case 'pfn_visual':
        table(
          section.title,
          [
            { header: '#', width: 22 },
            { header: section.key === 'A' ? 'Check Item' : 'Inspection Item', width: 128 },
            { header: 'Requirement', width: 196 },
            { header: 'Finding / Notes', width: 124 },
            { header: 'Status', width: 70 },
          ],
          rows.map((r, i) => [
            { segments: [{ text: String(i + 1), color: C.slate }] },
            { segments: [{ text: r.label }] },
            { segments: [{ text: r.criterion ?? '', color: C.slate }] },
            { segments: noteSegments(r) },
            { status: r.status },
          ]),
        );
        return;
      case 'dimensional':
        table(
          section.title,
          [
            { header: '#', width: 18 },
            { header: 'Measurement', width: 136 },
            { header: 'Spec / Limit', width: 96 },
            { header: 'Actual 1', width: 46, align: 'center' },
            { header: 'Actual 2', width: 46, align: 'center' },
            { header: 'Actual 3', width: 46, align: 'center' },
            { header: 'Notes', width: 84 },
            { header: 'Status', width: 68 },
          ],
          rows.map((r, i) => [
            { segments: [{ text: String(i + 1), color: C.slate }] },
            { segments: [{ text: r.label }, ...(r.location ? [{ text: r.location, size: 6.8, color: C.slate } as Segment] : [])] },
            { segments: specSegs(r) },
            ...r.readings.map((rd) => ({ segments: readingSegs(rd), align: 'center' as const })),
            { segments: noteSegments(r) },
            { status: r.status },
          ]),
        );
        return;
      case 'general_measurements':
        table(
          section.title,
          [
            { header: '#', width: 18 },
            { header: 'Measurement', width: 150 },
            { header: 'Specification', width: 130 },
            { header: 'Actual Value', width: 70, align: 'center' },
            { header: 'Notes', width: 104 },
            { header: 'Result', width: 68 },
          ],
          rows.map((r, i) => [
            { segments: [{ text: String(i + 1), color: C.slate }] },
            { segments: [{ text: r.label }] },
            { segments: specSegs(r) },
            { segments: readingSegs(r.readings[0]!), align: 'center' },
            { segments: noteSegments(r) },
            { status: r.status },
          ]),
        );
        return;
      case 'camshaft_bore':
      case 'fire_ring_protrusion':
      case 'groove_specs': {
        const n = section.readingLabels.length;
        const labelW = 120;
        const resultW = 68;
        const readingW = Math.floor((CONTENT_W - labelW - resultW) / n);
        const spare = CONTENT_W - labelW - resultW - readingW * n;
        table(
          section.title,
          [
            { header: 'Characteristic / Spec', width: labelW + spare },
            ...section.readingLabels.map((l) => ({ header: l, width: readingW, align: 'center' as const })),
            { header: 'Result', width: resultW },
          ],
          rows.flatMap((r) => {
            const main: Cell[] = [
              { segments: [{ text: r.label, font: 'Helvetica-Bold' }, ...specSegs(r)] },
              ...r.readings.map((rd) => ({ segments: readingSegs(rd), align: 'center' as const })),
              { status: r.status },
            ];
            const notes = noteSegments(r);
            return notes.length ? [main, [{ segments: notes }, ...r.readings.map(() => ({})), {}]] : [main];
          }),
        );
        return;
      }
      case 'valve_recession': {
        const n = section.readingLabels.length;
        const readingW = Math.floor((CONTENT_W - 50 - 150 - 68) / n);
        const notesW = CONTENT_W - 50 - 68 - readingW * n;
        table(
          section.title,
          [
            { header: 'Cyl', width: 50 },
            ...section.readingLabels.map((l) => ({ header: l, width: readingW, align: 'center' as const })),
            { header: 'Notes', width: notesW },
            { header: 'Result', width: 68 },
          ],
          rows.map((r) => [
            { segments: [{ text: r.label.replace('Cylinder ', 'C') }] },
            ...r.readings.map((rd) => ({ segments: readingSegs(rd), align: 'center' as const })),
            { segments: noteSegments(r) },
            { status: r.status },
          ]),
          section.limitSummary ?? undefined,
        );
        return;
      }
      case 'vacuum_test':
        table(
          section.title,
          [
            { header: 'Cylinder', width: 90 },
            { header: 'Result', width: 80 },
            { header: 'Valve results / Notes', width: CONTENT_W - 170 },
          ],
          rows.map((r) => [{ segments: [{ text: r.label }] }, { status: r.status }, { segments: noteSegments(r) }]),
        );
        return;
    }
  };

  // ---- Page 1: masthead, metadata grid, outcome ------------------------------------
  masthead(true);
  const i = s.inspection;
  const meta: Array<[string, string]> = [
    ['PART NUMBER', i.partNumber],
    ['INSPECTION NO.', i.number],
    ['DESCRIPTION', i.partDescription],
    ['INSPECTOR', i.inspector],
    ['PO NUMBER', i.poNumber ?? 'Not recorded'],
    ['DATE RECEIVED', formatDate(i.dateReceived, tz)],
    ['SUPPLIER / SITE', [i.supplier, i.site].filter(Boolean).join(' / ') || 'Not identified'],
    ['UNITS INSPECTED', `${i.unitCount}${i.lotSize ? ` of lot ${i.lotSize}` : ''}`],
    ['LOT / SHIPMENT', i.lotNumber ?? 'Not recorded'],
    ['FORM', `${s.form.formNumber}${s.form.revisionLabel ? ` Rev ${s.form.revisionLabel}` : ' (initial issue)'}`],
    ['SOURCE STATUS AT RECEIPT', sourceStateText(i.sourceState)],
    ['COMPLETED', i.completedAt ? formatDateTime(i.completedAt, tz) : s.draft ? 'Draft — not completed' : 'Not completed'],
  ];
  const colW = CONTENT_W / 2;
  for (let r = 0; r < meta.length; r += 2) {
    const pair = [meta[r]!, meta[r + 1]];
    const h = Math.max(
      ...pair.map((m) => {
        if (!m) return 0;
        font('Helvetica', 8.5);
        return doc.heightOfString(pdfText(m[1]), { width: colW - 120 });
      }),
    );
    const rowH = Math.max(18, h + 8);
    pair.forEach((m, ci) => {
      if (!m) return;
      const x = MARGIN + ci * colW;
      doc.rect(x, y, colW, rowH).lineWidth(0.5).strokeColor(C.border).stroke();
      font('Helvetica-Bold', 6.5, C.muted).text(m[0], x + 6, y + 6, { width: 104, lineBreak: false });
      font('Helvetica', 8.5, C.text).text(pdfText(m[1]), x + 112, y + 4.5, { width: colW - 120 });
    });
    y += rowH;
  }
  y += 10;

  // Outcome banner: reported outcome is distinct from material authorization.
  const outcome = i.outcome;
  const bannerColor = outcome ? OUTCOME_COLOR[outcome]! : C.slate;
  doc.rect(MARGIN, y, CONTENT_W, 26).fill(C.white).lineWidth(1).strokeColor(bannerColor).stroke();
  doc.rect(MARGIN, y, 6, 26).fill(bannerColor);
  font('Helvetica-Bold', 11, bannerColor).text(outcome ? `OVERALL OUTCOME: ${outcome}` : 'OVERALL OUTCOME: NOT DETERMINED', MARGIN + 14, y + 8, {
    lineBreak: false,
  });
  font('Helvetica', 7, C.slate).text(
    'Reported inspection outcome. This report does not authorize material release, disposition or a concession.',
    MARGIN + 250,
    y + 6,
    { width: CONTENT_W - 258 },
  );
  y += 34;

  const notices: string[] = [];
  if (s.baseline) {
    notices.push(
      `Governing limits: ${s.baseline.title}, Rev ${s.baseline.revisionLabel}${s.baseline.synthetic ? ' — SYNTHETIC staging baseline, not a PDI-approved specification' : ''}.`,
    );
  } else {
    notices.push('No released technical baseline applied: recorded measurements are observations, not validated against limits.');
  }
  if (s.review) {
    notices.push(
      `Independent review: ${s.review.decision === 'CONFIRMED' ? 'confirmed' : s.review.decision.toLowerCase()} by ${s.review.reviewer} on ${formatDateTime(s.review.reviewedAt, tz)}${s.review.comment ? ` — "${s.review.comment}"` : ''}.`,
    );
    for (const reason of s.review.reasons) notices.push(`Review item: ${reason}`);
  }
  if (s.amendment) {
    notices.push(`Amendment ${s.amendment.number} by ${s.amendment.by} on ${formatDateTime(s.amendment.at, tz)}: ${s.amendment.reason}. Earlier editions remain on file.`);
  }
  for (const n of notices) {
    font('Helvetica', 7.5, C.slate);
    const h = doc.heightOfString(pdfText(n), { width: CONTENT_W - 8 });
    ensure(h + 4);
    doc.text(pdfText(n), MARGIN + 4, y, { width: CONTENT_W - 8 });
    y += h + 3;
  }
  y += 8;

  // ---- Shared receiving section, then each unit ------------------------------------
  for (const section of s.shared) renderSection(section);

  for (const unit of s.units) {
    itemBar(`ITEM ${unit.unitIndex} OF ${s.units.length}${unit.serial ? ` · SERIAL ${unit.serial}` : ''}`);
    for (const section of unit.sections) renderSection(section);
    // Unit disposition kept beside the unit's last row.
    ensure(46);
    doc.rect(MARGIN, y, CONTENT_W, 16).fill(C.section);
    font('Helvetica-Bold', 7.5, C.navy).text(`ITEM ${unit.unitIndex} — RESULT`, MARGIN + 8, y + 5, { lineBreak: false });
    y += 18;
    const uc = unit.outcome ? OUTCOME_COLOR[unit.outcome]! : C.slate;
    font('Helvetica-Bold', 11, uc).text(unit.outcome ?? 'NOT DETERMINED', MARGIN, y + 2, { width: CONTENT_W, align: 'center' });
    y += 17;
    if (unit.dispositionNote) {
      font('Helvetica', 8, C.text);
      const h = doc.heightOfString(pdfText(unit.dispositionNote), { width: CONTENT_W - 16 });
      ensure(h + 4);
      doc.text(pdfText(unit.dispositionNote), MARGIN + 8, y, { width: CONTENT_W - 16, align: 'center' });
      y += h + 4;
    }
    y += 10;
  }

  // ---- Photographs: compact 3-across grid with captions ----------------------------
  if (s.photos.length) {
    sectionBar('PHOTOGRAPHS');
    const cols = 3;
    const gap = 10;
    const cellW = (CONTENT_W - gap * (cols - 1)) / cols;
    const imgH = 128;
    for (let idx = 0; idx < s.photos.length; idx += cols) {
      const batch = s.photos.slice(idx, idx + cols);
      const captionH = Math.max(
        ...batch.map((p) => {
          font('Helvetica', 6.8);
          return doc.heightOfString(pdfText(`Photo ${p.number} · ${p.context}${p.caption ? ` — ${p.caption}` : ''}`), { width: cellW });
        }),
      );
      const blockH = imgH + captionH + 10;
      if (y + blockH > BOTTOM) {
        newPage();
        sectionBar('PHOTOGRAPHS', true);
      }
      batch.forEach((p, ci) => {
        const x = MARGIN + ci * (cellW + gap);
        doc.rect(x, y, cellW, imgH).fill('#F1F3F6');
        const bytes = input.photoBytes.get(p.fileId);
        if (bytes) {
          doc.image(bytes, x + 2, y + 2, { fit: [cellW - 4, imgH - 4], align: 'center', valign: 'center' });
        } else {
          font('Helvetica-Oblique', 7, C.red).text('Image unavailable', x, y + imgH / 2, { width: cellW, align: 'center' });
        }
        font('Helvetica', 6.8, C.slate).text(pdfText(`Photo ${p.number} · ${p.context}${p.caption ? ` — ${p.caption}` : ''}`), x, y + imgH + 3, {
          width: cellW,
        });
      });
      y += blockH;
    }
  }

  // ---- Footer and page numbers on every page ---------------------------------------
  const range = doc.bufferedPageRange();
  const issued = s.draft ? `Printed ${formatDate(s.generatedAt, tz)}` : `Issued ${formatDate(s.generatedAt, tz)}`;
  for (let p = range.start; p < range.start + range.count; p += 1) {
    doc.switchToPage(p);
    const bottomMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;
    const fy = PAGE.height - MARGIN - 10;
    doc.moveTo(MARGIN, fy - 6).lineTo(MARGIN + CONTENT_W, fy - 6).lineWidth(0.5).strokeColor(C.border).stroke();
    font('Helvetica', 6.8, C.muted).text(pdfText(`PDI Quality Control · ${s.inspection.number} · ${s.draft ? 'Draft preview' : `Edition ${s.edition}`}`), MARGIN, fy, {
      width: CONTENT_W / 2,
      lineBreak: false,
    });
    font('Helvetica', 6.8, C.muted).text(`Page ${p - range.start + 1} of ${range.count} · ${issued}`, MARGIN + CONTENT_W / 2, fy, {
      width: CONTENT_W / 2,
      align: 'right',
      lineBreak: false,
    });
    if (s.draft) {
      doc.save();
      doc.rotate(-35, { origin: [PAGE.width / 2, PAGE.height / 2] });
      font('Helvetica-Bold', 40, '#C63B33').fillOpacity(0.12).text('DRAFT — NOT A CONTROLLED RECORD', 0, PAGE.height / 2 - 20, {
        width: PAGE.width,
        align: 'center',
        lineBreak: false,
      });
      doc.restore();
      doc.fillOpacity(1);
    }
    doc.page.margins.bottom = bottomMargin;
  }

  doc.end();
  await done;
  return { bytes: Buffer.concat(chunks), pageCount: range.count };
}

function sourceStateText(state: string): string {
  switch (state) {
    case 'NO_SOURCE':
      return 'No exact source identified';
    case 'NOT_APPROVED':
      return 'Source not approved — material held pending authorization';
    case 'IN_REVIEW':
      return 'Source approval in review';
    case 'APPROVED_CONDITIONAL':
      return 'Source approved with conditions';
    case 'APPROVED':
      return 'Source approved';
    case 'SUSPENDED':
      return 'Supplier/site SUSPENDED — material held pending authorized review';
    case 'EXPIRED':
      return 'Source approval expired — material held pending authorized review';
    case 'AT_RISK':
      return 'Source at risk — site qualification not current';
    default:
      return state;
  }
}
