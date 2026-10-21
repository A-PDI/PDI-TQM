import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type pg from 'pg';

const MIGRATION_LOCK = 724_100_001;

/**
 * Forward-only migrations. Applied files are checksummed; an edited, already-applied
 * migration stops the run instead of silently diverging.
 */
export async function runMigrations(pool: pg.Pool, dir: string, log: (m: string) => void = console.log): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migration (
      name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map(
      (await client.query<{ name: string; sha256: string }>('SELECT name, sha256 FROM schema_migration')).rows.map((r) => [r.name, r.sha256]),
    );
    const files = readdirSync(dir).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
    for (const file of files) {
      const sql = readFileSync(path.join(dir, file), 'utf8');
      const sha = createHash('sha256').update(sql).digest('hex');
      const prior = done.get(file);
      if (prior) {
        if (prior !== sha) throw new Error(`Migration ${file} was modified after being applied (checksum mismatch)`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migration (name, sha256) VALUES ($1, $2)', [file, sha]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
      log(`applied migration ${file}`);
    }
    for (const name of done.keys()) {
      if (!files.includes(name)) throw new Error(`Applied migration ${name} is missing from ${dir}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => undefined);
    client.release();
  }
  return applied;
}
