import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, api } from '../api';
import { Dialog, type PartOption, PartTypeahead, useLoad } from './ui';

export function QuickCapture({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [part, setPart] = useState<PartOption | null>(null);
  const [ownerId, setOwnerId] = useState('');
  const [poNumber, setPoNumber] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const owners = useLoad<Array<{ id: string; displayName: string }>>(open ? '/api/users/directory?capability=quality.triage' : null);

  const reset = () => {
    setTitle('');
    setDescription('');
    setPart(null);
    setOwnerId('');
    setPoNumber('');
    setError(null);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await api<{ id: string; number: string }>('/api/quality/events', {
        body: { title, description, partId: part?.id ?? null, ownerId: ownerId || null, poNumber: poNumber || null },
      });
      reset();
      onClose();
      navigate(`/quality/${created.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the concern');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      title="Record a concern"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" disabled={busy || title.trim().length < 3 || description.trim().length < 3} onClick={() => void submit()}>
            Save concern
          </button>
        </>
      }
    >
      <p className="small muted" style={{ marginTop: 0 }}>
        Capture it now; details and formal action can follow after triage.
      </p>
      <div className="field">
        <label htmlFor="qc-title">Topic</label>
        <input id="qc-title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
      </div>
      <div className="field">
        <label htmlFor="qc-desc">What happened</label>
        <textarea id="qc-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} />
      </div>
      <div className="field">
        <label htmlFor="part-number">Part (optional)</label>
        <PartTypeahead value={part} onSelect={setPart} />
      </div>
      <div className="field">
        <label htmlFor="qc-po">PO (optional)</label>
        <input id="qc-po" type="text" value={poNumber} onChange={(e) => setPoNumber(e.target.value)} maxLength={60} />
      </div>
      <div className="field">
        <label htmlFor="qc-owner">Suggested owner (optional)</label>
        <select id="qc-owner" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
          <option value="">Unassigned — quality triage queue</option>
          {owners.data?.map((o) => (
            <option key={o.id} value={o.id}>
              {o.displayName}
            </option>
          ))}
        </select>
      </div>
      {error && (
        <div className="notice notice-error" role="alert">
          {error}
        </div>
      )}
    </Dialog>
  );
}
