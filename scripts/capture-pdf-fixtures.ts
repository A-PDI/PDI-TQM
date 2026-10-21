/**
 * Freezes the report snapshots written by the integration tests (var/report-samples/*.snapshot.json)
 * into committed visual-regression fixtures. Run after `npm test` when a report layout change is
 * intended, then refresh the baselines with `npx playwright test tests/e2e/pdf-visual.spec.ts --update-snapshots`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// The representative outputs named in Construction Drawing F1.
export const PDF_FIXTURES = [
  'piston-2-unit',
  'liner-12-unit',
  'cylinder-head-6cyl',
  'crankshaft-accepted',
  'main-bearing-fail',
  'turbocharger-photos',
  'ncr-ops-06',
  'scar-ops-07',
] as const;

const ROOT = path.resolve(import.meta.dirname, '..');
const FIXED_TIME = '2026-10-21T15:00:00.000Z';

let missing = 0;
for (const name of PDF_FIXTURES) {
  const from = path.join(ROOT, 'var/report-samples', `${name}.snapshot.json`);
  if (!existsSync(from)) {
    console.error(`missing ${from}; run npm test first`);
    missing += 1;
    continue;
  }
  const snapshot = JSON.parse(readFileSync(from, 'utf8')) as { generatedAt: string };
  snapshot.generatedAt = FIXED_TIME;
  writeFileSync(path.join(ROOT, 'tests/fixtures/pdf-snapshots', `${name}.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`captured ${name}`);
}
process.exit(missing ? 1 : 0);
