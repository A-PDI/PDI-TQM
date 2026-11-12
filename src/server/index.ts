import { buildApp, checkReadiness, initFreshEvidenceVolume, pairEvidenceVolume } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { pilotSessions, seedPilot, seedPilotAgreements } from './pilot-seed.js';
import { startReminderSchedule } from './quality/commitments.js';

async function main() {
  const config = loadConfig();
  const db = createPool(config.databaseUrl, config.databaseSsl);
  const { app, svc } = await buildApp(config, db);

  // Startup verification: never fall back to ephemeral storage. The process still serves
  // /health so the platform sees a clear "not ready" reason instead of a crash loop.
  const initialized = await initFreshEvidenceVolume(db, svc.storage).catch((err) => {
    app.log.error({ err }, 'could not initialize the evidence volume');
    return null;
  });
  if (initialized) app.log.info({ volumeId: initialized }, 'initialized a freshly attached evidence volume');
  await pairEvidenceVolume(db, svc.storage).catch((err) => app.log.error({ err }, 'could not pair evidence volume'));
  const readiness = await checkReadiness(svc);
  if (!readiness.ready) app.log.error({ checks: readiness.checks }, 'TQM is NOT READY — see readiness checks');

  let stopReminders: (() => void) | null = null;
  if (config.jobsEnabled) {
    svc.worker?.start();
    stopReminders = startReminderSchedule(svc);
  }
  await app.listen({ port: config.port, host: config.host });

  // TEST environments only: fictional pilot records, created once through the API (never in production).
  if (process.env.PILOT_SEED === 'true' && config.appEnv !== 'production' && readiness.ready) {
    const password = process.env.TQMS_DEMO_PASSWORD ?? '';
    const sessions = pilotSessions(app, password);
    // Agreements need no controlled templates; the module records wait until the templates are in force.
    void (async () => {
      try {
        const a = await seedPilotAgreements(app, svc, { password, log: app.log, sessions });
        app.log.info({ pilotAgreements: a }, `pilot agreements ${a.status.toLowerCase()}${a.reason ? `: ${a.reason}` : ''}`);
      } catch (err) {
        app.log.error({ err }, 'pilot agreements failed');
      }
      try {
        const r = await seedPilot(app, svc, { password, templatesDir: process.env.PILOT_TEMPLATES_DIR ?? null, log: app.log, sessions });
        app.log.info({ pilotSeed: r }, `pilot seed ${r.status.toLowerCase()}${r.reason ? `: ${r.reason}` : ''}`);
      } catch (err) {
        app.log.error({ err }, 'pilot seed failed');
      }
    })();
  }

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    stopReminders?.();
    await svc.worker?.stop();
    await app.close();
    await db.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
