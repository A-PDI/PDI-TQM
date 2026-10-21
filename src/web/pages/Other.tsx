import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, fmtDateTime } from '../api';
import { useAuth } from '../auth';
import { LoadState, StatusBadge, useLoad } from '../components/ui';

interface SearchData {
  parts: Array<{ id: string; partNumber: string; description: string }>;
  inspections: Array<{ id: string; number: string; partNumber: string; poNumber: string | null; lotNumber: string | null; status: string }>;
  suppliers: Array<{ id: string; code: string; legalName: string }>;
  qualityEvents: Array<{ id: string; number: string; title: string; status: string }>;
}

export function Search() {
  const [params] = useSearchParams();
  const q = params.get('q') ?? '';
  const { data, error, loading } = useLoad<SearchData>(q.length >= 2 ? `/api/search?q=${encodeURIComponent(q)}` : null);
  const total = data ? data.parts.length + data.inspections.length + data.suppliers.length + data.qualityEvents.length : 0;
  return (
    <>
      <h1>Search: “{q}”</h1>
      <LoadState loading={loading && !data} error={error} />
      {data && total === 0 && <div className="empty card">Nothing matched. Try a part number, OE alias, PO, lot, serial or record number.</div>}
      {data && data.parts.length > 0 && (
        <section className="card">
          <h2>Parts</h2>
          <ul>
            {data.parts.map((p) => (
              <li key={p.id}>
                <Link to={`/parts/${p.id}`}>{p.partNumber}</Link> — {p.description}
              </li>
            ))}
          </ul>
        </section>
      )}
      {data && data.inspections.length > 0 && (
        <section className="card">
          <h2>Inspections</h2>
          <ul>
            {data.inspections.map((i) => (
              <li key={i.id}>
                <Link to={`/inspections/${i.id}`}>{i.number}</Link> {i.partNumber} · PO {i.poNumber ?? '—'} · Lot {i.lotNumber ?? '—'} <StatusBadge status={i.status} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {data && data.suppliers.length > 0 && (
        <section className="card">
          <h2>Suppliers</h2>
          <ul>
            {data.suppliers.map((s) => (
              <li key={s.id}>
                <Link to={`/suppliers/${s.id}`}>{s.legalName}</Link> <span className="muted small">{s.code}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {data && data.qualityEvents.length > 0 && (
        <section className="card">
          <h2>Quality concerns</h2>
          <ul>
            {data.qualityEvents.map((e) => (
              <li key={e.id}>
                <Link to={`/quality/${e.id}`}>{e.number}</Link> {e.title} <StatusBadge status={e.status} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

export function Policies() {
  const { data, error, loading } = useLoad<Array<{ code: string; area: string; title: string; status: string; interimBehavior: string; owner: string | null; decision: string | null }>>(
    '/api/admin/policies',
  );
  return (
    <>
      <h1>Policy register</h1>
      <p className="muted small">
        Business decisions PDI must sign. Open items do not block synthetic staging work but block consequential production use.
      </p>
      <LoadState loading={loading && !data} error={error} />
      {data && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Code</th>
                <th>Area</th>
                <th>Decision needed</th>
                <th>Status</th>
                <th>Interim system behavior</th>
              </tr>
            </thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.code}>
                  <td>{p.code}</td>
                  <td>{p.area}</td>
                  <td>{p.title}</td>
                  <td>
                    <span className="badge badge-review">{p.status.replace('_', ' ')}</span>
                  </td>
                  <td className="small">{p.interimBehavior}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

interface AdminUsers {
  users: Array<{ id: string; email: string; displayName: string; active: boolean; grants: Array<{ id: string; capability: string }> }>;
  capabilities: Record<string, { description: string; sensitive: boolean }>;
  bundles: Record<string, { label: string; capabilities: string[] }>;
}

export function Admin() {
  const { can, me } = useAuth();
  const [tab, setTab] = useState<'users' | 'forms' | 'system'>(can('admin.users') ? 'users' : 'forms');
  return (
    <>
      <h1>Administration</h1>
      <div className="row-actions" role="tablist" style={{ margin: '10px 0' }}>
        {can('admin.users') && (
          <button type="button" role="tab" aria-selected={tab === 'users'} className={`btn btn-small${tab === 'users' ? ' btn-primary' : ''}`} onClick={() => setTab('users')}>
            Users &amp; authority
          </button>
        )}
        <button type="button" role="tab" aria-selected={tab === 'forms'} className={`btn btn-small${tab === 'forms' ? ' btn-primary' : ''}`} onClick={() => setTab('forms')}>
          Inspection forms
        </button>
        {can('admin.system') && (
          <button type="button" role="tab" aria-selected={tab === 'system'} className={`btn btn-small${tab === 'system' ? ' btn-primary' : ''}`} onClick={() => setTab('system')}>
            System health
          </button>
        )}
      </div>
      {tab === 'users' && can('admin.users') && <UsersAdmin selfId={me!.user.id} />}
      {tab === 'forms' && <FormsAdmin />}
      {tab === 'system' && can('admin.system') && <SystemAdmin />}
    </>
  );
}

function UsersAdmin({ selfId }: { selfId: string }) {
  const { data, error, loading, reload } = useLoad<AdminUsers>('/api/admin/users');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [newUser, setNewUser] = useState({ email: '', displayName: '', temporaryPassword: '' });
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: ok });
      reload();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    }
  };
  if (!data) return <LoadState loading={loading} error={error} />;
  return (
    <>
      {msg && <div className={`notice ${msg.ok ? 'notice-ok' : 'notice-error'}`} role={msg.ok ? 'status' : 'alert'}>{msg.text}</div>}
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>User</th>
              <th>Authority grants</th>
              <th>Grant role bundle</th>
            </tr>
          </thead>
          <tbody>
            {data.users.map((u) => (
              <tr key={u.id}>
                <td>
                  {u.displayName}
                  <div className="small muted">{u.email}</div>
                  {!u.active && <span className="badge">inactive</span>}
                </td>
                <td className="small">
                  {u.grants.length === 0 && <span className="muted">None</span>}
                  {u.grants.map((g) => (
                    <span key={g.id} className="badge" style={{ margin: '0 4px 4px 0' }} title={data.capabilities[g.capability]?.description}>
                      {g.capability}
                      {u.id !== selfId && (
                        <button
                          type="button"
                          className="btn-link"
                          aria-label={`Revoke ${g.capability} from ${u.displayName}`}
                          style={{ marginLeft: 4 }}
                          onClick={() => {
                            const reason = window.prompt(`Reason for revoking ${g.capability}?`);
                            if (reason) void act(() => api(`/api/admin/grants/${g.id}/revoke`, { body: { reason } }), 'Grant revoked');
                          }}
                        >
                          ×
                        </button>
                      )}
                    </span>
                  ))}
                </td>
                <td>
                  {u.id === selfId ? (
                    <span className="small muted">Your own authority is managed by another administrator.</span>
                  ) : (
                    <select
                      aria-label={`Grant bundle to ${u.displayName}`}
                      value=""
                      onChange={(e) => {
                        const b = data.bundles[e.target.value];
                        if (!b) return;
                        const reason = window.prompt(`Reason for granting ${b.label} to ${u.displayName}?`);
                        if (reason) void act(() => api(`/api/admin/users/${u.id}/grants`, { body: { capabilities: b.capabilities, reason } }), `${b.label} granted`);
                      }}
                    >
                      <option value="">Grant…</option>
                      {Object.entries(data.bundles).map(([k, b]) => (
                        <option key={k} value={k}>
                          {b.label}
                        </option>
                      ))}
                    </select>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <form
        className="card"
        style={{ marginTop: 14 }}
        onSubmit={(e) => {
          e.preventDefault();
          void act(() => api('/api/admin/users', { body: newUser }), `User ${newUser.email} created`).then(() =>
            setNewUser({ email: '', displayName: '', temporaryPassword: '' }),
          );
        }}
      >
        <h2>Add user</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10 }}>
          <div className="field">
            <label htmlFor="nu-name">Name</label>
            <input id="nu-name" type="text" required value={newUser.displayName} onChange={(e) => setNewUser({ ...newUser, displayName: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="nu-email">Email</label>
            <input id="nu-email" type="email" required value={newUser.email} onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="nu-pw">Temporary password (12+ characters)</label>
            <input id="nu-pw" type="password" required minLength={12} value={newUser.temporaryPassword} onChange={(e) => setNewUser({ ...newUser, temporaryPassword: e.target.value })} />
          </div>
        </div>
        <button type="submit" className="btn btn-primary">
          Create user
        </button>
      </form>
    </>
  );
}

function FormsAdmin() {
  const { data, error, loading } = useLoad<Array<{ revisionId: string; formNumber: string; component: string; revisionLabel: string | null; status: string; provenance: string; inspectionCount: number; sha256: string }>>(
    '/api/forms?all=1',
  );
  return (
    <>
      <p className="small muted">
        Controlled inspection forms from Appendix A v1.0. Released revisions are immutable; completed inspections keep their frozen copy. A structured revision editor with review and
        publish is planned for Stage 3.
      </p>
      <LoadState loading={loading && !data} error={error} />
      {data && (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Form</th>
                <th>Revision</th>
                <th>Status</th>
                <th>Inspections</th>
                <th>Provenance</th>
              </tr>
            </thead>
            <tbody>
              {data.map((f) => (
                <tr key={f.revisionId}>
                  <td>
                    {f.formNumber} — {f.component}
                  </td>
                  <td>{f.revisionLabel ?? 'Initial issue'}</td>
                  <td>
                    <StatusBadge status={f.status} />
                  </td>
                  <td>{f.inspectionCount}</td>
                  <td className="small muted">{f.provenance}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function SystemAdmin() {
  const { data, error, loading } = useLoad<{
    storage: { ok: boolean; reason: string | null; freeBytes: number | null };
    jobs: Array<{ id: string; kind: string; status: string; attempts: number; lastError: string | null; createdAt: string }>;
    audits: Array<{ id: string; occurredAt: string; action: string; outcome: string; summary: string; actor: string | null }>;
  }>('/api/admin/system');
  if (!data) return <LoadState loading={loading} error={error} />;
  return (
    <>
      <div className={`notice ${data.storage.ok ? 'notice-ok' : 'notice-error'}`}>
        Evidence storage: {data.storage.ok ? 'ready' : data.storage.reason}
        {data.storage.freeBytes !== null && ` · ${(data.storage.freeBytes / 1024 / 1024 / 1024).toFixed(1)} GB free`}
      </div>
      <section className="card">
        <h2>Background jobs</h2>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Job</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Last error</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {data.jobs.map((j) => (
                <tr key={j.id}>
                  <td>{j.kind}</td>
                  <td>{j.status}</td>
                  <td>{j.attempts}</td>
                  <td className="small">{j.lastError ?? '—'}</td>
                  <td className="small">{fmtDateTime(j.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <h2>Audit trail (latest 100)</h2>
        <ul style={{ paddingLeft: 18 }}>
          {data.audits.map((a) => (
            <li key={a.id} className="small">
              {fmtDateTime(a.occurredAt)} — {a.actor ?? 'System'} — {a.action} {a.outcome !== 'SUCCESS' && <strong>({a.outcome})</strong>}: {a.summary}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

export function NotFound() {
  return (
    <div className="card">
      <h1>Page not found</h1>
      <p>
        This address does not match a TQMS page. <Link to="/">Go to My Work</Link>.
      </p>
    </div>
  );
}
