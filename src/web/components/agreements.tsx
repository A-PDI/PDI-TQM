import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AGREEMENT_STATE_TEXT, type AgreementState, ROLE_TEXT, type DocumentRole } from '../../shared/agreements';
import { api, fmtDate, fmtDateTime } from '../api';
import { useBusy } from './sourcing';
import { Dialog, LoadState, useLoad } from './ui';

const STATE_CLASS: Record<AgreementState, string> = {
  DRAFT: '',
  IN_REVIEW: 'badge-review',
  AWAITING_EXECUTION: 'badge-accepted',
  EXECUTED: 'badge-pass',
  EXPIRED: 'badge-fail',
  SUPERSEDED: '',
  TERMINATED: 'badge-fail',
  CANCELLED: '',
};

export function AgreementStateBadge({ state }: { state: AgreementState }) {
  return <span className={`badge ${STATE_CLASS[state]}`}>{AGREEMENT_STATE_TEXT[state]}</span>;
}

export interface AgreementSummaryRow {
  id: string;
  number: string;
  kind: 'AGREEMENT' | 'AMENDMENT' | 'RENEWAL';
  title: string;
  state: AgreementState;
  effectiveFrom: string | null;
  expiresOn: string | null;
  createdAt: string;
  preparedByName: string;
  approvedByName: string | null;
  lineCount: number;
  sites: Array<{ id: string; code: string; name: string }>;
  supersededAt: string | null;
  terminatedAt: string | null;
  cancelledAt: string | null;
}

export interface EffectiveLine {
  id: string;
  agreementId: string;
  agreementNumber: string;
  role: DocumentRole;
  documentNumber: string;
  title: string;
  revisionLabel: string;
  documentRevisionId: string | null;
  documentId: string | null;
  baselineRevisionId: string | null;
  contractualRef: string;
  precedence: number;
  siteIds: string[];
  partIds: string[];
  productFamilies: string[];
}

interface SupplierAgreements {
  supplier: { id: string; legalName: string; status: string };
  today: string;
  summary: {
    agreementId: string;
    number: string;
    masterDocument: string | null;
    state: AgreementState;
    effectiveFrom: string | null;
    expiresOn: string | null;
    renewalDue: boolean;
    legalEntity: string;
    sites: Array<{ code: string; name: string }>;
    productFamilies: string[];
    specificationCount: number;
    exceptions: string | null;
  } | null;
  counts: { pendingSignatures: number; pendingAcknowledgments: number; outstandingAmendments: number };
  restrictions: Array<{ reason: string; site: string | null }>;
  active: AgreementSummaryRow[];
  drafts: AgreementSummaryRow[];
  pendingExecution: AgreementSummaryRow[];
  specifications: EffectiveLine[];
  partSchedules: EffectiveLine[];
  amendments: AgreementSummaryRow[];
  historical: AgreementSummaryRow[];
  acknowledgments: Array<{
    id: string;
    documentNumber: string;
    revisionLabel: string;
    site: string | null;
    response: string;
    sentAt: string;
    sentTo: string;
    representative: string | null;
    respondedAt: string | null;
    exceptions: string | null;
    acceptedThrough: string | null;
  }>;
  supporting: Array<{ linkId: string; fileId: string; name: string | null; sha256: string; caption: string | null; linkedAt: string; agreementNumber: string; agreementId: string; signedCopy: boolean }>;
  audit: Array<{ id: string; occurredAt: string; action: string; outcome: string; summary: string; actor: string | null }>;
  permissions: { canPrepare: boolean; canApprove: boolean; canClassify: boolean };
}

interface SpecificationRow {
  documentId: string;
  number: string;
  title: string;
  classification: string;
  categoryLabel: string | null;
  current: { id: string; revisionLabel: string } | null;
}

