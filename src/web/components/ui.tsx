import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';

export function OutcomeBadge({ outcome }: { outcome: string | null | undefined }) {
  if (!outcome) return <span className="badge">Not determined</span>;
  const cls = outcome === 'PASS' ? 'badge-pass' : outcome === 'FAIL' ? 'badge-fail' : 'badge-accepted';
  return <span className={`badge ${cls}`}>{outcome}</span>;
}

const STATUS_TEXT: Record<string, string> = {
  DRAFT: 'Draft',
  PARTIAL: 'Partially complete',
  READY_FOR_REVIEW: 'Pending review',
  COMPLETED: 'Completed',
  VOID: 'Void',
  CAPTURED: 'Awaiting triage',
  TRIAGED: 'Owned',
  NONCONFIRMED: 'Not confirmed',
  INFORMATIONAL: 'Informational',
  CONFIRMED_NCR: 'NCR',
  NOT_APPROVED: 'Not approved',
  RELEASED: 'Released',
  SUPERSEDED: 'Superseded',
  OBSOLETE: 'Obsolete',
};

export function StatusBadge({ status }: { status: string }) {
  const cls = status === 'READY_FOR_REVIEW' || status === 'CAPTURED' ? 'badge-review' : status === 'COMPLETED' || status === 'RELEASED' ? 'badge-done' : '';
  return <span className={`badge ${cls}`}>{STATUS_TEXT[status] ?? status.replaceAll('_', ' ').toLowerCase()}</span>;
}

export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
      // showModal() moves focus to the first focusable element (the close button); start on the first field instead.
      const first = el.querySelector<HTMLElement>('[data-autofocus], .dialog-body :is(input, select, textarea):not([disabled]):not([type="hidden"])');
      first?.focus();
    }
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog ref={ref} aria-labelledby={titleId} onClose={onClose} onCancel={onClose}>
      {open && (
        <>
          <div className="dialog-head">
            <h2 id={titleId} style={{ margin: 0 }}>
              {title}
            </h2>
            <button type="button" className="btn btn-small" onClick={onClose} aria-label="Close dialog">
              ✕
            </button>
          </div>
          <div className="dialog-body">{children}</div>
          {footer && <div className="dialog-foot">{footer}</div>}
        </>
      )}
    </dialog>
  );
}

export function useLoad<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    const ctrl = new AbortController();
    setLoading(true);
    api<T>(path, { signal: ctrl.signal })
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setError(e.message);
      })
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [path, tick, ...deps]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload, setData };
}

export function LoadState({ loading, error }: { loading: boolean; error: string | null }) {
  if (error) return <div className="notice notice-error" role="alert">{error}</div>;
  if (loading) return <p className="muted" aria-live="polite">Loading…</p>;
  return null;
}

export interface PartOption {
  id: string;
  partNumber: string;
  description: string;
  defaultFormNumber: string | null;
  aliases: string | null;
}

export function PartTypeahead({ value, onSelect, autoFocus }: { value: PartOption | null; onSelect: (p: PartOption | null) => void; autoFocus?: boolean }) {
  const [text, setText] = useState(value ? value.partNumber : '');
  const [options, setOptions] = useState<PartOption[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  useEffect(() => {
    if (!text.trim() || (value && text === value.partNumber)) {
      setOptions([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      api<PartOption[]>(`/api/parts?q=${encodeURIComponent(text)}`, { signal: ctrl.signal })
        .then((o) => {
          setOptions(o);
          setActive(0);
          setOpen(true);
        })
        .catch(() => undefined);
    }, 150);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [text, value]);
  const choose = (p: PartOption) => {
    onSelect(p);
    setText(p.partNumber);
    setOpen(false);
  };
  return (
    <div className="typeahead">
      <input
        id="part-number"
        type="text"
        role="combobox"
        aria-expanded={open && options.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        autoFocus={autoFocus}
        data-autofocus={autoFocus || undefined}
        placeholder="Type part number, OE alias or description"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (value) onSelect(null);
        }}
        onKeyDown={(e) => {
          if (!open || !options.length) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, options.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === 'Enter') {
            e.preventDefault();
            choose(options[active]!);
          } else if (e.key === 'Escape') setOpen(false);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && options.length > 0 && (
        <ul id={listId} role="listbox">
          {options.map((p, i) => (
            <li key={p.id} role="option" aria-selected={i === active} onMouseDown={() => choose(p)}>
              <strong>{p.partNumber}</strong> — {p.description}
              {p.aliases && <div className="small muted">Also: {p.aliases}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
