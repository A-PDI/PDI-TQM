import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BENCH_ADAPTER, BENCH_ADAPTER_NOTE, METRICS_VERSION, QUICK_MEASUREMENTS, REPAIR_ACTION_TYPES, normalizeSerial, toCsv } from '../../shared/injectors.js';
import { dayIn } from '../../shared/quality.js';
import { parseReading } from '../../shared/measurement.js';
import { audit } from '../audit.js';
import { has, recheckCapability, requireCapability } from '../auth.js';
import { type Queryable, many, one, withTransaction } from '../db.js';
import { AppError, badRequest, conflict, forbidden, notFound, unprocessable } from '../errors.js';
import { sanitizeFilename } from '../file-validation.js';
import { nextRecordNumber } from '../numbering.js';
import { history, isoDate, issueRecordEdition, renditions, uuid } from '../quality/common.js';
import type { Services } from '../services.js';
import { ensureInjector, importBenchFile, insertTest, sourceKey } from './bench.js';
import { buildComparisonReport, buildShipmentReport } from './reports.js';

export interface TestRow {
  id: string;
  injector_id: string;
  origin: string;
  import_id: string | null;
  import_number: string | null;
  machine_id: string;
  test_plan: string;
  tested_at: Date;
  operator: string | null;
  machine_verdict: string;
  pdi_evaluation: string;
  criteria_label: string | null;
  repair_action_id: string | null;
  repair_case_number: string | null;
  note: string | null;
  results: Array<{ condition: string; parameter: string; unit: string | null; value_text: string; machine_verdict: string | null; lower_limit: string | null; upper_limit: string | null; pdi_evaluation: string }>;
}

export async function testsFor(db: Queryable, injectorIds: string[]): Promise<TestRow[]> {
  if (!injectorIds.length) return [];
  return many<TestRow>(
    db,
    `SELECT t.id, t.injector_id, t.origin, t.import_id, bi.number AS import_number, t.machine_id, t.test_plan, t.tested_at, t.operator, t.machine_verdict, t.pdi_evaluation,
            (SELECT b.title || ' Rev ' || r.revision_label FROM baseline_revision r JOIN technical_baseline b ON b.id = r.baseline_id WHERE r.id = t.criteria_revision_id) AS criteria_label,
            t.repair_action_id, rc.number AS repair_case_number, t.note,
            coalesce((SELECT json_agg(json_build_object('condition', x.condition, 'parameter', x.parameter, 'unit', x.unit, 'value_text', x.value_text, 'machine_verdict', x.machine_verdict,
                                     'lower_limit', x.lower_limit::text, 'upper_limit', x.upper_limit::text, 'pdi_evaluation', x.pdi_evaluation) ORDER BY x.condition, x.parameter)
                        FROM injector_test_result x WHERE x.test_id = t.id), '[]') AS results
       FROM injector_test t LEFT JOIN bench_import bi ON bi.id = t.import_id
       LEFT JOIN repair_action ra ON ra.id = t.repair_action_id LEFT JOIN repair_case rc ON rc.id = ra.case_id
      WHERE t.injector_id = ANY($1::uuid[]) ORDER BY t.tested_at, t.recorded_at`,
    [injectorIds],
  );
}

/** First test, retest after repair, shipment evaluation or other retest (C9 chronology). */
export function classify(tests: TestRow[], shippedTestIds: Set<string>) {
  return tests.map((t, i) => ({
    ...t,
    stage: i === 0 ? 'FIRST_TEST' : t.repair_action_id ? 'RETEST_AFTER_REPAIR' : shippedTestIds.has(t.id) ? 'SHIPMENT_EVALUATION' : 'RETEST',
  }));
}

const testInput = z.object({
  machineId: z.string().trim().min(1).max(60),
  testPlan: z.string().trim().min(1).max(120),
  testedAt: z.string().datetime({ offset: true }),
  testSeq: z.string().trim().max(20).default('1'),
  operator: z.string().trim().max(120).nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
  repairActionId: uuid.nullable().optional(),
  results: z
    .array(
      z.object({
        condition: z.string().trim().min(1).max(60),
        parameter: z.string().trim().min(1).max(60),
        unit: z.string().trim().max(20).nullable().optional(),
        value: z.string().trim().min(1).max(24),
        result: z.enum(['PASS', 'FAIL']).nullable().optional(),
      }),
    )
    .min(1)
    .max(200),
});

