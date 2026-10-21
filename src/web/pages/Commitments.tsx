import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { COMMITMENT_STATUS_TEXT, COMMUNICATION_CHANNELS } from '../../shared/quality';
import { api, fmtDate, fmtDateTime } from '../api';
import { useAuth } from '../auth';
import { HistoryCard, type HistoryRow, StateBadge, UserSelect, addDays, todayIso, useDirectory } from '../components/quality';
import { FileLinks, type FileRef, UploadEvidence, useBusy } from '../components/sourcing';
import { Dialog, LoadState, OutcomeBadge, useLoad } from '../components/ui';

interface Row {
  id: string;
  number: string;
  promisedAction: string;
  status: string;
  severity: string;
  dueDate: string | null;
  representative: string;
  supplier: string;
  owner: string;
  partNumber: string | null;
  overdue: boolean;
}

export function CommitmentList() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') ?? 'OPEN';
  const { data, error, loading } = useLoad<Row[]>(`/api/commitments?${view === 'OVERDUE' ? 'overdue=1' : view === 'ALL' ? '' : `status=${view}`}`);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Supplier commitments</h1>
          <div className="muted small">Promises made by named supplier representatives. A supplier’s “done” is a claim; PDI verifies the outcome before closing.</div>
        </div>
        <Link className="btn" to="/suppliers">
          Suppliers
        </Link>
      </div>
      <div className="row-actions card" role="group" aria-label="Commitment filter">
        {[
          ['OPEN', 'Open'],
          ['OVERDUE', 'Overdue'],
          ['VERIFIED', 'Verified'],
          ['ALL', 'All'],
        ].map(([k, label]) => (
          <button key={k} type="button" className={`btn btn-small${view === k ? ' btn-primary' : ''}`} aria-pressed={view === k} onClick={() => setParams({ view: k! })}>
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
                <th>Commitment</th>
                <th>Supplier</th>
                <th>Due</th>
                <th>Owner</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <div className="empty">No commitments in this view. Record one from the supplier’s page.</div>
                  </td>
                </tr>
              )}
              {data.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => navigate(`/commitments/${c.id}`)}>
                  <td>
                    <Link to={`/commitments/${c.id}`} onClick={(e) => e.stopPropagation()}>
                      {c.promisedAction}
                    </Link>
                    <div className="small muted">
                      {c.number} · {c.representative} · {c.severity.toLowerCase()}
                    </div>
                  </td>
                  <td className="small">
                    {c.supplier}
                    {c.partNumber ? <div className="muted">{c.partNumber}</div> : null}
                  </td>
                  <td className="small">
                    {c.dueDate ? fmtDate(c.dueDate) : 'No date'} {c.overdue && <span className="badge badge-fail">overdue</span>}
                  </td>
                  <td className="small">{c.owner}</td>
                  <td>
                    <StateBadge state={c.status} text={COMMITMENT_STATUS_TEXT[c.status]} />
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

interface Detail {
  commitment: Record<string, string | number | boolean | null> & { id: string; number: string; status: string; statusText: string; overdue: boolean };
  events: Array<{ id: string; kind: string; note: string; occurredAt: string; actor: string | null; inspectionId: string | null; inspectionNumber: string | null; inspectionOutcome: string | null }>;
  inspections: Array<{ id: string; number: string; outcome: string; dateReceived: string; lotNumber: string | null }>;
  files: FileRef[];
  history: HistoryRow[];
  rule: string;
  permissions: { manage: boolean; verify: boolean; restrictSource: boolean };
}

const EVENT_TEXT: Record<string, string> = {
  NOTE: 'Note',
  SUPPLIER_UPDATE: 'Supplier update',
  SUPPLIER_CLAIM: 'Supplier says done (claim)',
  VERIFIED: 'Verified by PDI',
  VERIFICATION_FAILED: 'Verification failed',
  REMINDER: 'Reminder',
  ESCALATED: 'Escalated',
  DUE_DATE_CHANGED: 'Target date changed',
  CANCELLED: 'Cancelled',
};

export function CommitmentDetail() {
  const { id = '' } = useParams();
  const { data, error, loading, reload } = useLoad<Detail>(`/api/commitments/${id}`);
  const { busy, run, banner } = useBusy();
  const [dialog, setDialog] = useState<'update' | 'verify' | 'cancel' | 'restrict' | null>(null);
  if (!data) return <LoadState loading={loading} error={error} />;
  const c = data.commitment;
  const done = () => {
    setDialog(null);
    reload();
  };
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{c.promised_action}</h1>
          <div className="small muted">
            {c.number} · <Link to={`/suppliers/${c.supplier_id}`}>{c.supplier_name}</Link> · {c.representative} via {String(c.channel).toLowerCase()}, {fmtDateTime(c.communicated_at as string)}
          </div>
          <StateBadge state={c.status} text={c.statusText} /> {c.overdue && <span className="badge badge-fail">overdue</span>}
        </div>
        <Link className="btn" to="/commitments">
          All commitments
        </Link>
      </div>
      <div className="card">
        <dl className="kv">
          <dt>Supplier statement</dt>
          <dd>{c.statement}</dd>
          <dt>Expected outcome</dt>
          <dd>{c.expected_outcome ?? '—'}</dd>
          <dt>How PDI verifies</dt>
          <dd>{c.verification_method}</dd>
          <dt>PDI owner</dt>
          <dd>{c.owner_name}</dd>
          <dt>Target date</dt>
          <dd>{c.due_date ? fmtDate(c.due_date as string) : `No date — ${c.no_date_reason}`}</dd>
          <dt>Severity</dt>
          <dd>{String(c.severity).toLowerCase()}</dd>
          {c.part_number && (
            <>
              <dt>Part</dt>
              <dd>
                <Link to={`/parts/${c.part_id}`}>{c.part_number}</Link>
                {c.revision_label ? ` · ${c.baseline_title} Rev ${c.revision_label}` : ''}
              </dd>
            </>
          )}
          {c.source_id && (
            <>
              <dt>Exact source</dt>
              <dd>
                <Link to={`/sources/${c.source_id}`}>Open source</Link>
                {c.site_name ? ` · ${c.site_name}` : ''}
              </dd>
            </>
          )}
          {(c.scar_number || c.ncr_number || c.change_number) && (
            <>
              <dt>Related</dt>
              <dd>
                {c.scar_number && <Link to={`/quality/scars/${c.scar_id}`}>{c.scar_number}</Link>} {c.ncr_number && <Link to={`/quality/ncrs/${c.ncr_id}`}>{c.ncr_number}</Link>}{' '}
                {c.change_number && <Link to={`/changes/${c.change_id}`}>{c.change_number}</Link>}
              </dd>
            </>
          )}
        </dl>
        <div style={{ marginTop: 8 }}>
          <FileLinks files={data.files} /> {data.permissions.manage && <UploadEvidence entityType="COMMITMENT" entityId={id} onUploaded={reload} />}
        </div>
      </div>
      <div className="card row-actions">
        {data.permissions.manage && (
          <button type="button" className="btn" onClick={() => setDialog('update')}>
            Record update…
          </button>
        )}
        {data.permissions.verify && (
          <button type="button" className="btn btn-primary" onClick={() => setDialog('verify')}>
            Verify outcome…
          </button>
        )}
        {data.permissions.restrictSource && c.status !== 'VERIFIED' && (
          <button type="button" className="btn btn-danger" onClick={() => setDialog('restrict')}>
            Restrict this source…
          </button>
        )}
        {data.permissions.manage && (
          <button type="button" className="btn btn-danger" onClick={() => setDialog('cancel')}>
            Cancel…
          </button>
        )}
        <span className="small muted">{data.rule}</span>
      </div>
      {banner}
      <section className="card">
        <h2>Activity</h2>
        {data.events.length === 0 ? (
          <p className="small muted">No activity yet.</p>
        ) : (
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {data.events.map((e) => (
              <li key={e.id}>
                {fmtDateTime(e.occurredAt)} — <strong>{EVENT_TEXT[e.kind] ?? e.kind}</strong>
                {e.actor ? ` (${e.actor})` : ' (system)'}: {e.note}
                {e.inspectionId && (
                  <>
                    {' '}
                    — <Link to={`/inspections/${e.inspectionId}`}>{e.inspectionNumber}</Link> <OutcomeBadge outcome={e.inspectionOutcome} />
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <HistoryCard history={data.history} />

      <UpdateDialog open={dialog === 'update'} id={id} onClose={() => setDialog(null)} onDone={done} />
      <VerifyCommitmentDialog open={dialog === 'verify'} id={id} inspections={data.inspections} onClose={() => setDialog(null)} onDone={done} />
      <ReasonDialog
        open={dialog === 'cancel'}
        title="Cancel commitment"
        label="Reason (the duty is dismissed with this reason and stays on record)"
        action="Cancel commitment"
        busy={busy}
        onClose={() => setDialog(null)}
        onSubmit={async (reason) => (await run(() => api(`/api/commitments/${id}/cancel`, { body: { reason } }))) && done()}
      />
      <ReasonDialog
        open={dialog === 'restrict'}
        title="Restrict exact source"
        label="Reason — new approvals and receipts from this source are held"
        action="Restrict source"
        busy={busy}
        onClose={() => setDialog(null)}
        onSubmit={async (reason) => (await run(() => api(`/api/sources/${c.source_id}/restrictions`, { body: { reason } }), 'Source restricted.')) && done()}
      />
    </>
  );
}

function ReasonDialog({ open, title, label, action, busy, onClose, onSubmit }: { open: boolean; title: string; label: string; action: string; busy: boolean; onClose: () => void; onSubmit: (r: string) => void }) {
  const [reason, setReason] = useState('');
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-primary" disabled={busy || reason.trim().length < 10} onClick={() => onSubmit(reason)}>
          {action}
        </button>
      }
    >
      <div className="field">
        <label htmlFor="reason-text">{label}</label>
        <textarea id="reason-text" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
    </Dialog>
  );
}

function UpdateDialog({ open, id, onClose, onDone }: { open: boolean; id: string; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ kind: 'SUPPLIER_UPDATE', note: '', dueDate: '' });
  const { busy, run, banner } = useBusy();
  return (
    <Dialog
      open={open}
      title="Record update"
      onClose={onClose}
      footer={
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={async () => (await run(() => api(`/api/commitments/${id}/events`, { body: { kind: f.kind, note: f.note, dueDate: f.dueDate || null } }))) && onDone()}
        >
          Record
        </button>
      }
    >
      <div className="field">
        <label htmlFor="upd-kind">Update</label>
        <select id="upd-kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
          <option value="SUPPLIER_UPDATE">Supplier update</option>
          <option value="SUPPLIER_CLAIM">Supplier says it is done (claim only)</option>
          <option value="DUE_DATE_CHANGED">Change target date</option>
          <option value="NOTE">Internal note</option>
        </select>
      </div>
      {f.kind === 'DUE_DATE_CHANGED' && (
        <div className="field">
          <label htmlFor="upd-due">New target date</label>
          <input id="upd-due" type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} />
        </div>
      )}
      <div className="field">
        <label htmlFor="upd-note">{f.kind === 'DUE_DATE_CHANGED' ? 'Reason' : 'What was said or done'}</label>
        <textarea id="upd-note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
      </div>
      {banner}
    </Dialog>
  );
}

function VerifyCommitmentDialog({ open, id, inspections, onClose, onDone }: { open: boolean; id: string; inspections: Detail['inspections']; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ result: 'VERIFIED', note: '', inspectionId: '' });
  const { busy, run, banner } = useBusy();
  return (
    <Dialog
      open={open}
      title="Verify supplier commitment"
      onClose={onClose}
      footer={
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={async () => (await run(() => api(`/api/commitments/${id}/verify`, { body: { result: f.result, note: f.note, inspectionId: f.inspectionId || null } }))) && onDone()}
        >
          Record verification
        </button>
      }
    >
      <p className="small muted">Objective PDI evidence is required to verify: a completed inspection or an attached record. A failed verification keeps the commitment open with its owner.</p>
      <div className="field">
        <label htmlFor="vc-result">Result</label>
        <select id="vc-result" value={f.result} onChange={(e) => setF({ ...f, result: e.target.value })}>
          <option value="VERIFIED">Delivered as agreed — verified</option>
          <option value="FAILED">Not delivered — verification failed</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="vc-insp">Inspection evidence (optional)</label>
        <select id="vc-insp" value={f.inspectionId} onChange={(e) => setF({ ...f, inspectionId: e.target.value })}>
          <option value="">None</option>
          {inspections.map((i) => (
            <option key={i.id} value={i.id}>
              {i.number} · lot {i.lotNumber ?? '—'} · {i.outcome} · {fmtDate(i.dateReceived)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="vc-note">Note</label>
        <textarea id="vc-note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
      </div>
      {banner}
    </Dialog>
  );
}

/** Record a supplier promise made by a named representative (FR-014, AT-18). */
export function NewCommitmentDialog({
  open,
  onClose,
  supplierId,
  sources,
}: {
  open: boolean;
  onClose: () => void;
  supplierId: string;
  sources: Array<{ id: string; partNumber: string; site: string; supplierPartNumber: string }>;
}) {
  const navigate = useNavigate();
  const { me } = useAuth();
  const owners = useDirectory('commitment.manage');
  const [f, setF] = useState({
    sourceId: '',
    representative: '',
    channel: 'CALL',
    communicatedAt: todayIso(),
    statement: '',
    promisedAction: '',
    expectedOutcome: '',
    verificationMethod: '',
    ownerId: me?.user.id ?? '',
    dueDate: addDays(14),
    noDateReason: '',
    severity: 'MEDIUM',
  });
  const { busy, run, banner } = useBusy();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Dialog
      open={open}
      title="Record supplier commitment"
      onClose={onClose}
      footer={
        <button type="submit" form="com-form" className="btn btn-primary" disabled={busy}>
          Record commitment
        </button>
      }
    >
      <form
        id="com-form"
        onSubmit={async (e) => {
          e.preventDefault();
          let id = '';
          const ok = await run(async () => {
            id = (
              await api<{ id: string }>('/api/commitments', {
                body: {
                  supplierId,
                  sourceId: f.sourceId || null,
                  representative: f.representative,
                  channel: f.channel,
                  communicatedAt: f.communicatedAt,
                  statement: f.statement,
                  promisedAction: f.promisedAction,
                  expectedOutcome: f.expectedOutcome || null,
                  verificationMethod: f.verificationMethod,
                  ownerId: f.ownerId,
                  dueDate: f.dueDate || null,
                  noDateReason: f.dueDate ? null : f.noDateReason,
                  severity: f.severity,
                },
              })
            ).id;
          });
          if (ok) navigate(`/commitments/${id}`);
        }}
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
          <div className="field">
            <label htmlFor="com-rep">Supplier representative</label>
            <input id="com-rep" type="text" value={f.representative} onChange={set('representative')} required />
          </div>
          <div className="field">
            <label htmlFor="com-channel">Channel</label>
            <select id="com-channel" value={f.channel} onChange={set('channel')}>
              {COMMUNICATION_CHANNELS.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="com-when">When</label>
            <input id="com-when" type="date" value={f.communicatedAt} onChange={set('communicatedAt')} required />
          </div>
        </div>
        <div className="field">
          <label htmlFor="com-source">Exact source (optional)</label>
          <select id="com-source" value={f.sourceId} onChange={set('sourceId')}>
            <option value="">Supplier-wide</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.partNumber} — {s.site} ({s.supplierPartNumber})
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="com-statement">What the supplier said</label>
          <textarea id="com-statement" value={f.statement} onChange={set('statement')} required />
        </div>
        <div className="field">
          <label htmlFor="com-action">Promised action</label>
          <input id="com-action" type="text" value={f.promisedAction} onChange={set('promisedAction')} required />
        </div>
        <div className="field">
          <label htmlFor="com-outcome">Expected outcome (optional)</label>
          <input id="com-outcome" type="text" value={f.expectedOutcome} onChange={set('expectedOutcome')} />
        </div>
        <div className="field">
          <label htmlFor="com-verify">How PDI will verify</label>
          <input id="com-verify" type="text" value={f.verificationMethod} onChange={set('verificationMethod')} required />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
          <UserSelect id="com-owner" label="PDI owner" value={f.ownerId} onChange={(v) => setF({ ...f, ownerId: v })} users={owners} />
          <div className="field">
            <label htmlFor="com-due">Target date</label>
            <input id="com-due" type="date" value={f.dueDate} onChange={set('dueDate')} />
          </div>
          <div className="field">
            <label htmlFor="com-sev">Severity</label>
            <select id="com-sev" value={f.severity} onChange={set('severity')}>
              <option>LOW</option>
              <option>MEDIUM</option>
              <option>HIGH</option>
            </select>
          </div>
        </div>
        {!f.dueDate && (
          <div className="field">
            <label htmlFor="com-nodate">Why there is no target date</label>
            <input id="com-nodate" type="text" value={f.noDateReason} onChange={set('noDateReason')} required />
          </div>
        )}
        {banner}
      </form>
    </Dialog>
  );
}
