import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Outlet, RouterProvider, createBrowserRouter } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { Layout } from './components/Layout';
import { Home } from './pages/Home';
import { Inspections } from './pages/Inspections';
import { Login } from './pages/Login';
import { PartDetail, PartsList, SupplierDetail, SuppliersList } from './pages/MasterData';
import { Admin, NotFound, Policies, Search } from './pages/Other';
import { QualityDetail, QualityList } from './pages/Quality';
import { Workbench } from './pages/Workbench';
import './styles.css';

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
          { path: '/inspections/:id', element: <Workbench /> },
          { path: '/quality', element: <QualityList /> },
          { path: '/quality/:id', element: <QualityDetail /> },
          { path: '/parts', element: <PartsList /> },
          { path: '/parts/:id', element: <PartDetail /> },
          { path: '/suppliers', element: <SuppliersList /> },
          { path: '/suppliers/:id', element: <SupplierDetail /> },
          { path: '/search', element: <Search /> },
          { path: '/policies', element: <Policies /> },
          { path: '/admin', element: <Admin /> },
          { path: '*', element: <NotFound /> },
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
