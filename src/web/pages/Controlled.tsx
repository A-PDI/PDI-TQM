import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  EVIDENCE_SCHEDULE,
  ROW_LABEL,
  type RecordData,
  type TemplateColumn,
  type TemplateField,
  type TemplateSchedule,
  type TemplateSchema,
} from '../../shared/controlled-forms';
import { api, fmtDate, fmtDateTime } from '../api';
import { ControlledFormsPanel, type ControlledRecordRow, type ControlledTypeRow, RecordStatus, categoryText } from '../components/controlled';
import { useBusy } from '../components/sourcing';
import { Dialog, LoadState, useLoad } from '../components/ui';

interface Binding {
  role: 'BASE' | 'CONTINUATION' | 'EVIDENCE' | 'NARRATIVE';
  scheduleKey: string | null;
  documentNumber: string;
  revisionId: string;
  revisionLabel: string;
  effectiveFrom: string;
  fileId: string;
}

interface Signature {
  id: string;
  cycle: number;
  role_key: string;
  role_label: string;
  mode: 'INTERNAL' | 'EXTERNAL' | 'NOT_REQUIRED';
  signer_name: string;
  signer_title: string | null;
  signed_on: string;
  decision: string | null;
  statement: string | null;
  reference: string | null;
  recorded_by: string;
}

interface Step {
  key: string;
  label: string;
  mode: 'INTERNAL' | 'EXTERNAL';
  decides: boolean;
  optional: boolean;
  signature: Signature | null;
}

interface Attachment {
  linkId: string;
  fileId: string;
  name: string;
  sha256: string;
  caption: string | null;
  linkedOn: string;
  linkedBy: string;
  conforms: boolean | null;
  conformanceDetail: string | null;
}

interface Output {
  id: string;
  edition: number;
  fileId: string;
  sha256: string;
  pageCount: number;
  renderedAt: string;
  validationOk: boolean;
  validation: { checks: Array<{ name: string; ok: boolean; detail: string }>; templates: Array<{ documentNumber: string; revisionLabel: string; pages: number }> };
}

interface Problem {
  path: string;
  message: string;
}

interface RecordView {
  id: string;
  number: string;
  typeCode: string;
  category: 'FORM' | 'ATTACHMENT';
  title: string;
  status: 'DRAFT' | 'SUBMITTED' | 'COMPLETED' | 'VOID';
  entity: { type: string; id: string | null; label: string; route: string | null };
  module: { name: string; route: string };
  rationale: string;
  recordRevision: number;
  cycle: number;
  version: number;
  preparedBy: string;
  createdAt: string;
  submittedBy: string | null;
  submittedAt: string | null;
  completedAt: string | null;
  voidReason: string | null;
  bindings: Binding[];
  schema: TemplateSchema;
  continuations: Record<string, { capacity: number; labelColumn: string | null; documentNumber: string; revisionLabel: string }>;
  narrative: boolean;
  data: RecordData;
  composed: RecordData | null;
  attachments: Attachment[];
  steps: Step[];
  history: Signature[];
  outputs: Output[];
  renderJob: { status: string; last_error: string | null } | null;
  problems: Problem[];
  can: { edit: boolean; submit: boolean; void: boolean; sign: string[]; attest: string[]; return: boolean };
}

const REQ_MARK: Record<string, string> = { REQUIRED: ' *', CONDITIONAL: ' [C]', OPTIONAL: ' [O]' };
const IDENTIFICATION = 'Record identification';

