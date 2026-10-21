import { createPool } from '../db.js';
import { seedDemo } from '../demo-seed.js';

/** Explicit fictional demo import; never runs on boot and refuses production. */
async function main() {
  if (process.env.APP_ENV === 'production') throw new Error('Demo data may not be seeded into production');
  const password = process.env.TQMS_DEMO_PASSWORD ?? '';
  if (password.length < 12) throw new Error('Set TQMS_DEMO_PASSWORD (12+ characters); no default demo password exists');
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = createPool(url, process.env.DATABASE_SSL === 'true');
  try {
    const result = await seedDemo(pool, password);
    console.log(`Fictional demo data ready: ${Object.keys(result.users).length} users, ${Object.keys(result.parts).length} parts.`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
