import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { DOCUMENT_FAMILIES } from '../../shared/documents';
import { api, fmtDate, fmtDateTime } from '../api';
import { useAuth } from '../auth';
import { useBusy } from '../components/sourcing';
import { Dialog, LoadState, StatusBadge, useLoad } from '../components/ui';

type Usage = { how: 'GENERATED' | 'RECORDED'; route: string; screen: string } | null;

interface DocumentRow {
  id: string;
  number: string;
  typeCode: string | null;
  family: string;
  kind: 'FORM' | 'CONTINUATION' | 'LIBRARY';
  title: string;
  currentRevision: string | null;
  currentEffective: string | null;
  currentFileId: string | null;
  pendingRevision: string | null;
  pendingEffective: string | null;
  revisionCount: number;
  usage: Usage;
}

interface Revision {
  id: string;
  revisionLabel: string;
  effectiveFrom: string;
  changeSummary: string;
  fileId: string;
  sha256: string;
  byteSize: number;
  originalName: string | null;
  releasedBy: string;
  releasedAt: string;
  status: 'CURRENT' | 'PENDING' | 'SUPERSEDED';
}

interface DocumentDetail {
  id: string;
  number: string;
  typeCode: string | null;
  family: string;
  kind: string;
  title: string;
  ownerRole: string;
  retentionClass: string | null;
  asOf: string;
  revisions: Revision[];
  related: Array<{ id: string; number: string; kind: string; title: string }>;
  usage: Usage;
  evidenceType: string | null;
}

const KIND_TEXT: Record<string, string> = { FORM: 'Form', CONTINUATION: 'Continuation sheet', LIBRARY: 'Library document' };
const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function RevisionStatus({ r }: { r: Pick<Revision, 'status' | 'effectiveFrom'> }) {
  if (r.status === 'CURRENT') return <span className="badge badge-done">Current</span>;
  if (r.status === 'PENDING') return <span className="badge badge-review">Effective {fmtDate(r.effectiveFrom)}</span>;
  return <StatusBadge status="SUPERSEDED" />;
}

function UsageNote({ usage }: { usage: Usage }) {
  if (!usage) return <span className="muted">—</span>;
  return (
    <>
      <Link to={usage.route}>{usage.screen}</Link>
      <div className="small muted">{usage.how === 'GENERATED' ? 'App produces this record and its PDF' : 'Recorded in the app'}</div>
    </>
  );
}

