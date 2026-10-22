import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { dayIn } from '../../shared/quality.js';
import { audit } from '../audit.js';
import { requireCapability } from '../auth.js';
import { many, one } from '../db.js';
import { conflict, unprocessable } from '../errors.js';
import { createInspection } from '../inspections/service.js';
import { isoDate, uuid } from '../quality/common.js';
import type { Services } from '../services.js';
import { benchStatus, syncBench } from './carbonzapp.js';

const MAX_SELECTION = 100;
const OUTCOMES = ['PASS', 'FAIL', 'DNF', 'UNKNOWN'] as const;

/** CarbonZapp bench results: status, Sync now, the results list and starting an inspection from a selection. */
export function registerBenchRoutes(app: FastifyInstance, svc: Services) {
  const { db, config } = svc;

  app.get('/api/injectors/bench', async (req) => {
    await requireCapability(db, req, 'injector.bench_sync', { action: 'injector.bench_status', consequential: false });
    return benchStatus(db);
  });

  app.post('/api/injectors/bench/sync', async (req) => {
    const auth = await requireCapability(db, req, 'injector.bench_sync', { action: 'injector.bench_sync' });
    return syncBench(svc, auth, req.id);
  });

  app.get('/api/injectors/bench/tests', async (req) => {
    await requireCapability(db, req, 'records.read', { action: 'injector.bench_tests', consequential: false });
    const q = z
      .object({
        q: z.string().trim().max(80).optional(),
        outcome: z.enum(OUTCOMES).optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
        available: z.enum(['true', 'false']).optional(),
      })
      .parse(req.query);
    const term = q.q ? `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
    return many(
      db,
      `SELECT t.id, t.tested_at AS "testedAt", t.bench_outcome AS outcome, t.pdi_evaluation AS "pdiEvaluation", t.machine_id AS machine, t.test_plan AS "testPlan",
              t.bench_report_id AS "reportId", t.bench_slot AS slot, j.id AS "injectorId", j.serial_number AS serial, p.id AS "partId", p.part_number AS "partNumber",
              bi.number AS "importNumber",
              (SELECT count(*)::int FROM injector_test_result r WHERE r.test_id = t.id) AS measurements,
              (SELECT count(*)::int FROM injector_test_result r WHERE r.test_id = t.id AND r.bench_outcome = 'FAIL') AS failed,
              (SELECT json_build_object('id', i.id, 'number', i.number, 'status', i.status)
                 FROM inspection_bench_test l JOIN inspection i ON i.id = l.inspection_id
                WHERE l.test_id = t.id AND i.status <> 'VOID' ORDER BY l.linked_at DESC LIMIT 1) AS inspection
         FROM injector_test t JOIN injector j ON j.id = t.injector_id JOIN company_part p ON p.id = j.part_id
         LEFT JOIN bench_import bi ON bi.id = t.import_id
        WHERE t.bench_outcome IS NOT NULL
          AND ($1::text IS NULL OR j.serial_number ILIKE $1 OR p.part_number ILIKE $1)
          AND ($2::text IS NULL OR t.bench_outcome = $2)
          AND ($3::date IS NULL OR t.tested_at >= ($3::date)::timestamp AT TIME ZONE $6)
          AND ($4::date IS NULL OR t.tested_at < ($4::date + 1)::timestamp AT TIME ZONE $6)
          AND ($5::boolean IS NOT TRUE OR NOT EXISTS (SELECT 1 FROM inspection_bench_test l JOIN inspection i ON i.id = l.inspection_id
                                                       WHERE l.test_id = t.id AND i.status <> 'VOID'))
        ORDER BY t.tested_at DESC, t.bench_report_id, t.bench_slot, j.serial_number LIMIT 500`,
      [term, q.outcome ?? null, q.from ?? null, q.to ?? null, q.available === 'true', config.displayTimeZone],
    );
  });

  /**
   * Starts one incoming inspection (the part's form, normally PDI-IQI-012) with one item per selected
   * bench result: serial numbers filled in and the bench results carried read-only. Receiving and
   * visual checks are still performed by the inspector.
   */
  app.post('/api/injectors/bench/inspections', async (req, reply) => {
    await requireCapability(db, req, 'injector.bench_sync', { action: 'injector.bench_inspection' });
    const body = z
      .object({
        testIds: z.array(uuid).min(1).max(MAX_SELECTION),
        poNumber: z.string().trim().max(60).nullable().optional(),
        dateReceived: isoDate.optional(),
        inspectorId: uuid.nullable().optional(),
      })
      .parse(req.body);
    if (new Set(body.testIds).size !== body.testIds.length) throw unprocessable('A bench result is selected twice');
    const tests = await many<{ id: string; injector_id: string; serial: string; part_id: string; part_number: string; tested_at: Date; slot: number | null; outcome: string | null }>(
      db,
      `SELECT t.id, t.injector_id, j.serial_number AS serial, j.part_id, p.part_number, t.tested_at, t.bench_slot AS slot, t.bench_outcome AS outcome
         FROM injector_test t JOIN injector j ON j.id = t.injector_id JOIN company_part p ON p.id = j.part_id
        WHERE t.id = ANY($1::uuid[]) ORDER BY t.tested_at, t.bench_slot, j.serial_number`,
      [body.testIds],
    );
    if (tests.length !== body.testIds.length) throw unprocessable('Some selected bench results were not found; refresh the list and try again');
    if (tests.some((t) => !t.outcome)) throw unprocessable('Only CarbonZapp bench results can start an inspection here');
    const parts = [...new Set(tests.map((t) => t.part_number))];
    if (parts.length > 1) throw unprocessable(`Select results for one part number at a time (selected: ${parts.join(', ')})`);
    const twice = tests.find((t, i) => tests.findIndex((x) => x.injector_id === t.injector_id) !== i);
    if (twice) throw unprocessable(`SN ${twice.serial} is selected more than once; choose one of its bench results`);
    const part = await one<{ default_form_number: string | null }>(db, 'SELECT default_form_number FROM company_part WHERE id = $1', [tests[0]!.part_id]);
    const formNumber = part?.default_form_number ?? 'PDI-IQI-012';
    const form = await one<{ id: string }>(
      db,
      `SELECT r.id FROM form_revision r JOIN inspection_form f ON f.id = r.form_id WHERE f.form_number = $1 AND r.status = 'RELEASED'`,
      [formNumber],
    );
    if (!form) throw unprocessable(`${formNumber} has no released revision to start an inspection with`);
    const latestDay = dayIn(config.displayTimeZone, tests[tests.length - 1]!.tested_at);

    const created = await createInspection(db, req, {
      partId: tests[0]!.part_id,
      formRevisionId: form.id,
      unitCount: tests.length,
      poNumber: body.poNumber ?? null,
      dateReceived: body.dateReceived ?? latestDay,
      inspectorId: body.inspectorId ?? null,
      creatorCapability: 'injector.bench_sync',
      afterCreate: async (tx, c) => {
        // Locked so two people cannot put the same bench result into two inspections.
        await tx.query('SELECT id FROM injector_test WHERE id = ANY($1::uuid[]) FOR UPDATE', [body.testIds]);
        const used = await one<{ serial: string; number: string }>(
          tx,
          `SELECT j.serial_number AS serial, i.number FROM inspection_bench_test l JOIN inspection i ON i.id = l.inspection_id
             JOIN injector_test t ON t.id = l.test_id JOIN injector j ON j.id = t.injector_id
            WHERE l.test_id = ANY($1::uuid[]) AND i.status <> 'VOID' AND i.id <> $2 LIMIT 1`,
          [body.testIds, c.id],
        );
        if (used) throw conflict(`The bench result of SN ${used.serial} is already in inspection ${used.number}`);
        for (const [i, t] of tests.entries()) {
          await tx.query('UPDATE inspection_unit SET serial_number = $3 WHERE inspection_id = $1 AND unit_index = $2', [c.id, i + 1, t.serial]);
          await tx.query('INSERT INTO inspection_bench_test (inspection_id, unit_index, test_id, linked_by) VALUES ($1,$2,$3,$4)', [c.id, i + 1, t.id, c.userId]);
        }
        await audit(tx, {
          actorId: c.userId,
          action: 'injector.bench_inspection',
          entityType: 'inspection',
          entityId: c.id,
          summary: `${c.number} started from ${tests.length} CarbonZapp bench result(s): ${tests.map((t) => `SN ${t.serial} (${t.outcome})`).join(', ')}`.slice(0, 1000),
          after: { testIds: tests.map((t) => t.id) },
          requestId: req.id,
        });
      },
    });
    return reply.code(201).send(created);
  });
}
