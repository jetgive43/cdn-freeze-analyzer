import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import StatusTable from './components/StatusTable';
import HistoryPanel from './components/HistoryPanel';
import BandwidthDashboard from './components/BandwidthDashboard';
import ErrorLogs from './components/ErrorLogs';
import ServerMetrics from './components/ServerMetrics';
import PortsPanel from './components/PortsPanel';
import ServerPingPanel from './components/ServerPingPanel';
import GroupManagementPanel from './components/GroupManagementPanel';
import './App.css';

// Navigation Component
const Navigation = () => {
  return (
    <nav className="side-nav">
      <div className="nav-header">
        <h3>Menu</h3>
      </div>
      <ul className="nav-links">
        <li>
          <span className="nav-section-label parent">Nodes</span>
          <ul className="nav-sub-links">
            <li>
              <a href="/dashboard" className="nav-link">
                <span className="nav-icon">📊</span>
                TTL
              </a>
            </li>
            <li>
              <a href="/ports" className="nav-link">
                <span className="nav-icon">🧭</span>
                Proxy ports
              </a>
            </li>
            <li>
              <a href="/history" className="nav-link">
                <span className="nav-icon">📈</span>
                History
              </a>
            </li>
            <li>
              <a href="/bandwidth" className="nav-link">
                <span className="nav-icon">📶</span>
                Traffic
              </a>
            </li>
            <li>
              <a href="/errors" className="nav-link">
                <span className="nav-icon">⚠️</span>
                Logs
              </a>
            </li>
            <li>
              <a href="/server-ping" className="nav-link">
                <span className="nav-icon">🏓</span>
                Server Ping
              </a>
            </li>
            <li>
              <a href="/groups" className="nav-link">
                <span className="nav-icon">🧩</span>
                Groups
              </a>
            </li>
          </ul>
        </li>
        <li>
          <a href="/server-metrics" className="nav-link">
            <span className="nav-icon">🖥️</span>
            Server Metrics
          </a>
        </li>
      </ul>
    </nav>
  );
};

// Main layout component
const Layout = ({ children }) => {
  return (
    <div className="App">
      {/* <header className="App-header">
        <h1>Network Monitor</h1>
        <p>Real-time network latency monitoring</p>
      </header> */}
      <div className="main-content">
        <Navigation />
        <main className="content-area">
          {children}
        </main>
      </div>
    </div>
  );
};

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Layout><Navigate to="/dashboard" replace /></Layout>} />
        <Route path="/dashboard" element={<Layout><StatusTable /></Layout>} />
        <Route path="/ports" element={<Layout><PortsPanel /></Layout>} />
        <Route path="/history" element={<Layout><HistoryPanel /></Layout>} />
        <Route path="/bandwidth" element={<Layout><BandwidthDashboard /></Layout>} />
        <Route path="/errors" element={<Layout><ErrorLogs /></Layout>} />
        <Route path="/server-metrics" element={<Layout><ServerMetrics /></Layout>} />
        <Route path="/server-ping" element={<Layout><ServerPingPanel /></Layout>} />
        <Route path="/groups" element={<Layout><GroupManagementPanel /></Layout>} />
        <Route path="*" element={<Layout><div className="not-found">Page not found</div></Layout>} />
      </Routes>
    </Router>
  );
}

export default App;