export function ControlledRecord() {
  const { id = '' } = useParams();
  const { data: rec, error, loading, reload } = useLoad<RecordView>(`/api/controlled/records/${id}`);
  const [draft, setDraft] = useState<RecordData | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [dirty, setDirty] = useState(false);
  const [version, setVersion] = useState(0);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const [dialog, setDialog] = useState<null | { kind: 'sign' | 'attest'; step: Step } | { kind: 'return' | 'void' }>(null);
  const { busy, run, banner, setMessage } = useBusy();

  useEffect(() => {
    if (!rec) return;
    setVersion(rec.version);
    // A reload (after an upload, a signature…) keeps edits that are not saved yet.
    if (!dirtyRef.current) {
      setDraft(structuredClone(rec.data));
      setProblems(rec.problems);
    }
  }, [rec]);

  // While the controlled PDF is being generated, check back every few seconds.
  const generating = rec?.status === 'COMPLETED' && rec.category === 'FORM' && rec.outputs.length === 0 && rec.renderJob?.status !== 'FAILED_PERMANENT';
  useEffect(() => {
    if (!generating) return;
    const t = setInterval(reload, 2500);
    return () => clearInterval(t);
  }, [generating, reload]);

  if (!rec || !draft) return <LoadState loading={loading} error={error} />;
  const editable = rec.can.edit && rec.category === 'FORM';
  const base = rec.bindings.find((b) => b.role === 'BASE')!;

  const update = (fn: (d: RecordData) => void) => {
    setDraft((prev) => {
      const next = structuredClone(prev!);
      fn(next);
      return next;
    });
    setDirty(true);
  };

  const saveDraft = async () => {
    const r = await api<{ version: number; problems: Problem[] }>(`/api/controlled/records/${rec.id}`, { method: 'PATCH', body: { expectedVersion: version, data: draft } });
    setProblems(r.problems);
    setVersion(r.version);
    setDirty(false);
    return r;
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="small">
            <Link to="/controlled">Controlled documents</Link>
            {rec.entity.route && (
              <>
                {' · '}
                <Link to={rec.entity.route}>{rec.entity.label}</Link>
              </>
            )}
          </div>
          <h1>
            {rec.number} — {rec.title}
          </h1>
          <div className="small muted">
            {rec.typeCode} · {categoryText(rec.category)} · {rec.module.name} · prepared by {rec.preparedBy} {fmtDate(rec.createdAt)}
            {rec.cycle > 1 ? ` · approval cycle ${rec.cycle}` : ''}
          </div>
          <RecordStatus status={rec.status} category={rec.category} />
        </div>
        <div className="row-actions">
          <a className="btn" href={`/api/files/${base.fileId}`} target="_blank" rel="noreferrer">
            Open approved revision
          </a>
          {editable && (
            <button type="button" className="btn" disabled={busy || !dirty} onClick={() => void run(saveDraft, 'Draft saved')}>
              Save draft
            </button>
          )}
          {rec.can.submit && (
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const v = dirty ? (await saveDraft()).version : version;
                  try {
                    await api(`/api/controlled/records/${rec.id}/submit`, { body: { expectedVersion: v } });
                  } catch (err) {
                    const details = (err as { details?: unknown }).details;
                    if (Array.isArray(details)) setProblems(details as Problem[]);
                    reload();
                    throw err;
                  }
                  reload();
                }, rec.category === 'FORM' ? 'Submitted for approval' : 'Submitted for signatures')
              }
            >
              {rec.category === 'FORM' ? 'Submit for approval' : 'Submit for signatures'}
            </button>
          )}
          {rec.can.return && (
            <button type="button" className="btn" onClick={() => setDialog({ kind: 'return' })}>
              Return for correction…
            </button>
          )}
          {rec.can.void && (
            <button type="button" className="btn btn-danger" onClick={() => setDialog({ kind: 'void' })}>
              Void…
            </button>
          )}
        </div>
      </div>
      {banner}
      {rec.status === 'VOID' && <div className="notice notice-warn">Void: {rec.voidReason}</div>}

      <div className="two-col">
        <section className="card" aria-labelledby="bound-revisions">
          <h2 id="bound-revisions">Controlled revision</h2>
          <p className="small" style={{ marginTop: 0 }}>
            Bound when the record was opened. Later revisions do not change this record or its output.
          </p>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {rec.bindings.map((b) => (
              <li key={b.revisionId}>
                <a href={`/api/files/${b.fileId}`} target="_blank" rel="noreferrer">
                  {b.documentNumber} Rev {b.revisionLabel}
                </a>{' '}
                <span className="muted">
                  {b.role === 'BASE' ? 'form' : b.role === 'CONTINUATION' ? 'continuation sheet' : b.role === 'EVIDENCE' ? 'evidence continuation' : 'narrative continuation'} · effective {fmtDate(b.effectiveFrom)}
                </span>
              </li>
            ))}
          </ul>
        </section>
        <ApprovalsCard rec={rec} onSign={(step) => setDialog({ kind: 'sign', step })} onAttest={(step) => setDialog({ kind: 'attest', step })} />
      </div>

      {rec.category === 'FORM' && rec.status === 'DRAFT' && problems.length > 0 && (
        <div className="notice notice-warn" role="status">
          <strong>{problems.length} item(s) to complete before submission</strong>
          <ul className="small" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {problems.slice(0, 12).map((p) => (
              <li key={p.path}>{p.message}</li>
            ))}
            {problems.length > 12 && <li>…and {problems.length - 12} more</li>}
          </ul>
        </div>
      )}

      {rec.category === 'FORM' ? (
        <FormBody rec={rec} draft={editable ? draft : (rec.composed ?? rec.data)} editable={editable} problems={problems} update={update} reload={reload} setMessage={setMessage} />
      ) : (
        <AttachmentBody rec={rec} reload={reload} />
      )}

      {rec.category === 'FORM' && (rec.status === 'COMPLETED' || rec.outputs.length > 0) && <OutputCard rec={rec} generating={generating} />}

      {rec.history.length > 0 && (
        <section className="card">
          <h2>Earlier approval cycles</h2>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
            {rec.history.map((s) => (
              <li key={s.id}>
                Cycle {s.cycle}: {s.role_label} — {s.signer_name} {fmtDate(s.signed_on)}
                {s.decision ? ` (${s.decision})` : ''}
              </li>
            ))}
          </ul>
        </section>
      )}

      {dialog?.kind === 'sign' && <SignDialog rec={rec} step={dialog.step} onClose={() => setDialog(null)} onDone={() => { setDialog(null); reload(); }} />}
      {dialog?.kind === 'attest' && <AttestDialog rec={rec} step={dialog.step} onClose={() => setDialog(null)} onDone={() => { setDialog(null); reload(); }} />}
      {(dialog?.kind === 'return' || dialog?.kind === 'void') && (
        <ReasonDialog
          title={dialog.kind === 'return' ? 'Return for correction' : 'Void draft'}
          action={dialog.kind === 'return' ? 'Return to draft' : 'Void'}
          url={`/api/controlled/records/${rec.id}/${dialog.kind}`}
          version={rec.version}
          onClose={() => setDialog(null)}
          onDone={() => {
            setDialog(null);
            reload();
          }}
        />
      )}
    </>
  );
}

