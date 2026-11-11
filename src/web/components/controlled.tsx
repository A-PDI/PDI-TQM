import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { ControlledEntity } from '../../shared/controlled-forms';
import { api, fmtDate } from '../api';
import { useBusy } from './sourcing';
import { useLoad } from './ui';

export interface ControlledTypeRow {
  code: string;
  category: 'FORM' | 'ATTACHMENT';
  family: string;
  module: string;
  moduleRoute: string;
  entity: ControlledEntity;
  rationale: string;
  title: string | null;
  revision: { revisionId: string; revisionLabel: string; effectiveFrom: string; fileId: string } | null;
  interactive: boolean | null;
  canPrepare: boolean;
}

export interface ControlledRecordRow {
  id: string;
  number: string;
  typeCode: string;
  category: 'FORM' | 'ATTACHMENT';
  title: string;
  status: string;
  entityType: string;
  entityId: string | null;
  entityLabel: string;
  revisionLabel: string;
  preparedBy: string;
  createdAt: string;
  completedAt: string | null;
  outputFileId: string | null;
}

export const RECORD_STATUS: Record<string, { text: string; cls: string }> = {
  DRAFT: { text: 'Draft', cls: '' },
  SUBMITTED: { text: 'Awaiting approval', cls: 'badge-review' },
  COMPLETED: { text: 'Completed', cls: 'badge-done' },
  VOID: { text: 'Void', cls: '' },
};

export function RecordStatus({ status, category }: { status: string; category?: string }) {
  const s = RECORD_STATUS[status] ?? { text: status, cls: '' };
  const text = status === 'SUBMITTED' && category === 'ATTACHMENT' ? 'Awaiting signatures' : s.text;
  return <span className={`badge ${s.cls}`}>{text}</span>;
}

export const categoryText = (c: string) => (c === 'FORM' ? 'Completed in TQM' : 'Attached document');

/**
 * Controlled documents for one module record: the records opened from it, and the approved revision
 * of each document type that belongs here, ready to start.
 */
export function ControlledFormsPanel({ entity, entityId, title = 'Controlled forms' }: { entity: ControlledEntity; entityId: string | null; title?: string }) {
  const navigate = useNavigate();
  const types = useLoad<{ types: ControlledTypeRow[] }>('/api/controlled/types');
  const query = entity === 'SYSTEM' ? `entityType=SYSTEM` : `entityType=${entity}&entityId=${entityId}`;
  const records = useLoad<ControlledRecordRow[]>(`/api/controlled/records?${query}`);
  const { busy, run, banner } = useBusy();
  const [pick, setPick] = useState('');
  const available = (types.data?.types ?? []).filter((t) => t.entity === entity);
  const startable = available.filter((t) => t.canPrepare && t.revision && (t.category === 'ATTACHMENT' || t.interactive));
  const start = (code: string) =>
    run(async () => {
      const r = await api<{ id: string }>('/api/controlled/records', { body: { typeCode: code, entityId } });
      navigate(`/controlled/${r.id}`);
    });

  return (
    <section className="card" aria-labelledby={`controlled-${entity}`}>
      <h2 id={`controlled-${entity}`}>{title}</h2>
      {banner}
      {records.data && records.data.length > 0 ? (
        <div className="table-wrap" style={{ marginBottom: 10 }}>
          <table className="data stack">
            <thead>
              <tr>
                <th>Record</th>
                <th>Document</th>
                <th>Status</th>
                <th>Output</th>
              </tr>
            </thead>
            <tbody>
              {records.data.map((r) => (
                <tr key={r.id}>
                  <td data-label="Record">
                    <Link to={`/controlled/${r.id}`}>{r.number}</Link>
                    <div className="small muted">
                      {r.preparedBy} · {fmtDate(r.createdAt)}
                    </div>
                  </td>
                  <td data-label="Document">
                    {r.typeCode} {r.title}
                    <div className="small muted">
                      Rev {r.revisionLabel} · {categoryText(r.category)}
                    </div>
                  </td>
                  <td data-label="Status">
                    <RecordStatus status={r.status} category={r.category} />
                  </td>
                  <td data-label="Output">
                    {r.outputFileId ? (
                      <a href={`/api/files/${r.outputFileId}`} target="_blank" rel="noreferrer">
                        Controlled PDF
                      </a>
                    ) : (
                      <span className="muted small">{r.category === 'ATTACHMENT' ? 'Attached document' : '—'}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        records.data && <p className="small muted" style={{ marginTop: 0 }}>No controlled records yet.</p>
      )}
      {available.length > 0 && (
        <div className="row-actions">
          <label htmlFor={`start-${entity}`} className="sr-only">
            Controlled document to start
          </label>
          <select id={`start-${entity}`} style={{ maxWidth: 420 }} value={pick} onChange={(e) => setPick(e.target.value)} disabled={!startable.length}>
            <option value="">{startable.length ? 'Choose a controlled document…' : 'No controlled document can be started here'}</option>
            {startable.map((t) => (
              <option key={t.code} value={t.code}>
                {t.code} {t.title ?? ''} — Rev {t.revision!.revisionLabel}
              </option>
            ))}
          </select>
          <button type="button" className="btn btn-primary" disabled={!pick || busy} onClick={() => void start(pick)}>
            Start
          </button>
          <Link className="small" to="/controlled">
            All controlled documents
          </Link>
        </div>
      )}
      {available.some((t) => !t.revision || (t.category === 'FORM' && t.interactive === false)) && (
        <p className="small muted" style={{ marginBottom: 0 }}>
          Not available here until an approved revision is released in the Document Library:{' '}
          {available
            .filter((t) => !t.revision || (t.category === 'FORM' && t.interactive === false))
            .map((t) => t.code)
            .join(', ')}
          .
        </p>
      )}
    </section>
  );
}
