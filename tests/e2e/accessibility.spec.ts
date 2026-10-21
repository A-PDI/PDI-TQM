import { AxeBuilder } from '@axe-core/playwright';
import { type APIRequestContext, type Browser, type Page, expect, request, test } from '@playwright/test';

/**
 * Accessibility audit (Part X: screen-reader labels, keyboard controls, accessible errors, visible
 * focus). Every main destination is scanned with axe-core against WCAG 2.0/2.1 A and AA rules;
 * serious and critical findings fail the run.
 */
const PASSWORD = process.env.E2E_PASSWORD ?? 'E2E-Only-Password-2026';
const BASE = `http://localhost:${process.env.E2E_PORT ?? 3100}`;
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function apiAs(email: string): Promise<{ ctx: APIRequestContext; call: (url: string, data?: unknown) => Promise<any> }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const ctx = await request.newContext({ baseURL: BASE });
  const res = await ctx.post('/api/auth/login', { data: { email, password: PASSWORD } });
  expect(res.status()).toBe(200);
  const { csrfToken } = await res.json();
  return {
    ctx,
    call: async (url, data) => {
      const r = await ctx.fetch(url, { method: data === undefined ? 'GET' : 'POST', data, headers: { 'x-csrf-token': csrfToken } });
      expect(r.status(), `${url}: ${await r.text()}`).toBeLessThan(300);
      return r.json();
    },
  };
}

async function pageAs(browser: Browser, email: string, viewport = { width: 1440, height: 900 }): Promise<Page> {
  const page = await (await browser.newContext({ viewport })).newPage();
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'My Work' })).toBeVisible();
  return page;
}

