import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiError, api, fmtDate } from '../api';
import { useAuth } from '../auth';
import { Dialog, LoadState, OutcomeBadge, type PartOption, PartTypeahead, StatusBadge, useLoad } from '../components/ui';

interface ListData {
  items: Array<{
    id: string;
    number: string;
    partNumber: string;
    partDescription: string;
    poNumber: string | null;
    lotNumber: string | null;
    dateReceived: string;
    status: string;
    unitCount: number;
    outcome: string | null;
    inspector: string;
    formNumber: string;
    formRevision: string | null;
  }>;
  total: number;
  page: number;
  pageSize: number;
  statusCounts: Record<string, number>;
}

const FILTERS: Array<[string, string]> = [
  ['', 'All'],
  ['OPEN', 'Open'],
  ['READY_FOR_REVIEW', 'Pending review'],
  ['COMPLETED', 'Completed'],
];

export function Inspections() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const query = new URLSearchParams();
  for (const k of ['q', 'status', 'outcome', 'mine', 'page']) {
    const v = params.get(k);
    if (v) query.set(k, v);
  }
  const { data, error, loading } = useLoad<ListData>(`/api/inspections?${query.toString()}`);
  const launchOpen = params.get('new') === '1';
  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!('page' in patch)) next.delete('page');
    setParams(next);
  };
  const counts = data?.statusCounts ?? {};
  const countFor = (k: string) =>
    k === '' ? Object.values(counts).reduce((a, b) => a + b, 0) : k === 'OPEN' ? (counts.DRAFT ?? 0) + (counts.PARTIAL ?? 0) : (counts[k] ?? 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Inspections</h1>
          <div className="muted small">Receiving inspections, newest first.</div>
        </div>
        <div className="row-actions">
          {can('forms.publish') && (
            <Link className="btn" to="/forms">
              Forms
            </Link>
          )}
          {can('inspection.perform') && (
            <button type="button" className="btn btn-primary" onClick={() => update({ new: '1' })}>
              New Inspection
            </button>
          )}
        </div>
      </div>
      <div className="card">
        <form
          className="row-actions"
          onSubmit={(e) => {
            e.preventDefault();
            update({ q: q.trim() || null });
          }}
        >
          <label htmlFor="insp-q" className="sr-only">
            Search inspections
          </label>
          <input id="insp-q" type="search" style={{ maxWidth: 360 }} placeholder="Part, alias, PO, lot, serial or inspection no." value={q} onChange={(e) => setQ(e.target.value)} />
          <button type="submit" className="btn">
            Search
          </button>
          <span className="row-actions" role="group" aria-label="Status filter">
            {FILTERS.map(([k, label]) => (
              <button
                key={k}
                type="button"
                className={`btn btn-small${(params.get('status') ?? '') === k ? ' btn-primary' : ''}`}
                aria-pressed={(params.get('status') ?? '') === k}
                onClick={() => update({ status: k || null })}
              >
                {label} <span className="small">({countFor(k)})</span>
              </button>
            ))}
          </span>
          <label className="small" style={{ display: 'inline-flex', gap: 6, alignItems: 'center', margin: 0 }}>
            <input type="checkbox" checked={params.get('mine') === '1'} onChange={(e) => update({ mine: e.target.checked ? '1' : null })} /> Mine only
          </label>
        </form>
      </div>
      <LoadState loading={loading && !data} error={error} />
      {data && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Part</th>
                <th>Form</th>
                <th>PO</th>
                <th>Received</th>
                <th>Items</th>
                <th>Inspector</th>
                <th>Status</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {data.items.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    <div className="empty">No inspections match. {can('inspection.perform') && 'Start one with New Inspection.'}</div>
                  </td>
                </tr>
              )}
              {data.items.map((i) => (
                <tr key={i.id} className="clickable" onClick={() => navigate(`/inspections/${i.id}`)}>
                  <td>
                    <Link to={`/inspections/${i.id}`} onClick={(e) => e.stopPropagation()}>
                      {i.partNumber}
                    </Link>
                    <div className="small muted">
                      {i.partDescription} · {i.number}
                    </div>
                  </td>
                  <td className="small">
                    {i.formNumber}
                    {i.formRevision ? ` Rev ${i.formRevision}` : ''}
                  </td>
                  <td>{i.poNumber ?? <span className="muted">—</span>}</td>
                  <td>{fmtDate(i.dateReceived)}</td>
                  <td>{i.unitCount}</td>
                  <td>{i.inspector}</td>
                  <td>
                    <StatusBadge status={i.status} />
                  </td>
                  <td>{i.status === 'COMPLETED' || i.status === 'READY_FOR_REVIEW' ? <OutcomeBadge outcome={i.outcome} /> : <span className="muted">—</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.total > data.pageSize && (
            <div className="row-actions" style={{ padding: 10 }}>
              <button type="button" className="btn btn-small" disabled={data.page <= 1} onClick={() => update({ page: String(data.page - 1) })}>
                Previous page
              </button>
              <span className="small muted">
                Page {data.page} of {Math.ceil(data.total / data.pageSize)} · {data.total} inspections
              </span>
              <button type="button" className="btn btn-small" disabled={data.page * data.pageSize >= data.total} onClick={() => update({ page: String(data.page + 1) })}>
                Next page
              </button>
            </div>
          )}
        </div>
      )}
      <LaunchDialog open={launchOpen} onClose={() => update({ new: null })} />
    </>
  );
}

