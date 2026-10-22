import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { SESSION_COOKIE, resolveSession } from './auth.js';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { AppError, fromDbError } from './errors.js';
import { registerEvidenceRoutes } from './evidence.js';
import { inspectionReportHandler } from './inspections/report-job.js';
import { registerInspectionRoutes } from './inspections/routes.js';
import { JobWorker } from './jobs.js';
import { registerQualityRoutes } from './quality.js';
import { registerCommitmentRoutes, reminderSweepHandler } from './quality/commitments.js';
import { registerConcessionRoutes } from './quality/concessions.js';
import { registerNcrRoutes } from './quality/ncr.js';
import { registerScarRoutes } from './quality/scars.js';
import { registerChangeRoutes } from './changes/changes.js';
import { registerFormRoutes } from './forms/forms.js';
import { registerInjectorRoutes } from './injectors/routes.js';
import { registerReportRoutes } from './reports/routes.js';
import { registerControlledDocumentRoutes } from './documents/routes.js';
import { registerStageRoutes } from './inspections/stages.js';
import { registerCoreRoutes } from './routes-core.js';
import { recordReportHandler } from './sourcing/approval-report.js';
import { registerBaselineRoutes } from './sourcing/baselines.js';
import { registerDocumentRoutes } from './sourcing/documents.js';
import { registerSourcingRoutes } from './sourcing/requests.js';
import { registerSourceRoutes } from './sourcing/sources.js';
import { registerSupplierRoutes } from './sourcing/suppliers.js';
import type { Services } from './services.js';
import { EvidenceStorage } from './storage.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_EXEMPT = new Set(['/api/auth/login']);

export interface Readiness {
  ready: boolean;
  checks: Record<string, { ok: boolean; detail?: string }>;
}

export async function checkReadiness(svc: Services): Promise<Readiness> {
  const checks: Readiness['checks'] = {};
  try {
    await svc.db.query('SELECT 1');
    checks.database = { ok: true };
  } catch {
    checks.database = { ok: false, detail: 'Database unreachable' };
  }
  const storage = await svc.storage.check();
  checks.evidenceStorage = storage.ok ? { ok: true } : { ok: false, detail: storage.reason };
  if (checks.database.ok && storage.volumeId) {
    const row = await svc.db.query<{ value: { volumeId: string } }>(`SELECT value FROM system_setting WHERE key = 'evidence_volume'`);
    const paired = row.rows[0]?.value.volumeId;
    checks.volumePairing =
      paired && paired !== storage.volumeId
        ? { ok: false, detail: 'Evidence volume does not match this database (uncoordinated restore?)' }
        : { ok: true, detail: paired ? undefined : 'Not yet paired' };
  }
  return { ready: Object.values(checks).every((c) => c.ok), checks };
}

/** Records which evidence volume this database is paired with (first boot only). */
export async function pairEvidenceVolume(db: Db, storage: EvidenceStorage): Promise<void> {
  const volumeId = await storage.readVolumeId();
  if (!volumeId) return;
  await db.query(
    `INSERT INTO system_setting (key, value) VALUES ('evidence_volume', $1) ON CONFLICT (key) DO NOTHING`,
    [JSON.stringify({ volumeId, pairedAt: new Date().toISOString() })],
  );
}

/**
 * First boot on a freshly attached disk: writes the volume marker automatically, but only when the
 * storage root is a separately mounted filesystem with no evidence tree yet and this database has never
 * been paired with a volume or recorded a file. Anything else is left for an operator (storage-init),
 * so an unmounted image folder or a wrong disk still fails readiness.
 */
export async function initFreshEvidenceVolume(db: Db, storage: EvidenceStorage): Promise<string | null> {
  if (await storage.readVolumeId()) return null;
  if (!(await storage.isMountPoint())) return null;
  if (existsSync(storage.objectsDir)) return null;
  const used = await db.query<{ n: string }>(
    `SELECT (SELECT count(*) FROM system_setting WHERE key = 'evidence_volume') + (SELECT count(*) FROM file_object) AS n`,
  );
  if (Number(used.rows[0]!.n) > 0) return null;
  return storage.initVolume();
}

