import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { PATHWAYS, type Pathway, RISK_FACTORS, type GateResult, type EffectiveSourceStatus } from '../../shared/sourcing';
import { api, fmtDate, fmtDateTime } from '../api';
import { useAuth } from '../auth';
import { FileLinks, GateList, SourceStatusBadge, UploadEvidence, useBusy } from '../components/sourcing';
import { Dialog, LoadState, type PartOption, PartTypeahead, useLoad } from '../components/ui';
import { HubTabs } from './MasterData';

interface SupplierOption {
  id: string;
  legalName: string;
  code: string;
}

export function SourcingList() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'ACTIVE';
  const { data, error, loading } = useLoad<
    Array<{ id: string; number: string; title: string; pathway: string; status: string; targetDate: string | null; partNumber: string; supplier: string | null; site: string | null; owner: string; risk: string | null }>
  >(`/api/sourcing?status=${status === 'ALL' ? '' : status}`);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Parts &amp; Sources</h1>
          <div className="small muted">Sourcing requests: from intake to an approved exact source.</div>
        </div>
        {can('sourcing.manage') && (
          <button type="button" className="btn btn-primary" onClick={() => setParams({ ...Object.fromEntries(params), new: '1' })}>
            New sourcing request
          </button>
        )}
      </div>
      <HubTabs />
      <div className="row-actions card" role="group" aria-label="Status filter">
        {[
          ['ACTIVE', 'In progress'],
          ['APPROVED', 'Approved'],
          ['CANCELLED', 'Cancelled'],
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
                <th>Request</th>
                <th>Part</th>
                <th>Path</th>
                <th>Supplier / site</th>
                <th>Risk</th>
                <th>Owner</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.length === 0 && (
                <tr>
                  <td colSpan={7}>
                    <div className="empty">No sourcing requests in this view.</div>
                  </td>
                </tr>
              )}
              {data.map((r) => (
                <tr key={r.id} className="clickable" onClick={() => navigate(`/sourcing/${r.id}`)}>
                  <td>
                    <Link to={`/sourcing/${r.id}`} onClick={(e) => e.stopPropagation()}>
                      {r.title}
                    </Link>
                    <div className="small muted">
                      {r.number}
                      {r.targetDate ? ` · target ${fmtDate(r.targetDate)}` : ''}
                    </div>
                  </td>
                  <td>{r.partNumber}</td>
                  <td>{r.pathway}</td>
                  <td className="small">{r.supplier ? `${r.supplier}${r.site ? ` — ${r.site}` : ''}` : '—'}</td>
                  <td>{r.risk ? <span className="badge">{r.risk}</span> : <span className="muted small">not assessed</span>}</td>
                  <td>{r.owner}</td>
                  <td>
                    <span className="badge">{r.status.replaceAll('_', ' ').toLowerCase()}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <IntakeDialog open={params.get('new') === '1'} onClose={() => setParams({ status })} presetPartId={params.get('partId')} />
    </>
  );
}

function SupplierSitePicker({ supplierId, siteId, onChange }: { supplierId: string; siteId: string; onChange: (supplierId: string, siteId: string) => void }) {
  const suppliers = useLoad<SupplierOption[]>('/api/suppliers');
  const detail = useLoad<{ sites: Array<{ id: string; name: string }> }>(supplierId ? `/api/suppliers/${supplierId}` : null);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
      <div className="field">
        <label htmlFor="in-sup">Supplier</label>
        <select id="in-sup" value={supplierId} onChange={(e) => onChange(e.target.value, '')}>
          <option value="">Not chosen yet</option>
          {suppliers.data?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.legalName}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="in-site">Manufacturing site</label>
        <select id="in-site" value={siteId} disabled={!supplierId} onChange={(e) => onChange(supplierId, e.target.value)}>
          <option value="">Not chosen yet</option>
          {supplierId &&
            detail.data?.sites.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
        </select>
      </div>
    </div>
  );
}

function IntakeDialog({ open, onClose, presetPartId }: { open: boolean; onClose: () => void; presetPartId: string | null }) {
  const navigate = useNavigate();
  const [part, setPart] = useState<PartOption | null>(null);
  const [f, setF] = useState({ title: '', pathway: '' as Pathway | '', proposedPartNumber: '', description: '', supplierId: '', siteId: '', supplierPartNumber: '', targetDate: '' });
  const { busy, run, banner } = useBusy();
  useEffect(() => {
    if (open && presetPartId && !part) {
      void api<{ part: PartOption & { partNumber: string } }>(`/api/parts/${presetPartId}`).then((d) => setPart({ ...d.part, aliases: null }));
    }
  }, [open, presetPartId, part]);
  const valid = f.title.length >= 3 && f.pathway && (part || f.proposedPartNumber);
  return (
    <Dialog
      open={open}
      title="New sourcing request"
      onClose={onClose}
      footer={
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !valid}
          onClick={async () => {
            let id = '';
            const ok = await run(
              async () =>
                (id = (
                  await api<{ id: string }>('/api/sourcing', {
                    body: {
                      title: f.title,
                      pathway: f.pathway,
                      partId: part?.id ?? null,
                      proposedPartNumber: part ? null : f.proposedPartNumber || null,
                      description: f.description || null,
                      supplierId: f.supplierId || null,
                      siteId: f.siteId || null,
                      supplierPartNumber: f.supplierPartNumber || null,
                      targetDate: f.targetDate || null,
                    },
                  })
                ).id),
            );
            if (ok) navigate(`/sourcing/${id}`);
          }}
        >
          Start request
        </button>
      }
    >
      <p className="small muted" style={{ marginTop: 0 }}>
        Record what you know now; drawings, supplier and site details can follow.
      </p>
      <div className="field">
        <label htmlFor="in-title">What is being sourced</label>
        <input id="in-title" type="text" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
      </div>
      <fieldset className="field" style={{ border: 'none', padding: 0, margin: '0 0 12px' }}>
        <legend style={{ fontSize: 12, fontWeight: 600, color: 'var(--slate)', marginBottom: 6 }}>Sourcing path</legend>
        {(Object.keys(PATHWAYS) as Pathway[]).map((k) => (
          <label key={k} style={{ display: 'flex', gap: 8, fontWeight: 400, fontSize: 13, marginBottom: 6, color: 'var(--text)' }}>
            <input type="radio" name="pathway" value={k} checked={f.pathway === k} onChange={() => setF({ ...f, pathway: k })} />
            <span>
              <strong>{PATHWAYS[k].title}</strong>
              <span className="small muted" style={{ display: 'block' }}>
                {PATHWAYS[k].explanation}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="field">
        <label htmlFor="part-number">Company part</label>
        <PartTypeahead value={part} onSelect={setPart} />
      </div>
      {!part && (
        <div className="field">
          <label htmlFor="in-ppn">…or proposed new part number</label>
          <input id="in-ppn" type="text" value={f.proposedPartNumber} onChange={(e) => setF({ ...f, proposedPartNumber: e.target.value })} />
        </div>
      )}
      <SupplierSitePicker supplierId={f.supplierId} siteId={f.siteId} onChange={(supplierId, siteId) => setF({ ...f, supplierId, siteId })} />
      <div className="field">
        <label htmlFor="in-spn">Supplier part number</label>
        <input id="in-spn" type="text" value={f.supplierPartNumber} onChange={(e) => setF({ ...f, supplierPartNumber: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="in-desc">Notes (application, quantity, rationale)</label>
        <textarea id="in-desc" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="in-target">Target date</label>
        <input id="in-target" type="date" value={f.targetDate} onChange={(e) => setF({ ...f, targetDate: e.target.value })} />
      </div>
      {banner}
    </Dialog>
  );
}

interface Requirement {
  id: string;
  code: string;
  title: string;
  applicability: 'REQUIRED' | 'CONDITIONAL' | 'NOT_APPLICABLE';
  rationale: string;
  ruleVersion: string;
  status: 'OPEN' | 'SATISFIED' | 'WAIVED';
  waiverReason: string | null;
  version: number;
  satisfiedBy: string | null;
  satisfiedAt: string | null;
  waivedBy: string | null;
  files: Array<{ linkId: string; fileId: string; name: string; sha256: string }>;
}

interface RequestData {
  request: Record<string, string | number | null> & { id: string; number: string; title: string; pathway: Pathway; status: string; version: number; source_id: string | null; part_id: string | null; supplier_id: string | null; site_id: string | null };
  risks: Array<{ id: string; inputs: Record<string, number>; ruleVersion: string; score: number; result: string; rationale: string | null; assessedAt: string; assessedBy: string }>;
  requirements: Requirement[];
  history: Array<{ occurredAt: string; summary: string; reason: string | null; actor: string | null; outcome: string }>;
  gates: { gates: GateResult[]; approvable: boolean; conditionalOnly: boolean } | null;
  sourceStatus: { status: EffectiveSourceStatus } | null;
  riskFactors: typeof RISK_FACTORS;
  permissions: { canManage: boolean; canWaive: boolean };
}

export function SourcingDetail() {
  const { id = '' } = useParams();
  const { data, error, loading, reload } = useLoad<RequestData>(`/api/sourcing/${id}`);
  const { busy, run, banner } = useBusy();
  const [dialog, setDialog] = useState<null | 'risk' | 'source' | 'cancel' | 'edit' | { waive: Requirement }>(null);
  const [inputs, setInputs] = useState<Record<string, number>>({});
  const [text, setText] = useState('');
  const [baselineRevisionId, setBaselineRevisionId] = useState('');
  const [edit, setEdit] = useState({ supplierId: '', siteId: '', supplierPartNumber: '', part: null as PartOption | null });
  const baselines = useLoad<{ baselines: Array<{ revisionId: string; title: string; revisionLabel: string; status: string; ownership: string }> }>(
    dialog === 'source' && data?.request.part_id ? `/api/parts/${data.request.part_id}` : null,
  );
  if (!data) return <LoadState loading={loading} error={error} />;
  const r = data.request;
  const p = data.permissions;
  const latestRisk = data.risks[0];
  const close = () => {
    setDialog(null);
    setText('');
  };
  const expectedOwnership = { A: 'PDI', B: 'SUPPLIER', C: 'SUPPLIER_PLUS_DELTA' }[r.pathway];
  const groups: Array<[Requirement['applicability'], string]> = [
    ['REQUIRED', 'Required'],
    ['CONDITIONAL', 'Conditional — when applicable'],
    ['NOT_APPLICABLE', 'Not applicable for this path and risk'],
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{r.title}</h1>
          <div className="small muted">
            {r.number} · {PATHWAYS[r.pathway].title} · owner {r.owner_name} · <span className="badge">{r.status.replaceAll('_', ' ').toLowerCase()}</span>
          </div>
        </div>
        <div className="row-actions">
          {r.source_id && (
            <Link className="btn btn-primary" to={`/sources/${r.source_id}`}>
              Open source & approval
            </Link>
          )}
          {p.canManage && (
            <button type="button" className="btn btn-danger" onClick={() => setDialog('cancel')}>
              Cancel request
            </button>
          )}
        </div>
      </div>
      {banner}
      <p className="small">{PATHWAYS[r.pathway].explanation}</p>

      <section className="card">
        <div className="page-head" style={{ marginBottom: 6 }}>
          <h2>Intake</h2>
          {p.canManage && !r.source_id && (
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                setEdit({ supplierId: String(r.supplier_id ?? ''), siteId: String(r.site_id ?? ''), supplierPartNumber: String(r.supplier_part_number ?? ''), part: null });
                setDialog('edit');
              }}
            >
              Complete intake
            </button>
          )}
        </div>
        <dl className="kv">
          <dt>Part</dt>
          <dd>{r.part_id ? <Link to={`/parts/${r.part_id}`}>{`${r.part_number} — ${r.part_description}`}</Link> : `${r.proposed_part_number} (proposed, not yet a company part)`}</dd>
          <dt>Supplier / site</dt>
          <dd>{r.supplier_id ? <Link to={`/suppliers/${r.supplier_id}`}>{`${r.supplier_name}${r.site_name ? ` — ${r.site_name}` : ' — site not chosen'}`}</Link> : 'Not chosen yet'}</dd>
          <dt>Supplier part</dt>
          <dd>{r.supplier_part_number ?? '—'}</dd>
          <dt>Configuration</dt>
          <dd>{r.configuration}</dd>
          <dt>Target</dt>
          <dd>{fmtDate(r.target_date as string | null)}</dd>
          <dt>Notes</dt>
          <dd>{r.description ?? '—'}</dd>
        </dl>
      </section>

      <section className="card">
        <div className="page-head" style={{ marginBottom: 6 }}>
          <h2>Risk assessment</h2>
          {p.canManage && (
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                setInputs(latestRisk ? latestRisk.inputs : Object.fromEntries(RISK_FACTORS.map((f) => [f.key, 2])));
                setDialog('risk');
              }}
            >
              {latestRisk ? 'Reassess risk' : 'Assess risk'}
            </button>
          )}
        </div>
        {latestRisk ? (
          <>
            <p style={{ margin: 0 }}>
              <span className={`badge ${latestRisk.result === 'HIGH' ? 'badge-fail' : latestRisk.result === 'MEDIUM' ? 'badge-accepted' : 'badge-pass'}`}>{latestRisk.result}</span> score{' '}
              {latestRisk.score} · {latestRisk.assessedBy} · {fmtDateTime(latestRisk.assessedAt)} <span className="small muted">({latestRisk.ruleVersion})</span>
            </p>
            {latestRisk.rationale && <p className="small">{latestRisk.rationale}</p>}
            {data.risks.length > 1 && <p className="small muted">{data.risks.length - 1} earlier assessment(s) kept on record.</p>}
          </>
        ) : (
          <div className="empty">Assess risk to generate the evidence checklist for this path.</div>
        )}
      </section>

      {data.requirements.length > 0 && (
        <section className="card">
          <h2>Evidence checklist</h2>
          <p className="small muted" style={{ marginTop: 0 }}>
            Proportionate to path {r.pathway} and risk {latestRisk?.result} ({data.requirements[0]?.ruleVersion}). Required items must be satisfied with a document or waived with authority.
          </p>
          {groups.map(([kind, label]) => {
            const items = data.requirements.filter((x) => x.applicability === kind);
            if (!items.length) return null;
            return (
              <details key={kind} open={kind !== 'NOT_APPLICABLE'} style={{ marginBottom: 10 }}>
                <summary>
                  <strong>{label}</strong> ({items.length})
                </summary>
                <ul style={{ listStyle: 'none', padding: 0, margin: '6px 0 0' }}>
                  {items.map((q) => (
                    <li key={q.id} style={{ borderTop: '1px solid var(--border)', padding: '8px 0' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                        <div>
                          <strong>
                            {q.code} {q.title}
                          </strong>{' '}
                          <span className={`badge ${q.status === 'SATISFIED' ? 'badge-pass' : q.status === 'WAIVED' ? 'badge-accepted' : ''}`}>{q.status.toLowerCase()}</span>
                          <div className="small muted">{q.rationale}</div>
                          {q.status === 'WAIVED' && (
                            <div className="small">
                              Waived by {q.waivedBy}: {q.waiverReason}
                            </div>
                          )}
                          <FileLinks files={q.files} canRemove={p.canManage && q.status === 'OPEN'} onChanged={reload} />
                        </div>
                        {q.status === 'OPEN' && kind !== 'NOT_APPLICABLE' && (
                          <div className="row-actions">
                            {p.canManage && <UploadEvidence entityType="EVIDENCE_REQUIREMENT" entityId={q.id} onUploaded={reload} />}
                            {p.canManage && q.files.length > 0 && (
                              <button
                                type="button"
                                className="btn btn-small btn-primary"
                                disabled={busy}
                                onClick={() => void run(() => api(`/api/requirements/${q.id}/satisfy`, { body: { expectedVersion: q.version } }), `${q.code} satisfied`).then(reload)}
                              >
                                Mark satisfied
                              </button>
                            )}
                            {p.canWaive && (
                              <button type="button" className="btn btn-small" onClick={() => setDialog({ waive: q })}>
                                Waive…
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </details>
            );
          })}
        </section>
      )}

      <section className="card">
        <div className="page-head" style={{ marginBottom: 6 }}>
          <h2>Exact source</h2>
          {p.canManage && !r.source_id && r.status === 'OPEN' && (
            <button type="button" className="btn btn-small btn-primary" onClick={() => setDialog('source')}>
              Identify exact source
            </button>
          )}
        </div>
        {data.gates && data.sourceStatus ? (
          <>
            <p style={{ marginTop: 0 }}>
              <SourceStatusBadge status={data.sourceStatus.status} />{' '}
              {data.gates.approvable ? (
                <span className="small">All gates met{data.gates.conditionalOnly ? ' (conditional approval only)' : ''}.</span>
              ) : (
                <span className="small">{data.gates.gates.filter((g) => g.status === 'FAIL').length} gate(s) not met.</span>
              )}
            </p>
            <GateList gates={data.gates.gates} />
          </>
        ) : (
          <div className="empty">Identify the part, supplier, manufacturing site, supplier part number and governing baseline revision to create the exact source.</div>
        )}
      </section>

      <section className="card">
        <h2>History</h2>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {data.history.map((h, i) => (
            <li key={i} className="small">
              {fmtDateTime(h.occurredAt)} — {h.actor ?? 'System'}: {h.summary}
              {h.reason ? ` — ${h.reason}` : ''}
            </li>
          ))}
        </ul>
      </section>

      <Dialog
        open={dialog === 'risk'}
        title="Risk assessment"
        onClose={close}
        footer={
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={async () => {
              if (await run(() => api(`/api/sourcing/${id}/risk`, { body: { inputs, rationale: text || null } }), 'Risk recorded; checklist updated')) {
                close();
                reload();
              }
            }}
          >
            Record assessment
          </button>
        }
      >
        <p className="small muted" style={{ marginTop: 0 }}>
          Interim method pending PDI approval (POL-04). Earlier assessments and satisfied evidence are kept.
        </p>
        {RISK_FACTORS.map((rf) => (
          <fieldset key={rf.key} style={{ border: 'none', padding: 0, margin: '0 0 10px' }}>
            <legend style={{ fontSize: 13, fontWeight: 600 }}>{rf.label}</legend>
            <div className="seg" role="radiogroup" aria-label={rf.label}>
              {[1, 2, 3].map((v) => (
                <button key={v} type="button" role="radio" aria-checked={inputs[rf.key] === v} className={inputs[rf.key] === v ? 's-N' : ''} onClick={() => setInputs({ ...inputs, [rf.key]: v })}>
                  {v}
                  <span>{v === 1 ? 'Low' : v === 2 ? 'Med' : 'High'}</span>
                </button>
              ))}
            </div>
            <div className="small muted">
              1 = {rf.low}; 3 = {rf.high}
            </div>
          </fieldset>
        ))}
        <div className="field">
          <label htmlFor="risk-rat">Rationale</label>
          <textarea id="risk-rat" value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        {banner}
      </Dialog>

      <Dialog
        open={dialog === 'edit'}
        title="Complete intake"
        onClose={close}
        footer={
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={async () => {
              const body: Record<string, unknown> = { expectedVersion: r.version };
              if (edit.part) body.partId = edit.part.id;
              if (edit.supplierId) body.supplierId = edit.supplierId;
              body.siteId = edit.siteId || null;
              if (edit.supplierPartNumber) body.supplierPartNumber = edit.supplierPartNumber;
              if (await run(() => api(`/api/sourcing/${id}`, { method: 'PATCH', body }), 'Intake updated')) {
                close();
                reload();
              }
            }}
          >
            Save
          </button>
        }
      >
        {!r.part_id && (
          <div className="field">
            <label htmlFor="part-number">Company part (create it under Parts first if new)</label>
            <PartTypeahead value={edit.part} onSelect={(part) => setEdit({ ...edit, part })} />
          </div>
        )}
        <SupplierSitePicker supplierId={edit.supplierId} siteId={edit.siteId} onChange={(supplierId, siteId) => setEdit({ ...edit, supplierId, siteId })} />
        <div className="field">
          <label htmlFor="ed-spn">Supplier part number</label>
          <input id="ed-spn" type="text" value={edit.supplierPartNumber} onChange={(e) => setEdit({ ...edit, supplierPartNumber: e.target.value })} />
        </div>
        {banner}
      </Dialog>

      <Dialog
        open={dialog === 'source'}
        title="Identify exact source"
        onClose={close}
        footer={
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !baselineRevisionId}
            onClick={async () => {
              if (await run(() => api(`/api/sourcing/${id}/source`, { body: { expectedVersion: r.version, baselineRevisionId } }), 'Exact source identified')) {
                close();
                reload();
              }
            }}
          >
            Create source
          </button>
        }
      >
        <p className="small" style={{ marginTop: 0 }}>
          {r.part_number} · {r.supplier_name} — {r.site_name ?? 'site not chosen'} · {r.supplier_part_number ?? 'supplier PN missing'} · {r.configuration}
        </p>
        <div className="field">
          <label htmlFor="src-rev">Governing baseline revision</label>
          <select id="src-rev" value={baselineRevisionId} onChange={(e) => setBaselineRevisionId(e.target.value)}>
            <option value="">Select…</option>
            {baselines.data?.baselines
              .filter((b) => b.ownership === expectedOwnership && b.status !== 'SUPERSEDED' && b.status !== 'OBSOLETE')
              .map((b) => (
                <option key={b.revisionId} value={b.revisionId}>
                  {b.title} Rev {b.revisionLabel} ({b.status.toLowerCase().replace('_', ' ')})
                </option>
              ))}
          </select>
          <div className="field-hint">
            Path {r.pathway} needs a {expectedOwnership.replaceAll('_', ' ').toLowerCase()} baseline. A draft may be linked now, but approval requires it to be released.
          </div>
        </div>
        {banner}
      </Dialog>

      <Dialog
        open={dialog === 'cancel'}
        title="Cancel sourcing request"
        onClose={close}
        footer={
          <button
            type="button"
            className="btn btn-danger"
            disabled={busy || text.trim().length < 5}
            onClick={async () => {
              if (await run(() => api(`/api/sourcing/${id}/cancel`, { body: { reason: text } }), 'Request cancelled')) {
                close();
                reload();
              }
            }}
          >
            Cancel request
          </button>
        }
      >
        <div className="field">
          <label htmlFor="cx-reason">Reason</label>
          <textarea id="cx-reason" value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        {banner}
      </Dialog>

      {dialog && typeof dialog === 'object' && (
        <Dialog
          open
          title={`Waive ${dialog.waive.code}`}
          onClose={close}
          footer={
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || text.trim().length < 10}
              onClick={async () => {
                if (await run(() => api(`/api/requirements/${dialog.waive.id}/waive`, { body: { expectedVersion: dialog.waive.version, reason: text } }), `${dialog.waive.code} waived`)) {
                  close();
                  reload();
                }
              }}
            >
              Record waiver
            </button>
          }
        >
          <p className="small" style={{ marginTop: 0 }}>
            {dialog.waive.title} — {dialog.waive.rationale}
          </p>
          <div className="field">
            <label htmlFor="wv-reason">Reason this evidence is not needed (recorded with your authority)</label>
            <textarea id="wv-reason" value={text} onChange={(e) => setText(e.target.value)} />
          </div>
          {banner}
        </Dialog>
      )}
    </>
  );
}
