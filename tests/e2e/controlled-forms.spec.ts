import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { type APIRequestContext, type Browser, type Page, expect, request, test } from '@playwright/test';
import { makePdf } from '../fixtures/documents.js';
import { standInFiles, templateFixture } from '../fixtures/controlled-templates.js';
import { makePng } from '../fixtures/images.js';

/**
 * One full controlled record per major family, completed through the UI from the module record it
 * belongs to: open the approved revision, complete every section (rows beyond the sheet continue on
 * continuation sheets), obtain the approvals, and check the generated PDF against the approved
 * revision (document control, continuation sheets, signatures, validation report).
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
  for (const f of await standInFiles(['INT-01', 'SUP-01', 'SUP-03', 'ENG-04', 'OPS-02', 'VAL-02', 'OPS-05', 'OPS-06', 'OPS-07'])) {
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
  await page.getByRole('button', { name: /^Submit for (approval|signatures)$/ }).click();
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

test('sourcing: INT-01 Product Sourcing Request from a sourcing request', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop walkthrough');
  test.setTimeout(180_000);
  const purchasing = await apiAs('purchasing');
  const part = (await purchasing.call('/api/parts?q=TQ-PRK-3003'))[0];
  const nwr = (await purchasing.call('/api/suppliers')).find((s: { code: string }) => s.code === 'NWR');
  const site = (await purchasing.call(`/api/suppliers/${nwr.id}`)).sites.find((s: { code: string }) => s.code === 'P2');
  const req = await purchasing.call('/api/sourcing', { title: 'Second-source ring kit (E2E)', pathway: 'B', partId: part.id, supplierId: nwr.id, siteId: site.id, supplierPartNumber: 'NR-3003-E2E' });

  const page = await pageAs(browser, 'purchasing');
  const url = await startFrom(page, `/sourcing/${req.id}`, 'INT-01');
  await expect(page.getByLabel(/Project \/ sourcing request ID/)).toHaveValue(/^SR-/);
  await completeForm(page);
  await submit(page);
  await sign(browser, 'engineering', url, { decision: 'Investigate' });
  await sign(browser, 'quality', url);
  await verifyOutput(page, 'INT-01', 'e2e-int-01.pdf', ['Investigate', NAMES.engineering, NAMES.quality, 'NR-3003-E2E']);
});

test('supplier: SUP-01 questionnaire completed in TQM, SUP-03 agreement attached with its signatures', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop walkthrough');
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
  test.skip(info.project.name !== 'desktop', 'desktop walkthrough');
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

test('inspection: OPS-02 Incoming Inspection Report from a completed inspection', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop walkthrough');
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
  await inspector.call(`/api/inspections/${insp.id}/complete`, { expectedVersion: await v() });

  const page = await pageAs(browser, 'inspector');
  const url = await startFrom(page, `/inspections/${insp.id}`, 'OPS-02');
  await expect(page.getByLabel(/Supplier lot/)).toHaveValue('LOT-E2E-IIR');
  await expect(page.getByRole('textbox', { name: /row 1 Actual/ })).toHaveValue(/\d/);
  await completeForm(page);
  await submit(page);
  await sign(browser, 'quality', url, { decision: 'Accept lot' });
  await verifyOutput(page, 'OPS-02', 'e2e-ops-02.pdf', ['Accept lot', NAMES.quality, 'LOT-E2E-IIR', 'IIR-1', '10.05']);
});

test('FAI: VAL-02 First Article Inspection Report from a first-article sample', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop walkthrough');
  test.setTimeout(180_000);
  const purchasing = await apiAs('purchasing');
  const nwr = (await purchasing.call('/api/suppliers')).find((s: { code: string }) => s.code === 'NWR');
  const source = (await purchasing.call(`/api/suppliers/${nwr.id}`)).sources[0];
  const fai = await purchasing.call(`/api/sources/${source.id}/fai`, { sampleType: 'PRODUCTION_REPRESENTATIVE', receivedDate: localDate(-1), serialNumbers: 'FA-01', lotNumber: 'LOT-FAI-E2E' });
  await purchasing.call(`/api/fai/${fai.id}/results`, { results: [{ charKey: 'free_end_gap', value: '10.10' }, { charKey: 'installed_end_gap', value: '0.50' }, { charKey: 'axial_width', value: '2.981' }, { charKey: 'radial_wall', value: '4.22' }] }, 'PUT');

  const page = await pageAs(browser, 'purchasing');
  const url = await startFrom(page, `/sources/${source.id}`, 'VAL-02');
  await expect(page.getByRole('textbox', { name: /row 1 Actual/ })).toHaveValue('2.981');
  // Eight more measured samples than the form holds: they continue on the VAL-02 measurement sheets.
  await completeForm(page, { 'actual measurement': 8 });
  await submit(page);
  await sign(browser, 'engineering', url, { decision: 'Approve' });
  await sign(browser, 'quality', url);
  const { number } = await verifyOutput(page, 'VAL-02', 'e2e-val-02.pdf', ['Approve', NAMES.engineering, NAMES.quality, 'LOT-FAI-E2E', '10.10']);
  const text = execFileSync('pdftotext', ['-layout', path.join(OUT, 'e2e-val-02.pdf'), '-']).toString();
  expect(text).toContain(`${number}-C01`);
});

test('concession: OPS-05 Temporary Deviation / Concession Request from a concession', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop walkthrough');
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
  const url = await startFrom(page, `/quality/concessions/${concession.id}`, 'OPS-05');
  await expect(page.getByRole('textbox', { name: /row 1 Lot/ })).toHaveValue('LOT-DEV-E2E');
  await completeForm(page);
  await submit(page);
  await sign(browser, 'engineering', url, { decision: 'Conditional' });
  await sign(browser, 'manager', url);
  await verifyOutput(page, 'OPS-05', 'e2e-ops-05.pdf', ['Conditional', NAMES.engineering, NAMES.manager, 'LOT-DEV-E2E']);
});

let ncrId = '';

test('nonconformance: OPS-06 Nonconformance Report from an NCR, containment continued', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop walkthrough');
  test.setTimeout(240_000);
  const inspector = await apiAs('inspector');
  const quality = await apiAs('quality');
  const manager = await apiAs('manager');
  const part = (await inspector.call('/api/parts?q=TQ-PRK-3003'))[0];
  const form = (await inspector.call('/api/forms')).find((f: { formNumber: string }) => f.formNumber === 'PDI-IQI-004');
  const options = await inspector.call(`/api/parts/${part.id}/launch-options`);
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
  await inspector.call(`/api/inspections/${insp.id}/complete`, { expectedVersion: await v() });
  const concern = await inspector.call(`/api/inspections/${insp.id}/concerns`, { unitIndex: 2, sectionKey: 'B', rowKey: 'running_face_coating' });
  const qualityId = (await quality.call('/api/auth/me')).user.id;
  await quality.call(`/api/quality/events/${concern.id}/triage`, { expectedVersion: 1, decision: 'TRIAGED', ownerId: qualityId, severity: 'HIGH' });
  const ncr = await manager.call(`/api/quality/events/${concern.id}/confirm-ncr`, { expectedVersion: 2, severity: 'HIGH', ownerId: qualityId, failureMode: 'Missing coating', rationale: 'Coating absent on item 2 (fictional)' });
  ncrId = ncr.id;
  await quality.call(`/api/ncrs/${ncr.id}/scopes`, { label: 'Ring kits on shelf R-9', lotNumber: 'LOT-NCR-E2E', poNumber: 'PO-E2E-06', inspectionId: insp.id, quantity: 2, serialNumbers: ['NC-1', 'NC-2'], location: 'Receiving shelf R-9', containmentAction: 'Red tag, quarantine Q-3' });

  const page = await pageAs(browser, 'quality');
  const url = await startFrom(page, `/quality/ncrs/${ncr.id}`, 'OPS-06');
  await expect(page.getByLabel(/Defect class/)).toHaveValue('Major');
  await expect(page.getByRole('textbox', { name: /row 1 Lot \/ serial interval/ })).toHaveValue(/LOT-NCR-E2E/);
  await completeForm(page, { 'stock containment': 11 });
  await expect(page.getByText(/Continuation sheet 2 — OPS-06\/containment Rev 03/)).toBeVisible();
  mkdirSync('var/screenshots', { recursive: true });
  await page.screenshot({ path: 'var/screenshots/controlled-ops-06-entry.png', fullPage: true });
  await page.getByLabel('Caption for the file').fill('Uncoated running face, item 2');
  await page.getByLabel('Attach file').setInputFiles({ name: 'coating.png', mimeType: 'image/png', buffer: makePng(90, 60, [150, 40, 40]) });
  await expect(page.getByRole('link', { name: 'coating.png' })).toBeVisible();
  await submit(page);
  await sign(browser, 'manager', url, { decision: 'Authorize disposition', second: 'not required' });
  const { number } = await verifyOutput(page, 'OPS-06', 'e2e-ops-06.pdf', ['Authorize disposition', NAMES.manager, 'NA - not required', 'Uncoated running face, item 2', 'LOT-NCR-E2E']);
  const text = execFileSync('pdftotext', ['-layout', path.join(OUT, 'e2e-ops-06.pdf'), '-']).toString();
  for (const sheet of ['C01', 'C02']) expect(text).toContain(`${number}-${sheet}`);
  // The record is listed on the NCR with its controlled PDF.
  await page.goto(`/quality/ncrs/${ncr.id}`);
  const panel = page.locator('section.card', { has: page.getByRole('heading', { name: 'Controlled forms' }) });
  await expect(panel.getByRole('link', { name: number })).toBeVisible();
  await expect(panel.getByRole('link', { name: 'Controlled PDF' })).toBeVisible();
});

test('corrective action: OPS-07 Supplier Corrective Action Request from a SCAR', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop walkthrough');
  test.setTimeout(180_000);
  const purchasing = await apiAs('purchasing');
  const quality = await apiAs('quality');
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
  const page = await pageAs(browser, 'purchasing');
  const url = await startFrom(page, `/quality/scars/${scar.id}`, 'OPS-07');
  await expect(page.getByLabel(/^Objective problem/)).toHaveValue(/without running-face coating/);
  await completeForm(page, { 'actions and verified': 8 });
  await submit(page);
  await sign(browser, 'quality', url, { decision: 'Continue' });
  const { number } = await verifyOutput(page, 'OPS-07', 'e2e-ops-07.pdf', ['Continue', NAMES.quality, 'without running-face coating']);
  expect(execFileSync('pdftotext', ['-layout', path.join(OUT, 'e2e-ops-07.pdf'), '-']).toString()).toContain(`${number}-C01`);
});
