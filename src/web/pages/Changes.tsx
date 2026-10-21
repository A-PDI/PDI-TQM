import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  CHANGE_ACTION_KINDS,
  CHANGE_ACTION_TEXT,
  CHANGE_CATEGORIES,
  CHANGE_CATEGORY_TEXT,
  CHANGE_STATUS_TEXT,
  type CharacteristicDiffRow,
  IMPACT_AREAS,
  IMPACT_AREA_TEXT,
  PRE_EFFECTIVE_ACTIONS,
} from '../../shared/quality';
import type { EffectiveSourceStatus } from '../../shared/sourcing';
import { api, fmtDate, fmtDateTime } from '../api';
import { useAuth } from '../auth';
import { HistoryCard, type HistoryRow, RecordPdfs, type Rendition, StateBadge, UserSelect, addDays, todayIso, useDirectory } from '../components/quality';
import { FileLinks, type FileRef, SourceStatusBadge, UploadEvidence, useBusy } from '../components/sourcing';
import { Dialog, LoadState, OutcomeBadge, type PartOption, PartTypeahead, useLoad } from '../components/ui';

export function ChangeList() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'OPEN';
  const [open, setOpen] = useState(false);
  const { data, error, loading } = useLoad<
    Array<{ id: string; number: string; title: string; origin: string; status: string; categories: string[]; requestedAt: string; partNumber: string; supplier: string | null; owner: string; requalificationRequired: boolean | null }>
  >(`/api/changes?status=${status === 'ALL' ? '' : status}`);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Changes</h1>
          <div className="muted small">PDI and supplier changes (OPS-03/04, ENG-09): compare revisions, assess impact, decide, make effective and verify the first conforming lot.</div>
        </div>
        {can('change.manage') && (
          <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
            New change
          </button>
        )}
      </div>
      <div className="row-actions card" role="group" aria-label="Status filter">
        {[
          ['OPEN', 'Open'],
          ['IMPLEMENTATION_VERIFIED', 'Verified'],
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
                <th>Change</th>
                <th>Part / supplier</th>
                <th>Scope</th>
                <th>Owner</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <div className="empty">No changes in this view.</div>
                  </td>
                </tr>
              )}
              {data.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => navigate(`/changes/${c.id}`)}>
                  <td>
                    <Link to={`/changes/${c.id}`} onClick={(e) => e.stopPropagation()}>
                      {c.title}
                    </Link>
                    <div className="small muted">
                      {c.number} · {c.origin === 'SUPPLIER' ? 'supplier' : 'PDI'} · {fmtDate(c.requestedAt)}
                    </div>
                  </td>
                  <td className="small">
                    {c.partNumber}
                    {c.supplier ? <div className="muted">{c.supplier}</div> : null}
                  </td>
                  <td className="small">
                    {c.categories.map((k) => CHANGE_CATEGORY_TEXT[k as keyof typeof CHANGE_CATEGORY_TEXT] ?? k).join(', ')}
                    {c.requalificationRequired ? <div className="muted">requalification required</div> : null}
                  </td>
                  <td className="small">{c.owner}</td>
                  <td>
                    <StateBadge state={c.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <NewChangeDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function NewChangeDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const { me } = useAuth();
  const owners = useDirectory('change.manage');
  const [part, setPart] = useState<PartOption | null>(null);
  const detail = useLoad<{ sources: Array<{ id: string; supplierId: string; supplier: string; site: string; supplierPartNumber: string; baselineRevision: string | null }>; baselines: Array<{ title: string; revisionId: string; revisionLabel: string; status: string }> }>(
    part ? `/api/parts/${part.id}` : null,
  );
  const [f, setF] = useState({
    origin: 'SUPPLIER',
    title: '',
    description: '',
    justification: '',
    supplierReference: '',
    supplierRepresentative: '',
    currentRevisionId: '',
    proposedRevisionId: '',
    desiredEffectiveDate: addDays(30),
    affectedStock: '',
    ownerId: me?.user.id ?? '',
  });
  const [categories, setCategories] = useState<string[]>([]);
  const [sourceIds, setSourceIds] = useState<string[]>([]);
  const { busy, run, banner } = useBusy();
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const sources = detail.data?.sources ?? [];
  const supplierId = sources.find((s) => sourceIds.includes(s.id))?.supplierId ?? null;
  return (
    <Dialog
      open
      title="New change"
      onClose={onClose}
      footer={
        <button type="submit" form="chg-form" className="btn btn-primary" disabled={busy || !part}>
          Propose change
        </button>
      }
    >
      <form
        id="chg-form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!part) return;
          let id = '';
          const ok = await run(async () => {
            id = (
              await api<{ id: string }>('/api/changes', {
                body: {
                  origin: f.origin,
                  title: f.title,
                  description: f.description,
                  justification: f.justification,
                  categories,
                  partId: part.id,
                  supplierId,
                  sourceIds,
                  currentRevisionId: f.currentRevisionId || null,
                  proposedRevisionId: f.proposedRevisionId || null,
                  supplierReference: f.supplierReference || null,
                  supplierRepresentative: f.supplierRepresentative || null,
                  desiredEffectiveDate: f.desiredEffectiveDate || null,
                  affectedStock: f.affectedStock || null,
                  ownerId: f.ownerId,
                },
              })
            ).id;
          });
          if (ok) navigate(`/changes/${id}`);
        }}
      >
        <fieldset className="field" style={{ border: 'none', padding: 0 }}>
          <legend className="small" style={{ fontWeight: 600 }}>
            Origin
          </legend>
          <label style={{ display: 'inline-flex', gap: 6, marginRight: 14, fontWeight: 400 }}>
            <input type="radio" name="origin" checked={f.origin === 'SUPPLIER'} onChange={() => setF({ ...f, origin: 'SUPPLIER' })} /> Supplier (PCN)
          </label>
          <label style={{ display: 'inline-flex', gap: 6, fontWeight: 400 }}>
            <input type="radio" name="origin" checked={f.origin === 'PDI'} onChange={() => setF({ ...f, origin: 'PDI' })} /> PDI
          </label>
        </fieldset>
        <div className="field">
          <label htmlFor="part-number">Company part</label>
          <PartTypeahead value={part} onSelect={setPart} />
        </div>
        <div className="field">
          <label htmlFor="chg-title">Title</label>
          <input id="chg-title" type="text" value={f.title} onChange={set('title')} required />
        </div>
        <fieldset className="field" style={{ border: 'none', padding: 0 }}>
          <legend className="small" style={{ fontWeight: 600 }}>
            What changes
          </legend>
          {CHANGE_CATEGORIES.map((k) => (
            <label key={k} style={{ display: 'inline-flex', gap: 6, marginRight: 12, fontWeight: 400 }}>
              <input type="checkbox" checked={categories.includes(k)} onChange={(e) => setCategories(e.target.checked ? [...categories, k] : categories.filter((x) => x !== k))} />
              {CHANGE_CATEGORY_TEXT[k]}
            </label>
          ))}
        </fieldset>
        <div className="field">
          <label htmlFor="chg-desc">Description (old vs proposed)</label>
          <textarea id="chg-desc" value={f.description} onChange={set('description')} required minLength={10} />
        </div>
        <div className="field">
          <label htmlFor="chg-why">Justification</label>
          <textarea id="chg-why" value={f.justification} onChange={set('justification')} required />
        </div>
        {part && (
          <>
            <fieldset className="field" style={{ border: 'none', padding: 0 }}>
              <legend className="small" style={{ fontWeight: 600 }}>
                Affected exact sources
              </legend>
              {sources.length === 0 && <div className="small muted">No sources for this part.</div>}
              {sources.map((s) => (
                <label key={s.id} style={{ display: 'flex', gap: 6, fontWeight: 400 }}>
                  <input type="checkbox" checked={sourceIds.includes(s.id)} onChange={(e) => setSourceIds(e.target.checked ? [...sourceIds, s.id] : sourceIds.filter((x) => x !== s.id))} />
                  {s.supplier} / {s.site} — {s.supplierPartNumber} (Rev {s.baselineRevision ?? '—'})
                </label>
              ))}
            </fieldset>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
              {(['currentRevisionId', 'proposedRevisionId'] as const).map((k) => (
                <div className="field" key={k}>
                  <label htmlFor={`chg-${k}`}>{k === 'currentRevisionId' ? 'Current revision' : 'Proposed revision (draft is fine)'}</label>
                  <select id={`chg-${k}`} value={f[k]} onChange={set(k)}>
                    <option value="">None</option>
                    {detail.data?.baselines.map((b) => (
                      <option key={b.revisionId} value={b.revisionId}>
                        {b.title} Rev {b.revisionLabel} ({b.status.toLowerCase()})
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
          </>
        )}
        {f.origin === 'SUPPLIER' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
            <div className="field">
              <label htmlFor="chg-ref">Supplier reference (PCN)</label>
              <input id="chg-ref" type="text" value={f.supplierReference} onChange={set('supplierReference')} />
            </div>
            <div className="field">
              <label htmlFor="chg-rep">Supplier representative</label>
              <input id="chg-rep" type="text" value={f.supplierRepresentative} onChange={set('supplierRepresentative')} required />
            </div>
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
          <div className="field">
            <label htmlFor="chg-date">Desired effective date</label>
            <input id="chg-date" type="date" value={f.desiredEffectiveDate} onChange={set('desiredEffectiveDate')} />
          </div>
          <UserSelect id="chg-owner" label="Owner" value={f.ownerId} onChange={(v) => setF({ ...f, ownerId: v })} users={owners} />
        </div>
        <div className="field">
          <label htmlFor="chg-stock">Affected stock, lots and open orders</label>
          <textarea id="chg-stock" value={f.affectedStock} onChange={set('affectedStock')} />
        </div>
        {banner}
      </form>
    </Dialog>
  );
}

interface ChangeData {
  change: Record<string, string | number | boolean | string[] | null> & {
    id: string;
    number: string;
    status: string;
    statusText: string;
    version: number;
    categories: string[];
    requalification_required: boolean | null;
    proposed_revision_id: string | null;
    current_revision_id: string | null;
  };
  sources: Array<{ id: string; partNumber: string; supplier: string; site: string; supplierPartNumber: string; revisionLabel: string | null; effective?: { status: EffectiveSourceStatus; reasons: string[] } }>;
  impact: Array<{ area: (typeof IMPACT_AREAS)[number]; affected: boolean; assessment: string }>;
  actions: Array<{ id: string; kind: (typeof CHANGE_ACTION_KINDS)[number]; title: string; status: string; dueDate: string | null; waivable: boolean; completionNote: string | null; completedAt: string | null; owner: string; ownerId: string; completedBy: string | null }>;
  diff: CharacteristicDiffRow[];
  inspections: Array<{ id: string; number: string; status: string; outcome: string | null; dateReceived: string; lotNumber: string | null; revisionLabel: string | null; onProposed: boolean }>;
  commitments: Array<{ id: string; number: string; promisedAction: string; status: string }>;
  files: FileRef[];
  history: HistoryRow[];
  renditions: Rendition[];
  permissions: { manage: boolean; decide: boolean; decideBlockedReason: string | null; verify: boolean; waive: boolean };
}

const limitText = (x: Record<string, unknown> | null) =>
  x ? `${x.lower ?? '—'} – ${x.upper ?? '—'} ${x.unit ?? ''}${x.limitText ? ` ${String(x.limitText)}` : ''}`.trim() : '—';

export function ChangeDetail() {
  const { id = '' } = useParams();
  const { me } = useAuth();
  const { data, error, loading, reload } = useLoad<ChangeData>(`/api/changes/${id}`);
  const { busy, run, banner } = useBusy();
  const [dialog, setDialog] = useState<'impact' | 'action' | 'decide' | 'effective' | 'verify' | 'cancel' | null>(null);
  if (!data) return <LoadState loading={loading} error={error} />;
  const c = data.change;
  const p = data.permissions;
  const done = () => {
    setDialog(null);
    reload();
  };
  const changed = data.diff.filter((d) => d.change !== 'UNCHANGED');
  return (
    <>
      <div className="page-head">
        <div>
          <h1>{c.title}</h1>
          <div className="small muted">
            {c.number} · {c.origin === 'SUPPLIER' ? `supplier ${c.supplier_name ?? ''} ${c.supplier_reference ? `(${c.supplier_reference})` : ''}` : 'PDI'} · requested {fmtDateTime(c.requested_at as string)} by {c.requested_by_name} · owner{' '}
            {c.owner_name}
          </div>
          <StateBadge state={c.status} text={c.statusText} />
        </div>
        <Link className="btn" to="/changes">
          Back to changes
        </Link>
      </div>
      <div className="card">
        <dl className="kv">
          <dt>Part</dt>
          <dd>
            <Link to={`/parts/${c.part_id}`}>{c.part_number}</Link> — {c.part_description}
          </dd>
          <dt>What changes</dt>
          <dd>{c.categories.map((k) => CHANGE_CATEGORY_TEXT[k as keyof typeof CHANGE_CATEGORY_TEXT] ?? k).join(', ')}</dd>
          <dt>Description</dt>
          <dd>{c.description}</dd>
          <dt>Justification</dt>
          <dd>{c.justification}</dd>
          {c.supplier_representative && (
            <>
              <dt>Supplier representative</dt>
              <dd>{c.supplier_representative}</dd>
            </>
          )}
          <dt>Revisions</dt>
          <dd>
            {c.current_revision_id ? <Link to={`/baselines/${c.current_revision_id}`}>{`${c.current_baseline_title} Rev ${c.current_revision_label}`}</Link> : '—'} →{' '}
            {c.proposed_revision_id ? (
              <>
                <Link to={`/baselines/${c.proposed_revision_id}`}>{`${c.proposed_baseline_title} Rev ${c.proposed_revision_label}`}</Link> <StateBadge state={String(c.proposed_revision_status)} />
              </>
            ) : (
              '—'
            )}
          </dd>
          <dt>Desired effective</dt>
          <dd>{c.desired_effective_date ? fmtDate(c.desired_effective_date as string) : '—'}</dd>
          <dt>Affected stock</dt>
          <dd>{c.affected_stock ?? '—'}</dd>
          {c.decided_by_name && (
            <>
              <dt>Decision</dt>
              <dd>
                {c.status === 'REJECTED' ? 'Rejected' : 'Approved'} by {c.decided_by_name}, {fmtDateTime(c.decided_at as string)} — {c.decision_rationale}
                {c.conditions ? ` Conditions: ${c.conditions}` : ''}
              </dd>
            </>
          )}
          {c.effective_date && (
            <>
              <dt>Effective</dt>
              <dd>
                {fmtDate(c.effective_date as string)}
                {c.effective_lot ? `, first lot ${c.effective_lot}` : ''} — {c.effective_note} ({c.made_effective_by_name})
              </dd>
            </>
          )}
          {c.implementation_verified_by_name && (
            <>
              <dt>Implementation</dt>
              <dd>
                Verified by {c.implementation_verified_by_name} with <Link to={`/inspections/${c.implementation_inspection_id}`}>{c.implementation_inspection_number}</Link> — {c.implementation_note}
              </dd>
            </>
          )}
        </dl>
        <div style={{ marginTop: 8 }}>
          <FileLinks files={data.files} /> {p.manage && <UploadEvidence entityType="CHANGE" entityId={id} onUploaded={reload} />}
        </div>
      </div>

      <div className="card row-actions">
        {p.manage && ['PROPOSED', 'IMPACT_ASSESSED'].includes(c.status) && (
          <button type="button" className="btn btn-primary" onClick={() => setDialog('impact')}>
            {c.status === 'PROPOSED' ? 'Assess impact…' : 'Reassess impact…'}
          </button>
        )}
        {p.manage && ['PROPOSED', 'IMPACT_ASSESSED', 'APPROVED', 'EFFECTIVE'].includes(c.status) && (
          <button type="button" className="btn" onClick={() => setDialog('action')}>
            + Add action
          </button>
        )}
        {p.decide && c.status === 'IMPACT_ASSESSED' && (
          <button type="button" className="btn btn-primary" onClick={() => setDialog('decide')}>
            Decide…
          </button>
        )}
        {p.decideBlockedReason && c.status === 'IMPACT_ASSESSED' && <span className="small muted">{p.decideBlockedReason}</span>}
        {p.manage && c.status === 'APPROVED' && (
          <button type="button" className="btn btn-primary" onClick={() => setDialog('effective')}>
            Make effective…
          </button>
        )}
        {p.verify && c.status === 'EFFECTIVE' && (
          <button type="button" className="btn btn-primary" onClick={() => setDialog('verify')}>
            Verify implementation…
          </button>
        )}
        {p.manage && ['PROPOSED', 'IMPACT_ASSESSED', 'APPROVED'].includes(c.status) && (
          <button type="button" className="btn btn-danger" onClick={() => setDialog('cancel')}>
            Cancel change…
          </button>
        )}
        <span className="small muted">{CHANGE_STATUS_TEXT[c.status]}</span>
      </div>
      {banner}

      <section className="card" aria-labelledby="diff-h">
        <h2 id="diff-h">Before / after</h2>
        {!c.proposed_revision_id ? (
          <p className="small muted">Link a proposed revision to compare characteristics.</p>
        ) : changed.length === 0 ? (
          <p className="small muted">No characteristic differences between the revisions.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Characteristic</th>
                  <th>Change</th>
                  <th>Before</th>
                  <th>After</th>
                </tr>
              </thead>
              <tbody>
                {changed.map((d) => (
                  <tr key={d.charKey}>
                    <td>{d.name}</td>
                    <td>
                      <StateBadge state={d.change === 'ADDED' ? 'APPROVED' : d.change === 'REMOVED' ? 'REJECTED' : 'CHANGED'} text={d.change.toLowerCase()} />
                      {d.fields.length ? <div className="small muted">{d.fields.join(', ')}</div> : null}
                    </td>
                    <td className="small">{limitText(d.before)}</td>
                    <td className="small">{limitText(d.after)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Affected exact sources</h2>
        {data.sources.length === 0 ? (
          <p className="small muted">None listed.</p>
        ) : (
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {data.sources.map((s) => (
              <li key={s.id}>
                <Link to={`/sources/${s.id}`}>
                  {s.supplier} / {s.site} — {s.supplierPartNumber} Rev {s.revisionLabel ?? '—'}
                </Link>{' '}
                <SourceStatusBadge status={s.effective?.status} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>Impact assessment</h2>
        {data.impact.length === 0 ? (
          <p className="small muted">Not assessed yet.</p>
        ) : (
          <>
            <p className="small">
              {c.impact_summary} — requalification <strong>{c.requalification_required ? 'required' : 'not required'}</strong> ({c.impact_assessed_by_name})
            </p>
            <dl className="kv">
              {IMPACT_AREAS.map((a) => {
                const item = data.impact.find((i) => i.area === a);
                return item ? (
                  <div key={a} style={{ display: 'contents' }}>
                    <dt>{IMPACT_AREA_TEXT[a]}</dt>
                    <dd>
                      {item.affected ? <strong>Affected: </strong> : 'Not affected: '}
                      {item.assessment}
                    </dd>
                  </div>
                ) : null;
              })}
            </dl>
          </>
        )}
      </section>

      <section className="card">
        <h2>Requalification and implementation actions</h2>
        {data.actions.length === 0 ? (
          <p className="small muted">No actions.</p>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Owner / due</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.actions.map((a) => (
                  <tr key={a.id}>
                    <td>
                      {a.title}
                      <div className="small muted">
                        {PRE_EFFECTIVE_ACTIONS.has(a.kind) ? 'Before effectivity' : 'Before implementation is verified'}
                        {a.waivable ? '' : ' · not waivable'}
                      </div>
                    </td>
                    <td className="small">
                      {a.owner}
                      <div className="muted">{a.dueDate ? fmtDate(a.dueDate) : 'No date'}</div>
                    </td>
                    <td className="small">
                      <StateBadge state={a.status} />
                      {a.completionNote ? <div className="muted">{a.completionNote}</div> : null}
                    </td>
                    <td>
                      {a.status === 'OPEN' && (
                        <div className="row-actions">
                          {(a.ownerId === me?.user.id || p.manage) && (
                            <button
                              type="button"
                              className="btn btn-small"
                              disabled={busy}
                              onClick={() => {
                                const note = window.prompt(`How was "${a.title}" completed?`);
                                if (note) void run(() => api(`/api/change-actions/${a.id}/complete`, { body: { note } }), 'Action completed.').then(reload);
                              }}
                            >
                              Complete
                            </button>
                          )}
                          {p.waive && a.waivable && (
                            <button
                              type="button"
                              className="btn btn-small"
                              disabled={busy}
                              onClick={() => {
                                const reason = window.prompt(`Reason for waiving "${a.title}"`);
                                if (reason) void run(() => api(`/api/change-actions/${a.id}/waive`, { body: { reason } }), 'Action waived.').then(reload);
                              }}
                            >
                              Waive
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <h2>Lots received for this part</h2>
        <p className="small muted">Each lot keeps the revision it was received under; earlier lots never inherit the change.</p>
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
          {data.inspections.map((i) => (
            <li key={i.id}>
              <Link to={`/inspections/${i.id}`}>{i.number}</Link> · lot {i.lotNumber ?? '—'} · {fmtDate(i.dateReceived)} · Rev {i.revisionLabel ?? '—'} {i.onProposed ? '(changed revision)' : ''} <OutcomeBadge outcome={i.outcome} />
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Controlled record</h2>
        <RecordPdfs renditions={data.renditions} issueUrl={`/api/changes/${id}/report`} docCode="OPS-04" canIssue={p.manage} onIssued={reload} />
      </section>
      <HistoryCard history={data.history} />

      {dialog === 'impact' && <ImpactDialog change={c} existing={data.impact} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === 'action' && <ActionDialog changeId={id} requal={Boolean(c.requalification_required)} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === 'decide' && <DecideDialog change={c} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === 'effective' && <EffectiveDialog changeId={id} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === 'verify' && <VerifyChangeDialog changeId={id} inspections={data.inspections.filter((i) => i.status === 'COMPLETED')} onClose={() => setDialog(null)} onDone={done} />}
      {dialog === 'cancel' && (
        <Dialog
          open
          title="Cancel change"
          onClose={() => setDialog(null)}
          footer={
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={async () => {
                const reason = (document.getElementById('chg-cancel') as HTMLTextAreaElement | null)?.value ?? '';
                if (await run(() => api(`/api/changes/${id}/cancel`, { body: { reason } }))) done();
              }}
            >
              Cancel change
            </button>
          }
        >
          <div className="field">
            <label htmlFor="chg-cancel">Reason</label>
            <textarea id="chg-cancel" />
          </div>
          {banner}
        </Dialog>
      )}
    </>
  );
}

function ImpactDialog({ change, existing, onClose, onDone }: { change: ChangeData['change']; existing: ChangeData['impact']; onClose: () => void; onDone: () => void }) {
  const [items, setItems] = useState(IMPACT_AREAS.map((area) => existing.find((e) => e.area === area) ?? { area, affected: false, assessment: '' }));
  const [summary, setSummary] = useState((change.impact_summary as string) ?? '');
  const [requal, setRequal] = useState(Boolean(change.requalification_required) || change.categories.includes('SITE'));
  const { busy, run, banner } = useBusy();
  return (
    <Dialog
      open
      title="Impact assessment"
      onClose={onClose}
      footer={
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={async () => (await run(() => api(`/api/changes/${change.id}/impact`, { method: 'PUT', body: { expectedVersion: change.version, summary, requalificationRequired: requal, items } }))) && onDone()}
        >
          Record assessment
        </button>
      }
    >
      {items.map((it, i) => (
        <div key={it.area} className="field" style={{ borderTop: i ? '1px solid var(--border)' : undefined, paddingTop: i ? 8 : 0 }}>
          <label htmlFor={`imp-${it.area}`} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={it.affected}
              aria-label={`${IMPACT_AREA_TEXT[it.area]} affected`}
              onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, affected: e.target.checked } : x)))}
            />
            {IMPACT_AREA_TEXT[it.area]}
          </label>
          <input id={`imp-${it.area}`} type="text" placeholder="Assessment" value={it.assessment} onChange={(e) => setItems(items.map((x, j) => (j === i ? { ...x, assessment: e.target.value } : x)))} />
        </div>
      ))}
      <div className="field">
        <label htmlFor="imp-summary">Summary</label>
        <textarea id="imp-summary" value={summary} onChange={(e) => setSummary(e.target.value)} />
      </div>
      <label style={{ display: 'flex', gap: 8, fontWeight: 400 }}>
        <input type="checkbox" checked={requal} onChange={(e) => setRequal(e.target.checked)} /> Requalification required (new first article and/or source approval)
      </label>
      {banner}
    </Dialog>
  );
}

function ActionDialog({ changeId, requal, onClose, onDone }: { changeId: string; requal: boolean; onClose: () => void; onDone: () => void }) {
  const owners = useDirectory();
  const [f, setF] = useState({ kind: requal ? 'REQUALIFY_FAI' : 'BASELINE_RELEASE', title: '', ownerId: '', dueDate: addDays(14), waivable: true });
  const { busy, run, banner } = useBusy();
  return (
    <Dialog
      open
      title="Add action"
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-primary" disabled={busy} onClick={async () => (await run(() => api(`/api/changes/${changeId}/actions`, { body: { ...f, title: f.title || undefined } }))) && onDone()}>
          Add action
        </button>
      }
    >
      <div className="field">
        <label htmlFor="act-kind">Kind</label>
        <select id="act-kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
          {CHANGE_ACTION_KINDS.map((k) => (
            <option key={k} value={k}>
              {CHANGE_ACTION_TEXT[k]}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="act-title">Title (optional)</label>
        <input id="act-title" type="text" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
      </div>
      <UserSelect id="act-owner" label="Owner" value={f.ownerId} onChange={(v) => setF({ ...f, ownerId: v })} users={owners} />
      <div className="field">
        <label htmlFor="act-due">Due</label>
        <input id="act-due" type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} />
      </div>
      <label style={{ display: 'flex', gap: 8, fontWeight: 400 }}>
        <input type="checkbox" checked={f.waivable} onChange={(e) => setF({ ...f, waivable: e.target.checked })} /> May be waived with authority and reason
      </label>
      {banner}
    </Dialog>
  );
}

function DecideDialog({ change, onClose, onDone }: { change: ChangeData['change']; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ decision: 'APPROVED', rationale: '', conditions: '' });
  const { busy, run, banner } = useBusy();
  return (
    <Dialog
      open
      title={`Decide ${change.number}`}
      onClose={onClose}
      footer={
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={async () => (await run(() => api(`/api/changes/${change.id}/decide`, { body: { expectedVersion: change.version, decision: f.decision, rationale: f.rationale, conditions: f.conditions || null } }))) && onDone()}
        >
          Record decision
        </button>
      }
    >
      <p className="small muted">Approval releases the decision only; the change still needs effectivity and a verified first conforming lot.</p>
      <div className="field">
        <label htmlFor="dec-decision">Decision</label>
        <select id="dec-decision" value={f.decision} onChange={(e) => setF({ ...f, decision: e.target.value })}>
          <option value="APPROVED">Approve</option>
          <option value="REJECTED">Reject</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="dec-why">Rationale</label>
        <textarea id="dec-why" value={f.rationale} onChange={(e) => setF({ ...f, rationale: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="dec-cond">Conditions (optional)</label>
        <input id="dec-cond" type="text" value={f.conditions} onChange={(e) => setF({ ...f, conditions: e.target.value })} />
      </div>
      {banner}
    </Dialog>
  );
}

function EffectiveDialog({ changeId, onClose, onDone }: { changeId: string; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ effectiveDate: todayIso(), effectiveLot: '', note: '' });
  const { busy, run, banner } = useBusy();
  return (
    <Dialog
      open
      title="Make change effective"
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-primary" disabled={busy} onClick={async () => (await run(() => api(`/api/changes/${changeId}/effective`, { body: { ...f, effectiveLot: f.effectiveLot || null } }))) && onDone()}>
          Make effective
        </button>
      }
    >
      <div className="field">
        <label htmlFor="eff-date">Effective date</label>
        <input id="eff-date" type="date" value={f.effectiveDate} onChange={(e) => setF({ ...f, effectiveDate: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="eff-lot">First effective lot (optional)</label>
        <input id="eff-lot" type="text" value={f.effectiveLot} onChange={(e) => setF({ ...f, effectiveLot: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="eff-note">Note</label>
        <textarea id="eff-note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
      </div>
      {banner}
    </Dialog>
  );
}

function VerifyChangeDialog({ changeId, inspections, onClose, onDone }: { changeId: string; inspections: ChangeData['inspections']; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ inspectionId: '', note: '' });
  const { busy, run, banner } = useBusy();
  return (
    <Dialog
      open
      title="Verify implementation"
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-primary" disabled={busy || !f.inspectionId} onClick={async () => (await run(() => api(`/api/changes/${changeId}/verify-implementation`, { body: f }))) && onDone()}>
          Record verification
        </button>
      }
    >
      <p className="small muted">Choose the completed, passing inspection of the first lot received under the changed revision. A supplier statement is not proof.</p>
      <div className="field">
        <label htmlFor="ver-insp">First conforming lot</label>
        <select id="ver-insp" value={f.inspectionId} onChange={(e) => setF({ ...f, inspectionId: e.target.value })}>
          <option value="">Select…</option>
          {inspections.map((i) => (
            <option key={i.id} value={i.id}>
              {i.number} · lot {i.lotNumber ?? '—'} · Rev {i.revisionLabel ?? '—'} · {i.outcome ?? '—'} · {fmtDate(i.dateReceived)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="ver-note">Note</label>
        <textarea id="ver-note" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
      </div>
      {banner}
    </Dialog>
  );
}
