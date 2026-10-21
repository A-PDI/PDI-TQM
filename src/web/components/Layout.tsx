import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { QuickCapture } from './QuickCapture';

const NAV: Array<{ to: string; label: string; built: boolean; stage?: string; also?: string[] }> = [
  { to: '/', label: 'Home', built: true },
  { to: '/inspections', label: 'Inspections', built: true },
  { to: '/quality', label: 'Quality', built: true },
  { to: '/parts', label: 'Parts & Sources', built: true, also: ['/sourcing', '/sources', '/baselines'] },
  { to: '/suppliers', label: 'Suppliers', built: true },
  { to: '/injectors', label: 'Injectors', built: false, stage: 'Stage 4' },
  { to: '/changes', label: 'Changes', built: false, stage: 'Stage 3' },
  { to: '/reports', label: 'Reports', built: false, stage: 'Stage 4' },
];

export function Layout() {
  const { me, signOut, can } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [q, setQ] = useState('');
  const navigate = useNavigate();
  const location = useLocation();
  useEffect(() => setMenuOpen(false), [location.pathname]);
  const showEnv = me && me.environment !== 'production';

  return (
    <div className="shell">
      <aside className={`sidebar${menuOpen ? ' open' : ''}`}>
        <div className="brand">
          <span className="brand-mark">PDI</span> TQMS
        </div>
        {showEnv && <span className="env-badge">{me.environment.toUpperCase()}</span>}
        <nav aria-label="Main navigation">
          <ul className="nav">
            {NAV.map((n) =>
              n.built ? (
                <li key={n.to}>
                  <NavLink
                    to={n.to}
                    end={n.to === '/'}
                    className={({ isActive }) => (isActive || n.also?.some((a) => location.pathname.startsWith(a)) ? 'active' : '')}
                  >
                    {n.label}
                  </NavLink>
                </li>
              ) : (
                <li key={n.to}>
                  <span className="nav-disabled" aria-disabled="true" title={`Not yet available — planned for ${n.stage}`}>
                    {n.label} <span className="later">{n.stage}</span>
                  </span>
                </li>
              ),
            )}
            {(can('admin.users') || can('admin.system')) && (
              <li style={{ marginTop: 12 }}>
                <NavLink to="/admin">Administration</NavLink>
              </li>
            )}
            <li>
              <NavLink to="/policies">Policy register</NavLink>
            </li>
          </ul>
        </nav>
        <div className="sidebar-foot">Signed in as {me?.user.displayName}</div>
      </aside>
      <div className="main">
        <header className="topbar">
          <button type="button" className="btn btn-small menu-btn" aria-label="Open menu" onClick={() => setMenuOpen((o) => !o)}>
            ☰
          </button>
          <form
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              if (q.trim().length >= 2) navigate(`/search?q=${encodeURIComponent(q.trim())}`);
            }}
          >
            <label htmlFor="global-search" className="sr-only">
              Search
            </label>
            <input id="global-search" type="search" placeholder="Search part, alias, PO, lot, serial, inspection, concern…" value={q} onChange={(e) => setQ(e.target.value)} />
          </form>
          {can('quality.capture') && (
            <button type="button" className="btn btn-small" onClick={() => setCaptureOpen(true)}>
              + Capture
            </button>
          )}
          <span className="user-name small muted">{me?.user.displayName}</span>
          <button type="button" className="btn btn-small" onClick={() => void signOut()}>
            Sign out
          </button>
        </header>
        <main className="content" id="main">
          <Outlet />
        </main>
      </div>
      <QuickCapture open={captureOpen} onClose={() => setCaptureOpen(false)} />
    </div>
  );
}
