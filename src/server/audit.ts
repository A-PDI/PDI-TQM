import type { Queryable } from './db.js';

export interface AuditInput {
  actorId: string | null;
  action: string;
  outcome?: 'SUCCESS' | 'DENIED' | 'FAILED';
  entityType?: string;
  entityId?: string;
  summary: string;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  requestId?: string;
}

export async function audit(db: Queryable, e: AuditInput): Promise<void> {
  await db.query(
    `INSERT INTO audit_event (actor_id, action, outcome, entity_type, entity_id, summary, reason, before_state, after_state, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      e.actorId,
      e.action,
      e.outcome ?? 'SUCCESS',
      e.entityType ?? null,
      e.entityId ?? null,
      e.summary,
      e.reason ?? null,
      e.before === undefined ? null : JSON.stringify(e.before),
      e.after === undefined ? null : JSON.stringify(e.after),
      e.requestId ?? null,
    ],
  );
}
