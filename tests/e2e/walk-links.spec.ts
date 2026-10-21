import { type Browser, expect, test } from '@playwright/test';

/**
 * NEG-21: follow every visible in-app link from Home (breadth first) for two roles. Runs last
 * (alphabetical order, one worker) so it walks the records the other specs created. A page fails
 * when it shows "Page not found", has no heading, throws in the browser, or one of its API calls fails.
 */
const PASSWORD = process.env.E2E_PASSWORD ?? 'E2E-Only-Password-2026';
const MAX_PAGES = 160;
/** Visit at most this many concrete URLs per route pattern (e.g. /quality/ncrs/:id). */
const PER_PATTERN = 3;

const pattern = (url: string) => url.split('?')[0]!.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ':id');

async function crawl(browser: Browser, email: string) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'My Work' })).toBeVisible();

  const problems: string[] = [];
  let current = '/';
  page.on('pageerror', (err) => problems.push(`${current} — browser error: ${err.message}`));
  page.on('response', (res) => {
    const url = new URL(res.url());
    if (url.pathname.startsWith('/api/') && res.request().method() === 'GET' && res.status() >= 400) problems.push(`${current} — ${res.status()} from ${url.pathname}${url.search}`);
  });

  const queue = ['/'];
  const seen = new Set<string>(queue);
  const perPattern = new Map<string, number>();
  let visited = 0;
  while (queue.length && visited < MAX_PAGES) {
    current = queue.shift()!;
    visited += 1;
    await page.goto(current);
    await page.waitForLoadState('networkidle');
    if (await page.getByText('Page not found').count()) problems.push(`${current} — Page not found`);
    else if ((await page.getByRole('heading', { level: 1 }).count()) === 0) problems.push(`${current} — no page heading`);
    const hrefs = await page.locator('main a[href^="/"], nav a[href^="/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')!));
    for (const href of hrefs) {
      if (href.startsWith('/api/') || seen.has(href)) continue;
      const p = pattern(href);
      if ((perPattern.get(p) ?? 0) >= PER_PATTERN) continue;
      perPattern.set(p, (perPattern.get(p) ?? 0) + 1);
      seen.add(href);
      queue.push(href);
    }
  }
  await context.close();
  return { problems, visited, patterns: perPattern.size };
}

test('NEG-21: every visible link works for a cross-functional manager and for an inspector', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'desktop crawl');
  test.setTimeout(300_000);
  for (const email of ['riley.chen@example.com', 'jordan.rivera@example.com']) {
    const result = await crawl(browser, email);
    expect(result.visited, `${email} visited pages`).toBeGreaterThan(25);
    expect(result.problems, `${email}: ${result.visited} pages, ${result.patterns} route patterns`).toEqual([]);
  }
});
