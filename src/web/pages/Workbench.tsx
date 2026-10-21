import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useBlocker, useNavigate, useParams } from 'react-router-dom';
import {
  type AnswerRow,
  type FormDefinition,
  type FormSection,
  type ResponseStatus,
  STATUS_LABEL,
  formLabel,
  isPassAllEligible,
  noteRequired,
  photoRequired,
  readingLimitRef,
  sectionRows,
  sectionTitle,
} from '../../shared/forms';
import { type EntryState, type Evaluation, type Issue, type Outcome, activationId, evaluateInspection, passAllTargets, readingId, rowId } from '../../shared/inspection';
import { type GoverningLimit, formatLimit } from '../../shared/measurement';
import { ApiError, api, fmtDate, fmtDateTime } from '../api';
import { Dialog, LoadState, OutcomeBadge, StatusBadge, useLoad } from '../components/ui';
import { RequestConcessionDialog } from './Concessions';

interface Detail {
  id: string;
  number: string;
  status: 'DRAFT' | 'PARTIAL' | 'READY_FOR_REVIEW' | 'COMPLETED' | 'VOID';
  outcome: Outcome | null;
  version: number;
  partId: string | null;
  partNumber: string;
  partDescription: string;
  poNumber: string | null;
  dateReceived: string;
  lotNumber: string | null;
  lotSize: number | null;
  unitCount: number;
  inspector: { id: string; name: string };
  supplier: { id: string; name: string } | null;
  site: { id: string; name: string } | null;
  sourceState: string;
  completedAt: string | null;
  completedBy: string | null;
  form: { revisionId: string; definition: FormDefinition };
  baseline: { baselineTitle: string; revisionLabel: string; synthetic: boolean } | null;
  limits: Record<string, GoverningLimit>;
  units: Array<{ unitIndex: number; serialNumber: string | null; dispositionNote: string | null }>;
  activated: string[];
  responses: Record<string, { status: ResponseStatus | null; note: string | null; amendmentNo: number }>;
  readings: Record<string, { text: string; amendmentNo: number }>;
  photos: Photo[];
  reviewReasons: Issue[] | null;
  reviews: Array<{ decision: string; reviewer: string; reviewedAt: string; comment: string | null }>;
  amendments: Array<{ amendmentNo: number; reason: string; resultingOutcome: string; amendedBy: string; amendedAt: string }>;
  reports: Array<{ renditionId: string; edition: number; fileId: string; sha256: string; pageCount: number; renderedAt: string }>;
  reportPending: boolean;
  reportError: string | null;
  concerns: Array<{ id: string; number: string; title: string; status: string; unitIndex: number; sectionKey: string; rowKey: string }>;
  concession: { id: string; number: string; quantity: number; validUntil: string } | null;
  permissions: { canEdit: boolean; canReview: boolean; canReviewAccepted: boolean; canAmend: boolean; canCaptureConcern: boolean; canRequestConcession: boolean };
}

interface Photo {
  linkId: string;
  fileId: string;
  unitIndex: number | null;
  sectionKey: string | null;
  rowKey: string | null;
  caption: string | null;
}

interface EntryChange {
  unitIndex: number;
  sectionKey: string;
  rowKey: string;
  status?: ResponseStatus | null;
  note?: string | null;
  readings?: Record<string, string | null>;
}
interface UnitChange {
  unitIndex: number;
  serialNumber?: string | null;
  dispositionNote?: string | null;
}

type SaveState = 'saved' | 'pending' | 'saving' | 'error' | 'conflict';

const draftKey = (id: string) => `tqms-unsaved-${id}`;

