import { useState } from 'react';
import { Link, NavLink, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { EffectiveSourceStatus } from '../../shared/sourcing';
import { api, fmtDate, fmtDateTime } from '../api';
import { useAuth } from '../auth';
import { type QualityContext, QualityContextCard } from '../components/quality';
import { SourceStatusBadge, useBusy } from '../components/sourcing';
import { Dialog, LoadState, OutcomeBadge, StatusBadge, useLoad } from '../components/ui';

const Synthetic = ({ on }: { on: boolean }) => (on ? <span className="badge badge-synthetic">fictional</span> : null);

export function HubTabs() {
  return (
    <div className="row-actions" role="navigation" aria-label="Parts and sources sections" style={{ marginBottom: 12 }}>
      <NavLink to="/parts" end className={({ isActive }) => `btn btn-small${isActive ? ' btn-primary' : ''}`}>
        Parts
      </NavLink>
      <NavLink to="/sourcing" className={({ isActive }) => `btn btn-small${isActive ? ' btn-primary' : ''}`}>
        Sourcing requests
      </NavLink>
      <NavLink to="/sources" end className={({ isActive }) => `btn btn-small${isActive ? ' btn-primary' : ''}`}>
        Exact sources
      </NavLink>
    </div>
  );
}

export function PartsList() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const { data, error, loading } = useLoad<Array<{ id: string; partNumber: string; description: string; family: string | null; aliases: string | null; defaultFormNumber: string | null; isSynthetic: boolean }>>(
    `/api/parts?q=${encodeURIComponent(params.get('q') ?? '')}`,
  );
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ partNumber: '', description: '', family: '', defaultFormNumber: '', aliases: '' });
  const { busy, run, banner } = useBusy();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Parts &amp; Sources</h1>
          <div className="small muted">Company parts with aliases, technical baselines, sourcing requests and exact supplier/site sources.</div>
        </div>
        {can('masterdata.edit') && (
          <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
            New part
          </button>
        )}
      </div>
      <HubTabs />
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
      <Dialog
        open={open}
        title="New company part"
        onClose={() => setOpen(false)}
        footer={
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || form.partNumber.length < 2 || form.description.length < 2}
            onClick={async () => {
              let id = '';
              const ok = await run(
                async () =>
                  (id = (
                    await api<{ id: string }>('/api/parts', {
                      body: {
                        partNumber: form.partNumber,
                        description: form.description,
                        family: form.family || null,
                        defaultFormNumber: form.defaultFormNumber || null,
                        aliases: form.aliases
                          .split(',')
                          .map((a) => a.trim())
                          .filter(Boolean),
                      },
                    })
                  ).id),
              );
              if (ok) navigate(`/parts/${id}`);
            }}
          >
            Create part
          </button>
        }
      >
        <div className="field">
          <label htmlFor="np-pn">Company part number</label>
          <input id="np-pn" type="text" value={form.partNumber} onChange={(e) => setForm({ ...form, partNumber: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="np-desc">Description</label>
          <input id="np-desc" type="text" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="np-family">Family</label>
          <input id="np-family" type="text" value={form.family} onChange={(e) => setForm({ ...form, family: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="np-form">Inspection form number</label>
          <input id="np-form" type="text" placeholder="PDI-IQI-0xx" value={form.defaultFormNumber} onChange={(e) => setForm({ ...form, defaultFormNumber: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="np-alias">OE / other aliases (comma separated)</label>
          <input id="np-alias" type="text" value={form.aliases} onChange={(e) => setForm({ ...form, aliases: e.target.value })} />
        </div>
        {banner}
      </Dialog>
    </>
  );
}

interface PartDetailData {
  part: { id: string; partNumber: string; description: string; family: string | null; criticality: string; designOwner: string; defaultFormNumber: string | null; isSynthetic: boolean };
  aliases: Array<{ alias: string; aliasType: string }>;
  sources: Array<{
    id: string;
    pathway: string;
    configuration: string;
    supplierId: string;
    supplier: string;
    site: string;
    supplierPartNumber: string;
    baselineRevision: string | null;
    baselineStatus: string | null;
    baselineTitle: string | null;
    effective: { status: EffectiveSourceStatus; reasons: string[] };
  }>;
  baselines: Array<{
    id: string;
    title: string;
    ownership: string;
    revisionId: string;
    revisionLabel: string;
    status: string;
    isSynthetic: boolean;
    releasedAt: string | null;
    releasedBy: string | null;
    characteristics: Array<{ name: string; unit: string | null; lower: string | null; upper: string | null }> | null;
  }>;
  inspections: Array<{ id: string; number: string; status: string; outcome: string | null; poNumber: string | null; lotNumber: string | null; dateReceived: string }>;
  concerns: Array<{ id: string; number: string; title: string; status: string }>;
  sourcing: Array<{ id: string; number: string; title: string; pathway: string; status: string }>;
  quality: QualityContext;
}

const OWNERSHIP_TEXT: Record<string, string> = { PDI: 'PDI-owned definition', SUPPLIER: 'Supplier-owned specification', SUPPLIER_PLUS_DELTA: 'Supplier base + PDI delta' };

export function PartDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const { data, error, loading } = useLoad<PartDetailData>(`/api/parts/${id}`);
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ title: '', ownership: 'PDI', revisionLabel: 'A', baseRevisionId: '', documentRef: '' });
  const { busy, run, banner } = useBusy();
  if (!data) return <LoadState loading={loading} error={error} />;
  const p = data.part;
  const supplierReleased = data.baselines.filter((b) => b.ownership === 'SUPPLIER' && b.status === 'RELEASED');
  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            {p.partNumber} <Synthetic on={p.isSynthetic} />
          </h1>
          <div className="muted">{p.description}</div>
        </div>
        <div className="row-actions">
          {can('sourcing.manage') && (
            <Link className="btn" to={`/sourcing?new=1&partId=${p.id}`}>
              Start sourcing request
            </Link>
          )}
          {can('inspection.perform') && (
            <Link className="btn btn-primary" to="/inspections?new=1">
              New Inspection
            </Link>
          )}
        </div>
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
          Each source is one supplier + manufacturing site + supplier part + configuration + governing baseline revision, approved separately.
        </p>
        {data.sources.length === 0 ? (
          <div className="empty">No sources recorded. Start a sourcing request to identify one.</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Supplier / site</th>
                  <th>Supplier PN</th>
                  <th>Path</th>
                  <th>Governing baseline</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.sources.map((s) => (
                  <tr key={s.id} className="clickable" onClick={() => navigate(`/sources/${s.id}`)}>
                    <td>
                      <Link to={`/sources/${s.id}`} onClick={(e) => e.stopPropagation()}>
                        {s.supplier}
                      </Link>
                      <div className="small muted">{s.site}</div>
                    </td>
                    <td>{s.supplierPartNumber}</td>
                    <td>{s.pathway}</td>
                    <td className="small">{s.baselineTitle ? `${s.baselineTitle} Rev ${s.baselineRevision} (${s.baselineStatus?.toLowerCase().replace('_', ' ')})` : 'None'}</td>
                    <td>
                      <SourceStatusBadge status={s.effective.status} />
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
          <h2>Technical baselines</h2>
          {can('engineering.author') && (
            <button type="button" className="btn btn-small" onClick={() => setOpen(true)}>
              + New baseline
            </button>
          )}
        </div>
        {data.baselines.length === 0 ? (
          <div className="empty">No technical baseline. Inspection measurements are recorded as observations and routed to Engineering review.</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Baseline</th>
                  <th>Revision</th>
                  <th>Status</th>
                  <th>Released</th>
                </tr>
              </thead>
              <tbody>
                {data.baselines.map((b) => (
                  <tr key={b.revisionId} className="clickable" onClick={() => navigate(`/baselines/${b.revisionId}`)}>
                    <td>
                      <Link to={`/baselines/${b.revisionId}`} onClick={(e) => e.stopPropagation()}>
                        {b.title}
                      </Link>
                      <div className="small muted">{OWNERSHIP_TEXT[b.ownership]}</div>
                    </td>
                    <td>Rev {b.revisionLabel}</td>
                    <td>
                      <StatusBadge status={b.status} /> {b.isSynthetic && <span className="badge badge-synthetic">synthetic — not PDI-approved</span>}
                    </td>
                    <td className="small">{b.releasedAt ? `${fmtDateTime(b.releasedAt)} · ${b.releasedBy}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {data.sourcing.length > 0 && (
        <section className="card">
          <h2>Sourcing requests</h2>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {data.sourcing.map((r) => (
              <li key={r.id}>
                <Link to={`/sourcing/${r.id}`}>{r.number}</Link> {r.title} · path {r.pathway} · <span className="badge">{r.status.replaceAll('_', ' ').toLowerCase()}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <QualityContextCard context={data.quality} />
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

      <Dialog
        open={open}
        title="New technical baseline"
        onClose={() => setOpen(false)}
        footer={
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || f.title.length < 3 || !f.revisionLabel || (f.ownership === 'SUPPLIER_PLUS_DELTA' && !f.baseRevisionId)}
            onClick={async () => {
              let revisionId = '';
              const ok = await run(
                async () =>
                  (revisionId = (
                    await api<{ revisionId: string }>(`/api/parts/${id}/baselines`, {
                      body: { title: f.title, ownership: f.ownership, revisionLabel: f.revisionLabel, baseRevisionId: f.baseRevisionId || null, documentRef: f.documentRef || null },
                    })
                  ).revisionId),
              );
              if (ok) navigate(`/baselines/${revisionId}`);
            }}
          >
            Create draft
          </button>
        }
      >
        <div className="field">
          <label htmlFor="nb-title">Title (drawing / specification)</label>
          <input id="nb-title" type="text" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="nb-own">Ownership</label>
          <select id="nb-own" value={f.ownership} onChange={(e) => setF({ ...f, ownership: e.target.value })}>
            <option value="PDI">PDI-owned definition (path A)</option>
            <option value="SUPPLIER">Supplier-owned specification (path B)</option>
            <option value="SUPPLIER_PLUS_DELTA" disabled={!supplierReleased.length}>
              Supplier base + PDI delta (path C){supplierReleased.length ? '' : ' — needs a released supplier baseline'}
            </option>
          </select>
        </div>
        {f.ownership === 'SUPPLIER_PLUS_DELTA' && (
          <div className="field">
            <label htmlFor="nb-base">Exact supplier base revision</label>
            <select id="nb-base" value={f.baseRevisionId} onChange={(e) => setF({ ...f, baseRevisionId: e.target.value })}>
              <option value="">Select…</option>
              {supplierReleased.map((b) => (
                <option key={b.revisionId} value={b.revisionId}>
                  {b.title} Rev {b.revisionLabel}
                </option>
              ))}
            </select>
            <div className="field-hint">The supplier's characteristics are copied; flag PDI changes as delta.</div>
          </div>
        )}
        <div className="field">
          <label htmlFor="nb-rev">First revision label</label>
          <input id="nb-rev" type="text" maxLength={10} value={f.revisionLabel} onChange={(e) => setF({ ...f, revisionLabel: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="nb-doc">Controlling document reference</label>
          <input id="nb-doc" type="text" value={f.documentRef} onChange={(e) => setF({ ...f, documentRef: e.target.value })} />
        </div>
        {banner}
      </Dialog>
    </>
  );
}

export function SourcesList() {
  const navigate = useNavigate();
  const { data, error, loading } = useLoad<
    Array<{ id: string; partNumber: string; description: string; supplier: string; site: string; supplierPartNumber: string; pathway: string; revisionLabel: string | null; baselineTitle: string | null; effective: { status: EffectiveSourceStatus } }>
  >('/api/sources');
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Parts &amp; Sources</h1>
          <div className="small muted">Every exact source and its live status (restrictions and expiry shown on top of the recorded decision).</div>
        </div>
      </div>
      <HubTabs />
      <LoadState loading={loading && !data} error={error} />
      {data && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Part</th>
                <th>Supplier / site</th>
                <th>Supplier PN</th>
                <th>Path</th>
                <th>Governing baseline</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <div className="empty">No sources yet.</div>
                  </td>
                </tr>
              )}
              {data.map((s) => (
                <tr key={s.id} className="clickable" onClick={() => navigate(`/sources/${s.id}`)}>
                  <td>
                    <Link to={`/sources/${s.id}`} onClick={(e) => e.stopPropagation()}>
                      {s.partNumber}
                    </Link>
                    <div className="small muted">{s.description}</div>
                  </td>
                  <td>
                    {s.supplier}
                    <div className="small muted">{s.site}</div>
                  </td>
                  <td>{s.supplierPartNumber}</td>
                  <td>{s.pathway}</td>
                  <td className="small">{s.baselineTitle ? `${s.baselineTitle} Rev ${s.revisionLabel}` : '—'}</td>
                  <td>
                    <SourceStatusBadge status={s.effective.status} />
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
