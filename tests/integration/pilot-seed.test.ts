import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedPilot } from '../../src/server/pilot-seed.js';
import { standInFiles } from '../fixtures/controlled-templates.js';
import { type Harness, PASSWORD, startHarness } from './harness.js';

/**
 * Pilot sample data for a TEST environment: created once through the API as the demo personas, so
 * every sample event has its controlled record and the completed ones carry validated controlled PDFs.
 * (CI uses structure-identical stand-ins; a deployed test environment uses copies of the approved files.)
 */
let h: Harness;
let dir: string;
const log = { info: () => undefined, warn: () => undefined };

beforeAll(async () => {
  h = await startHarness();
  dir = mkdtempSync(path.join(h.storageRoot, 'pilot-templates-'));
  for (const f of await standInFiles(['INT-01', 'OPS-02', 'OPS-04', 'OPS-05', 'OPS-06', 'OPS-07', 'VAL-02'])) writeFileSync(path.join(dir, f.name), f.bytes);
});
afterAll(async () => h?.close());

describe('pilot seed', () => {
  it('waits for the controlled templates rather than recording events without their forms', async () => {
    const r = await seedPilot(h.app, h.svc, { password: PASSWORD, templatesDir: null, log });
    expect(r).toMatchObject({ status: 'SKIPPED', reason: expect.stringMatching(/controlled templates not in force: INT-01, OPS-02/) });
    expect((await h.pool.query(`SELECT count(*)::int AS n FROM controlled_record`)).rows[0].n).toBe(0);
  });

  it('imports the templates, creates one record per module through its single approval path, and runs once', async () => {
    const r = await seedPilot(h.app, h.svc, { password: PASSWORD, templatesDir: dir, log, drain: true });
    expect(r.status).toBe('SEEDED');
    expect(r.templates.failed).toEqual([]);
    expect(r.records).toHaveLength(9);
    const rows = (await h.pool.query(`SELECT type_code, status, event_bound FROM controlled_record ORDER BY number`)).rows;
    expect(rows.every((x) => x.event_bound)).toBe(true);
    expect(rows.map((x) => `${x.type_code}:${x.status}`).sort()).toEqual(
      ['INT-01:DRAFT', 'OPS-02:COMPLETED', 'OPS-02:COMPLETED', 'OPS-02:DRAFT', 'OPS-04:DRAFT', 'OPS-05:COMPLETED', 'OPS-05:SUBMITTED', 'OPS-06:DRAFT', 'OPS-07:DRAFT', 'VAL-02:DRAFT'].sort(),
    );
    const outputs = (await h.pool.query(`SELECT v.ok FROM report_rendition r JOIN controlled_output_validation v ON v.rendition_id = r.id WHERE r.subject_type = 'CONTROLLED_RECORD'`)).rows;
    expect(outputs.map((o) => o.ok)).toEqual([true, true, true]);
    const again = await seedPilot(h.app, h.svc, { password: PASSWORD, templatesDir: dir, log });
    expect(again).toMatchObject({ status: 'SKIPPED', reason: expect.stringMatching(/already seeded/) });
  });

  it('refuses production', async () => {
    const prod = { ...h.svc, config: { ...h.svc.config, appEnv: 'production' as const } };
    await expect(seedPilot(h.app, prod, { password: PASSWORD, templatesDir: dir, log })).rejects.toThrow(/may not be seeded into production/);
  });
});
