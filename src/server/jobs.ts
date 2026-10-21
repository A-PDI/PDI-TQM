import os from 'node:os';
import type { FastifyBaseLogger } from 'fastify';
import type { Db, Queryable } from './db.js';

export interface JobRow {
  id: string;
  kind: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export type JobHandler = (job: JobRow) => Promise<void>;

export class PermanentJobError extends Error {}

/** Enqueue inside the caller's transaction so the job exists iff the business change commits. */
export async function enqueueJob(db: Queryable, kind: string, idempotencyKey: string, payload: Record<string, unknown>): Promise<void> {
  await db.query(
    `INSERT INTO job (kind, idempotency_key, payload) VALUES ($1, $2, $3) ON CONFLICT (idempotency_key) DO NOTHING`,
    [kind, idempotencyKey, JSON.stringify(payload)],
  );
}

const STALE_CLAIM_MINUTES = 5;

/**
 * Database-backed worker. Claims with SKIP LOCKED; claims abandoned by a crashed or
 * restarted process are reclaimed after a timeout. Failures retry with bounded backoff
 * and end visibly in FAILED_PERMANENT.
 */
export class JobWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly workerId = `${os.hostname()}:${process.pid}`;

  constructor(
    private readonly db: Db,
    private readonly handlers: Record<string, JobHandler>,
    private readonly log: FastifyBaseLogger,
  ) {}

  start(intervalMs = 1000) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.running) await new Promise((r) => setTimeout(r, 25));
  }

  async claim(): Promise<JobRow | null> {
    const res = await this.db.query<JobRow>(
      `UPDATE job SET status = 'CLAIMED', claimed_at = now(), claimed_by = $1, attempts = attempts + 1
        WHERE id = (
          SELECT id FROM job
           WHERE (status IN ('QUEUED', 'FAILED_RETRYABLE') AND run_after <= now())
              OR (status = 'CLAIMED' AND claimed_at < now() - make_interval(mins => $2))
           ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING id, kind, idempotency_key, payload, attempts, max_attempts`,
      [this.workerId, STALE_CLAIM_MINUTES],
    );
    return res.rows[0] ?? null;
  }

  async runJob(job: JobRow): Promise<void> {
    const handler = this.handlers[job.kind];
    try {
      if (!handler) throw new PermanentJobError(`No handler for job kind ${job.kind}`);
      await handler(job);
      await this.db.query(`UPDATE job SET status = 'COMPLETED', completed_at = now(), last_error = NULL WHERE id = $1`, [job.id]);
    } catch (err) {
      const message = (err as Error).message.slice(0, 1000);
      const permanent = err instanceof PermanentJobError || job.attempts >= job.max_attempts;
      await this.db.query(
        `UPDATE job SET status = $2, last_error = $3,
           run_after = now() + make_interval(secs => least(300, power(2, attempts)::int * 5))
         WHERE id = $1`,
        [job.id, permanent ? 'FAILED_PERMANENT' : 'FAILED_RETRYABLE', message],
      );
      this.log.error({ jobId: job.id, kind: job.kind, attempt: job.attempts, permanent }, `job failed: ${message}`);
    }
  }

  /** Processes ready jobs until none remain (used by the timer and by tests). */
  async drain(): Promise<number> {
    let count = 0;
    for (;;) {
      const job = await this.claim();
      if (!job) return count;
      await this.runJob(job);
      count += 1;
    }
  }

  private async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.drain();
    } catch (err) {
      this.log.error({ err }, 'job worker tick failed');
    } finally {
      this.running = false;
    }
  }
}
