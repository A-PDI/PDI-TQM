import { type Browser, type Page, expect, request, test } from '@playwright/test';

/**
 * Screen visual-regression baselines (Construction Drawing F1). Runs only in the "visual" project,
 * whose browser uses the pinned font set in tests/fixtures/fonts.conf. Screens are chosen so their
 * content does not depend on what other specs created; record numbers and dates are masked.
 * Refresh after an intended UI change: `npx playwright test --project=visual --update-snapshots`.
 */
const PASSWORD = process.env.E2E_PASSWORD ?? 'E2E-Only-Password-2026';
const BASE = `http://localhost:${process.env.E2E_PORT ?? 3100}`;
const SHOT = { animations: 'disabled' as const, maxDiffPixelRatio: 0.005, threshold: 0.05 };

async function signIn(browser: Browser, viewport: { width: number; height: number }): Promise<Page> {
  const page = await (await browser.newContext({ viewport })).newPage();
  await page.goto('/');
  await page.getByLabel('Email').fill('jordan.rivera@example.com');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'My Work' })).toBeVisible();
  return page;
}

/** A fresh two-item ring-kit inspection with the shared section passed, created through the API. */
async function freshInspection(): Promise<string> {
  const ctx = await request.newContext({ baseURL: BASE });
  const login = await ctx.post('/api/auth/login', { data: { email: 'jordan.rivera@example.com', password: PASSWORD } });
  const { csrfToken } = await login.json();
  const call = async (url: string, data?: unknown, method = data === undefined ? 'GET' : 'POST') => {
    const r = await ctx.fetch(url, { method, data, headers: { 'x-csrf-token': csrfToken } });
    expect(r.status(), `${url}: ${await r.text()}`).toBeLessThan(300);
    return r.json();
  };
  const part = (await call('/api/parts?q=TQ-PRK-3003'))[0];
  const form = (await call('/api/forms')).find((f: { formNumber: string }) => f.formNumber === 'PDI-IQI-004');
  const insp = await call('/api/inspections', { partId: part.id, formRevisionId: form.revisionId, unitCount: 2, poNumber: 'PO-VISUAL-1', dateReceived: '2026-10-19', lotNumber: 'LOT-VISUAL' });
  const v = (await call(`/api/inspections/${insp.id}`)).version;
  await call(`/api/inspections/${insp.id}/pass-all`, { expectedVersion: v, unitIndex: 0, sectionKey: 'A', mode: 'fill_blank' });
  await ctx.dispose();
  return insp.id;
}

test('sign-in, desktop and phone', async ({ browser }) => {
  for (const [name, viewport] of [['signin-desktop', { width: 1440, height: 900 }], ['signin-phone', { width: 390, height: 844 }]] as const) {
    const page = await (await browser.newContext({ viewport })).newPage();
    await page.goto('/');
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page).toHaveScreenshot(`${name}.png`, { ...SHOT, mask: [page.locator('.env-badge')] });
  }
});

test('policy register', async ({ browser }) => {
  const page = await signIn(browser, { width: 1440, height: 900 });
  await page.goto('/policies');
  await expect(page.getByRole('heading', { name: 'Policy register' })).toBeVisible();
  await expect(page).toHaveScreenshot('policies.png', { ...SHOT, fullPage: true });
});

test('launch dialog explaining what is still needed', async ({ browser }) => {
  const page = await signIn(browser, { width: 1440, height: 900 });
  await page.goto('/inspections?new=1');
  const dialog = page.getByRole('dialog', { name: 'New Inspection' });
  await dialog.getByLabel(/Number of Items/).fill('150');
  // A modal dialog renders above Playwright's mask overlay, so the date (defaults to today) is fixed instead.
  await dialog.getByLabel('Date Received').fill('2026-10-19');
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog).toHaveScreenshot('launch-dialog-invalid.png', SHOT);
});

test('inspection workbench, desktop and phone', async ({ browser }) => {
  const id = await freshInspection();
  for (const [name, viewport] of [['workbench-desktop', { width: 1440, height: 900 }], ['workbench-phone', { width: 390, height: 844 }]] as const) {
    const page = await signIn(browser, viewport);
    await page.goto(`/inspections/${id}`);
    await expect(page.locator('.wb-title')).toContainText('TQ-PRK-3003');
    await expect(page.getByRole('status').filter({ hasText: 'All changes saved' })).toBeVisible();
    await expect(page).toHaveScreenshot(`${name}.png`, { ...SHOT, mask: [page.locator('.wb-meta'), page.locator('.env-badge')] });
  }
});
