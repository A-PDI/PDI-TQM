import { mkdirSync } from 'node:fs';
import { type APIRequestContext, type Browser, type Page, expect, request, test } from '@playwright/test';
import { makePdf } from '../fixtures/documents.js';

const PASSWORD = process.env.E2E_PASSWORD ?? 'E2E-Only-Password-2026';
const SHOTS = 'var/screenshots';
mkdirSync(SHOTS, { recursive: true });
const BASE = `http://localhost:${process.env.E2E_PORT ?? 3100}`;

async function apiAs(email: string): Promise<{ ctx: APIRequestContext; post: (url: string, data?: unknown, method?: string) => Promise<any> }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const ctx = await request.newContext({ baseURL: BASE });
  const res = await ctx.post('/api/auth/login', { data: { email, password: PASSWORD } });
  expect(res.status()).toBe(200);
  const { csrfToken } = await res.json();
  return {
    ctx,
    post: async (url, data, method = 'POST') => {
      const r = await ctx.fetch(url, { method, data, headers: { 'x-csrf-token': csrfToken } });
      expect(r.status(), `${method} ${url}: ${await r.text()}`).toBeLessThan(300);
      return r.json();
    },
  };
}

async function pageAs(browser: Browser, email: string, viewport = { width: 1440, height: 900 }): Promise<Page> {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'My Work' })).toBeVisible();
  return page;
}

