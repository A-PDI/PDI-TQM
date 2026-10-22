import { AxeBuilder } from '@axe-core/playwright';
import { type Browser, type Page, expect, test } from '@playwright/test';
import { makePdf } from '../fixtures/documents.js';

/** Document Library: an administrator imports owner-named PDFs in one go; everyone can read and open them. */
const PASSWORD = process.env.E2E_PASSWORD ?? 'E2E-Only-Password-2026';

async function pageAs(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'My Work' })).toBeVisible();
  return page;
}

test('an administrator imports the controlled document set; files that break the naming rule are listed, not lost', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop walkthrough');
  const admin = await pageAs(browser, 'avery.patel@example.com');
  await admin.getByRole('link', { name: 'Documents', exact: true }).click();
  await expect(admin.getByRole('heading', { name: 'Document Library', level: 1 })).toBeVisible();
  await admin.getByRole('button', { name: 'Import documents' }).click();
  const names = ['OPS-07_Supplier_Corrective_Action_Request_Rev03.pdf', 'OPS-07_actions_Continuation_Rev03.pdf', 'PDI_Library_User_Guide_Rev03.pdf', 'Scanned form.pdf'];
  await admin.getByLabel('PDF files').setInputFiles(await Promise.all(names.map(async (name) => ({ name, mimeType: 'application/pdf', buffer: await makePdf(name) }))));
  await admin.getByRole('button', { name: 'Import 4 files' }).click();
  await expect(admin.getByRole('status').filter({ hasText: '3 imported or already present, 1 not imported' })).toBeVisible();
  await expect(admin.getByRole('dialog').getByText(/Scanned form\.pdf.*Name files/)).toBeVisible();
  await admin.getByRole('button', { name: 'Close dialog' }).click();

  // Read-only view for everyone: the SCAR form links to the screen that produces it.
  const reader = await pageAs(browser, 'jordan.rivera@example.com');
  await reader.goto('/documents');
  await expect(reader.getByRole('button', { name: 'Import documents' })).toHaveCount(0);
  const row = reader.getByRole('row').filter({ has: reader.getByRole('link', { name: 'OPS-07', exact: true }) });
  await expect(row.getByText('Rev 03')).toBeVisible();
  await expect(row.getByRole('link', { name: 'Supplier corrective actions' })).toBeVisible();
  await row.getByRole('link', { name: 'OPS-07', exact: true }).click();
  await expect(reader.getByRole('heading', { name: 'OPS-07 — Supplier Corrective Action Request (SCAR)', level: 1 })).toBeVisible();
  await expect(reader.getByRole('cell', { name: 'Current' })).toBeVisible();
  await expect(reader.getByRole('link', { name: 'OPS-07/actions' })).toBeVisible();
  const pdf = await reader.request.get((await reader.getByRole('link', { name: 'Open current PDF' }).getAttribute('href'))!);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toBe('application/pdf');

  const axe = await new AxeBuilder({ page: reader }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
});
