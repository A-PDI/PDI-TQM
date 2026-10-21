import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { fmtDate, fmtDateTime } from '../api';
import { LoadState, OutcomeBadge, StatusBadge, useLoad } from '../components/ui';

const approvalText = (s: string) => (s === 'NOT_APPROVED' ? 'Not approved' : s.replaceAll('_', ' ').toLowerCase());
const Synthetic = ({ on }: { on: boolean }) => (on ? <span className="badge badge-synthetic">fictional</span> : null);

export function PartsList() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const { data, error, loading } = useLoad<Array<{ id: string; partNumber: string; description: string; family: string | null; aliases: string | null; defaultFormNumber: string | null; isSynthetic: boolean }>>(
    `/api/parts?q=${encodeURIComponent(params.get('q') ?? '')}`,
  );
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Parts &amp; Sources</h1>
          <div className="small muted">Company parts with aliases, exact supplier/site sources and released technical baselines.</div>
        </div>
      </div>
      <form
        className="card row-actions"
        onSubmit={(e) => {
          e.preventDefault();
          setParams(q.trim() ? { q: q.trim() } : {});
        }}
      >
        <label htmlFor="parts-q" className="sr-only">
          Search parts
        </label>
        <input id="parts-q" type="search" style={{ maxWidth: 360 }} placeholder="Part number, OE alias or description" value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="submit" className="btn">
          Search
        </button>
      </form>
      <LoadState loading={loading && !data} error={error} />
      {data && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Part number</th>
                <th>Description</th>
                <th>Family</th>
                <th>Aliases</th>
                <th>Inspection form</th>
              </tr>
            </thead>
            <tbody>
              {data.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <div className="empty">No parts match.</div>
                  </td>
                </tr>
              )}
              {data.map((p) => (
                <tr key={p.id} className="clickable" onClick={() => navigate(`/parts/${p.id}`)}>
                  <td>
                    <Link to={`/parts/${p.id}`} onClick={(e) => e.stopPropagation()}>
                      {p.partNumber}
                    </Link>{' '}
                    <Synthetic on={p.isSynthetic} />
                  </td>
                  <td>{p.description}</td>
                  <td>{p.family ?? '—'}</td>
                  <td className="small">{p.aliases ?? '—'}</td>
                  <td className="small">{p.defaultFormNumber ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

interface PartDetailData {
  part: { id: string; partNumber: string; description: string; family: string | null; criticality: string; designOwner: string; defaultFormNumber: string | null; isSynthetic: boolean };
  aliases: Array<{ alias: string; aliasType: string }>;
  sources: Array<{ id: string; pathway: string; configuration: string; approvalState: string; supplierId: string; supplier: string; site: string; supplierPartNumber: string; baselineRevision: string | null; baselineStatus: string | null; baselineTitle: string | null }>;
  baselines: Array<{ id: string; title: string; ownership: string; revisionId: string; revisionLabel: string; status: string; isSynthetic: boolean; releasedAt: string | null; releasedBy: string | null; characteristics: Array<{ name: string; unit: string | null; lower: string | null; upper: string | null }> | null }>;
  inspections: Array<{ id: string; number: string; status: string; outcome: string | null; poNumber: string | null; lotNumber: string | null; dateReceived: string }>;
  concerns: Array<{ id: string; number: string; title: string; status: string }>;
}

export function PartDetail() {
  const { id = '' } = useParams();
  const { data, error, loading } = useLoad<PartDetailData>(`/api/parts/${id}`);
  if (!data) return <LoadState loading={loading} error={error} />;
  const p = data.part;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            {p.partNumber} <Synthetic on={p.isSynthetic} />
          </h1>
          <div className="muted">{p.description}</div>
        </div>
        <Link className="btn btn-primary" to="/inspections?new=1">
          New Inspection
        </Link>
      </div>
      <div className="card">
        <dl className="kv">
          <dt>Family</dt>
          <dd>{p.family ?? '—'}</dd>
          <dt>Aliases</dt>
          <dd>{data.aliases.length ? data.aliases.map((a) => `${a.alias} (${a.aliasType})`).join(', ') : '—'}</dd>
          <dt>Criticality</dt>
          <dd>{p.criticality === 'UNCLASSIFIED' ? 'Not yet classified (POL-04)' : p.criticality}</dd>
          <dt>Inspection form</dt>
          <dd>{p.defaultFormNumber ?? '—'}</dd>
        </dl>
      </div>
      <section className="card">
        <h2>Exact sources</h2>
        <p className="small muted" style={{ marginTop: 0 }}>
          Each source is one supplier + manufacturing site + supplier part + configuration + governing baseline. Source approval workflows arrive in Stage 2.
        </p>
        {data.sources.length === 0 ? (
          <div className="empty">No sources recorded.</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Supplier / site</th>
                  <th>Supplier PN</th>
                  <th>Path</th>
                  <th>Governing baseline</th>
                  <th>Approval</th>
                </tr>
              </thead>
              <tbody>
                {data.sources.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link to={`/suppliers/${s.supplierId}`}>{s.supplier}</Link>
                      <div className="small muted">{s.site}</div>
                    </td>
                    <td>{s.supplierPartNumber}</td>
                    <td>{s.pathway}</td>
                    <td className="small">{s.baselineTitle ? `${s.baselineTitle} Rev ${s.baselineRevision} (${s.baselineStatus?.toLowerCase()})` : 'None'}</td>
                    <td>
                      <span className="badge">{approvalText(s.approvalState)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card">
        <h2>Technical baselines</h2>
        {data.baselines.length === 0 ? (
          <div className="empty">No technical baseline. Measurements are recorded as observations and routed to Engineering review.</div>
        ) : (
          data.baselines.map((b) => (
            <div key={b.revisionId} style={{ marginBottom: 12 }}>
              <strong>
                {b.title} — Rev {b.revisionLabel}
              </strong>{' '}
              <StatusBadge status={b.status} /> {b.isSynthetic && <span className="badge badge-synthetic">synthetic — not PDI-approved</span>}
              <div className="small muted">
                {b.ownership === 'SUPPLIER' ? 'Supplier-owned specification' : 'PDI-owned definition'}
                {b.releasedAt ? ` · released ${fmtDateTime(b.releasedAt)} by ${b.releasedBy}` : ''}
              </div>
              {b.characteristics && (
                <ul className="small" style={{ margin: '4px 0 0' }}>
                  {b.characteristics.map((c) => (
                    <li key={c.name}>
                      {c.name}: {c.lower ?? '—'} – {c.upper ?? '—'} {c.unit}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))
        )}
      </section>
      <section className="card">
        <h2>Inspections</h2>
        {data.inspections.length === 0 ? (
          <div className="empty">No inspections yet.</div>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {data.inspections.map((i) => (
              <li key={i.id}>
                <Link to={`/inspections/${i.id}`}>{i.number}</Link> · PO {i.poNumber ?? '—'} · received {fmtDate(i.dateReceived)} · <StatusBadge status={i.status} />{' '}
                {i.status === 'COMPLETED' && <OutcomeBadge outcome={i.outcome} />}
              </li>
            ))}
          </ul>
        )}
      </section>
      {data.concerns.length > 0 && (
        <section className="card">
          <h2>Quality concerns</h2>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {data.concerns.map((c) => (
              <li key={c.id}>
                <Link to={`/quality/${c.id}`}>{c.number}</Link> {c.title} <StatusBadge status={c.status} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

export function SuppliersList() {
  const navigate = useNavigate();
  const { data, error, loading } = useLoad<Array<{ id: string; code: string; legalName: string; status: string; category: string | null; siteCount: number; sourceCount: number; isSynthetic: boolean }>>(
    '/api/suppliers',
  );
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Suppliers</h1>
          <div className="small muted">Supplier organizations and their manufacturing sites. Site qualification workflows arrive in Stage 2.</div>
        </div>
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
                    <span className="badge">{s.status.toLowerCase()}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

interface SupplierDetailData {
  supplier: { id: string; code: string; legalName: string; tradingName: string | null; status: string; category: string | null; notes: string | null; isSynthetic: boolean };
  sites: Array<{ id: string; code: string; name: string; address: string | null; country: string | null; status: string }>;
  sources: Array<{ id: string; partId: string; partNumber: string; description: string; site: string; supplierPartNumber: string; pathway: string; approvalState: string }>;
  inspections: Array<{ id: string; number: string; partNumber: string; status: string; outcome: string | null; dateReceived: string }>;
  concerns: Array<{ id: string; number: string; title: string; status: string }>;
}

export function SupplierDetail() {
  const { id = '' } = useParams();
  const { data, error, loading } = useLoad<SupplierDetailData>(`/api/suppliers/${id}`);
  if (!data) return <LoadState loading={loading} error={error} />;
  const s = data.supplier;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            {s.legalName} <Synthetic on={s.isSynthetic} />
          </h1>
          <div className="small muted">
            {s.code} · {s.category ?? 'Uncategorized'} · legal status {s.status.toLowerCase()} (separate from any site qualification)
          </div>
        </div>
        <Link className="btn" to="/suppliers">
          All suppliers
        </Link>
      </div>
      <section className="card">
        <h2>Manufacturing sites</h2>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Site</th>
                <th>Address</th>
                <th>Qualification</th>
              </tr>
            </thead>
            <tbody>
              {data.sites.map((x) => (
                <tr key={x.id}>
                  <td>
                    {x.name} <span className="small muted">{x.code}</span>
                  </td>
                  <td className="small">{[x.address, x.country].filter(Boolean).join(', ') || '—'}</td>
                  <td>
                    <span className="badge">Not assessed</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <h2>Sources</h2>
        {data.sources.length === 0 ? (
          <div className="empty">No sources.</div>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {data.sources.map((x) => (
              <li key={x.id}>
                <Link to={`/parts/${x.partId}`}>{x.partNumber}</Link> {x.description} · {x.site} · {x.supplierPartNumber} · path {x.pathway} ·{' '}
                <span className="badge">{approvalText(x.approvalState)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card">
        <h2>Recent inspections</h2>
        {data.inspections.length === 0 ? (
          <div className="empty">No inspections linked to this supplier yet.</div>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {data.inspections.map((i) => (
              <li key={i.id}>
                <Link to={`/inspections/${i.id}`}>{i.number}</Link> {i.partNumber} · {fmtDate(i.dateReceived)} · <StatusBadge status={i.status} />{' '}
                {i.status === 'COMPLETED' && <OutcomeBadge outcome={i.outcome} />}
              </li>
            ))}
          </ul>
        )}
      </section>
      {data.concerns.length > 0 && (
        <section className="card">
          <h2>Quality concerns</h2>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {data.concerns.map((c) => (
              <li key={c.id}>
                <Link to={`/quality/${c.id}`}>{c.number}</Link> {c.title} <StatusBadge status={c.status} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