export function registerInjectorRoutes(app: FastifyInstance, svc: Services) {
  const { db, config } = svc;

  app.get('/api/injectors', async (req) => {
    await requireCapability(db, req, 'records.read', { action: 'injector.list', consequential: false });
    const q = z.object({ q: z.string().trim().max(100).optional(), verdict: z.enum(['PASS', 'FAIL', 'ANY']).optional() }).parse(req.query);
    const term = q.q ? `%${q.q.replace(/[%_\\]/g, '\\$&')}%` : null;
    return many(
      db,
      `SELECT i.id, i.serial_number AS "serialNumber", p.id AS "partId", p.part_number AS "partNumber", p.description, i.oe_part_number AS "oePartNumber", i.is_synthetic AS "isSynthetic",
              (SELECT count(*)::int FROM injector_test t WHERE t.injector_id = i.id) AS tests,
              (SELECT row_to_json(x) FROM (SELECT t.tested_at AS "testedAt", t.machine_verdict AS "machineVerdict", t.pdi_evaluation AS "pdiEvaluation"
                  FROM injector_test t WHERE t.injector_id = i.id ORDER BY t.tested_at DESC, t.recorded_at DESC LIMIT 1) x) AS latest,
              (SELECT count(*)::int FROM repair_case c WHERE c.injector_id = i.id AND c.status = 'OPEN') AS "openRepairs"
         FROM injector i JOIN company_part p ON p.id = i.part_id
        WHERE ($1::text IS NULL OR i.serial_number ILIKE $1 OR i.normalized_serial LIKE upper(regexp_replace($2, '[^A-Za-z0-9]', '', 'g')) || '%'
               OR p.part_number ILIKE $1 OR i.oe_part_number ILIKE $1)
          AND ($3::text IS NULL OR $3 = 'ANY' OR EXISTS (SELECT 1 FROM injector_test t WHERE t.injector_id = i.id AND (t.machine_verdict = $3 OR t.pdi_evaluation = $3)))
        ORDER BY i.created_at DESC LIMIT 200`,
      [term, q.q ?? '', q.verdict ?? null],
    );
  });

  app.post('/api/injectors', async (req, reply) => {
    const auth = await requireCapability(db, req, 'injector.test', { action: 'injector.register' });
    const body = z.object({ partId: uuid, serialNumber: z.string().trim().min(2).max(60), oePartNumber: z.string().trim().max(60).nullable().optional(), notes: z.string().trim().max(1000).nullable().optional() }).parse(req.body);
    const created = await withTransaction(db, async (tx) => {
      const part = await one<{ id: string; part_number: string }>(tx, 'SELECT id, part_number FROM company_part WHERE id = $1 AND active', [body.partId]);
      if (!part) throw unprocessable('Part not found');
      if (await one(tx, 'SELECT 1 FROM injector WHERE part_id = $1 AND normalized_serial = $2', [body.partId, normalizeSerial(body.serialNumber)])) throw conflict('This serial is already registered for the part');
      const inj = await ensureInjector(tx, body.partId, body.serialNumber, auth.userId);
      await tx.query('UPDATE injector SET oe_part_number = $2, notes = $3 WHERE id = $1', [inj.id, body.oePartNumber ?? null, body.notes ?? null]);
      await audit(tx, { actorId: auth.userId, action: 'injector.register', entityType: 'injector', entityId: inj.id, summary: `Injector ${body.serialNumber} (${part.part_number}) registered`, requestId: req.id });
      return { id: inj.id };
    });
    return reply.code(201).send(created);
  });

  app.get('/api/injectors/:id', async (req) => {
    const auth = await requireCapability(db, req, 'records.read', { action: 'injector.read', consequential: false });
    const { id } = req.params as { id: string };
    if (!uuid.safeParse(id).success) throw notFound('Injector');
    const injector = await one(
      db,
      `SELECT i.id, i.serial_number AS "serialNumber", i.oe_part_number AS "oePartNumber", i.notes, i.is_synthetic AS "isSynthetic", i.created_at AS "createdAt",
              p.id AS "partId", p.part_number AS "partNumber", p.description
         FROM injector i JOIN company_part p ON p.id = i.part_id WHERE i.id = $1`,
      [id],
    );
    if (!injector) throw notFound('Injector');
    const shipped = new Set((await many<{ test_id: string }>(db, 'SELECT test_id FROM shipment_evaluation_item WHERE injector_id = $1 AND test_id IS NOT NULL', [id])).map((r) => r.test_id));
    const tests = classify(await testsFor(db, [id]), shipped);
    const repairs = await many(
      db,
      `SELECT c.id, c.number, c.problem, c.status, c.opened_at AS "openedAt", o.display_name AS "openedBy", c.closed_at AS "closedAt", c.closure_note AS "closureNote", c.version,
              coalesce((SELECT json_agg(json_build_object('id', a.id, 'actionType', a.action_type, 'description', a.description, 'componentReplaced', a.component_replaced,
                          'performedAt', a.performed_at, 'technician', u.display_name,
                          'measurements', coalesce((SELECT json_agg(json_build_object('name', m.name, 'value', m.value_text, 'unit', m.unit) ORDER BY m.name) FROM repair_measurement m WHERE m.action_id = a.id), '[]'),
                          'retests', coalesce((SELECT json_agg(t.id) FROM injector_test t WHERE t.repair_action_id = a.id), '[]')) ORDER BY a.performed_at)
                          FROM repair_action a JOIN app_user u ON u.id = a.technician_id WHERE a.case_id = c.id), '[]') AS actions
         FROM repair_case c JOIN app_user o ON o.id = c.opened_by WHERE c.injector_id = $1 ORDER BY c.opened_at`,
      [id],
    );
    const shipments = await many(
      db,
      `SELECT e.id, e.number, e.reference, e.evaluated_at AS "evaluatedAt", i.result, i.basis FROM shipment_evaluation_item i JOIN shipment_evaluation e ON e.id = i.evaluation_id
        WHERE i.injector_id = $1 ORDER BY e.evaluated_at`,
      [id],
    );
    // Receiving inspections that recorded this serial for the same part.
    const inspections = await many(
      db,
      `SELECT DISTINCT i.id, i.number, i.status, i.outcome, i.date_received AS "dateReceived" FROM inspection i JOIN inspection_unit u ON u.inspection_id = i.id
        WHERE i.part_id = $1 AND upper(regexp_replace(coalesce(u.serial_number, ''), '[^A-Za-z0-9]', '', 'g')) = $2 ORDER BY i.date_received`,
      [(injector as { partId: string }).partId, normalizeSerial((injector as { serialNumber: string }).serialNumber)],
    );
    return {
      injector,
      tests,
      repairs,
      shipments,
      inspections,
      quickMeasurements: QUICK_MEASUREMENTS,
      history: await history(db, 'injector', [id]),
      permissions: { test: has(auth, 'injector.test'), evaluate: has(auth, 'injector.evaluate'), export: has(auth, 'reports.export') },
    };
  });

  // Bench file import through the interim adapter (no live bench integration).
  app.post('/api/injectors/imports', async (req, reply) => {
    const auth = await requireCapability(db, req, 'injector.test', { action: 'injector.import' });
    const health = await svc.storage.check();
    if (!health.ok) throw new AppError(503, 'STORAGE_UNAVAILABLE', 'Evidence storage is unavailable; the file was not imported.');
    const part = await req.file({ limits: { fileSize: config.maxDocumentBytes, files: 1 } });
    if (!part) throw badRequest('No file was uploaded');
    let bytes: Buffer;
    try {
      bytes = await part.toBuffer();
    } catch (err) {
      if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') throw new AppError(413, 'FILE_TOO_LARGE', `The file exceeds ${Math.round(config.maxDocumentBytes / 1048576)} MB`);
      throw err;
    }
    const outcome = await importBenchFile(svc, auth, { bytes, name: sanitizeFilename(part.filename) || 'bench.csv' });
    return reply.code(201).send(outcome);
  });

  app.get('/api/injectors/imports', async (req) => {
    await requireCapability(db, req, 'records.read', { action: 'injector.imports', consequential: false });
    return many(
      db,
      `SELECT b.id, b.number, b.status, b.adapter, b.tests_total AS "testsTotal", b.tests_added AS "testsAdded", b.tests_duplicate AS "testsDuplicate", b.tests_conflict AS "testsConflict",
              b.tests_excluded AS "testsExcluded", b.injectors_added AS "injectorsAdded", b.imported_at AS "importedAt", u.display_name AS "importedBy", f.original_name AS "fileName"
         FROM bench_import b JOIN app_user u ON u.id = b.imported_by JOIN file_object f ON f.id = b.file_id ORDER BY b.imported_at DESC LIMIT 100`,
    );
  });

  app.get('/api/injectors/imports/:id', async (req) => {
    await requireCapability(db, req, 'records.read', { action: 'injector.import_read', consequential: false });
    const { id } = req.params as { id: string };
    if (!uuid.safeParse(id).success) throw notFound('Import');
    const row = await one(
      db,
      `SELECT b.*, u.display_name AS imported_by_name, f.original_name AS file_name, f.id AS file_id FROM bench_import b JOIN app_user u ON u.id = b.imported_by
         JOIN file_object f ON f.id = b.file_id WHERE b.id = $1`,
      [id],
    );
    if (!row) throw notFound('Import');
    return { import: row, adapterNote: BENCH_ADAPTER_NOTE };
  });

  app.post('/api/injectors/:id/tests', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!uuid.safeParse(id).success) throw notFound('Injector');
    const auth = await requireCapability(db, req, 'injector.test', { action: 'injector.test_manual', entityType: 'injector', entityId: id });
    const body = testInput.parse(req.body);
    for (const r of body.results) if (!parseReading(r.value).ok) throw unprocessable(`${r.condition} / ${r.parameter}: "${r.value}" is not a number`);
    const created = await withTransaction(db, async (tx) => {
      const inj = await one<{ id: string; part_id: string; serial_number: string; part_number: string }>(
        tx,
        'SELECT i.id, i.part_id, i.serial_number, p.part_number FROM injector i JOIN company_part p ON p.id = i.part_id WHERE i.id = $1 FOR UPDATE OF i',
        [id],
      );
      if (!inj) throw notFound('Injector');
      const input = {
        machineId: body.machineId,
        testPlan: body.testPlan,
        serial: inj.serial_number,
        partNumber: inj.part_number,
        testedAt: new Date(body.testedAt).toISOString(),
        testSeq: body.testSeq,
        operator: body.operator ?? null,
        results: body.results.map((r) => ({ condition: r.condition, parameter: r.parameter, unit: r.unit || null, value: parseReading(r.value).ok ? (parseReading(r.value) as { value: { canonical: string } }).value.canonical : r.value, result: r.result ?? null })),
        raw: body.results.map((r) => ({ ...r, entered: 'manual' }) as unknown as Record<string, string>),
      };
      if (await one(tx, 'SELECT 1 FROM injector_test WHERE source_key = $1', [sourceKey(input, 'MANUAL')])) throw conflict('A test with this machine, time and sequence is already recorded for this injector');
      if (body.repairActionId) await assertRetestOf(tx, body.repairActionId, id, input.testedAt);
      const testId = await insertTest(tx, input, { injectorId: id, partId: inj.part_id, origin: 'MANUAL', importId: null, actorId: auth.userId, repairActionId: body.repairActionId ?? null, note: body.note ?? null });
      await audit(tx, { actorId: auth.userId, action: 'injector.test_manual', entityType: 'injector', entityId: id, summary: `Manual bench test recorded (${body.testPlan}, ${body.results.length} values)${body.repairActionId ? ' as retest after repair' : ''}`, requestId: req.id });
      return { id: testId };
    });
    return reply.code(201).send(created);
  });

  // Associate an existing test as the retest that verifies a repair action (once; C9).
  app.post('/api/injector-tests/:id/retest-of', async (req) => {
    const { id } = req.params as { id: string };
    if (!uuid.safeParse(id).success) throw notFound('Test');
    const auth = await requireCapability(db, req, 'injector.test', { action: 'injector.retest_link', entityType: 'injector_test', entityId: id });
    const body = z.object({ repairActionId: uuid }).parse(req.body);
    return withTransaction(db, async (tx) => {
      const t = await one<{ injector_id: string; tested_at: Date; repair_action_id: string | null }>(tx, 'SELECT injector_id, tested_at, repair_action_id FROM injector_test WHERE id = $1 FOR UPDATE', [id]);
      if (!t) throw notFound('Test');
      if (t.repair_action_id) throw conflict('This test is already attributed to a repair action');
      await assertRetestOf(tx, body.repairActionId, t.injector_id, t.tested_at.toISOString());
      await tx.query('UPDATE injector_test SET repair_action_id = $2 WHERE id = $1', [id, body.repairActionId]);
      await audit(tx, { actorId: auth.userId, action: 'injector.retest_link', entityType: 'injector', entityId: t.injector_id, summary: 'Test attributed as retest after repair action', requestId: req.id });
      return { ok: true };
    });
  });

  app.post('/api/injectors/:id/repair-cases', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!uuid.safeParse(id).success) throw notFound('Injector');
    const auth = await requireCapability(db, req, 'injector.test', { action: 'injector.repair_open', entityType: 'injector', entityId: id });
    const body = z.object({ problem: z.string().trim().min(5).max(2000) }).parse(req.body);
    const created = await withTransaction(db, async (tx) => {
      if (!(await one(tx, 'SELECT 1 FROM injector WHERE id = $1', [id]))) throw notFound('Injector');
      if (await one(tx, `SELECT 1 FROM repair_case WHERE injector_id = $1 AND status = 'OPEN'`, [id])) throw conflict('This injector already has an open repair case');
      const number = await nextRecordNumber(tx, 'REP');
      const c = await one<{ id: string }>(tx, 'INSERT INTO repair_case (number, injector_id, problem, opened_by) VALUES ($1,$2,$3,$4) RETURNING id', [number, id, body.problem, auth.userId]);
      await audit(tx, { actorId: auth.userId, action: 'injector.repair_open', entityType: 'injector', entityId: id, summary: `${number} opened: ${body.problem}`, requestId: req.id });
      return { id: c!.id, number };
    });
    return reply.code(201).send(created);
  });

  app.post('/api/repair-cases/:id/actions', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!uuid.safeParse(id).success) throw notFound('Repair case');
    const auth = await requireCapability(db, req, 'injector.test', { action: 'injector.repair_action', entityType: 'repair_case', entityId: id });
    const body = z
      .object({
        actionType: z.enum(REPAIR_ACTION_TYPES),
        description: z.string().trim().min(3).max(2000),
        componentReplaced: z.string().trim().max(200).nullable().optional(),
        performedAt: z.string().datetime({ offset: true }).optional(),
        measurements: z
          .array(z.object({ name: z.string().trim().min(1).max(60), value: z.string().trim().min(1).max(24), unit: z.string().trim().max(20).nullable().optional() }))
          .max(30)
          .default([]),
      })
      .parse(req.body);
    if (body.actionType === 'COMPONENT_REPLACEMENT' && !body.componentReplaced) throw unprocessable('Name the replaced component');
    if (new Set(body.measurements.map((m) => m.name.toLowerCase())).size !== body.measurements.length) throw unprocessable('Each measurement name may appear once');
    const created = await withTransaction(db, async (tx) => {
      const c = await one<{ status: string; injector_id: string; number: string }>(tx, 'SELECT status, injector_id, number FROM repair_case WHERE id = $1 FOR UPDATE', [id]);
      if (!c) throw notFound('Repair case');
      if (c.status !== 'OPEN') throw conflict(`${c.number} is closed`);
      const a = await one<{ id: string }>(
        tx,
        `INSERT INTO repair_action (case_id, action_type, description, component_replaced, technician_id, performed_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [id, body.actionType, body.description, body.componentReplaced ?? null, auth.userId, body.performedAt ?? new Date().toISOString()],
      );
      for (const m of body.measurements) {
        const v = parseReading(m.value);
        await tx.query('INSERT INTO repair_measurement (action_id, name, value_text, value, unit) VALUES ($1,$2,$3,$4,$5)', [a!.id, m.name, m.value, v.ok ? v.value.canonical : null, m.unit ?? null]);
      }
      await audit(tx, {
        actorId: auth.userId,
        action: 'injector.repair_action',
        entityType: 'injector',
        entityId: c.injector_id,
        summary: `${c.number}: ${body.actionType.toLowerCase().replace('_', ' ')} — ${body.description}${body.measurements.length ? ` (${body.measurements.map((m) => `${m.name} ${m.value}${m.unit ? ` ${m.unit}` : ''}`).join(', ')})` : ''}`,
        requestId: req.id,
      });
      return { id: a!.id };
    });
    return reply.code(201).send(created);
  });

  app.post('/api/repair-cases/:id/close', async (req) => {
    const { id } = req.params as { id: string };
    if (!uuid.safeParse(id).success) throw notFound('Repair case');
    const auth = await requireCapability(db, req, 'injector.test', { action: 'injector.repair_close', entityType: 'repair_case', entityId: id });
    const body = z.object({ note: z.string().trim().min(5).max(2000), expectedVersion: z.number().int() }).parse(req.body);
    return withTransaction(db, async (tx) => {
      const c = await one<{ status: string; injector_id: string; number: string; version: number }>(tx, 'SELECT status, injector_id, number, version FROM repair_case WHERE id = $1 FOR UPDATE', [id]);
      if (!c) throw notFound('Repair case');
      if (c.version !== body.expectedVersion) throw conflict('This repair case changed; reload and try again');
      if (c.status !== 'OPEN') throw conflict(`${c.number} is already closed`);
      const retested = await one(tx, 'SELECT 1 FROM injector_test t JOIN repair_action a ON a.id = t.repair_action_id WHERE a.case_id = $1', [id]);
      if (!retested) throw unprocessable('A repair case closes only after a retest is attributed to one of its actions');
      await tx.query(`UPDATE repair_case SET status = 'CLOSED', closed_by = $2, closed_at = now(), closure_note = $3, version = version + 1 WHERE id = $1`, [id, auth.userId, body.note]);
      await audit(tx, { actorId: auth.userId, action: 'injector.repair_close', entityType: 'injector', entityId: c.injector_id, summary: `${c.number} closed`, reason: body.note, requestId: req.id });
      return { status: 'CLOSED' };
    });
  });

  // Comparison of selected injectors in the user's order: first, latest and repaired state (FR-061, FR-063).
  app.get('/api/injectors/compare', async (req) => {
    await requireCapability(db, req, 'records.read', { action: 'injector.compare', consequential: false });
    return comparison(db, parseIds(req.query));
  });

  app.get('/api/exports/injector-compare.csv', async (req, reply) => {
    const auth = await requireCapability(db, req, 'reports.export', { action: 'export.injector_compare' });
    const ids = parseIds(req.query);
    const c = await comparison(db, ids);
    const rows: unknown[][] = [
      [`# PDI TQMS injector comparison; generated ${new Date().toISOString()}; ${BENCH_ADAPTER} data; values as recorded`],
      ['Condition', 'Parameter', 'Unit', ...c.injectors.flatMap((i) => [`${i.serialNumber} first`, `${i.serialNumber} latest`])],
      ...c.rows.map((r) => [r.condition, r.parameter, r.unit ?? '', ...r.values.flatMap((v) => [v.first?.value ?? '', v.latest?.value ?? ''])]),
    ];
    await audit(db, { actorId: auth.userId, action: 'export.injector_compare', summary: `Injector comparison exported (${ids.length} injectors)`, requestId: req.id });
    return reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', 'attachment; filename="injector-comparison.csv"').send(toCsv(rows));
  });

  app.post('/api/injectors/compare/report', async (req, reply) => {
    const auth = await requireCapability(db, req, 'reports.export', { action: 'injector.compare_report' });
    const ids = z.object({ ids: z.array(uuid).min(1).max(12) }).parse(req.body).ids;
    const c = await comparison(db, ids);
    const out = await withTransaction(db, async (tx) => {
      const number = await nextRecordNumber(tx, 'CMP');
      const subjectId = (await one<{ id: string }>(tx, 'SELECT gen_random_uuid() AS id'))!.id;
      const issued = await issueRecordEdition(tx, 'INJECTOR_COMPARISON', subjectId, (edition) => ({ ...buildComparisonReport(c, number, config.displayTimeZone), edition }));
      await audit(tx, { actorId: auth.userId, action: 'injector.compare_report', entityType: 'report_snapshot', entityId: issued.snapshotId, summary: `${number}: comparison of ${ids.length} injector(s) issued`, requestId: req.id });
      return { snapshotId: issued.snapshotId, number };
    });
    return reply.code(201).send(out);
  });

  app.get('/api/shipment-evaluations', async (req) => {
    await requireCapability(db, req, 'records.read', { action: 'shipment.list', consequential: false });
    return many(
      db,
      `SELECT e.id, e.number, e.reference, e.conclusion, e.evaluated_at AS "evaluatedAt", u.display_name AS "evaluatedBy",
              (SELECT count(*)::int FROM shipment_evaluation_item i WHERE i.evaluation_id = e.id) AS items
         FROM shipment_evaluation e JOIN app_user u ON u.id = e.evaluated_by ORDER BY e.evaluated_at DESC LIMIT 100`,
    );
  });

  app.get('/api/shipment-evaluations/:id', async (req) => {
    await requireCapability(db, req, 'records.read', { action: 'shipment.read', consequential: false });
    const { id } = req.params as { id: string };
    if (!uuid.safeParse(id).success) throw notFound('Shipment evaluation');
    const e = await one(db, `SELECT e.*, u.display_name AS evaluated_by_name FROM shipment_evaluation e JOIN app_user u ON u.id = e.evaluated_by WHERE e.id = $1`, [id]);
    if (!e) throw notFound('Shipment evaluation');
    const items = await many(
      db,
      `SELECT i.position, i.result, i.basis, j.id AS "injectorId", j.serial_number AS "serialNumber", p.part_number AS "partNumber", t.id AS "testId", t.tested_at AS "testedAt",
              t.machine_verdict AS "machineVerdict", t.pdi_evaluation AS "pdiEvaluation"
         FROM shipment_evaluation_item i JOIN injector j ON j.id = i.injector_id JOIN company_part p ON p.id = j.part_id LEFT JOIN injector_test t ON t.id = i.test_id
        WHERE i.evaluation_id = $1 ORDER BY i.position`,
      [id],
    );
    return { evaluation: e, items, renditions: await renditions(db, 'SHIPMENT_EVALUATION', id) };
  });

  // Frozen evaluation of the latest test of each selected injector; never a material release.
  app.post('/api/shipment-evaluations', async (req, reply) => {
    const auth = await requireCapability(db, req, 'injector.evaluate', { action: 'shipment.evaluate' });
    const body = z.object({ reference: z.string().trim().min(2).max(120), note: z.string().trim().max(2000).nullable().optional(), injectorIds: z.array(uuid).min(1).max(100) }).parse(req.body);
    if (new Set(body.injectorIds).size !== body.injectorIds.length) throw unprocessable('Each injector may appear once');
    const out = await withTransaction(db, async (tx) => {
      if (!(await recheckCapability(tx, auth.userId, 'injector.evaluate'))) throw forbidden();
      const items: Array<{ injectorId: string; testId: string | null; result: string; basis: string }> = [];
      for (const injectorId of body.injectorIds) {
        const latest = await one<{ id: string; machine_verdict: string; pdi_evaluation: string; criteria_label: string | null; tested_at: Date }>(
          tx,
          `SELECT t.id, t.machine_verdict, t.pdi_evaluation, t.tested_at,
                  (SELECT b.title || ' Rev ' || r.revision_label FROM baseline_revision r JOIN technical_baseline b ON b.id = r.baseline_id WHERE r.id = t.criteria_revision_id) AS criteria_label
             FROM injector_test t WHERE t.injector_id = $1 ORDER BY t.tested_at DESC, t.recorded_at DESC LIMIT 1`,
          [injectorId],
        );
        if (!(await one(tx, 'SELECT 1 FROM injector WHERE id = $1', [injectorId]))) throw unprocessable('Unknown injector');
        if (!latest) items.push({ injectorId, testId: null, result: 'NOT_TESTED', basis: 'No bench test recorded' });
        else if (latest.pdi_evaluation === 'PASS' || latest.pdi_evaluation === 'FAIL')
          items.push({ injectorId, testId: latest.id, result: latest.pdi_evaluation, basis: `PDI criteria ${latest.criteria_label}; machine verdict ${latest.machine_verdict.toLowerCase().replace('_', ' ')}` });
        else
          items.push({
            injectorId,
            testId: latest.id,
            result: 'NO_CRITERIA',
            basis: `${latest.pdi_evaluation === 'PARTIAL_CRITERIA' ? 'Released PDI criteria cover only part of the test' : 'No released PDI criteria'}; machine verdict ${latest.machine_verdict.toLowerCase().replace('_', ' ')} (not a PDI verdict)`,
          });
      }
      const conclusion = items.every((i) => i.result === 'PASS') ? 'ALL_PASS' : 'EXCEPTIONS';
      const number = await nextRecordNumber(tx, 'SHP');
      const e = await one<{ id: string }>(tx, 'INSERT INTO shipment_evaluation (number, reference, note, conclusion, evaluated_by) VALUES ($1,$2,$3,$4,$5) RETURNING id', [
        number,
        body.reference,
        body.note ?? null,
        conclusion,
        auth.userId,
      ]);
      for (const [i, item] of items.entries()) {
        await tx.query('INSERT INTO shipment_evaluation_item (evaluation_id, position, injector_id, test_id, result, basis) VALUES ($1,$2,$3,$4,$5,$6)', [e!.id, i + 1, item.injectorId, item.testId, item.result, item.basis]);
      }
      const content = await buildShipmentReport(tx, e!.id, config.displayTimeZone);
      await issueRecordEdition(tx, 'SHIPMENT_EVALUATION', e!.id, (edition) => ({ ...content, edition }));
      await audit(tx, { actorId: auth.userId, action: 'shipment.evaluate', entityType: 'shipment_evaluation', entityId: e!.id, summary: `${number} (${body.reference}): ${items.length} injector(s), ${conclusion.replace('_', ' ').toLowerCase()}`, requestId: req.id });
      return { id: e!.id, number, conclusion };
    });
    return reply.code(201).send(out);
  });

  app.get('/api/injectors/analytics', async (req) => {
    await requireCapability(db, req, 'records.read', { action: 'injector.analytics', consequential: false });
    const q = periodQuery(req.query, config.displayTimeZone);
    return injectorAnalytics(db, q.from, q.to, config.displayTimeZone);
  });

  app.get('/api/exports/injector-tests.csv', async (req, reply) => {
    const auth = await requireCapability(db, req, 'reports.export', { action: 'export.injector_tests' });
    const q = periodQuery(req.query, config.displayTimeZone);
    const rows = await many<Record<string, unknown>>(
      db,
      `SELECT j.serial_number, p.part_number, t.machine_id, t.test_plan, t.tested_at, t.origin, bi.number AS import_number, t.machine_verdict, t.pdi_evaluation,
              x.condition, x.parameter, x.unit, x.value_text, x.machine_verdict AS row_verdict, x.lower_limit, x.upper_limit, x.pdi_evaluation AS row_evaluation
         FROM injector_test t JOIN injector j ON j.id = t.injector_id JOIN company_part p ON p.id = j.part_id JOIN injector_test_result x ON x.test_id = t.id
         LEFT JOIN bench_import bi ON bi.id = t.import_id
        WHERE (t.tested_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date ORDER BY t.tested_at, j.serial_number, x.condition, x.parameter`,
      [q.from, q.to, config.displayTimeZone],
    );
    const header = ['Serial', 'Part', 'Machine', 'Test plan', 'Tested at', 'Origin', 'Import', 'Machine verdict', 'PDI evaluation', 'Condition', 'Parameter', 'Unit', 'Value', 'Row machine verdict', 'Lower', 'Upper', 'Row PDI evaluation'];
    const body = [
      [`# PDI TQMS injector test export; period ${q.from} to ${q.to} (${config.displayTimeZone}); generated ${new Date().toISOString()}; ${METRICS_VERSION}`],
      header,
      ...rows.map((r) => Object.values(r)),
    ];
    await audit(db, { actorId: auth.userId, action: 'export.injector_tests', summary: `Injector tests exported for ${q.from}..${q.to} (${rows.length} rows)`, requestId: req.id });
    return reply.header('Content-Type', 'text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="injector-tests-${q.from}-${q.to}.csv"`).send(toCsv(body));
  });
}

