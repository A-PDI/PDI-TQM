import { ROLE_BUNDLES } from '../shared/capabilities.js';
import { audit } from './audit.js';
import { hashPassword } from './auth.js';
import { type Db, type DbClient, one, withTransaction } from './db.js';
import { ensureSystemUser } from './reference-data.js';

/**
 * Explicit, idempotent FICTIONAL demo data for local development and isolated staging.
 * Every organization, part, person and number here is invented; limits on the synthetic
 * baselines are illustrations flagged is_synthetic and are not PDI-approved specifications.
 */
export const DEMO_USERS = [
  { key: 'inspector', email: 'jordan.rivera@example.com', name: 'Jordan Rivera', bundles: ['inspector'] },
  { key: 'inspector2', email: 'sam.okafor@example.com', name: 'Sam Okafor', bundles: ['inspector'] },
  { key: 'quality', email: 'casey.morgan@example.com', name: 'Casey Morgan', bundles: ['quality'] },
  { key: 'engineering', email: 'taylor.brooks@example.com', name: 'Taylor Brooks', bundles: ['engineering'] },
  { key: 'purchasing', email: 'morgan.diaz@example.com', name: 'Morgan Diaz', bundles: ['purchasing'] },
  { key: 'manager', email: 'riley.chen@example.com', name: 'Riley Chen', bundles: ['manager', 'inspector'] },
  { key: 'admin', email: 'avery.patel@example.com', name: 'Avery Patel', bundles: ['administrator'] },
] as const;

export type DemoKey = (typeof DEMO_USERS)[number]['key'];

const normalize = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

