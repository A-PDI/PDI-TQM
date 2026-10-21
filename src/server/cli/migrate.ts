import path from 'node:path';
import { createPool } from '../db.js';
import { runMigrations } from '../migrate.js';
import { loadReferenceData } from '../reference-data.js';

/** Pre-deploy step: forward-only schema migrations, then idempotent reference data. */
async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = createPool(url, process.env.DATABASE_SSL === 'true');
  try {
    const root = process.cwd();
    const applied = await runMigrations(pool, path.join(root, 'migrations'));
    console.log(applied.length ? `migrations applied: ${applied.join(', ')}` : 'schema up to date');
    await loadReferenceData(pool, root);
    console.log('reference data verified');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
