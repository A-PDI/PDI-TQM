import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import pg from 'pg';
import { canonicalJson } from '../shared/forms.js';
import { VOLUME_MARKER } from './storage.js';

const run = promisify(execFile);

/**
 * Application-consistent backup (Construction Drawing D2). PostgreSQL and the evidence disk are
 * separate systems, so one exported snapshot drives both: pg_dump uses it, and the evidence file
 * list is read inside the same snapshot. Evidence objects are immutable and never deleted, so
 * every object the snapshot references is still on disk while it is copied.
 */
export const BACKUP_FORMAT = 'TQMS-BACKUP-1';

/** Tables whose row counts are recorded and re-checked after an isolated restore. */
const COUNTED_TABLES = [
  'app_user',
  'authority_grant',
  'audit_event',
  'file_object',
  'evidence_link',
  'inspection',
  'inspection_response',
  'inspection_measurement',
  'report_snapshot',
  'report_rendition',
  'quality_event',
  'ncr',
  'scar',
  'concession',
  'change_request',
  'source_approval_decision',
  'injector_test',
] as const;

export interface BackupFile {
  storageKey: string;
  sha256: string;
  size: number;
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  backupId: string;
  createdAt: string;
  /** serverMajor: PostgreSQL that was dumped; toolMajor: pg_dump that wrote the file (its output may need a server at least this new). */
  database: { file: string; sha256: string; size: number; migrations: string[]; counts: Record<string, number>; serverMajor: number; toolMajor: number };
  evidence: { volumeId: string | null; count: number; bytes: number; files: BackupFile[] };
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VerifyReport {
  ok: boolean;
  backupId: string | null;
  checks: CheckResult[];
  restoredDatabase: string | null;
  restoredStorageRoot: string | null;
}

/** libpq connection details without the password on the command line (it goes via PGPASSWORD). */
function pgArgs(databaseUrl: string) {
  const url = new URL(databaseUrl);
  const password = decodeURIComponent(url.password);
  url.password = '';
  return { dbname: url.toString(), env: { ...process.env, ...(password ? { PGPASSWORD: password } : {}) } };
}

const objectPath = (root: string, key: string) => {
  if (!/^[0-9a-f-]{36}$/.test(key)) throw new Error(`Invalid storage key ${key}`);
  return path.join(root, 'objects', key.slice(0, 2), key);
};

async function sha256File(file: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { sha256: hash.digest('hex'), size };
}

/** Copies a file while hashing it; the copy is fsynced before returning. */
async function copyHashed(from: string, to: string): Promise<{ sha256: string; size: number }> {
  await fs.mkdir(path.dirname(to), { recursive: true });
  const hash = createHash('sha256');
  let size = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      size += chunk.length;
      cb(null, chunk);
    },
  });
  await pipeline(createReadStream(from), tap, createWriteStream(to, { flags: 'wx' }));
  const handle = await fs.open(to, 'r');
  await handle.sync();
  await handle.close();
  return { sha256: hash.digest('hex'), size };
}

