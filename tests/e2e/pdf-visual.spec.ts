import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { InspectionReportSnapshot } from '../../src/server/inspections/report-snapshot.js';
import { renderInspectionReport } from '../../src/server/pdf/inspection-report.js';
import { type RecordReportSnapshot, renderRecordReport } from '../../src/server/pdf/record-report.js';
import { makePng } from '../fixtures/images.js';

/**
 * PDF visual regression (Construction Drawing F1): the representative reports are rendered from
 * frozen snapshots (tests/fixtures/pdf-snapshots, captured from real API runs) and every page is
 * compared with its baseline image. Refresh after an intended layout change with
 * `npx tsx scripts/capture-pdf-fixtures.ts` and `npx playwright test tests/e2e/pdf-visual.spec.ts --update-snapshots`.
 */
const ROOT = path.resolve(import.meta.dirname, '../..');
const FIXTURES = path.join(ROOT, 'tests/fixtures/pdf-snapshots');
const LOGO = path.join(ROOT, 'assets/brand/pdi-logo.png');

for (const file of readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort()) {
  const name = file.replace(/\.json$/, '');
  // Playwright requires a destructuring pattern for the fixtures argument; this test needs none.
  // eslint-disable-next-line no-empty-pattern
  test(`PDF baseline: ${name}`, async ({}, info) => {
    test.skip(info.project.name !== 'visual', 'runs in the pinned-font visual project');
    const snapshot = JSON.parse(readFileSync(path.join(FIXTURES, file), 'utf8')) as InspectionReportSnapshot | RecordReportSnapshot;
    const logo = existsSync(LOGO) ? readFileSync(LOGO) : null;
    let bytes: Buffer;
    if (snapshot.kind === 'INSPECTION_REPORT') {
      // Deterministic stand-in photographs, one distinct colour per photo number.
      const photoBytes = new Map(snapshot.photos.map((p) => [p.fileId, makePng(160, 120, [(p.number * 53) % 200, (p.number * 97) % 200, (p.number * 31) % 200])]));
      bytes = (await renderInspectionReport({ snapshot, logo, photoBytes })).bytes;
    } else {
      bytes = (await renderRecordReport(snapshot, logo)).bytes;
    }
    const pdf = info.outputPath(`${name}.pdf`);
    writeFileSync(pdf, bytes);
    const prefix = info.outputPath(name);
    // Standard PDF fonts are not embedded; rasterize with the pinned font set (see tests/fixtures/fonts.conf).
    execFileSync('pdftoppm', ['-r', '40', '-png', pdf, prefix], { env: { ...process.env, FONTCONFIG_FILE: path.join(ROOT, 'tests/fixtures/fonts.conf') } });
    const pages = readdirSync(path.dirname(prefix))
      .filter((f) => f.startsWith(`${name}-`) && f.endsWith('.png'))
      .sort((a, b) => Number(/-(\d+)\.png$/.exec(a)![1]) - Number(/-(\d+)\.png$/.exec(b)![1]));
    expect(`${pages.length} pages\n`).toMatchSnapshot(`${name}-pages.txt`);
    for (const [i, page] of pages.entries()) {
      expect(readFileSync(path.join(path.dirname(prefix), page))).toMatchSnapshot(`${name}-page-${i + 1}.png`, { maxDiffPixelRatio: 0.002, threshold: 0.02 });
    }
  });
}
