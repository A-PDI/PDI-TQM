import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { EffectiveSourceStatus } from '../../shared/sourcing';
import { api, fmtDate, fmtDateTime } from '../api';
import { useAuth } from '../auth';
import { FileLinks, QualificationBadge, SourceStatusBadge, UploadEvidence, useBusy } from '../components/sourcing';
import { type QualityContext, QualityContextCard } from '../components/quality';
import { Dialog, LoadState, OutcomeBadge, StatusBadge, useLoad } from '../components/ui';
import { NewCommitmentDialog } from './Commitments';

const Synthetic = ({ on }: { on: boolean }) => (on ? <span className="badge badge-synthetic">fictional</span> : null);

export function SuppliersList() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const { data, error, loading } = useLoad<Array<{ id: string; code: string; legalName: string; status: string; category: string | null; siteCount: number; sourceCount: number; isSynthetic: boolean; restricted: boolean }>>(
    '/api/suppliers',
  );
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ code: '', legalName: '', category: '' });
  const { busy, run, banner } = useBusy();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Suppliers</h1>
          <div className="small muted">Supplier organizations and each manufacturing site. A site is qualified on its own; the parent supplier's status does not qualify it.</div>
        </div>
        {can('supplier.manage') && (
          <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
            New supplier
          </button>
        )}
      </div>
      <LoadState loading={loading && !data} error={error} />
      {data && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Supplier</th>
                <th>Category</th>
                <th>Sites</th>
                <th>Sources</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <div className="empty">No suppliers recorded.</div>
                  </td>
                </tr>
              )}
              {data.map((s) => (
                <tr key={s.id} className="clickable" onClick={() => navigate(`/suppliers/${s.id}`)}>
                  <td>
                    <Link to={`/suppliers/${s.id}`} onClick={(e) => e.stopPropagation()}>
                      {s.legalName}
                    </Link>{' '}
                    <span className="small muted">{s.code}</span> <Synthetic on={s.isSynthetic} />
                  </td>
                  <td>{s.category ?? '—'}</td>
                  <td>{s.siteCount}</td>
                  <td>{s.sourceCount}</td>
                  <td>
                    <span className="badge">{s.status.toLowerCase()}</span> {s.restricted && <span className="badge badge-fail">suspension active</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Dialog
        open={open}
        title="New supplier"
        onClose={() => setOpen(false)}
        footer={
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || form.code.length < 2 || form.legalName.length < 2}
            onClick={async () => {
              let id = '';
              if (await run(async () => (id = (await api<{ id: string }>('/api/suppliers', { body: { ...form, category: form.category || null } })).id))) navigate(`/suppliers/${id}`);
            }}
          >
            Register supplier
          </button>
        }
      >
        <p className="small muted" style={{ marginTop: 0 }}>
          New suppliers start as prospective. Add each manufacturing site, then record an assessment for the site you intend to buy from.
        </p>
        <div className="field">
          <label htmlFor="ns-code">Short code</label>
          <input id="ns-code" type="text" maxLength={20} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="ns-name">Legal name</label>
          <input id="ns-name" type="text" value={form.legalName} onChange={(e) => setForm({ ...form, legalName: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="ns-cat">Category / capabilities</label>
          <input id="ns-cat" type="text" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
        </div>
        {banner}
      </Dialog>
    </>
  );
}

interface Qualification {
  id: string;
  number: string;
  siteId: string | null;
  siteName: string | null;
  kind: string;
  scope: string;
  findings: string;
  proposedResult: string;
  proposedConditions: string | null;
  proposedValidUntil: string | null;
  status: string;
  decision: string | null;
  conditions: string | null;
  validUntil: string | null;
  rationale: string | null;
  version: number;
  createdAt: string;
  decidedAt: string | null;
  assessorId: string;
  assessor: string;
  decidedBy: string | null;
  files: Array<{ linkId: string; fileId: string; name: string }>;
}

interface SupplierData {
  supplier: { id: string; code: string; legalName: string; tradingName: string | null; status: string; category: string | null; notes: string | null; isSynthetic: boolean };
  sites: Array<{ id: string; code: string; name: string; address: string | null; country: string | null; qualification: { status: string; number: string | null; validUntil: string | null; conditions: string | null } }>;
  sources: Array<{ id: string; partId: string; partNumber: string; description: string; site: string; supplierPartNumber: string; pathway: string; effective: { status: EffectiveSourceStatus; reasons: string[] } }>;
  inspections: Array<{ id: string; number: string; partNumber: string; status: string; outcome: string | null; dateReceived: string }>;
  concerns: Array<{ id: string; number: string; title: string; status: string }>;
  qualifications: Qualification[];
  restrictions: Array<{
    id: string;
    kind: string;
    siteId: string | null;
    siteName: string | null;
    sourceId: string | null;
    sourceLabel: string | null;
    reason: string;
    decidedAt: string;
    decidedBy: string;
    liftedAt: string | null;
    liftedBy: string | null;
    liftReason: string | null;
  }>;
  quality: QualityContext;
  certificates: Array<{ id: string; siteName: string | null; certType: string; certNumber: string | null; issuer: string | null; validUntil: string | null; expired: boolean; files: Array<{ linkId: string; fileId: string; name: string }> }>;
  supplierParts: Array<{ id: string; supplierPartNumber: string; description: string | null }>;
  permissions: { canManage: boolean; canQualify: boolean; canRestrict: boolean };
}

type DialogKind = null | 'site' | 'assess' | 'part' | 'cert' | { decide: Qualification } | { suspend: string | null } | { lift: string };

export function SupplierDetail() {
  const { id = '' } = useParams();
  const { me, can } = useAuth();
  const { data, error, loading, reload } = useLoad<SupplierData>(`/api/suppliers/${id}`);
  const [commitmentOpen, setCommitmentOpen] = useState(false);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const { busy, run, banner } = useBusy();
  const [f, setF] = useState<Record<string, string>>({});
  const field = (k: string) => ({ value: f[k] ?? '', onChange: (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value })) });
  if (!data) return <LoadState loading={loading} error={error} />;
  const s = data.supplier;
  const p = data.permissions;
  const activeRestrictions = data.restrictions.filter((r) => !r.liftedAt && !r.sourceId);
  const sourceHolds = data.restrictions.filter((r) => !r.liftedAt && r.sourceId);
  const close = () => {
    setDialog(null);
    setF({});
  };
  const submit = async (fn: () => Promise<unknown>, ok: string) => {
    if (await run(fn, ok)) {
      close();
      reload();
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            {s.legalName} <Synthetic on={s.isSynthetic} />
          </h1>
          <div className="small muted">
            {s.code} · {s.category ?? 'Uncategorized'} · organization status {s.status.toLowerCase()}
          </div>
        </div>
        <div className="row-actions">
          {p.canRestrict && !activeRestrictions.some((r) => !r.siteId) && (
            <button type="button" className="btn btn-danger" onClick={() => setDialog({ suspend: null })}>
              Suspend supplier
            </button>
          )}
          <Link className="btn" to="/suppliers">
            All suppliers
          </Link>
        </div>
      </div>
      {banner}
      {sourceHolds.map((r) => (
        <div key={r.id} className="notice notice-warn">
          <strong>Source restricted:</strong> <Link to={`/sources/${r.sourceId}`}>{r.sourceLabel}</Link> since {fmtDateTime(r.decidedAt)} by {r.decidedBy}: {r.reason}
        </div>
      ))}
      {activeRestrictions.map((r) => (
        <div key={r.id} className="notice notice-error" role="alert">
          <strong>{r.siteName ? `Site ${r.siteName}` : 'Supplier'} suspended</strong> since {fmtDateTime(r.decidedAt)} by {r.decidedBy}: {r.reason}. Approved sources affected by this
          suspension are blocked for new activity; their approval records are unchanged.{' '}
          {p.canRestrict && (
            <button type="button" className="btn btn-small" onClick={() => setDialog({ lift: r.id })}>
              Reinstate…
            </button>
          )}
        </div>
      ))}

      <section className="card">
        <div className="page-head" style={{ marginBottom: 6 }}>
          <h2>Manufacturing sites</h2>
          <div className="row-actions">
            {p.canManage && (
              <>
                <button type="button" className="btn btn-small" onClick={() => setDialog('site')}>
                  + Site
                </button>
                <button type="button" className="btn btn-small" onClick={() => setDialog('assess')}>
                  Record assessment
                </button>
              </>
            )}
          </div>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Site</th>
                <th>Address</th>
                <th>Qualification</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.sites.length === 0 && (
                <tr>
                  <td colSpan={4}>
                    <div className="empty">No manufacturing sites yet.</div>
                  </td>
                </tr>
              )}
              {data.sites.map((x) => (
                <tr key={x.id}>
                  <td>
                    {x.name} <span className="small muted">{x.code}</span>
                  </td>
                  <td className="small">{[x.address, x.country].filter(Boolean).join(', ') || '—'}</td>
                  <td>
                    <QualificationBadge status={x.qualification.status} />
                    {x.qualification.number && (
                      <div className="small muted">
                        {x.qualification.number}
                        {x.qualification.validUntil ? ` · until ${fmtDate(x.qualification.validUntil)}` : ''}
                        {x.qualification.conditions ? ` · ${x.qualification.conditions}` : ''}
                      </div>
                    )}
                    {activeRestrictions.some((r) => r.siteId === x.id) && <span className="badge badge-fail">suspended</span>}
                  </td>
                  <td>
                    {p.canRestrict && !activeRestrictions.some((r) => r.siteId === x.id) && (
                      <button type="button" className="btn btn-small btn-danger" onClick={() => setDialog({ suspend: x.id })}>
                        Suspend site
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>Qualification assessments</h2>
        {data.qualifications.length === 0 ? (
          <div className="empty">No assessments recorded.</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Assessment</th>
                  <th>Subject / scope</th>
                  <th>Proposed</th>
                  <th>Decision</th>
                </tr>
              </thead>
              <tbody>
                {data.qualifications.map((q) => (
                  <tr key={q.id}>
                    <td>
                      {q.number}
                      <div className="small muted">
                        {q.kind.toLowerCase()} · {q.assessor} · {fmtDate(q.createdAt)}
                      </div>
                    </td>
                    <td className="small">
                      <strong>{q.siteName ?? 'Supplier (parent) level'}</strong>
                      <div>{q.scope}</div>
                      <div className="muted">{q.findings}</div>
                      <FileLinks files={q.files} canRemove={p.canManage && q.status === 'UNDER_REVIEW'} onChanged={reload} />{' '}
                      {p.canManage && q.status === 'UNDER_REVIEW' && <UploadEvidence entityType="QUALIFICATION" entityId={q.id} label="+ Evidence" onUploaded={reload} />}
                    </td>
                    <td>
                      <QualificationBadge status={q.proposedResult} />
                    </td>
                    <td>
                      {q.status === 'DECIDED' ? (
                        <>
                          <QualificationBadge status={q.decision ?? undefined} />
                          <div className="small muted">
                            {q.decidedBy} · {fmtDate(q.decidedAt)}
                            {q.validUntil ? ` · until ${fmtDate(q.validUntil)}` : ''}
                          </div>
                          {q.conditions && <div className="small">Conditions: {q.conditions}</div>}
                        </>
                      ) : p.canQualify && q.assessorId !== me?.user.id ? (
                        <button type="button" className="btn btn-small btn-primary" onClick={() => setDialog({ decide: q })}>
                          Decide…
                        </button>
                      ) : (
                        <span className="small muted">{q.assessorId === me?.user.id ? 'Awaiting a decision by someone else' : 'Awaiting decision'}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="page-head" style={{ marginBottom: 6 }}>
          <h2>Certificates</h2>
          {p.canManage && (
            <button type="button" className="btn btn-small" onClick={() => setDialog('cert')}>
              + Certificate
            </button>
          )}
        </div>
        {data.certificates.length === 0 ? (
          <div className="empty">No certificates recorded.</div>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {data.certificates.map((c) => (
              <li key={c.id} style={{ marginBottom: 6 }}>
                <strong>{c.certType}</strong> {c.certNumber && <span className="small">#{c.certNumber}</span>} {c.issuer && <span className="small muted">({c.issuer})</span>}{' '}
                {c.siteName && <span className="small">· {c.siteName}</span>}{' '}
                {c.validUntil && <span className={`badge ${c.expired ? 'badge-fail' : ''}`}>{c.expired ? 'expired' : 'valid until'} {fmtDate(c.validUntil)}</span>}{' '}
                <FileLinks files={c.files} canRemove={p.canManage} onChanged={reload} />{' '}
                {p.canManage && <UploadEvidence entityType="CERTIFICATE" entityId={c.id} onUploaded={reload} />}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <div className="page-head" style={{ marginBottom: 6 }}>
          <h2>Exact sources</h2>
          {p.canManage && (
            <button type="button" className="btn btn-small" onClick={() => setDialog('part')}>
              + Supplier part
            </button>
          )}
        </div>
        {data.sources.length === 0 ? (
          <div className="empty">No sources. Start a sourcing request from Parts &amp; Sources.</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Part</th>
                  <th>Site</th>
                  <th>Supplier PN</th>
                  <th>Path</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.sources.map((x) => (
                  <tr key={x.id}>
                    <td>
                      <Link to={`/sources/${x.id}`}>{x.partNumber}</Link>
                      <div className="small muted">{x.description}</div>
                    </td>
                    <td>{x.site}</td>
                    <td>{x.supplierPartNumber}</td>
                    <td>{x.pathway}</td>
                    <td>
                      <SourceStatusBadge status={x.effective.status} />
                      {x.effective.reasons.map((r) => (
                        <div key={r} className="small muted">
                          {r}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.supplierParts.length > 0 && (
          <p className="small muted" style={{ marginBottom: 0 }}>
            Supplier part numbers: {data.supplierParts.map((sp) => sp.supplierPartNumber).join(', ')}
          </p>
        )}
      </section>

      <QualityContextCard
        context={data.quality}
        actions={
          can('commitment.manage') ? (
            <button type="button" className="btn btn-small" onClick={() => setCommitmentOpen(true)}>
              + Record commitment
            </button>
          ) : null
        }
      />
      <NewCommitmentDialog open={commitmentOpen} onClose={() => setCommitmentOpen(false)} supplierId={id} sources={data.sources} />

      {(data.inspections.length > 0 || data.concerns.length > 0) && (
        <section className="card">
          <h2>Receiving and quality history</h2>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {data.inspections.map((i) => (
              <li key={i.id}>
                <Link to={`/inspections/${i.id}`}>{i.number}</Link> {i.partNumber} · {fmtDate(i.dateReceived)} · <StatusBadge status={i.status} />{' '}
                {i.status === 'COMPLETED' && <OutcomeBadge outcome={i.outcome} />}
              </li>
            ))}
            {data.concerns.map((c) => (
              <li key={c.id}>
                <Link to={`/quality/${c.id}`}>{c.number}</Link> {c.title} <StatusBadge status={c.status} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <Dialog
        open={dialog === 'site'}
        title="Add manufacturing site"
        onClose={close}
        footer={
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !f.code || !f.name}
            onClick={() => void submit(() => api(`/api/suppliers/${id}/sites`, { body: { code: f.code, name: f.name, address: f.address || null, country: f.country || null } }), 'Site added')}
          >
            Add site
          </button>
        }
      >
        <div className="field">
          <label htmlFor="st-code">Site code</label>
          <input id="st-code" type="text" maxLength={20} {...field('code')} />
        </div>
        <div className="field">
          <label htmlFor="st-name">Site name</label>
          <input id="st-name" type="text" {...field('name')} />
        </div>
        <div className="field">
          <label htmlFor="st-addr">Address</label>
          <input id="st-addr" type="text" {...field('address')} />
        </div>
        <div className="field">
          <label htmlFor="st-country">Country</label>
          <input id="st-country" type="text" {...field('country')} />
        </div>
        {banner}
      </Dialog>

      <Dialog
        open={dialog === 'assess'}
        title="Record qualification assessment"
        onClose={close}
        footer={
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !f.scope || !f.findings || !f.proposedResult}
            onClick={() =>
              void submit(
                () =>
                  api(`/api/suppliers/${id}/qualifications`, {
                    body: {
                      siteId: f.siteId || null,
                      kind: f.kind || 'INITIAL',
                      scope: f.scope,
                      findings: f.findings,
                      proposedResult: f.proposedResult,
                      proposedConditions: f.proposedConditions || null,
                      proposedValidUntil: f.proposedValidUntil || null,
                    },
                  }),
                'Assessment recorded and routed for an independent decision',
              )
            }
          >
            Record assessment
          </button>
        }
      >
        <div className="field">
          <label htmlFor="qa-site">Subject</label>
          <select id="qa-site" {...field('siteId')}>
            <option value="">Supplier (parent) level — does not qualify any site</option>
            {data.sites.map((x) => (
              <option key={x.id} value={x.id}>
                Site: {x.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="qa-kind">Type</label>
          <select id="qa-kind" {...field('kind')}>
            <option value="INITIAL">Initial qualification</option>
            <option value="REASSESSMENT">Reassessment</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="qa-scope">Scope (processes, product families)</label>
          <input id="qa-scope" type="text" {...field('scope')} />
        </div>
        <div className="field">
          <label htmlFor="qa-findings">Findings</label>
          <textarea id="qa-findings" {...field('findings')} />
        </div>
        <div className="field">
          <label htmlFor="qa-proposed">Proposed result</label>
          <select id="qa-proposed" {...field('proposedResult')}>
            <option value="">Select…</option>
            <option value="QUALIFIED">Qualified</option>
            <option value="CONDITIONALLY_QUALIFIED">Conditionally qualified</option>
            <option value="REJECTED">Rejected</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="qa-cond">Proposed conditions</label>
          <input id="qa-cond" type="text" {...field('proposedConditions')} />
        </div>
        <div className="field">
          <label htmlFor="qa-valid">Proposed validity</label>
          <input id="qa-valid" type="date" {...field('proposedValidUntil')} />
        </div>
        <p className="small muted">Attach audit reports or questionnaires after recording; someone other than you must decide.</p>
        {banner}
      </Dialog>

      {dialog && typeof dialog === 'object' && 'decide' in dialog && (
        <Dialog
          open
          title={`Decide ${dialog.decide.number}`}
          onClose={close}
          footer={
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !f.decision || (f.rationale ?? '').length < 5}
              onClick={() =>
                void submit(
                  () =>
                    api(`/api/qualifications/${dialog.decide.id}/decide`, {
                      body: { expectedVersion: dialog.decide.version, decision: f.decision, conditions: f.conditions || null, validUntil: f.validUntil || null, rationale: f.rationale },
                    }),
                  'Qualification decided',
                )
              }
            >
              Record decision
            </button>
          }
        >
          <p style={{ marginTop: 0 }}>
            <strong>{dialog.decide.siteName ?? 'Supplier (parent) level'}</strong> — {dialog.decide.scope}
          </p>
          <p className="small">{dialog.decide.findings}</p>
          <p className="small muted">
            Proposed by {dialog.decide.assessor}: {dialog.decide.proposedResult.replaceAll('_', ' ').toLowerCase()}
            {dialog.decide.proposedConditions ? ` — ${dialog.decide.proposedConditions}` : ''}
          </p>
          <p className="small">
            Evidence: <FileLinks files={dialog.decide.files} />
          </p>
          <div className="field">
            <label htmlFor="qd-dec">Decision</label>
            <select id="qd-dec" {...field('decision')}>
              <option value="">Select…</option>
              <option value="QUALIFIED">Qualified</option>
              <option value="CONDITIONALLY_QUALIFIED">Conditionally qualified</option>
              <option value="REJECTED">Rejected</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="qd-cond">Conditions{f.decision === 'CONDITIONALLY_QUALIFIED' ? ' (required)' : ''}</label>
            <input id="qd-cond" type="text" {...field('conditions')} />
          </div>
          <div className="field">
            <label htmlFor="qd-valid">Valid until{f.decision === 'CONDITIONALLY_QUALIFIED' ? ' (required)' : ''}</label>
            <input id="qd-valid" type="date" {...field('validUntil')} />
          </div>
          <div className="field">
            <label htmlFor="qd-rat">Rationale</label>
            <textarea id="qd-rat" {...field('rationale')} />
          </div>
          {banner}
        </Dialog>
      )}

      {dialog && typeof dialog === 'object' && 'suspend' in dialog && (
        <Dialog
          open
          title={dialog.suspend ? `Suspend site ${data.sites.find((x) => x.id === dialog.suspend)?.name}` : 'Suspend supplier'}
          onClose={close}
          footer={
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy || (f.reason ?? '').length < 5}
              onClick={() => void submit(() => api(`/api/suppliers/${id}/restrictions`, { body: { siteId: dialog.suspend, reason: f.reason } }), 'Suspension recorded')}
            >
              Suspend
            </button>
          }
        >
          <p className="small" style={{ marginTop: 0 }}>
            Approved sources {dialog.suspend ? 'at this site' : 'of this supplier'} will show as suspended and new approvals are blocked. Existing approval records are not changed (POL-13
            interim policy).
          </p>
          <div className="field">
            <label htmlFor="sus-reason">Reason</label>
            <textarea id="sus-reason" {...field('reason')} />
          </div>
          {banner}
        </Dialog>
      )}

      {dialog && typeof dialog === 'object' && 'lift' in dialog && (
        <Dialog
          open
          title="Reinstate"
          onClose={close}
          footer={
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || (f.reason ?? '').length < 5}
              onClick={() => void submit(() => api(`/api/restrictions/${dialog.lift}/lift`, { body: { reason: f.reason } }), 'Reinstated')}
            >
              Record reinstatement
            </button>
          }
        >
          <div className="field">
            <label htmlFor="lift-reason">Reinstatement basis (evidence reviewed)</label>
            <textarea id="lift-reason" {...field('reason')} />
          </div>
          {banner}
        </Dialog>
      )}

      <Dialog
        open={dialog === 'part'}
        title="Add supplier part number"
        onClose={close}
        footer={
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !f.pn}
            onClick={() => void submit(() => api(`/api/suppliers/${id}/parts`, { body: { supplierPartNumber: f.pn, description: f.desc || null } }), 'Supplier part added')}
          >
            Add
          </button>
        }
      >
        <div className="field">
          <label htmlFor="sp-pn">Supplier part number</label>
          <input id="sp-pn" type="text" {...field('pn')} />
        </div>
        <div className="field">
          <label htmlFor="sp-desc">Description</label>
          <input id="sp-desc" type="text" {...field('desc')} />
        </div>
        {banner}
      </Dialog>

      <Dialog
        open={dialog === 'cert'}
        title="Record certificate"
        onClose={close}
        footer={
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !f.certType}
            onClick={() =>
              void submit(
                () =>
                  api(`/api/suppliers/${id}/certificates`, {
                    body: { siteId: f.siteId || null, certType: f.certType, certNumber: f.certNumber || null, issuer: f.issuer || null, validUntil: f.validUntil || null },
                  }),
                'Certificate recorded — attach the certificate file',
              )
            }
          >
            Record
          </button>
        }
      >
        <div className="field">
          <label htmlFor="ct-type">Certificate type</label>
          <input id="ct-type" type="text" placeholder="e.g. ISO 9001, IATF 16949, heat-treat accreditation" {...field('certType')} />
        </div>
        <div className="field">
          <label htmlFor="ct-site">Applies to</label>
          <select id="ct-site" {...field('siteId')}>
            <option value="">Whole supplier</option>
            {data.sites.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ct-num">Certificate number</label>
          <input id="ct-num" type="text" {...field('certNumber')} />
        </div>
        <div className="field">
          <label htmlFor="ct-issuer">Issuer</label>
          <input id="ct-issuer" type="text" {...field('issuer')} />
        </div>
        <div className="field">
          <label htmlFor="ct-valid">Valid until</label>
          <input id="ct-valid" type="date" {...field('validUntil')} />
        </div>
        {banner}
      </Dialog>
    </>
  );
}
