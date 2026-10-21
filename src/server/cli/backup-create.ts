import path from 'node:path';
import { createBackup } from '../backup.js';
import { loadConfig } from '../config.js';

/**
 * Application-consistent backup of the database and evidence disk into a new directory under
 * BACKUP_DIR (or --out <dir>). Copying that directory to an independent, encrypted destination is
 * an operator step whose destination PDI must approve (POL-09).
 */
async function main() {
  const config = loadConfig();
  const i = process.argv.indexOf('--out');
  const outDir = i > 0 ? process.argv[i + 1] : process.env.BACKUP_DIR;
  if (!outDir) throw new Error('Set BACKUP_DIR or pass --out <directory>');
  const { dir, manifest } = await createBackup({
    databaseUrl: config.databaseUrl,
    ssl: config.databaseSsl,
    storageRoot: config.storageRoot,
    outDir: path.resolve(outDir),
    log: (m) => console.log(m),
  });
  console.log(`Backup complete: ${dir}`);
  console.log(`  backup id ${manifest.backupId}; ${manifest.evidence.count} evidence objects; audit events ${manifest.database.counts.audit_event}`);
  console.log('  Not yet verified: run `npm run backup:verify -- --from <dir>` before relying on it.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
