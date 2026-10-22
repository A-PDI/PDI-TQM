import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { FormDefinition, ResponseStatus } from '../../shared/forms';
import { type Evaluation, type Issue, evaluateInspection, readingId, rowId } from '../../shared/inspection';
import type { GoverningLimit } from '../../shared/measurement';
import { ApiError, api, fmtDate, fmtDateTime } from '../api';
import { LoadState, OutcomeBadge, StatusBadge } from '../components/ui';
import { type Detail, type Photo, type RowCtx, SectionBlock } from './Workbench';

interface StageDetail {
  id: string;
  number: string;
  status: 'OPEN' | 'READY_FOR_REVIEW' | 'COMPLETED';
  outcome: 'PASS' | 'FAIL' | 'ACCEPTED' | null;
  version: number;
  inspectionId: string;
  stage1: { number: string; partNumber: string; dateReceived: string; completedAt: string | null; unitIndex: number };
  serialNumber: string;
  stagePart: { id: string; partNumber: string; description: string };
  performedOn: string;
  inspector: { id: string; name: string };
  completedAt: string | null;
  completedBy: string | null;
  baseline: { baselineTitle: string; revisionLabel: string; synthetic: boolean } | null;
  definition: FormDefinition;
  limits: Record<string, GoverningLimit>;
  responses: Record<string, { status: ResponseStatus | null; note: string | null; amendmentNo: number }>;
  readings: Record<string, { text: string; amendmentNo: number }>;
  photos: Photo[];
  evaluation: Evaluation;
  reviewReasons: Issue[] | null;
  reviews: Array<{ decision: string; reviewer: string; reviewedAt: string; comment: string | null }>;
  reports: Array<{ edition: number; fileId: string | null }>;
  permissions: { canEdit: boolean; canReview: boolean };
}

type Change = { rowKey: string; status?: ResponseStatus | null; note?: string | null; readings?: Record<string, string | null> };
const UNIT = 1;

