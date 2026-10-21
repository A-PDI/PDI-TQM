import { mkdirSync } from 'node:fs';
import { type Page, expect, test } from '@playwright/test';
import { makePng } from '../fixtures/images.js';

const PASSWORD = process.env.E2E_PASSWORD ?? 'E2E-Only-Password-2026';
const SHOTS = 'var/screenshots';
mkdirSync(SHOTS, { recursive: true });

async function login(page: Page, email: string) {
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'My Work' })).toBeVisible();
}

async function logout(page: Page) {
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
}

/** Creates an inspection through the API using the page's signed-in session. */
async function apiCreateInspection(page: Page, unitCount: number) {
  const me = await (await page.request.get('/api/auth/me')).json();
  const part = (await (await page.request.get('/api/parts?q=TQ-PRK-3003')).json())[0];
  const forms = await (await page.request.get('/api/forms')).json();
  const form = forms.find((f: { formNumber: string }) => f.formNumber === 'PDI-IQI-004');
  const res = await page.request.post('/api/inspections', {
    headers: { 'x-csrf-token': me.csrfToken },
    data: { partId: part.id, formRevisionId: form.revisionId, unitCount, poNumber: 'PO-E2E', dateReceived: '2026-10-19' },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).id as string;
}

async function noHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

const readings: Record<string, string> = {
  free_end_gap_relaxed: '10.05',
  installed_end_gap: '0.52',
  axial_width_ring_height: '2.980',
  radial_wall_thickness: '4.20',
};

async function fillDimensions(page: Page, unit: number) {
  for (const [row, value] of Object.entries(readings)) {
    const r = page.locator(`#row-${unit}-C-${row}`);
    await r.getByLabel(/Actual 1/).fill(value);
    await r.locator('button.s-P').click();
  }
}

test('AT-01 inspector walkthrough: launch, shared section, two items, missing photo, review, report', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop walkthrough');
  await login(page, 'jordan.rivera@example.com');

  await page.getByRole('link', { name: 'New Inspection' }).click();
  const dialog = page.getByRole('dialog', { name: 'New Inspection' });
  await dialog.getByRole('combobox', { name: 'Part Number' }).fill('OE-PRK');
  await page.getByRole('option', { name: /TQ-PRK-3003/ }).click();
  await expect(dialog.getByLabel('Inspection Form')).toHaveValue(/.+/);
  await expect(dialog.getByLabel('Inspection Form').locator('option:checked')).toHaveText(/PDI-IQI-004/);
  await dialog.getByLabel('Number of Items (1–100)').fill('2');
  await dialog.getByLabel('PO Number').fill('PO-70021');
  await dialog.getByRole('button', { name: /supplier, lot and sampling/ }).click();
  await dialog.getByLabel('Supplier / site source').selectOption({ index: 1 });
  await dialog.getByLabel('Lot / shipment').fill('LOT-E2E-1');
  await dialog.screenshot({ path: `${SHOTS}/desktop-launch.png` });
  await dialog.getByRole('button', { name: 'Start inspection' }).click();

  await expect(page.locator('.wb-title')).toHaveText(/TQ-PRK-3003/);
  // Shared receiving section, once per inspection.
  await page.getByRole('button', { name: 'Pass All' }).first().click();
  await page.getByRole('button', { name: 'Mark 5 unanswered as Pass' }).click();
  await expect(page.locator('#row-0-A-outer_carton_condition button.s-P')).toHaveAttribute('aria-checked', 'true');

  // Item 1: all pass with measurements.
  await page.getByLabel('Serial number').fill('E2E-SN-1');
  await page.getByRole('button', { name: 'Pass All' }).nth(1).click();
  await page.getByRole('button', { name: 'Mark 4 unanswered as Pass' }).click();
  await expect(page.locator('#row-1-B-ring_body button.s-P')).toHaveAttribute('aria-checked', 'true');
  await fillDimensions(page, 1);
  await expect(page.locator('#row-1-C-installed_end_gap .reading').first()).toHaveClass(/within/);

  // Item 2: a failed coating row with note but no photo yet.
  await page.getByRole('button', { name: 'Next ›' }).first().click();
  await page.getByLabel('Serial number').fill('E2E-SN-2');
  await page.getByRole('button', { name: 'Pass All' }).nth(1).click();
  await page.getByRole('button', { name: 'Mark 4 unanswered as Pass' }).click();
  await fillDimensions(page, 2);
  const failRow = page.locator('#row-2-B-running_face_coating');
  await failRow.locator('button.s-F').click();
  await failRow.locator('textarea').fill('Coating missing on running face');
  await expect(failRow.getByText('Photo required')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'All changes saved' })).toBeVisible({ timeout: 10_000 });

  // Pause and resume: reload keeps everything.
  await page.reload();
  await page.getByRole('tab', { name: /E2E-SN-2/ }).click();
  await expect(page.locator('#row-2-B-running_face_coating textarea')).toHaveValue('Coating missing on running face');
  await expect(page.locator('#row-2-C-installed_end_gap').getByLabel(/Actual 1/)).toHaveValue('0.52');

  await page.getByRole('button', { name: 'Complete Inspection' }).click();
  const issue = page.getByRole('button', { name: 'Item 2 → Visual → Running Face Coating: photograph of this characteristic is required' });
  await expect(issue).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/desktop-completion-blocked.png` });
  await issue.click();
  await page.locator('#row-2-B-running_face_coating input[type=file]').setInputFiles({ name: 'coating.png', mimeType: 'image/png', buffer: makePng(200, 150) });
  await expect(page.locator('#row-2-B-running_face_coating .thumb img')).toBeVisible();
  await page.getByRole('button', { name: 'Complete Inspection' }).click();
  await expect(page.getByText('Submitted for independent review')).toBeVisible();
  await expect(page.locator('#row-2-B-ring_body button.s-P')).toBeDisabled();
  await page.screenshot({ path: `${SHOTS}/desktop-workbench-submitted.png`, fullPage: false });
  await logout(page);

  // Independent reviewer completes the record; the frozen report appears.
  await login(page, 'casey.morgan@example.com');
  await page.getByRole('link', { name: /Review IR-.*TQ-PRK-3003 \(FAIL\)/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Independent review' })).toBeVisible();
  await page.getByLabel(/Review comment/).fill('Coating failure confirmed');
  await page.getByRole('button', { name: 'Confirm review' }).click();
  await expect(page.getByRole('link', { name: 'Edition 1' })).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: `${SHOTS}/desktop-completed.png` });
  const href = await page.getByRole('link', { name: 'Edition 1' }).getAttribute('href');
  const pdf = await page.request.get(href!);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');
});

test('navigation: every visible destination works, list filters survive Back', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop navigation');
  await login(page, 'riley.chen@example.com');
  for (const name of ['Inspections', 'Quality', 'Parts & Sources', 'Suppliers', 'Injectors', 'Changes', 'Reports', 'Policy register', 'Home']) {
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name, exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByText('Page not found')).toHaveCount(0);
  }
  // Every main destination is built; no placeholder entries remain.
  await expect(page.locator('.nav-disabled')).toHaveCount(0);

  await apiCreateInspection(page, 1);
  await page.goto('/inspections?status=OPEN&q=TQ-PRK');
  await page.locator('table.data tbody tr.clickable').first().click();
  await expect(page.locator('.wb-title')).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/status=OPEN/);
  await expect(page.getByLabel('Search inspections')).toHaveValue('TQ-PRK');
  await page.getByRole('link', { name: 'Parts & Sources', exact: true }).click();
  await page.getByRole('link', { name: 'TQ-PRK-3003' }).click();
  await expect(page.getByText('synthetic — not PDI-approved')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/desktop-part-hub.png` });
});

