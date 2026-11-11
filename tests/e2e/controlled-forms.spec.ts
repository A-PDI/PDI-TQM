import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type APIRequestContext, type Browser, type Page, expect, request, test } from '@playwright/test';
import { IMPACT_AREAS } from '../../src/shared/quality.js';
import { makePdf } from '../fixtures/documents.js';
import { standInFiles, templateFixture } from '../fixtures/controlled-templates.js';
import { makePng } from '../fixtures/images.js';

/**
 * One full controlled record per major family, completed through the UI from the module record it
 * belongs to. Records of module events (sourcing request, inspection, first article, concession, NCR,
 * SCAR, change) open with the event and are approved by the module's own decision — one approval path;
 * the module's block is never offered for signature on the record. Each generated PDF is checked
 * against the approved revision (document control, continuation sheets, signatures, validation report).
 */
const PASSWORD = process.env.E2E_PASSWORD ?? 'E2E-Only-Password-2026';
const BASE = `http://localhost:${process.env.E2E_PORT ?? 3100}`;
const OUT = path.resolve('var/report-samples');
mkdirSync(OUT, { recursive: true });

const USERS = {
  inspector: 'jordan.rivera@example.com',
  quality: 'casey.morgan@example.com',
  engineering: 'taylor.brooks@example.com',
  purchasing: 'morgan.diaz@example.com',
  manager: 'riley.chen@example.com',
  admin: 'avery.patel@example.com',
} as const;
const NAMES: Record<keyof typeof USERS, string> = { inspector: 'Jordan Rivera', quality: 'Casey Morgan', engineering: 'Taylor Brooks', purchasing: 'Morgan Diaz', manager: 'Riley Chen', admin: 'Avery Patel' };

type Api = { ctx: APIRequestContext; call: (url: string, data?: unknown, method?: string) => Promise<any>; upload: (url: string, name: string, mimeType: string, buffer: Buffer) => Promise<any> }; // eslint-disable-line @typescript-eslint/no-explicit-any

async function apiAs(who: keyof typeof USERS): Promise<Api> {
  const ctx = await request.newContext({ baseURL: BASE });
  const res = await ctx.post('/api/auth/login', { data: { email: USERS[who], password: PASSWORD } });
  expect(res.status()).toBe(200);
  const { csrfToken } = await res.json();
  return {
    ctx,
    call: async (url, data, method = data === undefined ? 'GET' : 'POST') => {
      const r = await ctx.fetch(url, { method, data, headers: { 'x-csrf-token': csrfToken } });
      expect(r.status(), `${method} ${url}: ${await r.text()}`).toBeLessThan(300);
      return r.json();
    },
    upload: async (url, name, mimeType, buffer) => {
      const r = await ctx.post(url, { headers: { 'x-csrf-token': csrfToken }, multipart: { file: { name, mimeType, buffer } } });
      expect(r.status(), `upload ${url}: ${await r.text()}`).toBeLessThan(300);
      return r.json();
    },
  };
}

async function pageAs(browser: Browser, who: keyof typeof USERS): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto('/');
  await page.getByLabel('Email').fill(USERS[who]);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'My Work' })).toBeVisible();
  return page;
}

const localDate = (offsetDays = 0) => {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const footerOf = (code: string) => templateFixture().find((e) => e.number === code)!.schema.footer;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  // The administrator releases the approved revisions (structure-identical stand-ins in CI) in the Document Library.
  const admin = await apiAs('admin');
  for (const f of await standInFiles(['INT-01', 'SUP-01', 'SUP-03', 'ENG-04', 'OPS-02', 'OPS-04', 'VAL-02', 'OPS-05', 'OPS-06', 'OPS-07'])) {
    await admin.upload(`/api/documents/import?effectiveFrom=${localDate(-7)}`, f.name, 'application/pdf', f.bytes);
  }
});

