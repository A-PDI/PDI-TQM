import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { FormDefinition, FormSection, SectionPattern } from '../../shared/forms';
import { api, fmtDate, fmtDateTime } from '../api';
import { useAuth } from '../auth';
import { HistoryCard, type HistoryRow, StateBadge } from '../components/quality';
import { useBusy } from '../components/sourcing';
import { Dialog, LoadState, useLoad } from '../components/ui';

interface FormRow {
  revisionId: string;
  formNumber: string;
  component: string;
  revisionLabel: string | null;
  sequence: number;
  status: string;
  releasedAt: string | null;
  inspectionCount: number;
}

export function FormsList() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const { data, error, loading } = useLoad<FormRow[]>('/api/forms?all=1');
  const [draftFor, setDraftFor] = useState<FormRow | null>(null);
  const forms = new Map<string, FormRow[]>();
  for (const r of (data ?? []).filter((x) => x.status !== 'ONE_OFF')) forms.set(r.formNumber, [...(forms.get(r.formNumber) ?? []), r]);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Inspection forms</h1>
          <div className="muted small">Controlled form revisions. Edits create a new draft; only a released revision starts new inspections, and completed inspections keep the revision they used.</div>
        </div>
        <Link className="btn" to="/inspections">
          Inspections
        </Link>
      </div>
      <LoadState loading={loading && !data} error={error} />
      {data && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Form</th>
                <th>Released</th>
                <th>In progress</th>
                <th>History</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {[...forms.entries()].map(([num, revs]) => {
                const released = revs.find((r) => r.status === 'RELEASED');
                const working = revs.filter((r) => r.status === 'DRAFT' || r.status === 'IN_REVIEW');
                return (
                  <tr key={num}>
                    <td>
                      <strong>{num}</strong>
                      <div className="small muted">{revs[0]!.component}</div>
                    </td>
                    <td className="small">
                      {released ? (
                        <Link to={`/forms/${released.revisionId}`}>
                          {released.revisionLabel ? `Rev ${released.revisionLabel}` : 'Original'} · {released.inspectionCount} inspection(s)
                        </Link>
                      ) : (
                        <span className="muted">None (historical)</span>
                      )}
                    </td>
                    <td className="small">
                      {working.map((w) => (
                        <div key={w.revisionId}>
                          <Link to={`/forms/${w.revisionId}`}>Rev {w.revisionLabel}</Link> <StateBadge state={w.status} />
                        </div>
                      ))}
                    </td>
                    <td className="small muted">{revs.filter((r) => r.status === 'SUPERSEDED' || r.status === 'OBSOLETE').length} earlier</td>
                    <td>
                      {can('forms.publish') && released && !working.length && (
                        <button type="button" className="btn btn-small" onClick={() => setDraftFor(released)}>
                          New revision…
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {draftFor && <NewDraftDialog form={draftFor} onClose={() => setDraftFor(null)} onCreated={(id) => navigate(`/forms/${id}`)} />}
    </>
  );
}

function NewDraftDialog({ form, onClose, onCreated }: { form: FormRow; onClose: () => void; onCreated: (id: string) => void }) {
  const [label, setLabel] = useState('');
  const [summary, setSummary] = useState('');
  const { busy, run, banner } = useBusy();
  return (
    <Dialog
      open
      title={`New revision of ${form.formNumber}`}
      onClose={onClose}
      footer={
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={async () => {
            let id = '';
            if (await run(async () => (id = (await api<{ id: string }>(`/api/form-revisions/${form.revisionId}/drafts`, { body: { revisionLabel: label, changeSummary: summary } })).id))) onCreated(id);
          }}
        >
          Create draft
        </button>
      }
    >
      <div className="field">
        <label htmlFor="nd-label">New revision label</label>
        <input id="nd-label" type="text" value={label} onChange={(e) => setLabel(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="nd-summary">What changes and why</label>
        <textarea id="nd-summary" value={summary} onChange={(e) => setSummary(e.target.value)} />
      </div>
      {banner}
    </Dialog>
  );
}

interface RevisionData {
  revision: {
    id: string;
    formNumber: string;
    component: string;
    sequence: number;
    revisionLabel: string | null;
    status: string;
    definition: FormDefinition;
    provenance: string;
    changeSummary: string | null;
    releaseRationale: string | null;
    createdBy: string | null;
    createdAt: string;
    submittedBy: string | null;
    releasedBy: string | null;
    releasedAt: string | null;
    inspectionCount: number;
  };
  basedOn: { id: string; revisionLabel: string | null; status: string } | null;
  diff: Array<{ section: string; row: string | null; change: string; detail: string }>;
  siblings: Array<{ id: string; sequence: number; revisionLabel: string | null; status: string; releasedAt: string | null }>;
  history: HistoryRow[];
  permissions: { edit: boolean; release: boolean; releaseBlockedReason: string | null; newDraft: boolean };
}

const MEASURED: SectionPattern[] = ['dimensional', 'general_measurements'];
const slug = (name: string, taken: string[]) => {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'row';
  let key = base;
  for (let i = 2; taken.includes(key); i += 1) key = `${base}_${i}`;
  return key;
};

export function FormEditor() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data, error, loading, reload } = useLoad<RevisionData>(`/api/form-revisions/${id}`);
  const [def, setDef] = useState<FormDefinition | null>(null);
  const [dirty, setDirty] = useState(false);
  const { busy, run, banner } = useBusy();
  const [dialog, setDialog] = useState<'release' | 'return' | null>(null);
  const [text, setText] = useState('');
  useEffect(() => {
    if (data) {
      setDef(structuredClone(data.revision.definition));
      setDirty(false);
    }
  }, [data]);
  if (!data || !def) return <LoadState loading={loading} error={error} />;
  const r = data.revision;
  const edit = data.permissions.edit;
  const update = (fn: (d: FormDefinition) => void) => {
    const next = structuredClone(def);
    fn(next);
    setDef(next);
    setDirty(true);
  };
  return (
    <>
      <div className="page-head">
        <div>
          <h1>
            {r.formNumber} {r.revisionLabel ? `Rev ${r.revisionLabel}` : '(original)'} — {r.component}
          </h1>
          <div className="small muted">
            {r.provenance} · created {fmtDateTime(r.createdAt)}
            {r.createdBy ? ` by ${r.createdBy}` : ''}
            {r.releasedAt ? ` · released ${fmtDate(r.releasedAt)} by ${r.releasedBy}` : ''} · {r.inspectionCount} inspection(s)
          </div>
          <StateBadge state={r.status} />
        </div>
        <Link className="btn" to="/forms">
          All forms
        </Link>
      </div>
      {r.changeSummary && <div className="notice">Change summary: {r.changeSummary}</div>}
      <div className="card row-actions">
        {edit && (
          <>
            <button type="button" className="btn btn-primary" disabled={busy || !dirty} onClick={async () => (await run(() => api(`/api/form-revisions/${id}/definition`, { method: 'PUT', body: { definition: def } }), 'Draft saved.')) && reload()}>
              Save draft
            </button>
            <button type="button" className="btn" disabled={busy || dirty} onClick={async () => (await run(() => api(`/api/form-revisions/${id}/submit`, { method: 'POST' }), 'Submitted for release.')) && reload()}>
              Submit for release
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              onClick={async () => {
                if (window.confirm('Discard this draft? Nothing released is affected.') && (await run(() => api(`/api/form-revisions/${id}`, { method: 'DELETE' })))) navigate('/forms');
              }}
            >
              Discard draft
            </button>
            {dirty && <span className="small muted">Unsaved changes</span>}
          </>
        )}
        {r.status === 'IN_REVIEW' && data.permissions.release && (
          <>
            <button type="button" className="btn btn-primary" onClick={() => setDialog('release')}>
              Release…
            </button>
            <button type="button" className="btn" onClick={() => setDialog('return')}>
              Return to draft…
            </button>
          </>
        )}
        {data.permissions.releaseBlockedReason && <span className="small muted">{data.permissions.releaseBlockedReason}</span>}
        {!edit && r.status !== 'IN_REVIEW' && <span className="small muted">This revision is {r.status.toLowerCase().replaceAll('_', ' ')} and read-only.</span>}
      </div>
      {banner}

      {data.basedOn && (
        <section className="card">
          <h2>Changes from {data.basedOn.revisionLabel ? `Rev ${data.basedOn.revisionLabel}` : 'the original'}</h2>
          {data.diff.length === 0 ? (
            <p className="small muted">No changes yet.</p>
          ) : (
            <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
              {data.diff.map((d, i) => (
                <li key={i}>
                  <strong>{d.change.toLowerCase()}</strong> — {d.section}
                  {d.row ? ` → ${d.row}` : ''}
                  {d.detail ? `: ${d.detail}` : ''}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {def.sections.map((s, si) => (
        <SectionEditor
          key={s.key}
          section={s}
          edit={edit}
          onChange={(fn) => update((d) => fn(d.sections[si]!))}
          onRemove={() => update((d) => void d.sections.splice(si, 1))}
          removable={edit && s.scope !== 'inspection'}
        />
      ))}
      {edit && (
        <div className="card row-actions">
          <span className="small">Add section:</span>
          {(
            [
              ['pass_fail_checklist', 'Visual checklist'],
              ['dimensional', 'Dimensional (Actual 1–3)'],
              ['general_measurements', 'Single measurement'],
            ] as Array<[SectionPattern, string]>
          ).map(([pattern, label]) => (
            <button
              key={pattern}
              type="button"
              className="btn btn-small"
              onClick={() =>
                update((d) => {
                  const taken = d.sections.map((x) => x.key);
                  let n = d.sections.length;
                  let key = `S${n}`;
                  while (taken.includes(key)) key = `S${(n += 1)}`;
                  d.sections.push({ key, letter: String.fromCharCode(65 + d.sections.length), title: label.toUpperCase(), pattern, scope: 'unit', optional: pattern !== 'pass_fail_checklist', rows: [] });
                })
              }
            >
              + {label}
            </button>
          ))}
        </div>
      )}

      <section className="card">
        <h2>Revision history</h2>
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
          {data.siblings.map((s) => (
            <li key={s.id}>
              <Link to={`/forms/${s.id}`}>{s.revisionLabel ? `Rev ${s.revisionLabel}` : `Sequence ${s.sequence}`}</Link> <StateBadge state={s.status} /> {s.releasedAt ? fmtDate(s.releasedAt) : ''}
            </li>
          ))}
        </ul>
      </section>
      <HistoryCard history={data.history} />

      <Dialog
        open={dialog !== null}
        title={dialog === 'release' ? 'Release form revision' : 'Return to draft'}
        onClose={() => setDialog(null)}
        footer={
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || text.trim().length < 5}
            onClick={async () => {
              const ok = await run(() =>
                dialog === 'release' ? api(`/api/form-revisions/${id}/release`, { body: { rationale: text } }) : api(`/api/form-revisions/${id}/return`, { body: { reason: text } }),
              );
              if (ok) {
                setDialog(null);
                setText('');
                reload();
              }
            }}
          >
            {dialog === 'release' ? 'Release' : 'Return'}
          </button>
        }
      >
        {dialog === 'release' && <p className="small muted">New inspections will use this revision. Inspections already started keep the revision they were created with.</p>}
        <div className="field">
          <label htmlFor="rel-text">{dialog === 'release' ? 'Release rationale' : 'Reason'}</label>
          <textarea id="rel-text" value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        {banner}
      </Dialog>
    </>
  );
}

function SectionEditor({
  section,
  edit,
  onChange,
  onRemove,
  removable,
}: {
  section: FormSection;
  edit: boolean;
  onChange: (fn: (s: FormSection) => void) => void;
  onRemove: () => void;
  removable: boolean;
}) {
  const measured = MEASURED.includes(section.pattern);
  const rowsEditable = edit && section.pattern !== 'camshaft_bore' && section.pattern !== 'fire_ring_protrusion' && section.pattern !== 'valve_recession' && section.pattern !== 'vacuum_test';
  return (
    <section className="section">
      <div className="section-head">
        {edit ? (
          <input type="text" aria-label={`Section ${section.letter} title`} value={section.title} onChange={(e) => onChange((s) => void (s.title = e.target.value))} style={{ maxWidth: 420 }} />
        ) : (
          <h3>
            {section.letter}. {section.title}
          </h3>
        )}
        <span className="small muted">
          {section.pattern.replaceAll('_', ' ')} · {section.scope === 'inspection' ? 'once per inspection' : 'per item'}
          {section.optional ? ' · optional' : ''}
        </span>
        {removable && (
          <button type="button" className="btn btn-small btn-danger" onClick={onRemove}>
            Remove section
          </button>
        )}
      </div>
      <div style={{ padding: '6px 12px' }}>
        {!rowsEditable && section.rows.length === 0 && <p className="small muted">Readings are generated from the section layout (cylinders, bores, valves).</p>}
        {section.rows.map((row, ri) => (
          <div key={row.key} style={{ display: 'grid', gridTemplateColumns: rowsEditable ? 'minmax(160px,1fr) minmax(200px,2fr) 90px auto' : '1fr 2fr', gap: 8, padding: '6px 0', borderTop: ri ? '1px solid var(--border)' : undefined }}>
            {rowsEditable ? (
              <>
                <input type="text" aria-label={`Row ${ri + 1} name`} value={row.name} onChange={(e) => onChange((s) => void (s.rows[ri]!.name = e.target.value))} />
                <input
                  type="text"
                  aria-label={`Row ${ri + 1} ${measured ? 'reference spec text' : 'acceptance criterion'}`}
                  placeholder={measured ? 'Reference spec text (not a limit)' : 'Acceptance criterion'}
                  value={(measured ? row.specText : row.acceptance) ?? ''}
                  onChange={(e) => onChange((s) => void (measured ? (s.rows[ri]!.specText = e.target.value || undefined) : (s.rows[ri]!.acceptance = e.target.value || undefined)))}
                />
                <input
                  type="text"
                  aria-label={`Row ${ri + 1} unit`}
                  placeholder="Unit"
                  disabled={!measured}
                  value={row.unit ?? ''}
                  onChange={(e) => onChange((s) => void (s.rows[ri]!.unit = e.target.value || undefined))}
                />
                <button type="button" className="btn btn-small" aria-label={`Remove row ${row.name}`} onClick={() => onChange((s) => void s.rows.splice(ri, 1))}>
                  Remove
                </button>
              </>
            ) : (
              <>
                <div>
                  <strong>{row.name}</strong>
                  <div className="small muted">{row.key}</div>
                </div>
                <div className="small">{row.acceptance ?? row.specText ?? ''}</div>
              </>
            )}
          </div>
        ))}
        {rowsEditable && (
          <button
            type="button"
            className="btn btn-small"
            style={{ marginTop: 6 }}
            onClick={() =>
              onChange((s) => {
                const name = `New characteristic ${s.rows.length + 1}`;
                s.rows.push({ key: slug(name, s.rows.map((x) => x.key)), name });
              })
            }
          >
            + Add row
          </button>
        )}
        {rowsEditable && <p className="small muted">New rows get a stable key when added; renaming keeps the key so released limits and history stay linked.</p>}
      </div>
    </section>
  );
}
