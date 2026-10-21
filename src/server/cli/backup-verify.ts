import os from 'node:os';
import path from 'node:path';
import { verifyBackup } from '../backup.js';
import { readinessProbe } from '../backup-probe.js';

/**
 * Restores a backup into a new isolated database (created from DATABASE_URL's server, which needs
 * CREATEDB) and a temporary storage root, validates it, then removes both unless --keep is given.
 * Exit code 0 only when every check passes; anything else is INCOMPLETE, never success.
 */
async function main() {
  const arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const from = arg('--from');
  if (!from) throw new Error('Pass --from <backup directory>');
  const adminDatabaseUrl = process.env.DATABASE_URL;
  if (!adminDatabaseUrl) throw new Error('Set DATABASE_URL to a server where an isolated restore database may be created');
  const ssl = process.env.DATABASE_SSL === 'true';
  const report = await verifyBackup({
    backupDir: path.resolve(from),
    adminDatabaseUrl,
    ssl,
    workDir: arg('--work') ?? os.tmpdir(),
    keep: process.argv.includes('--keep'),
    probe: (url, root) => readinessProbe(url, root, ssl),
  });
  for (const c of report.checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}: ${c.detail}`);
  console.log(report.ok ? `VERIFIED: backup ${report.backupId} restores completely.` : `INCOMPLETE: backup ${report.backupId ?? '(unknown)'} is not validated.`);
  if (report.restoredDatabase && process.argv.includes('--keep')) console.log(`Kept database ${report.restoredDatabase} and evidence at ${report.restoredStorageRoot}`);
  process.exit(report.ok ? 0 : 2);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
