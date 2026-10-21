import type { EffectiveSourceStatus } from '../../shared/sourcing.js';
import { type Queryable, many } from '../db.js';

export type SiteQualificationState = 'QUALIFIED' | 'CONDITIONALLY_QUALIFIED' | 'REJECTED' | 'EXPIRED' | 'UNDER_REVIEW' | 'NOT_ASSESSED';

export interface SiteQualification {
  status: SiteQualificationState;
  qualificationId: string | null;
  number: string | null;
  validUntil: string | null;
  conditions: string | null;
  decidedAt: Date | null;
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Current qualification of each site from its latest decision (a site's qualification never
 * comes from its parent supplier or another site). Expired validity reads as EXPIRED.
 */
export async function siteQualifications(db: Queryable, siteIds: string[]): Promise<Map<string, SiteQualification>> {
  const out = new Map<string, SiteQualification>();
  if (!siteIds.length) return out;
  const decided = await many<{ site_id: string; id: string; number: string; decision: string; valid_until: string | null; conditions: string | null; decided_at: Date }>(
    db,
    `SELECT DISTINCT ON (site_id) site_id, id, number, decision, valid_until, conditions, decided_at
       FROM supplier_qualification WHERE status = 'DECIDED' AND site_id = ANY($1::uuid[])
      ORDER BY site_id, decided_at DESC`,
    [siteIds],
  );
  const reviewing = new Set(
    (await many<{ site_id: string }>(db, `SELECT DISTINCT site_id FROM supplier_qualification WHERE status = 'UNDER_REVIEW' AND site_id = ANY($1::uuid[])`, [siteIds])).map(
      (r) => r.site_id,
    ),
  );
  for (const id of siteIds) {
    const d = decided.find((x) => x.site_id === id);
    let status: SiteQualificationState;
    if (!d) status = reviewing.has(id) ? 'UNDER_REVIEW' : 'NOT_ASSESSED';
    else if (d.decision === 'REJECTED') status = 'REJECTED';
    else if (d.valid_until && d.valid_until < today()) status = 'EXPIRED';
    else status = d.decision as SiteQualificationState;
    out.set(id, {
      status,
      qualificationId: d?.id ?? null,
      number: d?.number ?? null,
      validUntil: d?.valid_until ?? null,
      conditions: d?.conditions ?? null,
      decidedAt: d?.decided_at ?? null,
    });
  }
  return out;
}

export interface ActiveRestriction {
  id: string;
  supplier_id: string;
  site_id: string | null;
  reason: string;
  decided_at: Date;
}

export async function activeRestrictions(db: Queryable, supplierIds: string[]): Promise<ActiveRestriction[]> {
  if (!supplierIds.length) return [];
  return many<ActiveRestriction>(
    db,
    `SELECT id, supplier_id, site_id, reason, decided_at FROM supplier_restriction WHERE lifted_at IS NULL AND supplier_id = ANY($1::uuid[])`,
    [supplierIds],
  );
}

export interface SourceStatus {
  status: EffectiveSourceStatus;
  /** Latest approval decision that is not a rejection, if any. */
  approval: { id: string; number: string; decision: string; validUntil: string | null; conditions: string | null; decidedAt: Date } | null;
  reasons: string[];
}

/**
 * Effective status overlays dynamic restrictions and expiry on top of the immutable approval
 * decision (FR-022, Drawing A5). The decision record itself is never edited.
 */
export async function effectiveSourceStatuses(db: Queryable, sourceIds: string[]): Promise<Map<string, SourceStatus>> {
  const out = new Map<string, SourceStatus>();
  if (!sourceIds.length) return out;
  const sources = await many<{ id: string; supplier_id: string; site_id: string; approval_state: string }>(
    db,
    'SELECT id, supplier_id, site_id, approval_state FROM source WHERE id = ANY($1::uuid[])',
    [sourceIds],
  );
  const decisions = await many<{ source_id: string; id: string; number: string; decision: string; valid_until: string | null; conditions: string | null; decided_at: Date }>(
    db,
    `SELECT DISTINCT ON (source_id) source_id, id, number, decision, valid_until, conditions, decided_at
       FROM source_approval_decision WHERE source_id = ANY($1::uuid[]) ORDER BY source_id, decided_at DESC`,
    [sourceIds],
  );
  const restrictions = await activeRestrictions(db, [...new Set(sources.map((s) => s.supplier_id))]);
  const sites = await siteQualifications(db, [...new Set(sources.map((s) => s.site_id))]);
  for (const s of sources) {
    const d = decisions.find((x) => x.source_id === s.id);
    const approval =
      d && d.decision !== 'REJECTED'
        ? { id: d.id, number: d.number, decision: d.decision, validUntil: d.valid_until, conditions: d.conditions, decidedAt: d.decided_at }
        : null;
    const reasons: string[] = [];
    const restriction = restrictions.find((r) => r.supplier_id === s.supplier_id && (r.site_id === null || r.site_id === s.site_id));
    let status: EffectiveSourceStatus;
    if (restriction) {
      status = 'SUSPENDED';
      reasons.push(`${restriction.site_id ? 'Site' : 'Supplier'} suspended: ${restriction.reason}`);
    } else if (approval) {
      const site = sites.get(s.site_id);
      if (approval.validUntil && approval.validUntil < today()) {
        status = 'EXPIRED';
        reasons.push(`Approval ${approval.number} expired ${approval.validUntil}`);
      } else if (!site || !['QUALIFIED', 'CONDITIONALLY_QUALIFIED'].includes(site.status)) {
        status = 'AT_RISK';
        reasons.push(`Site qualification is ${site?.status.replaceAll('_', ' ').toLowerCase() ?? 'missing'}`);
      } else {
        status = approval.decision as EffectiveSourceStatus;
      }
    } else {
      status = s.approval_state === 'IN_REVIEW' ? 'IN_REVIEW' : 'NOT_APPROVED';
    }
    out.set(s.id, { status, approval, reasons });
  }
  return out;
}
