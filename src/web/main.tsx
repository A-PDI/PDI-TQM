import { type ComponentType, StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { Outlet, RouterProvider, createBrowserRouter } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { Layout } from './components/Layout';
import { Home } from './pages/Home';
import { Inspections } from './pages/Inspections';
import { Login } from './pages/Login';
import './styles.css';

// Larger workspaces load on demand so the first screen stays light on shop-floor devices.
const page = <M extends Record<string, unknown>>(load: () => Promise<M>, name: keyof M) => {
  const Component = lazy(async () => ({ default: (await load())[name] as ComponentType }));
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <Component />
    </Suspense>
  );
};
const workbench = () => import('./pages/Workbench');
const quality = () => import('./pages/Quality');
const master = () => import('./pages/MasterData');
const suppliers = () => import('./pages/Suppliers');
const sourcing = () => import('./pages/Sourcing');
const other = () => import('./pages/Other');
const ncr = () => import('./pages/Ncr');
const concessions = () => import('./pages/Concessions');
const scars = () => import('./pages/Scars');
const commitments = () => import('./pages/Commitments');
const changes = () => import('./pages/Changes');
const forms = () => import('./pages/Forms');

function Gate() {
  const { me, loading } = useAuth();
  if (loading) return <p style={{ padding: 20 }}>Loading…</p>;
  if (!me) return <Login />;
  return <Outlet />;
}

const router = createBrowserRouter([
  {
    element: <Gate />,
    children: [
      {
        element: <Layout />,
        children: [
          { path: '/', element: <Home /> },
          { path: '/inspections', element: <Inspections /> },
          { path: '/inspections/:id', element: page(workbench, 'Workbench') },
          { path: '/quality', element: page(quality, 'QualityList') },
          { path: '/quality/:id', element: page(quality, 'QualityDetail') },
          { path: '/quality/ncrs', element: page(ncr, 'NcrList') },
          { path: '/quality/ncrs/:id', element: page(ncr, 'NcrDetail') },
          { path: '/quality/concessions', element: page(concessions, 'ConcessionList') },
          { path: '/quality/concessions/:id', element: page(concessions, 'ConcessionDetail') },
          { path: '/quality/scars', element: page(scars, 'ScarList') },
          { path: '/quality/scars/:id', element: page(scars, 'ScarDetail') },
          { path: '/commitments', element: page(commitments, 'CommitmentList') },
          { path: '/commitments/:id', element: page(commitments, 'CommitmentDetail') },
          { path: '/changes', element: page(changes, 'ChangeList') },
          { path: '/changes/:id', element: page(changes, 'ChangeDetail') },
          { path: '/forms', element: page(forms, 'FormsList') },
          { path: '/forms/:id', element: page(forms, 'FormEditor') },
          { path: '/parts', element: page(master, 'PartsList') },
          { path: '/parts/:id', element: page(master, 'PartDetail') },
          { path: '/suppliers', element: page(suppliers, 'SuppliersList') },
          { path: '/suppliers/:id', element: page(suppliers, 'SupplierDetail') },
          { path: '/sourcing', element: page(sourcing, 'SourcingList') },
          { path: '/sourcing/:id', element: page(sourcing, 'SourcingDetail') },
          { path: '/sources', element: page(master, 'SourcesList') },
          { path: '/sources/:id', element: page(() => import('./pages/Source'), 'Source') },
          { path: '/baselines/:id', element: page(() => import('./pages/Baseline'), 'Baseline') },
          { path: '/search', element: page(other, 'Search') },
          { path: '/policies', element: page(other, 'Policies') },
          { path: '/admin', element: page(other, 'Admin') },
          { path: '*', element: page(other, 'NotFound') },
        ],
      },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  </StrictMode>,
);
