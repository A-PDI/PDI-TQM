import { mkdirSync } from 'node:fs';
import { type Browser, type Page, expect, test } from '@playwright/test';

// Runs after the inspection, injector and quality specs (alphabetical order, one worker) so the
// overview shows their fictional records; every assertion also holds on an empty database.
const PASSWORD = process.env.E2E_PASSWORD ?? 'E2E-Only-Password-2026';
const SHOTS = 'var/screenshots';
mkdirSync(SHOTS, { recursive: true });

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

test('management overview: drill-down, CSV export and an issued report PDF', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop walkthrough');
  const quality = await pageAs(browser, 'casey.morgan@example.com');
  await quality.getByRole('link', { name: 'Reports' }).click();
  await expect(quality.getByRole('heading', { name: 'Inspection throughput and outcomes' })).toBeVisible();
  const completed = Number(await quality.getByRole('listitem').filter({ hasText: 'completed in period' }).locator('strong').innerText());
  if (completed > 0) {
    await expect(quality.getByRole('img', { name: /Completed inspections per week/ })).toBeVisible();
    // The figure drills into exactly the inspections it counts.
    await quality.getByRole('listitem').filter({ hasText: 'completed in period' }).click();
    await expect(quality.getByText(`· ${completed} inspection${completed === 1 ? '' : 's'}`)).toBeVisible();
    await quality.goBack();
  }
  const csv = await quality.request.get('/api/exports/inspections.csv');
  expect(csv.status()).toBe(200);
  expect((await csv.text()).split('\r\n')[0]).toMatch(/period .* METRICS-INTERIM-1/);
  await quality.getByRole('button', { name: 'Issue management report PDF' }).click();
  await expect(quality.getByRole('link', { name: 'PDF', exact: true }).first()).toBeVisible({ timeout: 30_000 });
  await quality.screenshot({ path: `${SHOTS}/desktop-reports.png`, fullPage: true });

  // An inspector sees the overview but no export or issue actions.
  const inspector = await pageAs(browser, 'jordan.rivera@example.com');
  await inspector.goto('/reports');
  await expect(inspector.getByRole('heading', { name: 'Corrective actions' })).toBeVisible();
  await expect(inspector.getByRole('link', { name: 'Inspections CSV' })).toHaveCount(0);
  await expect(inspector.getByRole('button', { name: 'Issue management report PDF' })).toHaveCount(0);
  expect((await inspector.request.get('/api/exports/inspections.csv')).status()).toBe(403);
});

test('phone: reports stay usable at 390px without horizontal scrolling', async ({ browser }, info) => {
  test.skip(info.project.name !== 'mobile', 'phone check');
  const page = await pageAs(browser, 'casey.morgan@example.com', { width: 390, height: 844 });
  await page.goto('/reports');
  await expect(page.getByRole('heading', { name: 'Corrective actions' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: `${SHOTS}/mobile-reports.png`, fullPage: true });
});