export function Workbench() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [responses, setResponses] = useState<Detail['responses']>({});
  const [readings, setReadings] = useState<Record<string, string>>({});
  const [units, setUnits] = useState<Detail['units']>([]);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [unit, setUnit] = useState(1);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showIssues, setShowIssues] = useState(false);
  const [banner, setBanner] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string } | null>(null);
  const [restoreOffer, setRestoreOffer] = useState<{ changes: EntryChange[]; units: UnitChange[] } | null>(null);
  const [passAllDialog, setPassAllDialog] = useState<{ section: FormSection; unitIndex: number; overwrite: Array<{ rowKey: string; status: ResponseStatus }>; fill: number } | null>(null);
  const [amendRow, setAmendRow] = useState<{ section: FormSection; row: AnswerRow; unitIndex: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const versionRef = useRef(0);
  const pending = useRef<{ changes: Map<string, EntryChange>; units: Map<number, UnitChange> }>({ changes: new Map(), units: new Map() });
  const saving = useRef<Promise<void> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const halted = useRef(false);

  const applyDetail = useCallback((d: Detail) => {
    setDetail(d);
    versionRef.current = d.version;
    setResponses(d.responses);
    setReadings(Object.fromEntries(Object.entries(d.readings).map(([k, v]) => [k, v.text])));
    setUnits(d.units);
    setPhotos(d.photos);
  }, []);

  const load = useCallback(async () => {
    try {
      const d = await api<Detail>(`/api/inspections/${id}`);
      applyDetail(d);
      setLoadError(null);
      return d;
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Could not load inspection');
      return null;
    }
  }, [id, applyDetail]);

  useEffect(() => {
    void load().then((d) => {
      if (!d) return;
      try {
        const raw = localStorage.getItem(draftKey(id));
        if (raw && d.permissions.canEdit) {
          const saved = JSON.parse(raw) as { changes: EntryChange[]; units: UnitChange[] };
          if (saved.changes.length || saved.units.length) setRestoreOffer(saved);
        }
      } catch {
        /* storage unavailable */
      }
    });
  }, [id, load]);

  const persistBackup = () => {
    try {
      const p = pending.current;
      if (!p.changes.size && !p.units.size) localStorage.removeItem(draftKey(id));
      else localStorage.setItem(draftKey(id), JSON.stringify({ changes: [...p.changes.values()], units: [...p.units.values()] }));
    } catch {
      /* storage unavailable */
    }
  };

  const flush = useCallback(async (): Promise<void> => {
    if (saving.current) {
      await saving.current;
      if (pending.current.changes.size || pending.current.units.size) return flush();
      return;
    }
    const p = pending.current;
    if (halted.current || (!p.changes.size && !p.units.size)) return;
    const changes = [...p.changes.values()];
    const unitChanges = [...p.units.values()];
    pending.current = { changes: new Map(), units: new Map() };
    setSaveState('saving');
    let succeeded = false;
    const run = (async () => {
      try {
        const res = await api<{ version: number }>(`/api/inspections/${id}/entries`, {
          method: 'PATCH',
          body: { expectedVersion: versionRef.current, changes, units: unitChanges },
        });
        versionRef.current = res.version;
        succeeded = true;
        setSaveError(null);
        setSaveState(pending.current.changes.size || pending.current.units.size ? 'pending' : 'saved');
      } catch (err) {
        // Put the unsent changes back underneath anything typed since.
        for (const c of changes) {
          const k = rowId(c.unitIndex, c.sectionKey, c.rowKey);
          const newer = pending.current.changes.get(k);
          pending.current.changes.set(k, newer ? mergeChange(c, newer) : c);
        }
        for (const u of unitChanges) if (!pending.current.units.has(u.unitIndex)) pending.current.units.set(u.unitIndex, u);
        const e = err as ApiError;
        if (e.status === 409) {
          halted.current = true;
          setSaveState('conflict');
          setSaveError(e.message);
        } else {
          setSaveState('error');
          setSaveError(e.message);
          if (e.status === 0 || e.status >= 500) timer.current = setTimeout(() => void flush(), 4000);
          else halted.current = true;
        }
      } finally {
        persistBackup();
      }
    })();
    saving.current = run;
    await run;
    saving.current = null;
    // After a failure the retry timer (or the user) drives the next attempt — never a tight loop.
    if (succeeded && !halted.current && (pending.current.changes.size || pending.current.units.size)) await flush();
  }, [id]);

  const schedule = (delay: number) => {
    if (timer.current) clearTimeout(timer.current);
    setSaveState('pending');
    persistBackup();
    timer.current = setTimeout(() => void flush(), delay);
  };

  const queueChange = (change: EntryChange, delay = 600) => {
    const k = rowId(change.unitIndex, change.sectionKey, change.rowKey);
    const prev = pending.current.changes.get(k);
    pending.current.changes.set(k, prev ? mergeChange(prev, change) : change);
    schedule(delay);
  };

  const flushNow = async () => {
    if (timer.current) clearTimeout(timer.current);
    await flush();
    if (pending.current.changes.size || pending.current.units.size || halted.current) throw new Error(saveError ?? 'Unsaved changes could not be saved');
  };

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (pending.current.changes.size || pending.current.units.size || saving.current) {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      currentLocation.pathname !== nextLocation.pathname && (pending.current.changes.size > 0 || pending.current.units.size > 0 || saving.current !== null),
  );
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    flushNow()
      .then(() => blocker.proceed())
      .catch(() => {
        if (window.confirm('Some entries are not saved yet. Leave anyway? They stay on this device and can be restored when you return.')) blocker.proceed();
        else blocker.reset();
      });
  }, [blocker.state]);

  const def = detail?.form.definition;
  const entry: EntryState | null = useMemo(() => {
    if (!detail) return null;
    const photoCounts: Record<string, number> = {};
    for (const p of photos) {
      if (p.unitIndex === null || !p.sectionKey || !p.rowKey) continue;
      const k = rowId(p.unitIndex, p.sectionKey, p.rowKey);
      photoCounts[k] = (photoCounts[k] ?? 0) + 1;
    }
    return {
      responses: Object.fromEntries(Object.entries(responses).map(([k, v]) => [k, { status: v.status, note: v.note }])),
      readings,
      photoCounts,
      activated: detail.activated,
    };
  }, [detail, responses, readings, photos]);
  const evaluation: Evaluation | null = useMemo(
    () => (detail && entry ? evaluateInspection({ definition: detail.form.definition, unitCount: detail.unitCount, limits: detail.limits }, entry) : null),
    [detail, entry],
  );

  if (loadError) return <div className="notice notice-error" role="alert">{loadError}</div>;
  if (!detail || !def || !evaluation || !entry) return <LoadState loading error={null} />;

  const editable = detail.permissions.canEdit && saveState !== 'conflict';
  const activated = new Set(detail.activated);
  const sharedSections = def.sections.filter((s) => s.scope === 'inspection');
  const unitSections = def.sections.filter((s) => s.scope === 'unit');
  const latestReport = detail.reports[detail.reports.length - 1];

  const setStatus = (unitIndex: number, sectionKey: string, rowKey: string, status: ResponseStatus | null) => {
    const k = rowId(unitIndex, sectionKey, rowKey);
    setResponses((r) => ({ ...r, [k]: { status, note: r[k]?.note ?? null, amendmentNo: 0 } }));
    queueChange({ unitIndex, sectionKey, rowKey, status }, 150);
  };
  const setNote = (unitIndex: number, sectionKey: string, rowKey: string, note: string) => {
    const k = rowId(unitIndex, sectionKey, rowKey);
    setResponses((r) => ({ ...r, [k]: { status: r[k]?.status ?? null, note, amendmentNo: 0 } }));
    queueChange({ unitIndex, sectionKey, rowKey, note });
  };
  const setReading = (unitIndex: number, sectionKey: string, rowKey: string, readingKey: string, value: string) => {
    const k = readingId(unitIndex, sectionKey, rowKey, readingKey);
    setReadings((r) => ({ ...r, [k]: value }));
    queueChange({ unitIndex, sectionKey, rowKey, readings: { [readingKey]: value.trim() === '' ? null : value } });
  };
  const setUnitField = (unitIndex: number, field: 'serialNumber' | 'dispositionNote', value: string) => {
    setUnits((us) => us.map((u) => (u.unitIndex === unitIndex ? { ...u, [field]: value } : u)));
    const prev = pending.current.units.get(unitIndex) ?? { unitIndex };
    pending.current.units.set(unitIndex, { ...prev, [field]: value });
    schedule(600);
  };

  const serverAction = async (fn: () => Promise<unknown>, success?: string) => {
    setBusy(true);
    setBanner(null);
    try {
      await flushNow();
      await fn();
      await load();
      if (success) setBanner({ kind: 'ok', text: success });
    } catch (err) {
      const e = err as ApiError;
      if (e.status === 422 && e.details && typeof e.details === 'object' && 'errors' in e.details) setShowIssues(true);
      setBanner({ kind: 'error', text: e.message });
      if (e.status === 409) await load();
    } finally {
      setBusy(false);
    }
  };

  const goTo = (issue: Issue) => {
    if (issue.unitIndex > 0) setUnit(issue.unitIndex);
    setTimeout(() => {
      const el = document.getElementById(`row-${issue.unitIndex}-${issue.sectionKey}-${issue.rowKey ?? ''}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        el.classList.remove('flash');
        void el.offsetWidth;
        el.classList.add('flash');
        el.querySelector<HTMLElement>('button, input, textarea')?.focus({ preventScroll: true });
      }
    }, 60);
  };

  const complete = async () => {
    try {
      await flushNow();
    } catch (err) {
      setBanner({ kind: 'error', text: (err as Error).message });
      return;
    }
    if (evaluation.errors.length) {
      setShowIssues(true);
      setBanner({ kind: 'error', text: `${evaluation.errors.length} item(s) must be resolved before completion.` });
      return;
    }
    await serverAction(
      () => api(`/api/inspections/${id}/complete`, { body: { expectedVersion: versionRef.current } }),
      evaluation.reviewReasons.length
        ? 'Submitted for independent review. Entries are now locked.'
        : 'Inspection completed. The controlled report is being generated.',
    );
  };

  const requestPassAll = (section: FormSection, unitIndex: number) => {
    const t = passAllTargets(section, unitIndex, entry);
    if (!t.fill.length && !t.overwrite.length) return;
    setPassAllDialog({ section, unitIndex, overwrite: t.overwrite, fill: t.fill.length });
  };

  const openPdf = async () => {
    if (detail.status === 'COMPLETED' && latestReport) {
      window.open(`/api/files/${latestReport.fileId}`, '_blank', 'noopener');
      return;
    }
    try {
      await flushNow();
      window.open(`/api/inspections/${id}/preview.pdf`, '_blank', 'noopener');
    } catch (err) {
      setBanner({ kind: 'error', text: (err as Error).message });
    }
  };

  const uploadPhoto = async (file: File, unitIndex: number, sectionKey: string | null, rowKey: string | null) => {
    const params = new URLSearchParams();
    if (sectionKey && rowKey) {
      params.set('unitIndex', String(unitIndex));
      params.set('sectionKey', sectionKey);
      params.set('rowKey', rowKey);
    }
    const form = new FormData();
    form.append('file', file, file.name);
    const res = await api<{ linkId: string; fileId: string }>(`/api/inspections/${id}/photos?${params.toString()}`, { form });
    setPhotos((ps) => [...ps, { linkId: res.linkId, fileId: res.fileId, unitIndex: sectionKey ? unitIndex : null, sectionKey, rowKey, caption: null }]);
  };
  const removePhoto = async (linkId: string) => {
    await api(`/api/inspections/${id}/photos/${linkId}`, { method: 'DELETE' });
    setPhotos((ps) => ps.filter((p) => p.linkId !== linkId));
  };

  const unitOutcome = (u: number) => evaluation.unitOutcomes[u];
  const unitTouched = (u: number) => Object.keys(responses).some((k) => k.startsWith(`${u}|`) && responses[k]?.status);
  const saveText: Record<SaveState, string> = {
    saved: 'All changes saved',
    pending: 'Unsaved changes…',
    saving: 'Saving…',
    error: 'Not saved — retrying',
    conflict: 'Changed elsewhere',
  };

  const rowProps = {
    detail,
    responses,
    readings,
    photos,
    evaluation,
    editable,
    showIssues,
    setStatus,
    setNote,
    setReading,
    uploadPhoto,
    removePhoto,
    onAmend: (section: FormSection, row: AnswerRow, unitIndex: number) => setAmendRow({ section, row, unitIndex }),
    onConcern: async (unitIndex: number, sectionKey: string, rowKey: string) => {
      try {
        const res = await api<{ id: string; number: string }>(`/api/inspections/${id}/concerns`, { body: { unitIndex, sectionKey, rowKey } });
        await load();
        setBanner({ kind: 'ok', text: `Concern ${res.number} recorded and routed for triage.` });
      } catch (err) {
        setBanner({ kind: 'error', text: (err as Error).message });
      }
    },
  };

  return (
    <>
      <header className="wb-header" aria-label="Inspection header">
        <div>
          <div className="wb-title">
            {detail.partNumber} — {detail.partDescription}
          </div>
          <div className="wb-meta">
            {formLabel(def)} · PO {detail.poNumber ?? '—'} · Received {fmtDate(detail.dateReceived)} · {detail.inspector.name} · {detail.number}
          </div>
        </div>
        <span className={`save-state${saveState === 'error' || saveState === 'conflict' ? ' err' : ''}`} role="status" aria-live="polite">
          {detail.permissions.canEdit ? saveText[saveState] : <StatusBadge status={detail.status} />}
        </span>
        <div className="wb-actions">
          {detail.permissions.canEdit && (
            <>
              <button type="button" className="btn btn-small" disabled={busy} onClick={() => void flushNow().catch((e: Error) => setBanner({ kind: 'error', text: e.message }))}>
                Save
              </button>
              <button
                type="button"
                className="btn btn-small"
                disabled={busy}
                onClick={() => void serverAction(() => api(`/api/inspections/${id}/save-partial`, { body: { expectedVersion: versionRef.current } }), 'Saved as partially complete.')}
              >
                Save as Partially Complete
              </button>
              <button type="button" className="btn btn-small btn-primary" style={{ background: '#fff', color: 'var(--navy)' }} disabled={busy} onClick={() => void complete()}>
                Complete Inspection
              </button>
            </>
          )}
          <button type="button" className="btn btn-small" onClick={() => void openPdf()}>
            {detail.status === 'COMPLETED' && latestReport ? 'PDF' : 'Print preview'}
          </button>
          <button type="button" className="btn btn-small" onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/inspections'))}>
            Close
          </button>
        </div>
      </header>

      {restoreOffer && (
        <div className="notice notice-warn" role="alert">
          {restoreOffer.changes.length + restoreOffer.units.length} unsaved entr{restoreOffer.changes.length + restoreOffer.units.length === 1 ? 'y was' : 'ies were'} kept on this device
          from an interrupted session.{' '}
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              for (const c of restoreOffer.changes) {
                const k = rowId(c.unitIndex, c.sectionKey, c.rowKey);
                if (c.status !== undefined || c.note !== undefined) {
                  setResponses((r) => ({ ...r, [k]: { status: c.status !== undefined ? c.status : (r[k]?.status ?? null), note: c.note !== undefined ? c.note : (r[k]?.note ?? null), amendmentNo: 0 } }));
                }
                for (const [rk, v] of Object.entries(c.readings ?? {})) {
                  setReadings((r) => ({ ...r, [readingId(c.unitIndex, c.sectionKey, c.rowKey, rk)]: v ?? '' }));
                }
                queueChange(c, 300);
              }
              for (const u of restoreOffer.units) {
                pending.current.units.set(u.unitIndex, u);
                setUnits((us) => us.map((x) => (x.unitIndex === u.unitIndex ? { ...x, ...u } as typeof x : x)));
              }
              schedule(300);
              setRestoreOffer(null);
            }}
          >
            Restore and save them
          </button>{' '}
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              localStorage.removeItem(draftKey(id));
              setRestoreOffer(null);
            }}
          >
            Discard
          </button>
        </div>
      )}
      {saveState === 'conflict' && (
        <div className="notice notice-error" role="alert">
          {saveError} Your latest unsaved entries are kept on this device.{' '}
          <button
            type="button"
            className="btn btn-small"
            onClick={() => {
              halted.current = false;
              persistBackup();
              pending.current = { changes: new Map(), units: new Map() };
              setSaveState('saved');
              void load().then(() => window.location.reload());
            }}
          >
            Reload latest
          </button>
        </div>
      )}
      {saveState === 'error' && saveError && <div className="notice notice-error" role="alert">Not saved: {saveError}</div>}
      {banner && (
        <div className={`notice notice-${banner.kind === 'ok' ? 'ok' : banner.kind === 'warn' ? 'warn' : 'error'}`} role={banner.kind === 'ok' ? 'status' : 'alert'}>
          {banner.text}
        </div>
      )}

      <StatusPanel detail={detail} evaluation={evaluation} onReload={load} />

      {(showIssues || detail.status === 'READY_FOR_REVIEW') && evaluation.errors.length > 0 && (
        <section className="card" aria-labelledby="issues-h">
          <h2 id="issues-h">To resolve before completion ({evaluation.errors.length})</h2>
          <ul className="issues">
            {evaluation.errors.slice(0, 60).map((issue, i) => (
              <li key={i}>
                <button type="button" className="btn-link" onClick={() => goTo(issue)}>
                  {issue.path}: {issue.message}
                </button>
              </li>
            ))}
          </ul>
          {evaluation.errors.length > 60 && <p className="small muted">…and {evaluation.errors.length - 60} more.</p>}
        </section>
      )}
      {detail.permissions.canEdit && evaluation.errors.length === 0 && evaluation.reviewReasons.length > 0 && (
        <div className="notice notice-warn">
          Ready to complete. Because of {evaluation.reviewReasons.length === 1 ? 'one item' : `${evaluation.reviewReasons.length} items`} below, completion sends this inspection to independent review:
          <ul style={{ margin: '4px 0 0' }}>
            {evaluation.reviewReasons.slice(0, 8).map((r, i) => (
              <li key={i} className="small">
                {r.path}: {r.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {sharedSections.map((s) => (
        <SectionBlock key={s.key} section={s} unitIndex={0} {...rowProps} onPassAll={() => requestPassAll(s, 0)} />
      ))}

      <div className="unit-bar" role="navigation" aria-label="Inspected items">
        <button type="button" className="btn btn-small" disabled={unit <= 1} onClick={() => setUnit((u) => u - 1)}>
          ‹ Previous
        </button>
        <div className="unit-tabs" role="tablist" aria-label="Items">
          {Array.from({ length: detail.unitCount }, (_, i) => i + 1).map((u) => {
            const o = unitOutcome(u);
            const serial = units.find((x) => x.unitIndex === u)?.serialNumber;
            return (
              <button
                key={u}
                type="button"
                role="tab"
                className="unit-tab"
                aria-selected={unit === u}
                onClick={() => setUnit(u)}
                title={o ? `Item ${u}: ${o}` : `Item ${u}`}
              >
                <span className={`dot ${o === 'PASS' ? 'P' : o === 'FAIL' ? 'F' : o === 'ACCEPTED' ? 'A' : unitTouched(u) ? 'partial' : ''}`} aria-hidden="true" />
                {serial ? serial : `Item ${u}`}
                <span className="sr-only">{o ? `, ${o}` : ', not complete'}</span>
              </button>
            );
          })}
        </div>
        <button type="button" className="btn btn-small" disabled={unit >= detail.unitCount} onClick={() => setUnit((u) => u + 1)}>
          Next ›
        </button>
      </div>

      <section aria-label={`Item ${unit} of ${detail.unitCount}`}>
        <div className="card" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ fontWeight: 700, color: 'var(--navy)' }}>
            Item {unit} of {detail.unitCount}
          </div>
          <div style={{ width: 200 }}>
            <label htmlFor={`serial-${unit}`}>Serial number</label>
            <input
              id={`serial-${unit}`}
              type="text"
              value={units.find((u) => u.unitIndex === unit)?.serialNumber ?? ''}
              disabled={!editable}
              maxLength={80}
              onChange={(e) => setUnitField(unit, 'serialNumber', e.target.value)}
            />
          </div>
          <div className="small">
            Item result: <OutcomeBadge outcome={unitOutcome(unit)} />
          </div>
        </div>
        {unitSections.map((s) =>
          s.optional && !activated.has(activationId(unit, s.key)) ? (
            <div key={s.key} className="section">
              <div className="section-head">
                <h3>{sectionTitle(s)}</h3>
                {detail.permissions.canEdit ? (
                  <button
                    type="button"
                    className="btn btn-small"
                    disabled={busy}
                    onClick={() =>
                      void serverAction(() => api(`/api/inspections/${id}/sections`, { body: { expectedVersion: versionRef.current, unitIndex: unit, sectionKey: s.key } }))
                    }
                  >
                    + Add {s.title.split('—').pop()?.trim()}
                  </button>
                ) : (
                  <span className="small muted">Not performed for this item</span>
                )}
              </div>
            </div>
          ) : (
            <SectionBlock key={s.key} section={s} unitIndex={unit} {...rowProps} onPassAll={() => requestPassAll(s, unit)} />
          ),
        )}
        <div className="card">
          <label htmlFor={`disp-${unit}`}>Item {unit} result comment</label>
          <textarea
            id={`disp-${unit}`}
            value={units.find((u) => u.unitIndex === unit)?.dispositionNote ?? ''}
            disabled={!editable}
            maxLength={2000}
            onChange={(e) => setUnitField(unit, 'dispositionNote', e.target.value)}
          />
          <div className="field-hint">The item result is derived from its answers (Fail outranks Accepted, which outranks Pass). It does not authorize material use.</div>
        </div>
        <div className="row-actions" style={{ justifyContent: 'space-between' }}>
          <button type="button" className="btn" disabled={unit <= 1} onClick={() => { setUnit((u) => u - 1); window.scrollTo({ top: 0 }); }}>
            ‹ Previous item
          </button>
          <button type="button" className="btn" disabled={unit >= detail.unitCount} onClick={() => { setUnit((u) => u + 1); window.scrollTo({ top: 0 }); }}>
            Next item ›
          </button>
        </div>
      </section>

      <GeneralPhotos detail={detail} photos={photos} editable={editable} uploadPhoto={uploadPhoto} removePhoto={removePhoto} />
      <HistoryPanel id={id} detail={detail} />

      <Dialog
        open={passAllDialog !== null}
        title="Pass All"
        onClose={() => setPassAllDialog(null)}
        footer={
          passAllDialog && (
            <>
              <button type="button" className="btn" onClick={() => setPassAllDialog(null)}>
                Cancel
              </button>
              {passAllDialog.fill > 0 && (
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    const d = passAllDialog;
                    setPassAllDialog(null);
                    void serverAction(() =>
                      api(`/api/inspections/${id}/pass-all`, { body: { expectedVersion: versionRef.current, unitIndex: d.unitIndex, sectionKey: d.section.key, mode: 'fill_blank' } }),
                    );
                  }}
                >
                  Mark {passAllDialog.fill} unanswered as Pass
                </button>
              )}
              {passAllDialog.overwrite.length > 0 && (
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => {
                    const d = passAllDialog;
                    setPassAllDialog(null);
                    void serverAction(() =>
                      api(`/api/inspections/${id}/pass-all`, { body: { expectedVersion: versionRef.current, unitIndex: d.unitIndex, sectionKey: d.section.key, mode: 'overwrite_all' } }),
                    );
                  }}
                >
                  Overwrite all {passAllDialog.fill + passAllDialog.overwrite.length} as Pass
                </button>
              )}
            </>
          )
        }
      >
        {passAllDialog && (
          <>
            <p style={{ marginTop: 0 }}>
              {sectionTitle(passAllDialog.section)} — {passAllDialog.unitIndex === 0 ? 'receiving' : `Item ${passAllDialog.unitIndex}`}. Only checklist rows are affected; measurements are never filled.
            </p>
            {passAllDialog.overwrite.length > 0 && (
              <div className="notice notice-warn">
                {passAllDialog.overwrite.length} row(s) already have a different answer (
                {passAllDialog.overwrite.map((o) => STATUS_LABEL[o.status]).join(', ')}). Overwriting replaces them; notes and photos stay attached.
              </div>
            )}
          </>
        )}
      </Dialog>

      {amendRow && (
        <AmendDialog
          id={id}
          version={versionRef.current}
          target={amendRow}
          responses={responses}
          readings={readings}
          onClose={() => setAmendRow(null)}
          onDone={async (msg) => {
            setAmendRow(null);
            await load();
            setBanner({ kind: 'ok', text: msg });
          }}
        />
      )}
    </>
  );
}

function mergeChange(a: EntryChange, b: EntryChange): EntryChange {
  return {
    ...a,
    ...(b.status !== undefined ? { status: b.status } : {}),
    ...(b.note !== undefined ? { note: b.note } : {}),
    readings: { ...(a.readings ?? {}), ...(b.readings ?? {}) },
  };
}

interface RowCtx {
  detail: Detail;
  responses: Detail['responses'];
  readings: Record<string, string>;
  photos: Photo[];
  evaluation: Evaluation;
  editable: boolean;
  showIssues: boolean;
  setStatus: (u: number, s: string, r: string, v: ResponseStatus | null) => void;
  setNote: (u: number, s: string, r: string, v: string) => void;
  setReading: (u: number, s: string, r: string, k: string, v: string) => void;
  uploadPhoto: (f: File, u: number, s: string | null, r: string | null) => Promise<void>;
  removePhoto: (linkId: string) => Promise<void>;
  onAmend: (section: FormSection, row: AnswerRow, unitIndex: number) => void;
  onConcern: (u: number, s: string, r: string) => Promise<void>;
}

function SectionBlock({ section, unitIndex, onPassAll, ...ctx }: RowCtx & { section: FormSection; unitIndex: number; onPassAll: () => void }) {
  const rows = sectionRows(section);
  const measured = rows.filter((r) => r.readingKeys.length > 0);
  const unreleased = measured.some((r) => r.readingKeys.some((rk) => {
    const ref = readingLimitRef(r, rk);
    return !ref || !ctx.detail.limits[ref];
  }));
  return (
    <section className="section" aria-label={sectionTitle(section)}>
      <div className="section-head">
        <h3>
          {sectionTitle(section)}
          {section.scope === 'inspection' && <span className="small muted" style={{ textTransform: 'none', marginLeft: 8 }}>once per inspection</span>}
        </h3>
        {ctx.editable && isPassAllEligible(section) && (
          <button type="button" className="btn btn-small" onClick={onPassAll}>
            Pass All
          </button>
        )}
      </div>
      {measured.length > 0 && unreleased && (
        <div className="notice small" style={{ margin: '8px 12px' }}>
          Specification not released — Engineering review required. Readings are recorded as observations; no Pass is calculated without a released limit.
        </div>
      )}
      {rows.map((row, i) => {
        if (row.parentKey) {
          const parent = ctx.responses[rowId(unitIndex, section.key, row.parentKey)]?.status;
          if (parent !== 'F') return null;
        }
        return <QuestionRow key={row.key} index={i} section={section} row={row} unitIndex={unitIndex} {...ctx} />;
      })}
    </section>
  );
}

function QuestionRow({ section, row, unitIndex, index, ...ctx }: RowCtx & { section: FormSection; row: AnswerRow; unitIndex: number; index: number }) {
  const id = rowId(unitIndex, section.key, row.key);
  const response = ctx.responses[id];
  const status = response?.status ?? null;
  const rowEval = ctx.evaluation.rows[id];
  const issues = ctx.evaluation.errors.filter((e) => e.unitIndex === unitIndex && e.sectionKey === section.key && e.rowKey === row.key);
  const rowPhotos = ctx.photos.filter((p) => p.unitIndex === unitIndex && p.sectionKey === section.key && p.rowKey === row.key);
  const needPhoto = photoRequired(section.pattern, status) && rowPhotos.length === 0;
  const needNote = noteRequired(section.pattern, status) && !(response?.note ?? '').trim();
  const options: ResponseStatus[] = row.parentKey ? ['P', 'F'] : ['P', 'F', 'A', 'N'];
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const concern = ctx.detail.concerns.find((c) => c.unitIndex === unitIndex && c.sectionKey === section.key && c.rowKey === row.key);
  const limitOf = (rk: string) => {
    const ref = readingLimitRef(row, rk);
    return ref ? ctx.detail.limits[ref] : undefined;
  };
  const limitText = row.readingKeys.length
    ? section.pattern === 'valve_recession'
      ? ['int', 'exh'].map((p) => {
          const l = limitOf(`${p}1`);
          return `${p === 'int' ? 'Intake' : 'Exhaust'}: ${l ? formatLimit(l) : 'not released'}`;
        }).join(' · ')
      : limitOf(row.readingKeys[0]!)
        ? formatLimit(limitOf(row.readingKeys[0]!)!)
        : row.source?.specText
          ? `Reference: ${row.source.specText} (not a released limit)`
          : 'Specification not released'
    : null;
  const showIssue = ctx.showIssues || ctx.detail.status !== 'DRAFT';
  const exceptional = status === 'F' || status === 'A' || rowEval?.measurement === 'OUTSIDE';

  return (
    <div id={`row-${unitIndex}-${section.key}-${row.key}`} className={`qrow${showIssue && issues.length ? ' has-error' : ''}`}>
      <div className="qnum">{row.parentKey ? '↳' : index + 1}</div>
      <div>
        <div className="qname">{row.label}</div>
        {row.source?.acceptance && <div className="qcrit">{row.source.acceptance}</div>}
        {row.source?.location && <div className="qcrit">Location: {row.source.location}</div>}
        {limitText && <div className="qcrit">Limit: {limitText}</div>}
        {showIssue && issues.map((iss, i) => <div key={i} className="qissue">{iss.message}</div>)}
        {concern && (
          <div className="small">
            Concern <Link to={`/quality/${concern.id}`}>{concern.number}</Link> · <StatusBadge status={concern.status} />
          </div>
        )}
        {!ctx.detail.permissions.canEdit && ctx.detail.permissions.canCaptureConcern && exceptional && !concern && (
          <button type="button" className="btn-link small" onClick={() => void ctx.onConcern(unitIndex, section.key, row.key)}>
            Raise quality concern
          </button>
        )}
        {ctx.detail.permissions.canAmend && !row.parentKey && (
          <button type="button" className="btn-link small" style={{ marginLeft: 8 }} onClick={() => ctx.onAmend(section, row, unitIndex)}>
            Amend
          </button>
        )}
        {response && response.amendmentNo > 0 && <div className="small muted">Amended (amendment {response.amendmentNo})</div>}
      </div>
      <div className="qcol-status">
        {row.readingKeys.length > 0 && (
          <div className={row.readingKeys.length > 3 ? 'series-grid' : 'readings'} style={{ marginBottom: 6 }}>
            {row.readingKeys.map((rk, i) => {
              const res = rowEval?.readingResults[rk];
              const rid = readingId(unitIndex, section.key, row.key, rk);
              const unitLabel = limitOf(rk)?.unit ?? row.source?.unit;
              return (
                <div key={rk} className={`reading${res === 'OUTSIDE' ? ' outside' : res === 'WITHIN' ? ' within' : ''}`}>
                  <label htmlFor={`in-${rid}`}>
                    {row.readingLabels[i]}
                    {unitLabel ? ` (${unitLabel})` : ''}
                  </label>
                  <input
                    id={`in-${rid}`}
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    value={ctx.readings[rid] ?? ''}
                    disabled={!ctx.editable}
                    aria-invalid={res === 'OUTSIDE'}
                    onChange={(e) => ctx.setReading(unitIndex, section.key, row.key, rk, e.target.value)}
                  />
                  {res === 'OUTSIDE' && <span className="small" style={{ color: 'var(--red)' }}>Outside limit</span>}
                </div>
              );
            })}
          </div>
        )}
        <div className="seg" role="radiogroup" aria-label={`Result for ${row.label}`}>
          {options.map((o) => (
            <button
              key={o}
              type="button"
              role="radio"
              aria-checked={status === o}
              className={`s-${o}`}
              disabled={!ctx.editable}
              onClick={() => ctx.setStatus(unitIndex, section.key, row.key, status === o ? null : o)}
            >
              {o}
              <span>{STATUS_LABEL[o]}</span>
            </button>
          ))}
        </div>
      </div>
      {!row.parentKey && (
        <div className="qcol-note">
          <label htmlFor={`note-${id}`} className="sr-only">
            Observation for {row.label}
          </label>
          <textarea
            id={`note-${id}`}
            placeholder={needNote ? (status === 'N' ? 'Reason for N/A required' : 'Observation required') : 'Observation / notes'}
            value={response?.note ?? ''}
            disabled={!ctx.editable}
            aria-invalid={needNote && showIssue}
            maxLength={2000}
            rows={2}
            style={needNote ? { borderColor: 'var(--red)' } : undefined}
            onChange={(e) => ctx.setNote(unitIndex, section.key, row.key, e.target.value)}
          />
        </div>
      )}
      {!row.parentKey && (
        <div className="qcol-photo photos">
          {rowPhotos.map((p) => (
            <div key={p.linkId} className="thumb">
              <a href={`/api/files/${p.fileId}`} target="_blank" rel="noopener noreferrer">
                <img src={`/api/files/${p.fileId}`} alt={`Photo of ${row.label}`} loading="lazy" />
              </a>
              {ctx.editable && (
                <button type="button" aria-label="Remove photo" onClick={() => void ctx.removePhoto(p.linkId).catch((e: Error) => setUploadError(e.message))}>
                  ×
                </button>
              )}
            </div>
          ))}
          {ctx.editable && (
            <label className={`btn btn-small photo-btn${needPhoto ? ' required' : ''}`} style={{ margin: 0, fontSize: 13 }}>
              {uploading ? 'Uploading…' : needPhoto ? 'Photo required' : '+ Photo'}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                capture="environment"
                aria-label={`Add photo for ${row.label}`}
                disabled={uploading}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  setUploading(true);
                  setUploadError(null);
                  try {
                    await ctx.uploadPhoto(file, unitIndex, section.key, row.key);
                  } catch (err) {
                    setUploadError((err as Error).message);
                  } finally {
                    setUploading(false);
                  }
                }}
              />
            </label>
          )}
          {uploadError && (
            <div className="field-error" role="alert">
              Photo not saved: {uploadError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusPanel({ detail, evaluation, onReload }: { detail: Detail; evaluation: Evaluation; onReload: () => Promise<unknown> }) {
  const [comment, setComment] = useState('');
  const [concessionId, setConcessionId] = useState('');
  const [requestOpen, setRequestOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!detail.reportPending) return;
    const t = setInterval(() => void onReload(), 2500);
    return () => clearInterval(t);
  }, [detail.reportPending, onReload]);
  const reasons = detail.reviewReasons ?? [];
  const hasAccepted = reasons.some((r) => r.message.startsWith('Accepted'));
  const concessions = useLoad<Array<{ id: string; number: string; state: string; used: number; quantityLimit: number; validUntil: string; characteristic: string }>>(
    hasAccepted && detail.status === 'READY_FOR_REVIEW' && detail.partId && detail.lotNumber
      ? `/api/concessions?status=APPROVED&partId=${detail.partId}&lot=${encodeURIComponent(detail.lotNumber)}`
      : null,
  );
  const review = async (decision: 'CONFIRM' | 'RETURN') => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/inspections/${detail.id}/review`, {
        body: { decision, comment: comment || null, expectedVersion: detail.version, concessionId: decision === 'CONFIRM' && concessionId ? concessionId : null },
      });
      await onReload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-label="Inspection status">
      <div className="outcome-strip">
        <StatusBadge status={detail.status} />
        <span className="small">
          Outcome: <OutcomeBadge outcome={detail.status === 'COMPLETED' || detail.status === 'READY_FOR_REVIEW' ? detail.outcome : evaluation.errors.length ? null : evaluation.overall} />
          {detail.status !== 'COMPLETED' && detail.status !== 'READY_FOR_REVIEW' && <span className="muted"> (so far)</span>}
        </span>
        <span className="small muted">
          {evaluation.answeredRows}/{evaluation.requiredRows} answered
        </span>
        <span className="small muted">
          Supplier: {detail.supplier ? `${detail.supplier.name} — ${detail.site?.name}` : 'not identified'}
          {detail.lotNumber ? ` · Lot ${detail.lotNumber}` : ''}
        </span>
        {detail.baseline ? (
          <span className="small">
            Limits: {detail.baseline.baselineTitle} Rev {detail.baseline.revisionLabel} {detail.baseline.synthetic && <span className="badge badge-synthetic">synthetic</span>}
          </span>
        ) : (
          <span className="small muted">No released technical baseline</span>
        )}
      </div>
      <p className="small muted" style={{ margin: '6px 0 0' }}>
        Material: not authorized by this inspection.{detail.sourceState !== 'APPROVED' ? ' Source is not approved; material stays on hold pending authorized disposition.' : ''}
        {detail.concession && (
          <>
            {' '}
            Accepted item(s) covered by <Link to={`/quality/concessions/${detail.concession.id}`}>{detail.concession.number}</Link> ({detail.concession.quantity}, valid until{' '}
            {fmtDate(detail.concession.validUntil)}).
          </>
        )}
        {detail.outcome === 'ACCEPTED' && !detail.concession && detail.status === 'COMPLETED' && ' Accepted items have no concession recorded; they are not authorized for use.'}
      </p>

      {detail.status === 'READY_FOR_REVIEW' && (
        <div style={{ marginTop: 10 }}>
          <h3>Independent review</h3>
          <ul style={{ margin: '0 0 8px' }}>
            {reasons.map((r, i) => (
              <li key={i} className="small">
                {r.path}: {r.message}
              </li>
            ))}
          </ul>
          {detail.permissions.canReview ? (
            <>
              <div className="field">
                <label htmlFor="review-comment">Review comment (required to return)</label>
                <textarea id="review-comment" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} />
              </div>
              {hasAccepted && !detail.permissions.canReviewAccepted && (
                <div className="notice notice-warn small">Confirming an Accepted result requires accepted-result review authority. You can return it or leave it for an authorized reviewer.</div>
              )}
              {hasAccepted && detail.permissions.canReviewAccepted && (
                <div className="field">
                  <label htmlFor="review-concession">Concession covering the accepted item(s)</label>
                  <select id="review-concession" value={concessionId} onChange={(e) => setConcessionId(e.target.value)}>
                    <option value="">None — accepted items stay unauthorized for use</option>
                    {concessions.data
                      ?.filter((c) => c.state === 'CURRENT')
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.number} — {c.characteristic}, {c.used}/{c.quantityLimit} used, until {fmtDate(c.validUntil)}
                        </option>
                      ))}
                  </select>
                  <div className="field-hint">
                    Only current concessions for this part and lot {detail.lotNumber ?? '(no lot recorded)'} are offered.{' '}
                    {detail.permissions.canRequestConcession && detail.partId && (
                      <button type="button" className="btn-link" onClick={() => setRequestOpen(true)}>
                        Request a concession
                      </button>
                    )}
                  </div>
                </div>
              )}
              <div className="row-actions">
                <button type="button" className="btn btn-primary" disabled={busy || (hasAccepted && !detail.permissions.canReviewAccepted)} onClick={() => void review('CONFIRM')}>
                  Confirm review
                </button>
                <button type="button" className="btn" disabled={busy || !comment.trim()} onClick={() => void review('RETURN')}>
                  Return for correction
                </button>
              </div>
            </>
          ) : (
            <p className="small muted">Awaiting review by an authorized person other than the inspector.</p>
          )}
          {error && <div className="notice notice-error" role="alert">{error}</div>}
        </div>
      )}
      {detail.partId && (
        <RequestConcessionDialog
          open={requestOpen}
          onClose={() => setRequestOpen(false)}
          partId={detail.partId}
          inspectionId={detail.id}
          lotNumber={detail.lotNumber}
          onCreated={() => {
            setRequestOpen(false);
            concessions.reload();
          }}
        />
      )}

      {detail.status === 'COMPLETED' && (
        <div style={{ marginTop: 10 }}>
          <h3>Controlled report</h3>
          {detail.reportError && <div className="notice notice-error">{detail.reportError}</div>}
          {detail.reportPending && <p className="small" aria-live="polite">Generating the next report edition…</p>}
          {detail.reports.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {detail.reports.map((r) => (
                <li key={r.renditionId} className="small">
                  <a href={`/api/files/${r.fileId}`} target="_blank" rel="noopener noreferrer">
                    Edition {r.edition}
                  </a>{' '}
                  · {r.pageCount} pages · {fmtDateTime(r.renderedAt)} · SHA-256 {r.sha256.slice(0, 12)}…
                </li>
              ))}
            </ul>
          )}
          {detail.completedAt && (
            <p className="small muted" style={{ marginBottom: 0 }}>
              Completed {fmtDateTime(detail.completedAt)}
              {detail.completedBy ? ` by ${detail.completedBy}` : ''}
              {detail.reviews.length ? ` · reviewed by ${detail.reviews[detail.reviews.length - 1]!.reviewer}` : ''}
            </p>
          )}
          {detail.amendments.length > 0 && (
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {detail.amendments.map((a) => (
                <li key={a.amendmentNo} className="small">
                  Amendment {a.amendmentNo} by {a.amendedBy} ({fmtDateTime(a.amendedAt)}): {a.reason} → {a.resultingOutcome}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function GeneralPhotos({ detail, photos, editable, uploadPhoto, removePhoto }: { detail: Detail; photos: Photo[]; editable: boolean; uploadPhoto: RowCtx['uploadPhoto']; removePhoto: RowCtx['removePhoto'] }) {
  const general = photos.filter((p) => !p.sectionKey);
  const [error, setError] = useState<string | null>(null);
  if (!editable && general.length === 0) return null;
  return (
    <section className="card" aria-labelledby="gallery-h">
      <h2 id="gallery-h">General photographs</h2>
      <div className="photos">
        {general.map((p) => (
          <div key={p.linkId} className="thumb">
            <a href={`/api/files/${p.fileId}`} target="_blank" rel="noopener noreferrer">
              <img src={`/api/files/${p.fileId}`} alt="General inspection photograph" loading="lazy" />
            </a>
            {editable && (
              <button type="button" aria-label="Remove photo" onClick={() => void removePhoto(p.linkId).catch((e: Error) => setError(e.message))}>
                ×
              </button>
            )}
          </div>
        ))}
        {editable && (
          <label className="btn btn-small photo-btn" style={{ margin: 0 }}>
            + Add photographs
            <input
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp"
              aria-label="Add general photographs"
              onChange={async (e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = '';
                setError(null);
                for (const f of files) {
                  try {
                    await uploadPhoto(f, 0, null, null);
                  } catch (err) {
                    setError(`${f.name}: ${(err as Error).message}`);
                  }
                }
              }}
            />
          </label>
        )}
      </div>
      {error && <div className="field-error" role="alert">{error}</div>}
      <p className="small muted" style={{ marginBottom: 0 }}>
        {detail.permissions.canEdit ? 'Row-specific photos are added beside each characteristic.' : ''}
      </p>
    </section>
  );
}

function HistoryPanel({ id, detail }: { id: string; detail: Detail }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Array<{ id: string; occurredAt: string; action: string; outcome: string; summary: string; reason: string | null; actor: string | null }> | null>(null);
  useEffect(() => {
    if (open) void api<typeof items>(`/api/inspections/${id}/history`).then(setItems);
  }, [open, id, detail.version]);
  return (
    <section className="card">
      <button type="button" className="btn-link" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {open ? 'Hide' : 'Show'} history and details
      </button>
      {open && (
        <>
          <dl className="kv" style={{ marginTop: 10 }}>
            <dt>Inspection</dt>
            <dd>{detail.number}</dd>
            <dt>Form</dt>
            <dd>{formLabel(detail.form.definition)}</dd>
            <dt>Source status at receipt</dt>
            <dd>{detail.sourceState.replaceAll('_', ' ').toLowerCase()}</dd>
          </dl>
          <ul style={{ paddingLeft: 18 }}>
            {items?.map((h) => (
              <li key={h.id} className="small">
                {fmtDateTime(h.occurredAt)} — {h.actor ?? 'System'}: {h.summary}
                {h.outcome !== 'SUCCESS' && <strong> ({h.outcome.toLowerCase()})</strong>}
                {h.reason ? ` — ${h.reason}` : ''}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function AmendDialog({
  id,
  version,
  target,
  responses,
  readings,
  onClose,
  onDone,
}: {
  id: string;
  version: number;
  target: { section: FormSection; row: AnswerRow; unitIndex: number };
  responses: Detail['responses'];
  readings: Record<string, string>;
  onClose: () => void;
  onDone: (msg: string) => Promise<void>;
}) {
  const { section, row, unitIndex } = target;
  const current = responses[rowId(unitIndex, section.key, row.key)];
  const [status, setStatus] = useState<ResponseStatus | null>(current?.status ?? null);
  const [note, setNote] = useState(current?.note ?? '');
  const [vals, setVals] = useState<Record<string, string>>(
    Object.fromEntries(row.readingKeys.map((rk) => [rk, readings[readingId(unitIndex, section.key, row.key, rk)] ?? ''])),
  );
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ amendmentNo: number; outcome: string }>(`/api/inspections/${id}/amendments`, {
        body: {
          reason,
          expectedVersion: version,
          changes: [
            {
              unitIndex,
              sectionKey: section.key,
              rowKey: row.key,
              status,
              note: note || null,
              ...(row.readingKeys.length ? { readings: Object.fromEntries(Object.entries(vals).map(([k, v]) => [k, v.trim() ? v : null])) } : {}),
            },
          ],
        },
      });
      await onDone(`Amendment ${res.amendmentNo} recorded. Outcome is now ${res.outcome}; a new report edition is being generated and earlier editions remain available.`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      title={`Amend: ${row.label}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || reason.trim().length < 5} onClick={() => void submit()}>
            Record amendment
          </button>
        </>
      }
    >
      <p className="small muted" style={{ marginTop: 0 }}>
        The original entry and report stay unchanged; this correction is recorded with your name, time and reason.
      </p>
      {row.readingKeys.length > 0 && (
        <div className="readings" style={{ marginBottom: 10 }}>
          {row.readingKeys.map((rk, i) => (
            <div key={rk} className="reading">
              <label htmlFor={`am-${rk}`}>{row.readingLabels[i]}</label>
              <input id={`am-${rk}`} type="text" inputMode="decimal" value={vals[rk] ?? ''} onChange={(e) => setVals((v) => ({ ...v, [rk]: e.target.value }))} />
            </div>
          ))}
        </div>
      )}
      <div className="seg" role="radiogroup" aria-label="Amended result" style={{ marginBottom: 10 }}>
        {(['P', 'F', 'A', 'N'] as ResponseStatus[]).map((o) => (
          <button key={o} type="button" role="radio" aria-checked={status === o} className={`s-${o}`} onClick={() => setStatus(o)}>
            {o}
            <span>{STATUS_LABEL[o]}</span>
          </button>
        ))}
      </div>
      <div className="field">
        <label htmlFor="am-note">Observation</label>
        <textarea id="am-note" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="am-reason">Reason for amendment</label>
        <textarea id="am-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      {error && <div className="notice notice-error" role="alert">{error}</div>}
    </Dialog>
  );
}