async function tableCounts(client: pg.ClientBase): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const t of COUNTED_TABLES) counts[t] = (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t}`)).rows[0]!.n;
  return counts;
}

const serverMajor = async (client: pg.ClientBase) => Math.floor(Number((await client.query<{ v: string }>("SELECT current_setting('server_version_num') AS v")).rows[0]!.v) / 10000);

/**
 * The PostgreSQL client tool to use with a server of the given major version: PG_BIN_DIR when set,
 * else the matching Debian/Ubuntu install (/usr/lib/postgresql/<major>/bin), else whatever is on PATH.
 * Machines often carry several client versions and pg_dump refuses to dump a newer server.
 */
export function pgTool(tool: 'pg_dump' | 'pg_restore', major: number): string {
  if (process.env.PG_BIN_DIR) return path.join(process.env.PG_BIN_DIR, tool);
  const versioned = `/usr/lib/postgresql/${major}/bin/${tool}`;
  return existsSync(versioned) ? versioned : tool;
}

async function toolMajor(tool: string): Promise<number> {
  const { stdout } = await run(tool, ['--version']);
  const m = /(\d+)(?:\.\d+)?/.exec(stdout.replace(/^[^0-9]*/, ''));
  if (!m) throw new Error(`Cannot read the ${tool} version from "${stdout.trim()}"`);
  return Number(m[1]);
}

const migrationsOf = async (client: pg.ClientBase) =>
  (await client.query<{ name: string }>('SELECT name FROM schema_migration ORDER BY name')).rows.map((r) => r.name);

/**
 * Writes `<outDir>/<backupId>/` with database.dump, evidence/, volume marker, manifest.json and
 * manifest.sha256. Fails (and leaves an incomplete marker) if any evidence object is missing or
 * no longer matches its recorded hash.
 */
export async function createBackup(opts: { databaseUrl: string; ssl?: boolean; storageRoot: string; outDir: string; log?: (m: string) => void }): Promise<{ dir: string; manifest: BackupManifest }> {
  const log = opts.log ?? (() => undefined);
  const backupId = `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z-${randomBytes(3).toString('hex')}`;
  const dir = path.join(opts.outDir, backupId);
  if (existsSync(dir)) throw new Error(`Backup directory ${dir} already exists`);
  await fs.mkdir(dir, { recursive: true });
  const client = new pg.Client({ connectionString: opts.databaseUrl, ssl: opts.ssl ? { rejectUnauthorized: true } : undefined });
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = (await client.query<{ s: string }>('SELECT pg_export_snapshot() AS s')).rows[0]!.s;
    const files = (
      await client.query<{ storage_key: string; sha256: string; byte_size: string }>(
        `SELECT storage_key, sha256, byte_size::text FROM file_object WHERE status = 'AVAILABLE' AND storage_key IS NOT NULL ORDER BY storage_key`,
      )
    ).rows;
    const counts = await tableCounts(client);
    const migrations = await migrationsOf(client);
    const sourceMajor = await serverMajor(client);
    const pgDump = pgTool('pg_dump', sourceMajor);
    const dumpMajor = await toolMajor(pgDump);
    const dumpFile = path.join(dir, 'database.dump');
    const { dbname, env } = pgArgs(opts.databaseUrl);
    log(`Dumping database (snapshot ${snapshot})…`);
    await run(pgDump, ['--format=custom', '--no-owner', `--snapshot=${snapshot}`, `--file=${dumpFile}`, `--dbname=${dbname}`], { env, maxBuffer: 16 * 1024 * 1024 });
    await client.query('COMMIT');

    log(`Copying ${files.length} evidence objects…`);
    const copied: BackupFile[] = [];
    const problems: string[] = [];
    for (const f of files) {
      const source = objectPath(opts.storageRoot, f.storage_key);
      if (!existsSync(source)) {
        problems.push(`missing object ${f.storage_key}`);
        continue;
      }
      const c = await copyHashed(source, objectPath(path.join(dir, 'evidence'), f.storage_key));
      if (c.sha256 !== f.sha256 || String(c.size) !== f.byte_size) problems.push(`object ${f.storage_key} does not match its recorded hash`);
      copied.push({ storageKey: f.storage_key, sha256: c.sha256, size: c.size });
    }
    if (problems.length) {
      await fs.writeFile(path.join(dir, 'INCOMPLETE'), `${problems.join('\n')}\n`);
      throw new Error(`Backup ${backupId} is incomplete: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? ` (+${problems.length - 5} more)` : ''}`);
    }
    let volumeId: string | null = null;
    const marker = path.join(opts.storageRoot, VOLUME_MARKER);
    if (existsSync(marker)) {
      await fs.copyFile(marker, path.join(dir, 'evidence', VOLUME_MARKER));
      volumeId = (JSON.parse(await fs.readFile(marker, 'utf8')) as { volumeId: string }).volumeId;
    }
    const dump = await sha256File(dumpFile);
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      backupId,
      createdAt: new Date().toISOString(),
      database: { file: 'database.dump', sha256: dump.sha256, size: dump.size, migrations, counts, serverMajor: sourceMajor, toolMajor: dumpMajor },
      evidence: { volumeId, count: copied.length, bytes: copied.reduce((a, f) => a + f.size, 0), files: copied },
    };
    const text = canonicalJson(manifest);
    await fs.writeFile(path.join(dir, 'manifest.json'), text);
    await fs.writeFile(path.join(dir, 'manifest.sha256'), `${createHash('sha256').update(text).digest('hex')}  manifest.json\n`);
    log(`Backup ${backupId}: database ${dump.size} bytes, ${copied.length} evidence objects.`);
    return { dir, manifest };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    // Any failure leaves an explicit marker so a partial directory is never mistaken for a backup.
    if (!existsSync(path.join(dir, 'INCOMPLETE'))) await fs.writeFile(path.join(dir, 'INCOMPLETE'), `${(err as Error).message}\n`).catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

/**
 * Restores a backup into a new, isolated database and storage root and validates the result end to
 * end. Nothing about the source system is touched. A report is returned instead of throwing, so a
 * database-only or mismatched set is reported as INCOMPLETE rather than success (NEG-14).
 */
export async function verifyBackup(opts: {
  backupDir: string;
  /** A connection the restore database can be created from (needs CREATEDB). */
  adminDatabaseUrl: string;
  ssl?: boolean;
  workDir: string;
  keep?: boolean;
  /** Extra end-to-end check run against the restored database and storage (e.g. application readiness). */
  probe?: (restoredDatabaseUrl: string, restoredStorageRoot: string) => Promise<CheckResult[]>;
}): Promise<VerifyReport> {
  const checks: CheckResult[] = [];
  const check = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
    return ok;
  };
  const report = (restoredDatabase: string | null, restoredStorageRoot: string | null, backupId: string | null): VerifyReport => ({
    ok: checks.length > 0 && checks.every((c) => c.ok),
    backupId,
    checks,
    restoredDatabase,
    restoredStorageRoot,
  });

  // 1. Manifest integrity and coordination of the set.
  let manifest: BackupManifest;
  try {
    const text = await fs.readFile(path.join(opts.backupDir, 'manifest.json'), 'utf8');
    const recorded = (await fs.readFile(path.join(opts.backupDir, 'manifest.sha256'), 'utf8')).split(/\s+/)[0];
    if (!check('manifest', createHash('sha256').update(text).digest('hex') === recorded, 'manifest.json matches manifest.sha256')) return report(null, null, null);
    manifest = JSON.parse(text) as BackupManifest;
    if (!check('format', manifest.format === BACKUP_FORMAT, `format ${manifest.format}`)) return report(null, null, manifest.backupId);
  } catch (err) {
    check('manifest', false, `Manifest missing or unreadable: ${(err as Error).message}`);
    return report(null, null, null);
  }
  if (existsSync(path.join(opts.backupDir, 'INCOMPLETE'))) check('complete', false, 'The backup run recorded problems (INCOMPLETE marker present)');

  const dumpFile = path.join(opts.backupDir, manifest.database.file);
  const dumpOk = existsSync(dumpFile) && (await sha256File(dumpFile)).sha256 === manifest.database.sha256;
  check('database export', dumpOk, dumpOk ? `${manifest.database.size} bytes, hash matches` : 'database.dump is missing or does not belong to this manifest (uncoordinated set)');

  const evidenceDir = path.join(opts.backupDir, 'evidence');
  let missing = 0;
  let mismatched = 0;
  for (const f of manifest.evidence.files) {
    const p = objectPath(evidenceDir, f.storageKey);
    if (!existsSync(p)) {
      missing += 1;
      continue;
    }
    const h = await sha256File(p);
    if (h.sha256 !== f.sha256 || h.size !== f.size) mismatched += 1;
  }
  check(
    'evidence files',
    missing === 0 && mismatched === 0,
    missing || mismatched
      ? `${missing} missing, ${mismatched} altered of ${manifest.evidence.count}; a database-only backup cannot restore complete evidence`
      : `${manifest.evidence.count} objects, ${manifest.evidence.bytes} bytes, all hashes match`,
  );
  if (!checks.every((c) => c.ok)) return report(null, null, manifest.backupId);

  // 2. Isolated restore: a new database and a new storage root.
  const dbName = `tqms_restore_${randomUUID().slice(0, 8)}`;
  const adminUrl = new URL(opts.adminDatabaseUrl);
  const targetUrl = new URL(opts.adminDatabaseUrl);
  targetUrl.pathname = `/${dbName}`;
  const restoredStorageRoot = path.join(opts.workDir, `${dbName}-evidence`);
  const admin = new pg.Client({ connectionString: adminUrl.toString(), ssl: opts.ssl ? { rejectUnauthorized: true } : undefined });
  await admin.connect();
  let created = false;
  try {
    // A dump written by pg_dump N may not load into a server older than N (PostgreSQL documentation).
    const targetMajor = await serverMajor(admin);
    const needed = Math.max(manifest.database.serverMajor, manifest.database.toolMajor);
    if (
      !check(
        'version compatibility',
        targetMajor >= needed,
        targetMajor >= needed
          ? `restore server PostgreSQL ${targetMajor}; dump from server ${manifest.database.serverMajor} by pg_dump ${manifest.database.toolMajor}`
          : `restore server is PostgreSQL ${targetMajor}, but this dump (server ${manifest.database.serverMajor}, pg_dump ${manifest.database.toolMajor}) needs PostgreSQL ${needed} or newer; use matching client tools`,
      )
    )
      return report(null, null, manifest.backupId);
    await admin.query(`CREATE DATABASE ${dbName}`);
    created = true;
    const { dbname, env } = pgArgs(targetUrl.toString());
    try {
      await run(pgTool('pg_restore', targetMajor), ['--no-owner', '--exit-on-error', '--single-transaction', `--dbname=${dbname}`, dumpFile], { env, maxBuffer: 16 * 1024 * 1024 });
      check('database restore', true, `restored into isolated database ${dbName}`);
    } catch (err) {
      check('database restore', false, `pg_restore failed: ${String((err as { stderr?: string }).stderr ?? err).slice(0, 400)}`);
      return report(dbName, null, manifest.backupId);
    }
    for (const f of manifest.evidence.files) await copyHashed(objectPath(evidenceDir, f.storageKey), objectPath(restoredStorageRoot, f.storageKey));
    await fs.mkdir(path.join(restoredStorageRoot, 'staging'), { recursive: true });
    const marker = path.join(evidenceDir, VOLUME_MARKER);
    if (existsSync(marker)) await fs.copyFile(marker, path.join(restoredStorageRoot, VOLUME_MARKER));

    // 3. Validate the restored system against the manifest.
    const restored = new pg.Client({ connectionString: targetUrl.toString(), ssl: opts.ssl ? { rejectUnauthorized: true } : undefined });
    await restored.connect();
    try {
      const counts = await tableCounts(restored);
      const diff = Object.entries(manifest.database.counts).filter(([t, n]) => counts[t] !== n);
      check('record counts', diff.length === 0, diff.length ? `differs: ${diff.map(([t, n]) => `${t} ${counts[t]} vs ${n}`).join(', ')}` : `${Object.keys(counts).length} tables match (audit_event ${counts.audit_event})`);
      const migrations = await migrationsOf(restored);
      check('schema version', canonicalJson(migrations) === canonicalJson(manifest.database.migrations), `${migrations.length} migrations, last ${migrations[migrations.length - 1] ?? 'none'}`);
      const files = (await restored.query<{ storage_key: string; sha256: string }>(`SELECT storage_key, sha256 FROM file_object WHERE status = 'AVAILABLE' AND storage_key IS NOT NULL`)).rows;
      let bad = 0;
      for (const f of files) {
        const p = objectPath(restoredStorageRoot, f.storage_key);
        if (!existsSync(p) || (await sha256File(p)).sha256 !== f.sha256) bad += 1;
      }
      check('evidence links', bad === 0 && files.length === manifest.evidence.count, bad ? `${bad} restored records point to missing or altered files` : `${files.length} file records resolve to restored bytes with matching SHA-256`);
      const dangling = (await restored.query<{ n: number }>(
        `SELECT (SELECT count(*) FROM evidence_link l LEFT JOIN file_object f ON f.id = l.file_id WHERE f.id IS NULL OR f.status <> 'AVAILABLE')
              + (SELECT count(*) FROM report_rendition r LEFT JOIN file_object f ON f.id = r.file_id WHERE f.id IS NULL OR f.sha256 <> r.sha256) AS n`,
      )).rows[0]!.n;
      check('evidence and report references', Number(dangling) === 0, Number(dangling) ? `${dangling} links or report editions do not resolve` : 'every evidence link and report edition resolves');
      const pairing = (await restored.query<{ value: { volumeId: string } }>(`SELECT value FROM system_setting WHERE key = 'evidence_volume'`)).rows[0]?.value.volumeId ?? null;
      check('volume pairing', pairing === manifest.evidence.volumeId, pairing ? `restored database and evidence share volume ${pairing}` : 'no pairing recorded');
    } finally {
      await restored.end();
    }
    if (opts.probe) for (const c of await opts.probe(targetUrl.toString(), restoredStorageRoot)) checks.push(c);
    return report(dbName, restoredStorageRoot, manifest.backupId);
  } finally {
    if (!opts.keep) {
      if (created) await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
      await fs.rm(restoredStorageRoot, { recursive: true, force: true });
    }
    await admin.end();
  }
}
