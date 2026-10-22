import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CAPABILITIES } from '../shared/capabilities.js';
import { type FormDefinition, canonicalJson, formDefinitionSchema } from '../shared/forms.js';
import { audit } from './audit.js';
import { type Db, withTransaction } from './db.js';

export const SYSTEM_USER_EMAIL = 'system@tqms.invalid';

/** Business decisions PDI must sign (Drawing E2 + spec POLICY OPEN items) with the interim behavior. */
export const POLICY_REGISTER: Array<{ code: string; area: string; title: string; interim: string }> = [
  { code: 'POL-01', area: 'Authority', title: 'Formal authority grants for engineering release, site qualification, source approval, concessions, disposition, SCAR effectiveness; independence exceptions', interim: 'Capabilities are granted per person. Independence: inspection reviewer ≠ inspector; baseline and form releaser ≠ author/submitter; qualification decider ≠ assessor; FAI decider ≠ recorder; source approver ≠ sourcing request owner; NCR confirmer ≠ concern reporter; concession approver ≠ requester; material releaser ≠ disposition decider; SCAR effectiveness verifier ≠ implementation verifier; change approver ≠ requester. No exception path exists.' },
  { code: 'POL-02', area: 'Technical', title: 'Product acceptance ranges, units, methods, dimensional/vacuum limits, CTQ classification, revision/effectivity per part/source', interim: 'Readings are recorded; without a released baseline limit no PASS is calculated and Engineering review is required.' },
  { code: 'POL-03', area: 'Receiving', title: 'Receipt sampling plan/AQL, lot handling, unit traceability, use-as-is, release when baseline missing, previously sourced unqualified catalog parts', interim: 'Sample size is entered by the inspector; no sampling plan is generated; inspection completion never releases material.' },
  { code: 'POL-04', area: 'Risk', title: 'Risk classification, site assessment triggers, FAI/PPAP evidence, SCAR issue/escalation, suspension and reinstatement criteria, response due dates', interim: 'RISK-INTERIM-1 (seven 1–3 factors; ≥15 or critical+severe = HIGH, ≥10 MEDIUM) and CHECKLIST-INTERIM-1 (pathway/risk document checklist; PPAP elements only at HIGH). FAI required for paths A and C and for B at MEDIUM/HIGH risk. SCAR effectiveness needs a completed, non-failing inspection of the supplier received after implementation was verified, or a documented alternative with evidence. REMINDER-INTERIM-1: overdue commitments get a daily in-app reminder; HIGH escalates to management at once, MEDIUM after 7 days, LOW is reminded only.' },
  { code: 'POL-05', area: 'Material', title: 'Concession quantities/expiry, containment, partial release, physical verification roles, NCR/SCAR impact on unrelated sources', interim: 'DISPOSITION-INTERIM-1: every confirmed NCR needs authorized containment, physical segregation verification and a disposition per quantity. Use-as-is always requires a current approved concession for the same part and lot within its quantity; rework/repair is verified only by a PDI reinspection of the same lot showing the failed characteristic conforms; release is a separate action by someone other than the disposition decider. TQM holds do not move ERP stock.' },
  { code: 'POL-06', area: 'Change', title: 'Change effective dates, old lots and field returns, supplier process-change authorization and requalification', interim: 'A change is decided after an impact assessment; it becomes effective only after its new baseline revision is released, with an effective date and optional first lot. Implementation is verified by a completed inspection of an affected source on or after the effective date. Earlier lots keep the revision recorded on their inspections.' },
  { code: 'POL-07', area: 'Records', title: 'Approval/report signature format, brand master artwork/fonts/colors, document numbering, record type catalogue, redaction, retention and legal hold', interim: 'Reports use the reference logo extract and suggested navy palette pending approved artwork; numbering IR-/QE-/NCR-/DEV-/SCAR-/COM-/CHG-YYYY-NNNNN; controlled record PDFs are issued as numbered editions; nothing is destructively deleted.' },
  { code: 'POL-08', area: 'Injector', title: 'Injector bench formats, authoritative pass/fail rules, measurements/units, retest grouping, export destinations, protocol/SSO integration', interim: 'Interim TQMS-BENCH-CSV-1 file adapter for synthetic data only (no CarbonZapp protocol, live bench or shared-spreadsheet writes). Imports are idempotent per machine/serial/time/sequence; a repeated key never overwrites the original. The machine verdict is shown as reported; a PDI verdict is calculated only against released FUNCTIONAL characteristics referenced as injector:<condition>__<parameter>. Exports require reports.export; no external destinations.' },
  { code: 'POL-09', area: 'Operations', title: 'Production budget and Render sizing, monitoring owner, RPO/RTO, off-site backup location, data migration, onboarding/MFA, launch gate', interim: 'Local and isolated staging only; no paid resources provisioned.' },
  { code: 'POL-10', area: 'Data', title: 'Whether historical sample reports may be de-identified/imported (including photographs)', interim: 'No historical report data or photographs are imported; all fixtures are fabricated.' },
  { code: 'POL-11', area: 'Inspection', title: 'Authority, timing and sign-off for Accepted items; status of partial records; review before stock release (FR-050)', interim: 'Accepted results require review by a holder of inspection.review_accepted who is not the inspector.' },
  { code: 'POL-12', area: 'Forms', title: 'Validation of Appendix A form texts and revisions by an appointed PDI owner before production release', interim: 'Catalogue loaded from Appendix A v1.0 and marked as pending PDI owner validation.' },
  { code: 'POL-13', area: 'Supplier', title: 'Propagation of supplier/site suspension to existing approvals and receipts (FR-022)', interim: 'Conservative: a suspension shows every affected approved source as SUSPENDED (approval records unchanged), blocks new approvals, and flags new inspections; reinstatement is a separate authorized decision.' },
  { code: 'POL-14', area: 'Quality', title: 'Whether an NCR may close with an open SCAR; which NCR statuses block approval (FR-075)', interim: 'NCR-BLOCK-INTERIM-1: an NCR may close after its material is verified and resolved while a linked SCAR stays open and visible. Open HIGH/CRITICAL NCRs and untriaged concerns block source approval; other open NCRs and active concessions allow only a conditional approval; an expired concession on an open NCR blocks.' },
  { code: 'POL-15', area: 'Records', title: 'Retention schedule per record family (FR-095)', interim: 'Retain everything; no purge jobs exist.' },
  { code: 'POL-16', area: 'Operations', title: 'Display time zone for dates on screens and reports', interim: 'DISPLAY_TIMEZONE environment setting (defaults to UTC).' },
];

