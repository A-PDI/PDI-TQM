import { useState } from 'react';
import { Link } from 'react-router-dom';
import { type EffectiveSourceStatus, type GateResult, SOURCE_STATUS_TEXT } from '../../shared/sourcing';
import { api } from '../api';

export interface FileRef {
  linkId?: string;
  fileId: string;
  name: string | null;
  sha256?: string;
}

export function FileLinks({ files, canRemove, onChanged }: { files: FileRef[]; canRemove?: boolean; onChanged?: () => void }) {
  if (!files.length) return <span className="muted small">No files</span>;
  return (
    <span className="small">
      {files.map((f, i) => (
        <span key={f.fileId} style={{ marginRight: 8 }}>
          <a href={`/api/files/${f.fileId}`} target="_blank" rel="noopener noreferrer">
            {f.name ?? `File ${i + 1}`}
          </a>
          {f.sha256 && <span className="muted"> ({f.sha256.slice(0, 8)})</span>}
          {canRemove && f.linkId && (
            <button
              type="button"
              className="btn-link"
              aria-label={`Remove ${f.name ?? 'file'}`}
              style={{ marginLeft: 4 }}
              onClick={async () => {
                await api(`/api/evidence/links/${f.linkId}`, { method: 'DELETE' });
                onChanged?.();
              }}
            >
              ×
            </button>
          )}
        </span>
      ))}
    </span>
  );
}

/** Uploads a PDF or image as evidence on a record; the server validates type and content. */
export function UploadEvidence({ entityType, entityId, label = '+ Attach file', onUploaded }: { entityType: string; entityId: string; label?: string; onUploaded: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span>
      <label className="btn btn-small photo-btn" style={{ margin: 0 }}>
        {busy ? 'Uploading…' : label}
        <input
          type="file"
          accept="application/pdf,image/jpeg,image/png,image/webp"
          aria-label={label.replace('+ ', '')}
          disabled={busy}
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (!file) return;
            setBusy(true);
            setError(null);
            try {
              const form = new FormData();
              form.append('file', file, file.name);
              await api(`/api/evidence/${entityType}/${entityId}`, { form });
              onUploaded();
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        />
      </label>
      {error && (
        <span className="field-error" role="alert" style={{ display: 'block' }}>
          {error}
        </span>
      )}
    </span>
  );
}

export function SourceStatusBadge({ status }: { status: EffectiveSourceStatus | undefined }) {
  if (!status) return null;
  const cls = status === 'APPROVED' ? 'badge-pass' : status === 'APPROVED_CONDITIONAL' || status === 'IN_REVIEW' ? 'badge-accepted' : status === 'NOT_APPROVED' ? '' : 'badge-fail';
  return <span className={`badge ${cls}`}>{SOURCE_STATUS_TEXT[status]}</span>;
}

const QUAL_TEXT: Record<string, string> = {
  QUALIFIED: 'Qualified',
  CONDITIONALLY_QUALIFIED: 'Conditionally qualified',
  REJECTED: 'Rejected',
  EXPIRED: 'Qualification expired',
  UNDER_REVIEW: 'Assessment under review',
  NOT_ASSESSED: 'Not assessed',
};

export function QualificationBadge({ status }: { status: string | undefined }) {
  if (!status) return null;
  const cls = status === 'QUALIFIED' ? 'badge-pass' : status === 'CONDITIONALLY_QUALIFIED' || status === 'UNDER_REVIEW' ? 'badge-accepted' : status === 'NOT_ASSESSED' ? '' : 'badge-fail';
  return <span className={`badge ${cls}`}>{QUAL_TEXT[status] ?? status}</span>;
}

const GATE_ICON: Record<GateResult['status'], { text: string; cls: string }> = {
  PASS: { text: 'Met', cls: 'badge-pass' },
  FAIL: { text: 'Not met', cls: 'badge-fail' },
  WARN: { text: 'Conditional', cls: 'badge-accepted' },
  NOT_APPLICABLE: { text: 'Not applicable', cls: '' },
};

/** Every approval gate with its evidence and where to resolve it (FR-036). */
export function GateList({ gates }: { gates: GateResult[] }) {
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {gates.map((g) => (
        <li key={g.code} style={{ padding: '8px 0', borderTop: '1px solid var(--border)', display: 'grid', gridTemplateColumns: '120px 1fr', gap: 10 }}>
          <span>
            <span className={`badge ${GATE_ICON[g.status].cls}`}>{GATE_ICON[g.status].text}</span>
          </span>
          <span>
            <strong>{g.label}</strong>
            <div className="small">{g.detail}</div>
            {g.status === 'FAIL' && g.link && (
              <Link className="small" to={g.link}>
                Resolve →
              </Link>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function useBusy() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
      if (ok) setMessage({ ok: true, text: ok });
      return true;
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
      return false;
    } finally {
      setBusy(false);
    }
  };
  const banner = message ? (
    <div className={`notice ${message.ok ? 'notice-ok' : 'notice-error'}`} role={message.ok ? 'status' : 'alert'}>
      {message.text}
    </div>
  ) : null;
  return { busy, run, banner, setMessage };
}
