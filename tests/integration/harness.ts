import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { buildApp, pairEvidenceVolume } from '../../src/server/app.js';
import { loadConfig } from '../../src/server/config.js';
import { createPool } from '../../src/server/db.js';
import { DEMO_USERS, type DemoKey, seedDemo } from '../../src/server/demo-seed.js';
import { runMigrations } from '../../src/server/migrate.js';
import { loadReferenceData } from '../../src/server/reference-data.js';
import type { Services } from '../../src/server/services.js';

export const TEST_DB = process.env.TEST_DATABASE_URL ?? 'postgres://tqms:tqms_local_dev@localhost:5432/tqms_test';
export const PASSWORD = 'Test-Only-Password-2026';
const ROOT = path.resolve(import.meta.dirname, '../..');

export interface Harness {
  app: FastifyInstance;
  svc: Services;
  pool: pg.Pool;
  ids: Awaited<ReturnType<typeof seedDemo>>;
  storageRoot: string;
  login: (who: DemoKey) => Promise<Session>;
  close: () => Promise<void>;
}

export interface Session {
  cookie: string;
  csrf: string;
  get: (url: string) => Promise<Res>;
  send: (method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown) => Promise<Res>;
  upload: (url: string, bytes: Buffer, filename: string, contentType: string) => Promise<Res>;
}

export interface Res {
  status: number;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  raw: Buffer;
  headers: Record<string, unknown>;
}

/** Fresh schema, reference data and fictional demo data for one test file. */
export async function startHarness(): Promise<Harness> {
  const admin = new pg.Client({ connectionString: TEST_DB });
  await admin.connect();
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await admin.end();

  const pool = createPool(TEST_DB, false);
  await runMigrations(pool, path.join(ROOT, 'migrations'), () => undefined);
  await loadReferenceData(pool, ROOT, () => undefined);
  const ids = await seedDemo(pool, PASSWORD);

  mkdirSync(path.join(ROOT, 'var'), { recursive: true });
  const storageRoot = mkdtempSync(path.join(ROOT, 'var', 'test-evidence-'));
  const config = loadConfig({
    APP_ENV: 'test',
    DATABASE_URL: TEST_DB,
    STORAGE_ROOT: storageRoot,
    STORAGE_MIN_FREE_MB: '1',
    MAX_PHOTO_MB: '2',
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? 'silent',
    DISPLAY_TIMEZONE: 'America/Chicago',
    WEB_DIST_DIR: path.join(ROOT, 'does-not-exist'),
  });
  const { app, svc } = await buildApp(config, pool, { rootDir: ROOT });
  await svc.storage.initVolume();
  await pairEvidenceVolume(pool, svc.storage);
  await app.ready();

  const login = async (who: DemoKey): Promise<Session> => {
    const user = DEMO_USERS.find((u) => u.key === who)!;
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: user.email, password: PASSWORD } });
    if (res.statusCode !== 200) throw new Error(`login failed for ${who}: ${res.body}`);
    const setCookie = String(res.headers['set-cookie']);
    const cookie = setCookie.split(';')[0]!;
    const csrf = res.json().csrfToken as string;
    return sessionFor(app, cookie, csrf);
  };

  return {
    app,
    svc,
    pool,
    ids,
    storageRoot,
    login,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
}

export function sessionFor(app: FastifyInstance, cookie: string, csrf: string): Session {
  const wrap = (r: { statusCode: number; body: string; rawPayload: Buffer; headers: Record<string, unknown> }): Res => {
    let json: unknown = null;
    try {
      json = JSON.parse(r.body);
    } catch {
      json = null;
    }
    return { status: r.statusCode, json, raw: r.rawPayload, headers: r.headers };
  };
  return {
    cookie,
    csrf,
    get: async (url) => wrap(await app.inject({ method: 'GET', url, headers: { cookie } })),
    send: async (method, url, body) =>
      wrap(
        await app.inject({
          method,
          url,
          headers: { cookie, 'x-csrf-token': csrf, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
          payload: body === undefined ? undefined : JSON.stringify(body),
        }),
      ),
    upload: async (url, bytes, filename, contentType) => {
      const boundary = `----tqms${Date.now()}`;
      const payload = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`),
        bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      return wrap(
        await app.inject({
          method: 'POST',
          url,
          headers: { cookie, 'x-csrf-token': csrf, 'content-type': `multipart/form-data; boundary=${boundary}` },
          payload,
        }),
      );
    },
  };
}

export async function formRevisionId(s: Session, formNumber: string): Promise<string> {
  const forms = (await s.get('/api/forms')).json as Array<{ revisionId: string; formNumber: string }>;
  const f = forms.find((x) => x.formNumber === formNumber);
  if (!f) throw new Error(`form ${formNumber} not released`);
  return f.revisionId;
}

/** Answers every row of a checklist section with P via Pass All (fill blanks). */
export async function passAll(s: Session, id: string, unitIndex: number, sectionKey: string) {
  const v = (await s.get(`/api/inspections/${id}`)).json.version;
  const r = await s.send('POST', `/api/inspections/${id}/pass-all`, { expectedVersion: v, unitIndex, sectionKey, mode: 'fill_blank' });
  if (r.status !== 200) throw new Error(`pass-all failed: ${JSON.stringify(r.json)}`);
  return r;
}

export async function save(s: Session, id: string, changes: unknown[], units?: unknown[]) {
  const v = (await s.get(`/api/inspections/${id}`)).json.version;
  return s.send('PATCH', `/api/inspections/${id}/entries`, { expectedVersion: v, changes, units });
}

export async function version(s: Session, id: string): Promise<number> {
  return (await s.get(`/api/inspections/${id}`)).json.version;
}
