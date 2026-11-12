import { AxeBuilder } from '@axe-core/playwright';
import { type APIRequestContext, type Browser, type Page, expect, request, test } from '@playwright/test';
import { SCS001_CLAUSES, syntheticMsa001, syntheticScs001 } from '../../src/server/agreements/synthetic-documents.js';
import { makePdf } from '../fixtures/documents.js';

/**
 * Supplier agreements through the UI, from the supplier record (the primary location): build a
 * package from recommendations, approve it, record execution from the signed copy, see the current
 * agreement and its specifications, the impact of a new specification revision, an amendment, and
 * the history after a renewal. Fictional supplier data and synthetic documents only.
 */
const PASSWORD = process.env.E2E_PASSWORD ?? 'E2E-Only-Password-2026';
const BASE = `http://localhost:${process.env.E2E_PORT ?? 3100}`;
const USERS = {
  inspector: 'jordan.rivera@example.com',
  quality: 'casey.morgan@example.com',
  purchasing: 'morgan.diaz@example.com',
  admin: 'avery.patel@example.com',
} as const;
type Who = keyof typeof USERS;
type Api = { ctx: APIRequestContext; call: (url: string, data?: unknown, method?: string) => Promise<any>; upload: (url: string, name: string, buffer: Buffer) => Promise<any> }; // eslint-disable-line @typescript-eslint/no-explicit-any

async function apiAs(who: Who): Promise<Api> {
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
    upload: async (url, name, buffer) => {
      const r = await ctx.post(url, { headers: { 'x-csrf-token': csrfToken }, multipart: { file: { name, mimeType: 'application/pdf', buffer } } });
      expect(r.status(), `upload ${url}: ${await r.text()}`).toBeLessThan(300);
      return r.json();
    },
  };
}

async function pageAs(browser: Browser, who: Who): Promise<Page> {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto('/');
  await page.getByLabel('Email').fill(USERS[who]);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'My Work' })).toBeVisible();
  return page;
}