export async function seedDemo(db: Db, password: string): Promise<{ users: Record<DemoKey, string>; parts: Record<string, string>; sources: Record<string, string> }> {
  const systemId = await ensureSystemUser(db);
  return withTransaction(db, async (tx) => {
    const users = {} as Record<DemoKey, string>;
    const hash = await hashPassword(password);
    for (const u of DEMO_USERS) {
      const row = await one<{ id: string }>(
        tx,
        `INSERT INTO app_user (email, display_name, password_hash, created_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT ((lower(email))) DO UPDATE SET display_name = EXCLUDED.display_name RETURNING id`,
        [u.email, u.name, hash, systemId],
      );
      users[u.key] = row!.id;
      for (const bundle of u.bundles) {
        for (const cap of ROLE_BUNDLES[bundle]!.capabilities) {
          await tx.query(
            `INSERT INTO authority_grant (user_id, capability_code, reason, granted_by) VALUES ($1,$2,'Fictional demo seed',$3)
             ON CONFLICT (user_id, capability_code, scope) WHERE revoked_at IS NULL DO NOTHING`,
            [row!.id, cap, systemId],
          );
        }
      }
    }

    const supplier = async (code: string, legal: string, category: string) =>
      (await one<{ id: string }>(
        tx,
        `INSERT INTO supplier (code, legal_name, category, status, is_synthetic, created_by) VALUES ($1,$2,$3,'ACTIVE',true,$4)
         ON CONFLICT (code) DO UPDATE SET legal_name = EXCLUDED.legal_name RETURNING id`,
        [code, legal, category, systemId],
      ))!.id;
    const site = async (supplierId: string, code: string, name: string, address: string) =>
      (await one<{ id: string }>(
        tx,
        `INSERT INTO supplier_site (supplier_id, code, name, address, country, status, is_synthetic) VALUES ($1,$2,$3,$4,'US','ACTIVE',true)
         ON CONFLICT (supplier_id, code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [supplierId, code, name, address],
      ))!.id;
    const supplierPart = async (supplierId: string, pn: string, description: string) =>
      (await one<{ id: string }>(
        tx,
        `INSERT INTO supplier_part (supplier_id, supplier_part_number, description, normalized) VALUES ($1,$2,$3,$4)
         ON CONFLICT (supplier_id, normalized) DO UPDATE SET description = EXCLUDED.description RETURNING id`,
        [supplierId, pn, description, normalize(pn)],
      ))!.id;

    const nwr = await supplier('NWR', 'Northwind Precision Rings Ltd. (fictional)', 'Piston rings');
    const nwr1 = await site(nwr, 'P1', 'Riverton Plant 1', '100 Example Way, Riverton');
    const nwr2 = await site(nwr, 'P2', 'Lakeside Plant 2', '200 Example Way, Lakeside');
    const bsc = await supplier('BSC', 'Bluestone Castings Co. (fictional)', 'Castings / cylinder heads');
    const bscA = await site(bsc, 'FA', 'Foundry A', '300 Example Road, Millbrook');
    const mbi = await supplier('MBI', 'Meridian Bearings Inc. (fictional)', 'Bearings');
    const mbiM = await site(mbi, 'MAIN', 'Main plant', '400 Example Avenue, Fairview');

    const partsSpec: Array<[string, string, string, string, string[]]> = [
      ['TQ-PST-1001', 'Piston, two-piece steel crown', 'Pistons', 'PDI-IQI-001', ['OE-PST-55-1001']],
      ['TQ-LNR-2002', 'Cylinder liner, wet type', 'Liners', 'PDI-IQI-002', ['OE-LNR-55-2002']],
      ['TQ-PRK-3003', 'Piston ring kit, 3-ring', 'Rings', 'PDI-IQI-004', ['OE-PRK-55-3003', 'LEG-RK-3003']],
      ['TQ-CYH-4004', 'Cylinder head, 6-cylinder', 'Cylinder heads', 'PDI-IQI-005', ['OE-CYH-55-4004']],
      ['TQ-TRB-5005', 'Turbocharger, VGT', 'Turbochargers', 'PDI-IQI-011', ['OE-TRB-55-5005']],
      ['TQ-CRK-6006', 'Crankshaft, forged', 'Crankshafts', 'PDI-IQI-014', ['OE-CRK-55-6006']],
      ['TQ-WPM-7007', 'Water pump assembly', 'Cooling', 'PDI-IQI-024', ['OE-WPM-55-7007']],
      ['TQ-MBR-8008', 'Main bearing shell half, std', 'Bearings', 'PDI-IQI-027', ['OE-MBR-55-8008']],
      ['TQ-INJ-9009', 'Fuel injector, common rail', 'Injectors', 'PDI-IQI-012', ['OE-INJ-55-9009']],
    ];
    const parts: Record<string, string> = {};
    for (const [pn, desc, family, form, aliases] of partsSpec) {
      const row = await one<{ id: string }>(
        tx,
        `INSERT INTO company_part (part_number, description, family, default_form_number, is_synthetic, created_by) VALUES ($1,$2,$3,$4,true,$5)
         ON CONFLICT ((upper(part_number))) DO UPDATE SET description = EXCLUDED.description RETURNING id`,
        [pn, desc, family, form, systemId],
      );
      parts[pn] = row!.id;
      for (const alias of aliases) {
        await tx.query(`INSERT INTO part_alias (part_id, alias, normalized) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [row!.id, alias, normalize(alias)]);
      }
    }

    // Supplier-owned (Path B) synthetic baseline for the ring kit, released by Engineering.
    const ringBaseline = await releasedBaseline(tx, parts['TQ-PRK-3003']!, 'NWR catalog spec NR-3003 (synthetic)', 'SUPPLIER', 'S1', users.engineering, [
      ['free_end_gap', 'Free End Gap (relaxed)', 'dimensional:free_end_gap_relaxed', 'mm', '9.80', '10.40'],
      ['installed_end_gap', 'Installed End Gap', 'dimensional:installed_end_gap', 'mm', '0.40', '0.65'],
      ['axial_width', 'Axial Width (ring height)', 'dimensional:axial_width_ring_height', 'mm', '2.970', '2.990'],
      ['radial_wall', 'Radial Wall Thickness', 'dimensional:radial_wall_thickness', 'mm', '4.10', '4.30'],
    ]);
    // PDI-owned (Path A) synthetic baseline for the cylinder head.
    const headBaseline = await releasedBaseline(tx, parts['TQ-CYH-4004']!, 'PDI drawing TQ-CYH-4004 (synthetic)', 'PDI', 'A', users.engineering, [
      ['groove_depth', 'Fire ring groove depth', 'groove_specs:groove_depth', 'in', '0.029', '0.031'],
      ['wire_protrusion', 'Fire ring wire protrusion', 'groove_specs:wire_protrusion', 'in', '0.008', '0.010'],
      ['valve_recession_intake', 'Valve recession — intake', 'valve_recession:intake', 'in', '0.030', '0.050'],
      ['valve_recession_exhaust', 'Valve recession — exhaust', 'valve_recession:exhaust', 'in', '0.030', '0.050'],
      ['head_height', 'Cylinder Head Height', 'general_measurements:cylinder_head_height', 'in', '4.795', '4.805'],
    ]);

    // Synthetic PDI bench criteria for the injector (FUNCTIONAL, referenced as injector:<condition>__<parameter>).
    await releasedBaseline(tx, parts['TQ-INJ-9009']!, 'PDI injector test criteria TQ-INJ-9009 (synthetic)', 'PDI', 'A', users.engineering, [
      ['rated_delivery', 'Rated condition — delivery', 'injector:rated__delivery', 'mm3/stroke', '95.0', '105.0', 'FUNCTIONAL'],
      ['idle_delivery', 'Idle condition — delivery', 'injector:idle__delivery', 'mm3/stroke', '8.0', '12.0', 'FUNCTIONAL'],
      ['rated_return', 'Rated condition — return flow', 'injector:rated__return_flow', 'mm3/stroke', '10.0', '30.0', 'FUNCTIONAL'],
    ]);

    const sources: Record<string, string> = {};
    const source = async (key: string, partId: string, supplierId: string, siteId: string, spn: string, pathway: 'A' | 'B' | 'C', baselineRev: string | null) => {
      const spId = await supplierPart(supplierId, spn, `Supplier item ${spn}`);
      const existing = await one<{ id: string }>(
        tx,
        `SELECT id FROM source WHERE part_id = $1 AND supplier_id = $2 AND site_id = $3 AND supplier_part_id = $4 AND configuration = 'STANDARD'`,
        [partId, supplierId, siteId, spId],
      );
      const id =
        existing?.id ??
        (await one<{ id: string }>(
          tx,
          `INSERT INTO source (part_id, supplier_id, site_id, supplier_part_id, baseline_revision_id, pathway, is_synthetic, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,true,$7) RETURNING id`,
          [partId, supplierId, siteId, spId, baselineRev, pathway, systemId],
        ))!.id;
      sources[key] = id;
    };
    await source('ringNwr1', parts['TQ-PRK-3003']!, nwr, nwr1, 'NR-3003', 'B', ringBaseline);
    await source('ringNwr2', parts['TQ-PRK-3003']!, nwr, nwr2, 'NR-3003', 'B', ringBaseline);
    await source('headBsc', parts['TQ-CYH-4004']!, bsc, bscA, 'BC-6H-118', 'A', headBaseline);
    await source('bearingMbi', parts['TQ-MBR-8008']!, mbi, mbiM, 'MB-8008-STD', 'B', null);

    await tx.query(
      `INSERT INTO system_setting (key, value) VALUES ('demo_seed', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify({ seededAt: new Date().toISOString(), fictional: true })],
    );
    await audit(tx, { actorId: systemId, action: 'demo.seed', summary: 'Fictional demo data seeded (idempotent)' });
    return { users, parts, sources };
  });
}

async function releasedBaseline(
  tx: DbClient,
  partId: string,
  title: string,
  ownership: 'PDI' | 'SUPPLIER',
  label: string,
  releasedBy: string,
  chars: Array<[string, string, string, string, string, string, ('DIMENSIONAL' | 'FUNCTIONAL')?]>,
): Promise<string> {
  const existing = await one<{ id: string }>(
    tx,
    `SELECT r.id FROM baseline_revision r JOIN technical_baseline b ON b.id = r.baseline_id WHERE b.part_id = $1 AND b.title = $2 AND r.revision_label = $3`,
    [partId, title, label],
  );
  if (existing) return existing.id;
  const baseline = await one<{ id: string }>(tx, `INSERT INTO technical_baseline (part_id, title, ownership) VALUES ($1,$2,$3) RETURNING id`, [partId, title, ownership]);
  const rev = await one<{ id: string }>(
    tx,
    `INSERT INTO baseline_revision (baseline_id, revision_label, is_synthetic, notes, authored_by)
     VALUES ($1,$2,true,'SYNTHETIC staging illustration — not a PDI-approved specification',$3) RETURNING id`,
    [baseline!.id, label, releasedBy],
  );
  for (const [key, name, ref, unit, lower, upper, type = 'DIMENSIONAL'] of chars) {
    await tx.query(
      `INSERT INTO baseline_characteristic (revision_id, char_key, name, char_type, form_row_ref, unit, lower_limit, upper_limit) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [rev!.id, key, name, type, ref, unit, lower, upper],
    );
  }
  await tx.query(`UPDATE baseline_revision SET status = 'RELEASED', released_by = $2, released_at = now(), effective_from = current_date WHERE id = $1`, [
    rev!.id,
    releasedBy,
  ]);
  return rev!.id;
}