function ApprovalsCard({ rec, onSign, onAttest }: { rec: RecordView; onSign: (s: Step) => void; onAttest: (s: Step) => void }) {
  return (
    <section className="card" aria-labelledby="approvals">
      <h2 id="approvals">{rec.category === 'FORM' ? 'Approvals' : 'Required signatures'}</h2>
      <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
        {rec.steps.map((s) => (
          <li key={s.key} style={{ marginBottom: 8 }}>
            <div>
              <strong>{s.label}</strong>
              {s.optional && <span className="small muted"> (when required)</span>}
              {s.mode === 'EXTERNAL' && <span className="small muted"> (from the executed document)</span>}
            </div>
            {s.signature ? (
              <div className="small">
                {s.signature.mode === 'NOT_REQUIRED' ? (
                  <>Not required — decided by {s.signature.recorded_by}</>
                ) : (
                  <>
                    {s.signature.signer_name}
                    {s.signature.signer_title ? `, ${s.signature.signer_title}` : ''} · {fmtDate(s.signature.signed_on)}
                    {s.signature.decision && <> · decision <strong>{s.signature.decision}</strong></>}
                    {s.signature.mode === 'EXTERNAL' && <> · recorded by {s.signature.recorded_by}</>}
                  </>
                )}
                {s.signature.statement && s.signature.mode !== 'NOT_REQUIRED' && <div className="muted">{s.signature.statement}</div>}
                {s.signature.reference && <div className="muted">Ref: {s.signature.reference}</div>}
              </div>
            ) : (
              <div className="small muted">
                Pending
                {rec.can.sign.includes(s.key) && (
                  <button type="button" className="btn btn-small btn-primary" style={{ marginLeft: 8 }} onClick={() => onSign(s)}>
                    Sign…
                  </button>
                )}
                {rec.can.attest.includes(s.key) && (
                  <button type="button" className="btn btn-small" style={{ marginLeft: 8 }} onClick={() => onAttest(s)}>
                    Record signature…
                  </button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
      {rec.status === 'DRAFT' && <p className="small muted" style={{ marginBottom: 0 }}>Signatures are collected after submission. The preparer and submitter cannot approve (POL-01).</p>}
    </section>
  );
}

function sectionsOf(schema: TemplateSchema) {
  const order = [IDENTIFICATION, ...schema.sections.map((s) => s.title)].filter((t, i, a) => a.indexOf(t) === i);
  return order
    .map((title) => ({
      title,
      fields: schema.fields.filter((f) => f.role === 'ENTRY' && (f.section ?? IDENTIFICATION) === title),
      schedules: schema.schedules.filter((s) => s.key !== EVIDENCE_SCHEDULE && (s.title ?? IDENTIFICATION) === title),
    }))
    .filter((s) => s.fields.length || s.schedules.length);
}

function FormBody({
  rec,
  draft,
  editable,
  problems,
  update,
  reload,
  setMessage,
}: {
  rec: RecordView;
  draft: RecordData;
  editable: boolean;
  problems: Problem[];
  update: (fn: (d: RecordData) => void) => void;
  reload: () => void;
  setMessage: (m: { ok: boolean; text: string } | null) => void;
}) {
  const sections = useMemo(() => sectionsOf(rec.schema), [rec.schema]);
  const problemPaths = new Set(problems.map((p) => p.path));
  return (
    <>
      {sections.map((sec, i) => {
        const missing = problems.filter((p) => sec.fields.some((f) => p.path === `fields.${f.key}`) || sec.schedules.some((s) => p.path.startsWith(`schedules.${s.key}.`))).length;
        return (
          <FormSection key={sec.title} title={sec.title} initiallyOpen={i === 0 || missing > 0 || !editable} missing={editable ? missing : 0}>
            {sec.fields.length > 0 && (
              <div className="cf-grid">
                {sec.fields.map((f) => (
                  <FieldInput key={f.key} field={f} value={draft.fields[f.key] ?? ''} editable={editable} narrative={rec.narrative} invalid={problemPaths.has(`fields.${f.key}`)} onChange={(v) => update((d) => { d.fields[f.key] = v; })} />
                ))}
              </div>
            )}
            {sec.schedules.map((s) => (
              <ScheduleTable key={s.key} sched={s} rows={draft.schedules[s.key] ?? []} cont={rec.continuations[s.key]} editable={editable} problems={problemPaths} update={update} />
            ))}
          </FormSection>
        );
      })}
      <EvidenceSection rec={rec} draft={draft} editable={editable} update={update} reload={reload} setMessage={setMessage} />
    </>
  );
}

/** A template section that expands and collapses; it opens by itself when it gains items to complete. */
function FormSection({ title, initiallyOpen, missing, children }: { title: string; initiallyOpen: boolean; missing: number; children: ReactNode }) {
  const [open, setOpen] = useState(initiallyOpen);
  const previous = useRef(missing);
  useEffect(() => {
    if (missing > previous.current) setOpen(true);
    previous.current = missing;
  }, [missing]);
  return (
    <details className="section" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="section-head" style={{ cursor: 'pointer' }}>
        <h3>{title}</h3>
        {missing > 0 && <span className="badge badge-review">{missing} to complete</span>}
      </summary>
      <div style={{ padding: '10px 12px' }}>{children}</div>
    </details>
  );
}

function FieldInput({ field, value, editable, narrative, invalid, onChange }: { field: TemplateField; value: string; editable: boolean; narrative: boolean; invalid: boolean; onChange: (v: string) => void }) {
  const id = `cf-${field.key}`;
  const over = field.maxLength && value.length > field.maxLength;
  const wide = field.input === 'multiline' || (field.maxLength ?? 0) > 80;
  return (
    <div className={`field${wide ? ' cf-wide' : ''}`}>
      <label htmlFor={id}>
        {field.label}
        <span className="muted">{REQ_MARK[field.requirement]}</span>
      </label>
      {!editable ? (
        <div id={id} className="cf-value">{value || <span className="muted">—</span>}</div>
      ) : field.input === 'choice' ? (
        <select id={id} value={value} aria-invalid={invalid || undefined} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {field.options!.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : field.input === 'multiline' ? (
        <textarea id={id} value={value} aria-invalid={invalid || undefined} maxLength={narrative ? undefined : (field.maxLength ?? undefined)} rows={Math.min(8, Math.max(3, Math.ceil((field.maxLength ?? 200) / 160)))} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input
          id={id}
          type={field.input === 'date' ? 'date' : 'text'}
          value={value}
          aria-invalid={invalid || undefined}
          maxLength={field.input === 'date' ? undefined : (field.maxLength ?? undefined)}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {editable && over && narrative && <div className="field-hint">Longer than the form’s {field.maxLength} characters; the rest continues on a narrative continuation sheet.</div>}
    </div>
  );
}

function CellInput({ col, value, label, onChange, invalid }: { col: TemplateColumn; value: string; label: string; onChange: (v: string) => void; invalid: boolean }) {
  if (col.input === 'choice') {
    return (
      <select aria-label={label} value={value} aria-invalid={invalid || undefined} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {col.options!.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      aria-label={label}
      type={col.input === 'date' ? 'date' : 'text'}
      value={value}
      maxLength={col.input === 'date' ? undefined : (col.maxLength ?? undefined)}
      aria-invalid={invalid || undefined}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function ScheduleTable({
  sched,
  rows,
  cont,
  editable,
  problems,
  update,
}: {
  sched: TemplateSchedule;
  rows: Array<Record<string, string>>;
  cont: RecordView['continuations'][string] | undefined;
  editable: boolean;
  problems: Set<string>;
  update: (fn: (d: RecordData) => void) => void;
}) {
  const printed = sched.rowLabels?.length ?? 0;
  const shown = Math.max(rows.length, printed);
  const all = Array.from({ length: shown }, (_, i) => rows[i] ?? {});
  const setCell = (i: number, key: string, v: string) =>
    update((d) => {
      const list = d.schedules[sched.key] ?? [];
      while (list.length <= i) list.push({});
      list[i] = { ...list[i], [key]: v };
      d.schedules[sched.key] = list;
    });
  const sheetOf = (i: number) => (i < sched.capacity ? 0 : cont ? Math.floor((i - sched.capacity) / cont.capacity) + 1 : -1);
  const title = sched.title ?? sched.key;
  return (
    <div style={{ marginTop: 6 }}>
      <div className="small muted" style={{ marginBottom: 4 }}>
        The form holds {sched.capacity} row{sched.capacity === 1 ? '' : 's'}
        {printed ? ` (${printed} printed checklist items)` : ''}.{' '}
        {cont ? `More rows continue on ${cont.documentNumber} Rev ${cont.revisionLabel}, ${cont.capacity} per sheet.` : 'No continuation sheet is released for more rows.'}
      </div>
      <div className="table-wrap">
        <table className="data cf-table">
          <thead>
            <tr>
              {sched.rowLabels && <th scope="col">Item</th>}
              {sched.columns.map((c) => (
                <th key={c.key} scope="col">
                  {c.label}
                  <span className="muted">{REQ_MARK[c.requirement]}</span>
                </th>
              ))}
              {editable && <th scope="col"><span className="sr-only">Row actions</span></th>}
            </tr>
          </thead>
          <tbody>
            {all.map((row, i) => {
              const sheet = sheetOf(i);
              const breakRow = i > 0 && sheet !== sheetOf(i - 1);
              const label = i < printed ? sched.rowLabels![i]! : row[ROW_LABEL] ?? '';
              return [
                breakRow ? (
                  <tr key={`b${i}`} className="cf-sheet">
                    <td colSpan={sched.columns.length + (sched.rowLabels ? 1 : 0) + (editable ? 1 : 0)}>
                      {sheet > 0 ? `Continuation sheet ${sheet} — ${cont!.documentNumber} Rev ${cont!.revisionLabel}` : 'Beyond the form: no continuation sheet released'}
                    </td>
                  </tr>
                ) : null,
                <tr key={i}>
                  {sched.rowLabels && (
                    <th scope="row" className="small">
                      {i < printed || !editable ? (
                        label || <span className="muted">Row {i + 1}</span>
                      ) : (
                        <input aria-label={`${title} added row ${i + 1} item`} type="text" value={label} aria-invalid={problems.has(`schedules.${sched.key}.${i}._label`) || undefined} onChange={(e) => setCell(i, ROW_LABEL, e.target.value)} />
                      )}
                    </th>
                  )}
                  {sched.columns.map((c) => (
                    <td key={c.key} data-label={c.label}>
                      {editable ? (
                        <CellInput col={c} value={row[c.key] ?? ''} label={`${title} row ${i + 1} ${c.label}`} invalid={problems.has(`schedules.${sched.key}.${i}.${c.key}`)} onChange={(v) => setCell(i, c.key, v)} />
                      ) : (
                        <span className="small">{row[c.key] ?? ''}</span>
                      )}
                    </td>
                  ))}
                  {editable && (
                    <td>
                      {i >= printed && (
                        <button
                          type="button"
                          className="btn btn-small"
                          aria-label={`Remove ${title} row ${i + 1}`}
                          onClick={() =>
                            update((d) => {
                              const list = d.schedules[sched.key] ?? [];
                              list.splice(i, 1);
                              d.schedules[sched.key] = list;
                            })
                          }
                        >
                          ×
                        </button>
                      )}
                    </td>
                  )}
                </tr>,
              ];
            })}
            {all.length === 0 && (
              <tr>
                <td colSpan={sched.columns.length + (editable ? 1 : 0)} className="muted small">
                  No rows yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {editable && (
        <button
          type="button"
          className="btn btn-small"
          style={{ marginTop: 6 }}
          onClick={() =>
            update((d) => {
              const list = d.schedules[sched.key] ?? [];
              while (list.length < printed) list.push({});
              list.push({});
              d.schedules[sched.key] = list;
            })
          }
        >
          + Add {printed ? 'item' : 'row'} to {title.replace(/^\d+\s+/, '')}
        </button>
      )}
    </div>
  );
}

function EvidenceSection({
  rec,
  draft,
  editable,
  update,
  reload,
  setMessage,
}: {
  rec: RecordView;
  draft: RecordData;
  editable: boolean;
  update: (fn: (d: RecordData) => void) => void;
  reload: () => void;
  setMessage: (m: { ok: boolean; text: string } | null) => void;
}) {
  const sched = rec.schema.schedules.find((s) => s.key === EVIDENCE_SCHEDULE);
  const manual = (editable ? draft.schedules[EVIDENCE_SCHEDULE] : rec.data.schedules[EVIDENCE_SCHEDULE]) ?? [];
  return (
    <details className="section" open>
      <summary className="section-head" style={{ cursor: 'pointer' }}>
        <h3>{sched?.title ?? 'Supporting evidence'}</h3>
      </summary>
      <div style={{ padding: '10px 12px' }}>
        <p className="small muted" style={{ marginTop: 0 }}>
          Attached files are listed as E01, E02… with their SHA-256. Every continuation sheet of the record set is added to this index when the PDF is generated.
        </p>
        <AttachmentList rec={rec} editable={editable} reload={reload} setMessage={setMessage} />
        {sched && (editable || manual.length > 0) && (
          <>
            <h3 style={{ marginTop: 12 }}>Other controlled references</h3>
            <ScheduleTable sched={{ ...sched, title: 'Evidence references', rowLabels: null }} rows={manual} cont={rec.continuations[EVIDENCE_SCHEDULE]} editable={editable} problems={new Set()} update={update} />
          </>
        )}
      </div>
    </details>
  );
}

function AttachmentList({ rec, editable, reload, setMessage }: { rec: RecordView; editable: boolean; reload: () => void; setMessage: (m: { ok: boolean; text: string } | null) => void }) {
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <>
      {rec.attachments.length ? (
        <ul className="small" style={{ margin: '0 0 8px', paddingLeft: 18 }}>
          {rec.attachments.map((a, i) => (
            <li key={a.linkId}>
              {rec.category === 'FORM' && <strong>E{String(i + 1).padStart(2, '0')} </strong>}
              <a href={`/api/files/${a.fileId}`} target="_blank" rel="noreferrer">
                {a.name}
              </a>{' '}
              <span className="muted">
                {a.caption ? `— ${a.caption} ` : ''}· {a.linkedBy} {fmtDate(a.linkedOn)} · SHA-256 {a.sha256.slice(0, 12)}
              </span>
              {a.conforms !== null && <span className={`badge ${a.conforms ? 'badge-pass' : 'badge-accepted'}`} style={{ marginLeft: 6 }}>{a.conforms ? 'On the bound template' : 'Other format'}</span>}
              {a.conformanceDetail && <div className="muted">{a.conformanceDetail}</div>}
              {editable && (
                <button
                  type="button"
                  className="btn-link"
                  style={{ marginLeft: 6 }}
                  aria-label={`Remove ${a.name}`}
                  onClick={async () => {
                    try {
                      await api(`/api/controlled/records/${rec.id}/attachments/${a.linkId}`, { method: 'DELETE' });
                      reload();
                    } catch (err) {
                      setMessage({ ok: false, text: (err as Error).message });
                    }
                  }}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted" style={{ marginTop: 0 }}>No files attached.</p>
      )}
      {editable && (
        <div className="row-actions">
          <label htmlFor="attach-caption" className="sr-only">
            Caption for the file
          </label>
          <input id="attach-caption" type="text" placeholder="Caption / feature / sample / defect" value={caption} onChange={(e) => setCaption(e.target.value)} style={{ maxWidth: 320 }} />
          <label className="btn btn-small photo-btn" style={{ margin: 0 }}>
            {busy ? 'Uploading…' : '+ Attach file'}
            <input
              type="file"
              accept="application/pdf,image/jpeg,image/png,image/webp"
              aria-label="Attach file"
              disabled={busy}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                setBusy(true);
                try {
                  const form = new FormData();
                  form.append('file', file, file.name);
                  await api(`/api/controlled/records/${rec.id}/attachments${caption ? `?caption=${encodeURIComponent(caption)}` : ''}`, { form });
                  setCaption('');
                  reload();
                } catch (err) {
                  setMessage({ ok: false, text: (err as Error).message });
                } finally {
                  setBusy(false);
                }
              }}
            />
          </label>
        </div>
      )}
    </>
  );
}

function AttachmentBody({ rec, reload }: { rec: RecordView; reload: () => void }) {
  const { setMessage, banner } = useBusy();
  return (
    <section className="card" aria-labelledby="attached-docs">
      <h2 id="attached-docs">Controlled document</h2>
      <p className="small" style={{ marginTop: 0 }}>
        {rec.rationale} Use the approved revision ({rec.bindings[0]!.documentNumber} Rev {rec.bindings[0]!.revisionLabel}) for the document, attach the completed or executed copy, then record each required signature.
      </p>
      {banner}
      <AttachmentList rec={rec} editable={rec.can.edit} reload={reload} setMessage={setMessage} />
    </section>
  );
}

function OutputCard({ rec, generating }: { rec: RecordView; generating: boolean }) {
  return (
    <section className="card" aria-labelledby="controlled-output">
      <h2 id="controlled-output">Controlled output</h2>
      {rec.outputs.map((o) => (
        <div key={o.id}>
          <div className="row-actions">
            <a className="btn btn-primary" href={`/api/files/${o.fileId}`} target="_blank" rel="noreferrer">
              Open controlled PDF
            </a>
            <span className="small muted">
              Edition {o.edition} · {o.pageCount} pages · {fmtDateTime(o.renderedAt)} · SHA-256 {o.sha256.slice(0, 12)}
            </span>
          </div>
          <p className="small" style={{ marginBottom: 4 }}>
            Built on {o.validation.templates.map((t) => `${t.documentNumber} Rev ${t.revisionLabel} (${t.pages} p.)`).join(', ')}.
          </p>
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }} aria-label="Validation against the approved template">
            {o.validation.checks.map((c) => (
              <li key={c.name}>
                <span className={`badge ${c.ok ? 'badge-pass' : 'badge-fail'}`}>{c.ok ? 'Pass' : 'Fail'}</span> {c.name}: {c.detail}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {generating && <p className="small muted" aria-live="polite">Generating the controlled PDF from the bound revisions…</p>}
      {rec.renderJob?.status === 'FAILED_PERMANENT' && <div className="notice notice-error">The controlled PDF could not be generated: {rec.renderJob.last_error}</div>}
    </section>
  );
}

function SignDialog({ rec, step, onClose, onDone }: { rec: RecordView; step: Step; onClose: () => void; onDone: () => void }) {
  const decisionField = rec.schema.fields.find((f) => f.key === 'pdi_decision');
  const conditionsField = rec.schema.fields.find((f) => f.key === 'decision_conditions');
  const extra = rec.schema.fields.filter((f) => f.role === 'DECISION' && f.key !== 'pdi_decision' && f.key !== 'decision_conditions');
  const optional = rec.steps.find((s) => s.optional && s.key !== step.key && !s.signature);
  const [decision, setDecision] = useState('');
  const [conditions, setConditions] = useState('');
  const [details, setDetails] = useState<Record<string, string>>({});
  const [second, setSecond] = useState<'REQUIRED' | 'NOT_REQUIRED'>('REQUIRED');
  const [statement, setStatement] = useState('');
  const { busy, run, banner } = useBusy();
  const ready = !step.decides || (decision && (!conditionsField || conditions.trim()));
  return (
    <Dialog
      open
      title={`Sign: ${step.label}`}
      onClose={onClose}
      footer={
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !ready}
          onClick={() =>
            void run(async () => {
              await api(`/api/controlled/records/${rec.id}/sign`, {
                body: { expectedVersion: rec.version, step: step.key, ...(step.decides ? { decision, conditions, details, ...(optional ? { secondApproval: second } : {}) } : { statement: statement || undefined }) },
              });
              onDone();
            })
          }
        >
          Sign
        </button>
      }
    >
      {banner}
      <p className="small muted" style={{ marginTop: 0 }}>
        Your name and today’s date are entered in the form’s approval block. The signature is bound to the submitted content.
      </p>
      {step.decides && decisionField && (
        <div className="field">
          <label htmlFor="sign-decision">{decisionField.label}</label>
          <select id="sign-decision" value={decision} onChange={(e) => setDecision(e.target.value)}>
            <option value="">Choose…</option>
            {(decisionField.options ?? [])
              .filter((o) => !/^return$/i.test(o))
              .map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
          </select>
          <div className="field-hint">To send the record back, close this and use Return for correction.</div>
        </div>
      )}
      {step.decides && conditionsField && (
        <div className="field">
          <label htmlFor="sign-conditions">{conditionsField.label}</label>
          <textarea id="sign-conditions" value={conditions} onChange={(e) => setConditions(e.target.value)} />
        </div>
      )}
      {step.decides &&
        extra.map((f) => (
          <div className="field" key={f.key}>
            <label htmlFor={`sign-${f.key}`}>
              {f.label}
              <span className="muted">{REQ_MARK[f.requirement]}</span>
            </label>
            <input id={`sign-${f.key}`} type={f.input === 'date' ? 'date' : 'text'} maxLength={f.maxLength ?? undefined} value={details[f.key] ?? ''} onChange={(e) => setDetails({ ...details, [f.key]: e.target.value })} />
          </div>
        ))}
      {step.decides && optional && (
        <fieldset className="field">
          <legend>{optional.label}</legend>
          <label>
            <input type="radio" name="second" checked={second === 'REQUIRED'} onChange={() => setSecond('REQUIRED')} /> Required — wait for this approval
          </label>
          <br />
          <label>
            <input type="radio" name="second" checked={second === 'NOT_REQUIRED'} onChange={() => setSecond('NOT_REQUIRED')} /> Not required for this record
          </label>
        </fieldset>
      )}
      {!step.decides && (
        <div className="field">
          <label htmlFor="sign-statement">Comment (optional)</label>
          <textarea id="sign-statement" value={statement} onChange={(e) => setStatement(e.target.value)} />
        </div>
      )}
    </Dialog>
  );
}

function AttestDialog({ rec, step, onClose, onDone }: { rec: RecordView; step: Step; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState('');
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [reference, setReference] = useState('');
  const { busy, run, banner } = useBusy();
  return (
    <Dialog
      open
      title={`Record: ${step.label}`}
      onClose={onClose}
      footer={
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || name.trim().length < 2 || !date}
          onClick={() =>
            void run(async () => {
              await api(`/api/controlled/records/${rec.id}/attest`, { body: { expectedVersion: rec.version, role: step.key, signerName: name, signerTitle: title || undefined, signedOn: date, reference: reference || undefined } });
              onDone();
            })
          }
        >
          Record signature
        </button>
      }
    >
      {banner}
      <p className="small muted" style={{ marginTop: 0 }}>
        Enter the signatory exactly as shown on the attached executed document. You are recorded as the person who checked it.
      </p>
      <div className="field">
        <label htmlFor="attest-name">Signatory name</label>
        <input id="attest-name" type="text" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="attest-title">Title / organization</label>
        <input id="attest-title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="attest-date">Date signed</label>
        <input id="attest-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="attest-ref">Reference (optional)</label>
        <input id="attest-ref" type="text" value={reference} onChange={(e) => setReference(e.target.value)} />
      </div>
    </Dialog>
  );
}

function ReasonDialog({ title, action, url, version, onClose, onDone }: { title: string; action: string; url: string; version: number; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const { busy, run, banner } = useBusy();
  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      footer={
        <button type="button" className="btn btn-primary" disabled={busy || reason.trim().length < 5} onClick={() => void run(async () => { await api(url, { body: { expectedVersion: version, reason } }); onDone(); })}>
          {action}
        </button>
      }
    >
      {banner}
      <div className="field">
        <label htmlFor="reason-text">Reason</label>
        <textarea id="reason-text" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
    </Dialog>
  );
}

/** All controlled document types with their module, A/B handling and revision in force, plus recent records. */
export function ControlledIndex() {
  const types = useLoad<{ asOf: string; types: ControlledTypeRow[] }>('/api/controlled/types');
  const [status, setStatus] = useState('');
  const records = useLoad<ControlledRecordRow[]>(`/api/controlled/records${status ? `?status=${status}` : ''}`);
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Controlled documents</h1>
          <div className="small muted">Each registered document type, where its work happens in TQM, and how its controlled record is produced.</div>
        </div>
      </div>
      <h2>Records</h2>
      <div className="card row-actions">
        <label htmlFor="cr-status">Status</label>
        <select id="cr-status" style={{ maxWidth: 220 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All</option>
          <option value="DRAFT">Draft</option>
          <option value="SUBMITTED">Awaiting approval</option>
          <option value="COMPLETED">Completed</option>
          <option value="VOID">Void</option>
        </select>
      </div>
      <LoadState loading={records.loading && !records.data} error={records.error} />
      {records.data && (
        <div className="table-wrap" style={{ marginBottom: 16 }}>
          <table className="data stack">
            <thead>
              <tr>
                <th>Record</th>
                <th>Document</th>
                <th>Opened from</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {records.data.length === 0 && (
                <tr>
                  <td colSpan={4}>
                    <div className="empty">No controlled records yet. Start one from the module record it belongs to.</div>
                  </td>
                </tr>
              )}
              {records.data.map((r) => (
                <tr key={r.id}>
                  <td data-label="Record">
                    <Link to={`/controlled/${r.id}`}>{r.number}</Link>
                  </td>
                  <td data-label="Document">
                    {r.typeCode} {r.title} <span className="small muted">Rev {r.revisionLabel}</span>
                  </td>
                  <td data-label="Opened from">{r.entityLabel}</td>
                  <td data-label="Status">
                    <RecordStatus status={r.status} category={r.category} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h2>Document types</h2>
      <LoadState loading={types.loading && !types.data} error={types.error} />
      {types.data && (
        <div className="table-wrap" style={{ marginBottom: 16 }}>
          <table className="data stack">
            <thead>
              <tr>
                <th>Type</th>
                <th>Handled as</th>
                <th>Module</th>
                <th>Revision in force</th>
              </tr>
            </thead>
            <tbody>
              {types.data.types.map((t) => (
                <tr key={t.code}>
                  <td data-label="Type">
                    <strong>{t.code}</strong> {t.title ?? ''}
                    <div className="small muted">{t.rationale}</div>
                  </td>
                  <td data-label="Handled as">
                    {t.category === 'FORM' ? 'A — completed in TQM, controlled PDF generated' : 'B — attached document with required signatures'}
                  </td>
                  <td data-label="Module">
                    <Link to={t.moduleRoute}>{t.module}</Link>
                  </td>
                  <td data-label="Revision in force">
                    {t.revision ? (
                      <>
                        <a href={`/api/files/${t.revision.fileId}`} target="_blank" rel="noreferrer">
                          Rev {t.revision.revisionLabel}
                        </a>
                        <div className="small muted">
                          since {fmtDate(t.revision.effectiveFrom)}
                          {t.category === 'FORM' && t.interactive === false ? ' · no fillable fields' : ''}
                        </div>
                      </>
                    ) : (
                      <span className="muted">Not released</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ControlledFormsPanel entity="SYSTEM" entityId={null} title="Quality-system documents (SYS-01)" />
    </>
  );
}
