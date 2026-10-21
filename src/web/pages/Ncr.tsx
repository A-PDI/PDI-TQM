import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { DISPOSITION_OUTCOMES, DISPOSITION_TEXT, type DispositionOutcome, SCOPE_STATE_TEXT } from '../../shared/quality';
import { api, fmtDate, fmtDateTime } from '../api';
import { HistoryCard, type HistoryRow, QualityTabs, RecordPdfs, type Rendition, StateBadge } from '../components/quality';
import { FileLinks, type FileRef, SourceStatusBadge, UploadEvidence, useBusy } from '../components/sourcing';
import { Dialog, LoadState, useLoad } from '../components/ui';
import type { EffectiveSourceStatus } from '../../shared/sourcing';
import { RequestConcessionDialog } from './Concessions';
import { IssueScarDialog } from './Scars';

export function NcrList() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'OPEN';
  const { data, error, loading } = useLoad<
    Array<{ id: string; number: string; title: string; status: string; severity: string; lotNumber: string | null; confirmedAt: string; partNumber: string | null; supplier: string | null; owner: string; openScars: number }>
  >(`/api/ncrs?status=${status === 'ALL' ? '' : status}`);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Quality</h1>
          <div className="muted small">Nonconformance reports (OPS-06): affected material, containment, disposition by quantity, verification and release.</div>
        </div>
      </div>
      <QualityTabs />
      <div className="row-actions card" role="group" aria-label="Status filter">
        {[
          ['OPEN', 'Open'],
          ['CLOSED', 'Closed'],
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
                <th>NCR</th>
                <th>Part / supplier</th>
                <th>Lot</th>
                <th>Severity</th>
                <th>Owner</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    <div className="empty">No NCRs in this view. NCRs are confirmed from a triaged concern.</div>
                  </td>
                </tr>
              )}
              {data.map((n) => (
                <tr key={n.id} className="clickable" onClick={() => navigate(`/quality/ncrs/${n.id}`)}>
                  <td>
                    <Link to={`/quality/ncrs/${n.id}`} onClick={(e) => e.stopPropagation()}>
                      {n.title}
                    </Link>
                    <div className="small muted">
                      {n.number} · {fmtDate(n.confirmedAt)}
                      {n.openScars ? ` · ${n.openScars} open SCAR` : ''}
                    </div>
                  </td>
                  <td className="small">
                    {n.partNumber ?? '—'}
                    {n.supplier ? <div className="muted">{n.supplier}</div> : null}
                  </td>
                  <td className="small">{n.lotNumber ?? '—'}</td>
                  <td className="small">{n.severity}</td>
                  <td className="small">{n.owner}</td>
                  <td>
                    <StateBadge state={n.status} />
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

interface Scope {
  id: string;
  label: string;
  lot_number: string;
  po_number: string | null;
  quantity: number;
  serial_numbers: string[];
  location: string | null;
  containment_action: string;
  containment_authorized_at: string | null;
  authorized_by_name: string | null;
  segregation_verified_at: string | null;
  verified_by_name: string | null;
  segregation_note: string | null;
  state: string;
  inspection_id: string | null;
  inspection_number: string | null;
}
interface Decision {
  id: string;
  scopeId: string;
  outcome: DispositionOutcome;
  quantity: number;
  serialNumbers: string[];
  instructions: string | null;
  rationale: string;
  decidedAt: string;
  decidedBy: string;
  voidedAt: string | null;
  voidReason: string | null;
  concessionId: string | null;
  concessionNumber: string | null;
  verifications: Array<{ id: string; result: string; method: string; note: string; verifiedAt: string; verifiedBy: string; inspectionId: string | null; inspectionNumber: string | null }>;
}
interface NcrData {
  ncr: Record<string, string | number | null> & { id: string; number: string; status: string; statusText: string; version: number; part_id: string | null; supplier_id: string | null; source_id: string | null; site_id: string | null };
  files: Array<FileRef & { caption: string | null; mimeType: string }>;
  scopes: Scope[];
  decisions: Decision[];
  releases: Array<{ id: string; scopeId: string; quantity: number; note: string; releasedAt: string; releasedBy: string; concessionNumber: string | null }>;
  scars: Array<{ id: string; number: string; title: string; status: string; cycle: number; relation: string }>;
  concessions: Array<{ id: string; number: string; status: string; lotNumber: string; quantityLimit: number; validFrom: string; validUntil: string; characteristic: string; used: number }>;
  related: {
    fais: Array<{ id: string; number: string; sampleType: string; status: string; decision: string | null; defects: string | null; conditions: string | null; correctiveRationale: string | null; decidedAt: string | null; lotNumber: string | null }>;
    approvals: Array<{ id: string; number: string; decision: string; scope: string; decidedAt: string; approver: string }>;
    priorNcrs: Array<{ id: string; number: string; title: string; status: string; failureMode: string | null; lotNumber: string | null; confirmedAt: string; sameSource: boolean }>;
    commitments: Array<{ id: string; number: string; promisedAction: string; status: string; dueDate: string | null }>;
    sourceStatus: { status: EffectiveSourceStatus; reasons: string[] } | null;
  };
  inspections: Array<{ id: string; number: string; lotNumber: string | null; outcome: string; completedAt: string }>;
  history: HistoryRow[];
  renditions: Rendition[];
  permissions: {
    manage: boolean;
    authorizeContainment: boolean;
    verifySegregation: boolean;
    disposition: boolean;
    verifyDisposition: boolean;
    release: boolean;
    releaseBlockedReason: string | null;
    requestConcession: boolean;
    issueScar: boolean;
  };
}

type DialogState = { kind: 'scope' } | { kind: 'segregate' | 'dispose' | 'release'; scope: Scope } | { kind: 'verify'; decision: Decision; scope: Scope } | { kind: 'close' | 'concession' | 'scar' } | null;

export function NcrDetail() {
  const { id = '' } = useParams();
  const { data, error, loading, reload } = useLoad<NcrData>(`/api/ncrs/${id}`);
  const { busy, run, banner } = useBusy();
  const [dialog, setDialog] = useState<DialogState>(null);
  const navigate = useNavigate();
  if (!data) return <LoadState loading={loading} error={error} />;
  const n = data.ncr;
  const p = data.permissions;
  const closed = n.status === 'CLOSED';
  const done = () => {
    setDialog(null);
    reload();
  };
  const openScars = data.scars.filter((s) => s.status !== 'CLOSED');
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{n.title}</h1>
          <div className="small muted">
            {n.number} · {n.severity} · confirmed {fmtDateTime(n.confirmed_at as string)} by {n.confirmed_by_name} from <Link to={`/quality/${n.quality_event_id}`}>{n.event_number}</Link> · owner {n.owner_name}
          </div>
          <StateBadge state={n.status} text={n.statusText} />
        </div>
        <div className="row-actions">
          <Link className="btn" to="/quality/ncrs">
            Back to NCRs
          </Link>
        </div>
      </div>
      {!closed && <div className="notice notice-warn">Affected material is not authorized for use until its disposition is verified and released. A TQMS hold does not move ERP stock.</div>}
      {closed && openScars.length > 0 && (
        <div className="notice notice-warn">
          The NCR is closed for local material, but {openScars.map((s) => s.number).join(', ')} remains open with the supplier.
        </div>
      )}
      {n.recurrence_scar_number && (
        <div className="notice notice-error">
          Recurrence of <Link to={`/quality/scars/${n.recurrence_of_scar_id}`}>{n.recurrence_scar_number}</Link> — earlier corrective action reopened for verification.
        </div>
      )}

      <div className="card">
        <dl className="kv">
          <dt>Description</dt>
          <dd>{n.defect_description}</dd>
          <dt>Characteristic</dt>
          <dd>{n.characteristic ?? '—'}</dd>
          <dt>Expected</dt>
          <dd>{n.expected ?? '—'}</dd>
          <dt>Actual</dt>
          <dd>{n.actual ?? '—'}</dd>
          <dt>Failure mode</dt>
          <dd>{n.failure_mode ?? '—'}</dd>
          {n.part_id && (
            <>
              <dt>Part</dt>
              <dd>
                <Link to={`/parts/${n.part_id}`}>{n.part_number}</Link> — {n.part_description}
              </dd>
            </>
          )}
          {n.supplier_id && (
            <>
              <dt>Supplier / site</dt>
              <dd>
                <Link to={`/suppliers/${n.supplier_id}`}>{n.supplier_name}</Link>
                {n.site_name ? ` / ${n.site_name}` : ''}
                {n.source_id && (
                  <>
                    {' '}
                    · <Link to={`/sources/${n.source_id}`}>exact source</Link> <SourceStatusBadge status={data.related.sourceStatus?.status} />
                  </>
                )}
              </dd>
            </>
          )}
          <dt>PO / lot / serial</dt>
          <dd>
            {n.po_number ?? '—'} / {n.lot_number ?? '—'} / {n.serial_number ?? '—'}
          </dd>
          {n.inspection_id && (
            <>
              <dt>Inspection</dt>
              <dd>
                <Link to={`/inspections/${n.inspection_id}`}>{n.inspection_number}</Link>
              </dd>
            </>
          )}
          <dt>Confirmation</dt>
          <dd>{n.confirmation_rationale}</dd>
          {closed && (
            <>
              <dt>Closed</dt>
              <dd>
                {fmtDateTime(n.closed_at as string)} by {n.closed_by_name} — {n.closure_note}
              </dd>
            </>
          )}
        </dl>
        <div className="photos" style={{ marginTop: 10 }}>
          {data.files
            .filter((f) => f.mimeType.startsWith('image/'))
            .map((f) => (
              <a key={f.fileId} className="thumb" href={`/api/files/${f.fileId}`} target="_blank" rel="noopener noreferrer">
                <img src={`/api/files/${f.fileId}`} alt={f.caption ?? 'NCR photograph'} />
              </a>
            ))}
        </div>
        <div style={{ marginTop: 6 }}>
          <FileLinks files={data.files.filter((f) => !f.mimeType.startsWith('image/'))} /> {p.manage && <UploadEvidence entityType="NCR" entityId={id} onUploaded={reload} />}
        </div>
      </div>

      <section className="card" aria-labelledby="scope-h">
        <div className="page-head" style={{ marginBottom: 6 }}>
          <h2 id="scope-h">Affected material</h2>
          {p.manage && (
            <button type="button" className="btn btn-small" onClick={() => setDialog({ kind: 'scope' })}>
              + Add affected material
            </button>
          )}
        </div>
        {data.scopes.length === 0 && <div className="empty">Record the exact lot, quantity and serials affected, and how they are contained.</div>}
        {data.scopes.map((s) => {
          const decisions = data.decisions.filter((d) => d.scopeId === s.id);
          const allocated = decisions.filter((d) => !d.voidedAt).reduce((a, d) => a + d.quantity, 0);
          const releases = data.releases.filter((r) => r.scopeId === s.id);
          return (
            <div key={s.id} className="section" style={{ marginTop: 10 }}>
              <div className="section-head">
                <h3>
                  {s.label} — lot {s.lot_number}, {s.quantity} unit(s)
                </h3>
                <StateBadge state={s.state} text={SCOPE_STATE_TEXT[s.state]} />
              </div>
              <div style={{ padding: '8px 12px' }}>
                <dl className="kv">
                  <dt>Serials</dt>
                  <dd>{s.serial_numbers.join(', ') || '—'}</dd>
                  <dt>Location</dt>
                  <dd>{s.location ?? '—'}</dd>
                  <dt>Containment</dt>
                  <dd>
                    {s.containment_action}
                    {s.containment_authorized_at ? <div className="small muted">Authorized by {s.authorized_by_name}, {fmtDateTime(s.containment_authorized_at)}</div> : <div className="small muted">Not yet authorized</div>}
                    {s.segregation_verified_at ? (
                      <div className="small">
                        Physically verified by {s.verified_by_name}, {fmtDateTime(s.segregation_verified_at)}: {s.segregation_note}
                      </div>
                    ) : null}
                  </dd>
                </dl>
                <div className="row-actions" style={{ marginTop: 8 }}>
                  {!closed && !s.containment_authorized_at && p.authorizeContainment && (
                    <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => void run(() => api(`/api/scopes/${s.id}/authorize-containment`, { body: {} }), 'Containment authorized.').then(reload)}>
                      Authorize containment
                    </button>
                  )}
                  {!closed && s.containment_authorized_at && !s.segregation_verified_at && p.verifySegregation && (
                    <button type="button" className="btn btn-small btn-primary" onClick={() => setDialog({ kind: 'segregate', scope: s })}>
                      Verify physical segregation…
                    </button>
                  )}
                  {!closed && s.segregation_verified_at && allocated < s.quantity && p.disposition && (
                    <button type="button" className="btn btn-small btn-primary" onClick={() => setDialog({ kind: 'dispose', scope: s })}>
                      Decide disposition… ({s.quantity - allocated} left)
                    </button>
                  )}
                  {!closed && s.state === 'VERIFIED_RESOLVED' && p.release && decisions.some((d) => !d.voidedAt && DISPOSITION_TEXT[d.outcome].usable) && (
                    <button type="button" className="btn btn-small btn-primary" onClick={() => setDialog({ kind: 'release', scope: s })}>
                      Release verified material…
                    </button>
                  )}
                  {!closed && s.state === 'VERIFIED_RESOLVED' && p.releaseBlockedReason && <span className="small muted">{p.releaseBlockedReason}</span>}
                  {!closed && s.state === 'ON_HOLD' && <UploadEvidence entityType="MATERIAL_SCOPE" entityId={s.id} label="+ Hold photo" onUploaded={reload} />}
                </div>
                {decisions.length > 0 && (
                  <div className="table-wrap" style={{ marginTop: 10 }}>
                    <table className="data">
                      <thead>
                        <tr>
                          <th>Disposition</th>
                          <th>Qty / serials</th>
                          <th>Decided</th>
                          <th>Verification</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {decisions.map((d) => {
                          const last = d.verifications[d.verifications.length - 1];
                          const verified = last?.result === 'VERIFIED';
                          return (
                            <tr key={d.id}>
                              <td>
                                <strong style={d.voidedAt ? { textDecoration: 'line-through' } : undefined}>{DISPOSITION_TEXT[d.outcome].label}</strong>
                                {d.concessionId && (
                                  <div className="small">
                                    under <Link to={`/quality/concessions/${d.concessionId}`}>{d.concessionNumber}</Link>
                                  </div>
                                )}
                                <div className="small muted">{d.rationale}</div>
                                {d.voidedAt && <div className="small">Void: {d.voidReason}</div>}
                              </td>
                              <td className="small">
                                {d.quantity}
                                {d.serialNumbers.length ? <div className="muted">{d.serialNumbers.join(', ')}</div> : null}
                              </td>
                              <td className="small">
                                {d.decidedBy}
                                <div className="muted">{fmtDateTime(d.decidedAt)}</div>
                              </td>
                              <td className="small">
                                {d.verifications.map((v) => (
                                  <div key={v.id}>
                                    <StateBadge state={v.result} /> {v.method}
                                    {v.inspectionId && (
                                      <>
                                        {' '}
                                        (<Link to={`/inspections/${v.inspectionId}`}>{v.inspectionNumber}</Link>)
                                      </>
                                    )}{' '}
                                    — {v.verifiedBy}
                                  </div>
                                ))}
                                {!d.verifications.length && !d.voidedAt && <span className="muted">{DISPOSITION_TEXT[d.outcome].verification}</span>}
                              </td>
                              <td>
                                {!closed && !d.voidedAt && !verified && (
                                  <div className="row-actions">
                                    {p.verifyDisposition && (
                                      <button type="button" className="btn btn-small" onClick={() => setDialog({ kind: 'verify', decision: d, scope: s })}>
                                        Verify…
                                      </button>
                                    )}
                                    {p.disposition && (
                                      <button
                                        type="button"
                                        className="btn btn-small btn-danger"
                                        disabled={busy}
                                        onClick={() => {
                                          const reason = window.prompt('Reason for voiding this disposition (it stays on record)');
                                          if (reason) void run(() => api(`/api/dispositions/${d.id}/void`, { body: { reason } }), 'Disposition voided.').then(reload);
                                        }}
                                      >
                                        Void
                                      </button>
                                    )}
                                  </div>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {releases.map((r) => (
                  <div key={r.id} className="small" style={{ marginTop: 6 }}>
                    Released {r.quantity} unit(s){r.concessionNumber ? ` under ${r.concessionNumber}` : ''} by {r.releasedBy}, {fmtDateTime(r.releasedAt)} — {r.note}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </section>
      {banner}

      <section className="card">
        <div className="page-head" style={{ marginBottom: 6 }}>
          <h2>Concessions</h2>
          {!closed && p.requestConcession && n.part_id && (
            <button type="button" className="btn btn-small" onClick={() => setDialog({ kind: 'concession' })}>
              + Request concession
            </button>
          )}
        </div>
        {data.concessions.length === 0 ? (
          <p className="small muted">None. Use as is always requires an approved, current concession for this lot.</p>
        ) : (
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {data.concessions.map((c) => (
              <li key={c.id}>
                <Link to={`/quality/concessions/${c.id}`}>{c.number}</Link> — {c.characteristic}, lot {c.lotNumber}, {c.used}/{c.quantityLimit} used, {fmtDate(c.validFrom)}–{fmtDate(c.validUntil)} <StateBadge state={c.status} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <div className="page-head" style={{ marginBottom: 6 }}>
          <h2>Supplier corrective action</h2>
          {p.issueScar && n.supplier_id && (
            <button type="button" className="btn btn-small" onClick={() => setDialog({ kind: 'scar' })}>
              + Issue SCAR
            </button>
          )}
        </div>
        {data.scars.length === 0 ? (
          <p className="small muted">No SCAR linked.</p>
        ) : (
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {data.scars.map((s) => (
              <li key={s.id}>
                <Link to={`/quality/scars/${s.id}`}>{s.number}</Link> — {s.title} ({s.relation.toLowerCase()}, cycle {s.cycle}) <StateBadge state={s.status} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card" aria-labelledby="related-h">
        <h2 id="related-h">Earlier evidence and recurrence</h2>
        <h3>First articles on this source</h3>
        {data.related.fais.length === 0 ? (
          <p className="small muted">None recorded.</p>
        ) : (
          <ul className="small" style={{ marginTop: 0, paddingLeft: 18 }}>
            {data.related.fais.map((f) => (
              <li key={f.id}>
                {f.number} ({f.sampleType.replaceAll('_', ' ').toLowerCase()}) — {f.decision ? <StateBadge state={f.decision} /> : 'open'}
                {f.defects ? ` Defects: ${f.defects}.` : ''}
                {f.correctiveRationale ? ` Corrective rationale: ${f.correctiveRationale}` : ''}
              </li>
            ))}
          </ul>
        )}
        <h3>Source approvals</h3>
        {data.related.approvals.length === 0 ? (
          <p className="small muted">None.</p>
        ) : (
          <ul className="small" style={{ marginTop: 0, paddingLeft: 18 }}>
            {data.related.approvals.map((a) => (
              <li key={a.id}>
                {a.number} {a.decision.toLowerCase().replace('_', ' ')} by {a.approver}, {fmtDate(a.decidedAt)} — {a.scope}
              </li>
            ))}
          </ul>
        )}
        <h3>Other NCRs on this part</h3>
        {data.related.priorNcrs.length === 0 ? (
          <p className="small muted">None.</p>
        ) : (
          <ul className="small" style={{ marginTop: 0, paddingLeft: 18 }}>
            {data.related.priorNcrs.map((x) => (
              <li key={x.id}>
                <Link to={`/quality/ncrs/${x.id}`}>{x.number}</Link> — {x.title}
                {x.failureMode ? ` (${x.failureMode})` : ''} · lot {x.lotNumber ?? '—'} · {fmtDate(x.confirmedAt)}
                {x.sameSource ? ' · same source' : ''} <StateBadge state={x.status} />
              </li>
            ))}
          </ul>
        )}
        {data.related.commitments.length > 0 && (
          <>
            <h3>Supplier commitments</h3>
            <ul className="small" style={{ marginTop: 0, paddingLeft: 18 }}>
              {data.related.commitments.map((c) => (
                <li key={c.id}>
                  <Link to={`/commitments/${c.id}`}>{c.number}</Link> — {c.promisedAction} <StateBadge state={c.status} />
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="card">
        <h2>Close and controlled record</h2>
        {!closed && p.manage && (
          <div className="row-actions" style={{ marginBottom: 8 }}>
            <button type="button" className="btn btn-primary" disabled={n.status !== 'VERIFIED_RESOLVED'} onClick={() => setDialog({ kind: 'close' })}>
              Close NCR…
            </button>
            {n.status !== 'VERIFIED_RESOLVED' && <span className="small muted">Closing needs every affected quantity dispositioned and verified.</span>}
          </div>
        )}
        <RecordPdfs renditions={data.renditions} issueUrl={`/api/ncrs/${id}/report`} docCode="OPS-06" canIssue={p.manage || closed} onIssued={reload} />
      </section>
      <HistoryCard history={data.history} />

      {dialog?.kind === 'scope' && <ScopeDialog ncrId={id} lot={(n.lot_number as string) ?? ''} po={(n.po_number as string) ?? ''} inspectionId={n.inspection_id as string | null} onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === 'segregate' && (
        <NoteDialog
          title="Verify physical segregation"
          label="What you verified on site (location, tags, count)"
          action="Record verification"
          onClose={() => setDialog(null)}
          submit={(note) => api(`/api/scopes/${dialog.scope.id}/verify-segregation`, { body: { note } })}
          onDone={done}
        />
      )}
      {dialog?.kind === 'release' && (
        <NoteDialog
          title="Release verified material"
          label="Release note (TQMS record only; ERP stock is moved separately)"
          action="Release"
          onClose={() => setDialog(null)}
          submit={(note) => api(`/api/scopes/${dialog.scope.id}/release`, { body: { note } })}
          onDone={done}
        />
      )}
      {dialog?.kind === 'dispose' && (
        <DispositionDialog
          scope={dialog.scope}
          taken={data.decisions.filter((d) => d.scopeId === dialog.scope.id && !d.voidedAt).flatMap((d) => d.serialNumbers)}
          remaining={dialog.scope.quantity - data.decisions.filter((d) => d.scopeId === dialog.scope.id && !d.voidedAt).reduce((a, d) => a + d.quantity, 0)}
          concessions={data.concessions.filter((c) => c.status === 'APPROVED' && c.lotNumber.toUpperCase() === dialog.scope.lot_number.toUpperCase())}
          onClose={() => setDialog(null)}
          onDone={done}
        />
      )}
      {dialog?.kind === 'verify' && <VerifyDispositionDialog decision={dialog.decision} scope={dialog.scope} inspections={data.inspections} onClose={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === 'close' && (
        <NoteDialog
          title="Close NCR"
          label="Closure note"
          action="Close NCR"
          onClose={() => setDialog(null)}
          submit={(note) => api(`/api/ncrs/${id}/close`, { body: { note, expectedVersion: n.version } })}
          onDone={done}
        />
      )}
      {n.part_id && (
        <RequestConcessionDialog
          open={dialog?.kind === 'concession'}
          onClose={() => setDialog(null)}
          partId={n.part_id}
          ncrId={id}
          lotNumber={n.lot_number as string | null}
          characteristic={n.characteristic as string | null}
          onCreated={(cid) => navigate(`/quality/concessions/${cid}`)}
        />
      )}
      {n.supplier_id && (
        <IssueScarDialog
          open={dialog?.kind === 'scar'}
          onClose={() => setDialog(null)}
          ncr={{ id, title: n.title as string, supplierId: n.supplier_id, siteId: n.site_id, sourceId: n.source_id, partId: n.part_id, description: `${n.defect_description} (${n.number}, lot ${n.lot_number ?? '—'})` }}
        />
      )}
    </>
  );
}

function NoteDialog({ title, label, action, onClose, submit, onDone }: { title: string; label: string; action: string; onClose: () => void; submit: (note: string) => Promise<unknown>; onDone: () => void }) {
  const [note, setNote] = useState('');
  const { busy, run, banner } = useBusy();
  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-primary" disabled={busy || note.trim().length < 5} onClick={async () => (await run(() => submit(note))) && onDone()}>
          {action}
        </button>
      }
    >
      <div className="field">
        <label htmlFor="note-text">{label}</label>
        <textarea id="note-text" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {banner}
    </Dialog>
  );
}

function ScopeDialog({ ncrId, lot, po, inspectionId, onClose, onDone }: { ncrId: string; lot: string; po: string; inspectionId: string | null; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ label: '', lotNumber: lot, poNumber: po, quantity: '1', serials: '', location: '', containmentAction: '' });
  const { busy, run, banner } = useBusy();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Dialog
      open
      title="Add affected material"
      onClose={onClose}
      footer={
        <button type="submit" form="scope-form" className="btn btn-primary" disabled={busy}>
          Record material
        </button>
      }
    >
      <form
        id="scope-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const serialNumbers = f.serials
            .split(/[\s,;]+/)
            .map((s) => s.trim())
            .filter(Boolean);
          const ok = await run(() =>
            api(`/api/ncrs/${ncrId}/scopes`, {
              body: { label: f.label, lotNumber: f.lotNumber, poNumber: f.poNumber || null, inspectionId, quantity: Number(f.quantity), serialNumbers, location: f.location || null, containmentAction: f.containmentAction },
            }),
          );
          if (ok) onDone();
        }}
      >
        <div className="field">
          <label htmlFor="scope-label">Material description</label>
          <input id="scope-label" type="text" value={f.label} onChange={set('label')} required />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
          <div className="field">
            <label htmlFor="scope-lot">Lot</label>
            <input id="scope-lot" type="text" value={f.lotNumber} onChange={set('lotNumber')} required />
          </div>
          <div className="field">
            <label htmlFor="scope-po">PO</label>
            <input id="scope-po" type="text" value={f.poNumber} onChange={set('poNumber')} />
          </div>
          <div className="field">
            <label htmlFor="scope-qty">Quantity</label>
            <input id="scope-qty" type="number" min={1} value={f.quantity} onChange={set('quantity')} required />
          </div>
        </div>
        <div className="field">
          <label htmlFor="scope-serials">Serial numbers (optional, comma separated)</label>
          <input id="scope-serials" type="text" value={f.serials} onChange={set('serials')} />
        </div>
        <div className="field">
          <label htmlFor="scope-loc">Location</label>
          <input id="scope-loc" type="text" value={f.location} onChange={set('location')} />
        </div>
        <div className="field">
          <label htmlFor="scope-contain">Containment action</label>
          <textarea id="scope-contain" value={f.containmentAction} onChange={set('containmentAction')} required minLength={5} />
        </div>
        {banner}
      </form>
    </Dialog>
  );
}

function DispositionDialog({
  scope,
  taken,
  remaining,
  concessions,
  onClose,
  onDone,
}: {
  scope: Scope;
  taken: string[];
  remaining: number;
  concessions: NcrData['concessions'];
  onClose: () => void;
  onDone: () => void;
}) {
  const [f, setF] = useState({ outcome: 'RETURN_TO_SUPPLIER' as DispositionOutcome, quantity: String(remaining), concessionId: '', instructions: '', rationale: '' });
  const [serials, setSerials] = useState<string[]>([]);
  const { busy, run, banner } = useBusy();
  const free = scope.serial_numbers.filter((s) => !taken.includes(s));
  return (
    <Dialog
      open
      title={`Disposition — lot ${scope.lot_number}`}
      onClose={onClose}
      footer={
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={async () => {
            const ok = await run(() =>
              api(`/api/scopes/${scope.id}/dispositions`, {
                body: { outcome: f.outcome, quantity: Number(f.quantity), serialNumbers: serials, concessionId: f.outcome === 'USE_AS_IS' ? f.concessionId || null : null, instructions: f.instructions || null, rationale: f.rationale },
              }),
            );
            if (ok) onDone();
          }}
        >
          Record disposition
        </button>
      }
    >
      <p className="small muted">
        {remaining} of {scope.quantity} unit(s) still need a disposition. One sample’s outcome never covers the whole lot.
      </p>
      <div className="field">
        <label htmlFor="disp-outcome">Disposition</label>
        <select id="disp-outcome" value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value as DispositionOutcome })}>
          {DISPOSITION_OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {DISPOSITION_TEXT[o].label}
            </option>
          ))}
        </select>
        <div className="field-hint">Verified by: {DISPOSITION_TEXT[f.outcome].verification}.</div>
      </div>
      <div className="field">
        <label htmlFor="disp-qty">Quantity</label>
        <input id="disp-qty" type="number" min={1} max={remaining} value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} />
      </div>
      {free.length > 0 && (
        <fieldset className="field" style={{ border: 'none', padding: 0 }}>
          <legend className="small" style={{ fontWeight: 600 }}>
            Serials covered
          </legend>
          {free.map((s) => (
            <label key={s} style={{ display: 'inline-flex', gap: 6, marginRight: 12, fontWeight: 400 }}>
              <input type="checkbox" checked={serials.includes(s)} onChange={(e) => setSerials(e.target.checked ? [...serials, s] : serials.filter((x) => x !== s))} /> {s}
            </label>
          ))}
        </fieldset>
      )}
      {f.outcome === 'USE_AS_IS' && (
        <div className="field">
          <label htmlFor="disp-dev">Concession</label>
          <select id="disp-dev" value={f.concessionId} onChange={(e) => setF({ ...f, concessionId: e.target.value })}>
            <option value="">Select an approved concession for this lot…</option>
            {concessions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.number} — {c.used}/{c.quantityLimit} used, until {fmtDate(c.validUntil)}
              </option>
            ))}
          </select>
          {!concessions.length && <div className="field-error">No approved concession covers this lot; request one first.</div>}
        </div>
      )}
      {(f.outcome === 'REWORK' || f.outcome === 'REPAIR') && (
        <div className="field">
          <label htmlFor="disp-instr">Instructions</label>
          <textarea id="disp-instr" value={f.instructions} onChange={(e) => setF({ ...f, instructions: e.target.value })} />
        </div>
      )}
      <div className="field">
        <label htmlFor="disp-why">Rationale</label>
        <textarea id="disp-why" value={f.rationale} onChange={(e) => setF({ ...f, rationale: e.target.value })} />
      </div>
      {banner}
    </Dialog>
  );
}

function VerifyDispositionDialog({ decision, scope, inspections, onClose, onDone }: { decision: Decision; scope: Scope; inspections: NcrData['inspections']; onClose: () => void; onDone: () => void }) {
  const reinspect = decision.outcome === 'REWORK' || decision.outcome === 'REPAIR';
  const [f, setF] = useState({ result: 'VERIFIED', method: reinspect ? 'PDI reinspection' : decision.outcome === 'USE_AS_IS' ? 'Concession check' : '', note: '', inspectionId: '' });
  const { busy, run, banner } = useBusy();
  return (
    <Dialog
      open
      title={`Verify ${DISPOSITION_TEXT[decision.outcome].label.toLowerCase()}`}
      onClose={onClose}
      footer={
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={async () => (await run(() => api(`/api/dispositions/${decision.id}/verify`, { body: { result: f.result, method: f.method, note: f.note, inspectionId: f.inspectionId || null } }))) && onDone()}
        >
          Record verification
        </button>
      }
    >
      <p className="small muted">Required evidence: {DISPOSITION_TEXT[decision.outcome].verification}. A supplier statement or a replacement lot is not proof.</p>
      <div className="field">
        <label htmlFor="vd-result">Result</label>
        <select id="vd-result" value={f.result} onChange={(e) => setF({ ...f, result: e.target.value })}>
          <option value="VERIFIED">Verified</option>
          <option value="REJECTED">Not verified</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="vd-method">Method</label>
        <input id="vd-method" type="text" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })} />
      </div>
      {reinspect && (
        <div className="field">
          <label htmlFor="vd-insp">Reinspection (same lot {scope.lot_number})</label>
          <select id="vd-insp" value={f.inspectionId} onChange={(e) => setF({ ...f, inspectionId: e.target.value })}>
            <option value="">Select a completed inspection…</option>
            {inspections.map((i) => (
              <option key={i.id} value={i.id}>
                {i.number} · lot {i.lotNumber ?? '—'} · {i.outcome} · {fmtDate(i.completedAt)}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="field">
        <label htmlFor="vd-note">Note</label>
        <textarea id="vd-note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
      </div>
      {banner}
    </Dialog>
  );
}