async function axe(page: Page) {
  await expect(page.getByText('Loading…')).toHaveCount(0);
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
}

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const shift = (d: string, n: number) => {
  const x = new Date(`${d}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

test.describe.configure({ mode: 'serial' });

let admin: Api;
let purchasing: Api;
let quality: Api;
let bsc: string;
let scsDoc: string;
let agreementUrl: string;

test.beforeAll(async () => {
  [admin, purchasing, quality] = await Promise.all([apiAs('admin'), apiAs('purchasing'), apiAs('quality')]);
  const yesterday = shift(today(), -1);
  const msa = await admin.upload(`/api/documents/import?effectiveFrom=${yesterday}`, 'MSA-001_Master_Supplier_Agreement_Rev01.pdf', await syntheticMsa001('01'));
  const scs = await admin.upload(`/api/documents/import?effectiveFrom=${yesterday}`, 'SCS-001_Cast_Component_Quality_Identification_Standard_Rev1.0.pdf', await syntheticScs001('1.0'));
  scsDoc = scs.documentId;
  await admin.call(`/api/documents/${msa.documentId}/classification`, { classification: 'MASTER_AGREEMENT' }, 'PUT');
  await admin.call(`/api/document-revisions/${scs.revisionId}/clauses`, { clauses: SCS001_CLAUSES.map((c) => ({ clauseRef: c.ref, title: c.title })) });
  const head = (await purchasing.call('/api/parts?q=TQ-CYH-4004'))[0];
  await purchasing.call(`/api/parts/${head.id}/classification`, { manufacturingProcess: 'Casting' }, 'PUT');
  bsc = (await purchasing.call('/api/suppliers')).find((s: { code: string }) => s.code === 'BSC').id;
});

test('Document Control classifies SCS-001 as a casting specification on its library page', async ({ browser }) => {
  const page = await pageAs(browser, 'admin');
  await page.goto(`/documents/${scsDoc}`);
  const panel = page.getByRole('region', { name: 'Supplier agreements and specifications' });
  await panel.getByRole('button', { name: 'Classify for supplier agreements' }).click();
  const dialog = page.getByRole('dialog', { name: 'Classify for supplier agreements' });
  await dialog.getByLabel('Classification').selectOption('TECHNICAL_SPECIFICATION');
  await dialog.getByLabel('Category').selectOption('CASTING');
  await dialog.getByLabel('Manufacturing processes').fill('Casting');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(panel.getByText('Controlled technical / quality specification')).toBeVisible();
  await expect(panel.getByText(`Rev 1.0: ${SCS001_CLAUSES.length} clauses`)).toBeVisible();
  await axe(page);
});

test('Scenario A: a package is built from the supplier record, approved, executed and shown as active', async ({ browser }) => {
  const page = await pageAs(browser, 'purchasing');
  await page.goto(`/suppliers/${bsc}`);
  const section = page.getByRole('region', { name: 'Agreements & Specifications' });
  await expect(section.getByText('No executed agreement is in effect for this supplier.')).toBeVisible();
  await section.getByRole('button', { name: 'New agreement' }).click();
  const create = page.getByRole('dialog', { name: 'New supplier agreement' });
  await create.getByLabel('Title').fill('Supply agreement — cylinder heads (E2E)');
  await create.getByRole('checkbox', { name: /FA Foundry A/ }).check();
  await create.getByLabel('Product families (comma separated)').fill('Cylinder heads');
  await create.getByRole('button', { name: 'Create draft' }).click();
  await expect(page).toHaveURL(/\/agreements\/[0-9a-f-]{36}$/);
  agreementUrl = new URL(page.url()).pathname;
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Draft');

  for (const doc of ['MSA-001 Rev 01', 'SCS-001 Rev 1.0', 'TQ-CYH-4004 Rev A']) {
    await page.getByRole('listitem').filter({ hasText: doc }).getByRole('button', { name: 'Add' }).click();
  }
  await page.getByRole('button', { name: 'Save manifest' }).click();
  await expect(page.getByText('Manifest saved')).toBeVisible();
  await expect(page.getByRole('cell', { name: /^SCS-001 Rev 1\.0 Cast/ })).toBeVisible();
  await axe(page);
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Internal review');

  // Quality approves for execution; the preparer cannot.
  await expect(page.getByRole('button', { name: 'Approve for execution…' })).toHaveCount(0);
  const q = await pageAs(browser, 'quality');
  await q.goto(agreementUrl);
  await q.getByRole('button', { name: 'Approve for execution…' }).click();
  const approve = q.getByRole('dialog', { name: /^Approve/ });
  await approve.getByLabel('Legal reviewer').fill('Counsel (fictional)');
  await approve.getByLabel('Legal review reference').fill('E2E legal review memo (fictional)');
  await approve.getByLabel('Legal review date').fill(today());
  await approve.getByRole('button', { name: 'Approve' }).click();
  await expect(q.getByRole('heading', { level: 1 })).toContainText('Approved — awaiting signatures');
  await expect(q.getByText(/^Approved by PDI for execution. Approval is not execution/)).toBeVisible();

  // Purchasing records execution from the signed copy.
  await page.reload();
  await page.getByLabel('Attach document').setInputFiles({ name: 'signed-e2e.pdf', mimeType: 'application/pdf', buffer: await makePdf('Signed agreement (fictional)') });
  await expect(page.getByRole('link', { name: 'signed-e2e.pdf' })).toBeVisible();
  await page.getByRole('button', { name: 'Record execution…' }).click();
  const exec = page.getByRole('dialog', { name: /^Record execution/ });
  await exec.getByLabel('Signed agreement (PDF attached to this record)').selectOption({ index: 1 });
  await exec.getByLabel('Effective date').fill(today());
  await exec.getByRole('group', { name: 'Authorized PDI signatory' }).getByLabel('Name').fill('Pat Example');
  await exec.getByRole('group', { name: 'Authorized PDI signatory' }).getByLabel('Title').fill('VP Operations (fictional)');
  await exec.getByRole('group', { name: 'Authorized PDI signatory' }).getByLabel('Signed on').fill(today());
  await exec.getByRole('group', { name: 'Supplier authorized signatory' }).getByLabel('Name').fill('Lee Sample');
  await exec.getByRole('group', { name: 'Supplier authorized signatory' }).getByLabel('Title').fill('General Manager (fictional)');
  await exec.getByRole('group', { name: 'Supplier authorized signatory' }).getByLabel('Signed on').fill(today());
  await exec.getByRole('button', { name: 'Record execution' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Executed');
  await expect(page.getByRole('link', { name: 'open signed copy' })).toBeVisible();

  await page.goto(`/suppliers/${bsc}`);
  const after = page.getByRole('region', { name: 'Agreements & Specifications' });
  const current = after.getByRole('definition').filter({ hasText: /SA-\d{4}-\d{5}/ }).first();
  await expect(current).toContainText('Executed');
  await expect(after.getByText('MSA-001 Rev 01', { exact: true })).toBeVisible();
  await expect(after.getByRole('row', { name: /SCS-001.*Rev 1\.0.*Controlled specification/ })).toBeVisible();
  await expect(after.getByRole('row', { name: /TQ-CYH-4004.*Rev A.*Part-specific schedule/ })).toBeVisible();
  await axe(page);
});

test('Scenario E: a new SCS-001 revision leaves the executed agreement unchanged and appears in revision impact', async ({ browser }) => {
  await admin.upload(
    `/api/documents/${scsDoc}/revisions?revisionLabel=1.1&effectiveFrom=${today()}&changeSummary=${encodeURIComponent('Fictional clarification')}`,
    'SCS-001_Cast_Component_Quality_Identification_Standard_Rev1.1.pdf',
    await syntheticScs001('1.1'),
  );
  const page = await pageAs(browser, 'quality');
  await page.goto(`/documents/${scsDoc}`);
  const panel = page.getByRole('region', { name: 'Supplier agreements and specifications' });
  await expect(panel.getByText(/These executed agreements still incorporate an earlier revision/)).toBeVisible();
  await expect(panel.getByRole('row', { name: /Bluestone Castings.*Rev 1\.0/ })).toBeVisible();
  await page.goto(agreementUrl);
  await expect(page.getByText(/SCS-001 Rev 1\.1 is now in force \(line incorporates Rev 1\.0\)\. The executed agreement is unchanged/)).toBeVisible();
});

test('Scenario F: an amendment incorporates the new revision and is linked to the supplier and the original', async ({ browser }) => {
  const page = await pageAs(browser, 'purchasing');
  await page.goto(agreementUrl);
  await page.getByRole('button', { name: 'Amend…' }).click();
  await page.getByRole('dialog', { name: /^Amend/ }).getByLabel('What the amendment changes').fill('Incorporate SCS-001 Rev 1.1 (fictional)');
  await page.getByRole('dialog', { name: /^Amend/ }).getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(/-A1/);
  const amendmentId = new URL(page.url()).pathname.split('/').pop()!;
  await page.getByLabel('Add another classified document').selectOption({ label: 'SCS-001 Rev 1.1 — Controlled technical / quality specification' });
  await page.getByLabel('Contractual reference of SCS-001').fill('Schedule B1');
  await page.getByRole('button', { name: 'Save manifest' }).click();
  await expect(page.getByText('Manifest saved')).toBeVisible();
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Internal review');
  const a = (await quality.call(`/api/agreements/${amendmentId}`)).agreement;
  await quality.call(`/api/agreements/${amendmentId}/approve`, { version: a.version, legalReviewer: 'Counsel (fictional)', legalReference: 'E2E-LR-2', legalReviewedOn: today() });
  const signed = await purchasing.upload(`/api/evidence/SUPPLIER_AGREEMENT/${amendmentId}`, 'signed-a1.pdf', await makePdf('Signed amendment (fictional)'));
  const v = (await purchasing.call(`/api/agreements/${amendmentId}`)).agreement.version;
  const sig = { name: 'Pat Example', title: 'VP (fictional)', signedOn: today() };
  await purchasing.call(`/api/agreements/${amendmentId}/execution`, { version: v, signedFileId: signed.fileId, effectiveFrom: today(), pdiSignatory: sig, supplierSignatory: sig });
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Executed');
  await expect(page.getByRole('listitem').filter({ hasText: '(parent)' })).toBeVisible();
  await page.goto(`/suppliers/${bsc}`);
  const section = page.getByRole('region', { name: 'Agreements & Specifications' });
  await expect(section.getByRole('row', { name: /-A1.*Executed/ })).toBeVisible();
  await expect(section.getByRole('row', { name: /SCS-001.*Rev 1\.1/ })).toBeVisible();
});

test('Scenario D: after a renewal the superseded agreement, its signatures and documents stay reachable from the supplier', async ({ browser }) => {
  const original = (await purchasing.call(agreementUrl.replace('/agreements/', '/api/agreements/'))).agreement;
  const renewal = await purchasing.call(`/api/agreements/${original.id}/renewal`, { expiresOn: shift(today(), 1000) });
  let v = (await purchasing.call(`/api/agreements/${renewal.id}`)).agreement.version;
  await purchasing.call(`/api/agreements/${renewal.id}/submit`, { version: v });
  v = (await quality.call(`/api/agreements/${renewal.id}`)).agreement.version;
  await quality.call(`/api/agreements/${renewal.id}/approve`, { version: v, legalReviewer: 'Counsel (fictional)', legalReference: 'E2E-LR-3', legalReviewedOn: today() });
  const signed = await purchasing.upload(`/api/evidence/SUPPLIER_AGREEMENT/${renewal.id}`, 'signed-renewal.pdf', await makePdf('Signed renewal (fictional)'));
  v = (await purchasing.call(`/api/agreements/${renewal.id}`)).agreement.version;
  const sig = { name: 'Pat Example', title: 'VP (fictional)', signedOn: today() };
  await purchasing.call(`/api/agreements/${renewal.id}/execution`, { version: v, signedFileId: signed.fileId, effectiveFrom: today(), pdiSignatory: sig, supplierSignatory: sig });

  // Both package editions of the original are rendered by the job worker.
  await expect.poll(async () => (await purchasing.call(`/api/agreements/${original.id}`)).renditions.filter((r: { fileId: string | null }) => r.fileId).length, { timeout: 30_000 }).toBe(2);
  const page = await pageAs(browser, 'inspector');
  await page.goto(`/suppliers/${bsc}`);
  const section = page.getByRole('region', { name: 'Agreements & Specifications' });
  await expect(section.getByRole('button', { name: 'New agreement' })).toHaveCount(0);
  await section.getByRole('row', { name: new RegExp(`^${original.number} .*Superseded`) }).getByRole('link', { name: original.number, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Superseded');
  for (const role of ['PDI internal approval', 'Legal review', 'Authorized PDI signatory', 'Supplier authorized signatory']) await expect(page.getByRole('cell', { name: role, exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'open signed copy' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open PDF' })).toHaveCount(2);
  // Read-only users see no lifecycle actions.
  for (const name of ['Amend…', 'Renew…', 'Terminate…', 'Cancel…']) await expect(page.getByRole('button', { name })).toHaveCount(0);
  await axe(page);
});