interface CatalogueFile {
  source: { file: string; sha256: string; release: string };
  entries: Array<{
    formNumber: string;
    component: string;
    revisionLabel: string | null;
    sequence: number;
    availability: 'ACTIVE' | 'HISTORICAL';
    definition: FormDefinition;
  }>;
}

export function definitionHash(def: FormDefinition): string {
  return createHash('sha256').update(canonicalJson(def)).digest('hex');
}

export async function ensureSystemUser(db: Db): Promise<string> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO app_user (email, display_name, identity_type, active)
     VALUES ($1, 'TQMS system', 'SYSTEM', false)
     ON CONFLICT ((lower(email))) DO UPDATE SET display_name = EXCLUDED.display_name
     RETURNING id`,
    [SYSTEM_USER_EMAIL],
  );
  return res.rows[0]!.id;
}

/** Idempotent load of capabilities, policy register and the Appendix A form catalogue. */
export async function loadReferenceData(db: Db, rootDir: string, log: (m: string) => void = console.log): Promise<void> {
  const systemUserId = await ensureSystemUser(db);
  for (const [code, meta] of Object.entries(CAPABILITIES)) {
    await db.query(
      `INSERT INTO capability (code, description, sensitive) VALUES ($1, $2, $3)
       ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description, sensitive = EXCLUDED.sensitive`,
      [code, meta.description, meta.sensitive],
    );
  }
  for (const p of POLICY_REGISTER) {
    await db.query(
      `INSERT INTO policy_decision (code, title, area, interim_behavior) VALUES ($1, $2, $3, $4)
       ON CONFLICT (code) DO UPDATE SET title = EXCLUDED.title, interim_behavior = EXCLUDED.interim_behavior, updated_at = now()
         WHERE policy_decision.status = 'POLICY_OPEN'`,
      [p.code, p.title, p.area, p.interim],
    );
  }

  for (const { file, pendingValidation } of FORM_CATALOGUES) {
    const catalogue = JSON.parse(readFileSync(path.join(rootDir, 'seed/forms', file), 'utf8')) as CatalogueFile;
    const loaded = await loadCatalogue(db, catalogue, systemUserId, pendingValidation);
    if (loaded) log(`loaded ${loaded} form revisions from ${catalogue.source.release}`);
  }
}

/**
 * Released form catalogues, loaded in order: the Appendix A set, then forms supplied by the owner.
 * Entries already present (same form and sequence) are left untouched.
 */
const FORM_CATALOGUES = [
  { file: 'appendix-a-v1.0.json', pendingValidation: true },
  { file: 'owner-additions-2026-10.json', pendingValidation: false },
];

async function loadCatalogue(db: Db, catalogue: CatalogueFile, systemUserId: string, pendingValidation: boolean): Promise<number> {
  let loaded = 0;
  await withTransaction(db, async (tx) => {
    for (const entry of catalogue.entries) {
      const definition = formDefinitionSchema.parse(entry.definition);
      const form = await tx.query<{ id: string }>(
        `INSERT INTO inspection_form (form_number, component) VALUES ($1, $2)
         ON CONFLICT (form_number) DO UPDATE SET component = inspection_form.component RETURNING id`,
        [entry.formNumber, entry.component],
      );
      const formId = form.rows[0]!.id;
      const existing = await tx.query('SELECT 1 FROM form_revision WHERE form_id = $1 AND sequence = $2', [formId, entry.sequence]);
      if (existing.rowCount) continue;
      const laterRevision = catalogue.entries.some((e) => e.formNumber === entry.formNumber && e.sequence > entry.sequence);
      const status = entry.availability === 'ACTIVE' ? 'RELEASED' : laterRevision ? 'SUPERSEDED' : 'OBSOLETE';
      await tx.query(
        `INSERT INTO form_revision (form_id, sequence, revision_label, status, definition, definition_sha256, provenance,
                                    created_by, released_by, released_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8, now())`,
        [
          formId,
          entry.sequence,
          entry.revisionLabel,
          status,
          JSON.stringify(definition),
          definitionHash(definition),
          `${catalogue.source.release}; source sha256 ${catalogue.source.sha256.slice(0, 16)}${pendingValidation ? '; PDI owner validation pending (POL-12)' : ''}`,
          systemUserId,
        ],
      );
      loaded += 1;
    }
    if (loaded) {
      await audit(tx, {
        actorId: systemUserId,
        action: 'forms.catalogue_load',
        entityType: 'inspection_form',
        summary: `Loaded ${loaded} form revisions from ${catalogue.source.release}`,
      });
    }
  });
  return loaded;
}