/** Cylinder head Stage 2: fire ring readings for one head, with the same row controls as the inspection workbench. */
export function Stage2() {
  const { id } = useParams();
  const [data, setData] = useState<StageDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [responses, setResponses] = useState<StageDetail['responses']>({});
  const [readings, setReadings] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Record<string, Change>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [showIssues, setShowIssues] = useState(false);
  const [comment, setComment] = useState('');

  const load = useCallback(async () => {
    try {
      const d = await api<StageDetail>(`/api/inspection-stages/${id}`);
      setData(d);
      setResponses(d.responses);
      setReadings(Object.fromEntries(Object.entries(d.readings).map(([k, v]) => [k, v.text])));
      setPending({});
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [id]);
  useEffect(() => void load(), [load]);
  // The addendum PDF renders in the background once the record completes.
  const reportPending = data?.status === 'COMPLETED' && !data.reports.some((r) => r.fileId);
  useEffect(() => {
    if (!reportPending) return;
    const t = setInterval(() => void load(), 2500);
    return () => clearInterval(t);
  }, [reportPending, load]);

  const section = data?.definition.sections[0];
  const evaluation = useMemo(() => {
    if (!data) return null;
    const photoCounts: Record<string, number> = {};
    for (const p of data.photos) if (p.sectionKey && p.rowKey) photoCounts[rowId(UNIT, p.sectionKey, p.rowKey)] = (photoCounts[rowId(UNIT, p.sectionKey, p.rowKey)] ?? 0) + 1;
    return evaluateInspection(
      { definition: data.definition, unitCount: 1, limits: data.limits },
      { responses: Object.fromEntries(Object.entries(responses).map(([k, v]) => [k, { status: v.status, note: v.note }])), readings, photoCounts, activated: [] },
    );
  }, [data, responses, readings]);

  if (!data || !section || !evaluation) return <LoadState loading={!error} error={error} />;
  const editable = data.permissions.canEdit;
  const dirty = Object.keys(pending).length > 0;
  const queue = (rowKey: string, c: Omit<Change, 'rowKey'>) =>
    setPending((p) => ({ ...p, [rowKey]: { ...p[rowKey], rowKey, ...c, readings: { ...(p[rowKey]?.readings ?? {}), ...(c.readings ?? {}) } } }));

  const save = async () => {
    if (!dirty) return data.version;
    const r = await api<{ version: number }>(`/api/inspection-stages/${data.id}/entries`, { method: 'PATCH', body: { expectedVersion: data.version, changes: Object.values(pending) } });
    setPending({});
    return r.version;
  };
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      if (ok) setMessage({ ok: true, text: ok });
    } catch (err) {
      if (err instanceof ApiError && err.status === 422) setShowIssues(true);
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
      await load();
    }
  };

  const ctx: RowCtx = {
    // The shared row controls read only these fields of an inspection.
    detail: { status: data.status === 'OPEN' ? 'DRAFT' : 'COMPLETED', limits: data.limits, concerns: [], permissions: { canEdit: editable, canCaptureConcern: false, canAmend: false } } as unknown as Detail,
    responses,
    readings,
    photos: data.photos,
    evaluation,
    editable,
    showIssues,
    setStatus: (_u, _s, r, v) => {
      setResponses((x) => ({ ...x, [rowId(UNIT, section.key, r)]: { status: v, note: x[rowId(UNIT, section.key, r)]?.note ?? null, amendmentNo: 0 } }));
      queue(r, { status: v });
    },
    setNote: (_u, _s, r, v) => {
      setResponses((x) => ({ ...x, [rowId(UNIT, section.key, r)]: { status: x[rowId(UNIT, section.key, r)]?.status ?? null, note: v, amendmentNo: 0 } }));
      queue(r, { note: v });
    },
    setReading: (_u, _s, r, k, v) => {
      setReadings((x) => ({ ...x, [readingId(UNIT, section.key, r, k)]: v }));
      queue(r, { readings: { [k]: v } });
    },
    uploadPhoto: async (file, _u, _s, r) => {
      const form = new FormData();
      form.append('file', file, file.name);
      await api(`/api/inspection-stages/${data.id}/photos?rowKey=${encodeURIComponent(r ?? '')}`, { form });
      await load();
    },
    removePhoto: async (linkId) => {
      await api(`/api/inspection-stages/${data.id}/photos/${linkId}`, { method: 'DELETE' });
      await load();
    },
    onAmend: () => undefined,
    onConcern: async () => undefined,
  };

  return (
    <>
      <div className="page-head">
        <div>
          <div className="small">
            <Link to={`/inspections/${data.inspectionId}`}>Stage 1 inspection {data.stage1.number}</Link>
          </div>
          <h1>Stage 2 — {data.number}</h1>
          <div className="small muted">
            SN {data.serialNumber} · {data.stagePart.partNumber} — {data.stagePart.description}
          </div>
        </div>
        <div className="row-actions">
          {data.status === 'COMPLETED' ? <OutcomeBadge outcome={data.outcome} /> : <StatusBadge status={data.status === 'OPEN' ? 'DRAFT' : data.status} />}
          {data.reports
            .filter((r) => r.fileId)
            .map((r) => (
              <a key={r.edition} className="btn" href={`/api/files/${r.fileId}`} target="_blank" rel="noreferrer">
                Stage 2 addendum PDF{data.reports.length > 1 ? ` (edition ${r.edition})` : ''}
              </a>
            ))}
          {reportPending && <span className="small muted">Preparing addendum PDF…</span>}
        </div>
      </div>
      <div className="card">
        <dl className="kv">
          <dt>Stage 1</dt>
          <dd>
            {data.stage1.number}, item {data.stage1.unitIndex} · {data.stage1.partNumber} · received {fmtDate(data.stage1.dateReceived)}
            {data.stage1.completedAt ? ` · completed ${fmtDate(data.stage1.completedAt)}` : ''}
          </dd>
          <dt>Stage 2 date</dt>
          <dd>{fmtDate(data.performedOn)}</dd>
          <dt>Inspector</dt>
          <dd>{data.inspector.name}</dd>
          <dt>Specification</dt>
          <dd>{data.baseline ? `${data.baseline.baselineTitle} Rev ${data.baseline.revisionLabel}${data.baseline.synthetic ? ' (synthetic)' : ''}` : 'Not released for the Stage 2 part — readings are recorded as observations'}</dd>
          {data.completedAt && (
            <>
              <dt>Completed</dt>
              <dd>
                {fmtDateTime(data.completedAt)} by {data.completedBy}
              </dd>
            </>
          )}
        </dl>
      </div>
      {message && (
        <div className={`notice ${message.ok ? 'notice-ok' : 'notice-error'}`} role={message.ok ? 'status' : 'alert'}>
          {message.text}
        </div>
      )}
      <SectionBlock section={section} unitIndex={UNIT} onPassAll={() => undefined} {...ctx} />
      {editable && (
        <div className="row-actions" style={{ marginBottom: 14 }}>
          <button type="button" className="btn" disabled={busy || !dirty} onClick={() => void run(save, 'Saved')}>
            Save
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const v = await save();
                const r = await api<{ status: string }>(`/api/inspection-stages/${data.id}/complete`, { body: { expectedVersion: v } });
                setMessage({ ok: true, text: r.status === 'COMPLETED' ? 'Stage 2 completed' : 'Submitted for independent review' });
              })
            }
          >
            Complete Stage 2
          </button>
          {showIssues && evaluation.errors.length > 0 && <span className="small" style={{ color: 'var(--red)' }}>{evaluation.errors.length} item(s) still need an entry</span>}
        </div>
      )}
      {(data.status !== 'OPEN' || data.reviews.length > 0) && (
        <section className="card" aria-labelledby="stage-review-title">
          <h2 id="stage-review-title">Review</h2>
          {(data.reviewReasons ?? []).length > 0 && (
            <ul className="small">
              {(data.reviewReasons ?? []).map((r, i) => (
                <li key={i}>
                  {r.path}: {r.message}
                </li>
              ))}
            </ul>
          )}
          {data.reviews.map((r, i) => (
            <p key={i} className="small" style={{ margin: '4px 0' }}>
              {r.decision === 'CONFIRMED' ? 'Confirmed' : 'Returned'} by {r.reviewer}, {fmtDateTime(r.reviewedAt)}
              {r.comment ? ` — ${r.comment}` : ''}
            </p>
          ))}
          {data.permissions.canReview && (
            <>
              <div className="field">
                <label htmlFor="stage-review-comment">Review comment</label>
                <textarea id="stage-review-comment" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} />
              </div>
              <div className="row-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void run(() => api(`/api/inspection-stages/${data.id}/review`, { body: { decision: 'CONFIRM', comment: comment || null, expectedVersion: data.version } }), 'Review confirmed')}
                >
                  Confirm result
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={busy || !comment.trim()}
                  onClick={() => void run(() => api(`/api/inspection-stages/${data.id}/review`, { body: { decision: 'RETURN', comment, expectedVersion: data.version } }), 'Returned to the inspector')}
                >
                  Return for correction
                </button>
              </div>
            </>
          )}
        </section>
      )}
    </>
  );
}
