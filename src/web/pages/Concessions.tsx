import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CONCESSION_STATE_TEXT, type ConcessionState } from '../../shared/quality';
import { api, fmtDate, fmtDateTime } from '../api';
import { HistoryCard, type HistoryRow, QualityTabs, RecordPdfs, type Rendition, StateBadge, addDays, todayIso } from '../components/quality';
import { FileLinks, type FileRef, UploadEvidence, useBusy } from '../components/sourcing';
import { Dialog, LoadState, useLoad } from '../components/ui';

interface ConcessionRow {
  id: string;
  number: string;
  partNumber: string;
  lotNumber: string;
  characteristic: string;
  quantityLimit: number;
  used: number;
  validFrom: string;
  validUntil: string;
  status: string;
  state: ConcessionState;
  requestedBy: string;
  ncrNumber: string | null;
}

export function ConcessionList() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const { data, error, loading } = useLoad<ConcessionRow[]>(`/api/concessions${status ? `?status=${status}` : ''}`);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Quality</h1>
          <div className="muted small">Temporary deviations (OPS-05). Each authorizes only its named lot, quantity and dates — never other shipments or later dates.</div>
        </div>
      </div>
      <QualityTabs />
      <div className="row-actions card" role="group" aria-label="Status filter">
        {[
          ['', 'All'],
          ['REQUESTED', 'Awaiting decision'],
          ['APPROVED', 'Approved'],
        ].map(([k, label]) => (
          <button key={k} type="button" className={`btn btn-small${status === k ? ' btn-primary' : ''}`} aria-pressed={status === k} onClick={() => setParams(k ? { status: k } : {})}>
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
                <th>Concession</th>
                <th>Part / lot</th>
                <th>Used</th>
                <th>Valid</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {data.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <div className="empty">No concessions. Request one from an NCR or an inspection with an Accepted result.</div>
                  </td>
                </tr>
              )}
              {data.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => navigate(`/quality/concessions/${c.id}`)}>
                  <td>
                    <Link to={`/quality/concessions/${c.id}`} onClick={(e) => e.stopPropagation()}>
                      {c.number}
                    </Link>
                    <div className="small muted">{c.characteristic}</div>
                  </td>
                  <td className="small">
                    {c.partNumber}
                    <div className="muted">Lot {c.lotNumber}</div>
                  </td>
                  <td className="small">
                    {c.used} of {c.quantityLimit}
                  </td>
                  <td className="small">
                    {fmtDate(c.validFrom)} – {fmtDate(c.validUntil)}
                  </td>
                  <td>
                    <StateBadge state={c.state} text={CONCESSION_STATE_TEXT[c.state]} />
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

interface ConcessionDetailData {
  concession: Record<string, string | number | null> & { id: string; number: string; status: string; version: number; state: ConcessionState; stateText: string; used: number };
  uses: Array<{ id: string; quantity: number; usedAt: string; usedBy: string; inspectionNumber: string | null; inspectionId: string | null; ncrNumber: string | null; ncrId: string | null; outcome: string | null }>;
  files: FileRef[];
  history: HistoryRow[];
  renditions: Rendition[];
  permissions: { decide: boolean; decideBlockedReason: string | null; withdraw: boolean; report: boolean };
}

export function ConcessionDetail() {
  const { id = '' } = useParams();
  const { data, error, loading, reload } = useLoad<ConcessionDetailData>(`/api/concessions/${id}`);
  const { busy, run, banner } = useBusy();
  const [decision, setDecision] = useState<'APPROVED' | 'REJECTED' | null>(null);
  const [text, setText] = useState('');
  if (!data) return <LoadState loading={loading} error={error} />;
  const c = data.concession;
  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            {c.number}: {c.characteristic}
          </h1>
          <div className="small muted">
            {c.part_number} · lot {c.lot_number} · requested {fmtDateTime(c.requested_at as string)} by {c.requested_by_name}
          </div>
          <StateBadge state={c.state} text={c.stateText} />
        </div>
        <Link className="btn" to="/quality/concessions">
          Back to concessions
        </Link>
      </div>
      <div className="notice notice-warn">A concession is not a specification change. It authorizes only lot {c.lot_number}, up to {c.quantity_limit} unit(s), from {fmtDate(c.valid_from as string)} to {fmtDate(c.valid_until as string)}.</div>
      <div className="card">
        <dl className="kv">
          <dt>Permitted exception</dt>
          <dd>{c.permitted_exception}</dd>
          <dt>Conditions</dt>
          <dd>{c.conditions ?? '—'}</dd>
          <dt>Justification</dt>
          <dd>{c.justification}</dd>
          <dt>Quantity</dt>
          <dd>
            {c.used} used of {c.quantity_limit}
          </dd>
          <dt>Source</dt>
          <dd>{c.source_label ?? 'Any source of this part'}</dd>
          {c.ncr_id ? (
            <>
              <dt>NCR</dt>
              <dd>
                <Link to={`/quality/ncrs/${c.ncr_id}`}>{c.ncr_number}</Link>
              </dd>
            </>
          ) : null}
          {c.inspection_id ? (
            <>
              <dt>Inspection</dt>
              <dd>
                <Link to={`/inspections/${c.inspection_id}`}>{c.inspection_number}</Link>
              </dd>
            </>
          ) : null}
          {c.decided_by_name ? (
            <>
              <dt>Decision</dt>
              <dd>
                {String(c.status).toLowerCase()} by {c.decided_by_name}, {fmtDateTime(c.decided_at as string)} — {c.decision_rationale}
              </dd>
            </>
          ) : null}
        </dl>
        <div style={{ marginTop: 8 }}>
          <FileLinks files={data.files} />{' '}
          {c.status === 'REQUESTED' && <UploadEvidence entityType="CONCESSION" entityId={id} onUploaded={reload} />}
        </div>
      </div>
      {data.permissions.decideBlockedReason && <div className="notice notice-warn">{data.permissions.decideBlockedReason}</div>}
      {(data.permissions.decide || data.permissions.withdraw) && (
        <div className="card row-actions">
          {data.permissions.decide && (
            <>
              <button type="button" className="btn btn-primary" onClick={() => setDecision('APPROVED')}>
                Approve…
              </button>
              <button type="button" className="btn btn-danger" onClick={() => setDecision('REJECTED')}>
                Reject…
              </button>
            </>
          )}
          {data.permissions.withdraw && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => {
                const reason = window.prompt('Reason for withdrawing this request');
                if (reason) void run(() => api(`/api/concessions/${id}/withdraw`, { body: { reason } }), 'Withdrawn.').then(reload);
              }}
            >
              Withdraw request
            </button>
          )}
        </div>
      )}
      {banner}
      <Dialog
        open={decision !== null}
        title={decision === 'APPROVED' ? 'Approve concession' : 'Reject concession'}
        onClose={() => setDecision(null)}
        footer={
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || text.trim().length < 5}
            onClick={async () => {
              if (await run(() => api(`/api/concessions/${id}/decide`, { body: { decision, rationale: text, expectedVersion: c.version } }), 'Decision recorded.')) {
                setDecision(null);
                setText('');
                reload();
              }
            }}
          >
            Record decision
          </button>
        }
      >
        <div className="field">
          <label htmlFor="dev-rationale">Rationale</label>
          <textarea id="dev-rationale" value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        {banner}
      </Dialog>
      <section className="card">
        <h2>Uses</h2>
        {data.uses.length === 0 ? (
          <p className="muted small">Not used yet.</p>
        ) : (
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {data.uses.map((u) => (
              <li key={u.id}>
                {u.quantity} unit(s) — {u.inspectionId ? <Link to={`/inspections/${u.inspectionId}`}>{u.inspectionNumber}</Link> : <Link to={`/quality/ncrs/${u.ncrId}`}>{u.ncrNumber}</Link>}{' '}
                {u.outcome ? `(${u.outcome.replaceAll('_', ' ').toLowerCase()})` : ''} · {u.usedBy}, {fmtDateTime(u.usedAt)}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card">
        <h2>Controlled record</h2>
        <RecordPdfs renditions={data.renditions} issueUrl={`/api/concessions/${id}/report`} docCode="OPS-05" canIssue={data.permissions.report} onIssued={reload} />
      </section>
      <HistoryCard history={data.history} />
    </>
  );
}

/** Request a bounded deviation for a named lot (FR-073). */
export function RequestConcessionDialog({
  open,
  onClose,
  partId,
  ncrId,
  inspectionId,
  lotNumber,
  characteristic,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  partId: string;
  ncrId?: string;
  inspectionId?: string;
  lotNumber?: string | null;
  characteristic?: string | null;
  onCreated: (id: string) => void;
}) {
  const [form, setForm] = useState({
    lotNumber: lotNumber ?? '',
    quantityLimit: '1',
    characteristic: characteristic ?? '',
    permittedException: '',
    conditions: '',
    justification: '',
    validFrom: todayIso(),
    validUntil: addDays(30),
  });
  const { busy, run, banner } = useBusy();
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });
  return (
    <Dialog
      open={open}
      title="Request concession"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" form="dev-form" className="btn btn-primary" disabled={busy}>
            Submit request
          </button>
        </>
      }
    >
      <form
        id="dev-form"
        onSubmit={async (e) => {
          e.preventDefault();
          let created: { id: string } | null = null;
          const ok = await run(async () => {
            created = await api<{ id: string }>('/api/concessions', {
              body: {
                partId,
                ncrId: ncrId ?? null,
                inspectionId: inspectionId ?? null,
                lotNumber: form.lotNumber,
                quantityLimit: Number(form.quantityLimit),
                characteristic: form.characteristic,
                permittedException: form.permittedException,
                conditions: form.conditions || null,
                justification: form.justification,
                validFrom: form.validFrom,
                validUntil: form.validUntil,
              },
            });
          });
          if (ok && created) onCreated((created as { id: string }).id);
        }}
      >
        <p className="small muted">Someone other than you must approve it. It covers only this lot and quantity, within its dates.</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
          <div className="field">
            <label htmlFor="dev-lot">Lot</label>
            <input id="dev-lot" type="text" value={form.lotNumber} onChange={set('lotNumber')} required />
          </div>
          <div className="field">
            <label htmlFor="dev-qty">Quantity limit</label>
            <input id="dev-qty" type="number" min={1} value={form.quantityLimit} onChange={set('quantityLimit')} required />
          </div>
          <div className="field">
            <label htmlFor="dev-from">Valid from</label>
            <input id="dev-from" type="date" value={form.validFrom} onChange={set('validFrom')} required />
          </div>
          <div className="field">
            <label htmlFor="dev-until">Valid until</label>
            <input id="dev-until" type="date" value={form.validUntil} onChange={set('validUntil')} required />
          </div>
        </div>
        <div className="field">
          <label htmlFor="dev-char">Characteristic</label>
          <input id="dev-char" type="text" value={form.characteristic} onChange={set('characteristic')} required />
        </div>
        <div className="field">
          <label htmlFor="dev-exc">Permitted exception</label>
          <textarea id="dev-exc" value={form.permittedException} onChange={set('permittedException')} required />
        </div>
        <div className="field">
          <label htmlFor="dev-cond">Conditions (optional)</label>
          <textarea id="dev-cond" value={form.conditions} onChange={set('conditions')} />
        </div>
        <div className="field">
          <label htmlFor="dev-just">Justification</label>
          <textarea id="dev-just" value={form.justification} onChange={set('justification')} required minLength={10} />
        </div>
        {banner}
      </form>
    </Dialog>
  );
}