interface FormOption {
  revisionId: string;
  formNumber: string;
  component: string;
  revisionLabel: string | null;
}
interface LaunchOptions {
  suggestedFormNumber: string | null;
  sources: Array<{ id: string; supplier: string; site: string; supplierPartNumber: string; approvalState: string; pathway: string }>;
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function LaunchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { me, can } = useAuth();
  const navigate = useNavigate();
  const forms = useLoad<FormOption[]>(open ? '/api/forms' : null);
  const inspectors = useLoad<Array<{ id: string; displayName: string }>>(open && can('inspection.assign') ? '/api/users/directory?capability=inspection.perform' : null);
  const [part, setPart] = useState<PartOption | null>(null);
  const [options, setOptions] = useState<LaunchOptions | null>(null);
  const [formId, setFormId] = useState('');
  const [units, setUnits] = useState('1');
  const [po, setPo] = useState('');
  const [received, setReceived] = useState(today());
  const [inspectorId, setInspectorId] = useState('');
  const [showMore, setShowMore] = useState(false);
  const [sourceId, setSourceId] = useState('');
  const [lot, setLot] = useState('');
  const [lotSize, setLotSize] = useState('');
  const [sampling, setSampling] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [oneOff, setOneOff] = useState({ component: '', reason: '', receivingFrom: '', visual: '', dimensional: '' });
  const isOneOff = formId === 'ONE_OFF';
  const lines = (text: string) =>
    text
      .split('\n')
      .map((l) => l.split('|').map((x) => x.trim()))
      .filter((p) => p[0]);

  useEffect(() => {
    if (!part) {
      setOptions(null);
      setSourceId('');
      return;
    }
    api<LaunchOptions>(`/api/parts/${part.id}/launch-options`)
      .then((o) => {
        setOptions(o);
        const suggested = forms.data?.find((f) => f.formNumber === o.suggestedFormNumber);
        if (suggested) setFormId(suggested.revisionId);
        if (o.sources.length === 1) setSourceId(o.sources[0]!.id);
      })
      .catch(() => setOptions(null));
  }, [part, forms.data]);

