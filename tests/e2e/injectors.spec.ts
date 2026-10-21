import { mkdirSync } from 'node:fs';
import { type Browser, type Page, expect, test } from '@playwright/test';
import { GOOD_ROWS, benchCsv } from '../fixtures/bench.js';

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

const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
const stamp = Date.now().toString().slice(-5);
const S1 = `INJ-E${stamp}-1`;
const S2 = `INJ-E${stamp}-2`;

test('Stage 4 walkthrough: bench import → repair → retest → compare → shipment evaluation → analytics and trace', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop walkthrough');
  const inspector = await pageAs(browser, 'jordan.rivera@example.com');

  // Import a synthetic bench file through the UI.
  await inspector.getByRole('link', { name: 'Injectors' }).click();
  await expect(inspector.getByRole('heading', { name: 'Injectors', exact: true })).toBeVisible();
  const file = benchCsv([
    { serial: S1, testedAt: at(6), rows: GOOD_ROWS },
    {
      serial: S2,
      testedAt: at(6),
      rows: [
        ['Rated', 'Delivery', 'mm3/stroke', '106.8', 'PASS'],
        ['Idle', 'Delivery', 'mm3/stroke', '9.7', 'PASS'],
        ['Rated', 'Return flow', 'mm3/stroke', '19.0', 'PASS'],
      ],
    },
    { serial: `INJ-E${stamp}-X`, part: 'UNKNOWN-PART-9', testedAt: at(6), rows: GOOD_ROWS },
  ]);
  await inspector.getByLabel('Import bench file').setInputFiles({ name: `bench-${stamp}.csv`, mimeType: 'text/csv', buffer: file });
  await expect(inspector.getByRole('heading', { name: /^BI-\d{4}-\d{5}$/ })).toBeVisible();
  await expect(inspector.getByRole('listitem').filter({ hasText: 'Added' })).toContainText('2');
  await expect(inspector.getByText('Unknown part number UNKNOWN-PART-9')).toBeVisible();
  await inspector.screenshot({ path: `${SHOTS}/desktop-bench-import.png`, fullPage: true });

  // Injector with a PDI failure the machine passed: repair, quick measurement, retest, close.
  await inspector.getByRole('link', { name: S2 }).click();
  await expect(inspector.getByRole('heading', { name: S2 })).toBeVisible();
  await expect(inspector.getByText('Machine pass').first()).toBeVisible();
  await expect(inspector.getByText('PDI fail')).toBeVisible();
  await inspector.getByRole('button', { name: 'Open repair case' }).click();
  await inspector.getByLabel('Problem found').fill('Rated delivery above PDI criteria');
  await inspector.getByRole('button', { name: 'Open case' }).click();
  await inspector.getByRole('button', { name: 'Record repair action' }).click();
  await inspector.getByLabel('What was done').fill('Shim changed to reduce delivery');
  await inspector.getByLabel('Shim thickness', { exact: true }).fill('1.250');
  await inspector.getByLabel('Shim thickness unit').fill('mm');
  await inspector.getByRole('button', { name: 'Save action' }).click();
  await expect(inspector.getByText('Shim thickness 1.250 mm', { exact: true })).toBeVisible();
  await expect(inspector.getByText('No retest attributed yet')).toBeVisible();

  await inspector.getByRole('button', { name: 'Record bench test' }).click();
  await inspector.getByLabel('Value Rated Delivery').fill('100.9');
  await inspector.getByLabel('Value Idle Delivery').fill('10.0');
  await inspector.getByLabel('Value Rated Return flow').fill('19.5');
  await inspector.getByLabel('Retest after repair action').selectOption({ index: 1 });
  await inspector.getByRole('button', { name: 'Save test' }).click();
  await expect(inspector.getByText('Retest after repair', { exact: true })).toBeVisible();
  await expect(inspector.getByText('PDI pass')).toBeVisible();
  await inspector.getByRole('button', { name: 'Close case' }).click();
  await inspector.getByLabel('Closure note').fill('Retest within PDI criteria');
  await inspector.getByRole('dialog').getByRole('button', { name: 'Close case' }).click();
  await expect(inspector.getByText(/Closed .*Retest within PDI criteria/)).toBeVisible();
  await inspector.screenshot({ path: `${SHOTS}/desktop-injector-detail.png`, fullPage: true });
  // Inspectors cannot freeze shipment evaluations.
  await inspector.getByRole('link', { name: 'Injectors', exact: true }).first().click();
  await inspector.getByLabel(`Select ${S1}`).check();
  await expect(inspector.getByRole('button', { name: 'Evaluate for shipment' })).toHaveCount(0);

  // Quality: compare, issue the comparison PDF, evaluate for shipment, analytics.
  const quality = await pageAs(browser, 'casey.morgan@example.com');
  await quality.goto('/injectors');
  await quality.getByLabel(`Select ${S2}`).check();
  await quality.getByLabel(`Select ${S1}`).check();
  await quality.getByRole('button', { name: 'Compare' }).click();
  await expect(quality.getByRole('heading', { name: 'Compare injectors' })).toBeVisible();
  await expect(quality.getByRole('row', { name: /Rated \/ Delivery/ })).toContainText('106.8 (!)');
  await quality.getByRole('button', { name: 'Issue comparison PDF' }).click();
  await expect(quality.getByRole('link', { name: 'Open PDF' })).toBeVisible({ timeout: 30_000 });
  await quality.screenshot({ path: `${SHOTS}/desktop-injector-compare.png`, fullPage: true });

  await quality.goto('/injectors');
  await quality.getByLabel(`Select ${S1}`).check();
  await quality.getByLabel(`Select ${S2}`).check();
  await quality.getByRole('button', { name: 'Evaluate for shipment' }).click();
  await quality.getByLabel('Shipment / order reference').fill(`SHIP-E2E-${stamp}`);
  await quality.getByRole('button', { name: 'Freeze evaluation' }).click();
  await expect(quality.getByRole('heading', { name: /^SHP-\d{4}-\d{5}/ })).toContainText('all pass');
  await expect(quality.getByText('this evaluation does not release material')).toBeVisible();
  await expect(quality.getByRole('link', { name: /VAL-03 edition 1 PDF/ })).toBeVisible({ timeout: 30_000 });

  await quality.goto('/injectors/analytics');
  await expect(quality.getByRole('heading', { name: 'Injector analytics' })).toBeVisible();
  await expect(quality.getByText('First-pass yield, PDI criteria: 1 of 2')).toBeVisible();
  await expect(quality.getByText('Post-repair yield, PDI criteria: 1 of 1')).toBeVisible();
  await expect(quality.getByRole('img', { name: /Bench tests per week/ })).toBeVisible();
  await quality.screenshot({ path: `${SHOTS}/desktop-injector-analytics.png`, fullPage: true });

  // Traceability of the repaired serial.
  await quality.goto('/trace');
  await quality.getByLabel('or Serial').fill(S2.toLowerCase());
  await quality.getByRole('button', { name: 'Trace' }).click();
  await expect(quality.getByRole('heading', { name: 'Bench test and repair history' })).toBeVisible();
  await expect(quality.getByText(/2 test\(s\), 1 repair case\(s\)/)).toBeVisible();
  await expect(quality.getByText('PDI injector test criteria TQ-INJ-9009 (synthetic) Rev A')).toBeVisible();
  await quality.screenshot({ path: `${SHOTS}/desktop-trace.png`, fullPage: true });

  // Search reaches injectors and the imported file by name.
  await quality.getByLabel('Search', { exact: true }).fill(`bench-${stamp}`);
  await quality.getByLabel('Search', { exact: true }).press('Enter');
  await expect(quality.getByRole('heading', { name: 'Bench imports' })).toBeVisible();
  await expect(quality.getByRole('heading', { name: 'Documents and files' })).toBeVisible();
});

test('phone: injector detail stays usable at 390px without horizontal scrolling', async ({ browser }, info) => {
  test.skip(info.project.name !== 'mobile', 'phone check');
  const page = await pageAs(browser, 'casey.morgan@example.com', { width: 390, height: 844 });
  await page.goto('/injectors');
  await expect(page.getByRole('heading', { name: 'Injectors', exact: true })).toBeVisible();
  const serial = page.getByRole('link', { name: /^INJ-E\d+-2$/ }).first();
  if ((await serial.count()) > 0) {
    await serial.click();
    await expect(page.getByRole('heading', { name: 'Test chronology' })).toBeVisible();
  }
  const noOverflow = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  await noOverflow();
  await page.screenshot({ path: `${SHOTS}/mobile-injector.png`, fullPage: true });
});