async function assertRetestOf(tx: Queryable, actionId: string, injectorId: string, testedAt: string) {
  const a = await one<{ injector_id: string; performed_at: Date; status: string }>(
    tx,
    'SELECT c.injector_id, a.performed_at, c.status FROM repair_action a JOIN repair_case c ON c.id = a.case_id WHERE a.id = $1',
    [actionId],
  );
  if (!a || a.injector_id !== injectorId) throw unprocessable('The repair action belongs to a different injector');
  if (new Date(testedAt) < a.performed_at) throw unprocessable('A retest must be performed after the repair action');
}

const parseIds = (query: unknown) => {
  const raw = z.object({ ids: z.string().max(12 * 40) }).parse(query).ids;
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (!ids.length || ids.length > 12 || ids.some((i) => !uuid.safeParse(i).success)) throw badRequest('Select between 1 and 12 injectors');
  return ids;
};

export function periodQuery(query: unknown, timeZone: string) {
  const q = z.object({ from: isoDate.optional(), to: isoDate.optional() }).parse(query);
  const to = q.to ?? dayIn(timeZone);
  const from = q.from ?? dayIn(timeZone, new Date(Date.parse(`${to}T12:00:00Z`) - 89 * 86_400_000));
  if (from > to) throw badRequest('The period start must not be after its end');
  return { from, to };
}