  const unitCount = Number(units);
  const valid =
    part &&
    formId &&
    Number.isInteger(unitCount) &&
    unitCount >= 1 &&
    unitCount <= 100 &&
    received &&
    (!isOneOff || (oneOff.component.trim() && oneOff.reason.trim().length >= 10 && (oneOff.receivingFrom || forms.data?.find((f) => f.formNumber === options?.suggestedFormNumber)) && (oneOff.visual.trim() || oneOff.dimensional.trim())));
  const selectedSource = options?.sources.find((s) => s.id === sourceId);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const common = {
        unitCount,
        poNumber: po || null,
        dateReceived: received,
        sourceId: sourceId || null,
        lotNumber: lot || null,
        lotSize: lotSize ? Number(lotSize) : null,
        samplingNote: sampling || null,
      };
      if (isOneOff) {
        const created = await api<{ id: string }>('/api/inspections/one-off', {
          body: {
            ...common,
            partId: part!.id,
            component: oneOff.component,
            reason: oneOff.reason,
            receivingFromRevisionId: oneOff.receivingFrom || forms.data?.find((f) => f.formNumber === options?.suggestedFormNumber)?.revisionId,
            visualRows: lines(oneOff.visual).map(([name, acceptance]) => ({ name, acceptance: acceptance || undefined })),
            dimensionalRows: lines(oneOff.dimensional).map(([name, unit]) => ({ name, unit: unit || undefined })),
          },
        });
        navigate(`/inspections/${created.id}`);
        return;
      }
      const created = await api<{ id: string }>('/api/inspections', {
        body: {
          partId: part!.id,
          formRevisionId: formId,
          unitCount,
          poNumber: po || null,
          dateReceived: received,
          inspectorId: inspectorId || null,
          sourceId: sourceId || null,
          lotNumber: lot || null,
          lotSize: lotSize ? Number(lotSize) : null,
          samplingNote: sampling || null,
        },
      });
      navigate(`/inspections/${created.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start the inspection');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      title="New Inspection"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={!valid || busy} onClick={() => void start()}>
            Start inspection
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="part-number">Part Number</label>
        <PartTypeahead value={part} onSelect={setPart} autoFocus />
        {part && <div className="field-hint">{part.description}</div>}
      </div>
      <div className="field">
        <label htmlFor="launch-form">Inspection Form</label>
        <select id="launch-form" value={formId} onChange={(e) => setFormId(e.target.value)}>
          <option value="">Select form…</option>
          {forms.data?.map((f) => (
            <option key={f.revisionId} value={f.revisionId}>
              {f.formNumber} — {f.component}
              {f.revisionLabel ? ` (Rev ${f.revisionLabel})` : ''}
            </option>
          ))}
          <option value="ONE_OFF">One-off inspection (no catalogue form)…</option>
        </select>
        {options?.suggestedFormNumber && <div className="field-hint">Suggested for this part: {options.suggestedFormNumber}</div>}
      </div>
      {isOneOff && (
        <fieldset className="card" style={{ margin: '0 0 12px' }}>
          <legend className="small" style={{ fontWeight: 600 }}>
            One-off form — always independently reviewed; never becomes a released template
          </legend>
          <div className="field">
            <label htmlFor="oo-component">Component</label>
            <input id="oo-component" type="text" value={oneOff.component} onChange={(e) => setOneOff({ ...oneOff, component: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="oo-reason">Why a one-off form is needed</label>
            <input id="oo-reason" type="text" value={oneOff.reason} onChange={(e) => setOneOff({ ...oneOff, reason: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="oo-recv">Copy receiving checklist from</label>
            <select id="oo-recv" value={oneOff.receivingFrom} onChange={(e) => setOneOff({ ...oneOff, receivingFrom: e.target.value })}>
              <option value="">{options?.suggestedFormNumber ? `Suggested form (${options.suggestedFormNumber})` : 'Select form…'}</option>
              {forms.data?.map((f) => (
                <option key={f.revisionId} value={f.revisionId}>
                  {f.formNumber} — {f.component}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="oo-visual">Visual checks (one per line: name | acceptance)</label>
            <textarea id="oo-visual" value={oneOff.visual} onChange={(e) => setOneOff({ ...oneOff, visual: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="oo-dim">Measurements (one per line: name | unit)</label>
            <textarea id="oo-dim" value={oneOff.dimensional} onChange={(e) => setOneOff({ ...oneOff, dimensional: e.target.value })} />
            <div className="field-hint">No limits are invented: readings are recorded as observations for Engineering review.</div>
          </div>
        </fieldset>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
        <div className="field">
          <label htmlFor="launch-units">Number of Items (1–100)</label>
          <input id="launch-units" type="number" min={1} max={100} inputMode="numeric" value={units} onChange={(e) => setUnits(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="launch-po">PO Number</label>
          <input id="launch-po" type="text" value={po} onChange={(e) => setPo(e.target.value)} maxLength={60} />
        </div>
        <div className="field">
          <label htmlFor="launch-date">Date Received</label>
          <input id="launch-date" type="date" value={received} onChange={(e) => setReceived(e.target.value)} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="launch-inspector">Inspector</label>
        {can('inspection.assign') ? (
          <select id="launch-inspector" value={inspectorId} onChange={(e) => setInspectorId(e.target.value)}>
            <option value="">{me?.user.displayName} (me)</option>
            {inspectors.data
              ?.filter((u) => u.id !== me?.user.id)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName}
                </option>
              ))}
          </select>
        ) : (
          <input id="launch-inspector" type="text" value={me?.user.displayName ?? ''} readOnly />
        )}
      </div>
      <button type="button" className="btn-link" aria-expanded={showMore} onClick={() => setShowMore((s) => !s)}>
        {showMore ? 'Hide' : 'Add'} supplier, lot and sampling details
      </button>
      {showMore && (
        <div style={{ marginTop: 10 }}>
          <div className="field">
            <label htmlFor="launch-source">Supplier / site source</label>
            <select id="launch-source" value={sourceId} onChange={(e) => setSourceId(e.target.value)} disabled={!options}>
              <option value="">Not identified</option>
              {options?.sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.supplier} — {s.site} · {s.supplierPartNumber}
                </option>
              ))}
            </select>
            {part && options && options.sources.length === 0 && <div className="field-hint">No exact source is on record for this part; the inspection can still be captured.</div>}
            {selectedSource && selectedSource.approvalState !== 'APPROVED' && (
              <div className="notice notice-warn small">This source is not approved. Results are recorded; material stays on hold pending authorized disposition.</div>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
            <div className="field">
              <label htmlFor="launch-lot">Lot / shipment</label>
              <input id="launch-lot" type="text" value={lot} onChange={(e) => setLot(e.target.value)} maxLength={80} />
            </div>
            <div className="field">
              <label htmlFor="launch-lotsize">Lot size</label>
              <input id="launch-lotsize" type="number" min={1} inputMode="numeric" value={lotSize} onChange={(e) => setLotSize(e.target.value)} />
            </div>
          </div>
          <div className="field">
            <label htmlFor="launch-sampling">Sampling note</label>
            <input id="launch-sampling" type="text" value={sampling} onChange={(e) => setSampling(e.target.value)} maxLength={500} />
            <div className="field-hint">No sampling plan is generated until PDI approves one (POL-03).</div>
          </div>
        </div>
      )}
      {error && (
        <div className="notice notice-error" role="alert">
          {error}
        </div>
      )}
    </Dialog>
  );
}
