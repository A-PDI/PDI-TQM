import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, fmtDateTime } from '../api';
import { QualityTabs, UserSelect, useDirectory } from '../components/quality';
import { Dialog, LoadState, StatusBadge, useLoad } from '../components/ui';

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
          <div className="muted small">Quick concerns and their triage. A confirmed concern becomes an NCR with containment, disposition and, when needed, a SCAR.</div>
        </div>
      </div>
      <QualityTabs />
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
  ncr: { id: string; number: string; status: string } | null;
  permissions: { canTriage: boolean; canConfirmNcr: boolean; triageBlockedReason: string | null };
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
  const [confirmOpen, setConfirmOpen] = useState(false);
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

      {data.ncr && (
        <div className="notice notice-ok">
          Confirmed as <Link to={`/quality/ncrs/${data.ncr.id}`}>{data.ncr.number}</Link> — containment, disposition and closure continue there.
        </div>
      )}
      {data.permissions.canConfirmNcr && (
        <div className="card row-actions">
          <span className="small">A confirmed nonconformance needs containment and an authorized disposition before material can be used.</span>
          <button type="button" className="btn btn-primary" onClick={() => setConfirmOpen(true)}>
            Confirm as NCR…
          </button>
        </div>
      )}
      <ConfirmNcrDialog open={confirmOpen} onClose={() => setConfirmOpen(false)} eventId={id} version={e.version} defaultSeverity={(e.severity as string) ?? ''} />
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
          <p className="small muted">Triage does not dispose of material. NCR confirmation, containment and disposition are separate authorized steps.</p>
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

function ConfirmNcrDialog({ open, onClose, eventId, version, defaultSeverity }: { open: boolean; onClose: () => void; eventId: string; version: number; defaultSeverity: string }) {
  const navigate = useNavigate();
  const owners = useDirectory('ncr.manage');
  const scars = useLoad<Array<{ id: string; number: string; title: string; status: string }>>(open ? '/api/scars' : null);
  const [form, setForm] = useState({ severity: defaultSeverity, ownerId: '', failureMode: '', rationale: '', recurrenceOfScarId: '', recurrenceResponseDue: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (ev: { target: { value: string } }) => setForm({ ...form, [k]: ev.target.value });
  return (
    <Dialog
      open={open}
      title="Confirm nonconformance"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="confirm-ncr" className="btn btn-primary" disabled={busy}>
            Confirm NCR
          </button>
        </>
      }
    >
      <form
        id="confirm-ncr"
        onSubmit={async (ev) => {
          ev.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const r = await api<{ id: string }>(`/api/quality/events/${eventId}/confirm-ncr`, {
              body: {
                expectedVersion: version,
                severity: form.severity,
                ownerId: form.ownerId,
                failureMode: form.failureMode || null,
                rationale: form.rationale,
                recurrenceOfScarId: form.recurrenceOfScarId || null,
                recurrenceResponseDue: form.recurrenceResponseDue || null,
              },
            });
            navigate(`/quality/ncrs/${r.id}`);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="small muted">The NCR keeps the concern’s part, supplier, lot, expected/actual values and the same photographs — nothing is retyped.</p>
        <div className="field">
          <label htmlFor="ncr-sev">Severity</label>
          <select id="ncr-sev" value={form.severity} onChange={set('severity')} required>
            <option value="">Select…</option>
            <option>LOW</option>
            <option>MEDIUM</option>
            <option>HIGH</option>
            <option>CRITICAL</option>
          </select>
        </div>
        <UserSelect id="ncr-owner" label="NCR owner" value={form.ownerId} onChange={(v) => setForm({ ...form, ownerId: v })} users={owners} />
        <div className="field">
          <label htmlFor="ncr-mode">Failure mode (optional)</label>
          <input id="ncr-mode" type="text" value={form.failureMode} onChange={set('failureMode')} />
        </div>
        <div className="field">
          <label htmlFor="ncr-why">Confirmation rationale</label>
          <textarea id="ncr-why" value={form.rationale} onChange={set('rationale')} required minLength={5} />
        </div>
        <div className="field">
          <label htmlFor="ncr-recur">Recurrence of an earlier SCAR (optional)</label>
          <select id="ncr-recur" value={form.recurrenceOfScarId} onChange={set('recurrenceOfScarId')}>
            <option value="">Not a known recurrence</option>
            {scars.data?.map((s) => (
              <option key={s.id} value={s.id}>
                {s.number} — {s.title} ({s.status.replaceAll('_', ' ').toLowerCase()})
              </option>
            ))}
          </select>
          <div className="field-hint">A recurrence after verified implementation reopens the SCAR into a new cycle; earlier results are kept.</div>
        </div>
        {form.recurrenceOfScarId && (
          <div className="field">
            <label htmlFor="ncr-recur-due">New supplier response due</label>
            <input id="ncr-recur-due" type="date" value={form.recurrenceResponseDue} onChange={set('recurrenceResponseDue')} />
          </div>
        )}
        {error && (
          <div className="notice notice-error" role="alert">
            {error}
          </div>
        )}
      </form>
    </Dialog>
  );
}