export interface Comparison {
  injectors: Array<{ id: string; serialNumber: string; partNumber: string; first: { id: string; testedAt: Date; machineVerdict: string; pdiEvaluation: string } | null; latest: { id: string; testedAt: Date; machineVerdict: string; pdiEvaluation: string; afterRepair: boolean } | null; tests: number }>;
  rows: Array<{ condition: string; parameter: string; unit: string | null; values: Array<{ first: { value: string; evaluation: string } | null; latest: { value: string; evaluation: string } | null }> }>;
}

export async function comparison(db: Queryable, ids: string[]): Promise<Comparison> {
  const injectors = await many<{ id: string; serial_number: string; part_number: string }>(
    db,
    'SELECT i.id, i.serial_number, p.part_number FROM injector i JOIN company_part p ON p.id = i.part_id WHERE i.id = ANY($1::uuid[])',
    [ids],
  );
  if (injectors.length !== ids.length) throw notFound('Injector');
  const tests = await testsFor(db, ids);
  const ordered = ids.map((id) => injectors.find((i) => i.id === id)!);
  // Rows are keyed by unit too: values recorded in different units are never shown as comparable.
  const keyOf = (r: { condition: string; parameter: string; unit: string | null }) => `${r.condition}|${r.parameter}|${r.unit ?? ''}`;
  const rowKeys = new Map<string, { condition: string; parameter: string; unit: string | null }>();
  const picks = ordered.map((inj) => {
    const mine = tests.filter((t) => t.injector_id === inj.id);
    const first = mine[0] ?? null;
    const latest = mine.length > 1 ? mine[mine.length - 1]! : null;
    for (const t of [first, latest]) for (const r of t?.results ?? []) if (!rowKeys.has(keyOf(r))) rowKeys.set(keyOf(r), { condition: r.condition, parameter: r.parameter, unit: r.unit });
    return { inj, first, latest, count: mine.length };
  });
  return {
    injectors: picks.map((p) => ({
      id: p.inj.id,
      serialNumber: p.inj.serial_number,
      partNumber: p.inj.part_number,
      tests: p.count,
      first: p.first ? { id: p.first.id, testedAt: p.first.tested_at, machineVerdict: p.first.machine_verdict, pdiEvaluation: p.first.pdi_evaluation } : null,
      latest: p.latest ? { id: p.latest.id, testedAt: p.latest.tested_at, machineVerdict: p.latest.machine_verdict, pdiEvaluation: p.latest.pdi_evaluation, afterRepair: Boolean(p.latest.repair_action_id) } : null,
    })),
    rows: [...rowKeys.values()]
      .sort((a, b) => a.condition.localeCompare(b.condition) || a.parameter.localeCompare(b.parameter) || (a.unit ?? '').localeCompare(b.unit ?? ''))
      .map((k) => ({
        ...k,
        values: picks.map((p) => {
          const pick = (t: TestRow | null) => {
            const r = t?.results.find((x) => keyOf(x) === keyOf(k));
            return r ? { value: r.value_text, evaluation: r.pdi_evaluation === 'NO_LIMIT' ? (r.machine_verdict ?? 'NO_LIMIT') : r.pdi_evaluation } : null;
          };
          return { first: pick(p.first), latest: pick(p.latest) };
        }),
      })),
  };
}

