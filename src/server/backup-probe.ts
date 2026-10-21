import { checkReadiness } from './app.js';
import type { CheckResult } from './backup.js';
import { createPool } from './db.js';
import type { Services } from './services.js';
import { EvidenceStorage } from './storage.js';

/** The restored database and evidence root must pass the same readiness check the web service uses. */
export async function readinessProbe(databaseUrl: string, storageRoot: string, ssl = false): Promise<CheckResult[]> {
  const pool = createPool(databaseUrl, ssl);
  try {
    const svc = { db: pool, storage: new EvidenceStorage(storageRoot, 1) } as unknown as Services;
    const r = await checkReadiness(svc);
    return [
      {
        name: 'application readiness',
        ok: r.ready,
        detail: Object.entries(r.checks)
          .map(([k, c]) => `${k} ${c.ok ? 'ok' : `FAILED${c.detail ? ` (${c.detail})` : ''}`}`)
          .join(', '),
      },
    ];
  } finally {
    await pool.end();
  }
}
