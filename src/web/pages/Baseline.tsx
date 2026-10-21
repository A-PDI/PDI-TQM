import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, fmtDateTime } from '../api';
import { FileLinks, UploadEvidence, useBusy } from '../components/sourcing';
import { Dialog, LoadState, StatusBadge, useLoad } from '../components/ui';

interface Char {
  charKey: string;
  name: string;
  charType: 'DIMENSIONAL' | 'VISUAL' | 'FUNCTIONAL' | 'MATERIAL';
  formRowRef: string | null;
  unit: string | null;
  lower: string | null;
  upper: string | null;
  limitText: string | null;
  method: string | null;
  special: boolean;
  isDelta: boolean;
}

interface RevisionData {
  revision: Record<string, string | null> & { id: string; status: string; title: string; ownership: string; revision_label: string; part_id: string; part_number: string; baseline_id: string };
  characteristics: Char[];
  siblings: Array<{ id: string; revisionLabel: string; status: string }>;
  base: { id: string; revisionLabel: string; status: string; title: string; newerReleasedId: string | null; newerReleasedLabel: string | null } | null;
  sources: Array<{ id: string; supplier: string; site: string; approvalState: string }>;
  history: Array<{ occurredAt: string; summary: string; reason: string | null; actor: string | null; outcome: string }>;
  files: Array<{ linkId: string; fileId: string; name: string; sha256: string }>;
  formRows: Array<{ ref: string; label: string }>;
  permissions: { canEdit: boolean; canSubmit: boolean; canRelease: boolean; releaseBlockedReason: string | null; canRevise: boolean };
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'characteristic';

export function Baseline() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useLoad<RevisionData>(`/api/baseline-revisions/${id}`);
  const [chars, setChars] = useState<Char[]>([]);
  const [dirty, setDirty] = useState(false);
  const [dialog, setDialog] = useState<null | 'release' | 'return' | 'revise'>(null);
  const [text, setText] = useState('');
  const { busy, run, banner } = useBusy();
  useEffect(() => {
    if (data) {
      setChars(data.characteristics);
      setDirty(false);
    }
  }, [data]);
  if (!data) return <LoadState loading={loading} error={error} />;
  const r = data.revision;
  const p = data.permissions;
  const delta = r.ownership === 'SUPPLIER_PLUS_DELTA';
  const update = (i: number, patch: Partial<Char>) => {
    setChars((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)));
    setDirty(true);
  };
  const save = () =>
    run(async () => {
      await api(`/api/baseline-revisions/${id}/characteristics`, {
        method: 'PUT',
        body: { characteristics: chars.map((c) => ({ ...c, formRowRef: c.formRowRef || null, unit: c.unit || null, lower: c.lower || null, upper: c.upper || null })) },
      });
      reload();
    }, 'Draft saved');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            {r.title} — Rev {r.revision_label}
          </h1>
          <div className="small muted">
            <Link to={`/parts/${r.part_id}`}>{r.part_number}</Link> · {r.ownership === 'PDI' ? 'PDI-owned definition' : r.ownership === 'SUPPLIER' ? 'Supplier-owned specification' : 'Supplier base + PDI delta'} ·{' '}
            <StatusBadge status={r.status} /> {r.is_synthetic && <span className="badge badge-synthetic">synthetic — not PDI-approved</span>}
          </div>
        </div>
        <div className="row-actions">
          {p.canEdit && (
            <button type="button" className="btn" disabled={busy || !dirty} onClick={() => void save()}>
              Save draft
            </button>
          )}
          {p.canSubmit && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || dirty}
              title={dirty ? 'Save the draft first' : undefined}
              onClick={() => void run(async () => api(`/api/baseline-revisions/${id}/submit`, { method: 'POST' }), 'Submitted for release review').then(reload)}
            >
              Submit for release
            </button>
          )}
          {p.canRelease && (
            <>
              <button type="button" className="btn" onClick={() => setDialog('return')}>
                Return to draft
              </button>
              <button type="button" className="btn btn-primary" onClick={() => setDialog('release')}>
                Release…
              </button>
            </>
          )}
          {p.canRevise && (
            <button type="button" className="btn" onClick={() => setDialog('revise')}>
              Start new revision
            </button>
          )}
        </div>
      </div>
      {banner}
      {r.status === 'DRAFT' && <div className="notice">Draft — not a controlling requirement. Inspections, FAIs and source approvals use only released revisions.</div>}
      {p.releaseBlockedReason && <div className="notice notice-warn">{p.releaseBlockedReason}</div>}
      {data.base && (
        <div className={`notice ${data.base.newerReleasedLabel ? 'notice-warn' : ''}`}>
          Built on supplier base <Link to={`/baselines/${data.base.id}`}>{data.base.title} Rev {data.base.revisionLabel}</Link>.
          {data.base.newerReleasedLabel && (
            <>
              {' '}
              The supplier has since released <Link to={`/baselines/${data.base.newerReleasedId}`}>Rev {data.base.newerReleasedLabel}</Link>; this PDI configuration keeps Rev{' '}
              {data.base.revisionLabel} until a new delta revision is released through change control.
            </>
          )}
        </div>
      )}

      <section className="card">
        <dl className="kv">
          <dt>Document</dt>
          <dd>{r.document_ref ?? '—'}</dd>
          <dt>Authored by</dt>
          <dd>{r.authored_by_name ?? '—'}</dd>
          <dt>Submitted</dt>
          <dd>{r.submitted_at ? `${fmtDateTime(r.submitted_at)} · ${r.submitted_by_name}` : '—'}</dd>
          <dt>Released</dt>
          <dd>{r.released_at ? `${fmtDateTime(r.released_at)} · ${r.released_by_name}${r.release_rationale ? ` — ${r.release_rationale}` : ''}` : '—'}</dd>
          <dt>Revisions</dt>
          <dd>
            {data.siblings.map((s) => (
              <span key={s.id} style={{ marginRight: 8 }}>
                {s.id === id ? <strong>Rev {s.revisionLabel}</strong> : <Link to={`/baselines/${s.id}`}>Rev {s.revisionLabel}</Link>} <span className="small muted">({s.status.toLowerCase().replace('_', ' ')})</span>
              </span>
            ))}
          </dd>
          <dt>Documents</dt>
          <dd>
            <FileLinks files={data.files} canRemove={p.canEdit} onChanged={reload} /> {p.canEdit && <UploadEvidence entityType="BASELINE_REVISION" entityId={id} label="+ Attach drawing/spec" onUploaded={reload} />}
          </dd>
        </dl>
      </section>

      <section className="card">
        <div className="page-head" style={{ marginBottom: 6 }}>
          <h2>Characteristics and accepted limits</h2>
          {p.canEdit && (
            <button
              type="button"
              className="btn btn-small"
              onClick={() => {
                setChars((cs) => [...cs, { charKey: `new_${cs.length + 1}`, name: '', charType: 'DIMENSIONAL', formRowRef: null, unit: '', lower: '', upper: '', limitText: '', method: '', special: false, isDelta: delta }]);
                setDirty(true);
              }}
            >
              + Characteristic
            </button>
          )}
        </div>
        <p className="small muted" style={{ marginTop: 0 }}>
          Linking a characteristic to an inspection row makes its released limit govern that row; readings are compared exactly and never rounded.
        </p>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Characteristic</th>
                <th>Type</th>
                <th>Inspection row</th>
                <th>Lower</th>
                <th>Upper</th>
                <th>Unit</th>
                <th>Criterion / method</th>
                {delta && <th>PDI delta</th>}
                {p.canEdit && <th />}
              </tr>
            </thead>
            <tbody>
              {chars.length === 0 && (
                <tr>
                  <td colSpan={9}>
                    <div className="empty">No characteristics. Supplier specifications may be controlled by the referenced document alone.</div>
                  </td>
                </tr>
              )}
              {chars.map((c, i) =>
                p.canEdit ? (
                  <tr key={i}>
                    <td style={{ minWidth: 180 }}>
                      <input
                        type="text"
                        aria-label="Characteristic name"
                        value={c.name}
                        onChange={(e) => update(i, { name: e.target.value, charKey: c.charKey.startsWith('new_') || !c.name ? slug(e.target.value) : c.charKey })}
                      />
                      <div className="small muted">{c.charKey}</div>
                    </td>
                    <td>
                      <select aria-label="Type" value={c.charType} onChange={(e) => update(i, { charType: e.target.value as Char['charType'] })}>
                        <option value="DIMENSIONAL">Dimensional</option>
                        <option value="VISUAL">Visual</option>
                        <option value="FUNCTIONAL">Functional</option>
                        <option value="MATERIAL">Material</option>
                      </select>
                    </td>
                    <td>
                      <select aria-label="Inspection row" value={c.formRowRef ?? ''} onChange={(e) => update(i, { formRowRef: e.target.value || null })}>
                        <option value="">Not linked</option>
                        {data.formRows.map((fr) => (
                          <option key={fr.ref} value={fr.ref}>
                            {fr.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={{ width: 90 }}>
                      <input type="text" inputMode="decimal" aria-label="Lower limit" value={c.lower ?? ''} onChange={(e) => update(i, { lower: e.target.value })} />
                    </td>
                    <td style={{ width: 90 }}>
                      <input type="text" inputMode="decimal" aria-label="Upper limit" value={c.upper ?? ''} onChange={(e) => update(i, { upper: e.target.value })} />
                    </td>
                    <td style={{ width: 70 }}>
                      <input type="text" aria-label="Unit" value={c.unit ?? ''} onChange={(e) => update(i, { unit: e.target.value })} />
                    </td>
                    <td>
                      <input type="text" aria-label="Criterion" value={c.limitText ?? ''} onChange={(e) => update(i, { limitText: e.target.value })} />
                    </td>
                    {delta && (
                      <td>
                        <input type="checkbox" aria-label="PDI delta" checked={c.isDelta} onChange={(e) => update(i, { isDelta: e.target.checked })} />
                      </td>
                    )}
                    <td>
                      <button
                        type="button"
                        className="btn btn-small"
                        aria-label={`Remove ${c.name || 'characteristic'}`}
                        onClick={() => {
                          setChars((cs) => cs.filter((_, j) => j !== i));
                          setDirty(true);
                        }}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ) : (
                  <tr key={i}>
                    <td>{c.name}</td>
                    <td className="small">{c.charType.toLowerCase()}</td>
                    <td className="small">{data.formRows.find((fr) => fr.ref === c.formRowRef)?.label ?? c.formRowRef ?? '—'}</td>
                    <td>{c.lower ?? '—'}</td>
                    <td>{c.upper ?? '—'}</td>
                    <td>{c.unit ?? ''}</td>
                    <td className="small">{c.limitText ?? '—'}</td>
                    {delta && <td>{c.isDelta ? <span className="badge badge-accepted">delta</span> : ''}</td>}
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      </section>

      {data.sources.length > 0 && (
        <section className="card">
          <h2>Sources governed by this revision</h2>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {data.sources.map((s) => (
              <li key={s.id}>
                <Link to={`/sources/${s.id}`}>
                  {s.supplier} — {s.site}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h2>History</h2>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {data.history.map((h, i) => (
            <li key={i} className="small">
              {fmtDateTime(h.occurredAt)} — {h.actor ?? 'System'}: {h.summary}
              {h.outcome !== 'SUCCESS' ? ` (${h.outcome.toLowerCase()})` : ''}
              {h.reason ? ` — ${h.reason}` : ''}
            </li>
          ))}
        </ul>
      </section>

      <Dialog
        open={dialog !== null}
        title={dialog === 'release' ? `Release Rev ${r.revision_label}` : dialog === 'return' ? 'Return to draft' : 'Start new revision'}
        onClose={() => {
          setDialog(null);
          setText('');
        }}
        footer={
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || (dialog === 'revise' ? !text : text.trim().length < 5)}
            onClick={async () => {
              let nextId = '';
              const ok = await run(async () => {
                if (dialog === 'release') await api(`/api/baseline-revisions/${id}/release`, { body: { rationale: text } });
                else if (dialog === 'return') await api(`/api/baseline-revisions/${id}/return`, { body: { reason: text } });
                else nextId = (await api<{ revisionId: string }>(`/api/baselines/${r.baseline_id}/revisions`, { body: { revisionLabel: text } })).revisionId;
              });
              if (!ok) return;
              setDialog(null);
              setText('');
              if (nextId) navigate(`/baselines/${nextId}`);
              else reload();
            }}
          >
            {dialog === 'release' ? 'Release' : dialog === 'return' ? 'Return' : 'Create draft'}
          </button>
        }
      >
        {dialog === 'release' && (
          <p className="small" style={{ marginTop: 0 }}>
            Releasing makes this revision controlling for new work and supersedes the current release. Existing sources, inspections and approvals keep the exact revision they used.
          </p>
        )}
        <div className="field">
          <label htmlFor="bl-text">{dialog === 'revise' ? 'New revision label' : dialog === 'release' ? 'Release rationale (what was checked)' : 'Reason'}</label>
          {dialog === 'revise' ? (
            <input id="bl-text" type="text" maxLength={10} value={text} onChange={(e) => setText(e.target.value)} />
          ) : (
            <textarea id="bl-text" value={text} onChange={(e) => setText(e.target.value)} />
          )}
        </div>
        {banner}
      </Dialog>
    </>
  );
}
