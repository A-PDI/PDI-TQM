import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { COMMITMENT_STATUS_TEXT, COMMUNICATION_CHANNELS, REMINDER_RULE, commitmentEscalation, dayIn, daysBetween } from '../../shared/quality.js';
import { audit } from '../audit.js';
import { has, recheckCapability, requireCapability } from '../auth.js';
import { type Db, type Queryable, many, one, withTransaction } from '../db.js';
import { conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { enqueueJob } from '../jobs.js';
import { nextRecordNumber } from '../numbering.js';
import type { Services } from '../services.js';
import { closeWork, history, isActiveUser, isoDate, linkedFiles, openWork, uuid } from './common.js';

interface CommitmentRow {
  id: string;
  number: string;
  supplier_id: string;
  source_id: string | null;
  status: string;
  owner_id: string;
  severity: string;
  due_date: string | null;
  promised_action: string;
  version: number;
}

async function loadCommitment(db: Queryable, id: string, lock = false): Promise<CommitmentRow> {
  if (!uuid.safeParse(id).success) throw notFound('Commitment');
  const c = await one<CommitmentRow>(db, `SELECT *, due_date::text FROM supplier_commitment WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!c) throw notFound('Commitment');
  return c;
}

const addEvent = (db: Queryable, commitmentId: string, kind: string, note: string, actorId: string | null, extra: { inspectionId?: string | null; reminderDay?: string | null } = {}) =>
  db.query(
    `INSERT INTO commitment_event (commitment_id, kind, note, inspection_id, reminder_day, actor_id, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp())
     ON CONFLICT (commitment_id, kind, reminder_day) WHERE reminder_day IS NOT NULL DO NOTHING`,
    [commitmentId, kind, note, extra.inspectionId ?? null, extra.reminderDay ?? null, actorId],
  );

/**
 * Daily in-app reminders and severity-proportional escalation for overdue commitments
 * (FR-013, REMINDER-INTERIM-1). Idempotent per commitment and day.
 */
export async function runCommitmentReminders(db: Db, timeZone: string, at: Date = new Date()): Promise<{ reminded: number; escalated: number }> {
  const today = dayIn(timeZone, at);
  const overdue = await many<CommitmentRow & { supplier_name: string }>(
    db,
    `SELECT c.*, c.due_date::text, s.legal_name AS supplier_name FROM supplier_commitment c JOIN supplier s ON s.id = c.supplier_id
      WHERE c.status IN ('OPEN', 'SUPPLIER_CLAIMS_DONE') AND c.due_date < $1::date`,
    [today],
  );
  let reminded = 0;
  let escalated = 0;
  for (const c of overdue) {
    const days = daysBetween(c.due_date!, today);
    const rule = commitmentEscalation(c.severity, days);
    await withTransaction(db, async (tx) => {
      if (rule.remind) {
        const r = await addEvent(tx, c.id, 'REMINDER', `Overdue by ${days} day(s); owner reminded in My Work (${REMINDER_RULE}).`, null, { reminderDay: today });
        if (r.rowCount) reminded += 1;
      }
      if (rule.escalate) {
        const already = await one(tx, `SELECT 1 FROM commitment_event WHERE commitment_id = $1 AND kind = 'ESCALATED'`, [c.id]);
        if (!already) {
          await addEvent(tx, c.id, 'ESCALATED', `Escalated to management: ${c.severity.toLowerCase()} severity, ${days} day(s) overdue (${REMINDER_RULE}).`, null, { reminderDay: today });
          await openWork(tx, {
            kind: 'COMMITMENT_ESCALATION',
            title: `Overdue ${c.number}: ${c.supplier_name} — ${c.promised_action}`,
            subjectType: 'COMMITMENT',
            subjectId: c.id,
            capability: 'work.view_team',
            dueAt: c.due_date,
          });
          await audit(tx, { actorId: null, action: 'commitment.escalate', entityType: 'supplier_commitment', entityId: c.id, summary: `${c.number} escalated (${days} day(s) overdue)` });
          escalated += 1;
        }
      }
    });
  }
  return { reminded, escalated };
}

export function registerCommitmentRoutes(app: FastifyInstance, svc: Services) {
  const { db, config } = svc;
  const today = () => dayIn(config.displayTimeZone);

  app.get('/api/commitments', async (req) => {
    await requireCapability(db, req, 'records.read', { action: 'commitment.list', consequential: false });
    const q = z.object({ status: z.string().max(30).optional(), supplierId: uuid.optional(), sourceId: uuid.optional(), overdue: z.enum(['1']).optional() }).parse(req.query);
    const params: unknown[] = [today()];
    const where = ['true'];
    if (q.status === 'OPEN') where.push(`c.status IN ('OPEN', 'SUPPLIER_CLAIMS_DONE')`);
    else if (q.status) {
      params.push(q.status);
      where.push(`c.status = $${params.length}`);
    }
    if (q.supplierId) {
      params.push(q.supplierId);
      where.push(`c.supplier_id = $${params.length}`);
    }
    if (q.sourceId) {
      params.push(q.sourceId);
      where.push(`c.source_id = $${params.length}`);
    }
    if (q.overdue) where.push(`c.status IN ('OPEN', 'SUPPLIER_CLAIMS_DONE') AND c.due_date < $1::date`);
    return many(
      db,
      `SELECT c.id, c.number, c.promised_action AS "promisedAction", c.status, c.severity, c.due_date::text AS "dueDate", c.representative,
              s.legal_name AS supplier, o.display_name AS owner, p.part_number AS "partNumber",
              (c.status IN ('OPEN', 'SUPPLIER_CLAIMS_DONE') AND c.due_date < $1::date) AS overdue
         FROM supplier_commitment c JOIN supplier s ON s.id = c.supplier_id JOIN app_user o ON o.id = c.owner_id LEFT JOIN company_part p ON p.id = c.part_id
        WHERE ${where.join(' AND ')} ORDER BY c.due_date NULLS LAST, c.recorded_at DESC LIMIT 200`,
      params,
    );
  });

  app.get('/api/commitments/:id', async (req) => {
    const auth = await requireCapability(db, req, 'records.read', { action: 'commitment.read', consequential: false });
    const { id } = req.params as { id: string };
    const c = await loadCommitment(db, id);
    const detail = await one(
      db,
      `SELECT c.*, c.due_date::text AS due_date, s.legal_name AS supplier_name, ss.name AS site_name, p.part_number, o.display_name AS owner_name, r.display_name AS recorded_by_name,
              br.revision_label, b.title AS baseline_title, sc.number AS scar_number, n.number AS ncr_number, ch.number AS change_number,
              (c.status IN ('OPEN', 'SUPPLIER_CLAIMS_DONE') AND c.due_date < $2::date) AS overdue
         FROM supplier_commitment c JOIN supplier s ON s.id = c.supplier_id LEFT JOIN supplier_site ss ON ss.id = c.site_id LEFT JOIN company_part p ON p.id = c.part_id
         JOIN app_user o ON o.id = c.owner_id JOIN app_user r ON r.id = c.recorded_by
         LEFT JOIN baseline_revision br ON br.id = c.baseline_revision_id LEFT JOIN technical_baseline b ON b.id = br.baseline_id
         LEFT JOIN scar sc ON sc.id = c.scar_id LEFT JOIN ncr n ON n.id = c.ncr_id LEFT JOIN change_request ch ON ch.id = c.change_id
        WHERE c.id = $1`,
      [id, today()],
    );
    const events = await many(
      db,
      `SELECT e.id, e.kind, e.note, e.occurred_at AS "occurredAt", u.display_name AS actor, i.id AS "inspectionId", i.number AS "inspectionNumber", i.outcome AS "inspectionOutcome"
         FROM commitment_event e LEFT JOIN app_user u ON u.id = e.actor_id LEFT JOIN inspection i ON i.id = e.inspection_id
        WHERE e.commitment_id = $1 ORDER BY e.occurred_at, e.id`,
      [id],
    );
    const inspections = await many(
      db,
      `SELECT i.id, i.number, i.outcome, i.date_received AS "dateReceived", i.lot_number AS "lotNumber" FROM inspection i
        WHERE i.status = 'COMPLETED' AND i.supplier_id = $1 AND ($2::uuid IS NULL OR i.source_id = $2) ORDER BY i.completed_at DESC LIMIT 30`,
      [c.supplier_id, c.source_id],
    );
    const open = c.status === 'OPEN' || c.status === 'SUPPLIER_CLAIMS_DONE';
    return {
      commitment: { ...detail, statusText: COMMITMENT_STATUS_TEXT[c.status] },
      events,
      inspections,
      files: await linkedFiles(db, 'COMMITMENT', id),
      history: await history(db, 'supplier_commitment', [id]),
      rule: REMINDER_RULE,
      permissions: {
        manage: has(auth, 'commitment.manage') && open,
        verify: has(auth, 'commitment.verify') && open,
        restrictSource: has(auth, 'supplier.restrict') && Boolean(c.source_id),
      },
    };
  });

  app.post('/api/commitments', async (req, reply) => {
    const auth = await requireCapability(db, req, 'commitment.manage', { action: 'commitment.create' });
    const body = z
      .object({
        supplierId: uuid,
        siteId: uuid.nullable().optional(),
        sourceId: uuid.nullable().optional(),
        partId: uuid.nullable().optional(),
        baselineRevisionId: uuid.nullable().optional(),
        scarId: uuid.nullable().optional(),
        ncrId: uuid.nullable().optional(),
        changeId: uuid.nullable().optional(),
        representative: z.string().trim().min(2).max(200),
        channel: z.enum(COMMUNICATION_CHANNELS),
        communicatedAt: z.string().datetime({ offset: true }).or(isoDate),
        statement: z.string().trim().min(5).max(4000),
        promisedAction: z.string().trim().min(5).max(1000),
        expectedOutcome: z.string().trim().max(1000).nullable().optional(),
        verificationMethod: z.string().trim().min(5).max(1000),
        ownerId: uuid,
        dueDate: isoDate.nullable().optional(),
        noDateReason: z.string().trim().min(5).max(500).nullable().optional(),
        severity: z.enum(['LOW', 'MEDIUM', 'HIGH']).default('MEDIUM'),
      })
      .parse(req.body);
    if (!body.dueDate && !body.noDateReason) throw unprocessable('A target date or a reason for having none is required');
    const created = await withTransaction(db, async (tx) => {
      if (!(await isActiveUser(tx, body.ownerId))) throw unprocessable('The owner must be an active user');
      const checks: Array<[string | null | undefined, string, string]> = [
        [body.siteId, 'SELECT 1 FROM supplier_site WHERE id = $1 AND supplier_id = $2', 'site'],
        [body.sourceId, 'SELECT 1 FROM source WHERE id = $1 AND supplier_id = $2', 'source'],
        [body.scarId, 'SELECT 1 FROM scar WHERE id = $1 AND supplier_id = $2', 'SCAR'],
        [body.ncrId, 'SELECT 1 FROM ncr WHERE id = $1 AND supplier_id = $2', 'NCR'],
        [body.changeId, 'SELECT 1 FROM change_request WHERE id = $1 AND (supplier_id IS NULL OR supplier_id = $2)', 'change'],
      ];
      for (const [value, sql, what] of checks) if (value && !(await one(tx, sql, [value, body.supplierId]))) throw unprocessable(`The ${what} does not belong to this supplier`);
      let partId = body.partId ?? null;
      if (body.sourceId) partId = partId ?? (await one<{ part_id: string }>(tx, 'SELECT part_id FROM source WHERE id = $1', [body.sourceId]))!.part_id;
      const number = await nextRecordNumber(tx, 'COM');
      const communicatedAt = body.communicatedAt.length === 10 ? `${body.communicatedAt}T12:00:00Z` : body.communicatedAt;
      const c = await one<{ id: string }>(
        tx,
        `INSERT INTO supplier_commitment (number, supplier_id, site_id, source_id, part_id, baseline_revision_id, scar_id, ncr_id, change_id, representative, channel,
            communicated_at, statement, promised_action, expected_outcome, verification_method, owner_id, due_date, no_date_reason, severity, recorded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id`,
        [
          number,
          body.supplierId,
          body.siteId ?? null,
          body.sourceId ?? null,
          partId,
          body.baselineRevisionId ?? null,
          body.scarId ?? null,
          body.ncrId ?? null,
          body.changeId ?? null,
          body.representative,
          body.channel,
          communicatedAt,
          body.statement,
          body.promisedAction,
          body.expectedOutcome ?? null,
          body.verificationMethod,
          body.ownerId,
          body.dueDate ?? null,
          body.dueDate ? null : body.noDateReason,
          body.severity,
          auth.userId,
        ],
      );
      await openWork(tx, { kind: 'COMMITMENT_FOLLOW_UP', title: `${number}: ${body.promisedAction}`, subjectType: 'COMMITMENT', subjectId: c!.id, assigneeId: body.ownerId, dueAt: body.dueDate ?? null });
      await audit(tx, {
        actorId: auth.userId,
        action: 'commitment.create',
        entityType: 'supplier_commitment',
        entityId: c!.id,
        summary: `${number}: ${body.representative} (${body.channel.toLowerCase()}) promised "${body.promisedAction}"${body.dueDate ? ` by ${body.dueDate}` : ''}`,
        requestId: req.id,
      });
      await audit(tx, { actorId: auth.userId, action: 'commitment.create', entityType: 'supplier', entityId: body.supplierId, summary: `Commitment ${number} recorded: ${body.promisedAction}`, requestId: req.id });
      return { id: c!.id, number };
    });
    return reply.code(201).send(created);
  });

  app.post('/api/commitments/:id/events', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'commitment.manage', { action: 'commitment.update', entityType: 'supplier_commitment', entityId: id });
    const body = z
      .object({ kind: z.enum(['NOTE', 'SUPPLIER_UPDATE', 'SUPPLIER_CLAIM', 'DUE_DATE_CHANGED']), note: z.string().trim().min(3).max(4000), dueDate: isoDate.nullable().optional() })
      .parse(req.body);
    const out = await withTransaction(db, async (tx) => {
      const c = await loadCommitment(tx, id, true);
      if (c.status === 'VERIFIED' || c.status === 'CANCELLED') throw conflict(`${c.number} is ${c.status.toLowerCase()}`);
      if (body.kind === 'DUE_DATE_CHANGED') {
        if (!body.dueDate) throw unprocessable('A new target date is required');
        await tx.query('UPDATE supplier_commitment SET due_date = $2, no_date_reason = NULL, version = version + 1 WHERE id = $1', [id, body.dueDate]);
        await tx.query(`UPDATE work_item SET due_at = $2 WHERE subject_type = 'COMMITMENT' AND subject_id = $1 AND status = 'OPEN'`, [id, body.dueDate]);
      }
      // A supplier's "done" is a claim only; it never verifies or closes the commitment (C6).
      if (body.kind === 'SUPPLIER_CLAIM') await tx.query(`UPDATE supplier_commitment SET status = 'SUPPLIER_CLAIMS_DONE', version = version + 1 WHERE id = $1`, [id]);
      const note = body.kind === 'DUE_DATE_CHANGED' ? `Target date ${c.due_date ?? 'none'} → ${body.dueDate}: ${body.note}` : body.note;
      await addEvent(tx, id, body.kind, note, auth.userId);
      await audit(tx, { actorId: auth.userId, action: 'commitment.update', entityType: 'supplier_commitment', entityId: id, summary: `${c.number}: ${body.kind.toLowerCase().replaceAll('_', ' ')}`, reason: note, requestId: req.id });
      return { ok: true };
    });
    return reply.code(201).send(out);
  });

  app.post('/api/commitments/:id/verify', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'commitment.verify', { action: 'commitment.verify', entityType: 'supplier_commitment', entityId: id });
    const body = z.object({ result: z.enum(['VERIFIED', 'FAILED']), note: z.string().trim().min(5).max(4000), inspectionId: uuid.nullable().optional() }).parse(req.body);
    return withTransaction(db, async (tx) => {
      const c = await loadCommitment(tx, id, true);
      if (c.status === 'VERIFIED' || c.status === 'CANCELLED') throw conflict(`${c.number} is ${c.status.toLowerCase()}`);
      if (!(await recheckCapability(tx, auth.userId, 'commitment.verify'))) throw forbidden();
      let inspectionNumber: string | null = null;
      if (body.inspectionId) {
        const i = await one<{ number: string; status: string; outcome: string | null; supplier_id: string | null }>(tx, 'SELECT number, status, outcome, supplier_id FROM inspection WHERE id = $1', [body.inspectionId]);
        if (!i || i.status !== 'COMPLETED' || i.supplier_id !== c.supplier_id) throw unprocessable('The inspection must be a completed inspection of this supplier');
        if (body.result === 'VERIFIED' && i.outcome === 'FAIL') throw unprocessable(`${i.number} failed; it cannot verify the commitment`);
        inspectionNumber = i.number;
      }
      if (body.result === 'VERIFIED' && !body.inspectionId && !(await linkedFiles(tx, 'COMMITMENT', id)).length) {
        await audit(db, { actorId: auth.userId, action: 'commitment.verify', outcome: 'FAILED', entityType: 'supplier_commitment', entityId: id, summary: 'Verification refused: no objective evidence', requestId: req.id });
        throw unprocessable('Verification needs objective PDI evidence (a completed inspection or an attached record); a supplier statement is not proof');
      }
      if (body.result === 'VERIFIED') {
        await tx.query(`UPDATE supplier_commitment SET status = 'VERIFIED', closed_by = $2, closed_at = now(), version = version + 1 WHERE id = $1`, [id, auth.userId]);
        await closeWork(tx, ['COMMITMENT_FOLLOW_UP', 'COMMITMENT_ESCALATION'], 'COMMITMENT', id, auth.userId, 'Verified by PDI');
      } else {
        // The duty stays open with its owner until resolved (AT-07).
        await tx.query(`UPDATE supplier_commitment SET status = 'OPEN', version = version + 1 WHERE id = $1`, [id]);
      }
      await addEvent(tx, id, body.result === 'VERIFIED' ? 'VERIFIED' : 'VERIFICATION_FAILED', body.note, auth.userId, { inspectionId: body.inspectionId ?? null });
      await audit(tx, {
        actorId: auth.userId,
        action: 'commitment.verify',
        entityType: 'supplier_commitment',
        entityId: id,
        summary: `${c.number} ${body.result === 'VERIFIED' ? 'verified' : 'verification FAILED'}${inspectionNumber ? ` by ${inspectionNumber}` : ''}`,
        reason: body.note,
        requestId: req.id,
      });
      return { status: body.result === 'VERIFIED' ? 'VERIFIED' : 'OPEN' };
    });
  });

  app.post('/api/commitments/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'commitment.manage', { action: 'commitment.cancel', entityType: 'supplier_commitment', entityId: id });
    const body = z.object({ reason: z.string().trim().min(10).max(2000) }).parse(req.body);
    return withTransaction(db, async (tx) => {
      const c = await loadCommitment(tx, id, true);
      if (c.status === 'VERIFIED' || c.status === 'CANCELLED') throw conflict(`${c.number} is ${c.status.toLowerCase()}`);
      await tx.query(`UPDATE supplier_commitment SET status = 'CANCELLED', closed_by = $2, closed_at = now(), version = version + 1 WHERE id = $1`, [id, auth.userId]);
      await addEvent(tx, id, 'CANCELLED', body.reason, auth.userId);
      await closeWork(tx, ['COMMITMENT_FOLLOW_UP', 'COMMITMENT_ESCALATION'], 'COMMITMENT', id, auth.userId, 'Cancelled');
      await audit(tx, { actorId: auth.userId, action: 'commitment.cancel', entityType: 'supplier_commitment', entityId: id, summary: `${c.number} cancelled (duty dismissed with reason)`, reason: body.reason, requestId: req.id });
      return { status: 'CANCELLED' };
    });
  });
}

/** Job handler: one idempotent reminder sweep. */
export function reminderSweepHandler(svc: Services) {
  return async () => {
    await runCommitmentReminders(svc.db, svc.config.displayTimeZone);
  };
}

/**
 * Queues an hourly reminder sweep through the DB job table (one job per hour, idempotent key),
 * so retries and failures are visible like any other job.
 */
export function startReminderSchedule(svc: Services, intervalMs = 10 * 60 * 1000): () => void {
  const enqueue = () =>
    enqueueJob(svc.db, 'reminder_sweep', `reminder_sweep:${new Date().toISOString().slice(0, 13)}`, {}).catch(() => {
      /* the next tick retries; the job table records worker failures */
    });
  void enqueue();
  const timer = setInterval(() => void enqueue(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
