import { AxeBuilder } from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';

/** Cylinder head Stage 2: open the completed Stage 1 inspection, add the fire ring readings for one head, review, addendum PDF. */
const PASSWORD = process.env.E2E_PASSWORD ?? 'E2E-Only-Password-2026';
const SHOTS = 'var/screenshots';

async function login(page: Page, email: string) {
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'My Work' })).toBeVisible();
}

/** A completed one-head Stage 1 inspection, created through the API with the page's session. */
async function completedStage1(page: Page): Promise<string> {
  const me = await (await page.request.get('/api/auth/me')).json();
  const headers = { 'x-csrf-token': me.csrfToken };
  const part = (await (await page.request.get('/api/parts?q=TQ-CYH-4004')).json()).find((p: { partNumber: string }) => p.partNumber === 'TQ-CYH-4004');
  const form = (await (await page.request.get('/api/forms')).json()).find((f: { formNumber: string }) => f.formNumber === 'PDI-IQI-005');
  const created = await page.request.post('/api/inspections', { headers, data: { partId: part.id, formRevisionId: form.revisionId, unitCount: 1, dateReceived: '2026-10-01' } });
  expect(created.status(), await created.text()).toBe(201);
  const id = (await created.json()).id as string;
  const version = async () => (await (await page.request.get(`/api/inspections/${id}`)).json()).version as number;
  for (const [unitIndex, sectionKey] of [[0, 'A'], [1, 'B']] as const) {
    const r = await page.request.post(`/api/inspections/${id}/pass-all`, { headers, data: { expectedVersion: await version(), unitIndex, sectionKey, mode: 'fill_blank' } });
    expect(r.status(), await r.text()).toBe(200);
  }
  const units = await page.request.patch(`/api/inspections/${id}/entries`, { headers, data: { expectedVersion: await version(), changes: [], units: [{ unitIndex: 1, serialNumber: 'E2E-CYH-001' }] } });
  expect(units.status(), await units.text()).toBe(200);
  const done = await page.request.post(`/api/inspections/${id}/complete`, { headers, data: { expectedVersion: await version() } });
  expect((await done.json()).status).toBe('COMPLETED');
  return id;
}

test('Stage 2: fire ring readings added to a completed head inspection, reviewed, addendum issued', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop walkthrough');
  await login(page, 'jordan.rivera@example.com');
  const stage1 = await completedStage1(page);

  await page.goto(`/inspections/${stage1}`);
  const panel = page.getByRole('region', { name: 'Cylinder head Stage 2' });
  await panel.getByRole('button', { name: 'Start Stage 2…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Start Stage 2 — item 1' });
  await expect(dialog.getByText('SN E2E-CYH-001')).toBeVisible();
  await dialog.getByRole('combobox', { name: 'Stage 2 part number' }).fill('TQ-CYH-4004-S2');
  await page.getByRole('option', { name: /TQ-CYH-4004-S2/ }).click();
  await dialog.getByLabel('Stage 2 date').fill('2026-10-20');
  await dialog.getByRole('button', { name: 'Start Stage 2' }).click();

  await expect(page.getByRole('heading', { level: 1, name: /Stage 2 — .*-S2-1/ })).toBeVisible();
  await expect(page.getByText('SN E2E-CYH-001 · TQ-CYH-4004-S2')).toBeVisible();
  for (const [row, value] of [['groove_diameter', '5.990'], ['groove_depth', '0.030'], ['wire_protrusion', '0.009']] as const) {
    const r = page.locator(`#row-1-C_fire_ring-${row}`);
    for (let c = 1; c <= 6; c++) await r.getByLabel(new RegExp(`^C${c}\\b`)).fill(value);
    await r.locator('button.s-P').click();
  }
  await expect(page.locator('#row-1-C_fire_ring-groove_depth .reading').first()).toHaveClass(/within/);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('#row-1-C_fire_ring-wire_protrusion').getByLabel(/^C6\b/)).toHaveValue('0.009');

  const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/desktop-stage2.png` });

  // Groove diameter has no released limit for the Stage 2 part, so the record goes to independent review.
  await page.getByRole('button', { name: 'Complete Stage 2' }).click();
  await expect(page.getByText('Submitted for independent review')).toBeVisible();
  await expect(page.locator('#row-1-C_fire_ring-groove_depth').getByLabel(/^C1\b/)).toBeDisabled();
  const stageUrl = page.url();
  await page.getByRole('button', { name: 'Sign out' }).click();

  await login(page, 'casey.morgan@example.com');
  await page.goto(stageUrl);
  await page.getByLabel('Review comment').fill('Groove diameter checked against the drawing');
  await page.getByRole('button', { name: 'Confirm result' }).click();
  const pdfLink = page.getByRole('link', { name: 'Stage 2 addendum PDF' });
  await expect(pdfLink).toBeVisible({ timeout: 20_000 });
  const pdf = await page.request.get((await pdfLink.getAttribute('href'))!);
  expect(pdf.headers()['content-type']).toBe('application/pdf');
  expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');

  // The Stage 1 record lists the Stage 2 result without changing.
  await page.getByRole('link', { name: /Stage 1 inspection/ }).click();
  const row = page.getByRole('region', { name: 'Cylinder head Stage 2' }).locator('tbody tr').first();
  await expect(row).toContainText('TQ-CYH-4004-S2');
  await expect(row).toContainText('10/20/2026');
  await expect(row).toContainText('PASS');
});