/** Starts the controlled document from the module record's panel and returns the record page URL. */
async function startFrom(page: Page, moduleUrl: string, code: string): Promise<string> {
  await page.goto(moduleUrl);
  const panel = page.locator('section.card', { has: page.getByRole('heading', { name: /Controlled forms/ }) });
  await expect(panel.getByLabel('Controlled document to start')).toBeEnabled();
  const option = panel.getByLabel('Controlled document to start').locator('option', { hasText: code });
  await panel.getByLabel('Controlled document to start').selectOption(await option.getAttribute('value'));
  await panel.getByRole('button', { name: 'Start' }).click();
  await expect(page).toHaveURL(/\/controlled\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(code);
  // The approved revision the record is bound to opens from the record.
  const href = await page.getByRole('link', { name: 'Open approved revision' }).getAttribute('href');
  const pdf = await page.request.get(href!);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  // Sections expand on demand; open them all to check what was carried over from the module record.
  const closed = page.locator('details.section:not([open]) > summary');
  while ((await closed.count()) > 0) await closed.first().click();
  return page.url();
}

const shortText = (label: string, max: number | null) => `E2E ${label}`.replace(/[^\w /.-]/g, '').slice(0, Math.max(1, Math.min(max ?? 40, 40)));

/** Completes every entry the template defines; `addRows` adds rows to schedules (beyond the sheet → continuation). */
async function completeForm(page: Page, addRows: Record<string, number> = {}) {
  await page.locator('details.section').evaluateAll((els) => els.forEach((e) => ((e as HTMLDetailsElement).open = true)));
  for (const [schedule, n] of Object.entries(addRows)) {
    const button = page.getByRole('button', { name: new RegExp(`^\\+ Add (row|item) to ${schedule}`, 'i') });
    for (let i = 0; i < n; i += 1) await button.click();
  }
  // Free-form schedules without rows get one, so the record is complete in every section.
  for (const b of await page.getByRole('button', { name: /^\+ Add row to / }).all()) {
    const table = b.locator('xpath=preceding-sibling::div[contains(@class,"table-wrap")][1]');
    if ((await table.locator('tbody tr td input, tbody tr td select').count()) === 0) await b.click();
  }
  const controls = page.locator('.cf-grid .field input, .cf-grid .field select, .cf-grid .field textarea, .cf-table tbody input, .cf-table tbody select');
  const count = await controls.count();
  for (let i = 0; i < count; i += 1) {
    const c = controls.nth(i);
    if (!(await c.isVisible()) || (await c.inputValue())) continue;
    const tag = await c.evaluate((el) => el.tagName);
    const type = await c.getAttribute('type');
    if (tag === 'SELECT') {
      await c.selectOption({ index: 1 });
    } else if (type === 'date') {
      await c.fill(localDate());
    } else {
      const label = (await c.getAttribute('aria-label')) ?? (await c.evaluate((el) => (el.id ? (document.querySelector(`label[for="${el.id}"]`)?.textContent ?? '') : '')));
      const max = await c.getAttribute('maxlength');
      await c.fill(shortText(label, max ? Number(max) : null));
    }
  }
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Draft saved' })).toBeVisible();
  await expect(page.getByText(/item\(s\) to complete before submission/)).toHaveCount(0);
}

async function submit(page: Page) {
  await page.getByRole('button', { name: /^Submit for (approval|signatures|decision)$/ }).click();
  await expect(page.getByRole('status').filter({ hasText: /Submitted for/ })).toBeVisible();
  await expect(page.locator('.page-head .badge')).toHaveText(/Awaiting/);
}

/** Signs the next approval on the record as `who`; the deciding approver records the PDI decision. */
async function sign(browser: Browser, who: keyof typeof USERS, url: string, opts: { decision?: string; second?: 'required' | 'not required' } = {}) {
  const page = await pageAs(browser, who);
  await page.goto(url);
  await page.getByRole('button', { name: 'Sign…' }).first().click();
  const dialog = page.getByRole('dialog');
  if (await dialog.getByLabel('PDI decision').count()) {
    const select = dialog.getByLabel('PDI decision');
    if (opts.decision) await select.selectOption(opts.decision);
    else await select.selectOption({ index: 1 });
    await dialog.getByRole('textbox').first().fill(`E2E decision basis by ${NAMES[who]} (fictional)`);
    for (const input of await dialog.locator('input[type="text"]').all()) if (!(await input.inputValue())) await input.fill('25');
    for (const input of await dialog.locator('input[type="date"]').all()) await input.fill(localDate(90));
    if (opts.second) await dialog.getByLabel(opts.second === 'required' ? /Required — wait for this approval/ : /Not required for this record/).check();
  }
  await dialog.getByRole('button', { name: 'Sign' }).click();
  await expect(dialog).toHaveCount(0);
  await page.context().close();
}

/** Waits for the generated PDF and checks it against the approved revision it is bound to. */
async function verifyOutput(page: Page, code: string, sample: string, expectText: string[]) {
  await page.reload();
  await expect(page.locator('.page-head .badge')).toHaveText('Completed');
  const link = page.getByRole('link', { name: 'Open controlled PDF' });
  await expect(link).toBeVisible({ timeout: 30_000 });
  const report = page.getByRole('list', { name: 'Validation against the approved template' });
  await expect(report.getByText('Fail', { exact: true })).toHaveCount(0);
  for (const check of ['page count', 'page size', 'template layout', 'document control', 'entered values', 'references', 'flattened']) {
    await expect(report.locator('li', { hasText: `${check}:` }).getByText('Pass', { exact: true })).toBeVisible();
  }
  await expect(page.getByText(new RegExp(`Built on ${code} Rev 03`))).toBeVisible();
  const res = await page.request.get((await link.getAttribute('href'))!);
  expect(res.status()).toBe(200);
  const file = path.join(OUT, sample);
  writeFileSync(file, await res.body());
  expect(execFileSync('pdfinfo', [file]).toString()).toMatch(/Form:\s+none/);
  const text = execFileSync('pdftotext', ['-layout', file, '-']).toString().replace(/\s+/g, ' ');
  const number = (await page.getByRole('heading', { level: 1 }).innerText()).split(' — ')[0]!;
  for (const t of [number, ...footerOf(code), ...expectText]) expect(text, t).toContain(t);
  return { text, number };
}

/**
 * Opens the event's own controlled record from the module page (it was opened with the event) and
 * checks the approved revision it is bound to opens; returns the record page URL.
 */
async function openEventRecord(page: Page, moduleUrl: string, code: string): Promise<string> {
  await page.goto(moduleUrl);
  const status = page.getByRole('status', { name: `${code} approval record` }).first();
  await expect(status).toBeVisible();
  await status.getByRole('link', { name: new RegExp(`^${code}-\\d{4}-\\d{5}$`) }).click();
  await expect(page).toHaveURL(/\/controlled\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(code);
  await expect(page.getByRole('note', { name: 'Approval path' })).toContainText('One approval path');
  const href = await page.getByRole('link', { name: 'Open approved revision' }).getAttribute('href');
  const pdf = await page.request.get(href!);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  const closed = page.locator('details.section:not([open]) > summary');
  while ((await closed.count()) > 0) await closed.first().click();
  return page.url();
}

/** The module's approval block is not signable on the record: it shows where it is signed. */
async function expectModuleBlock(browser: Browser, who: keyof typeof USERS, url: string, text: RegExp) {
  const page = await pageAs(browser, who);
  await page.goto(url);
  const approvals = page.locator('section.card', { has: page.getByRole('heading', { name: 'Approvals' }) });
  const block = approvals.locator('li', { hasText: text });
  await expect(block).toBeVisible();
  await expect(block.getByRole('button', { name: 'Sign…' })).toHaveCount(0);
  await page.context().close();
}

test('sourcing: INT-01 opens with the sourcing request; its intake decision is signed on the form', async ({ browser }, info) => {
  test.skip(info.project.name !== 'controlled', 'controlled walkthrough');
  test.setTimeout(180_000);
  const purchasing = await apiAs('purchasing');
  const part = (await purchasing.call('/api/parts?q=TQ-PRK-3003'))[0];
  const nwr = (await purchasing.call('/api/suppliers')).find((s: { code: string }) => s.code === 'NWR');
  const site = (await purchasing.call(`/api/suppliers/${nwr.id}`)).sites.find((s: { code: string }) => s.code === 'P2');
  const req = await purchasing.call('/api/sourcing', { title: 'Second-source ring kit (E2E)', pathway: 'B', partId: part.id, supplierId: nwr.id, siteId: site.id, supplierPartNumber: 'NR-3003-E2E' });
  expect(req.controlled.number).toMatch(/^INT-01-/);

  const page = await pageAs(browser, 'purchasing');
  const url = await openEventRecord(page, `/sourcing/${req.id}`, 'INT-01');
  await expect(page.getByLabel(/Project \/ sourcing request ID/)).toHaveValue(req.number);
  await expect(page.getByLabel(/Project \/ sourcing request ID/)).toHaveAttribute('readonly', '');
  await completeForm(page);
  await submit(page);
  await sign(browser, 'engineering', url, { decision: 'Investigate' });
  await sign(browser, 'quality', url);
  await verifyOutput(page, 'INT-01', 'e2e-int-01.pdf', ['Investigate', NAMES.engineering, NAMES.quality, 'NR-3003-E2E']);
});

test('supplier: SUP-01 questionnaire completed in TQM, SUP-03 agreement attached with its signatures', async ({ browser }, info) => {
  test.skip(info.project.name !== 'controlled', 'controlled walkthrough');
  test.setTimeout(180_000);
  const purchasing = await apiAs('purchasing');
  const nwr = (await purchasing.call('/api/suppliers')).find((s: { code: string }) => s.code === 'NWR');
  const page = await pageAs(browser, 'purchasing');
  const url = await startFrom(page, `/suppliers/${nwr.id}`, 'SUP-01');
  await expect(page.getByLabel(/Supplier ID/)).toHaveValue('NWR');
  // The ten printed capability topics are answered; two more continue on the SUP-01 continuation sheet.
  await expect(page.locator('.cf-table th[scope="row"]').first()).not.toBeEmpty();
  await completeForm(page, { 'capability': 2 });
  await submit(page);
  await sign(browser, 'quality', url, { decision: 'Conditional' });
  await verifyOutput(page, 'SUP-01', 'e2e-sup-01.pdf', ['Conditional', NAMES.quality, 'SUP-01 | REV 0.3 | DRAFT - REVIEW ONLY', '1 of 1']);

  // SUP-03 (category B): the executed agreement is attached and completes with its required signatures.
  await page.goto(`/suppliers/${nwr.id}`);
  const agreementUrl = await startFrom(page, `/suppliers/${nwr.id}`, 'SUP-03');
  await page.getByLabel('Attach file').setInputFiles({ name: 'SQA-NWR-executed.pdf', mimeType: 'application/pdf', buffer: await makePdf('Executed SQA (fictional)') });
  await expect(page.getByRole('link', { name: 'SQA-NWR-executed.pdf' })).toBeVisible();
  await expect(page.getByText('Other format')).toBeVisible();
  await submit(page);
  for (const [label, name] of [['Legal approval', 'Counsel ref LGL-E2E'], ['PDI authorized signatory', 'Dana Whitfield'], ['Supplier authorized signatory', 'R. Okoye']] as const) {
    await page.locator('li', { hasText: label }).getByRole('button', { name: 'Record signature…' }).click();
    const d = page.getByRole('dialog');
    await d.getByLabel('Signatory name').fill(name);
    await d.getByLabel('Date signed').fill(localDate(-1));
    await d.getByRole('button', { name: 'Record signature' }).click();
    await expect(d).toHaveCount(0);
  }
  await sign(browser, 'quality', agreementUrl);
  await page.reload();
  await expect(page.locator('.page-head .badge')).toHaveText('Completed');
  await expect(page.getByText('Dana Whitfield')).toBeVisible();
});

test('engineering: ENG-04 supplier baseline from an exact source, requirements continued on a continuation sheet', async ({ browser }, info) => {
  test.skip(info.project.name !== 'controlled', 'controlled walkthrough');
  test.setTimeout(180_000);
  const purchasing = await apiAs('purchasing');
  const nwr = (await purchasing.call('/api/suppliers')).find((s: { code: string }) => s.code === 'NWR');
  const source = (await purchasing.call(`/api/suppliers/${nwr.id}`)).sources.find((s: { site_code?: string; siteCode?: string }) => (s.site_code ?? s.siteCode) === 'P1') ?? (await purchasing.call(`/api/suppliers/${nwr.id}`)).sources[0];
  const page = await pageAs(browser, 'purchasing');
  const url = await startFrom(page, `/sources/${source.id}`, 'ENG-04');
  // Requirements are prefilled from the governing baseline; four more go beyond the six rows on the form.
  await expect(page.getByRole('textbox', { name: /row 1 Req \/ feature ID/ })).toHaveValue('axial_width');
  await completeForm(page, { 'controlled requirements': 4 });
  await expect(page.getByText(/Continuation sheet 1 — ENG-04\/requirements Rev 03/)).toBeVisible();
  await submit(page);
  await sign(browser, 'engineering', url, { decision: 'Approve' });
  await sign(browser, 'quality', url);
  const { number } = await verifyOutput(page, 'ENG-04', 'e2e-eng-04.pdf', ['Approve', NAMES.engineering, NAMES.quality, 'free_end_gap']);
  const pdf = await page.request.get((await page.getByRole('link', { name: 'Open controlled PDF' }).getAttribute('href'))!);
  const text = execFileSync('pdftotext', ['-layout', '-', '-'], { input: await pdf.body() }).toString();
  expect(text).toContain(`${number}-C01`);
  expect(text).toContain('ENG-04 | Rev 0.3 | Effective: pending | Owner: Engineering');
});

test('inspection: OPS-02 opens at launch, is submitted by completing the inspection and approved by the review', async ({ browser }, info) => {
  test.skip(info.project.name !== 'controlled', 'controlled walkthrough');
  test.setTimeout(180_000);
  const inspector = await apiAs('inspector');
  const part = (await inspector.call('/api/parts?q=TQ-PRK-3003'))[0];
  const form = (await inspector.call('/api/forms')).find((f: { formNumber: string }) => f.formNumber === 'PDI-IQI-004');
  const options = await inspector.call(`/api/parts/${part.id}/launch-options`);
  const insp = await inspector.call('/api/inspections', { partId: part.id, formRevisionId: form.revisionId, unitCount: 2, poNumber: 'PO-E2E-02', dateReceived: localDate(), sourceId: options.sources[0].id, lotNumber: 'LOT-E2E-IIR' });
  const v = async () => (await inspector.call(`/api/inspections/${insp.id}`)).version;
  await inspector.call(`/api/inspections/${insp.id}/pass-all`, { expectedVersion: await v(), unitIndex: 0, sectionKey: 'A', mode: 'fill_blank' });
  for (const u of [1, 2]) {
    await inspector.call(`/api/inspections/${insp.id}/pass-all`, { expectedVersion: await v(), unitIndex: u, sectionKey: 'B', mode: 'fill_blank' });
    const readings = { free_end_gap_relaxed: '10.05', installed_end_gap: '0.52', axial_width_ring_height: '2.980', radial_wall_thickness: '4.20' };
    await inspector.call(`/api/inspections/${insp.id}/entries`, { expectedVersion: await v(), changes: Object.entries(readings).map(([rowKey, a1]) => ({ unitIndex: u, sectionKey: 'C', rowKey, status: 'P', readings: { a1 } })), units: [{ unitIndex: u, serialNumber: `IIR-${u}` }] }, 'PATCH');
  }

  // The inspector completes the report's own entries during the inspection; the readings are the inspection's.
  const page = await pageAs(browser, 'inspector');
  const url = await openEventRecord(page, `/inspections/${insp.id}`, 'OPS-02');
  await expect(page.getByLabel(/Supplier lot/)).toHaveValue('LOT-E2E-IIR');
  await expect(page.getByRole('textbox', { name: /row 1 Actual/ })).toHaveValue(/\d/);
  await expect(page.getByRole('textbox', { name: /row 1 Actual/ })).toHaveAttribute('readonly', '');
  await expect(page.getByRole('button', { name: /^Submit for/ })).toHaveCount(0);
  await completeForm(page);
  await inspector.call(`/api/inspections/${insp.id}/complete`, { expectedVersion: await v() });
  await page.reload();
  await expect(page.locator('.page-head .badge')).toHaveText(/Awaiting/);
  await expectModuleBlock(browser, 'quality', url, /Signed when you confirm review on the inspection/);

  // The Receiving Quality approver confirms the review on the inspection: that is the OPS-02 approval.
  const reviewer = await pageAs(browser, 'quality');
  await reviewer.goto(`/inspections/${insp.id}`);
  await reviewer.getByRole('button', { name: 'Confirm review' }).click();
  await expect(reviewer.getByRole('button', { name: 'Confirm review' })).toHaveCount(0);
  await reviewer.reload();
  await expect(reviewer.getByRole('status', { name: 'OPS-02 approval record' })).toContainText(/Approved through confirm review/);
  await verifyOutput(page, 'OPS-02', 'e2e-ops-02.pdf', ['Accept lot', NAMES.quality, 'LOT-E2E-IIR', 'IIR-1', '10.05']);
});

test('FAI: VAL-02 opens with the sample; Engineering concurs and the first-article decision approves it', async ({ browser }, info) => {
  test.skip(info.project.name !== 'controlled', 'controlled walkthrough');
  test.setTimeout(180_000);
  const purchasing = await apiAs('purchasing');
  const nwr = (await purchasing.call('/api/suppliers')).find((s: { code: string }) => s.code === 'NWR');
  const source = (await purchasing.call(`/api/suppliers/${nwr.id}`)).sources[0];
  const fai = await purchasing.call(`/api/sources/${source.id}/fai`, { sampleType: 'PRODUCTION_REPRESENTATIVE', receivedDate: localDate(-1), serialNumbers: 'FA-01', lotNumber: 'LOT-FAI-E2E' });
  await purchasing.call(`/api/fai/${fai.id}/results`, { results: [{ charKey: 'free_end_gap', value: '10.10' }, { charKey: 'installed_end_gap', value: '0.50' }, { charKey: 'axial_width', value: '2.981' }, { charKey: 'radial_wall', value: '4.22' }] }, 'PUT');

  const page = await pageAs(browser, 'purchasing');
  const url = await openEventRecord(page, `/sources/${source.id}`, 'VAL-02');
  await expect(page.getByRole('textbox', { name: /row 1 Actual/ })).toHaveValue('2.981');
  await completeForm(page);
  await submit(page);
  await sign(browser, 'engineering', url);
  await expectModuleBlock(browser, 'quality', url, /Signed when you decide first article on the first article/);

  const decider = await pageAs(browser, 'quality');
  await decider.goto(`/sources/${source.id}`);
  await decider.getByRole('button', { name: 'Decide…' }).first().click();
  const d = decider.getByRole('dialog');
  await d.getByLabel('Decision').selectOption('ACCEPTED');
  await d.getByLabel('Rationale').fill('All characteristics within limits (fictional)');
  await d.getByRole('button', { name: 'Record decision' }).click();
  await expect(d).toHaveCount(0);
  await verifyOutput(page, 'VAL-02', 'e2e-val-02.pdf', ['Approve', NAMES.engineering, NAMES.quality, 'LOT-FAI-E2E', '10.10']);
});

test('concession: OPS-05 opens with the request; Engineering concurs and the concession decision approves it', async ({ browser }, info) => {
  test.skip(info.project.name !== 'controlled', 'controlled walkthrough');
  test.setTimeout(180_000);
  const inspector = await apiAs('inspector');
  const part = (await inspector.call('/api/parts?q=TQ-PRK-3003'))[0];
  const concession = await inspector.call('/api/concessions', {
    partId: part.id,
    lotNumber: 'LOT-DEV-E2E',
    quantityLimit: 4,
    characteristic: 'Radial wall thickness',
    permittedException: '4.32 mm accepted for this lot (fictional)',
    conditions: 'Rebuild kits only',
    justification: 'Engineering assessed negligible effect (fictional)',
    validFrom: localDate(),
    validUntil: localDate(30),
  });
  const page = await pageAs(browser, 'inspector');
  const url = await openEventRecord(page, `/quality/concessions/${concession.id}`, 'OPS-05');
  await expect(page.getByRole('textbox', { name: /row 1 Lot/ })).toHaveValue('LOT-DEV-E2E');
  await completeForm(page);
  await submit(page);

  // The approver sees on the concession what the decision is still waiting for.
  const manager = await pageAs(browser, 'manager');
  await manager.goto(`/quality/concessions/${concession.id}`);
  await expect(manager.getByRole('status', { name: 'OPS-05 approval record' })).toContainText(/Engineering approver signs OPS-05-.* before you decide concession/);
  await sign(browser, 'engineering', url);
  await expectModuleBlock(browser, 'manager', url, /Signed when you decide concession on the concession/);
  await manager.reload();
  await expect(manager.getByRole('status', { name: 'OPS-05 approval record' })).toContainText('Ready for Decide concession');
  await manager.getByRole('button', { name: 'Approve…' }).click();
  await manager.getByRole('dialog').getByLabel('Rationale').fill('Within engineering limits (fictional)');
  await manager.getByRole('dialog').getByRole('button', { name: 'Record decision' }).click();
  await expect(manager.getByRole('dialog')).toHaveCount(0);
  await verifyOutput(page, 'OPS-05', 'e2e-ops-05.pdf', ['Conditional', NAMES.engineering, NAMES.manager, 'LOT-DEV-E2E']);
});

let ncrId = '';

test('nonconformance: OPS-06 opens with the NCR; closing the NCR approves it; containment continues', async ({ browser }, info) => {
  test.skip(info.project.name !== 'controlled', 'controlled walkthrough');
  test.setTimeout(240_000);
  const inspector = await apiAs('inspector');
  const quality = await apiAs('quality');
  const manager = await apiAs('manager');
  const part = (await inspector.call('/api/parts?q=TQ-PRK-3003'))[0];
  const form = (await inspector.call('/api/forms')).find((f: { formNumber: string }) => f.formNumber === 'PDI-IQI-004');
  const options = await inspector.call(`/api/parts/${part.id}/launch-options`);
  // The inspection runs with OPS-02 in force: its report is completed and the lot decided first.
  const insp = await inspector.call('/api/inspections', { partId: part.id, formRevisionId: form.revisionId, unitCount: 2, poNumber: 'PO-E2E-06', dateReceived: localDate(), sourceId: options.sources[0].id, lotNumber: 'LOT-NCR-E2E' });
  const v = async () => (await inspector.call(`/api/inspections/${insp.id}`)).version;
  await inspector.call(`/api/inspections/${insp.id}/pass-all`, { expectedVersion: await v(), unitIndex: 0, sectionKey: 'A', mode: 'fill_blank' });
  for (const u of [1, 2]) {
    await inspector.call(`/api/inspections/${insp.id}/pass-all`, { expectedVersion: await v(), unitIndex: u, sectionKey: 'B', mode: 'fill_blank' });
    const readings = { free_end_gap_relaxed: '10.05', installed_end_gap: '0.52', axial_width_ring_height: '2.980', radial_wall_thickness: '4.20' };
    await inspector.call(`/api/inspections/${insp.id}/entries`, { expectedVersion: await v(), changes: Object.entries(readings).map(([rowKey, a1]) => ({ unitIndex: u, sectionKey: 'C', rowKey, status: 'P', readings: { a1 } })), units: [{ unitIndex: u, serialNumber: `NC-${u}` }] }, 'PATCH');
  }
  await inspector.call(`/api/inspections/${insp.id}/entries`, { expectedVersion: await v(), changes: [{ unitIndex: 2, sectionKey: 'B', rowKey: 'running_face_coating', status: 'F', note: 'Running face uncoated' }] }, 'PATCH');
  await inspector.upload(`/api/inspections/${insp.id}/photos?unitIndex=2&sectionKey=B&rowKey=running_face_coating`, 'coating.png', 'image/png', makePng(120, 80, [150, 40, 40]));
  await completeOps02(inspector, insp.id);
  await inspector.call(`/api/inspections/${insp.id}/complete`, { expectedVersion: await v() });
  const concern = await inspector.call(`/api/inspections/${insp.id}/concerns`, { unitIndex: 2, sectionKey: 'B', rowKey: 'running_face_coating' });
  await quality.call(`/api/inspections/${insp.id}/review`, { decision: 'CONFIRM', comment: 'Lot held (fictional)', expectedVersion: (await quality.call(`/api/inspections/${insp.id}`)).version });
  const qualityId = (await quality.call('/api/auth/me')).user.id;
  await quality.call(`/api/quality/events/${concern.id}/triage`, { expectedVersion: 1, decision: 'TRIAGED', ownerId: qualityId, severity: 'HIGH' });
  const ncr = await manager.call(`/api/quality/events/${concern.id}/confirm-ncr`, { expectedVersion: 2, severity: 'HIGH', ownerId: qualityId, failureMode: 'Missing coating', rationale: 'Coating absent on item 2 (fictional)' });
  ncrId = ncr.id;
  expect(ncr.controlled.number).toMatch(/^OPS-06-/);
  // Eight affected lots are recorded in the NCR: the ledger holds six, two continue on OPS-06/containment.
  await quality.call(`/api/ncrs/${ncr.id}/scopes`, { label: 'Ring kits on shelf R-9', lotNumber: 'LOT-NCR-E2E', poNumber: 'PO-E2E-06', inspectionId: insp.id, quantity: 2, serialNumbers: ['NC-1', 'NC-2'], location: 'Receiving shelf R-9', containmentAction: 'Red tag, quarantine Q-3' });
  for (let i = 1; i <= 7; i += 1) await quality.call(`/api/ncrs/${ncr.id}/scopes`, { label: `Field return bin ${i}`, lotNumber: `LOT-NCR-F${i}`, quantity: 1, serialNumbers: [], location: `Field return bin ${i}`, containmentAction: 'Red tag (fictional)' });
  for (const s of (await quality.call(`/api/ncrs/${ncr.id}`)).scopes as Array<{ id: string; quantity: number; serial_numbers: string[] | null }>) {
    await manager.call(`/api/scopes/${s.id}/authorize-containment`, { note: 'Hold all (fictional)' });
    await quality.call(`/api/scopes/${s.id}/verify-segregation`, { note: 'Tagged and caged (fictional)' });
    const dec = await manager.call(`/api/scopes/${s.id}/dispositions`, { outcome: 'RETURN_TO_SUPPLIER', quantity: s.quantity, serialNumbers: s.serial_numbers ?? [], rationale: 'Supplier to replace (fictional)' });
    await quality.call(`/api/dispositions/${dec.id}/verify`, { result: 'VERIFIED', method: 'Return shipment', note: 'RMA shipped with carrier receipt (fictional)' });
  }

  const page = await pageAs(browser, 'quality');
  const url = await openEventRecord(page, `/quality/ncrs/${ncr.id}`, 'OPS-06');
  await expect(page.getByLabel(/Defect class/)).toHaveValue('Major');
  await expect(page.getByRole('textbox', { name: /row 1 Lot \/ serial interval/ })).toHaveValue(/LOT-NCR-E2E/);
  await expect(page.getByText(/Continuation sheet 1 — OPS-06\/containment Rev 03/)).toBeVisible();
  await expect(page.getByRole('button', { name: /^\+ Add row to .*containment/i })).toHaveCount(0);
  await completeForm(page);
  mkdirSync('var/screenshots', { recursive: true });
  await page.screenshot({ path: 'var/screenshots/controlled-ops-06-entry.png', fullPage: true });
  await page.getByLabel('Caption for the file').fill('Uncoated running face, item 2');
  await page.getByLabel('Attach file').setInputFiles({ name: 'coating.png', mimeType: 'image/png', buffer: makePng(90, 60, [150, 40, 40]) });
  await expect(page.getByRole('link', { name: 'coating.png' })).toBeVisible();
  await submit(page);
  await expectModuleBlock(browser, 'engineering', url, /Signed when you close ncr on the NCR/);

  // Closing the NCR is the approval; the "when required" Engineering block is recorded as not required.
  const closer = await pageAs(browser, 'engineering');
  await closer.goto(`/quality/ncrs/${ncr.id}`);
  await expect(closer.getByRole('status', { name: 'OPS-06 approval record' })).toContainText('Ready for Close NCR');
  await closer.getByRole('button', { name: 'Close NCR…' }).click();
  await closer.getByRole('dialog').getByLabel('Closure note').fill('All lots returned and verified (fictional)');
  await closer.getByRole('dialog').getByRole('button', { name: 'Close NCR' }).click();
  await expect(closer.getByRole('dialog')).toHaveCount(0);
  // No look-alike OPS-06 summary can be issued for this NCR any more.
  await expect(closer.getByRole('button', { name: /Issue summary PDF/ })).toHaveCount(0);
  const { number } = await verifyOutput(page, 'OPS-06', 'e2e-ops-06.pdf', ['Close', NAMES.engineering, 'NA - not required', 'Uncoated running face, item 2', 'LOT-NCR-E2E', 'LOT-NCR-F7']);
  const text = execFileSync('pdftotext', ['-layout', path.join(OUT, 'e2e-ops-06.pdf'), '-']).toString();
  expect(text).toContain(`${number}-C01`);
});

test('corrective action: OPS-07 opens with the SCAR; closing the SCAR approves it', async ({ browser }, info) => {
  test.skip(info.project.name !== 'controlled', 'controlled walkthrough');
  test.setTimeout(180_000);
  const purchasing = await apiAs('purchasing');
  const quality = await apiAs('quality');
  const manager = await apiAs('manager');
  const part = (await purchasing.call('/api/parts?q=TQ-PRK-3003'))[0];
  const nwr = (await purchasing.call('/api/suppliers')).find((s: { code: string }) => s.code === 'NWR');
  const scar = await purchasing.call('/api/scars', {
    ncrIds: ncrId ? [ncrId] : [],
    supplierId: nwr.id,
    siteId: null,
    sourceId: null,
    partId: part.id,
    title: 'Missing running-face coating (E2E)',
    problemStatement: 'Ring kits received without running-face coating (fictional).',
    requestedActions: 'Containment, root cause, corrective action and evidence',
    sentTo: 'Quality manager, Northwind (fictional)',
    sentVia: 'EMAIL',
    responseDue: localDate(14),
    ownerId: (await quality.call('/api/auth/me')).user.id,
  });
  // The supplier's response and PDI's verifications are recorded in the SCAR, not retyped on the form.
  await purchasing.call(`/api/scars/${scar.id}/responses`, { receivedAt: localDate(), channel: 'EMAIL', representative: 'R. Okoye (fictional)', containment: 'Supplier stock purged and recoated (fictional)', rootCause: 'Masking fixture skipped on line 2 (fictional)', correctiveAction: 'Fixture interlock added (fictional)' });
  await purchasing.upload(`/api/evidence/SCAR/${scar.id}`, 'router.pdf', 'application/pdf', await makePdf('Router revision with interlock (fictional)'));
  await quality.call(`/api/scars/${scar.id}/verifications`, { kind: 'IMPLEMENTATION', result: 'VERIFIED', method: 'Document review', evidence: 'Router revision reviewed (fictional)' });
  await purchasing.call(`/api/scars/${scar.id}/plan`, { effectivenessPlan: 'Inspect the next three lots for coating on every item (fictional)' }, 'PUT');
  await manager.call(`/api/scars/${scar.id}/verifications`, { kind: 'EFFECTIVENESS', result: 'VERIFIED', method: 'Supplier audit', evidence: 'Interlock observed working (fictional)', alternativeMethod: true, populationNote: 'Audit of line 2 (fictional)' });

  const page = await pageAs(browser, 'purchasing');
  const url = await openEventRecord(page, `/quality/scars/${scar.id}`, 'OPS-07');
  await expect(page.getByLabel(/^Objective problem/)).toHaveValue(/without running-face coating/);
  await expect(page.getByRole('textbox', { name: /row 1 Verified causal chain/ })).toHaveValue(/Masking fixture skipped/);
  await completeForm(page);
  await submit(page);
  await expectModuleBlock(browser, 'manager', url, /Signed when you close scar on the SCAR/);
  const closer = await pageAs(browser, 'manager');
  await closer.goto(`/quality/scars/${scar.id}`);
  await closer.getByRole('button', { name: 'Close SCAR…' }).click();
  await closer.getByRole('dialog').getByLabel('Closure note').fill('Effectiveness verified (fictional)');
  await closer.getByRole('dialog').getByRole('button', { name: 'Close SCAR' }).click();
  await expect(closer.getByRole('dialog')).toHaveCount(0);
  await verifyOutput(page, 'OPS-07', 'e2e-ops-07.pdf', ['Close', NAMES.manager, 'without running-face coating', 'Masking fixture skipped on line 2']);
});

test('change: OPS-04 opens with the change; Engineering concurs and the change decision approves it', async ({ browser }, info) => {
  test.skip(info.project.name !== 'controlled', 'controlled walkthrough');
  test.setTimeout(180_000);
  const purchasing = await apiAs('purchasing');
  const part = (await purchasing.call('/api/parts?q=TQ-PRK-3003'))[0];
  const me = (await purchasing.call('/api/auth/me')).user.id;
  const change = await purchasing.call('/api/changes', { origin: 'PDI', title: 'Radial wall tolerance (E2E)', description: 'Tighten radial wall tolerance (fictional)', justification: 'Field wear data (fictional)', categories: ['DIMENSION'], partId: part.id, sourceIds: [], ownerId: me });
  const detail = await purchasing.call(`/api/changes/${change.id}`);
  await purchasing.call(`/api/changes/${change.id}/impact`, { expectedVersion: detail.change.version, summary: 'Specification only; no requalification (fictional)', requalificationRequired: false, items: IMPACT_AREAS.map((area) => ({ area, affected: false, assessment: 'Not affected (fictional)' })) }, 'PUT');

  const page = await pageAs(browser, 'purchasing');
  const url = await openEventRecord(page, `/changes/${change.id}`, 'OPS-04');
  await expect(page.getByLabel(/Project \/ sourcing request ID/)).toHaveValue(change.number);
  await completeForm(page);
  await submit(page);
  await sign(browser, 'engineering', url);
  await expectModuleBlock(browser, 'manager', url, /Signed when you decide change on the change/);
  const decider = await pageAs(browser, 'manager');
  await decider.goto(`/changes/${change.id}`);
  await decider.getByRole('button', { name: 'Decide…' }).click();
  await decider.getByRole('dialog').getByLabel('Rationale').fill('Approved with field data (fictional)');
  await decider.getByRole('dialog').getByRole('button', { name: 'Record decision' }).click();
  await expect(decider.getByRole('dialog')).toHaveCount(0);
  await verifyOutput(page, 'OPS-04', 'e2e-ops-04.pdf', ['Approve', NAMES.engineering, NAMES.manager, change.number]);
});

/** Completes the inspection's OPS-02 entries the inspection does not record (API, for an inspection used as setup). */
async function completeOps02(api: Api, inspectionId: string) {
  const list = await api.call(`/api/controlled/records?entityType=INSPECTION&entityId=${inspectionId}&typeCode=OPS-02`);
  const rec = await api.call(`/api/controlled/records/${list[0].id}`);
  const data = structuredClone(rec.data);
  for (const f of rec.schema.fields) {
    if (f.role !== 'ENTRY' || f.requirement !== 'REQUIRED' || data.fields[f.key]) continue;
    data.fields[f.key] = f.input === 'choice' ? f.options[0] : f.input === 'date' ? localDate() : 'NA (E2E setup)'.slice(0, f.maxLength ?? 60);
  }
  for (const row of data.schedules.measurements ?? []) row.equipment_id = 'MIC-E2E';
  await api.call(`/api/controlled/records/${rec.id}`, { expectedVersion: rec.version, data }, 'PATCH');
}
