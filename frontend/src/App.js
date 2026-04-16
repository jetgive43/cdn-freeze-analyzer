import React, { useState } from 'react';
import {
  BrowserRouter as Router,
  Routes,
  Route,
  Navigate,
  Outlet,
  NavLink,
} from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import StatusTable from './components/StatusTable';
import HistoryPanel from './components/HistoryPanel';
import BandwidthDashboard from './components/BandwidthDashboard';
import ErrorLogs from './components/ErrorLogs';
import PortsPanel from './components/PortsPanel';
import ServerPingPanel from './components/ServerPingPanel';
import ServerMtrPanel from './components/ServerMtrPanel';
import VerifyEmailPage from './components/VerifyEmailPage';
import GroupManagementPanel from './components/GroupManagementPanel';
import BusinessServersPanel from './components/BusinessServersPanel';
import PublicHomePage from './pages/PublicHomePage';
import PublicServerPingPage from './pages/PublicServerPingPage';
import ProfilePage from './pages/ProfilePage';
import ForgotPasswordPage from './pages/ForgotPasswordPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import UserAccountMenu from './components/UserAccountMenu';
import './App.css';

const ADMIN_HEADER_NAV = [
  { to: '/admin/business-servers', label: 'Business servers' },
  { to: '/admin/dashboard', label: 'TTL' },
  { to: '/admin/ports', label: 'Proxy ports' },
  { to: '/admin/history', label: 'History' },
  { to: '/admin/bandwidth', label: 'Traffic' },
  { to: '/admin/errors', label: 'Logs' },
  { to: '/admin/server-ping', label: 'Server ping' },
  { to: '/admin/server-mtr', label: 'MTR path' },
  { to: '/admin/groups', label: 'Groups' },
];

