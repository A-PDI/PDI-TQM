import { type ReactNode, useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { api, fmtDateTime } from '../api';
import { useLoad } from './ui';

export function QualityTabs() {
  const cls = ({ isActive }: { isActive: boolean }) => `btn btn-small${isActive ? ' btn-primary' : ''}`;
  return (
    <div className="row-actions" role="navigation" aria-label="Quality sections" style={{ marginBottom: 12 }}>
      <NavLink to="/quality" end className={cls}>
        Concerns
      </NavLink>
      <NavLink to="/quality/ncrs" className={cls}>
        NCRs
      </NavLink>
      <NavLink to="/quality/concessions" className={cls}>
        Concessions
      </NavLink>
      <NavLink to="/quality/scars" className={cls}>
        SCARs
      </NavLink>
    </div>
  );
}

export interface HistoryRow {
  occurredAt: string;
  action: string;
  outcome: string;
  summary: string;
  reason: string | null;
  actor: string | null;
}

export function HistoryCard({ history }: { history: HistoryRow[] }) {
  return (
    <section className="card" aria-labelledby="history-h">
      <h2 id="history-h">History</h2>
      {history.length === 0 ? (
        <p className="muted small">No events yet.</p>
      ) : (
        <ul style={{ paddingLeft: 18, margin: 0 }}>
          {history.map((h, i) => (
            <li key={i} className="small">
              {fmtDateTime(h.occurredAt)} — {h.actor ?? 'System'}: {h.summary}
              {h.outcome !== 'SUCCESS' ? <strong> ({h.outcome.toLowerCase()})</strong> : null}
              {h.reason ? ` — ${h.reason}` : ''}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export interface Rendition {
  edition: number;
  fileId: string | null;
  sha256: string | null;
  pageCount: number | null;
  createdAt: string;
}

/** Controlled PDF editions of a record; each issue freezes a new numbered edition. */
export function RecordPdfs({ renditions, issueUrl, docCode, canIssue, onIssued }: { renditions: Rendition[]; issueUrl: string; docCode: string; canIssue: boolean; onIssued: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="row-actions small">
      {renditions.map((r) =>
        r.fileId ? (
          <a key={r.edition} href={`/api/files/${r.fileId}`} target="_blank" rel="noopener noreferrer">
            {docCode} edition {r.edition} PDF ({r.pageCount} page{r.pageCount === 1 ? '' : 's'})
          </a>
        ) : (
          <span key={r.edition} className="muted">
            Edition {r.edition} rendering…
          </span>
        ),
      )}
      {canIssue && (
        <button
          type="button"
          className="btn btn-small"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await api(issueUrl, { method: 'POST' });
              onIssued();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Issuing…' : `Issue ${docCode} PDF edition`}
        </button>
      )}
      {error && <span className="field-error">{error}</span>}
    </div>
  );
}

export function useDirectory(capability?: string) {
  return useLoad<Array<{ id: string; displayName: string }>>(`/api/users/directory${capability ? `?capability=${encodeURIComponent(capability)}` : ''}`).data ?? [];
}

export function UserSelect({ id, label, value, onChange, users, required = true }: { id: string; label: string; value: string; onChange: (v: string) => void; users: Array<{ id: string; displayName: string }>; required?: boolean }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} required={required}>
        <option value="">Select…</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.displayName}
          </option>
        ))}
      </select>
    </div>
  );
}

const TONES: Record<string, string> = {
  CLOSED: 'badge-done',
  VERIFIED: 'badge-pass',
  VERIFIED_RESOLVED: 'badge-pass',
  RELEASED: 'badge-pass',
  IMPLEMENTATION_VERIFIED: 'badge-pass',
  EFFECTIVENESS_VERIFIED: 'badge-pass',
  APPROVED: 'badge-pass',
  CURRENT: 'badge-pass',
  DONE: 'badge-pass',
  OPEN: 'badge-review',
  ON_HOLD: 'badge-fail',
  ISSUED: 'badge-review',
  REQUESTED: 'badge-review',
  PROPOSED: 'badge-review',
  EXPIRED: 'badge-fail',
  EXHAUSTED: 'badge-fail',
  REJECTED: 'badge-fail',
  CANCELLED: '',
  WITHDRAWN: '',
};

export function StateBadge({ state, text }: { state: string; text?: string }) {
  return <span className={`badge ${TONES[state] ?? 'badge-accepted'}`}>{text ?? state.replaceAll('_', ' ').toLowerCase()}</span>;
}

export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const addDays = (n: number) => {
  const d = new Date(Date.now() + n * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export interface QualityContext {
  ncrs: Array<{ id: string; number: string; title: string; status: string; severity: string; lotNumber: string | null }>;
  scars: Array<{ id: string; number: string; title: string; status: string; cycle: number }>;
  concessions: Array<{ id: string; number: string; status: string; lotNumber: string; validUntil: string; characteristic: string; current: boolean }>;
  changes: Array<{ id: string; number: string; title: string; status: string; requalificationRequired: boolean | null }>;
  commitments: Array<{ id: string; number: string; promisedAction: string; status: string; dueDate: string | null; representative: string; overdue: boolean }>;
}

/** Open issues, deviations, changes and promises related to a source, supplier or part (FR-016, FR-076). */
export function QualityContextCard({ context, actions }: { context: QualityContext; actions?: ReactNode }) {
  const open = (s: string) => !['CLOSED', 'VERIFIED', 'CANCELLED', 'REJECTED', 'WITHDRAWN', 'IMPLEMENTATION_VERIFIED'].includes(s);
  const sections: Array<[string, ReactNode[]]> = [
    [
      'Nonconformances',
      context.ncrs.map((n) => (
        <li key={n.id}>
          <Link to={`/quality/ncrs/${n.id}`}>{n.number}</Link> — {n.title} ({n.severity.toLowerCase()}, lot {n.lotNumber ?? '—'}) <StateBadge state={n.status} />
        </li>
      )),
    ],
    [
      'SCARs',
      context.scars.map((s) => (
        <li key={s.id}>
          <Link to={`/quality/scars/${s.id}`}>{s.number}</Link> — {s.title}
          {s.cycle > 1 ? ` (cycle ${s.cycle})` : ''} <StateBadge state={s.status} />
        </li>
      )),
    ],
    [
      'Concessions',
      context.concessions.map((c) => (
        <li key={c.id}>
          <Link to={`/quality/concessions/${c.id}`}>{c.number}</Link> — {c.characteristic}, lot {c.lotNumber}, until {c.validUntil} <StateBadge state={c.current ? 'CURRENT' : c.status} text={c.current ? 'current' : undefined} />
        </li>
      )),
    ],
    [
      'Changes',
      context.changes.map((c) => (
        <li key={c.id}>
          <Link to={`/changes/${c.id}`}>{c.number}</Link> — {c.title}
          {c.requalificationRequired ? ' · requalification required' : ''} <StateBadge state={c.status} />
        </li>
      )),
    ],
    [
      'Supplier commitments',
      context.commitments.map((c) => (
        <li key={c.id}>
          <Link to={`/commitments/${c.id}`}>{c.number}</Link> — {c.promisedAction} ({c.representative}
          {c.dueDate ? `, due ${c.dueDate}` : ''}) <StateBadge state={c.status} /> {c.overdue && <span className="badge badge-fail">overdue</span>}
        </li>
      )),
    ],
  ];
  const openCount = context.ncrs.filter((n) => open(n.status)).length + context.scars.filter((s) => open(s.status)).length + context.commitments.filter((c) => open(c.status)).length;
  return (
    <section className="card" aria-labelledby="qc-h">
      <div className="page-head" style={{ marginBottom: 6 }}>
        <h2 id="qc-h">Quality, changes and commitments</h2>
        <div className="row-actions">
          {openCount > 0 && <span className="badge badge-review">{openCount} open</span>}
          {actions}
        </div>
      </div>
      {sections.every(([, items]) => items.length === 0) ? (
        <p className="small muted">No nonconformances, SCARs, concessions, changes or supplier commitments recorded.</p>
      ) : (
        sections
          .filter(([, items]) => items.length)
          .map(([title, items]) => (
            <div key={title}>
              <h3 style={{ marginTop: 8 }}>{title}</h3>
              <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                {items}
              </ul>
            </div>
          ))
      )}
    </section>
  );
}
