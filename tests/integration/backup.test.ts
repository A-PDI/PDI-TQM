import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBackup, verifyBackup } from '../../src/server/backup.js';
import { readinessProbe } from '../../src/server/backup-probe.js';
import { GOOD_ROWS, benchCsv } from '../fixtures/bench.js';
import { makePng } from '../fixtures/images.js';
import { type Harness, type Session, TEST_DB, formRevisionId, passAll, save, startHarness, version } from './harness.js';

/** AT-21 (restore and validate evidence links) and NEG-14 (database-only backup is not success). */
let h: Harness;
let inspector: Session;
let quality: Session;
let work: string;
let inspectionId: string;

const RING = { free_end_gap_relaxed: '10.05', installed_end_gap: '0.52', axial_width_ring_height: '2.980', radial_wall_thickness: '4.20' };

beforeAll(async () => {
  h = await startHarness();
  [inspector, quality] = await Promise.all([h.login('inspector'), h.login('quality')]);
  mkdirSync(path.resolve(import.meta.dirname, '../../var'), { recursive: true });
  work = mkdtempSync(path.resolve(import.meta.dirname, '../../var/backup-test-'));

  // Evidence of every kind: an inspection photo, its controlled PDF edition and an original bench file.
  const launched = await inspector.send('POST', '/api/inspections', {
    partId: h.ids.parts['TQ-PRK-3003'],
    formRevisionId: await formRevisionId(inspector, 'PDI-IQI-004'),
    unitCount: 1,
    dateReceived: '2026-10-19',
    sourceId: h.ids.sources.ringNwr1,
    lotNumber: 'LOT-BKP-1',
  });
  inspectionId = launched.json.id;
  await passAll(inspector, inspectionId, 0, 'A');
  await passAll(inspector, inspectionId, 1, 'B');
  await save(inspector, inspectionId, Object.entries(RING).map(([rowKey, v]) => ({ unitIndex: 1, sectionKey: 'C', rowKey, status: 'P', readings: { a1: v, a2: v } })), [{ unitIndex: 1, serialNumber: 'SN-BKP-1' }]);
  await save(inspector, inspectionId, [{ unitIndex: 1, sectionKey: 'B', rowKey: 'running_face_coating', status: 'F', note: 'Uncoated (fictional)' }]);
  expect((await inspector.upload(`/api/inspections/${inspectionId}/photos?unitIndex=1&sectionKey=B&rowKey=running_face_coating`, makePng(40, 30, [20, 60, 140]), 'b.png', 'image/png')).status).toBe(201);
  await inspector.send('POST', `/api/inspections/${inspectionId}/complete`, { expectedVersion: await version(inspector, inspectionId) });
  expect((await quality.send('POST', `/api/inspections/${inspectionId}/review`, { decision: 'CONFIRM', expectedVersion: await version(quality, inspectionId), comment: 'ok (fictional)' })).status).toBe(200);
  await h.svc.worker!.drain();
  expect((await inspector.upload('/api/injectors/imports', benchCsv([{ serial: 'INJ-BKP-1', testedAt: '2026-10-20T08:00:00Z', rows: GOOD_ROWS }]), 'bkp.csv', 'text/csv')).status).toBe(201);
});
afterAll(async () => {
  await h?.close();
  if (work) rmSync(work, { recursive: true, force: true });
});

const backup = () => createBackup({ databaseUrl: TEST_DB, storageRoot: h.storageRoot, outDir: path.join(work, 'backups') });
const verify = (dir: string, keep = false) =>
  verifyBackup({ backupDir: dir, adminDatabaseUrl: TEST_DB, workDir: work, keep, probe: (url, root) => readinessProbe(url, root) });