function AdminHeaderTabs() {
  return (
    <nav className="app-header-tabs" aria-label="Admin sections">
      {ADMIN_HEADER_NAV.map(({ to, label }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) => `app-header-tab${isActive ? ' app-header-tab--active' : ''}`}
        >
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

const Layout = () => {
  const { user } = useAuth();
  const [adminToolbarExtra, setAdminToolbarExtra] = useState(null);
  return (
    <div className="App">
      <div className="main-content main-content-admin">
        <main className={`content-area${user ? ' content-area-stacked' : ''}`}>
          {user ? (
            <>
              <header className="app-session-bar app-session-bar--with-tabs">
                <div className="app-session-bar-inner">
                  <AdminHeaderTabs />
                  <div className="app-session-bar-trailing">
                    {adminToolbarExtra}
                    <UserAccountMenu layout="admin" />
                  </div>
                </div>
              </header>
              <div className="content-area-scroll">
                <Outlet context={{ setAdminToolbarExtra }} />
              </div>
            </>
          ) : (
            <Outlet />
          )}
        </main>
      </div>
    </div>
  );
};

function AdminLayoutGuard() {
  const { user, loadingMe, token } = useAuth();
  if (loadingMe && token) {
    return (
      <div className="app-solo-loading">
        <span className="server-ping-readonly-text">Loading…</span>
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  if (user.role !== 'admin') {
    return <Navigate to="/server-ping" replace />;
  }
  return <Layout />;
}

/** Sign-in page; never shows the form when already authenticated. */
function LoginPageGate() {
  const { user, loadingMe, token } = useAuth();
  if (loadingMe && token) {
    return (
      <div className="app-solo-loading">
        <span className="server-ping-readonly-text">Loading…</span>
      </div>
    );
  }
  if (user) {
    return <Navigate to={user.role === 'admin' ? '/admin/business-servers' : '/'} replace />;
  }
  return <PublicHomePage />;
}

function PrivatePingGate({ children }) {
  const { user, loadingMe, token } = useAuth();
  if (loadingMe && token) {
    return (
      <div className="app-solo-loading">
        <span className="server-ping-readonly-text">Loading…</span>
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  return children;
}

/** MTR is admin-only; /server-mtr keeps bookmarks from breaking. */
function SoloMtrRedirect() {
  const { user } = useAuth();
  if (user?.role === 'admin') {
    return <Navigate to="/admin/server-mtr" replace />;
  }
  return <Navigate to="/" replace />;
}

function AdminServerPingPage() {
  const { user } = useAuth();
  return <ServerPingPanel hideSessionChrome={!!user} />;
}

function AdminServerMtrPage() {
  const { user } = useAuth();
  return <ServerMtrPanel hideSessionChrome={!!user} />;
}

function ProfileSoloShell() {
  return (
    <div className="App app-solo app-with-session-shell">
      <header className="app-session-bar app-session-bar--solo-minimal">
        <div className="app-session-bar-inner app-session-bar-inner--solo-minimal">
          <UserAccountMenu layout="solo" />
        </div>
      </header>
      <main className="content-area app-solo-main page-content">
        <ProfilePage />
      </main>
    </div>
  );
}

function ProfileEntryGate() {
  const { user, loadingMe, token } = useAuth();
  if (loadingMe && token) {
    return (
      <div className="app-solo-loading">
        <span className="server-ping-readonly-text">Loading…</span>
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  if (user.role === 'admin') {
    return <Navigate to="/admin/profile" replace />;
  }
  return <ProfileSoloShell />;
}

function MinimalChrome({ children }) {
  return (
    <div className="App app-solo">
      <main className="content-area app-solo-main page-content">{children}</main>
    </div>
  );
}

function NotFoundRedirect() {
  const { user, loadingMe, token } = useAuth();
  if (loadingMe && token) {
    return (
      <div className="app-solo-loading">
        <span className="server-ping-readonly-text">Loading…</span>
      </div>
    );
  }
  if (!user) {
    return <Navigate to="/" replace />;
  }
  if (user.role === 'admin') {
    return <Navigate to="/admin/business-servers" replace />;
  }
  return <Navigate to="/" replace />;
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<PublicServerPingPage />} />
      <Route path="/group/:publicGroup" element={<PublicServerPingPage />} />
      <Route path="/login" element={<LoginPageGate />} />
      <Route
        path="/verify-email"
        element={
          <MinimalChrome>
            <VerifyEmailPage />
          </MinimalChrome>
        }
      />
      <Route
        path="/forgot-password"
        element={
          <MinimalChrome>
            <ForgotPasswordPage />
          </MinimalChrome>
        }
      />
      <Route
        path="/reset-password"
        element={
          <MinimalChrome>
            <ResetPasswordPage />
          </MinimalChrome>
        }
      />
      <Route path="/server-ping" element={<Navigate to="/" replace />} />
      <Route
        path="/server-mtr"
        element={
          <PrivatePingGate>
            <SoloMtrRedirect />
          </PrivatePingGate>
        }
      />
      <Route
        path="/profile"
        element={
          <PrivatePingGate>
            <ProfileEntryGate />
          </PrivatePingGate>
        }
      />

      <Route path="/admin" element={<AdminLayoutGuard />}>
        <Route index element={<Navigate to="business-servers" replace />} />
        <Route path="dashboard" element={<StatusTable />} />
        <Route path="ports" element={<PortsPanel />} />
        <Route path="history" element={<HistoryPanel />} />
        <Route path="bandwidth" element={<BandwidthDashboard />} />
        <Route path="errors" element={<ErrorLogs />} />
        <Route path="business-servers" element={<BusinessServersPanel />} />
        <Route path="groups" element={<GroupManagementPanel />} />
        <Route path="server-ping" element={<AdminServerPingPage />} />
        <Route path="server-mtr" element={<AdminServerMtrPage />} />
        <Route path="profile" element={<ProfilePage />} />
      </Route>

      <Route path="/dashboard" element={<Navigate to="/admin/dashboard" replace />} />
      <Route path="/ports" element={<Navigate to="/admin/ports" replace />} />
      <Route path="/history" element={<Navigate to="/admin/history" replace />} />
      <Route path="/bandwidth" element={<Navigate to="/admin/bandwidth" replace />} />
      <Route path="/errors" element={<Navigate to="/admin/errors" replace />} />
      <Route path="/server-metrics" element={<Navigate to="/admin/dashboard" replace />} />
      <Route path="/business-servers" element={<Navigate to="/admin/business-servers" replace />} />
      <Route path="/groups" element={<Navigate to="/admin/groups" replace />} />

      <Route path="*" element={<NotFoundRedirect />} />
    </Routes>
  );
}

function App() {
  return (
    <AuthProvider>
      <Router>
        <AppRoutes />
      </Router>
    </AuthProvider>
  );
}

export default App;