function AgreementTable({ rows, empty, showKind = false }: { rows: AgreementSummaryRow[]; empty: string; showKind?: boolean }) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Agreement</th>
            {showKind && <th>Kind</th>}
            <th>Status</th>
            <th>Sites</th>
            <th>Effective</th>
            <th>Expires</th>
            <th>Documents</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={showKind ? 7 : 6}>
                <div className="empty">{empty}</div>
              </td>
            </tr>
          )}
          {rows.map((a) => (
            <tr key={a.id}>
              <td>
                <Link to={`/agreements/${a.id}`}>{a.number}</Link>
                <div className="small muted">{a.title}</div>
              </td>
              {showKind && <td className="small">{a.kind.toLowerCase()}</td>}
              <td>
                <AgreementStateBadge state={a.state} />
              </td>
              <td className="small">{a.sites.map((s) => s.code).join(', ') || '—'}</td>
              <td className="small">{fmtDate(a.effectiveFrom) || '—'}</td>
              <td className="small">{fmtDate(a.expiresOn) || '—'}</td>
              <td className="small">{a.lineCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LinesTable({ rows, empty }: { rows: EffectiveLine[]; empty: string }) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>Document</th>
            <th>Revision</th>
            <th>Role</th>
            <th>Reference</th>
            <th>Agreement</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={5}>
                <div className="empty">{empty}</div>
              </td>
            </tr>
          )}
          {rows.map((l) => (
            <tr key={`${l.agreementId}-${l.id}`}>
              <td>
                {l.documentId ? <Link to={`/documents/${l.documentId}`}>{l.documentNumber}</Link> : l.baselineRevisionId ? <Link to={`/baselines/${l.baselineRevisionId}`}>{l.documentNumber}</Link> : l.documentNumber}
                <div className="small muted">{l.title}</div>
              </td>
              <td>Rev {l.revisionLabel}</td>
              <td className="small">{ROLE_TEXT[l.role]}</td>
              <td className="small">{l.contractualRef}</td>
              <td className="small">
                <Link to={`/agreements/${l.agreementId}`}>{l.agreementNumber}</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Suppliers → Supplier Detail → Agreements & Specifications: the primary place to see and manage a
 * supplier's agreements, the specifications and revisions that govern it, and their full history.
 */
export function AgreementsSection({ supplierId, sites }: { supplierId: string; sites: Array<{ id: string; code: string; name: string }> }) {
  const navigate = useNavigate();
  const { data, error, loading, reload } = useLoad<SupplierAgreements>(`/api/suppliers/${supplierId}/agreements`);
  const [dialog, setDialog] = useState<null | 'new' | 'ack' | { respond: string }>(null);
  const [f, setF] = useState<Record<string, string>>({});
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const { busy, run, banner } = useBusy();
  const specs = useLoad<SpecificationRow[]>(dialog === 'ack' ? '/api/specifications' : null, [dialog]);
  const field = (k: string) => ({ value: f[k] ?? '', onChange: (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value })) });
  const close = () => {
    setDialog(null);
    setF({});
    setSiteIds([]);
  };
  if (!data) return <LoadState loading={loading} error={error} />;
  const s = data.summary;
  const p = data.permissions;
  const words = (v: string | undefined) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  return (
    <section className="card" id="agreements" aria-labelledby="agreements-title">
      <div className="page-head" style={{ marginBottom: 6 }}>
        <h2 id="agreements-title">Agreements &amp; Specifications</h2>
        <div className="row-actions">
          {p.canPrepare && (
            <>
              <button type="button" className="btn btn-small btn-primary" onClick={() => setDialog('new')}>
                New agreement
              </button>
              <button type="button" className="btn btn-small" onClick={() => setDialog('ack')}>
                Request acknowledgment
              </button>
            </>
          )}
        </div>
      </div>
      {banner}
      {s ? (
        <dl className="kv" aria-label="Current agreement">
          <dt>Current agreement</dt>
          <dd>
            <Link to={`/agreements/${s.agreementId}`}>{s.number}</Link> <AgreementStateBadge state={s.state} />
            {s.renewalDue && <span className="badge badge-review">renewal due</span>}
          </dd>
          <dt>Master agreement</dt>
          <dd>{s.masterDocument ?? '—'}</dd>
          <dt>Legal entity</dt>
          <dd>{s.legalEntity}</dd>
          <dt>Effective / expiry</dt>
          <dd>
            {fmtDate(s.effectiveFrom)} – {s.expiresOn ? fmtDate(s.expiresOn) : 'no expiry stated'}
          </dd>
          <dt>Sites covered</dt>
          <dd>{s.sites.map((x) => `${x.code} ${x.name}`).join('; ')}</dd>
          <dt>Product families</dt>
          <dd>{s.productFamilies.join(', ') || 'Not restricted'}</dd>
          <dt>Specifications</dt>
          <dd>{s.specificationCount} incorporated</dd>
          {s.exceptions && (
            <>
              <dt>Exceptions</dt>
              <dd>{s.exceptions}</dd>
            </>
          )}
        </dl>
      ) : (
        <div className="notice notice-warn">No executed agreement is in effect for this supplier.</div>
      )}
      <div className="metric-grid" style={{ margin: '10px 0' }}>
        <div className="metric">
          <strong>{data.counts.pendingSignatures}</strong>
          <span className="small">awaiting signatures</span>
        </div>
        <div className="metric">
          <strong>{data.counts.pendingAcknowledgments}</strong>
          <span className="small">acknowledgments outstanding</span>
        </div>
        <div className="metric">
          <strong>{data.counts.outstandingAmendments}</strong>
          <span className="small">amendments in progress</span>
        </div>
      </div>
      {data.restrictions.map((r, i) => (
        <div key={i} className="notice notice-error">
          {r.site ? `Site ${r.site}` : 'Supplier'} suspended: {r.reason}. Agreements and their history remain on record.
        </div>
      ))}
      {data.supplier.status === 'INACTIVE' && <div className="notice notice-warn">The supplier is inactive. Its agreements and history remain on record.</div>}

      <h3>Active agreements</h3>
      <AgreementTable rows={data.active} empty="No executed agreement in effect." showKind />
      <h3>Drafts and internal review</h3>
      <AgreementTable rows={data.drafts} empty="No drafts." showKind />
      <h3>Pending execution</h3>
      <AgreementTable rows={data.pendingExecution} empty="Nothing awaiting signatures." showKind />
      <h3>Incorporated specifications</h3>
      <LinesTable rows={data.specifications} empty="No documents incorporated by an active agreement." />
      <h3>Part-specific schedules</h3>
      <LinesTable rows={data.partSchedules} empty="No part schedules incorporated." />
      <h3>Amendments</h3>
      <AgreementTable rows={data.amendments} empty="No amendments." />
      <h3>Historical agreements</h3>
      <AgreementTable rows={data.historical} empty="No superseded, expired, terminated or cancelled agreements." showKind />

      <h3>Acknowledgments</h3>
      <p className="small muted">An acknowledgment records that the supplier received an exact revision. It is not evidence of compliance or of execution.</p>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Document</th>
              <th>Site</th>
              <th>Sent</th>
              <th>Response</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.acknowledgments.length === 0 && (
              <tr>
                <td colSpan={5}>
                  <div className="empty">No acknowledgments requested.</div>
                </td>
              </tr>
            )}
            {data.acknowledgments.map((k) => (
              <tr key={k.id}>
                <td>
                  {k.documentNumber} Rev {k.revisionLabel}
                  {k.acceptedThrough && <div className="small muted">Also accepted through executed agreement {k.acceptedThrough}</div>}
                </td>
                <td className="small">{k.site ?? 'All sites'}</td>
                <td className="small">
                  {fmtDate(k.sentAt)} to {k.sentTo}
                </td>
                <td className="small">
                  <span className={`badge ${k.response === 'ACKNOWLEDGED' ? 'badge-pass' : k.response === 'OBJECTED' ? 'badge-fail' : 'badge-review'}`}>{k.response.toLowerCase()}</span>
                  {k.representative && ` ${k.representative}, ${fmtDate(k.respondedAt)}`}
                  {k.exceptions && <div>Exceptions: {k.exceptions}</div>}
                </td>
                <td>
                  {p.canPrepare && k.response === 'PENDING' && (
                    <button type="button" className="btn btn-small" onClick={() => setDialog({ respond: k.id })}>
                      Record response
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>Supporting documents</h3>
      {data.supporting.length === 0 ? (
        <p className="muted small">No files attached to this supplier's agreements.</p>
      ) : (
        <ul className="small">
          {data.supporting.map((x) => (
            <li key={x.linkId}>
              <a href={`/api/files/${x.fileId}`} target="_blank" rel="noopener noreferrer">
                {x.name ?? 'File'}
              </a>{' '}
              {x.signedCopy && <span className="badge badge-done">signed agreement</span>} on <Link to={`/agreements/${x.agreementId}`}>{x.agreementNumber}</Link>
              <span className="muted"> · {fmtDateTime(x.linkedAt)} · SHA-256 {x.sha256.slice(0, 12)}…</span>
            </li>
          ))}
        </ul>
      )}

      <details>
        <summary>Audit history ({data.audit.length})</summary>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>What</th>
              </tr>
            </thead>
            <tbody>
              {data.audit.map((e) => (
                <tr key={e.id}>
                  <td className="small">{fmtDateTime(e.occurredAt)}</td>
                  <td className="small">{e.actor ?? 'System'}</td>
                  <td className="small">
                    {e.outcome !== 'SUCCESS' && <span className="badge badge-fail">{e.outcome.toLowerCase()}</span>} {e.summary}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      <Dialog
        open={dialog === 'new'}
        title="New supplier agreement"
        onClose={close}
        footer={
          <>
            <button type="button" className="btn" onClick={close}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !f.title || siteIds.length === 0}
              onClick={async () => {
                let created: { id: string } | null = null;
                const done = await run(async () => {
                  created = await api<{ id: string }>(`/api/suppliers/${supplierId}/agreements`, {
                    body: { title: f.title, siteIds, productFamilies: words(f.families), expiresOn: f.expiresOn || null, exceptions: f.exceptions || null },
                  });
                });
                if (done && created) navigate(`/agreements/${(created as { id: string }).id}`);
              }}
            >
              Create draft
            </button>
          </>
        }
      >
        <p className="small muted">The draft belongs to this supplier. The contracting legal entity is taken from the supplier record and kept with the agreement.</p>
        <div className="field">
          <label htmlFor="ag-title">Title</label>
          <input id="ag-title" {...field('title')} />
        </div>
        <fieldset className="field">
          <legend>Manufacturing sites covered</legend>
          {sites.map((x) => (
            <label key={x.id} style={{ display: 'block' }}>
              <input type="checkbox" checked={siteIds.includes(x.id)} onChange={(e) => setSiteIds((v) => (e.target.checked ? [...v, x.id] : v.filter((y) => y !== x.id)))} /> {x.code} {x.name}
            </label>
          ))}
          {sites.length === 0 && <span className="small muted">Add a manufacturing site first.</span>}
        </fieldset>
        <div className="field">
          <label htmlFor="ag-families">Product families (comma separated)</label>
          <input id="ag-families" {...field('families')} />
        </div>
        <div className="field">
          <label htmlFor="ag-expires">Expiry / renewal date (optional)</label>
          <input id="ag-expires" type="date" {...field('expiresOn')} />
        </div>
        <div className="field">
          <label htmlFor="ag-exceptions">Exceptions or restrictions (optional)</label>
          <textarea id="ag-exceptions" rows={2} {...field('exceptions')} />
        </div>
      </Dialog>

      <Dialog
        open={dialog === 'ack'}
        title="Request acknowledgment of a revision"
        onClose={close}
        footer={
          <>
            <button type="button" className="btn" onClick={close}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !f.revisionId || !f.sentTo || !f.sentAt}
              onClick={() =>
                run(
                  () => api(`/api/suppliers/${supplierId}/acknowledgments`, { body: { documentRevisionId: f.revisionId, siteId: f.siteId || null, sentVia: f.sentVia || 'EMAIL', sentTo: f.sentTo, sentAt: f.sentAt } }),
                  'Acknowledgment request recorded',
                ).then((ok) => {
                  if (ok) {
                    close();
                    reload();
                  }
                })
              }
            >
              Record request
            </button>
          </>
        }
      >
        <p className="small muted">Not needed when an executed agreement already incorporates the exact revision for the site.</p>
        <LoadState loading={specs.loading && !specs.data} error={specs.error} />
        <div className="field">
          <label htmlFor="ack-doc">Document revision</label>
          <select id="ack-doc" {...field('revisionId')}>
            <option value="">Choose…</option>
            {(specs.data ?? [])
              .filter((x) => x.current)
              .map((x) => (
                <option key={x.documentId} value={x.current!.id}>
                  {x.number} Rev {x.current!.revisionLabel} — {x.title}
                </option>
              ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ack-site">Site</label>
          <select id="ack-site" {...field('siteId')}>
            <option value="">All sites</option>
            {sites.map((x) => (
              <option key={x.id} value={x.id}>
                {x.code} {x.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ack-via">Sent via</label>
          <select id="ack-via" {...field('sentVia')}>
            {['EMAIL', 'PORTAL', 'MEETING', 'MAIL', 'OTHER'].map((v) => (
              <option key={v} value={v}>
                {v.toLowerCase()}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ack-to">Sent to</label>
          <input id="ack-to" {...field('sentTo')} />
        </div>
        <div className="field">
          <label htmlFor="ack-at">Sent on</label>
          <input id="ack-at" type="date" {...field('sentAt')} />
        </div>
      </Dialog>

      <Dialog
        open={typeof dialog === 'object' && dialog !== null}
        title="Record supplier response"
        onClose={close}
        footer={
          <>
            <button type="button" className="btn" onClick={close}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !f.response || !f.representative || !f.respondedAt}
              onClick={() =>
                run(
                  () =>
                    api(`/api/acknowledgments/${(dialog as { respond: string }).respond}/response`, {
                      body: { response: f.response, representative: f.representative, respondedAt: f.respondedAt, note: f.note || null, exceptions: f.exceptions || null },
                    }),
                  'Response recorded',
                ).then((ok) => {
                  if (ok) {
                    close();
                    reload();
                  }
                })
              }
            >
              Save response
            </button>
          </>
        }
      >
        <div className="field">
          <label htmlFor="ack-resp">Response</label>
          <select id="ack-resp" {...field('response')}>
            <option value="">Choose…</option>
            <option value="ACKNOWLEDGED">Acknowledged</option>
            <option value="OBJECTED">Objected</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="ack-rep">Supplier representative</label>
          <input id="ack-rep" {...field('representative')} />
        </div>
        <div className="field">
          <label htmlFor="ack-date">Responded on</label>
          <input id="ack-date" type="date" {...field('respondedAt')} />
        </div>
        <div className="field">
          <label htmlFor="ack-exc">Exceptions stated by the supplier (optional)</label>
          <textarea id="ack-exc" rows={2} {...field('exceptions')} />
        </div>
        <div className="field">
          <label htmlFor="ack-note">Note (required for an objection)</label>
          <textarea id="ack-note" rows={2} {...field('note')} />
        </div>
      </Dialog>
    </section>
  );
}

export interface GoverningSnapshot {
  asOf: string;
  agreements: Array<{ id: string; number: string; title: string }>;
  requirements: Array<{
    agreementNumber: string;
    role: DocumentRole;
    documentNumber: string;
    title: string;
    revisionLabel: string;
    documentRevisionId: string | null;
    baselineRevisionId: string | null;
    contractualRef: string;
    precedence: number;
    clauses: Array<{ clauseRef: string; title: string }>;
  }>;
}

/** The contractual documents (exact revisions) that governed a part from a supplier site on a date. */
export function GoverningRequirements({ snapshot, title = 'Governing specifications', note }: { snapshot: GoverningSnapshot | null | undefined; title?: string; note?: string }) {
  return (
    <section className="card" aria-label={title}>
      <h2>{title}</h2>
      {note && <p className="small muted">{note}</p>}
      {!snapshot ? (
        <p className="muted small">No executed supplier agreement covered this part and site on that date.</p>
      ) : (
        <>
          <p className="small muted">
            Under {snapshot.agreements.map((a, i) => (
              <span key={a.id}>
                {i > 0 && ', '}
                <Link to={`/agreements/${a.id}`}>{a.number}</Link>
              </span>
            ))}{' '}
            as of {fmtDate(snapshot.asOf)}.
          </p>
          <ul className="small">
            {[...snapshot.requirements]
              .sort((a, b) => a.precedence - b.precedence)
              .map((r, i) => (
                <li key={i}>
                  <strong>
                    {r.documentNumber} Rev {r.revisionLabel}
                  </strong>{' '}
                  {r.title} <span className="muted">({ROLE_TEXT[r.role]}, {r.contractualRef})</span>
                  {r.clauses.length > 0 && (
                    <details>
                      <summary>{r.clauses.length} clauses</summary>
                      <ul>
                        {r.clauses.map((c) => (
                          <li key={c.clauseRef}>
                            {c.clauseRef} {c.title}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                </li>
              ))}
          </ul>
        </>
      )}
    </section>
  );
}

interface DocAgreementInfo {
  classification: {
    classification: 'MASTER_AGREEMENT' | 'QUALITY_AGREEMENT' | 'TECHNICAL_SPECIFICATION';
    categoryCode: string | null;
    categoryLabel: string | null;
    productFamilies: string[];
    materials: string[];
    processes: string[];
    defaultPrecedence: number;
    scopeNote: string | null;
    explicit: boolean;
  } | null;
  clauses: Record<string, Array<{ clauseRef: string; title: string }>>;
  incorporatedIn: Array<{ revisionId: string; revisionLabel: string; agreementId: string; number: string; status: string; kind: string; supplierId: string; supplierCode: string; supplierName: string; contractualRef: string }>;
}

interface ImpactData {
  current: { revisionLabel: string } | null;
  latest: { id: string; revisionLabel: string };
  affected: Array<{
    agreementId: string;
    number: string;
    supplierId: string;
    supplierCode: string;
    supplierName: string;
    incorporatedRevision: string;
    sites: Array<{ code: string; name: string }>;
    productFamilies: string[];
    parts: Array<{ id: string; partNumber: string }>;
    sources: Array<{ id: string; partNumber: string; site: string }>;
    acknowledgments: Array<{ id: string; response: string; revisionLabel: string }>;
    newRevisionAcknowledged: boolean;
    review: { id: string; status: string } | null;
  }>;
}

const CLASS_TEXT: Record<string, string> = {
  MASTER_AGREEMENT: 'Master supplier agreement template',
  QUALITY_AGREEMENT: 'Supplier quality agreement',
  TECHNICAL_SPECIFICATION: 'Controlled technical / quality specification',
};

/** Document Library page: how the document takes part in supplier agreements, its clauses and revision impact. */
export function DocumentAgreementsPanel({
  documentId,
  info,
  revisions,
  canControl,
  onChanged,
}: {
  documentId: string;
  info: DocAgreementInfo | undefined;
  revisions: Array<{ id: string; revisionLabel: string; status: string }>;
  canControl: boolean;
  onChanged: () => void;
}) {
  const [dialog, setDialog] = useState<null | 'classify' | { clauses: string }>(null);
  const [f, setF] = useState<Record<string, string>>({});
  const { busy, run, banner } = useBusy();
  const cats = useLoad<Array<{ code: string; label: string; active: boolean }>>(dialog === 'classify' ? '/api/specification-categories' : null, [dialog]);
  const impact = useLoad<ImpactData>(info?.classification ? `/api/documents/${documentId}/impact` : null, [info?.classification?.classification]);
  if (!info) return null;
  const c = info.classification;
  const field = (k: string) => ({ value: f[k] ?? '', onChange: (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value })) });
  const close = () => {
    setDialog(null);
    setF({});
  };
  const list = (v: string | undefined) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!c && !canControl) return null;
  return (
    <section className="card" aria-labelledby="doc-agreements">
      <div className="page-head" style={{ marginBottom: 6 }}>
        <h2 id="doc-agreements">Supplier agreements and specifications</h2>
        {canControl && (
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              setF({
                classification: c?.classification ?? '',
                categoryCode: c?.categoryCode ?? '',
                families: c?.productFamilies.join(', ') ?? '',
                materials: c?.materials.join(', ') ?? '',
                processes: c?.processes.join(', ') ?? '',
                precedence: c ? String(c.defaultPrecedence) : '',
                scopeNote: c?.scopeNote ?? '',
              });
              setDialog('classify');
            }}
          >
            {c ? 'Change classification' : 'Classify for supplier agreements'}
          </button>
        )}
      </div>
      {banner}
      {!c ? (
        <p className="small muted">Not used in supplier agreements.</p>
      ) : (
        <dl className="kv">
          <dt>Classification</dt>
          <dd>
            {CLASS_TEXT[c.classification]}
            {!c.explicit && <span className="muted"> (default for this document)</span>}
          </dd>
          {c.categoryLabel && (
            <>
              <dt>Category</dt>
              <dd>{c.categoryLabel}</dd>
            </>
          )}
          <dt>Applies to</dt>
          <dd>
            {[c.productFamilies.length ? `Families ${c.productFamilies.join(', ')}` : null, c.materials.length ? `Materials ${c.materials.join(', ')}` : null, c.processes.length ? `Processes ${c.processes.join(', ')}` : null].filter(Boolean).join('; ') ||
              'No applicability rules (chosen per agreement)'}
          </dd>
          <dt>Default precedence</dt>
          <dd>{c.defaultPrecedence}</dd>
          {c.scopeNote && (
            <>
              <dt>Scope</dt>
              <dd>{c.scopeNote}</dd>
            </>
          )}
        </dl>
      )}
      {c && (
        <>
          <h3>Clauses by revision</h3>
          <ul className="small">
            {revisions.map((r) => {
              const cl = info.clauses[r.id] ?? [];
              return (
                <li key={r.id}>
                  Rev {r.revisionLabel}: {cl.length ? `${cl.length} clauses` : 'no clauses recorded'}
                  {cl.length > 0 && (
                    <details>
                      <summary>Show clauses</summary>
                      <ul>
                        {cl.map((x) => (
                          <li key={x.clauseRef}>
                            {x.clauseRef} {x.title}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {canControl && (
                    <button type="button" className="btn-link" style={{ marginLeft: 6 }} onClick={() => setDialog({ clauses: r.id })}>
                      Record clauses
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          <h3>Incorporated in agreements</h3>
          {info.incorporatedIn.length === 0 ? (
            <p className="small muted">Not incorporated in any agreement.</p>
          ) : (
            <ul className="small">
              {info.incorporatedIn.map((x) => (
                <li key={`${x.agreementId}-${x.revisionId}`}>
                  Rev {x.revisionLabel} in <Link to={`/agreements/${x.agreementId}`}>{x.number}</Link> ({x.status.toLowerCase().replaceAll('_', ' ')}, {x.contractualRef}) for{' '}
                  <Link to={`/suppliers/${x.supplierId}#agreements`}>{x.supplierName}</Link>
                </li>
              ))}
            </ul>
          )}
          <h3>Revision impact</h3>
          <LoadState loading={impact.loading && !impact.data} error={impact.error} />
          {impact.data &&
            (impact.data.affected.length === 0 ? (
              <p className="small muted">Every executed agreement incorporating this document is on Rev {impact.data.latest.revisionLabel}.</p>
            ) : (
              <>
                <p className="small">
                  Rev {impact.data.latest.revisionLabel} is the latest. These executed agreements still incorporate an earlier revision and remain unchanged until amended:
                </p>
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Agreement</th>
                        <th>Supplier</th>
                        <th>Incorporated</th>
                        <th>Sites / parts</th>
                        <th>Exact sources</th>
                        <th>Review</th>
                      </tr>
                    </thead>
                    <tbody>
                      {impact.data.affected.map((x) => (
                        <tr key={x.agreementId}>
                          <td>
                            <Link to={`/agreements/${x.agreementId}`}>{x.number}</Link>
                          </td>
                          <td>
                            <Link to={`/suppliers/${x.supplierId}#agreements`}>{x.supplierName}</Link>
                          </td>
                          <td className="small">Rev {x.incorporatedRevision}</td>
                          <td className="small">
                            {x.sites.map((s) => s.code).join(', ')}
                            {x.parts.length > 0 && ` · ${x.parts.map((p) => p.partNumber).join(', ')}`}
                            {x.productFamilies.length > 0 && ` · ${x.productFamilies.join(', ')}`}
                          </td>
                          <td className="small">
                            {x.sources.map((s, i) => (
                              <span key={s.id}>
                                {i > 0 && ', '}
                                <Link to={`/sources/${s.id}`}>
                                  {s.partNumber} @ {s.site}
                                </Link>
                              </span>
                            ))}
                            {x.sources.length === 0 && '—'}
                          </td>
                          <td className="small">
                            {x.review ? x.review.status.toLowerCase() : '—'}
                            {x.newRevisionAcknowledged && <div>new revision acknowledged</div>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ))}
        </>
      )}

      <Dialog
        open={dialog === 'classify'}
        title="Classify for supplier agreements"
        onClose={close}
        footer={
          <>
            <button type="button" className="btn" onClick={close}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !f.classification || (f.classification === 'TECHNICAL_SPECIFICATION' && !f.categoryCode)}
              onClick={() =>
                run(
                  () =>
                    api(`/api/documents/${documentId}/classification`, {
                      method: 'PUT',
                      body: {
                        classification: f.classification,
                        categoryCode: f.classification === 'TECHNICAL_SPECIFICATION' ? f.categoryCode : null,
                        productFamilies: list(f.families),
                        materials: list(f.materials),
                        processes: list(f.processes),
                        defaultPrecedence: f.precedence ? Number(f.precedence) : undefined,
                        scopeNote: f.scopeNote || null,
                      },
                    }),
                  'Classification saved',
                ).then((ok) => {
                  if (ok) {
                    close();
                    onChanged();
                  }
                })
              }
            >
              Save
            </button>
          </>
        }
      >
        <div className="field">
          <label htmlFor="cl-class">Classification</label>
          <select id="cl-class" {...field('classification')}>
            <option value="">Choose…</option>
            {Object.entries(CLASS_TEXT).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        {f.classification === 'TECHNICAL_SPECIFICATION' && (
          <div className="field">
            <label htmlFor="cl-cat">Category</label>
            <select id="cl-cat" {...field('categoryCode')}>
              <option value="">Choose…</option>
              {(cats.data ?? [])
                .filter((x) => x.active)
                .map((x) => (
                  <option key={x.code} value={x.code}>
                    {x.label}
                  </option>
                ))}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor="cl-fam">Product families (comma separated)</label>
          <input id="cl-fam" {...field('families')} />
        </div>
        <div className="field">
          <label htmlFor="cl-mat">Materials</label>
          <input id="cl-mat" {...field('materials')} />
        </div>
        <div className="field">
          <label htmlFor="cl-proc">Manufacturing processes</label>
          <input id="cl-proc" {...field('processes')} />
        </div>
        <div className="field">
          <label htmlFor="cl-prec">Default precedence (1 governs first)</label>
          <input id="cl-prec" type="number" min={1} max={999} {...field('precedence')} />
        </div>
        <div className="field">
          <label htmlFor="cl-note">Scope note</label>
          <textarea id="cl-note" rows={2} {...field('scopeNote')} />
        </div>
      </Dialog>

      <Dialog
        open={typeof dialog === 'object' && dialog !== null}
        title="Record clauses of this revision"
        onClose={close}
        footer={
          <>
            <button type="button" className="btn" onClick={close}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !f.clauses}
              onClick={() => {
                const clauses = (f.clauses ?? '')
                  .split('\n')
                  .map((line) => line.trim())
                  .filter(Boolean)
                  .map((line) => {
                    const [ref, ...rest] = line.split('|');
                    return { clauseRef: (ref ?? '').trim(), title: rest.join('|').trim() };
                  });
                void run(() => api(`/api/document-revisions/${(dialog as { clauses: string }).clauses}/clauses`, { body: { clauses } }), 'Clauses recorded').then((ok) => {
                  if (ok) {
                    close();
                    onChanged();
                  }
                });
              }}
            >
              Record
            </button>
          </>
        }
      >
        <p className="small muted">One clause per line as reference | title, e.g. §6.3 | Internal soundness. Clauses are recorded once per revision and cannot be edited, so citations stay stable.</p>
        <div className="field">
          <label htmlFor="cl-lines">Clauses</label>
          <textarea id="cl-lines" rows={8} {...field('clauses')} />
        </div>
      </Dialog>
    </section>
  );
}

export interface NcrRequirement {
  revisionId: string | null;
  clause: string | null;
  baselineRevisionId: string | null;
  cited: { documentNumber: string; revisionLabel: string; title: string } | null;
  schedule: { partNumber: string; revisionLabel: string } | null;
  governing: GoverningSnapshot | null;
}

/** The governing requirement an NCR cites: exact specification revision and clause, and the part schedule. */
export function NcrRequirementPanel({ ncrId, requirement, canEdit, onChanged }: { ncrId: string; requirement: NcrRequirement | undefined; canEdit: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<Record<string, string>>({});
  const { busy, run, banner } = useBusy();
  if (!requirement) return null;
  const r = requirement;
  const docOptions = (r.governing?.requirements ?? []).filter((x) => x.documentRevisionId && x.role !== 'MASTER_AGREEMENT');
  const scheduleOptions = (r.governing?.requirements ?? []).filter((x) => x.baselineRevisionId);
  const selected = docOptions.find((x) => x.documentRevisionId === (f.revisionId ?? r.revisionId));
  return (
    <section className="card" aria-labelledby="ncr-requirement">
      <div className="page-head" style={{ marginBottom: 6 }}>
        <h2 id="ncr-requirement">Governing requirement</h2>
        {canEdit && (
          <button type="button" className="btn btn-small" onClick={() => setOpen(true)}>
            {r.cited || r.schedule ? 'Change' : 'Cite requirement'}
          </button>
        )}
      </div>
      {banner}
      {r.cited || r.schedule ? (
        <dl className="kv">
          {r.cited && (
            <>
              <dt>Specification</dt>
              <dd>
                {r.cited.documentNumber} Rev {r.cited.revisionLabel} {r.clause ?? ''} <span className="muted">{r.cited.title}</span>
              </dd>
            </>
          )}
          {r.schedule && (
            <>
              <dt>Part schedule</dt>
              <dd>
                <Link to={`/baselines/${r.baselineRevisionId}`}>
                  {r.schedule.partNumber} Rev {r.schedule.revisionLabel}
                </Link>
              </dd>
            </>
          )}
        </dl>
      ) : (
        <p className="small muted">No governing requirement cited yet.</p>
      )}
      {r.governing && (
        <p className="small muted">
          Executed agreements covering this supplier and part on the NCR date: {r.governing.agreements.map((a) => a.number).join(', ')}.
        </p>
      )}
      <Dialog
        open={open}
        title="Cite the governing requirement"
        onClose={() => {
          setOpen(false);
          setF({});
        }}
        footer={
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() =>
              run(
                () =>
                  api(`/api/ncrs/${ncrId}/requirement`, {
                    method: 'PUT',
                    body: {
                      governingRevisionId: (f.revisionId ?? r.revisionId) || null,
                      governingClause: (f.clause ?? r.clause) || null,
                      governingBaselineRevisionId: (f.baselineRevisionId ?? r.baselineRevisionId) || null,
                    },
                  }),
                'Requirement recorded',
              ).then((ok) => {
                if (ok) {
                  setOpen(false);
                  setF({});
                  onChanged();
                }
              })
            }
          >
            Save
          </button>
        }
      >
        <p className="small muted">Choose from the documents the supplier's executed agreements incorporate for this part.</p>
        <div className="field">
          <label htmlFor="nr-doc">Specification revision</label>
          <select id="nr-doc" value={f.revisionId ?? r.revisionId ?? ''} onChange={(e) => setF((x) => ({ ...x, revisionId: e.target.value, clause: '' }))}>
            <option value="">None</option>
            {docOptions.map((x) => (
              <option key={x.documentRevisionId!} value={x.documentRevisionId!}>
                {x.documentNumber} Rev {x.revisionLabel} — {x.title}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="nr-clause">Clause</label>
          {selected && selected.clauses.length > 0 ? (
            <select id="nr-clause" value={f.clause ?? r.clause ?? ''} onChange={(e) => setF((x) => ({ ...x, clause: e.target.value }))}>
              <option value="">None</option>
              {selected.clauses.map((c) => (
                <option key={c.clauseRef} value={c.clauseRef}>
                  {c.clauseRef} {c.title}
                </option>
              ))}
            </select>
          ) : (
            <input id="nr-clause" value={f.clause ?? r.clause ?? ''} onChange={(e) => setF((x) => ({ ...x, clause: e.target.value }))} />
          )}
        </div>
        <div className="field">
          <label htmlFor="nr-sched">Part schedule</label>
          <select id="nr-sched" value={f.baselineRevisionId ?? r.baselineRevisionId ?? ''} onChange={(e) => setF((x) => ({ ...x, baselineRevisionId: e.target.value }))}>
            <option value="">None</option>
            {scheduleOptions.map((x) => (
              <option key={x.baselineRevisionId!} value={x.baselineRevisionId!}>
                {x.documentNumber} Rev {x.revisionLabel}
              </option>
            ))}
          </select>
        </div>
      </Dialog>
    </section>
  );
}

interface PartSpecs {
  asOf: string;
  classification: { family: string | null; material: string | null; process: string | null };
  sources: Array<{ id: string; supplierId: string; supplier: string; site: string; governing: GoverningSnapshot | null }>;
}

/** Part page: material/process applicability and the specifications governing each exact source. */
export function PartSpecificationsPanel({ partId, canEdit }: { partId: string; canEdit: boolean }) {
  const { data, error, loading, reload } = useLoad<PartSpecs>(`/api/parts/${partId}/specifications`);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<Record<string, string>>({});
  const { busy, run, banner } = useBusy();
  if (!data) return <LoadState loading={loading} error={error} />;
  const c = data.classification;
  return (
    <section className="card" aria-labelledby="part-specs">
      <div className="page-head" style={{ marginBottom: 6 }}>
        <h2 id="part-specs">Governing specifications and agreements</h2>
        {canEdit && (
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              setF({ material: c.material ?? '', process: c.process ?? '' });
              setOpen(true);
            }}
          >
            Edit material / process
          </button>
        )}
      </div>
      {banner}
      <dl className="kv">
        <dt>Material</dt>
        <dd>{c.material ?? '—'}</dd>
        <dt>Manufacturing process</dt>
        <dd>{c.process ?? '—'}</dd>
      </dl>
      <p className="small muted">Specifications apply by product family, material or process, as Document Control classifies them. Coverage is informational and gates nothing.</p>
      {data.sources.length === 0 && <p className="small muted">No exact sources.</p>}
      <ul className="small">
        {data.sources.map((s) => (
          <li key={s.id}>
            <Link to={`/sources/${s.id}`}>
              {s.supplier} — {s.site}
            </Link>
            :{' '}
            {s.governing ? (
              <>
                {s.governing.requirements
                  .filter((r) => r.role === 'SPECIFICATION' || r.role === 'PART_SCHEDULE' || r.role === 'QUALITY_AGREEMENT')
                  .map((r) => `${r.documentNumber} Rev ${r.revisionLabel}`)
                  .join(', ') || 'no specifications'}{' '}
                <span className="muted">
                  under{' '}
                  {s.governing.agreements.map((a, i) => (
                    <span key={a.id}>
                      {i > 0 && ', '}
                      <Link to={`/agreements/${a.id}`}>{a.number}</Link>
                    </span>
                  ))}
                </span>
              </>
            ) : (
              <span className="muted">
                no executed agreement — see the <Link to={`/suppliers/${s.supplierId}#agreements`}>supplier</Link>
              </span>
            )}
          </li>
        ))}
      </ul>
      <Dialog
        open={open}
        title="Material and process"
        onClose={() => setOpen(false)}
        footer={
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() =>
              run(() => api(`/api/parts/${partId}/classification`, { method: 'PUT', body: { material: f.material || null, manufacturingProcess: f.process || null } }), 'Saved').then((ok) => {
                if (ok) {
                  setOpen(false);
                  reload();
                }
              })
            }
          >
            Save
          </button>
        }
      >
        <div className="field">
          <label htmlFor="pc-mat">Material</label>
          <input id="pc-mat" value={f.material ?? ''} onChange={(e) => setF((x) => ({ ...x, material: e.target.value }))} />
        </div>
        <div className="field">
          <label htmlFor="pc-proc">Manufacturing process</label>
          <input id="pc-proc" value={f.process ?? ''} onChange={(e) => setF((x) => ({ ...x, process: e.target.value }))} />
        </div>
      </Dialog>
    </section>
  );
}