export async function buildApp(config: Config, db: Db, opts: { rootDir?: string } = {}): Promise<{ app: FastifyInstance; svc: Services }> {
  const rootDir = opts.rootDir ?? process.cwd();
  const logoPath = path.join(rootDir, 'assets/brand/pdi-logo.png');
  const storage = new EvidenceStorage(config.storageRoot, config.storageMinFreeBytes);
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ['req.headers.cookie', 'req.headers["x-csrf-token"]', 'req.headers.authorization'],
    },
    trustProxy: config.appEnv === 'staging' || config.appEnv === 'production',
    bodyLimit: 1024 * 1024,
    genReqId: () => crypto.randomUUID(),
  });
  const svc: Services = { db, config, storage, logo: existsSync(logoPath) ? readFileSync(logoPath) : null, worker: null, routes: [] };
  // Route inventory: lets the authorization sweep test cover every registered endpoint.
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) if (method !== 'HEAD') svc.routes.push({ method, url: route.url });
  });
  svc.worker = new JobWorker(
    db,
    { inspection_report: inspectionReportHandler(svc), record_report: recordReportHandler(svc), reminder_sweep: reminderSweepHandler(svc) },
    app.log,
  );

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        connectSrc: ["'self'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });
  // The limit guards the API. Static files and the app shell are exempt: one page load fetches
  // several of them, and an office shares one public address, so counting them would make the
  // app fail to load for everyone once a few people are busy.
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute', allowList: (req) => !req.url.startsWith('/api/') });
  await app.register(multipart, { limits: { files: 1, fields: 10, fieldSize: 2048 } });

  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    req.auth = await resolveSession(db, req.cookies[SESSION_COOKIE]);
    const pathOnly = req.url.split('?')[0]!;
    if (!SAFE_METHODS.has(req.method) && !CSRF_EXEMPT.has(pathOnly)) {
      // Double defense with SameSite=Strict: state changes need the session's CSRF token.
      if (!req.auth) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in required');
      if (req.headers['x-csrf-token'] !== req.auth.csrfToken) throw new AppError(403, 'CSRF', 'Security token missing or invalid; reload the page');
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details ?? null } });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({
        error: { code: 'VALIDATION', message: 'Request is invalid', details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
      });
    }
    const mapped = fromDbError(err);
    if (mapped) return reply.code(mapped.statusCode).send({ error: { code: mapped.code, message: mapped.message, details: mapped.details ?? null } });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: { code: (err as { code?: string }).code ?? 'REQUEST', message: (err as Error).message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'INTERNAL', message: `Unexpected error. Reference ${req.id}` } });
  });

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_req, reply) => {
    const r = await checkReadiness(svc);
    return reply.code(r.ready ? 200 : 503).send({ status: r.ready ? 'ready' : 'not_ready', checks: r.checks });
  });

  registerCoreRoutes(app, svc);
  registerInspectionRoutes(app, svc);
  registerEvidenceRoutes(app, svc);
  registerQualityRoutes(app, svc);
  registerSupplierRoutes(app, svc);
  registerBaselineRoutes(app, svc);
  registerSourcingRoutes(app, svc);
  registerSourceRoutes(app, svc);
  registerDocumentRoutes(app, svc);
  registerNcrRoutes(app, svc);
  registerConcessionRoutes(app, svc);
  registerScarRoutes(app, svc);
  registerCommitmentRoutes(app, svc);
  registerChangeRoutes(app, svc);
  registerFormRoutes(app, svc);
  registerInjectorRoutes(app, svc);
  registerReportRoutes(app, svc);
  registerControlledDocumentRoutes(app, svc);
  registerStageRoutes(app, svc);

  if (existsSync(path.join(config.webDistDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: config.webDistDir, wildcard: false, index: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== 'GET' || req.url.startsWith('/api/') || req.url.startsWith('/health/')) {
        return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
      }
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } }));
  }

  return { app, svc };
}
