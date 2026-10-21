import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { toCsv } from '../../shared/injectors.js';
import { METRICS_VERSION } from '../../shared/reports.js';
import { audit } from '../audit.js';
import { requireCapability } from '../auth.js';
import { many, one, withTransaction } from '../db.js';
import { notFound } from '../errors.js';
import { periodQuery } from '../injectors/routes.js';
import { nextRecordNumber } from '../numbering.js';
import { issueRecordEdition, renditions, uuid } from '../quality/common.js';
import type { Services } from '../services.js';
import { buildManagementReport } from './management-report.js';
import { EFFECTIVE_OUTCOME_SQL, completedOn, overview } from './metrics.js';
import { trace } from './trace.js';

const horizonQuery = z.object({ horizonDays: z.coerce.number().int().min(1).max(365).default(90) });

export function registerReportRoutes(app: FastifyInstance, svc: Services) {
  const { db, config } = svc;
  const tz = config.displayTimeZone;

  app.get('/api/reports/overview', async (req) => {
    await requireCapability(db, req, 'records.read', { action: 'reports.overview', consequential: false });
    const p = periodQuery(req.query, tz);
    const { horizonDays } = horizonQuery.parse(req.query);
    return overview(db, { ...p, timeZone: tz }, horizonDays);
  });

  // Issue an immutable management report edition with its PDF (FR-103).
  app.post('/api/reports/issue', async (req, reply) => {
    const auth = await requireCapability(db, req, 'reports.export', { action: 'reports.issue' });
    const body = z
      .object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), horizonDays: z.number().int().min(1).max(365).default(90) })
      .parse(req.body);
    const p = periodQuery({ from: body.from, to: body.to }, tz);
    const out = await withTransaction(db, async (tx) => {
      const data = await overview(tx, { ...p, timeZone: tz }, body.horizonDays);
      const number = await nextRecordNumber(tx, 'MR');
      const row = await one<{ id: string }>(
        tx,
        'INSERT INTO management_report (number, period_from, period_to, definitions_version, issued_by) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [number, p.from, p.to, METRICS_VERSION, auth.userId],
      );
      const content = buildManagementReport(data, number, `All parts and suppliers; expiry horizon ${body.horizonDays} days`);
      const issued = await issueRecordEdition(tx, 'MANAGEMENT_REPORT', row!.id, (edition) => ({ ...content, edition }));
      await audit(tx, {
        actorId: auth.userId,
        action: 'reports.issue',
        entityType: 'management_report',
        entityId: row!.id,
        summary: `${number} issued for ${p.from}..${p.to} (${METRICS_VERSION})`,
        requestId: req.id,
      });
      return { id: row!.id, number, snapshotId: issued.snapshotId };
    });
    return reply.code(201).send(out);
  });

  app.get('/api/reports/issued', async (req) => {
    await requireCapability(db, req, 'records.read', { action: 'reports.issued', consequential: false });
    const rows = await many<{ id: string; number: string; periodFrom: string; periodTo: string; definitionsVersion: string; issuedAt: Date; issuedBy: string }>(
      db,
      `SELECT m.id, m.number, m.period_from::text AS "periodFrom", m.period_to::text AS "periodTo", m.definitions_version AS "definitionsVersion",
              m.issued_at AS "issuedAt", u.display_name AS "issuedBy"
         FROM management_report m JOIN app_user u ON u.id = m.issued_by ORDER BY m.issued_at DESC LIMIT 50`,
    );
    const out = [];
    for (const r of rows) out.push({ ...r, renditions: await renditions(db, 'MANAGEMENT_REPORT', r.id) });
    return out;
  });

  // Rendition status of any issued snapshot (PDF jobs run asynchronously).
  app.get('/api/report-snapshots/:id', async (req) => {
    await requireCapability(db, req, 'records.read', { action: 'reports.snapshot', consequential: false });
    const { id } = req.params as { id: string };
    if (!uuid.safeParse(id).success) throw notFound('Report');
    const row = await one(
      db,
      `SELECT s.id, s.subject_type AS "subjectType", s.subject_id AS "subjectId", s.edition, s.snapshot->>'number' AS number, s.snapshot->>'title' AS title,
              s.created_at AS "createdAt", r.file_id AS "fileId", r.page_count AS "pageCount", r.sha256
         FROM report_snapshot s LEFT JOIN report_rendition r ON r.snapshot_id = s.id WHERE s.id = $1`,
      [id],
    );
    if (!row) throw notFound('Report');
    return row;
  });

  app.get('/api/trace', async (req) => {
    await requireCapability(db, req, 'records.read', { action: 'trace', consequential: false });
    return trace(db, req.query, tz);
  });

  // CSV exports: each carries its period, time zone, generation time and definitions version (FR-103, C10).
  const sendCsv = async (reply: FastifyReply, name: string, title: string, p: { from: string; to: string }, header: string[], rows: unknown[][]) => {
    const body = [[`# PDI TQMS ${title}; period ${p.from} to ${p.to} (${tz}); generated ${new Date().toISOString()}; ${METRICS_VERSION}`], header, ...rows];
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${name}-${p.from}-${p.to}.csv"`)
      .send(toCsv(body));
  };

  const exports: Record<string, { title: string; header: string[]; sql: string }> = {
    inspections: {
      title: 'completed inspections (by completion date)',
      header: ['Number', 'Part', 'Description', 'Supplier', 'Site', 'PO', 'Lot', 'Received', 'Completed at', 'Outcome', 'Amended', 'Inspector', 'Form', 'Form revision'],
      sql: `SELECT i.number, i.part_number, i.part_description, s.legal_name, ss.name, i.po_number, i.lot_number, i.date_received::text, i.completed_at,
                   ${EFFECTIVE_OUTCOME_SQL}, (i.amendment_count > 0), u.display_name, i.form_snapshot->>'formNumber', fr.revision_label
              FROM inspection i JOIN app_user u ON u.id = i.inspector_id JOIN form_revision fr ON fr.id = i.form_revision_id
              LEFT JOIN supplier s ON s.id = i.supplier_id LEFT JOIN supplier_site ss ON ss.id = i.site_id
             WHERE i.status = 'COMPLETED' AND ${completedOn('$3')} BETWEEN $1::date AND $2::date ORDER BY i.completed_at`,
    },
    ncrs: {
      title: 'NCRs (by confirmation date)',
      header: ['Number', 'Title', 'Severity', 'Status', 'Part', 'Supplier', 'Lot', 'Characteristic', 'Failure mode', 'Confirmed at', 'Closed at', 'Owner'],
      sql: `SELECT n.number, n.title, n.severity, n.status, p.part_number, s.legal_name, n.lot_number, n.characteristic, n.failure_mode, n.confirmed_at, n.closed_at, u.display_name
              FROM ncr n LEFT JOIN company_part p ON p.id = n.part_id LEFT JOIN supplier s ON s.id = n.supplier_id JOIN app_user u ON u.id = n.owner_id
             WHERE (n.confirmed_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date ORDER BY n.confirmed_at`,
    },
    scars: {
      title: 'SCARs (by issue date)',
      header: ['Number', 'Title', 'Status', 'Cycle', 'Supplier', 'Part', 'Response due', 'Issued at', 'Closed at', 'Owner'],
      sql: `SELECT x.number, x.title, x.status, x.cycle, s.legal_name, p.part_number, x.response_due::text, x.issued_at, x.closed_at, u.display_name
              FROM scar x JOIN supplier s ON s.id = x.supplier_id LEFT JOIN company_part p ON p.id = x.part_id JOIN app_user u ON u.id = x.owner_id
             WHERE (x.issued_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date ORDER BY x.issued_at`,
    },
    commitments: {
      title: 'supplier commitments (by communication date)',
      header: ['Number', 'Supplier', 'Representative', 'Channel', 'Communicated at', 'Promised action', 'Due', 'No-date reason', 'Severity', 'Status', 'Owner', 'Closed at'],
      sql: `SELECT c.number, s.legal_name, c.representative, c.channel, c.communicated_at, c.promised_action, c.due_date::text, c.no_date_reason, c.severity, c.status, u.display_name, c.closed_at
              FROM supplier_commitment c JOIN supplier s ON s.id = c.supplier_id JOIN app_user u ON u.id = c.owner_id
             WHERE (c.communicated_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date ORDER BY c.communicated_at`,
    },
  };

  for (const [name, def] of Object.entries(exports)) {
    app.get(`/api/exports/${name}.csv`, async (req, reply) => {
      const auth = await requireCapability(db, req, 'reports.export', { action: `export.${name}` });
      const p = periodQuery(req.query, tz);
      const result = await db.query({ text: def.sql, values: [p.from, p.to, tz], rowMode: 'array' });
      await audit(db, { actorId: auth.userId, action: `export.${name}`, summary: `${def.title} exported for ${p.from}..${p.to} (${result.rows.length} rows)`, requestId: req.id });
      return sendCsv(reply, name, def.title, p, def.header, result.rows as unknown[][]);
    });
  }

  app.get('/api/exports/supplier-quality.csv', async (req, reply) => {
    const auth = await requireCapability(db, req, 'reports.export', { action: 'export.supplier_quality' });
    const p = periodQuery(req.query, tz);
    const { horizonDays } = horizonQuery.parse(req.query);
    const o = await overview(db, { ...p, timeZone: tz }, horizonDays);
    await audit(db, { actorId: auth.userId, action: 'export.supplier_quality', summary: `Supplier quality exported for ${p.from}..${p.to} (${o.suppliers.length} suppliers)`, requestId: req.id });
    return sendCsv(
      reply,
      'supplier-quality',
      'supplier quality',
      p,
      ['Code', 'Supplier', 'Completed inspections', 'Failed', 'Accepted', 'Fail rate %', 'NCRs in period', 'Open NCRs', 'Open SCARs', 'Overdue commitments', 'Site qualification'],
      o.suppliers.map((s) => [s.code, s.name, s.completed, s.failed, s.accepted, s.failRate, s.ncrs, s.openNcrs, s.openScars, s.overdueCommitments, s.sites.join('; ')]),
    );
  });
}