test('Stage 2 walkthrough: Path B intake → risk → checklist → exact source → site qualification → approval', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop walkthrough');
  const stamp = Date.now().toString().slice(-5);

  // Setup through the API: a supplier with one site, a part with a released supplier specification.
  const purchasingApi = await apiAs('morgan.diaz@example.com');
  const engineeringApi = await apiAs('taylor.brooks@example.com');
  const supplier = await purchasingApi.post('/api/suppliers', { code: `E2E${stamp}`, legalName: `Harbor Valve Works ${stamp} (fictional)`, category: 'Cooling components' });
  await purchasingApi.post(`/api/suppliers/${supplier.id}/sites`, { code: 'MAIN', name: 'Harbor main plant' });
  const part = await purchasingApi.post('/api/parts', { partNumber: `TQ-THM-${stamp}`, description: 'Thermostat 82 °C (fictional)', defaultFormNumber: 'PDI-IQI-022' });
  const spec = await purchasingApi.post(`/api/parts/${part.id}/baselines`, { title: `Harbor catalog TH-${stamp} (fictional)`, ownership: 'SUPPLIER', revisionLabel: 'S1', documentRef: `TH-${stamp}` });
  await purchasingApi.post(`/api/baseline-revisions/${spec.revisionId}/characteristics`, {
    characteristics: [{ charKey: 'flange_od', name: 'Flange Outer Diameter (OD)', charType: 'DIMENSIONAL', formRowRef: 'dimensional:flange_outer_diameter_od', unit: 'mm', lower: '53.80', upper: '54.20' }],
  }, 'PUT');
  await purchasingApi.post(`/api/baseline-revisions/${spec.revisionId}/submit`);
  await engineeringApi.post(`/api/baseline-revisions/${spec.revisionId}/release`, { rationale: 'Catalog data sheet checked (fictional)' });

  // Purchasing runs the request in the UI.
  const purchasing = await pageAs(browser, 'morgan.diaz@example.com');
  await purchasing.goto('/sourcing');
  await purchasing.getByRole('button', { name: 'New sourcing request' }).click();
  const intake = purchasing.getByRole('dialog', { name: 'New sourcing request' });
  await intake.getByLabel('What is being sourced').fill('Catalog thermostat for cooling kits');
  await intake.getByRole('radio', { name: /B — Supplier-standard product/ }).check();
  await intake.getByRole('combobox', { name: 'Company part' }).fill(`TQ-THM-${stamp}`);
  await purchasing.getByRole('option', { name: new RegExp(`TQ-THM-${stamp}`) }).click();
  await intake.getByLabel('Supplier', { exact: true }).selectOption({ label: `Harbor Valve Works ${stamp} (fictional)` });
  await intake.getByLabel('Manufacturing site').selectOption({ label: 'Harbor main plant' });
  await intake.getByLabel('Supplier part number').fill(`TH-${stamp}`);
  await intake.screenshot({ path: `${SHOTS}/desktop-sourcing-intake.png` });
  await intake.getByRole('button', { name: 'Start request' }).click();

  await expect(purchasing.getByRole('heading', { name: 'Catalog thermostat for cooling kits' })).toBeVisible();
  await purchasing.getByRole('button', { name: 'Assess risk' }).click();
  const risk = purchasing.getByRole('dialog', { name: 'Risk assessment' });
  for (const group of await risk.getByRole('radiogroup').all()) await group.getByRole('radio').first().click();
  await risk.getByLabel('Rationale').fill('Proven catalog item, non-critical');
  await risk.getByRole('button', { name: 'Record assessment' }).click();
  await expect(purchasing.getByText('LOW', { exact: true })).toBeVisible();
  await expect(purchasing.getByText('Required (2)')).toBeVisible();

  for (const code of ['ENG-04', 'ENG-05']) {
    const item = purchasing.locator('li', { hasText: code }).filter({ has: purchasing.getByRole('button', { name: /Waive|Attach/ }) });
    await item.locator('input[type=file]').setInputFiles({ name: `${code}.pdf`, mimeType: 'application/pdf', buffer: await makePdf(code) });
    await item.getByRole('button', { name: 'Mark satisfied' }).click();
    await expect(purchasing.locator('li', { hasText: code }).getByText('satisfied', { exact: true })).toBeVisible();
  }

  await purchasing.getByRole('button', { name: 'Identify exact source' }).click();
  const srcDialog = purchasing.getByRole('dialog', { name: 'Identify exact source' });
  await srcDialog.getByLabel('Governing baseline revision').selectOption({ index: 1 });
  await srcDialog.getByRole('button', { name: 'Create source' }).click();
  await expect(purchasing.getByText('This manufacturing site is qualified and current')).toBeVisible();
  await purchasing.screenshot({ path: `${SHOTS}/desktop-sourcing-request.png`, fullPage: true });

  // Assessment recorded by purchasing; an independent quality user decides it in the UI.
  const detail = await (await purchasingApi.ctx.get(`/api/suppliers/${supplier.id}`)).json();
  await purchasingApi.post(`/api/suppliers/${supplier.id}/qualifications`, {
    siteId: detail.sites[0].id,
    kind: 'INITIAL',
    scope: 'Thermostat assembly',
    findings: 'Desk assessment of certificates and capability (fictional)',
    proposedResult: 'QUALIFIED',
  });
  const quality = await pageAs(browser, 'casey.morgan@example.com');
  await quality.getByRole('link', { name: /Decide SQ-/ }).first().click();
  await quality.getByRole('button', { name: 'Decide…' }).click();
  const decide = quality.getByRole('dialog', { name: /Decide SQ-/ });
  await decide.getByLabel('Decision').selectOption('QUALIFIED');
  await decide.getByLabel(/Valid until/).fill('2028-12-31');
  await decide.getByLabel('Rationale').fill('Certificates current; capability adequate');
  await decide.getByRole('button', { name: 'Record decision' }).click();
  await expect(quality.getByText('Qualified', { exact: true }).first()).toBeVisible();
  await quality.screenshot({ path: `${SHOTS}/desktop-supplier-hub.png`, fullPage: true });

  // Management approves the exact source; the frozen record PDF follows.
  const manager = await pageAs(browser, 'riley.chen@example.com');
  await manager.goto('/sources');
  await manager.getByRole('link', { name: `TQ-THM-${stamp}` }).click();
  await expect(manager.getByText('All gates are met')).toBeVisible();
  await manager.getByRole('button', { name: 'Record decision…' }).click();
  const approve = manager.getByRole('dialog', { name: 'Source approval decision' });
  await approve.getByLabel('Decision').selectOption('APPROVED');
  await approve.getByLabel(/Scope/).fill('Catalog thermostat from Harbor main plant');
  await approve.getByLabel('Rationale').fill('Low-risk catalog item; evidence complete');
  await approve.getByRole('button', { name: 'Record decision' }).click();
  await expect(manager.locator('.page-head').getByText('Approved', { exact: true })).toBeVisible();
  await expect(manager.getByRole('link', { name: /Approval record PDF/ })).toBeVisible({ timeout: 20_000 });
  await manager.screenshot({ path: `${SHOTS}/desktop-source-approved.png`, fullPage: true });

  // The same source page has no sideways scrolling on a phone.
  const phone = await pageAs(browser, 'riley.chen@example.com', { width: 390, height: 844 });
  await phone.goto(manager.url().replace(BASE, ''));
  await expect(phone.getByText('Approval decisions')).toBeVisible();
  expect(await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  await phone.screenshot({ path: `${SHOTS}/mobile-source.png` });
});
