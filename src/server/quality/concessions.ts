import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CONCESSION_STATE_TEXT, concessionState, dayIn } from '../../shared/quality.js';
import { audit } from '../audit.js';
import { auditedDenial, has, recheckCapability, requireAuth, requireCapability } from '../auth.js';
import { type Queryable, many, one, withTransaction } from '../db.js';
import { conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { nextRecordNumber } from '../numbering.js';
import type { Services } from '../services.js';
import { closeWork, history, isoDate, issueRecordEdition, linkedFiles, openWork, renditions, uuid } from './common.js';
import { buildConcessionReport } from './reports.js';

export interface ConcessionRow {
  id: string;
  number: string;
  part_id: string;
  source_id: string | null;
  ncr_id: string | null;
  inspection_id: string | null;
  lot_number: string;
  quantity_limit: number;
  characteristic: string;
  status: string;
  valid_from: string;
  valid_until: string;
  requested_by: string;
  version: number;
}

async function loadConcession(db: Queryable, id: string, lock = false): Promise<ConcessionRow> {
  if (!uuid.safeParse(id).success) throw notFound('Concession');
  const c = await one<ConcessionRow>(db, `SELECT *, valid_from::text, valid_until::text FROM concession WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!c) throw notFound('Concession');
  return c;
}

const usedOf = async (db: Queryable, id: string) =>
  (await one<{ n: number }>(db, 'SELECT coalesce(sum(quantity), 0)::int AS n FROM concession_use WHERE concession_id = $1 AND released_at IS NULL', [id]))!.n;

export function registerConcessionRoutes(app: FastifyInstance, svc: Services) {
  const { db, config } = svc;
  const today = () => dayIn(config.displayTimeZone);

  app.get('/api/concessions', async (req) => {
    await requireCapability(db, req, 'records.read', { action: 'concession.list', consequential: false });
    const q = z.object({ status: z.string().max(20).optional(), partId: uuid.optional(), lot: z.string().max(80).optional() }).parse(req.query);
    const params: unknown[] = [];
    const where = ['true'];
    if (q.status) {
      params.push(q.status);
      where.push(`c.status = $${params.length}`);
    }
    if (q.partId) {
      params.push(q.partId);
      where.push(`c.part_id = $${params.length}`);
    }
    if (q.lot) {
      params.push(q.lot.trim());
      where.push(`upper(c.lot_number) = upper($${params.length})`);
    }
    const rows = await many<ConcessionRow & { partNumber: string; requestedBy: string; used: number; ncrNumber: string | null }>(
      db,
      `SELECT c.*, c.valid_from::text, c.valid_until::text, p.part_number AS "partNumber", u.display_name AS "requestedBy", n.number AS "ncrNumber",
              (SELECT coalesce(sum(quantity), 0)::int FROM concession_use x WHERE x.concession_id = c.id AND x.released_at IS NULL) AS used
         FROM concession c JOIN company_part p ON p.id = c.part_id JOIN app_user u ON u.id = c.requested_by LEFT JOIN ncr n ON n.id = c.ncr_id
        WHERE ${where.join(' AND ')} ORDER BY c.requested_at DESC LIMIT 200`,
      params,
    );
    const t = today();
    return rows.map((c) => ({
      id: c.id,
      number: c.number,
      partNumber: c.partNumber,
      lotNumber: c.lot_number,
      characteristic: c.characteristic,
      quantityLimit: c.quantity_limit,
      used: c.used,
      validFrom: c.valid_from,
      validUntil: c.valid_until,
      status: c.status,
      state: concessionState(c, c.used, t),
      requestedBy: c.requestedBy,
      ncrNumber: c.ncrNumber,
    }));
  });

  app.get('/api/concessions/:id', async (req) => {
    const auth = await requireCapability(db, req, 'records.read', { action: 'concession.read', consequential: false });
    const { id } = req.params as { id: string };
    const c = await loadConcession(db, id);
    const detail = await one(
      db,
      `SELECT c.*, c.valid_from::text AS valid_from, c.valid_until::text AS valid_until, p.part_number, p.description AS part_description,
              n.number AS ncr_number, i.number AS inspection_number, r.display_name AS requested_by_name, d.display_name AS decided_by_name,
              (SELECT sp.supplier_part_number || ' — ' || s2.legal_name || ' / ' || ss.name FROM source x JOIN supplier_part sp ON sp.id = x.supplier_part_id
                 JOIN supplier s2 ON s2.id = x.supplier_id JOIN supplier_site ss ON ss.id = x.site_id WHERE x.id = c.source_id) AS source_label
         FROM concession c JOIN company_part p ON p.id = c.part_id LEFT JOIN ncr n ON n.id = c.ncr_id LEFT JOIN inspection i ON i.id = c.inspection_id
         JOIN app_user r ON r.id = c.requested_by LEFT JOIN app_user d ON d.id = c.decided_by
        WHERE c.id = $1`,
      [id],
    );
    const uses = await many(
      db,
      `SELECT x.id, x.quantity, x.used_at AS "usedAt", x.released_at AS "releasedAt", u.display_name AS "usedBy", i.number AS "inspectionNumber", i.id AS "inspectionId",
              n.number AS "ncrNumber", n.id AS "ncrId", d.outcome
         FROM concession_use x JOIN app_user u ON u.id = x.used_by LEFT JOIN inspection i ON i.id = x.inspection_id
         LEFT JOIN disposition_decision d ON d.id = x.disposition_decision_id LEFT JOIN material_scope m ON m.id = d.scope_id LEFT JOIN ncr n ON n.id = m.ncr_id
        WHERE x.concession_id = $1 ORDER BY x.used_at`,
      [id],
    );
    const used = await usedOf(db, id);
    const state = concessionState(c, used, today());
    return {
      concession: { ...detail, used, state, stateText: CONCESSION_STATE_TEXT[state] },
      uses,
      files: await linkedFiles(db, 'CONCESSION', id),
      history: await history(db, 'concession', [id]),
      renditions: await renditions(db, 'CONCESSION', id),
      permissions: {
        decide: has(auth, 'concession.approve') && c.status === 'REQUESTED' && c.requested_by !== auth.userId,
        decideBlockedReason: c.status === 'REQUESTED' && c.requested_by === auth.userId && has(auth, 'concession.approve') ? 'You requested this concession; someone else must decide it.' : null,
        withdraw: c.status === 'REQUESTED' && (c.requested_by === auth.userId || has(auth, 'concession.approve')),
        report: has(auth, 'concession.request') || has(auth, 'concession.approve'),
      },
    };
  });

  app.post('/api/concessions', async (req, reply) => {
    const auth = await requireCapability(db, req, 'concession.request', { action: 'concession.request' });
    const body = z
      .object({
        partId: uuid,
        sourceId: uuid.nullable().optional(),
        ncrId: uuid.nullable().optional(),
        inspectionId: uuid.nullable().optional(),
        configuration: z.string().trim().max(120).nullable().optional(),
        lotNumber: z.string().trim().min(1).max(80),
        poNumber: z.string().trim().max(60).nullable().optional(),
        quantityLimit: z.number().int().min(1).max(1_000_000),
        characteristic: z.string().trim().min(2).max(300),
        permittedException: z.string().trim().min(5).max(2000),
        conditions: z.string().trim().max(2000).nullable().optional(),
        justification: z.string().trim().min(10).max(4000),
        validFrom: isoDate,
        validUntil: isoDate,
      })
      .parse(req.body);
    if (body.validUntil < body.validFrom) throw unprocessable('Valid until must not be before valid from');
    const created = await withTransaction(db, async (tx) => {
      let sourceId = body.sourceId ?? null;
      if (body.ncrId) {
        const n = await one<{ part_id: string | null; source_id: string | null; status: string; number: string }>(tx, 'SELECT part_id, source_id, status, number FROM ncr WHERE id = $1', [body.ncrId]);
        if (!n || n.part_id !== body.partId) throw unprocessable('The NCR is not for this part');
        if (n.status === 'CLOSED') throw conflict(`${n.number} is closed`);
        sourceId = sourceId ?? n.source_id;
        if (n.source_id && sourceId !== n.source_id) throw unprocessable('The source differs from the NCR source');
      }
      if (body.inspectionId) {
        const i = await one<{ part_id: string | null; lot_number: string | null; source_id: string | null }>(tx, 'SELECT part_id, lot_number, source_id FROM inspection WHERE id = $1', [body.inspectionId]);
        if (!i || i.part_id !== body.partId) throw unprocessable('The inspection is not for this part');
        if ((i.lot_number ?? '').toUpperCase() !== body.lotNumber.toUpperCase()) throw unprocessable(`The inspection recorded lot ${i.lot_number ?? 'none'}`);
        sourceId = sourceId ?? i.source_id;
      }
      if (sourceId && !(await one(tx, 'SELECT 1 FROM source WHERE id = $1 AND part_id = $2', [sourceId, body.partId]))) throw unprocessable('The source is not for this part');
      const number = await nextRecordNumber(tx, 'DEV');
      const c = await one<{ id: string }>(
        tx,
        `INSERT INTO concession (number, part_id, source_id, configuration, ncr_id, inspection_id, lot_number, po_number, quantity_limit, characteristic,
            permitted_exception, conditions, justification, valid_from, valid_until, requested_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
        [
          number,
          body.partId,
          sourceId,
          body.configuration ?? null,
          body.ncrId ?? null,
          body.inspectionId ?? null,
          body.lotNumber,
          body.poNumber ?? null,
          body.quantityLimit,
          body.characteristic,
          body.permittedException,
          body.conditions ?? null,
          body.justification,
          body.validFrom,
          body.validUntil,
          auth.userId,
        ],
      );
      await openWork(tx, { kind: 'CONCESSION_DECISION', title: `Decide ${number}: ${body.characteristic} — lot ${body.lotNumber} (${body.quantityLimit})`, subjectType: 'CONCESSION', subjectId: c!.id, capability: 'concession.approve' });
      await audit(tx, {
        actorId: auth.userId,
        action: 'concession.request',
        entityType: 'concession',
        entityId: c!.id,
        summary: `${number} requested for lot ${body.lotNumber}, up to ${body.quantityLimit}, ${body.validFrom} to ${body.validUntil}`,
        reason: body.justification,
        requestId: req.id,
      });
      if (body.ncrId) await audit(tx, { actorId: auth.userId, action: 'concession.request', entityType: 'ncr', entityId: body.ncrId, summary: `Concession ${number} requested`, requestId: req.id });
      return { id: c!.id, number };
    });
    return reply.code(201).send(created);
  });

  app.post('/api/concessions/:id/decide', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'concession.approve', { action: 'concession.decide', entityType: 'concession', entityId: id });
    const body = z.object({ decision: z.enum(['APPROVED', 'REJECTED']), rationale: z.string().trim().min(5).max(2000), expectedVersion: z.number().int() }).parse(req.body);
    return withTransaction(db, async (tx) => {
      const c = await loadConcession(tx, id, true);
      if (c.version !== body.expectedVersion) throw conflict('This concession was changed elsewhere. Reload and try again.');
      if (c.status !== 'REQUESTED') throw conflict(`${c.number} is already ${c.status.toLowerCase()}`);
      // AT-19: nobody grants their own concession.
      if (c.requested_by === auth.userId) throw await auditedDenial(db, req, auth.userId, 'concession.decide', 'concession', id, 'A concession must be decided by someone other than the requester');
      if (!(await recheckCapability(tx, auth.userId, 'concession.approve'))) throw forbidden();
      if (body.decision === 'APPROVED') {
        if (c.valid_until < today()) throw unprocessable(`${c.number} would already be expired (valid until ${c.valid_until})`);
        // Serialize approvals per part, then refuse an overlapping concession for the same lot and characteristic.
        await tx.query('SELECT 1 FROM company_part WHERE id = $1 FOR UPDATE', [c.part_id]);
        const overlap = await one<{ number: string }>(
          tx,
          `SELECT number FROM concession WHERE id <> $1 AND status = 'APPROVED' AND part_id = $2 AND upper(lot_number) = upper($3)
             AND lower(characteristic) = lower($4) AND (source_id IS NULL OR $5::uuid IS NULL OR source_id = $5)
             AND daterange(valid_from, valid_until, '[]') && daterange($6::date, $7::date, '[]')`,
          [id, c.part_id, c.lot_number, c.characteristic, c.source_id, c.valid_from, c.valid_until],
        );
        if (overlap) throw conflict(`${overlap.number} already covers this lot and characteristic for overlapping dates`);
      }
      await tx.query(
        `UPDATE concession SET status = $2, decided_by = $3, decided_at = now(), decision_rationale = $4, grants_used = $5, version = version + 1 WHERE id = $1`,
        [id, body.decision, auth.userId, body.rationale, ['concession.approve']],
      );
      await closeWork(tx, ['CONCESSION_DECISION'], 'CONCESSION', id, auth.userId, body.decision);
      await audit(tx, { actorId: auth.userId, action: 'concession.decide', entityType: 'concession', entityId: id, summary: `${c.number} ${body.decision.toLowerCase()}`, reason: body.rationale, requestId: req.id });
      if (c.ncr_id) await audit(tx, { actorId: auth.userId, action: 'concession.decide', entityType: 'ncr', entityId: c.ncr_id, summary: `Concession ${c.number} ${body.decision.toLowerCase()}`, requestId: req.id });
      return { status: body.decision };
    });
  });

  app.post('/api/concessions/:id/withdraw', async (req) => {
    const { id } = req.params as { id: string };
    const auth = await requireCapability(db, req, 'records.read', { action: 'concession.withdraw', entityType: 'concession', entityId: id });
    const body = z.object({ reason: z.string().trim().min(5).max(2000) }).parse(req.body);
    return withTransaction(db, async (tx) => {
      const c = await loadConcession(tx, id, true);
      if (c.status !== 'REQUESTED') throw conflict(`${c.number} is already ${c.status.toLowerCase()}`);
      if (c.requested_by !== auth.userId && !has(auth, 'concession.approve')) throw forbidden('Only the requester or an approver can withdraw a request');
      await tx.query(`UPDATE concession SET status = 'WITHDRAWN', version = version + 1 WHERE id = $1`, [id]);
      await closeWork(tx, ['CONCESSION_DECISION'], 'CONCESSION', id, auth.userId, 'Withdrawn');
      await audit(tx, { actorId: auth.userId, action: 'concession.withdraw', entityType: 'concession', entityId: id, summary: `${c.number} withdrawn`, reason: body.reason, requestId: req.id });
      return { status: 'WITHDRAWN' };
    });
  });

  app.post('/api/concessions/:id/report', async (req, reply) => {
    const { id } = req.params as { id: string };
    const auth = requireAuth(req);
    if (!has(auth, 'concession.request') && !has(auth, 'concession.approve')) {
      await requireCapability(db, req, 'concession.request', { action: 'concession.report', entityType: 'concession', entityId: id });
    }
    const out = await withTransaction(db, async (tx) => {
      const c = await loadConcession(tx, id, true);
      const content = await buildConcessionReport(tx, id, config.displayTimeZone);
      const issued = await issueRecordEdition(tx, 'CONCESSION', id, (edition) => ({ ...content, edition }));
      await audit(tx, { actorId: auth.userId, action: 'concession.report', entityType: 'concession', entityId: id, summary: `${c.number} OPS-05 edition ${issued.edition} issued`, requestId: req.id });
      return issued;
    });
    return reply.code(201).send(out);
  });
}