/** Injector performance with explicit denominators (FR-063, METRICS-INTERIM-1). */
export async function injectorAnalytics(db: Queryable, from: string, to: string, timeZone: string) {
  const inPeriod = `(t.tested_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date`;
  const base = await one<Record<string, number>>(
    db,
    `WITH ranked AS (
       SELECT t.*, row_number() OVER (PARTITION BY t.injector_id ORDER BY t.tested_at, t.recorded_at) AS n FROM injector_test t)
     SELECT count(*)::int AS tests,
            count(DISTINCT t.injector_id)::int AS injectors,
            count(*) FILTER (WHERE n = 1)::int AS first_tests,
            count(*) FILTER (WHERE n = 1 AND machine_verdict = 'PASS')::int AS first_pass_machine,
            count(*) FILTER (WHERE n = 1 AND machine_verdict IN ('PASS', 'FAIL'))::int AS first_reported_machine,
            count(*) FILTER (WHERE n = 1 AND pdi_evaluation = 'PASS')::int AS first_pass_pdi,
            count(*) FILTER (WHERE n = 1 AND pdi_evaluation IN ('PASS', 'FAIL'))::int AS first_evaluated_pdi,
            count(*) FILTER (WHERE n > 1)::int AS retests,
            count(*) FILTER (WHERE repair_action_id IS NOT NULL)::int AS post_repair_tests,
            count(*) FILTER (WHERE repair_action_id IS NOT NULL AND pdi_evaluation = 'PASS')::int AS post_repair_pass_pdi,
            count(*) FILTER (WHERE repair_action_id IS NOT NULL AND pdi_evaluation IN ('PASS', 'FAIL'))::int AS post_repair_evaluated_pdi,
            count(*) FILTER (WHERE repair_action_id IS NOT NULL AND machine_verdict = 'PASS')::int AS post_repair_pass_machine,
            count(*) FILTER (WHERE repair_action_id IS NOT NULL AND machine_verdict IN ('PASS', 'FAIL'))::int AS post_repair_reported_machine
       FROM ranked t WHERE ${inPeriod}`,
    [from, to, timeZone],
  );
  const failureModes = await many(
    db,
    `SELECT x.condition, x.parameter, count(*)::int AS failures,
            count(*) FILTER (WHERE x.pdi_evaluation = 'OUTSIDE')::int AS outside_pdi, count(*) FILTER (WHERE x.machine_verdict = 'FAIL')::int AS machine_fail
       FROM injector_test t JOIN injector_test_result x ON x.test_id = t.id
      WHERE ${inPeriod} AND (x.pdi_evaluation = 'OUTSIDE' OR x.machine_verdict = 'FAIL')
      GROUP BY x.condition, x.parameter ORDER BY failures DESC, x.condition LIMIT 15`,
    [from, to, timeZone],
  );
  const adjustments = await many(
    db,
    `SELECT a.action_type AS "actionType", count(DISTINCT a.id)::int AS actions,
            coalesce((SELECT json_agg(json_build_object('name', m.name, 'count', m.n) ORDER BY m.n DESC) FROM (
               SELECT m.name, count(*)::int AS n FROM repair_measurement m JOIN repair_action a2 ON a2.id = m.action_id
                WHERE a2.action_type = a.action_type AND (a2.performed_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date GROUP BY m.name) m), '[]') AS measurements
       FROM repair_action a WHERE (a.performed_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date GROUP BY a.action_type ORDER BY actions DESC`,
    [from, to, timeZone],
  );
  const weekly = await many(
    db,
    `SELECT to_char(date_trunc('week', t.tested_at AT TIME ZONE $3), 'YYYY-MM-DD') AS week, count(*)::int AS tests
       FROM injector_test t WHERE ${inPeriod} GROUP BY 1 ORDER BY 1`,
    [from, to, timeZone],
  );
  const pct = (n: number, d: number) => (d ? Math.round((1000 * n) / d) / 10 : null);
  const b = base!;
  return {
    period: { from, to, timeZone },
    definitionsVersion: METRICS_VERSION,
    tests: b.tests,
    injectors: b.injectors,
    retests: b.retests,
    firstPassYield: {
      machine: { pass: b.first_pass_machine, of: b.first_reported_machine, percent: pct(b.first_pass_machine!, b.first_reported_machine!) },
      pdi: { pass: b.first_pass_pdi, of: b.first_evaluated_pdi, percent: pct(b.first_pass_pdi!, b.first_evaluated_pdi!) },
      firstTests: b.first_tests,
    },
    postRepairYield: {
      tests: b.post_repair_tests,
      machine: { pass: b.post_repair_pass_machine, of: b.post_repair_reported_machine, percent: pct(b.post_repair_pass_machine!, b.post_repair_reported_machine!) },
      pdi: { pass: b.post_repair_pass_pdi, of: b.post_repair_evaluated_pdi, percent: pct(b.post_repair_pass_pdi!, b.post_repair_evaluated_pdi!) },
    },
    failureModes,
    adjustments,
    weekly,
    definitions: [
      'Period: tests whose bench time falls on the selected dates in the display time zone.',
      'First-pass yield: injectors whose first-ever test is in the period and passed; machine and PDI bases are reported separately, each over the tests that basis could judge.',
      'PDI basis: only tests fully covered by released PDI criteria (PASS/FAIL); tests without complete criteria are excluded from that denominator.',
      'Post-repair yield: tests attributed as retests after a repair action, by the same two bases.',
      'Retests: tests in the period that are not the injector’s first test.',
    ],
  };
}