async function audit(page: Page, url: string) {
  await page.goto(url);
  await expect(page.locator('main#main')).toBeVisible();
  await expect(page.getByText('Loading…')).toHaveCount(0);
  await page.waitForLoadState('networkidle');
  const findings: string[] = [];
  // Every screen names itself with one top-level heading (screen-reader orientation).
  if ((await page.getByRole('heading', { level: 1 }).count()) !== 1) findings.push(`${url} — page must have exactly one level-1 heading`);
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return findings.concat(results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${url} — ${v.id} (${v.impact}): ${v.help} — ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`));
}

test('axe: every main destination has no serious or critical WCAG A/AA violations', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop audit; phone layout audited below');
  test.setTimeout(240_000);
  const inspector = await apiAs('jordan.rivera@example.com');
  const part = (await inspector.call('/api/parts?q=TQ-PRK-3003'))[0];
  const forms = await inspector.call('/api/forms');
  const form = forms.find((f: { formNumber: string }) => f.formNumber === 'PDI-IQI-004');
  const options = await inspector.call(`/api/parts/${part.id}/launch-options`);
  const insp = await inspector.call('/api/inspections', { partId: part.id, formRevisionId: form.revisionId, unitCount: 2, dateReceived: '2026-10-20', sourceId: options.sources[0].id, lotNumber: 'LOT-A11Y' });
  const injector = await inspector.call('/api/injectors', { partId: (await inspector.call('/api/parts?q=TQ-INJ-9009'))[0].id, serialNumber: `INJ-A11Y-${Date.now().toString().slice(-5)}` });
  const supplier = (await inspector.call('/api/suppliers'))[0];
  const source = options.sources[0];
  const baseline = (await inspector.call(`/api/parts/${part.id}`)).baselines[0]?.revisionId ?? null;

  const page = await pageAs(browser, 'riley.chen@example.com');
  const urls = [
    '/',
    '/inspections',
    `/inspections/${insp.id}`,
    '/quality',
    '/quality/ncrs',
    '/quality/concessions',
    '/quality/scars',
    '/commitments',
    '/changes',
    '/parts',
    `/parts/${part.id}`,
    '/suppliers',
    `/suppliers/${supplier.id}`,
    '/sourcing',
    '/sources',
    `/sources/${source.id}`,
    ...(baseline ? [`/baselines/${baseline}`] : []),
    '/injectors',
    `/injectors/${injector.id}`,
    '/injectors/imports',
    '/injectors/compare',
    '/injectors/shipments',
    '/injectors/analytics',
    '/reports',
    '/trace',
    `/trace?partId=${part.id}&lot=LOT-A11Y`,
    '/search?q=TQ',
    '/policies',
  ];
  const findings: string[] = [];
  for (const url of urls) findings.push(...(await audit(page, url)));
  const admin = await pageAs(browser, 'avery.patel@example.com');
  findings.push(...(await audit(admin, '/admin')));
  const quality = await pageAs(browser, 'casey.morgan@example.com');
  findings.push(...(await audit(quality, '/forms')));
  expect(findings).toEqual([]);
});

test('axe: sign-in page and phone layout', async ({ browser }, info) => {
  test.skip(info.project.name !== 'mobile', 'phone audit');
  const anon = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await anon.goto('/');
  await expect(anon.getByLabel('Email')).toBeVisible();
  const login = (await new AxeBuilder({ page: anon }).withTags(TAGS).analyze()).violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(login.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  const page = await pageAs(browser, 'riley.chen@example.com', { width: 390, height: 844 });
  const findings: string[] = [];
  for (const url of ['/', '/inspections', '/reports', '/injectors', '/injectors/analytics']) findings.push(...(await audit(page, url)));
  expect(findings).toEqual([]);
});

/** Presses Tab until the focused element's accessible name matches, asserting focus is visibly indicated. */
async function tabTo(page: Page, name: RegExp, maxTabs = 60) {
  for (let i = 0; i < maxTabs; i += 1) {
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return null;
      const label = el.getAttribute('aria-label') ?? (el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent : null) ?? el.textContent ?? '';
      const style = getComputedStyle(el);
      return { label: label.trim(), outline: style.outlineStyle !== 'none' && style.outlineWidth !== '0px' };
    });
    if (focused && name.test(focused.label)) {
      expect(focused.outline, `visible focus on "${focused.label}"`).toBe(true);
      return;
    }
  }
  throw new Error(`Could not reach ${name} with the keyboard`);
}

test('keyboard only: sign in, launch an inspection, answer a section and save', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'keyboard walkthrough');
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto('/');
  await tabTo(page, /^Email$/);
  await page.keyboard.type('jordan.rivera@example.com');
  await tabTo(page, /^Password$/);
  await page.keyboard.type(PASSWORD);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'My Work' })).toBeVisible();

  await tabTo(page, /^Inspections$/);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Inspections', level: 1 })).toBeVisible();
  await tabTo(page, /^New Inspection$/);
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'New Inspection' });
  await expect(dialog).toBeVisible();
  // Escape closes the dialog without starting anything; reopen and continue.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await tabTo(page, /^New Inspection$/);
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Part Number')).toBeFocused();
  await page.keyboard.type('TQ-PRK-3003');
  await expect(page.getByRole('option').first()).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(dialog.getByLabel('Inspection Form')).not.toHaveValue('');
  await tabTo(page, /Number of Items/);
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('1');
  await tabTo(page, /^Start inspection$/);
  await page.keyboard.press('Enter');
  await expect(page.locator('.wb-title')).toContainText('TQ-PRK-3003');

  // Answer the shared receiving section with Pass All and save, all by keyboard.
  await tabTo(page, /Pass All/i, 120);
  await page.keyboard.press('Enter');
  const confirm = page.getByRole('dialog');
  if (await confirm.isVisible()) {
    await tabTo(page, /^Mark \d+ unanswered as Pass$/);
    await page.keyboard.press('Enter');
  }
  await expect(page.getByRole('radio', { name: /^P/ }).first()).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('status').filter({ hasText: 'All changes saved' })).toBeVisible({ timeout: 10_000 });
});

test('empty states and failed validations explain themselves', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop');
  const anon = await (await browser.newContext()).newPage();
  await anon.goto('/');
  await anon.getByLabel('Email').fill('jordan.rivera@example.com');
  await anon.getByLabel('Password').fill('wrong-password-for-test');
  await anon.getByRole('button', { name: 'Sign in' }).click();
  await expect(anon.getByRole('alert')).toBeVisible();

  const page = await pageAs(browser, 'jordan.rivera@example.com');
  await page.goto('/search?q=zz-no-such-record');
  await expect(page.getByText('Nothing matched')).toBeVisible();
  await page.goto('/inspections?q=zz-no-such-record');
  await expect(page.getByText('No inspections match')).toBeVisible();
  await page.goto('/injectors/compare');
  await expect(page.getByText('Select injectors on the Injectors list')).toBeVisible();
  await page.goto('/trace');
  await expect(page.getByText('Enter a serial, or a part and lot.')).toBeVisible();

  await page.goto('/inspections?new=1');
  const dialog = page.getByRole('dialog', { name: 'New Inspection' });
  await expect(dialog.getByText('Still needed: a part, an inspection form.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Start inspection' })).toBeDisabled();
  await dialog.getByLabel(/Number of Items/).fill('150');
  await expect(dialog.getByLabel(/Number of Items/)).toHaveAttribute('aria-invalid', 'true');
  await expect(dialog.getByRole('alert')).toHaveText('Enter a whole number of items from 1 to 100.');
  await expect(dialog.getByText(/Still needed: .*a valid number of items/)).toBeVisible();
});
