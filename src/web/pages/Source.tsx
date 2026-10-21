import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { type EffectiveSourceStatus, type GateResult, PATHWAYS, type Pathway } from '../../shared/sourcing';
import { api, fmtDate, fmtDateTime } from '../api';
import { FileLinks, GateList, QualificationBadge, SourceStatusBadge, UploadEvidence, useBusy } from '../components/sourcing';
import { Dialog, LoadState, OutcomeBadge, StatusBadge, useLoad } from '../components/ui';

interface Fai {
  id: string;
  number: string;
  sequence: number;
  sampleType: string;
  status: string;
  decision: string | null;
  conditions: string | null;
  defects: string | null;
  rationale: string | null;
  correctiveRationale: string | null;
  lotNumber: string | null;
  serialNumbers: string | null;
  receivedDate: string;
  version: number;
  revisionLabel: string;
  recordedById: string;
  recordedBy: string;
  decidedBy: string | null;
  decidedAt: string | null;
  files: Array<{ linkId: string; fileId: string; name: string }>;
  results: Array<{ charKey: string; charName: string; unit: string | null; lower: string | null; upper: string | null; value: string | null; visualResult: string | null; evaluation: string; note: string | null }>;
}

interface SourceData {
  source: { id: string; pathway: Pathway; configuration: string; part_id: string; part_number: string; part_description: string; supplier_id: string; supplier_name: string; site_name: string; supplier_part_number: string };
  revision: { id: string; revision_label: string; status: string; title: string; ownership: string } | null;
  baseRevision: { id: string; revision_label: string; title: string; newerReleased: string | null } | null;
  characteristics: Array<{ char_key: string; name: string; char_type: string; unit: string | null; lower_limit: string | null; upper_limit: string | null; limit_text: string | null; is_delta: boolean }>;
  request: { id: string; number: string } | null;
  risk: { result: string; score: number } | null;
  siteQualification: { status: string; number: string | null; validUntil: string | null };
  status: { status: EffectiveSourceStatus; reasons: string[]; approval: { number: string } | null };
  gates: GateResult[];
  approvable: boolean;
  conditionalOnly: boolean;
  acknowledgments: Array<{ id: string; sentVia: string; sentTo: string; sentAt: string; response: string; representative: string | null; respondedAt: string | null; responseNote: string | null; revisionLabel: string; sentBy: string; files: Array<{ linkId: string; fileId: string; name: string }> }>;
  fais: Fai[];
  decisions: Array<{ id: string; number: string; decision: string; scope: string; conditions: string | null; validUntil: string | null; rationale: string; decidedAt: string; approver: string; manifestSha256: string; report: { fileId: string; sha256: string; pageCount: number } | null }>;
  inspections: Array<{ id: string; number: string; status: string; outcome: string | null; dateReceived: string; lotNumber: string | null; sourceStateAtStart: string }>;
  repointCandidates: Array<{ id: string; revisionLabel: string }>;
  permissions: { canManage: boolean; canDecideFai: boolean; canApprove: boolean; approveBlockedReason: string | null; canRegisterFai: boolean };
}

type DialogKind = null | 'ack' | 'fai' | 'approve' | { response: string } | { results: Fai } | { decide: Fai };

