import { parseArgs } from 'node:util';
import { ROLE_BUNDLES } from '../../shared/capabilities.js';
import { audit } from '../audit.js';
import { hashPassword, passwordProblem } from '../auth.js';
import { createPool, one, withTransaction } from '../db.js';
import { ensureSystemUser } from '../reference-data.js';

/**
 * Create-once administrator bootstrap. The password is read from TQMS_BOOTSTRAP_PASSWORD so it
 * never appears in shell history or logs. Refuses to run when any administrator already exists.
 */
async function main() {
  const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' } } });
  const password = process.env.TQMS_BOOTSTRAP_PASSWORD ?? '';
  if (!values.email || !values.name) throw new Error('Usage: bootstrap-admin --email <email> --name "<display name>"');
  const problem = passwordProblem(password);
  if (problem) throw new Error(`TQMS_BOOTSTRAP_PASSWORD: ${problem}`);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = createPool(url, process.env.DATABASE_SSL === 'true');
  try {
    const systemId = await ensureSystemUser(pool);
    await withTransaction(pool, async (tx) => {
      await tx.query('LOCK TABLE authority_grant IN SHARE ROW EXCLUSIVE MODE');
      const existing = await one(tx, `SELECT 1 FROM authority_grant WHERE capability_code = 'admin.users' AND revoked_at IS NULL`);
      if (existing) throw new Error('An administrator already exists; bootstrap is create-once. Use the Administration screen.');
      const user = await one<{ id: string }>(
        tx,
        `INSERT INTO app_user (email, display_name, password_hash, created_by) VALUES ($1, $2, $3, $4) RETURNING id`,
        [values.email, values.name, await hashPassword(password), systemId],
      );
      for (const cap of ROLE_BUNDLES.administrator!.capabilities) {
        await tx.query(`INSERT INTO authority_grant (user_id, capability_code, reason, granted_by) VALUES ($1, $2, 'Administrator bootstrap', $3)`, [
          user!.id,
          cap,
          systemId,
        ]);
      }
      await audit(tx, { actorId: systemId, action: 'admin.bootstrap', entityType: 'app_user', entityId: user!.id, summary: `Bootstrap administrator ${values.email} created` });
    });
    console.log(`Administrator ${values.email} created.`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