describe('application-consistent backup and isolated restore (AT-21)', () => {
  it('a backup restores into an isolated database and storage root with every evidence link, hash and record intact', async () => {
    const { dir, manifest } = await backup();
    expect(manifest.evidence.count).toBeGreaterThanOrEqual(3); // photo, report PDF, bench file
    expect(manifest.database.counts.audit_event).toBeGreaterThanOrEqual(10);
    const report = await verify(dir, true);
    expect(report.checks.filter((c) => !c.ok)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual([
      'manifest',
      'format',
      'database export',
      'evidence files',
      'version compatibility',
      'database restore',
      'record counts',
      'schema version',
      'evidence links',
      'evidence and report references',
      'volume pairing',
      'application readiness',
    ]);

    // The restored PDF edition is byte-identical to the original and still matches its recorded hash.
    const url = new URL(TEST_DB);
    url.pathname = `/${report.restoredDatabase}`;
    const restored = new pg.Client({ connectionString: url.toString() });
    await restored.connect();
    try {
      const row = (await restored.query(
        `SELECT f.storage_key, f.sha256 FROM report_rendition r JOIN file_object f ON f.id = r.file_id WHERE r.subject_id = $1`,
        [inspectionId],
      )).rows[0];
      const objectRel = path.join('objects', row.storage_key.slice(0, 2), row.storage_key);
      expect(readFileSync(path.join(report.restoredStorageRoot!, objectRel)).equals(readFileSync(path.join(h.storageRoot, objectRel)))).toBe(true);
      expect((await restored.query(`SELECT count(*)::int AS n FROM injector_test`)).rows[0].n).toBe(1);
    } finally {
      await restored.end();
      const admin = new pg.Client({ connectionString: TEST_DB });
      await admin.connect();
      await admin.query(`DROP DATABASE IF EXISTS ${report.restoredDatabase} WITH (FORCE)`);
      await admin.end();
      rmSync(report.restoredStorageRoot!, { recursive: true, force: true });
    }
  });

  it('a dump that needs a newer PostgreSQL than the restore server is refused with a plain explanation', async () => {
    const { dir } = await backup();
    const mismatched = path.join(work, 'newer-tool');
    cpSync(dir, mismatched, { recursive: true });
    // Simulate a dump written by a much newer pg_dump: re-seal the edited manifest so only the version check can fail.
    const manifest = JSON.parse(readFileSync(path.join(mismatched, 'manifest.json'), 'utf8'));
    manifest.database.toolMajor = 99;
    const { canonicalJson } = await import('../../src/shared/forms.js');
    const text = canonicalJson(manifest);
    writeFileSync(path.join(mismatched, 'manifest.json'), text);
    writeFileSync(path.join(mismatched, 'manifest.sha256'), `${createHash('sha256').update(text).digest('hex')}  manifest.json\n`);
    const report = await verify(mismatched);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === 'version compatibility')).toMatchObject({ ok: false, detail: expect.stringMatching(/needs PostgreSQL 99 or newer; use matching client tools/) });
    expect(report.restoredDatabase).toBeNull();
  });

  it('NEG-14: a database export without the evidence files is reported INCOMPLETE, and nothing is restored', async () => {
    const { dir } = await backup();
    rmSync(path.join(dir, 'evidence'), { recursive: true, force: true });
    const report = await verify(dir);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === 'evidence files')).toMatchObject({ ok: false, detail: expect.stringMatching(/database-only backup cannot restore complete evidence/) });
    expect(report.restoredDatabase).toBeNull();
  });

  it('an uncoordinated set (database export from another backup) is refused', async () => {
    const first = await backup();
    await inspector.send('POST', '/api/injectors', { partId: h.ids.parts['TQ-INJ-9009'], serialNumber: 'INJ-BKP-LATER' });
    const second = await backup();
    const mixed = path.join(work, 'mixed');
    cpSync(first.dir, mixed, { recursive: true });
    cpSync(path.join(second.dir, 'database.dump'), path.join(mixed, 'database.dump'));
    const report = await verify(mixed);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === 'database export')).toMatchObject({ ok: false, detail: expect.stringMatching(/uncoordinated set/) });
  });

  it('an altered evidence copy or an edited manifest is detected', async () => {
    const { dir, manifest } = await backup();
    const altered = path.join(work, 'altered');
    cpSync(dir, altered, { recursive: true });
    const key = manifest.evidence.files[0]!.storageKey;
    writeFileSync(path.join(altered, 'evidence', 'objects', key.slice(0, 2), key), 'changed');
    expect((await verify(altered)).checks.find((c) => c.name === 'evidence files')?.ok).toBe(false);

    const edited = path.join(work, 'edited');
    cpSync(dir, edited, { recursive: true });
    writeFileSync(path.join(edited, 'manifest.json'), readFileSync(path.join(edited, 'manifest.json'), 'utf8').replace('"count":', '"count": 0, "x":'));
    const r = await verify(edited);
    expect(r.ok).toBe(false);
    expect(r.checks[0]).toMatchObject({ name: 'manifest', ok: false });
  });

  it('a backup run that cannot read an original stops and marks itself INCOMPLETE with the reason', async () => {
    const key = (await h.pool.query(`SELECT storage_key FROM file_object WHERE kind = 'PHOTO' AND status = 'AVAILABLE' LIMIT 1`)).rows[0].storage_key as string;
    const object = path.join(h.storageRoot, 'objects', key.slice(0, 2), key);
    const moved = `${object}.away`;
    renameSync(object, moved);
    try {
      await expect(backup()).rejects.toThrow(/missing object/);
    } finally {
      renameSync(moved, object);
    }
  });

  it('a backup run that finds a corrupt original stops and marks itself INCOMPLETE', async () => {
    const key = (await h.pool.query(`SELECT storage_key FROM file_object WHERE kind = 'IMPORT' AND status = 'AVAILABLE' LIMIT 1`)).rows[0].storage_key as string;
    const object = path.join(h.storageRoot, 'objects', key.slice(0, 2), key);
    const original = readFileSync(object);
    chmodSync(object, 0o640); // stored objects are read-only (0440)
    writeFileSync(object, 'corrupted');
    try {
      await expect(backup()).rejects.toThrow(/is incomplete: object .* does not match its recorded hash/);
    } finally {
      writeFileSync(object, original);
      chmodSync(object, 0o440);
    }
    const dirs = (await import('node:fs')).readdirSync(path.join(work, 'backups'));
    expect(dirs.some((d) => existsSync(path.join(work, 'backups', d, 'INCOMPLETE')))).toBe(true);
  });
});