export function Source() {
  const { id = '' } = useParams();
  const { data, error, loading, reload } = useLoad<SourceData>(`/api/sources/${id}`);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [f, setF] = useState<Record<string, string>>({});
  const [values, setValues] = useState<Record<string, { value?: string; visualResult?: string; note?: string }>>({});
  const [refused, setRefused] = useState<GateResult[] | null>(null);
  const { busy, run, banner } = useBusy();
  const field = (k: string) => ({ value: f[k] ?? '', onChange: (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value })) });
  // The approval record PDF is rendered by a background job; refresh until it is available.
  const reportPending = Boolean(data?.decisions.some((d) => !d.report));
  useEffect(() => {
    if (!reportPending) return;
    const t = setInterval(reload, 2500);
    return () => clearInterval(t);
  }, [reportPending, reload]);
  if (!data) return <LoadState loading={loading} error={error} />;
  const s = data.source;
  const p = data.permissions;
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
  const lastRejected = [...data.fais].reverse().find((x) => x.status === 'DECIDED')?.decision === 'REJECTED';
  const pendingAck = data.acknowledgments.find((a) => a.response === 'PENDING');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            {s.part_number} from {s.supplier_name}
          </h1>
          <div className="small muted">
            Site <strong>{s.site_name}</strong> · supplier PN {s.supplier_part_number} · {s.configuration} · {PATHWAYS[s.pathway].title}
          </div>
          <div style={{ marginTop: 6 }}>
            <SourceStatusBadge status={data.status.status} />{' '}
            {data.status.reasons.map((r) => (
              <span key={r} className="small" style={{ marginLeft: 6 }}>
                {r}
              </span>
            ))}
          </div>
        </div>
        <div className="row-actions">
          {data.request && (
            <Link className="btn" to={`/sourcing/${data.request.id}`}>
              {data.request.number}
            </Link>
          )}
          <Link className="btn" to={`/parts/${s.part_id}`}>
            Part
          </Link>
          <Link className="btn" to={`/suppliers/${s.supplier_id}`}>
            Supplier
          </Link>
        </div>
      </div>
      {banner}

      <section className="card">
        <div className="page-head" style={{ marginBottom: 6 }}>
          <h2>Approval gates</h2>
          <div className="row-actions">
            {p.canManage && data.status.status === 'NOT_APPROVED' && data.decisions.length === 0 && (
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => void run(() => api(`/api/sources/${id}/request-approval`, { method: 'POST' }), 'Approval requested').then(reload)}>
                Request approval
              </button>
            )}
            {p.canApprove && (
              <button type="button" className="btn btn-small btn-primary" onClick={() => setDialog('approve')}>
                Record decision…
              </button>
            )}
          </div>
        </div>
        {p.approveBlockedReason && <div className="notice notice-warn small">{p.approveBlockedReason}</div>}
        <p className="small" style={{ marginTop: 0 }}>
          {data.approvable
            ? `All gates are met${data.conditionalOnly ? '; a conditional prerequisite allows only a conditional approval' : ''}. Gates are re-checked when the decision is recorded.`
            : `${data.gates.filter((g) => g.status === 'FAIL').length} gate(s) not met. Each shows what is missing and where to resolve it.`}
        </p>
        <GateList gates={data.gates} />
      </section>

      <section className="card">
        <h2>Governing technical baseline</h2>
        {data.revision ? (
          <>
            <p style={{ marginTop: 0 }}>
              <Link to={`/baselines/${data.revision.id}`}>
                {data.revision.title} Rev {data.revision.revision_label}
              </Link>{' '}
              <StatusBadge status={data.revision.status} />
              {data.baseRevision && (
                <span className="small">
                  {' '}
                  · on supplier base Rev {data.baseRevision.revision_label}
                  {data.baseRevision.newerReleased ? ` (supplier has released Rev ${data.baseRevision.newerReleased}; not applied without change control)` : ''}
                </span>
              )}
            </p>
            {p.canManage && data.repointCandidates.length > 0 && (
              <p className="small">
                A newer released revision exists:{' '}
                {data.repointCandidates.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="btn btn-small"
                    onClick={() => void run(() => api(`/api/sources/${id}/governing-revision`, { method: 'PATCH', body: { baselineRevisionId: c.id } }), `Now governed by Rev ${c.revisionLabel}`).then(reload)}
                  >
                    Use Rev {c.revisionLabel}
                  </button>
                ))}
              </p>
            )}
            <ul className="small" style={{ margin: 0 }}>
              {data.characteristics.map((c) => (
                <li key={c.char_key}>
                  {c.name}: {c.lower_limit !== null || c.upper_limit !== null ? `${c.lower_limit ?? '—'} – ${c.upper_limit ?? '—'} ${c.unit ?? ''}` : (c.limit_text ?? 'per document')}{' '}
                  {c.is_delta && <span className="badge badge-accepted">PDI delta</span>}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div className="empty">No governing revision linked.</div>
        )}
        <p className="small" style={{ marginBottom: 0 }}>
          Site qualification: <QualificationBadge status={data.siteQualification.status} /> {data.siteQualification.number}
          {data.siteQualification.validUntil ? ` until ${fmtDate(data.siteQualification.validUntil)}` : ''} · Risk: {data.risk ? `${data.risk.result} (score ${data.risk.score})` : 'not assessed'}
        </p>
      </section>

      <section className="card">
        <div className="page-head" style={{ marginBottom: 6 }}>
          <h2>Supplier acknowledgment</h2>
          {p.canManage && !pendingAck && data.revision?.status === 'RELEASED' && (
            <button type="button" className="btn btn-small" onClick={() => setDialog('ack')}>
              Send Rev {data.revision.revision_label} for acknowledgment
            </button>
          )}
        </div>
        {data.acknowledgments.length === 0 ? (
          <div className="empty">Nothing sent yet. An acknowledgment records that the supplier received the exact revision; it does not verify execution.</div>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {data.acknowledgments.map((a) => (
              <li key={a.id} style={{ marginBottom: 6 }}>
                Rev {a.revisionLabel} sent {fmtDate(a.sentAt)} via {a.sentVia.toLowerCase()} to {a.sentTo} ({a.sentBy}) —{' '}
                <span className={`badge ${a.response === 'ACKNOWLEDGED' ? 'badge-pass' : a.response === 'OBJECTED' ? 'badge-fail' : 'badge-review'}`}>{a.response.toLowerCase()}</span>
                {a.representative && (
                  <span className="small">
                    {' '}
                    by {a.representative} on {fmtDate(a.respondedAt)}
                    {a.responseNote ? `: ${a.responseNote}` : ''}
                  </span>
                )}{' '}
                <FileLinks files={a.files} /> {p.canManage && <UploadEvidence entityType="ACKNOWLEDGMENT" entityId={a.id} label="+ Evidence" onUploaded={reload} />}{' '}
                {p.canManage && a.response === 'PENDING' && (
                  <button type="button" className="btn btn-small" onClick={() => setDialog({ response: a.id })}>
                    Record response
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <div className="page-head" style={{ marginBottom: 6 }}>
          <h2>First article and validation samples</h2>
          {p.canRegisterFai && (
            <button type="button" className="btn btn-small" onClick={() => setDialog('fai')}>
              Register {lastRejected ? 'resubmitted sample' : 'sample'}
            </button>
          )}
        </div>
        {data.fais.length === 0 ? (
          <div className="empty">No samples registered. Samples are evaluated against the released governing revision.</div>
        ) : (
          data.fais.map((x) => (
            <div key={x.id} style={{ borderTop: '1px solid var(--border)', padding: '10px 0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                <div>
                  <strong>{x.number}</strong> · {x.sampleType.replaceAll('_', ' ').toLowerCase()} · Rev {x.revisionLabel} · received {fmtDate(x.receivedDate)}
                  {x.serialNumbers ? ` · ${x.serialNumbers}` : ''}{' '}
                  {x.status === 'DECIDED' ? (
                    <span className={`badge ${x.decision === 'ACCEPTED' ? 'badge-pass' : x.decision === 'REJECTED' ? 'badge-fail' : 'badge-accepted'}`}>{x.decision?.toLowerCase()}</span>
                  ) : (
                    <span className="badge badge-review">open</span>
                  )}
                  {x.correctiveRationale && <div className="small">Corrective rationale: {x.correctiveRationale}</div>}
                  {x.defects && <div className="small">Defects: {x.defects}</div>}
                  {x.conditions && <div className="small">Conditions: {x.conditions}</div>}
                  {x.decidedBy && (
                    <div className="small muted">
                      Decided by {x.decidedBy} {fmtDateTime(x.decidedAt)} — {x.rationale}
                    </div>
                  )}
                  <div className="small">
                    <FileLinks files={x.files} canRemove={p.canManage && x.status === 'OPEN'} onChanged={reload} />{' '}
                    {p.canManage && x.status === 'OPEN' && <UploadEvidence entityType="FAI" entityId={x.id} label="+ FAI report / photos" onUploaded={reload} />}
                  </div>
                </div>
                {x.status === 'OPEN' && (
                  <div className="row-actions">
                    {p.canManage && (
                      <button
                        type="button"
                        className="btn btn-small"
                        onClick={() => {
                          setValues(Object.fromEntries(x.results.map((r) => [r.charKey, { value: r.value ?? undefined, visualResult: r.visualResult ?? undefined, note: r.note ?? undefined }])));
                          setDialog({ results: x });
                        }}
                      >
                        Enter results
                      </button>
                    )}
                    {p.canDecideFai && (
                      <button type="button" className="btn btn-small btn-primary" onClick={() => setDialog({ decide: x })}>
                        Decide…
                      </button>
                    )}
                  </div>
                )}
              </div>
              {x.results.length > 0 && (
                <div className="table-wrap" style={{ marginTop: 6 }}>
                  <table className="data">
                    <thead>
                      <tr>
                        <th>Characteristic</th>
                        <th>Limit</th>
                        <th>Result</th>
                        <th>Evaluation</th>
                      </tr>
                    </thead>
                    <tbody>
                      {x.results.map((r) => (
                        <tr key={r.charKey}>
                          <td>{r.charName}</td>
                          <td className="small">{r.lower !== null || r.upper !== null ? `${r.lower ?? '—'} – ${r.upper ?? '—'} ${r.unit ?? ''}` : '—'}</td>
                          <td>
                            {r.value ?? r.visualResult?.toLowerCase().replaceAll('_', ' ')}
                            {r.note ? <div className="small muted">{r.note}</div> : null}
                          </td>
                          <td>
                            <span className={`badge ${['WITHIN', 'CONFORMS'].includes(r.evaluation) ? 'badge-pass' : r.evaluation === 'NO_LIMIT' ? '' : 'badge-fail'}`}>
                              {r.evaluation.replaceAll('_', ' ').toLowerCase()}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))
        )}
      </section>

      <section className="card">
        <h2>Approval decisions</h2>
        {data.decisions.length === 0 ? (
          <div className="empty">No decision recorded.</div>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {data.decisions.map((d) => (
              <li key={d.id} style={{ marginBottom: 6 }}>
                <strong>{d.number}</strong> <span className={`badge ${d.decision === 'APPROVED' ? 'badge-pass' : d.decision === 'REJECTED' ? 'badge-fail' : 'badge-accepted'}`}>{d.decision.replaceAll('_', ' ').toLowerCase()}</span> by{' '}
                {d.approver} · {fmtDateTime(d.decidedAt)}
                {d.validUntil ? ` · valid until ${fmtDate(d.validUntil)}` : ''}
                <div className="small">Scope: {d.scope}</div>
                {d.conditions && <div className="small">Conditions: {d.conditions}</div>}
                <div className="small muted">
                  Frozen manifest SHA-256 {d.manifestSha256.slice(0, 16)}… ·{' '}
                  {d.report ? (
                    <a href={`/api/files/${d.report.fileId}`} target="_blank" rel="noopener noreferrer">
                      Approval record PDF ({d.report.pageCount} pages)
                    </a>
                  ) : (
                    'record PDF generating…'
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {data.inspections.length > 0 && (
        <section className="card">
          <h2>Receiving inspections from this source</h2>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {data.inspections.map((i) => (
              <li key={i.id}>
                <Link to={`/inspections/${i.id}`}>{i.number}</Link> · {fmtDate(i.dateReceived)} · <StatusBadge status={i.status} /> {i.status === 'COMPLETED' && <OutcomeBadge outcome={i.outcome} />}{' '}
                <span className="small muted">source status at receipt: {i.sourceStateAtStart.replaceAll('_', ' ').toLowerCase()}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <Dialog
        open={dialog === 'ack'}
        title={`Send Rev ${data.revision?.revision_label} for acknowledgment`}
        onClose={close}
        footer={
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !f.sentTo || !f.sentAt}
            onClick={() => void submit(() => api(`/api/sources/${id}/acknowledgments`, { body: { sentVia: f.sentVia || 'EMAIL', sentTo: f.sentTo, sentAt: f.sentAt } }), 'Recorded as sent')}
          >
            Record as sent
          </button>
        }
      >
        <div className="field">
          <label htmlFor="ak-via">Sent via</label>
          <select id="ak-via" {...field('sentVia')}>
            <option value="EMAIL">Email</option>
            <option value="PORTAL">Supplier portal</option>
            <option value="MEETING">Meeting</option>
            <option value="MAIL">Mail</option>
            <option value="OTHER">Other</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="ak-to">Sent to (representative / address)</label>
          <input id="ak-to" type="text" {...field('sentTo')} />
        </div>
        <div className="field">
          <label htmlFor="ak-at">Date sent</label>
          <input id="ak-at" type="date" {...field('sentAt')} />
        </div>
        {banner}
      </Dialog>

      {dialog && typeof dialog === 'object' && 'response' in dialog && (
        <Dialog
          open
          title="Record supplier response"
          onClose={close}
          footer={
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !f.response || !f.representative || !f.respondedAt}
              onClick={() =>
                void submit(
                  () => api(`/api/acknowledgments/${dialog.response}/response`, { body: { response: f.response, representative: f.representative, respondedAt: f.respondedAt, note: f.note || null } }),
                  'Response recorded',
                )
              }
            >
              Record response
            </button>
          }
        >
          <div className="field">
            <label htmlFor="rs-resp">Response</label>
            <select id="rs-resp" {...field('response')}>
              <option value="">Select…</option>
              <option value="ACKNOWLEDGED">Acknowledged the exact revision</option>
              <option value="OBJECTED">Objected / requested changes</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="rs-rep">Supplier representative</label>
            <input id="rs-rep" type="text" {...field('representative')} />
          </div>
          <div className="field">
            <label htmlFor="rs-at">Response date</label>
            <input id="rs-at" type="date" {...field('respondedAt')} />
          </div>
          <div className="field">
            <label htmlFor="rs-note">Notes / objections</label>
            <textarea id="rs-note" {...field('note')} />
          </div>
          {banner}
        </Dialog>
      )}

      <Dialog
        open={dialog === 'fai'}
        title={lastRejected ? 'Register resubmitted sample' : 'Register sample'}
        onClose={close}
        footer={
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !f.receivedDate}
            onClick={() =>
              void submit(
                () =>
                  api(`/api/sources/${id}/fai`, {
                    body: {
                      sampleType: lastRejected ? 'RESUBMITTED_FAI' : f.sampleType || 'INITIAL_FAI',
                      receivedDate: f.receivedDate,
                      lotNumber: f.lotNumber || null,
                      serialNumbers: f.serialNumbers || null,
                      description: f.description || null,
                      correctiveRationale: f.correctiveRationale || null,
                    },
                  }),
                'Sample registered',
              )
            }
          >
            Register
          </button>
        }
      >
        {lastRejected ? (
          <div className="field">
            <label htmlFor="fa-cr">Corrective rationale: root cause, process correction, why this sample is representative</label>
            <textarea id="fa-cr" {...field('correctiveRationale')} />
            <div className="field-hint">The rejected sample stays on record; a passing sample alone does not prove process capability.</div>
          </div>
        ) : (
          <div className="field">
            <label htmlFor="fa-type">Sample type</label>
            <select id="fa-type" {...field('sampleType')}>
              <option value="INITIAL_FAI">Initial first article</option>
              <option value="PROTOTYPE">Engineering prototype</option>
              <option value="PRODUCTION_REPRESENTATIVE">Production-representative sample</option>
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor="fa-date">Received</label>
          <input id="fa-date" type="date" {...field('receivedDate')} />
        </div>
        <div className="field">
          <label htmlFor="fa-lot">Lot</label>
          <input id="fa-lot" type="text" {...field('lotNumber')} />
        </div>
        <div className="field">
          <label htmlFor="fa-sn">Serial numbers</label>
          <input id="fa-sn" type="text" {...field('serialNumbers')} />
        </div>
        {banner}
      </Dialog>

      {dialog && typeof dialog === 'object' && 'results' in dialog && (
        <Dialog
          open
          title={`Results — ${dialog.results.number}`}
          onClose={close}
          footer={
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() =>
                void submit(
                  () =>
                    api(`/api/fai/${dialog.results.id}/results`, {
                      method: 'PUT',
                      body: {
                        results: data.characteristics.map((c) => ({
                          charKey: c.char_key,
                          value: values[c.char_key]?.value || null,
                          visualResult: values[c.char_key]?.visualResult || null,
                          note: values[c.char_key]?.note || null,
                        })),
                      },
                    }),
                  'Results saved',
                )
              }
            >
              Save results
            </button>
          }
        >
          {data.characteristics.map((c) => {
            const numeric = c.lower_limit !== null || c.upper_limit !== null || c.char_type === 'DIMENSIONAL';
            const v = values[c.char_key] ?? {};
            return (
              <div key={c.char_key} className="field">
                <label htmlFor={`fr-${c.char_key}`}>
                  {c.name} {numeric && (c.lower_limit !== null || c.upper_limit !== null) ? `(${c.lower_limit ?? '—'} – ${c.upper_limit ?? '—'} ${c.unit ?? ''})` : c.limit_text ? `(${c.limit_text})` : ''}
                </label>
                {numeric ? (
                  <input
                    id={`fr-${c.char_key}`}
                    type="text"
                    inputMode="decimal"
                    value={v.value ?? ''}
                    onChange={(e) => setValues({ ...values, [c.char_key]: { ...v, value: e.target.value } })}
                  />
                ) : (
                  <select id={`fr-${c.char_key}`} value={v.visualResult ?? ''} onChange={(e) => setValues({ ...values, [c.char_key]: { ...v, visualResult: e.target.value } })}>
                    <option value="">Not evaluated</option>
                    <option value="CONFORMS">Conforms</option>
                    <option value="DOES_NOT_CONFORM">Does not conform</option>
                  </select>
                )}
              </div>
            );
          })}
          {banner}
        </Dialog>
      )}

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
                    api(`/api/fai/${dialog.decide.id}/decide`, {
                      body: { expectedVersion: dialog.decide.version, decision: f.decision, conditions: f.conditions || null, defects: f.defects || null, rationale: f.rationale },
                    }),
                  'Sample decided',
                )
              }
            >
              Record decision
            </button>
          }
        >
          <p className="small" style={{ marginTop: 0 }}>
            Registered by {dialog.decide.recordedBy}. {dialog.decide.results.filter((r) => ['OUTSIDE', 'DOES_NOT_CONFORM'].includes(r.evaluation)).length} nonconforming result(s).
          </p>
          <div className="field">
            <label htmlFor="fd-dec">Decision</label>
            <select id="fd-dec" {...field('decision')}>
              <option value="">Select…</option>
              <option value="ACCEPTED">Accepted</option>
              <option value="CONDITIONAL">Accepted with conditions</option>
              <option value="REJECTED">Rejected</option>
            </select>
          </div>
          {f.decision === 'CONDITIONAL' && (
            <div className="field">
              <label htmlFor="fd-cond">Conditions</label>
              <textarea id="fd-cond" {...field('conditions')} />
            </div>
          )}
          {f.decision === 'REJECTED' && (
            <div className="field">
              <label htmlFor="fd-def">Defects found</label>
              <textarea id="fd-def" {...field('defects')} />
            </div>
          )}
          <div className="field">
            <label htmlFor="fd-rat">Rationale</label>
            <textarea id="fd-rat" {...field('rationale')} />
          </div>
          {banner}
        </Dialog>
      )}

      <Dialog
        open={dialog === 'approve'}
        title="Source approval decision"
        onClose={() => {
          close();
          setRefused(null);
        }}
        footer={
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !f.decision || (f.scope ?? '').length < 3 || (f.rationale ?? '').length < 5}
            onClick={async () => {
              setRefused(null);
              try {
                await api(`/api/sources/${id}/decision`, {
                  body: { decision: f.decision, scope: f.scope, conditions: f.conditions || null, validUntil: f.validUntil || null, rationale: f.rationale },
                });
                close();
                reload();
              } catch (err) {
                const e = err as { details?: { gates?: GateResult[] }; message: string };
                if (e.details?.gates) setRefused(e.details.gates.filter((g) => g.status === 'FAIL' || g.status === 'WARN'));
                else setRefused([{ code: 'ERROR', label: e.message, status: 'FAIL', detail: '' }]);
              }
            }}
          >
            Record decision
          </button>
        }
      >
        <p className="small" style={{ marginTop: 0 }}>
          Authorizes only <strong>{s.part_number}</strong> from <strong>{s.supplier_name} — {s.site_name}</strong>, supplier PN {s.supplier_part_number}, {s.configuration}, governed by Rev{' '}
          {data.revision?.revision_label}. Gates are re-evaluated at the moment you record the decision, and the evidence is frozen.
        </p>
        <div className="field">
          <label htmlFor="ap-dec">Decision</label>
          <select id="ap-dec" {...field('decision')}>
            <option value="">Select…</option>
            <option value="APPROVED" disabled={!data.approvable || data.conditionalOnly}>
              Approve
            </option>
            <option value="APPROVED_CONDITIONAL" disabled={!data.approvable}>
              Approve with conditions
            </option>
            <option value="REJECTED">Reject</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="ap-scope">Scope (quantities, applications, period)</label>
          <input id="ap-scope" type="text" {...field('scope')} />
        </div>
        {f.decision === 'APPROVED_CONDITIONAL' && (
          <div className="field">
            <label htmlFor="ap-cond">Conditions</label>
            <textarea id="ap-cond" {...field('conditions')} />
          </div>
        )}
        <div className="field">
          <label htmlFor="ap-valid">Valid until (optional)</label>
          <input id="ap-valid" type="date" {...field('validUntil')} />
        </div>
        <div className="field">
          <label htmlFor="ap-rat">Rationale</label>
          <textarea id="ap-rat" {...field('rationale')} />
        </div>
        {refused && (
          <div className="notice notice-error" role="alert">
            Not recorded:
            <ul style={{ margin: '4px 0 0' }}>
              {refused.map((g) => (
                <li key={g.code} className="small">
                  {g.label}
                  {g.detail ? ` — ${g.detail}` : ''}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Dialog>
    </>
  );
}
