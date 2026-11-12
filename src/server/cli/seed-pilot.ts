import { buildApp, initFreshEvidenceVolume, pairEvidenceVolume } from '../app.js';
import { loadConfig } from '../config.js';
import { createPool } from '../db.js';
import { pilotSessions, seedPilot, seedPilotAgreements } from '../pilot-seed.js';

/**
 * Pilot sample data for an isolated TEST environment (refuses production):
 *   TQMS_DEMO_PASSWORD=... [PILOT_TEMPLATES_DIR=/path/to/approved-template-copies] node dist/server/server/cli/seed-pilot.js
 * Runs once per database (system_setting pilot_seed); later runs report that it is already seeded.
 */
async function main() {
  const config = loadConfig();
  if (config.appEnv === 'production') throw new Error('Pilot sample data may not be seeded into production');
  const db = createPool(config.databaseUrl, config.databaseSsl);
  const { app, svc } = await buildApp(config, db);
  try {
    await initFreshEvidenceVolume(db, svc.storage);
    await pairEvidenceVolume(db, svc.storage);
    await app.ready();
    const password = process.env.TQMS_DEMO_PASSWORD ?? '';
    const log = { info: (o: object, m?: string) => console.log(m ?? '', o), warn: (o: object, m?: string) => console.warn(m ?? '', o) };
    const sessions = pilotSessions(app, password);
    const agreements = await seedPilotAgreements(app, svc, { password, log, drain: true, sessions });
    const result = await seedPilot(app, svc, { password, templatesDir: process.argv[2] ?? process.env.PILOT_TEMPLATES_DIR ?? null, log, drain: true, sessions });
    console.log(JSON.stringify({ agreements, records: result }, null, 2));
  } finally {
    await app.close();
    await db.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