test('AT-21: unsaved entries interrupted by a reload are offered for restore', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop recovery');
  await login(page, 'jordan.rivera@example.com');
  const id = await apiCreateInspection(page, 1);
  await page.goto(`/inspections/${id}`);
  // Simulate a lost connection so the entry cannot reach the server.
  await page.route('**/api/inspections/*/entries', (route) => route.abort('internetdisconnected'));
  await page.locator('#row-0-A-outer_carton_condition textarea').fill('Carton corner dented');
  await expect(page.getByRole('status').filter({ hasText: 'Not saved — retrying' })).toBeVisible({ timeout: 10_000 });
  await page.unroute('**/api/inspections/*/entries');
  await page.goto(`/inspections/${id}`);
  await expect(page.getByText(/unsaved entr(y was|ies were) kept on this device/)).toBeVisible();
  await page.getByRole('button', { name: 'Restore and save them' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'All changes saved' })).toBeVisible({ timeout: 10_000 });
  await page.reload();
  await expect(page.locator('#row-0-A-outer_carton_condition textarea')).toHaveValue('Carton corner dented');
});

test('phone: 100-item inspection stays usable without sideways scrolling (NEG-15)', async ({ page }, info) => {
  test.skip(info.project.name !== 'mobile', 'phone layout');
  await login(page, 'jordan.rivera@example.com');
  await noHorizontalOverflow(page);
  await page.screenshot({ path: `${SHOTS}/mobile-home.png` });
  const id = await apiCreateInspection(page, 100);
  await page.goto(`/inspections/${id}`);
  await expect(page.locator('.wb-title')).toBeVisible();
  await noHorizontalOverflow(page);
  await page.getByRole('tab', { name: /Item 100/ }).click();
  await expect(page.getByText('Item 100 of 100')).toBeVisible();
  await page.getByLabel('Serial number').fill('LAST-UNIT');
  await page.locator('#row-100-B-ring_body button.s-F').click();
  await page.locator('#row-100-B-ring_body textarea').fill('Twist visible');
  await expect(page.getByRole('status').filter({ hasText: 'All changes saved' })).toBeVisible({ timeout: 10_000 });
  await noHorizontalOverflow(page);
  const box = await page.locator('#row-100-B-ring_body button.s-P').boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(40);
  expect(box!.width).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: `${SHOTS}/mobile-workbench-item100.png` });
  await page.reload();
  await page.getByRole('tab', { name: /LAST-UNIT/ }).click();
  await expect(page.locator('#row-100-B-ring_body textarea')).toHaveValue('Twist visible');
  await page.getByRole('button', { name: 'Open menu' }).click();
  await page.screenshot({ path: `${SHOTS}/mobile-menu.png` });
});
