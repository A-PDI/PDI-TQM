import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { SCAR_STATUS_TEXT } from '../../shared/quality';
import { api, fmtDate, fmtDateTime } from '../api';
import { HistoryCard, type HistoryRow, QualityTabs, RecordPdfs, type Rendition, StateBadge, UserSelect, addDays, todayIso, useDirectory } from '../components/quality';
import { FileLinks, type FileRef, UploadEvidence, useBusy } from '../components/sourcing';
import { Dialog, LoadState, OutcomeBadge, useLoad } from '../components/ui';

const CHANNELS = ['EMAIL', 'PORTAL', 'MEETING', 'CALL', 'MAIL', 'OTHER'];

export function ScarList() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'OPEN';
  const { data, error, loading } = useLoad<Array<{ id: string; number: string; title: string; status: string; cycle: number; responseDue: string; supplier: string; owner: string; overdue: boolean }>>(
    `/api/scars?status=${status === 'ALL' ? '' : status}`,
  );
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Quality</h1>
          <div className="muted small">Supplier corrective actions (OPS-07/08). A supplier’s response is its stated position; only PDI verification advances a SCAR.</div>
        </div>
      </div>
      <QualityTabs />
      <div className="row-actions card" role="group" aria-label="Status filter">
        {[
          ['OPEN', 'Open'],
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
                <th>SCAR</th>
                <th>Supplier</th>
                <th>Response due</th>
                <th>Owner</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <div className="empty">No SCARs in this view. Issue one from an NCR when the supplier must act.</div>
                  </td>
                </tr>
              )}
              {data.map((s) => (
                <tr key={s.id} className="clickable" onClick={() => navigate(`/quality/scars/${s.id}`)}>
                  <td>
                    <Link to={`/quality/scars/${s.id}`} onClick={(e) => e.stopPropagation()}>
                      {s.title}
                    </Link>
                    <div className="small muted">
                      {s.number}
                      {s.cycle > 1 ? ` · cycle ${s.cycle}` : ''}
                    </div>
                  </td>
                  <td className="small">{s.supplier}</td>
                  <td className="small">
                    {fmtDate(s.responseDue)} {s.overdue && <span className="badge badge-fail">overdue</span>}
                  </td>
                  <td className="small">{s.owner}</td>
                  <td>
                    <StateBadge state={s.status} />
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

interface ScarData {
  scar: Record<string, string | number | null> & { id: string; number: string; status: string; cycle: number; statusText: string; effectiveness_plan: string | null };
  responses: Array<Record<string, string | number | boolean | null>>;
  verifications: Array<Record<string, string | number | null> & { inspections: Array<{ id: string; number: string; outcome: string }> }>;
  ncrs: Array<{ id: string; number: string; title: string; status: string; relation: string }>;
  reopens: Array<{ id: string; ncr_number: string; from_status: string; to_cycle: number; reason: string; reopened_by_name: string; reopened_at: string }>;
  commitments: Array<{ id: string; number: string; promisedAction: string; status: string }>;
  inspections: Array<{ id: string; number: string; outcome: string; dateReceived: string; lotNumber: string | null; completedAt: string }>;
  files: FileRef[];
  history: HistoryRow[];
  renditions: Rendition[];
  permissions: { manage: boolean; verify: boolean; effectivenessBlockedReason: string | null; close: boolean };
}

export function ScarDetail() {
  const { id = '' } = useParams();
  const { data, error, loading, reload } = useLoad<ScarData>(`/api/scars/${id}`);
  const { busy, run, banner } = useBusy();
  const [dialog, setDialog] = useState<'response' | 'verify' | 'plan' | 'close' | null>(null);
  if (!data) return <LoadState loading={loading} error={error} />;
  const s = data.scar;
  const done = () => {
    setDialog(null);
    reload();
  };
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{s.title}</h1>
          <div className="small muted">
            {s.number} · {s.supplier_name}
            {s.site_name ? ` / ${s.site_name}` : ''} · issued {fmtDateTime(s.issued_at as string)} by {s.issued_by_name} · cycle {s.cycle}
          </div>
          <StateBadge state={s.status} text={s.statusText} />
        </div>
        <Link className="btn" to="/quality/scars">
          Back to SCARs
        </Link>
      </div>
      <div className="card">
        <dl className="kv">
          <dt>Problem</dt>
          <dd>{s.problem_statement}</dd>
          <dt>Requested</dt>
          <dd>{s.requested_actions ?? '—'}</dd>
          <dt>Sent to</dt>
          <dd>
            {s.sent_to} via {String(s.sent_via).toLowerCase()}
          </dd>
          <dt>Response due</dt>
          <dd>{fmtDate(s.response_due as string)}</dd>
          <dt>PDI owner</dt>
          <dd>{s.owner_name}</dd>
          <dt>Nonconformances</dt>
          <dd>
            {data.ncrs.map((n, i) => (
              <span key={n.id}>
                {i > 0 && ', '}
                <Link to={`/quality/ncrs/${n.id}`}>{n.number}</Link> ({n.relation.toLowerCase()}, {n.status.replaceAll('_', ' ').toLowerCase()})
              </span>
            ))}
            {!data.ncrs.length && '—'}
          </dd>
        </dl>
        <div style={{ marginTop: 8 }}>
          <FileLinks files={data.files} /> {data.permissions.manage && <UploadEvidence entityType="SCAR" entityId={id} onUploaded={reload} />}
        </div>
      </div>
      <div className="card row-actions">
        {data.permissions.manage && ['ISSUED', 'RESPONSE_RECEIVED'].includes(s.status) && (
          <button type="button" className="btn btn-primary" onClick={() => setDialog('response')}>
            Record supplier response…
          </button>
        )}
        {data.permissions.manage && !['EFFECTIVENESS_VERIFIED', 'CLOSED'].includes(s.status) && (
          <button type="button" className="btn" onClick={() => setDialog('plan')}>
            {s.effectiveness_plan ? 'Edit effectiveness plan…' : 'Set effectiveness plan…'}
          </button>
        )}
        {data.permissions.verify && ['RESPONSE_RECEIVED', 'IMPLEMENTATION_VERIFIED'].includes(s.status) && (
          <button type="button" className="btn btn-primary" onClick={() => setDialog('verify')}>
            {s.status === 'RESPONSE_RECEIVED' ? 'Verify implementation…' : 'Verify effectiveness…'}
          </button>
        )}
        {data.permissions.close && s.status === 'EFFECTIVENESS_VERIFIED' && (
          <button type="button" className="btn btn-primary" onClick={() => setDialog('close')}>
            Close SCAR…
          </button>
        )}
        <span className="small muted">{SCAR_STATUS_TEXT[s.status]}</span>
      </div>
      {banner}

      {data.reopens.length > 0 && (
        <section className="card">
          <h2>Recurrence</h2>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {data.reopens.map((r) => (
              <li key={r.id}>
                {fmtDateTime(r.reopened_at)}: {r.ncr_number} reopened the SCAR from {r.from_status.replaceAll('_', ' ').toLowerCase()} into cycle {r.to_cycle} — {r.reason} ({r.reopened_by_name})
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h2>Supplier responses</h2>
        {data.responses.length === 0 ? (
          <p className="muted small">No response recorded.</p>
        ) : (
          data.responses.map((r) => (
            <div key={String(r.id)} style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 8 }}>
              <div className="small muted">
                Revision {r.revision} (cycle {r.cycle}) from {r.representative} via {String(r.channel).toLowerCase()}, {fmtDateTime(r.received_at as string)} — recorded by {r.recorded_by_name}
                {r.supplier_claims_done ? <span className="badge badge-accepted" style={{ marginLeft: 6 }}>supplier says done — not verified</span> : null}
              </div>
              <dl className="kv" style={{ marginTop: 6 }}>
                {r.team ? (
                  <>
                    <dt>D1 Team</dt>
                    <dd>{r.team}</dd>
                  </>
                ) : null}
                {r.problem_description ? (
                  <>
                    <dt>D2 Problem</dt>
                    <dd>{r.problem_description}</dd>
                  </>
                ) : null}
                <dt>D3 Containment</dt>
                <dd>{r.containment}</dd>
                <dt>D4 Root cause</dt>
                <dd>{r.root_cause}</dd>
                <dt>D5 Corrective action</dt>
                <dd>{r.corrective_action}</dd>
                {r.implementation ? (
                  <>
                    <dt>D6 Implementation</dt>
                    <dd>{r.implementation}</dd>
                  </>
                ) : null}
                {r.prevention ? (
                  <>
                    <dt>D7 Prevention</dt>
                    <dd>{r.prevention}</dd>
                  </>
                ) : null}
              </dl>
            </div>
          ))
        )}
      </section>

      <section className="card">
        <h2>PDI verification</h2>
        <p className="small">
          <strong>Effectiveness plan:</strong> {s.effectiveness_plan ?? <span className="muted">not set</span>}
        </p>
        {data.permissions.effectivenessBlockedReason && s.status === 'IMPLEMENTATION_VERIFIED' && <div className="notice notice-warn">{data.permissions.effectivenessBlockedReason}</div>}
        {data.verifications.length === 0 ? (
          <p className="muted small">Not verified yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Result</th>
                  <th>Method / evidence</th>
                  <th>Inspections</th>
                  <th>By</th>
                </tr>
              </thead>
              <tbody>
                {data.verifications.map((v) => (
                  <tr key={String(v.id)}>
                    <td>
                      {String(v.kind).toLowerCase()} <span className="small muted">cycle {v.cycle}</span>
                    </td>
                    <td>
                      <StateBadge state={String(v.result)} />
                    </td>
                    <td className="small">
                      {v.method}: {v.evidence}
                      {v.population_note ? <div className="muted">{v.population_note}</div> : null}
                    </td>
                    <td className="small">
                      {v.inspections.map((i) => (
                        <div key={i.id}>
                          <Link to={`/inspections/${i.id}`}>{i.number}</Link> <OutcomeBadge outcome={i.outcome} />
                        </div>
                      ))}
                    </td>
                    <td className="small">
                      {v.verified_by_name}
                      <div className="muted">{fmtDateTime(v.verified_at as string)}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {data.commitments.length > 0 && (
        <section className="card">
          <h2>Supplier commitments</h2>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {data.commitments.map((c) => (
              <li key={c.id}>
                <Link to={`/commitments/${c.id}`}>{c.number}</Link> — {c.promisedAction} <StateBadge state={c.status} />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h2>Controlled record</h2>
        <RecordPdfs renditions={data.renditions} issueUrl={`/api/scars/${id}/report`} docCode="OPS-07" canIssue={data.permissions.manage || data.scar.status === 'CLOSED'} onIssued={reload} />
      </section>
      <HistoryCard history={data.history} />

      <ResponseDialog open={dialog === 'response'} onClose={() => setDialog(null)} scarId={id} onDone={done} />
      <PlanDialog open={dialog === 'plan'} onClose={() => setDialog(null)} scarId={id} plan={s.effectiveness_plan} onDone={done} />
      <VerifyDialog
        open={dialog === 'verify'}
        onClose={() => setDialog(null)}
        scarId={id}
        kind={s.status === 'RESPONSE_RECEIVED' ? 'IMPLEMENTATION' : 'EFFECTIVENESS'}
        inspections={data.inspections}
        onDone={done}
      />
      <Dialog
        open={dialog === 'close'}
        title="Close SCAR"
        onClose={() => setDialog(null)}
        footer={
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={async () => {
              const note = (document.getElementById('scar-close-note') as HTMLTextAreaElement | null)?.value ?? '';
              if (await run(() => api(`/api/scars/${id}/close`, { body: { note } }), 'SCAR closed.')) done();
            }}
          >
            Close SCAR
          </button>
        }
      >
        <div className="field">
          <label htmlFor="scar-close-note">Closure note</label>
          <textarea id="scar-close-note" />
        </div>
        {banner}
      </Dialog>
    </>
  );
}

function ResponseDialog({ open, onClose, scarId, onDone }: { open: boolean; onClose: () => void; scarId: string; onDone: () => void }) {
  const [f, setF] = useState({ receivedAt: todayIso(), channel: 'EMAIL', representative: '', team: '', problemDescription: '', containment: '', rootCause: '', correctiveAction: '', implementation: '', prevention: '', supplierClaimsDone: false });
  const { busy, run, banner } = useBusy();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const area = (k: keyof typeof f, label: string, required = false) => (
    <div className="field">
      <label htmlFor={`resp-${k}`}>{label}</label>
      <textarea id={`resp-${k}`} value={f[k] as string} onChange={set(k)} required={required} />
    </div>
  );
  return (
    <Dialog
      open={open}
      title="Record supplier response"
      onClose={onClose}
      footer={
        <button type="submit" form="resp-form" className="btn btn-primary" disabled={busy}>
          Record response
        </button>
      }
    >
      <form
        id="resp-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await run(() => api(`/api/scars/${scarId}/responses`, { body: { ...f, team: f.team || null, problemDescription: f.problemDescription || null, implementation: f.implementation || null, prevention: f.prevention || null } })))
            onDone();
        }}
      >
        <p className="small muted">Record what the supplier stated (8D-style fields; only D3–D5 are required). This is the supplier’s position, not PDI verification.</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
          <div className="field">
            <label htmlFor="resp-date">Received</label>
            <input id="resp-date" type="date" value={f.receivedAt} onChange={set('receivedAt')} required />
          </div>
          <div className="field">
            <label htmlFor="resp-channel">Channel</label>
            <select id="resp-channel" value={f.channel} onChange={set('channel')}>
              {CHANNELS.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="resp-rep">Supplier representative</label>
          <input id="resp-rep" type="text" value={f.representative} onChange={set('representative')} required />
        </div>
        {area('team', 'D1 Team (optional)')}
        {area('problemDescription', 'D2 Problem description (optional)')}
        {area('containment', 'D3 Containment', true)}
        {area('rootCause', 'D4 Root cause', true)}
        {area('correctiveAction', 'D5 Corrective action', true)}
        {area('implementation', 'D6 Implementation (optional)')}
        {area('prevention', 'D7 Prevention (optional)')}
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontWeight: 400 }}>
          <input type="checkbox" checked={f.supplierClaimsDone} onChange={(e) => setF({ ...f, supplierClaimsDone: e.target.checked })} /> Supplier states the actions are complete
        </label>
        {banner}
      </form>
    </Dialog>
  );
}

function PlanDialog({ open, onClose, scarId, plan, onDone }: { open: boolean; onClose: () => void; scarId: string; plan: string | null; onDone: () => void }) {
  const [text, setText] = useState(plan ?? '');
  const { busy, run, banner } = useBusy();
  return (
    <Dialog
      open={open}
      title="Effectiveness verification plan"
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-primary" disabled={busy} onClick={async () => (await run(() => api(`/api/scars/${scarId}/plan`, { method: 'PUT', body: { effectivenessPlan: text } }))) && onDone()}>
          Save plan
        </button>
      }
    >
      <div className="field">
        <label htmlFor="scar-plan">Plan (population, time and method)</label>
        <textarea id="scar-plan" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="field-hint">Effectiveness should cover representative later production, not only a replacement sample.</div>
      </div>
      {banner}
    </Dialog>
  );
}

function VerifyDialog({
  open,
  onClose,
  scarId,
  kind,
  inspections,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  scarId: string;
  kind: 'IMPLEMENTATION' | 'EFFECTIVENESS';
  inspections: ScarData['inspections'];
  onDone: () => void;
}) {
  const [f, setF] = useState({ result: 'VERIFIED', method: '', evidence: '', populationNote: '', alternativeMethod: false, responseDue: addDays(14) });
  const [picked, setPicked] = useState<string[]>([]);
  const { busy, run, banner } = useBusy();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Dialog
      open={open}
      title={kind === 'IMPLEMENTATION' ? 'Verify implementation' : 'Verify effectiveness'}
      onClose={onClose}
      footer={
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={async () => {
            const ok = await run(() =>
              api(`/api/scars/${scarId}/verifications`, {
                body: { kind, result: f.result, method: f.method, evidence: f.evidence, inspectionIds: picked, populationNote: f.populationNote || null, alternativeMethod: f.alternativeMethod, responseDue: f.result === 'NOT_VERIFIED' ? f.responseDue : null },
              }),
            );
            if (ok) onDone();
          }}
        >
          Record verification
        </button>
      }
    >
      <p className="small muted">
        {kind === 'IMPLEMENTATION'
          ? 'PDI evidence is required: a completed inspection or a document attached to this SCAR.'
          : 'Must be someone other than the implementation verifier; uses completed inspections received after implementation was verified.'}
      </p>
      <div className="field">
        <label htmlFor="v-result">Result</label>
        <select id="v-result" value={f.result} onChange={set('result')}>
          <option value="VERIFIED">Verified</option>
          <option value="NOT_VERIFIED">Not verified — supplier must respond again</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="v-method">Method</label>
        <input id="v-method" type="text" value={f.method} onChange={set('method')} />
      </div>
      <div className="field">
        <label htmlFor="v-evidence">Evidence summary</label>
        <textarea id="v-evidence" value={f.evidence} onChange={set('evidence')} />
      </div>
      <fieldset className="field" style={{ border: 'none', padding: 0 }}>
        <legend className="small" style={{ fontWeight: 600 }}>
          Inspections used as evidence
        </legend>
        {inspections.length === 0 && <div className="small muted">No completed inspections of this supplier yet.</div>}
        {inspections.map((i) => (
          <label key={i.id} style={{ display: 'flex', gap: 8, fontWeight: 400 }}>
            <input type="checkbox" checked={picked.includes(i.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, i.id] : picked.filter((x) => x !== i.id))} />
            {i.number} · lot {i.lotNumber ?? '—'} · received {fmtDate(i.dateReceived)} · {i.outcome}
          </label>
        ))}
      </fieldset>
      {kind === 'EFFECTIVENESS' && (
        <>
          <div className="field">
            <label htmlFor="v-pop">Population / time covered</label>
            <input id="v-pop" type="text" value={f.populationNote} onChange={set('populationNote')} />
          </div>
          <label style={{ display: 'flex', gap: 8, fontWeight: 400 }}>
            <input type="checkbox" checked={f.alternativeMethod} onChange={(e) => setF({ ...f, alternativeMethod: e.target.checked })} /> Alternative documented method (attach evidence to the SCAR)
          </label>
        </>
      )}
      {f.result === 'NOT_VERIFIED' && (
        <div className="field">
          <label htmlFor="v-due">New supplier response due</label>
          <input id="v-due" type="date" value={f.responseDue} onChange={set('responseDue')} />
        </div>
      )}
      {banner}
    </Dialog>
  );
}

/** Issue a SCAR to the supplier from an NCR (FR-074). */
export function IssueScarDialog({
  open,
  onClose,
  ncr,
}: {
  open: boolean;
  onClose: () => void;
  ncr: { id: string; title: string; supplierId: string; siteId: string | null; sourceId: string | null; partId: string | null; description: string };
}) {
  const navigate = useNavigate();
  const owners = useDirectory('scar.manage');
  const [f, setF] = useState({ title: ncr.title, problemStatement: ncr.description, requestedActions: 'Containment of stock, root cause, corrective action and objective evidence', sentTo: '', sentVia: 'EMAIL', responseDue: addDays(14), ownerId: '' });
  const { busy, run, banner } = useBusy();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Dialog
      open={open}
      title="Issue SCAR"
      onClose={onClose}
      footer={
        <button type="submit" form="scar-form" className="btn btn-primary" disabled={busy}>
          Issue SCAR
        </button>
      }
    >
      <form
        id="scar-form"
        onSubmit={async (e) => {
          e.preventDefault();
          let id = '';
          const ok = await run(async () => {
            id = (await api<{ id: string }>('/api/scars', { body: { ...f, ncrIds: [ncr.id], supplierId: ncr.supplierId, siteId: ncr.siteId, sourceId: ncr.sourceId, partId: ncr.partId } })).id;
          });
          if (ok) navigate(`/quality/scars/${id}`);
        }}
      >
        <div className="field">
          <label htmlFor="scar-title">Title</label>
          <input id="scar-title" type="text" value={f.title} onChange={set('title')} required />
        </div>
        <div className="field">
          <label htmlFor="scar-problem">Problem statement</label>
          <textarea id="scar-problem" value={f.problemStatement} onChange={set('problemStatement')} required minLength={10} />
        </div>
        <div className="field">
          <label htmlFor="scar-req">Requested actions</label>
          <textarea id="scar-req" value={f.requestedActions} onChange={set('requestedActions')} />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
          <div className="field">
            <label htmlFor="scar-to">Sent to</label>
            <input id="scar-to" type="text" value={f.sentTo} onChange={set('sentTo')} required />
          </div>
          <div className="field">
            <label htmlFor="scar-via">Via</label>
            <select id="scar-via" value={f.sentVia} onChange={set('sentVia')}>
              {CHANNELS.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="scar-due">Response due</label>
            <input id="scar-due" type="date" value={f.responseDue} onChange={set('responseDue')} required />
          </div>
        </div>
        <UserSelect id="scar-owner" label="PDI owner" value={f.ownerId} onChange={(v) => setF({ ...f, ownerId: v })} users={owners} />
        {banner}
      </form>
    </Dialog>
  );
}
