import type pg from 'pg';

/**
 * Bulk, fictional history for performance checks: roughly three years at ~40 receiving inspections
 * a week, with items, answers, measurements, photo records, concerns/NCRs, injector tests and audit
 * history. Rows go through the same lifecycle the triggers enforce (entries are written while an
 * inspection is a draft, then it is completed). Photo records carry metadata only (no bytes).
 */
export interface VolumeOptions {
  inspections: number;
  unitsPerInspection: number;
  photosPerInspection: number;
  ncrs: number;
  injectors: number;
  testsPerInjector: number;
  auditEvents: number;
}

export const DEFAULT_VOLUME: VolumeOptions = {
  inspections: 6000,
  unitsPerInspection: 2,
  photosPerInspection: 2.5,
  ncrs: 600,
  injectors: 1500,
  testsPerInjector: 3,
  auditEvents: 100_000,
};

export async function seedVolume(db: pg.Pool, o: VolumeOptions = DEFAULT_VOLUME): Promise<Record<string, number>> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const t = (
      await client.query<{ form_revision_id: string; form_snapshot: unknown; part_id: string; source_id: string; supplier_id: string; site_id: string; user_id: string }>(
        `SELECT fr.id AS form_revision_id, fr.definition AS form_snapshot, p.id AS part_id, s.id AS source_id, s.supplier_id, s.site_id,
                (SELECT id FROM app_user WHERE email = 'jordan.rivera@example.com') AS user_id
           FROM form_revision fr JOIN inspection_form f ON f.id = fr.form_id
           JOIN company_part p ON p.part_number = 'TQ-PRK-3003' JOIN source s ON s.part_id = p.id
          WHERE f.form_number = 'PDI-IQI-004' AND fr.status = 'RELEASED' LIMIT 1`,
      )
    ).rows[0]!;
    const quality = (await client.query<{ id: string }>(`SELECT id FROM app_user WHERE email = 'casey.morgan@example.com'`)).rows[0]!.id;
    const days = 3 * 365;

    // Inspections as drafts, spread over three years.
    await client.query(
      `INSERT INTO inspection (number, form_revision_id, form_snapshot, form_snapshot_sha256, part_id, part_number, part_description, source_id, supplier_id, site_id,
                               source_state_at_start, po_number, date_received, lot_number, unit_count, inspector_id, created_by, created_at)
       SELECT 'VOL-' || lpad(g::text, 6, '0'), $1, $2, 'volume', $3, 'TQ-PRK-3003', 'Piston ring kit, 3-ring', $4, $5, $6, 'NOT_APPROVED',
              'PO-V' || (g % 900), (now() - make_interval(days => (g * $7 / $8)))::date, 'LOT-V' || g, $9, $10, $10, now() - make_interval(days => (g * $7 / $8))
         FROM generate_series(1, $8) g`,
      [t.form_revision_id, JSON.stringify(t.form_snapshot), t.part_id, t.source_id, t.supplier_id, t.site_id, days, o.inspections, o.unitsPerInspection, t.user_id],
    );
    await client.query(
      `INSERT INTO inspection_unit (inspection_id, unit_index, serial_number)
       SELECT i.id, u, 'VSN-' || substr(i.number, 5) || '-' || u FROM inspection i, generate_series(1, $1) u WHERE i.number LIKE 'VOL-%'`,
      [o.unitsPerInspection],
    );
    // Shared section A once per inspection; section B per unit (one in twenty units has a failed coating row).
    await client.query(
      `INSERT INTO inspection_response (inspection_id, unit_index, section_key, row_key, status, note, updated_by)
       SELECT i.id, 0, 'A', r, 'P', NULL, $1 FROM inspection i,
              unnest(ARRAY['outer_carton_condition','box_package_label','part_marking','quantity_verification','corrosion_contamination_protection']) r
        WHERE i.number LIKE 'VOL-%'`,
      [t.user_id],
    );
    await client.query(
      `INSERT INTO inspection_response (inspection_id, unit_index, section_key, row_key, status, note, updated_by)
       SELECT i.id, u, 'B', r,
              CASE WHEN r = 'running_face_coating' AND (hashtext(i.id::text) + u) % 20 = 0 THEN 'F' ELSE 'P' END,
              CASE WHEN r = 'running_face_coating' AND (hashtext(i.id::text) + u) % 20 = 0 THEN 'Uncoated (fictional volume data)' END, $1
         FROM inspection i, generate_series(1, $2) u, unnest(ARRAY['running_face_coating','gap_end_faces','orientation_mark','ring_body']) r
        WHERE i.number LIKE 'VOL-%'`,
      [t.user_id, o.unitsPerInspection],
    );
    await client.query(
      `INSERT INTO inspection_measurement (inspection_id, unit_index, section_key, row_key, reading_key, value_text, value_numeric, decimals, unit, updated_by)
       SELECT i.id, u, 'C', r, 'a1', v::text, v, 2, 'mm', $1
         FROM inspection i, generate_series(1, $2) u,
              (VALUES ('free_end_gap_relaxed', 10.05), ('installed_end_gap', 0.52), ('axial_width_ring_height', 2.98), ('radial_wall_thickness', 4.20)) m(r, v)
        WHERE i.number LIKE 'VOL-%'`,
      [t.user_id, o.unitsPerInspection],
    );
    const photos = Math.round(o.inspections * o.photosPerInspection);
    await client.query(
      `WITH f AS (
         INSERT INTO file_object (kind, status, sha256, byte_size, mime_type, original_name, storage_key, width, height, uploaded_by, uploaded_at)
         SELECT 'PHOTO', 'AVAILABLE', md5(g::text) || md5((g + 1)::text), 350000 + g % 90000, 'image/jpeg', 'photo-' || g || '.jpg', gen_random_uuid()::text, 1600, 1200, $1,
                now() - make_interval(days => (g * $2 / $3))
           FROM generate_series(1, $3) g RETURNING id, original_name)
       INSERT INTO evidence_link (file_id, entity_type, entity_id, inspection_id, unit_index, section_key, row_key, linked_by)
       SELECT f.id, 'INSPECTION', i.id, i.id, 1, 'B', 'running_face_coating', $1
         FROM f JOIN inspection i ON i.number = 'VOL-' || lpad((((substring(f.original_name FROM '[0-9]+')::int - 1) % $4) + 1)::text, 6, '0')`,
      [t.user_id, days, photos, o.inspections],
    );
    // Complete them: an item with a failed row makes the inspection FAIL.
    await client.query(
      `UPDATE inspection i SET status = 'COMPLETED', completed_by = $1, completed_at = i.created_at + interval '2 hours', updated_at = i.created_at + interval '2 hours',
              outcome = CASE WHEN EXISTS (SELECT 1 FROM inspection_response r WHERE r.inspection_id = i.id AND r.status = 'F') THEN 'FAIL' ELSE 'PASS' END
        WHERE i.number LIKE 'VOL-%'`,
      [t.user_id],
    );
    // Concerns confirmed as NCRs for a share of the failed inspections.
    await client.query(
      `WITH failed AS (
         SELECT i.id, i.number, i.lot_number, i.created_at, row_number() OVER (ORDER BY i.created_at) AS n FROM inspection i
          WHERE i.number LIKE 'VOL-%' AND i.outcome = 'FAIL' LIMIT $1),
       e AS (
         INSERT INTO quality_event (number, title, description, origin_type, inspection_id, unit_index, section_key, row_key, characteristic, part_id, supplier_id, site_id,
                                    source_id, lot_number, reported_by, reported_at, owner_id, severity, status, triaged_by, triaged_at)
         SELECT 'QE-V' || lpad(n::text, 6, '0'), 'Uncoated running face', 'Fictional volume concern', 'INSPECTION', id, 1, 'B', 'running_face_coating', 'Running Face Coating',
                $2, $3, $4, $5, lot_number, $6, created_at, $7, 'MEDIUM', 'CONFIRMED_NCR', $7, created_at
           FROM failed RETURNING id, number, lot_number, reported_at, inspection_id)
       INSERT INTO ncr (number, quality_event_id, title, defect_description, failure_mode, characteristic, part_id, supplier_id, site_id, source_id, inspection_id, lot_number,
                        severity, owner_id, confirmed_by, confirmed_at, confirmation_rationale, status, closed_by, closed_at, closure_note)
       SELECT 'NCR-V' || substr(e.number, 5), e.id, 'Uncoated running face', 'Fictional volume NCR', 'Missing running-face coating', 'Running Face Coating', $2, $3, $4, $5,
              e.inspection_id, e.lot_number, 'MEDIUM', $7, $7, e.reported_at, 'Fictional volume data',
              CASE WHEN e.reported_at < now() - interval '60 days' THEN 'CLOSED' ELSE 'OPEN' END,
              CASE WHEN e.reported_at < now() - interval '60 days' THEN $7 END,
              CASE WHEN e.reported_at < now() - interval '60 days' THEN e.reported_at + interval '20 days' END,
              CASE WHEN e.reported_at < now() - interval '60 days' THEN 'Closed (fictional volume data)' END
         FROM e`,
      [o.ncrs, t.part_id, t.supplier_id, t.site_id, t.source_id, t.user_id, quality],
    );
    // Injectors with bench tests and results.
    const inj = (await client.query<{ id: string }>(`SELECT id FROM company_part WHERE part_number = 'TQ-INJ-9009'`)).rows[0]!.id;
    await client.query(
      `INSERT INTO injector (part_id, serial_number, normalized_serial, is_synthetic, created_by, created_at)
       SELECT $1, 'VINJ-' || lpad(g::text, 6, '0'), 'VINJ' || lpad(g::text, 6, '0'), true, $2, now() - make_interval(days => (g * $3 / $4))
         FROM generate_series(1, $4) g`,
      [inj, t.user_id, days, o.injectors],
    );
    await client.query(
      `WITH t AS (
         INSERT INTO injector_test (injector_id, source_key, content_sha256, origin, machine_id, test_plan, tested_at, operator, machine_verdict, pdi_evaluation, raw, recorded_by)
         SELECT j.id, 'manual:VOL|' || j.normalized_serial || '|' || k, md5(j.id::text || k), 'MANUAL', 'BENCH-VOL-1', 'SYN-PLAN-CR-1',
                j.created_at + make_interval(hours => k * 3), 'Op. Volume',
                CASE WHEN (hashtext(j.id::text) + k) % 9 = 0 THEN 'FAIL' ELSE 'PASS' END,
                CASE WHEN (hashtext(j.id::text) + k) % 9 = 0 THEN 'FAIL' ELSE 'PASS' END, '[]', $1
           FROM injector j, generate_series(1, $2) k WHERE j.serial_number LIKE 'VINJ-%' RETURNING id, pdi_evaluation)
       INSERT INTO injector_test_result (test_id, condition, parameter, unit, value_text, value, machine_verdict, lower_limit, upper_limit, pdi_evaluation)
       SELECT t.id, c, p, 'mm3/stroke', v::text, v, CASE WHEN t.pdi_evaluation = 'FAIL' AND c = 'Rated' AND p = 'Delivery' THEN 'FAIL' ELSE 'PASS' END, lo, hi,
              CASE WHEN t.pdi_evaluation = 'FAIL' AND c = 'Rated' AND p = 'Delivery' THEN 'OUTSIDE' ELSE 'WITHIN' END
         FROM t, (VALUES ('Rated', 'Delivery', 100.4, 95.0, 105.0), ('Idle', 'Delivery', 10.1, 8.0, 12.0), ('Rated', 'Return flow', 18.0, 10.0, 30.0)) r(c, p, v, lo, hi)`,
      [t.user_id, o.testsPerInjector],
    );
    await client.query(
      `INSERT INTO audit_event (occurred_at, actor_id, action, outcome, entity_type, entity_id, summary)
       SELECT now() - make_interval(mins => g), $1, 'inspection.edit', 'SUCCESS', 'inspection', i.id::text, 'Volume history entry (fictional)'
         FROM generate_series(1, $2) g JOIN LATERAL (SELECT id FROM inspection WHERE number = 'VOL-' || lpad(((g % $3) + 1)::text, 6, '0')) i ON true`,
      [t.user_id, o.auditEvents, o.inspections],
    );
    await client.query('COMMIT');
    await client.query('ANALYZE');
    const counts: Record<string, number> = {};
    for (const table of ['inspection', 'inspection_unit', 'inspection_response', 'inspection_measurement', 'file_object', 'evidence_link', 'ncr', 'injector_test', 'injector_test_result', 'audit_event']) {
      counts[table] = (await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]!.n;
    }
    return counts;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
