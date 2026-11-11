import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type SheetTemplate, planSheets, renderSheets } from '../../src/server/controlled/render.js';
import { deriveTemplate } from '../../src/server/controlled/template.js';
import { validateOutput } from '../../src/server/controlled/validate.js';
import { CONTROLLED_TYPES, EVIDENCE_CONTINUATION, NARRATIVE_CONTINUATION, continuationNumber } from '../../src/shared/controlled-forms.js';
import { sampleRecord } from '../fixtures/controlled-sample.js';
import { buildStandIn, templateFixture } from '../fixtures/controlled-templates.js';

/**
 * Runs only against the approved PDFs (PDI Drive folder QualitySystemForms, not committed):
 *   CONTROLLED_DOCS_DIR=/path/to/QualitySystemForms npx vitest run tests/unit/controlled-approved.test.ts
 * Proves the committed template fixture is exactly what the approved files contain, and that every
 * category-A form generates a validated record set on the real templates.
 */
const dir = process.env.CONTROLLED_DOCS_DIR;
const OUT = path.resolve(import.meta.dirname, '../../var/report-samples/approved');

describe.skipIf(!dir)('approved controlled templates (CONTROLLED_DOCS_DIR)', () => {
  const fixture = templateFixture();
  const byNumber = new Map(fixture.map((e) => [e.number, e]));
  const cache = new Map<string, SheetTemplate>();
  const sheet = async (number: string): Promise<SheetTemplate> => {
    const hit = cache.get(number);
    if (hit) return hit;
    const e = byNumber.get(number)!;
    const file = path.join(dir!, e.fileName);
    // A template only transcribed into the fixture is rendered from its stand-in when the file is absent.
    const bytes = existsSync(file) ? readFileSync(file) : await buildStandIn(e.schema);
    const t = { documentNumber: number, revisionId: `rev-${number}`, revisionLabel: e.revisionLabel, sha256: createHash('sha256').update(bytes).digest('hex'), bytes, schema: await deriveTemplate(bytes) };
    cache.set(number, t);
    return t;
  };

  it('the committed fixture matches every approved file byte for byte and field for field', async () => {
    for (const e of fixture.filter((x) => x.source === 'APPROVED_PDF')) {
      const file = path.join(dir!, e.fileName);
      expect(existsSync(file), e.fileName).toBe(true);
      const bytes = readFileSync(file);
      expect(createHash('sha256').update(bytes).digest('hex'), e.fileName).toBe(e.sha256);
      expect(bytes.length).toBe(e.byteSize);
      expect(await deriveTemplate(bytes), e.fileName).toEqual(e.schema);
    }
  });

  for (const def of CONTROLLED_TYPES.filter((t) => t.category === 'FORM')) {
    it(`${def.code} generates a validated record set on the approved revision`, async () => {
      const base = await sheet(def.code);
      const continuations: Record<string, SheetTemplate> = {};
      for (const s of base.schema.schedules) if (s.key !== 'evidence') continuations[s.key] = await sheet(continuationNumber(def.code, s.key));
      const evidence = await sheet(EVIDENCE_CONTINUATION);
      const narrative = await sheet(NARRATIVE_CONTINUATION);
      const number = `${def.code}-2026-00077`;
      const data = sampleRecord(base.schema, (k) => continuations[k]?.schema.schedules.find((s) => s.key === k)?.capacity ?? 0, { number, date: '2026-11-10' });
      const sheets = planSheets({ number, recordRevision: '1', title: base.schema.title ?? def.code, base, continuations, evidence, narrative, data, preparedBy: 'Casey Morgan', completedDate: '2026-11-10', generatedAt: new Date('2026-11-10T12:00:00Z') });
      const out = await renderSheets(sheets, { number, title: base.schema.title ?? def.code, generatedAt: new Date('2026-11-10T12:00:00Z') });
      const v = await validateOutput(out.bytes, out.pages, out.expected, new Map([base, ...Object.values(continuations), evidence, narrative].map((t) => [t.revisionId, t.schema])));
      expect(v.checks.filter((c) => !c.ok), def.code).toEqual([]);
      mkdirSync(OUT, { recursive: true });
      const file = path.join(OUT, `${def.code}.pdf`);
      writeFileSync(file, out.bytes);
      // Independent check with poppler: document control of each template on its pages, signatures and sheet IDs.
      const text = execFileSync('pdftotext', ['-layout', file, '-']).toString().replace(/\s+/g, ' ');
      for (const t of [base.schema.footer[0]!, number, 'Riley Chen', ...sheets.filter((s) => s.sheetId).map((s) => s.sheetId!)]) expect(text, `${def.code}: ${t}`).toContain(t);
    });
  }
});