export function DocumentList() {
  const { can } = useAuth();
  const { data, error, loading, reload } = useLoad<{ asOf: string; documents: DocumentRow[] }>('/api/documents');
  const [q, setQ] = useState('');
  const [family, setFamily] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data?.documents ?? []).filter(
      (d) => (!family || d.family === family) && (!needle || d.number.toLowerCase().includes(needle) || d.title.toLowerCase().includes(needle)),
    );
  }, [data, q, family]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Document Library</h1>
          <div className="small muted">Controlled quality-system forms and documents, owned by administrators. The current revision is the latest one already in effect.</div>
        </div>
        {can('documents.control') && (
          <button type="button" className="btn btn-primary" onClick={() => setImportOpen(true)}>
            Import documents
          </button>
        )}
      </div>
      <div className="card row-actions">
        <label htmlFor="doc-q" className="sr-only">
          Search documents
        </label>
        <input id="doc-q" type="search" style={{ maxWidth: 320 }} placeholder="Number or title" value={q} onChange={(e) => setQ(e.target.value)} />
        <label htmlFor="doc-family" className="sr-only">
          Family
        </label>
        <select id="doc-family" style={{ maxWidth: 240 }} value={family} onChange={(e) => setFamily(e.target.value)}>
          <option value="">All families</option>
          {Object.entries(DOCUMENT_FAMILIES).map(([code, label]) => (
            <option key={code} value={code}>
              {code} — {label}
            </option>
          ))}
        </select>
        {data && (
          <span className="small muted">
            {rows.length} of {data.documents.length} documents
          </span>
        )}
      </div>
      <LoadState loading={loading && !data} error={error} />
      {data && (
        <div className="table-wrap">
          <table className="data stack">
            <thead>
              <tr>
                <th>Number</th>
                <th>Title</th>
                <th>Current revision</th>
                <th>Next revision</th>
                <th>Used in the app</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5}>
                    <div className="empty">{data.documents.length ? 'No documents match.' : 'No documents yet. Administrators can import the controlled document set.'}</div>
                  </td>
                </tr>
              )}
              {rows.map((d) => (
                <tr key={d.id}>
                  <td data-label="Number">
                    <Link to={`/documents/${d.id}`}>{d.number}</Link>
                    <div className="small muted">{KIND_TEXT[d.kind]}</div>
                  </td>
                  <td data-label="Title">{d.title}</td>
                  <td data-label="Current revision">
                    {d.currentRevision ? (
                      <>
                        Rev {d.currentRevision}
                        <div className="small muted">since {fmtDate(d.currentEffective)}</div>
                      </>
                    ) : (
                      <span className="muted">None in effect</span>
                    )}
                  </td>
                  <td data-label="Next revision">
                    {d.pendingRevision ? (
                      <>
                        Rev {d.pendingRevision}
                        <div className="small muted">effective {fmtDate(d.pendingEffective)}</div>
                      </>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td data-label="Used in the app">
                    <UsageNote usage={d.usage} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ImportDialog
        open={importOpen}
        onClose={() => {
          setImportOpen(false);
          reload();
        }}
      />
    </>
  );
}

type ImportResult = { name: string; ok: boolean; text: string };
const IMPORT_TEXT: Record<string, string> = { CREATED: 'added', ADDED_REVISION: 'new revision added', UNCHANGED: 'already imported (unchanged)' };

function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [files, setFiles] = useState<File[]>([]);
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const [results, setResults] = useState<ImportResult[]>([]);
  const [running, setRunning] = useState(false);
  const failed = results.filter((r) => !r.ok);

  const start = async () => {
    setRunning(true);
    setResults([]);
    for (const file of files) {
      const form = new FormData();
      form.append('file', file, file.name);
      try {
        const r = await api<{ status: string; number: string; revisionLabel: string }>(`/api/documents/import?effectiveFrom=${effectiveFrom}`, { form });
        setResults((prev) => [...prev, { name: file.name, ok: true, text: `${r.number} Rev ${r.revisionLabel} ${IMPORT_TEXT[r.status] ?? r.status}` }]);
      } catch (err) {
        setResults((prev) => [...prev, { name: file.name, ok: false, text: (err as Error).message }]);
      }
    }
    setRunning(false);
    setFiles([]);
  };

  return (
    <Dialog
      open={open}
      title="Import documents"
      onClose={() => {
        if (running) return;
        setResults([]);
        setFiles([]);
        onClose();
      }}
      footer={
        <button type="button" className="btn btn-primary" disabled={running || !files.length || !effectiveFrom} onClick={() => void start()}>
          {running ? `Importing ${Math.min(results.length + 1, files.length)} of ${files.length}…` : `Import ${files.length || ''} file${files.length === 1 ? '' : 's'}`}
        </button>
      }
    >
      <p className="small muted" style={{ marginTop: 0 }}>
        Number, title and revision are read from each file name, for example <code>OPS-06_Nonconformance_Report_Rev03.pdf</code>. Files already imported are skipped.
      </p>
      <div className="field">
        <label htmlFor="import-files">PDF files</label>
        <input id="import-files" type="file" accept="application/pdf,.pdf" multiple disabled={running} onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
        {files.length > 0 && <div className="field-hint">{files.length} file(s) selected</div>}
      </div>
      <div className="field">
        <label htmlFor="import-effective">Effective date</label>
        <input id="import-effective" type="date" required value={effectiveFrom} disabled={running} onChange={(e) => setEffectiveFrom(e.target.value)} />
        <div className="field-hint">Each imported revision becomes current on this date.</div>
      </div>
      {results.length > 0 && (
        <div aria-live="polite">
          <div className={`notice ${failed.length ? 'notice-warn' : 'notice-ok'}`} role="status">
            {results.length - failed.length} imported or already present{failed.length ? `, ${failed.length} not imported` : ''}
            {running ? ' — working…' : ''}
          </div>
          {failed.length > 0 && (
            <ul className="small" style={{ paddingLeft: 18 }}>
              {failed.map((r) => (
                <li key={r.name}>
                  <strong>{r.name}</strong>: {r.text}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Dialog>
  );
}

export function DocumentDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data, error, loading, reload } = useLoad<DocumentDetail>(`/api/documents/${id}`);
  const [reviseOpen, setReviseOpen] = useState(false);
  if (!data) return <LoadState loading={loading} error={error} />;
  const current = data.revisions.find((r) => r.status === 'CURRENT');
  return (
    <>
      <div className="page-head">
        <div>
          <div className="small">
            <Link to="/documents">Document Library</Link>
          </div>
          <h1>
            {data.number} — {data.title}
          </h1>
          <div className="small muted">
            {KIND_TEXT[data.kind]} · {data.family} {DOCUMENT_FAMILIES[data.family] ? `(${DOCUMENT_FAMILIES[data.family]})` : ''}
          </div>
        </div>
        <div className="row-actions">
          {current && (
            <a className="btn" href={`/api/files/${current.fileId}`} target="_blank" rel="noreferrer">
              Open current PDF
            </a>
          )}
          {can('documents.control') && (
            <button type="button" className="btn btn-primary" onClick={() => setReviseOpen(true)}>
              Add revision
            </button>
          )}
        </div>
      </div>
      <div className="two-col">
        <div className="card">
          <h2>Control</h2>
          <dl className="kv">
            <dt>Owner</dt>
            <dd>Administrators</dd>
            <dt>Current revision</dt>
            <dd>{current ? `Rev ${current.revisionLabel}, effective ${fmtDate(current.effectiveFrom)}` : 'None in effect yet'}</dd>
            <dt>Retention</dt>
            <dd>{data.retentionClass ?? <span className="muted">Not set — retention rules are open (POL-07)</span>}</dd>
          </dl>
        </div>
        <div className="card">
          <h2>Use in the app</h2>
          {data.usage ? (
            <p style={{ margin: 0 }}>
              {data.usage.how === 'GENERATED' ? 'The app produces this record and its numbered PDF on ' : 'This record is captured on '}
              <Link to={data.usage.route}>{data.usage.screen}</Link>.
            </p>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              {data.kind === 'LIBRARY' ? 'Reference document for the quality system.' : 'Completed copies are kept as attached evidence.'}
            </p>
          )}
          {data.evidenceType && <p className="small" style={{ marginBottom: 0 }}>Required as evidence when approving a source, depending on risk and sourcing path.</p>}
          {data.related.length > 0 && (
            <>
              <h3 style={{ marginTop: 12 }}>Related sheets</h3>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {data.related.map((r) => (
                  <li key={r.id}>
                    <Link to={`/documents/${r.id}`}>{r.number}</Link> <span className="small muted">{r.title}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
      <h2>Revision history</h2>
      <div className="table-wrap">
        <table className="data stack">
          <thead>
            <tr>
              <th>Revision</th>
              <th>Status</th>
              <th>Effective</th>
              <th>Change</th>
              <th>Released</th>
              <th>File</th>
            </tr>
          </thead>
          <tbody>
            {data.revisions.map((r) => (
              <tr key={r.id}>
                <td data-label="Revision">Rev {r.revisionLabel}</td>
                <td data-label="Status">
                  <RevisionStatus r={r} />
                </td>
                <td data-label="Effective">{fmtDate(r.effectiveFrom)}</td>
                <td data-label="Change">{r.changeSummary}</td>
                <td data-label="Released">
                  {r.releasedBy}
                  <div className="small muted">{fmtDateTime(r.releasedAt)}</div>
                </td>
                <td data-label="File">
                  <a href={`/api/files/${r.fileId}`} target="_blank" rel="noreferrer">
                    View
                  </a>{' '}
                  · <a href={`/api/files/${r.fileId}?download=1`}>Download</a>
                  <div className="small muted" title={r.sha256}>
                    {Math.max(1, Math.round(r.byteSize / 1024))} KB · SHA-256 {r.sha256.slice(0, 12)}…
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ReviseDialog
        open={reviseOpen}
        detail={data}
        onClose={() => setReviseOpen(false)}
        onDone={() => {
          setReviseOpen(false);
          reload();
        }}
      />
    </>
  );
}

function ReviseDialog({ open, detail, onClose, onDone }: { open: boolean; detail: DocumentDetail; onClose: () => void; onDone: () => void }) {
  const [label, setLabel] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());
  const [summary, setSummary] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const { busy, run, banner } = useBusy();
  const ready = /^[0-9A-Za-z]{1,6}$/.test(label.trim()) && effectiveFrom && summary.trim().length >= 5 && file;
  return (
    <Dialog
      open={open}
      title={`New revision of ${detail.number}`}
      onClose={onClose}
      footer={
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !ready}
          onClick={() =>
            void run(async () => {
              const form = new FormData();
              form.append('file', file!, file!.name);
              const qs = new URLSearchParams({ revisionLabel: label.trim(), effectiveFrom, changeSummary: summary.trim() });
              await api(`/api/documents/${detail.id}/revisions?${qs.toString()}`, { form });
              setLabel('');
              setSummary('');
              setFile(null);
              onDone();
            })
          }
        >
          Release revision
        </button>
      }
    >
      {banner}
      <div className="field">
        <label htmlFor="rev-label">Revision</label>
        <input id="rev-label" type="text" maxLength={6} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. 04" />
      </div>
      <div className="field">
        <label htmlFor="rev-effective">Effective date</label>
        <input id="rev-effective" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
        <div className="field-hint">Cannot be earlier than the latest recorded revision.</div>
      </div>
      <div className="field">
        <label htmlFor="rev-summary">What changed</label>
        <textarea id="rev-summary" value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={1000} />
      </div>
      <div className="field">
        <label htmlFor="rev-file">PDF file</label>
        <input id="rev-file" type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </div>
    </Dialog>
  );
}
