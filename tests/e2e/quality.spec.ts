import { mkdirSync } from 'node:fs';
import { type APIRequestContext, type Browser, type Page, expect, request, test } from '@playwright/test';
import { makePng } from '../fixtures/images.js';

const PASSWORD = process.env.E2E_PASSWORD ?? 'E2E-Only-Password-2026';
const SHOTS = 'var/screenshots';
mkdirSync(SHOTS, { recursive: true });
const BASE = `http://localhost:${process.env.E2E_PORT ?? 3100}`;

type Api = { ctx: APIRequestContext; call: (url: string, data?: unknown, method?: string) => Promise<any> }; // eslint-disable-line @typescript-eslint/no-explicit-any

async function apiAs(email: string): Promise<Api> {
  const ctx = await request.newContext({ baseURL: BASE });
  const res = await ctx.post('/api/auth/login', { data: { email, password: PASSWORD } });
  expect(res.status()).toBe(200);
  const { csrfToken } = await res.json();
  return {
    ctx,
    call: async (url, data, method = data === undefined ? 'GET' : 'POST') => {
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

test('Stage 3 walkthrough: concern → NCR → containment → disposition → verification → close; SCAR, change and commitment', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop walkthrough');
  const stamp = Date.now().toString().slice(-5);
  const lot = `LOT-E${stamp}`;
  const inspector = await apiAs('jordan.rivera@example.com');
  const inspector2 = await apiAs('sam.okafor@example.com');
  const qualityApi = await apiAs('casey.morgan@example.com');

  // Setup via API: a ring-kit inspection with an uncoated item and its photo, a concern and its triage.
  const part = (await inspector.call('/api/parts?q=TQ-PRK-3003'))[0];
  const forms = await inspector.call('/api/forms');
  const form = forms.find((f: { formNumber: string }) => f.formNumber === 'PDI-IQI-004');
  const options = await inspector.call(`/api/parts/${part.id}/launch-options`);
  const sourceId = options.sources.find((s: { site: string }) => /Riverton/.test(s.site))?.id ?? options.sources[0].id;
  const insp = await inspector.call('/api/inspections', { partId: part.id, formRevisionId: form.revisionId, unitCount: 2, poNumber: 'PO-E2E', dateReceived: '2026-10-20', sourceId, lotNumber: lot });
  const id = insp.id;
  const v = async () => (await inspector.call(`/api/inspections/${id}`)).version;
  await inspector.call(`/api/inspections/${id}/pass-all`, { expectedVersion: await v(), unitIndex: 0, sectionKey: 'A', mode: 'fill_blank' });
  for (const u of [1, 2]) {
    await inspector.call(`/api/inspections/${id}/pass-all`, { expectedVersion: await v(), unitIndex: u, sectionKey: 'B', mode: 'fill_blank' });
    const readings = { free_end_gap_relaxed: '10.05', installed_end_gap: '0.52', axial_width_ring_height: '2.980', radial_wall_thickness: '4.20' };
    await inspector.call(
      `/api/inspections/${id}/entries`,
      { expectedVersion: await v(), changes: Object.entries(readings).map(([rowKey, a1]) => ({ unitIndex: u, sectionKey: 'C', rowKey, status: 'P', readings: { a1 } })), units: [{ unitIndex: u, serialNumber: `E${stamp}-${u}` }] },
      'PATCH',
    );
  }
  await inspector.call(`/api/inspections/${id}/entries`, { expectedVersion: await v(), changes: [{ unitIndex: 2, sectionKey: 'B', rowKey: 'running_face_coating', status: 'F', note: 'Running face uncoated' }] }, 'PATCH');
  const csrf = (await (await inspector.ctx.get('/api/auth/me')).json()).csrfToken;
  const up = await inspector.ctx.post(`/api/inspections/${id}/photos?unitIndex=2&sectionKey=B&rowKey=running_face_coating`, {
    headers: { 'x-csrf-token': csrf },
    multipart: { file: { name: 'coating.png', mimeType: 'image/png', buffer: makePng(120, 80, [150, 40, 40]) } },
  });
  expect(up.status()).toBe(201);
  await inspector.call(`/api/inspections/${id}/complete`, { expectedVersion: await v() });
  const concern = await inspector.call(`/api/inspections/${id}/concerns`, { unitIndex: 2, sectionKey: 'B', rowKey: 'running_face_coating' });
  await qualityApi.call(`/api/quality/events/${concern.id}/triage`, { expectedVersion: 1, decision: 'TRIAGED', ownerId: (await qualityApi.call('/api/auth/me')).user.id, severity: 'HIGH' });

  // Quality confirms the NCR and records the affected material in the UI.
  const quality = await pageAs(browser, 'casey.morgan@example.com');
  await quality.goto(`/quality/${concern.id}`);
  await quality.getByRole('button', { name: 'Confirm as NCR…' }).click();
  const confirm = quality.getByRole('dialog', { name: 'Confirm nonconformance' });
  await confirm.getByLabel('NCR owner').selectOption({ label: 'Casey Morgan' });
  await confirm.getByLabel('Failure mode (optional)').fill('Missing running-face coating');
  await confirm.getByLabel('Confirmation rationale').fill('Coating absent on item 2; supplier process escape suspected');
  await confirm.getByRole('button', { name: 'Confirm NCR' }).click();
  await expect(quality.getByText(/Open — material not yet contained/)).toBeVisible();
  const ncrUrl = quality.url();
  await quality.getByRole('button', { name: '+ Add affected material' }).click();
  const scope = quality.getByRole('dialog', { name: 'Add affected material' });
  await scope.getByLabel('Material description').fill('Ring kits on receiving shelf R-4');
  await scope.getByLabel('Quantity').fill('2');
  await scope.getByLabel('Serial numbers (optional, comma separated)').fill(`E${stamp}-1, E${stamp}-2`);
  await scope.getByLabel('Containment action').fill('Tag red and move to quarantine cage Q-2');
  await scope.getByRole('button', { name: 'Record material' }).click();
  await expect(quality.getByRole('heading', { name: new RegExp(`lot ${lot}, 2 unit`) })).toBeVisible();

  // Management authorizes containment; the inspector on site verifies segregation.
  const manager = await pageAs(browser, 'riley.chen@example.com');
  await manager.goto(ncrUrl.replace(BASE, ''));
  await manager.getByRole('button', { name: 'Authorize containment' }).click();
  await expect(manager.getByText(/Authorized by Riley Chen/)).toBeVisible();
  const ncrId = ncrUrl.split('/').pop()!;
  const scopeId = (await qualityApi.call(`/api/ncrs/${ncrId}`)).scopes[0].id;
  await inspector2.call(`/api/scopes/${scopeId}/verify-segregation`, { note: 'Both kits tagged and caged in Q-2' });

  // Disposition by quantity: return one, scrap one.
  await manager.reload();
  for (const [outcome, label] of [
    ['RETURN_TO_SUPPLIER', 'Supplier replaces the coated kit'],
    ['SCRAP', 'Damaged during sorting'],
  ]) {
    await manager.getByRole('button', { name: /Decide disposition…/ }).click();
    const d = manager.getByRole('dialog', { name: `Disposition — lot ${lot}` });
    await d.getByLabel('Disposition').selectOption(outcome!);
    await d.getByLabel('Quantity').fill('1');
    await d.getByLabel('Rationale').fill(label!);
    await d.getByRole('button', { name: 'Record disposition' }).click();
    await expect(d).toBeHidden();
  }
  await expect(manager.getByText('Dispositioned — awaiting verification')).toBeVisible();

  // Quality verifies each disposition, closes the NCR and issues a SCAR.
  await quality.reload();
  for (const method of ['Return shipment RMA', 'Scrap witnessed']) {
    await quality.getByRole('button', { name: 'Verify…' }).first().click();
    const d = quality.getByRole('dialog', { name: /^Verify / });
    await d.getByLabel('Method').fill(method);
    await d.getByLabel('Note').fill(`${method} recorded (fictional)`);
    await d.getByRole('button', { name: 'Record verification' }).click();
    await expect(d).toBeHidden();
  }
  await expect(quality.getByText('Verified and resolved — ready to close')).toBeVisible();
  await quality.screenshot({ path: `${SHOTS}/desktop-ncr.png`, fullPage: true });
  await quality.getByRole('button', { name: '+ Issue SCAR' }).click();
  const scarDialog = quality.getByRole('dialog', { name: 'Issue SCAR' });
  await scarDialog.getByLabel('Sent to').fill('Quality manager, Northwind (fictional)');
  await scarDialog.getByLabel('PDI owner').selectOption({ label: 'Casey Morgan' });
  await scarDialog.getByRole('button', { name: 'Issue SCAR' }).click();
  await expect(quality.getByText(/Issued — awaiting supplier response/).first()).toBeVisible();
  await quality.getByRole('button', { name: 'Record supplier response…' }).click();
  const resp = quality.getByRole('dialog', { name: 'Record supplier response' });
  await resp.getByLabel('Supplier representative').fill('Lee Example (Northwind QA)');
  await resp.getByLabel('D3 Containment').fill('Sorted stock; 3 uncoated found');
  await resp.getByLabel('D4 Root cause').fill('Masking fixture left on during PVD run');
  await resp.getByLabel('D5 Corrective action').fill('Fixture removal check added to router');
  await resp.getByLabel('Supplier states the actions are complete').check();
  await resp.getByRole('button', { name: 'Record response' }).click();
  await expect(quality.getByText('supplier says done — not verified')).toBeVisible();
  await expect(quality.getByText(/Supplier responded — PDI verification of implementation pending/).first()).toBeVisible();
  await quality.screenshot({ path: `${SHOTS}/desktop-scar.png`, fullPage: true });

  await quality.goto(ncrUrl.replace(BASE, ''));
  await quality.getByRole('button', { name: 'Close NCR…' }).click();
  const close = quality.getByRole('dialog', { name: 'Close NCR' });
  await close.getByLabel('Closure note').fill('Material returned and scrapped; verified');
  await close.getByRole('button', { name: 'Close NCR' }).click();
  await expect(quality.getByText(/remains open with the supplier/)).toBeVisible();

  // Supplier commitment recorded from the supplier hub.
  const purchasing = await pageAs(browser, 'morgan.diaz@example.com');
  await purchasing.goto('/suppliers');
  await purchasing.getByRole('link', { name: /Northwind Precision Rings/ }).click();
  await purchasing.getByRole('button', { name: '+ Record commitment' }).click();
  const com = purchasing.getByRole('dialog', { name: 'Record supplier commitment' });
  await com.getByLabel('Supplier representative').fill('Lee Example (Northwind QA)');
  await com.getByLabel('What the supplier said').fill('Every ring kit from the next lot will carry the PVD coating.');
  await com.getByLabel('Promised action').fill('Apply running-face coating on every kit');
  await com.getByLabel('How PDI will verify').fill('Receiving inspection of the next lot');
  await com.getByLabel('Severity').selectOption('HIGH');
  await com.getByRole('button', { name: 'Record commitment' }).click();
  await expect(purchasing.getByRole('heading', { name: 'Apply running-face coating on every kit' })).toBeVisible();

  // Change control: open the Changes workspace and propose a supplier change.
  const engineering = await pageAs(browser, 'taylor.brooks@example.com');
  await engineering.getByRole('link', { name: 'Changes' }).click();
  await engineering.getByRole('button', { name: 'New change' }).click();
  const chg = engineering.getByRole('dialog', { name: 'New change' });
  await chg.getByRole('combobox', { name: 'Company part' }).fill('TQ-PRK-3003');
  await engineering.getByRole('option', { name: /TQ-PRK-3003/ }).click();
  await chg.getByLabel('Title').fill(`PVD coating process change ${stamp}`);
  await chg.getByLabel('Coating / finish').check();
  await chg.getByLabel('Manufacturing process').check();
  await chg.getByLabel('Description (old vs proposed)').fill('Supplier moves running-face coating from chrome plating to PVD.');
  await chg.getByLabel('Justification').fill('Supplier PCN: wear improvement');
  await chg.getByLabel(/Northwind.*Riverton Plant 1/).check();
  await chg.getByLabel('Supplier reference (PCN)').fill(`PCN-${stamp}`);
  await chg.getByLabel('Supplier representative').fill('Lee Example (Northwind QA)');
  await chg.getByRole('button', { name: 'Propose change' }).click();
  await expect(engineering.getByText('Proposed — impact assessment needed').first()).toBeVisible();
  await engineering.getByRole('button', { name: 'Assess impact…' }).click();
  const impact = engineering.getByRole('dialog', { name: 'Impact assessment' });
  for (const box of await impact.getByRole('textbox').all()) await box.fill('Assessed for PVD change (fictional)');
  await impact.getByLabel('Exact source approvals affected').check();
  await impact.getByLabel(/Requalification required/).check();
  await impact.getByRole('button', { name: 'Record assessment' }).click();
  await expect(engineering.getByText('Impact assessed — decision needed').first()).toBeVisible();
  await engineering.screenshot({ path: `${SHOTS}/desktop-change.png`, fullPage: true });

  // Phone: the NCR workspace has no sideways scrolling.
  const phone = await pageAs(browser, 'casey.morgan@example.com', { width: 390, height: 844 });
  await phone.goto(ncrUrl.replace(BASE, ''));
  await expect(phone.getByRole('heading', { name: 'Affected material' })).toBeVisible();
  expect(await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  await phone.screenshot({ path: `${SHOTS}/mobile-ncr.png`, fullPage: false });
});

test('Form editor: draft a new revision, add a row, submit; another person releases it', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop walkthrough');
  const engineering = await pageAs(browser, 'taylor.brooks@example.com');
  await engineering.goto('/inspections');
  await engineering.getByRole('link', { name: 'Forms' }).click();
  const row = engineering.getByRole('row', { name: /PDI-IQI-022/ });
  await row.getByRole('button', { name: 'New revision…' }).click();
  const nd = engineering.getByRole('dialog', { name: /New revision of PDI-IQI-022/ });
  await nd.getByLabel('New revision label').fill('B');
  await nd.getByLabel('What changes and why').fill('Add gasket seat check');
  await nd.getByRole('button', { name: 'Create draft' }).click();
  await expect(engineering.getByRole('heading', { name: /PDI-IQI-022 Rev B/ })).toBeVisible();
  const visual = engineering.locator('section.section').nth(1);
  await visual.getByRole('button', { name: '+ Add row' }).click();
  const names = visual.getByRole('textbox', { name: /Row \d+ name/ });
  await names.last().fill('Gasket seat condition');
  await visual.getByRole('textbox', { name: /acceptance criterion/ }).last().fill('Seat clean, no nicks');
  await engineering.getByRole('button', { name: 'Save draft' }).click();
  await expect(engineering.getByText(/added — .*Gasket seat condition/)).toBeVisible();
  await engineering.getByRole('button', { name: 'Submit for release' }).click();
  await expect(engineering.getByText(/someone else must release it/)).toBeVisible();
  await engineering.screenshot({ path: `${SHOTS}/desktop-form-editor.png`, fullPage: true });

  const quality = await pageAs(browser, 'casey.morgan@example.com');
  await quality.goto(engineering.url().replace(BASE, ''));
  await quality.getByRole('button', { name: 'Release…' }).click();
  const rel = quality.getByRole('dialog', { name: 'Release form revision' });
  await rel.getByLabel('Release rationale').fill('Reviewed with the receiving team (fictional)');
  await rel.getByRole('button', { name: 'Release' }).click();
  await expect(quality.getByText('released', { exact: true }).first()).toBeVisible();
  await expect(quality.getByText('gasket_seat_condition', { exact: true })).toBeVisible(); // new row keyed from its name
});
