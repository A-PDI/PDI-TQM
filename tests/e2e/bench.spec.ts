import { AxeBuilder } from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';

/** CarbonZapp bench results: an administrator syncs, selects results and starts an inspection; the inspector sees them read-only. */
const PASSWORD = process.env.E2E_PASSWORD ?? 'E2E-Only-Password-2026';
const SHOTS = 'var/screenshots';

async function login(page: Page, email: string) {
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'My Work' })).toBeVisible();
}

test('bench results: Sync now, select two injectors, start a PDI-IQI-012 inspection with the results filled in', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop walkthrough');
  await login(page, 'avery.patel@example.com');
  await page.goto('/injectors/bench');
  await expect(page.getByRole('heading', { level: 1, name: 'Test bench results' })).toBeVisible();
  await expect(page.getByText(/Connected to 127\.0\.0\.1/)).toBeVisible();

  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByRole('status')).toContainText(/2 report\(s\) fetched, 2 new result\(s\) added|2 already present/);
  const rows = page.locator('table.data tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: 'TQ-SN-0455' })).toContainText('Pass');
  await expect(rows.filter({ hasText: 'TQ-SN-0447' })).toContainText('0 of 12');

  await page.getByRole('checkbox', { name: 'Select TQ-SN-0455' }).check();
  await page.getByRole('checkbox', { name: 'Select TQ-SN-0447' }).check();
  await expect(page.getByRole('region', { name: 'Selection' })).toContainText('2 selected · TQ-INJ-9009');
  await page.getByRole('button', { name: 'Start inspection…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Start inspection from bench results' });
  await expect(dialog).toContainText('TQ-SN-0455, TQ-SN-0447');
  await dialog.getByLabel('Inspector').selectOption({ label: 'Jordan Rivera' });
  await dialog.getByLabel('PO Number').fill('PO-BENCH-E2E');
  await dialog.getByRole('button', { name: 'Start inspection' }).click();

  await expect(page).toHaveURL(/\/inspections\/[0-9a-f-]{36}$/);
  const inspectionUrl = page.url();
  await expect(page.locator('.wb-title')).toHaveText(/TQ-INJ-9009/);
  await page.getByRole('button', { name: 'Sign out' }).click();

  await login(page, 'jordan.rivera@example.com');
  await page.goto(inspectionUrl);
  await expect(page.getByLabel('Serial number')).toHaveValue('TQ-SN-0455');
  await expect(page.getByLabel('Serial number')).toHaveAttribute('readonly', '');
  const bench = page.getByRole('region', { name: 'Test bench results (CarbonZapp)' });
  await expect(bench).toContainText('Bench: Pass');
  await expect(bench.locator('tr', { hasText: 'Peak HP' }).first()).toContainText('220.9 – 249.1 mm3/STRK');
  await expect(bench.locator('tr', { hasText: 'Peak HP' }).first()).toContainText('230.3');
  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
  await bench.screenshot({ path: `${SHOTS}/desktop-bench-results.png` });

  await page.getByRole('tab', { name: /TQ-SN-0447/ }).click();
  await expect(page.getByRole('region', { name: 'Test bench results (CarbonZapp)' })).toContainText('259.8');
});
