import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, fmtDateTime } from '../api';
import { LoadState, StatusBadge, useLoad } from '../components/ui';

interface EventRow {
  id: string;
  number: string;
  title: string;
  status: string;
  severity: string | null;
  originType: string;
  reportedAt: string;
  reportedBy: string;
  owner: string | null;
  partNumber: string | null;
  supplier: string | null;
  inspectionNumber: string | null;
}

export function QualityList() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'OPEN';
  const { data, error, loading } = useLoad<EventRow[]>(`/api/quality/events?status=${encodeURIComponent(status === 'ALL' ? '' : status)}`);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Quality</h1>
          <div className="muted small">Quick concerns and their triage. Formal NCR, containment, disposition and SCAR workflows arrive in Stage 3.</div>
        </div>
      </div>
      <div className="row-actions card" role="group" aria-label="Status filter">
        {[
          ['OPEN', 'Open'],
          ['CAPTURED', 'Awaiting triage'],
          ['TRIAGED', 'Owned'],
          ['ALL', 'All'],
        ].map(([k, label]) => (
          <button key={k} type="button" className={`btn btn-small${status === k ? ' btn-primary' : ''}`} aria-pressed={status === k} onClick={() => setParams({ status: k! })}>
            {label}
          </button>
        ))}
      </div>
      <LoadState loading={loading && !data} error={error} />
      {data && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Concern</th>
                <th>Part / supplier</th>
                <th>Origin</th>
                <th>Reported</th>
                <th>Owner</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <div className="empty">No concerns in this view. Use “+ Capture” to record one.</div>
                  </td>
                </tr>
              )}
              {data.map((e) => (
                <tr key={e.id} className="clickable" onClick={() => navigate(`/quality/${e.id}`)}>
                  <td>
                    <Link to={`/quality/${e.id}`} onClick={(ev) => ev.stopPropagation()}>
                      {e.title}
                    </Link>
                    <div className="small muted">{e.number}</div>
                  </td>
                  <td className="small">
                    {e.partNumber ?? '—'}
                    {e.supplier ? <div className="muted">{e.supplier}</div> : null}
                  </td>
                  <td className="small">{e.inspectionNumber ? `Inspection ${e.inspectionNumber}` : e.originType.replaceAll('_', ' ').toLowerCase()}</td>
                  <td className="small">
                    {fmtDateTime(e.reportedAt)}
                    <div className="muted">{e.reportedBy}</div>
                  </td>
                  <td>{e.owner ?? <span className="muted">Unassigned</span>}</td>
                  <td>
                    <StatusBadge status={e.status} />
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

interface EventDetail {
  event: Record<string, string | number | null> & { id: string; number: string; title: string; status: string; version: number };
  photos: Array<{ linkId: string; fileId: string; caption: string | null }>;
  history: Array<{ occurredAt: string; action: string; outcome: string; summary: string; reason: string | null; actor: string | null }>;
  permissions: { canTriage: boolean; triageBlockedReason: string | null };
}

export function QualityDetail() {
  const { id = '' } = useParams();
  const { data, error, loading, reload } = useLoad<EventDetail>(`/api/quality/events/${id}`);
  const owners = useLoad<Array<{ id: string; displayName: string }>>('/api/users/directory?capability=quality.capture');
  const [decision, setDecision] = useState<'TRIAGED' | 'NONCONFIRMED' | 'INFORMATIONAL'>('TRIAGED');
  const [ownerId, setOwnerId] = useState('');
  const [severity, setSeverity] = useState('');
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!data) return <LoadState loading={loading} error={error} />;
  const e = data.event;
  const field = (label: string, value: unknown) =>
    value === null || value === undefined || value === '' ? null : (
      <>
        <dt>{label}</dt>
        <dd>{String(value)}</dd>
      </>
    );
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{e.title}</h1>
          <div className="small muted">
            {e.number} · reported {fmtDateTime(e.reported_at as string)} by {e.reported_by_name as string} · <StatusBadge status={e.status} />
          </div>
        </div>
        <Link className="btn" to="/quality">
          Back to Quality
        </Link>
      </div>
      <div className="card">
        <p style={{ marginTop: 0 }}>{e.description as string}</p>
        <dl className="kv">
          {e.inspection_id ? (
            <>
              <dt>Inspection</dt>
              <dd>
                <Link to={`/inspections/${e.inspection_id}`}>{e.inspection_number as string}</Link>
                {e.unit_index !== null && Number(e.unit_index) > 0 ? ` · Item ${e.unit_index}` : ''}
              </dd>
            </>
          ) : null}
          {e.part_id ? (
            <>
              <dt>Part</dt>
              <dd>
                <Link to={`/parts/${e.part_id}`}>{e.part_number as string}</Link> — {e.part_description as string}
              </dd>
            </>
          ) : null}
          {e.supplier_id ? (
            <>
              <dt>Supplier / site</dt>
              <dd>
                <Link to={`/suppliers/${e.supplier_id}`}>{e.supplier_name as string}</Link>
                {e.site_name ? ` — ${e.site_name}` : ''}
              </dd>
            </>
          ) : null}
          {field('PO', e.po_number)}
          {field('Lot', e.lot_number)}
          {field('Serial', e.serial_number)}
          {field('Characteristic', e.characteristic)}
          {field('Expected', e.expected)}
          {field('Actual', e.actual)}
          {field('Owner', e.owner_name)}
          {field('Severity', e.severity)}
          {field('Triaged by', e.triaged_by_name)}
          {field('Triage reason', e.triage_reason)}
        </dl>
        {data.photos.length > 0 && (
          <div className="photos" style={{ marginTop: 10 }}>
            {data.photos.map((p) => (
              <a key={p.linkId} className="thumb" href={`/api/files/${p.fileId}`} target="_blank" rel="noopener noreferrer">
                <img src={`/api/files/${p.fileId}`} alt={p.caption ?? 'Concern photograph'} />
              </a>
            ))}
          </div>
        )}
      </div>

      {data.permissions.triageBlockedReason && <div className="notice notice-warn">{data.permissions.triageBlockedReason}</div>}
      {data.permissions.canTriage && (
        <form
          className="card"
          onSubmit={async (ev) => {
            ev.preventDefault();
            setMsg(null);
            try {
              await api(`/api/quality/events/${id}/triage`, {
                body: { expectedVersion: e.version, decision, ownerId: ownerId || null, severity: severity || null, reason: reason || undefined },
              });
              setMsg({ ok: true, text: 'Triage recorded.' });
              reload();
            } catch (err) {
              setMsg({ ok: false, text: (err as Error).message });
            }
          }}
        >
          <h2>Triage</h2>
          <div className="field">
            <label htmlFor="tri-decision">Decision</label>
            <select id="tri-decision" value={decision} onChange={(ev) => setDecision(ev.target.value as typeof decision)}>
              <option value="TRIAGED">Take ownership — needs follow-up</option>
              <option value="NONCONFIRMED">Not a nonconformance</option>
              <option value="INFORMATIONAL">Informational only</option>
            </select>
          </div>
          {decision === 'TRIAGED' ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
              <div className="field">
                <label htmlFor="tri-owner">Owner</label>
                <select id="tri-owner" value={ownerId} onChange={(ev) => setOwnerId(ev.target.value)} required>
                  <option value="">Select…</option>
                  {owners.data?.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.displayName}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="tri-sev">Severity</label>
                <select id="tri-sev" value={severity} onChange={(ev) => setSeverity(ev.target.value)} required>
                  <option value="">Select…</option>
                  <option>LOW</option>
                  <option>MEDIUM</option>
                  <option>HIGH</option>
                  <option>CRITICAL</option>
                </select>
              </div>
            </div>
          ) : null}
          <div className="field">
            <label htmlFor="tri-reason">Reason{decision === 'TRIAGED' ? ' (optional)' : ''}</label>
            <textarea id="tri-reason" value={reason} onChange={(ev) => setReason(ev.target.value)} required={decision !== 'TRIAGED'} />
          </div>
          <button type="submit" className="btn btn-primary">
            Record triage
          </button>
          <p className="small muted">Triage does not dispose of material. NCR confirmation, containment and disposition are separate authorized steps (Stage 3).</p>
        </form>
      )}
      {msg && <div className={`notice ${msg.ok ? 'notice-ok' : 'notice-error'}`} role={msg.ok ? 'status' : 'alert'}>{msg.text}</div>}

      <section className="card">
        <h2>History</h2>
        <ul style={{ paddingLeft: 18, margin: 0 }}>
          {data.history.map((h, i) => (
            <li key={i} className="small">
              {fmtDateTime(h.occurredAt)} — {h.actor ?? 'System'}: {h.summary}
              {h.outcome !== 'SUCCESS' ? ` (${h.outcome.toLowerCase()})` : ''}
              {h.reason ? ` — ${h.reason}` : ''}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
