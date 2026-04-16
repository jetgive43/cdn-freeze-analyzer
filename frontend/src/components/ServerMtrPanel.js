import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import axios from 'axios';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import '../App.css';
import './ServerMtrPanel.css';

const SORT_IP = 'ip';
const SORT_GROUP = 'group';
const SORT_LOCATION = 'location';

/** Recent MTR runs per row (newest first); must stay ≤ backend cap (20). */
const SHOW_COUNT_OPTIONS = [4, 6, 8, 10, 12];
const MTR_JOB_LS = 'cdn_server_mtr_job';

function flattenServerRows(serverList) {
  const rows = [];
  Object.keys(serverList || {}).forEach((groupName) => {
    (serverList[groupName] || []).forEach((server) => {
      rows.push({ groupName, server });
    });
  });
  return rows;
}

function formatAgo(isoString, nowMs) {
  if (!isoString) return '—';
  const t = new Date(isoString).getTime();
  if (Number.isNaN(t)) return '—';
  const sec = Math.round((nowMs - t) / 1000);
  if (sec < 10) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function fmtMs(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  return `${n.toFixed(n < 10 ? 3 : 1)}ms`;
}

function fmtPct(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  return `${n.toFixed(1)}%`;
}

function pathModeLabel(mode) {
  if (mode === 'socks_proxy') return 'SOCKS';
  if (mode === 'direct') return 'Local';
  return '—';
}

function pathModePillClass(mode) {
  if (mode === 'socks_proxy') return 'mtr-path-pill mtr-path-pill--socks';
  if (mode === 'direct') return 'mtr-path-pill mtr-path-pill--local';
  return 'mtr-path-pill mtr-path-pill--local';
}

function formatMtrTargetRttCell(ms) {
  if (ms == null || ms === '') return null;
  const n = Number(ms);
  if (Number.isNaN(n)) return null;
  return `${n < 10 ? n.toFixed(2) : n.toFixed(1)}ms`;
}

function MtrHopDiagram({ hubs, targetPort, status, errorMessage }) {
  if (!hubs || hubs.length === 0) {
    return (
      <div className="server-ping-readonly-text" style={{ fontSize: '0.85rem', padding: '0.5rem 0' }}>
        {errorMessage || (status === 'failed' ? 'No hop data for this run.' : 'No hop data.')}
      </div>
    );
  }

  const lastIdx = hubs.length - 1;

  return (
    <div className="mtr-hop-track" role="list">
      {hubs.map((hub, i) => {
        const host = String(hub.host ?? '—');
        const cc = hub.country_code ? String(hub.country_code).toUpperCase() : null;
        const loss = hub['Loss%'] ?? hub.LossPct ?? hub.loss;
        const last = hub.Last ?? hub.last;
        const avg = hub.Avg ?? hub.avg;
        const asn = hub.ASN ?? hub.asn ?? '';
        const isTarget = i === lastIdx;

        return (
          <React.Fragment key={`${i}-${host}`}>
            {i > 0 ? <span className="mtr-hop-arrow" aria-hidden="true">→</span> : null}
            <div
              className={`mtr-hop-card${isTarget ? ' mtr-hop-card-target' : ''}`}
              role="listitem"
              title={hub.country_name || undefined}
            >
              <div className="mtr-hop-card-head">
                <span className={`mtr-hop-cc${cc ? '' : ' mtr-hop-cc-unknown'}`}>{cc || '??'}</span>
                <div className="mtr-hop-host" title={host}>
                  {host.length > 22 ? `${host.slice(0, 20)}…` : host}
                </div>
              </div>
              <div className="mtr-hop-metric">
                <span className="mtr-hop-metric-label">Loss</span>
                <span className="mtr-hop-metric-value">{fmtPct(loss)}</span>
              </div>
              <div className="mtr-hop-metric">
                <span className="mtr-hop-metric-label">Last</span>
                <span className="mtr-hop-metric-value">{fmtMs(last)}</span>
              </div>
              <div className="mtr-hop-metric">
                <span className="mtr-hop-metric-label">Avg</span>
                <span className="mtr-hop-metric-value">{fmtMs(avg)}</span>
              </div>
              {asn ? (
                <div className="mtr-hop-asn" title={String(asn)}>
                  {String(asn)}
                </div>
              ) : null}
              {isTarget && targetPort != null ? (
                <div className="mtr-hop-metric" style={{ marginTop: 0.15 }}>
                  <span className="mtr-hop-metric-label">TCP</span>
                  <span className="mtr-hop-metric-value">:{targetPort}</span>
                </div>
              ) : null}
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}

const ServerMtrPanel = ({ privateSession = false, hideSessionChrome = false }) => {
  const navigate = useNavigate();
  const { authHeader, user, canPing, isAdmin, loadingMe, login, signup, logout } = useAuth();
  const [authModal, setAuthModal] = useState(null);
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [authBusy, setAuthBusy] = useState(false);
  const [authMessage, setAuthMessage] = useState(null);

  const [serverList, setServerList] = useState({});
  const [geoDbAvailable, setGeoDbAvailable] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showError, setShowError] = useState(true);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [proxyPort, setProxyPort] = useState('');
  const [showCount, setShowCount] = useState(6);
  const [ports, setPorts] = useState([]);
  const [sortColumn, setSortColumn] = useState(SORT_IP);
  const [sortDir, setSortDir] = useState('asc');
  const [rowRunningId, setRowRunningId] = useState(null);
  const [mtrBatchRunActive, setMtrBatchRunActive] = useState(false);
  const [mtrBatchProgress, setMtrBatchProgress] = useState({ current: 0, total: 0 });
  const [detailRunId, setDetailRunId] = useState(null);
  const [detailRun, setDetailRun] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const mtrPollRef = useRef(null);
  const mtrMergeIdxRef = useRef(0);

  const tableBusy = loading || !!rowRunningId || mtrBatchRunActive;

  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const fetchPorts = useCallback(async () => {
    try {
      const response = await axios.get('/api/ports', { headers: { ...authHeader() } });
      const data = response.data || {};
      const allPorts = (Array.isArray(data.ports) ? data.ports : []).sort(
        (a, b) => Number(a.portNumber) - Number(b.portNumber)
      );
      setPorts(allPorts);
      setProxyPort((prev) => {
        if (prev && allPorts.some((p) => String(p.portNumber) === String(prev))) {
          return prev;
        }
        return allPorts[0] ? String(allPorts[0].portNumber) : '';
      });
    } catch (err) {
      console.error('❌ Error fetching ports:', err);
      setPorts([]);
      setProxyPort('');
    }
  }, [authHeader]);

  const fetchList = useCallback(async () => {
    if (!proxyPort) {
      setServerList({});
      return;
    }
    setLoading(true);
    try {
      const response = await axios.get('/api/server-mtr/list', {
        params: { proxyPort, historyLimit: showCount },
        headers: { ...authHeader() },
      });
      if (response.data.success) {
        setServerList(response.data.servers || {});
        if (typeof response.data.geoDbAvailable === 'boolean') {
          setGeoDbAvailable(response.data.geoDbAvailable);
        }
      }
    } catch (err) {
      console.error('❌ Error fetching MTR list:', err);
      setError('Failed to load MTR list');
    } finally {
      setLoading(false);
    }
  }, [proxyPort, showCount, authHeader]);

  useEffect(() => {
    fetchPorts();
  }, [fetchPorts]);

  useEffect(() => {
    if (loadingMe) return;
    fetchList();
  }, [fetchList, loadingMe]);

  const formatPortLabel = (port) => {
    if (!port) return '';
    const country = (port.country || '').trim();
    const isp = (port.ispName || port.provider || '').trim();
    const short = [country, isp].filter(Boolean).join(' · ');
    const base = short || 'Proxy';
    const inactive = Number(port.status) === 1 ? '' : ' · inactive';
    return `${base}${inactive}`;
  };

  const toggleSort = useCallback((col) => {
    setSortColumn((prev) => {
      if (prev === col) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        return prev;
      }
      setSortDir('asc');
      return col;
    });
  }, []);

  const tableRows = useMemo(() => {
    const rows = flattenServerRows(serverList);
    const dir = sortDir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      let c = 0;
      switch (sortColumn) {
        case SORT_IP:
          c = String(a.server.ip).localeCompare(String(b.server.ip), undefined, {
            numeric: true,
            sensitivity: 'base',
          });
          break;
        case SORT_GROUP:
          c = String(a.groupName).localeCompare(String(b.groupName), undefined, { sensitivity: 'base' });
          break;
        case SORT_LOCATION:
          c = String(a.server.location).localeCompare(String(b.server.location), undefined, {
            sensitivity: 'base',
          });
          break;
        default:
          c = 0;
      }
      return c * dir;
    });
    return rows;
  }, [serverList, sortColumn, sortDir]);

  const mergeLatestAfterRun = useCallback(
    (groupName, serverId, historyEntry) => {
      setServerList((prev) => {
        const list = prev[groupName];
        if (!list) return prev;
        const idx = list.findIndex((s) => Number(s.id) === Number(serverId));
        if (idx < 0) return prev;
        const s = list[idx];
        const h = [historyEntry, ...(s.mtrHistory || [])].slice(0, showCount);
        const nextList = [...list];
        nextList[idx] = { ...s, mtrHistory: h };
        return { ...prev, [groupName]: nextList };
      });
    },
    [showCount]
  );

  const clearMtrPolling = useCallback(() => {
    if (mtrPollRef.current) {
      clearInterval(mtrPollRef.current);
      mtrPollRef.current = null;
    }
  }, []);

  const runMtrPollTick = useCallback(
    async (jobId) => {
      const { data } = await axios.get(`/api/server-mtr/job/${jobId}`, {
        headers: { ...authHeader() },
      });
      if (!data.success) {
        return 'done';
      }
      if (data.total > 1) {
        setMtrBatchProgress({ current: data.completed, total: data.total });
      }
      const results = data.results || [];
      for (let i = mtrMergeIdxRef.current; i < results.length; i += 1) {
        const r = results[i];
        if (r.historyEntry && r.groupName) {
          mergeLatestAfterRun(r.groupName, r.serverId, r.historyEntry);
        }
      }
      mtrMergeIdxRef.current = results.length;
      setNowTick(Date.now());
      if (data.status === 'completed' || data.status === 'failed') {
        localStorage.removeItem(MTR_JOB_LS);
        clearMtrPolling();
        setRowRunningId(null);
        setMtrBatchRunActive(false);
        setMtrBatchProgress({ current: 0, total: 0 });
        await fetchList();
        if (data.error) setError(data.error);
        return 'done';
      }
      return 'cont';
    },
    [authHeader, mergeLatestAfterRun, fetchList, clearMtrPolling]
  );

  const beginMtrPolling = useCallback(
    (jobId, resetMergeIndex) => {
      clearMtrPolling();
      if (resetMergeIndex) {
        mtrMergeIdxRef.current = 0;
      }
      const tick = () => {
        runMtrPollTick(jobId).catch((err) => {
          console.error(err);
          localStorage.removeItem(MTR_JOB_LS);
          clearMtrPolling();
          setRowRunningId(null);
          setMtrBatchRunActive(false);
          setMtrBatchProgress({ current: 0, total: 0 });
          setError(err.response?.data?.error || err.message || 'MTR status failed');
        });
      };
      tick();
      mtrPollRef.current = setInterval(tick, 2000);
    },
    [clearMtrPolling, runMtrPollTick]
  );

  useEffect(() => {
    if (!user) {
      clearMtrPolling();
      localStorage.removeItem(MTR_JOB_LS);
      setRowRunningId(null);
      setMtrBatchRunActive(false);
      setMtrBatchProgress({ current: 0, total: 0 });
    }
  }, [user, clearMtrPolling]);

  useEffect(() => {
    if (loadingMe || !user) return undefined;
    let raw;
    try {
      raw = localStorage.getItem(MTR_JOB_LS);
    } catch {
      raw = null;
    }
    if (!raw) return undefined;
    let jobId;
    let serverId;
    let batch;
    try {
      const o = JSON.parse(raw);
      jobId = o.jobId;
      serverId = o.serverId;
      batch = o.batch === true;
    } catch {
      return undefined;
    }
    if (!jobId) return undefined;
    if (batch) {
      setMtrBatchRunActive(true);
    } else if (serverId != null) {
      setRowRunningId(serverId);
    }
    const tid = setTimeout(() => {
      if (!mtrPollRef.current) {
        beginMtrPolling(jobId, false);
      }
    }, 0);
    return () => clearTimeout(tid);
  }, [loadingMe, user, beginMtrPolling]);

  const runSingleRow = useCallback(
    async (groupName, server) => {
      if (!proxyPort || !canPing) return;
      setRowRunningId(server.id);
      setMtrBatchRunActive(false);
      setMtrBatchProgress({ current: 0, total: 0 });
      setError(null);
      setShowError(true);
      clearMtrPolling();
      mtrMergeIdxRef.current = 0;
      try {
        const startRes = await axios.post(
          '/api/server-mtr/sequence/start',
          {
            proxyPort: Number(proxyPort),
            serverIds: [server.id],
          },
          { headers: { ...authHeader(), 'Content-Type': 'application/json' } }
        );
        if (!startRes.data.success || !startRes.data.jobId) {
          setError(startRes.data.error || 'Failed to start MTR');
          setRowRunningId(null);
          return;
        }
        const jobId = startRes.data.jobId;
        try {
          localStorage.setItem(MTR_JOB_LS, JSON.stringify({ jobId, serverId: server.id, groupName }));
        } catch {
          /* ignore */
        }
        beginMtrPolling(jobId, true);
      } catch (err) {
        console.error(err);
        setError(err.response?.data?.error || err.message || 'MTR failed');
        setRowRunningId(null);
        localStorage.removeItem(MTR_JOB_LS);
      }
    },
    [proxyPort, canPing, authHeader, clearMtrPolling, beginMtrPolling]
  );

  const mtrCheckAll = useCallback(async () => {
    if (!isAdmin || !proxyPort || tableRows.length === 0 || !canPing) return;
    setMtrBatchRunActive(true);
    setMtrBatchProgress({ current: 0, total: tableRows.length });
    setRowRunningId(null);
    setError(null);
    setShowError(true);
    clearMtrPolling();
    mtrMergeIdxRef.current = 0;
    try {
      const startRes = await axios.post(
        '/api/server-mtr/sequence/start',
        {
          proxyPort: Number(proxyPort),
          serverIds: tableRows.map(({ server }) => server.id),
        },
        { headers: { ...authHeader(), 'Content-Type': 'application/json' } }
      );
      if (!startRes.data.success || !startRes.data.jobId) {
        setError(startRes.data.error || 'Failed to start MTR batch');
        setMtrBatchRunActive(false);
        setMtrBatchProgress({ current: 0, total: 0 });
        return;
      }
      const jobId = startRes.data.jobId;
      try {
        localStorage.setItem(MTR_JOB_LS, JSON.stringify({ jobId, batch: true }));
      } catch {
        /* ignore */
      }
      beginMtrPolling(jobId, true);
    } catch (err) {
      console.error(err);
      setError(err.response?.data?.error || err.message || 'MTR batch failed');
      setMtrBatchRunActive(false);
      setMtrBatchProgress({ current: 0, total: 0 });
      localStorage.removeItem(MTR_JOB_LS);
    }
  }, [isAdmin, proxyPort, tableRows, canPing, authHeader, clearMtrPolling, beginMtrPolling]);

  const openRunDetail = useCallback(
    async (runId) => {
      if (!runId) return;
      setDetailRunId(runId);
      setDetailRun(null);
      setDetailLoading(true);
      try {
        const { data } = await axios.get(`/api/server-mtr/runs/${runId}`, {
          headers: { ...authHeader() },
        });
        if (data.success && data.run) {
          setDetailRun(data.run);
        }
      } catch (err) {
        setError(err.response?.data?.error || 'Failed to load MTR report');
        setDetailRunId(null);
      } finally {
        setDetailLoading(false);
      }
    },
    [authHeader]
  );

  const renderSortableTh = (col, label, thStyle, extraClass = '') => {
    const active = sortColumn === col;
    return (
      <th
        className={`server-ping-th-sort-wrap ${extraClass}`.trim()}
        style={thStyle}
        aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        <button type="button" className="server-ping-th-sort" onClick={() => toggleSort(col)}>
          <span>{label}</span>
          {active ? (
            <span className="server-ping-sort-indicator" aria-hidden="true">
              {sortDir === 'asc' ? ' ▲' : ' ▼'}
            </span>
          ) : null}
        </button>
      </th>
    );
  };

  const closeAuthModal = useCallback(() => {
    setAuthModal(null);
    setAuthEmail('');
    setAuthPassword('');
    setAuthMessage(null);
    setAuthBusy(false);
  }, []);

  const submitAuthModal = async (e) => {
    e.preventDefault();
    setAuthBusy(true);
    setAuthMessage(null);
    try {
      if (authModal === 'signup') {
        await signup(authEmail, authPassword);
        setAuthMessage('Account created. You can sign in.');
      } else {
        await login(authEmail, authPassword);
        closeAuthModal();
      }
    } catch (err) {
      setAuthMessage(err.response?.data?.error || err.message || 'Request failed');
    } finally {
      setAuthBusy(false);
    }
  };

  const totalServers = Object.values(serverList).reduce((sum, servers) => sum + servers.length, 0);

  const mtrSlotCellClass = (status) => {
    const base = 'mtr-last-run-cell-compact data-cell server-ping-timeline-cell';
    if (status === 'success') return `${base} status-success`;
    if (status === 'partial') return `${base} status-timeout`;
    if (status === 'failed' || status === 'error') return `${base} status-failed`;
    return `${base} empty`;
  };

  return (
    <div className="status-table-container">
      <div className="table-header">
        <div className="server-ping-header-row" style={{ flexWrap: 'wrap', gap: '0.75rem' }}>
          <h2 style={{ margin: 0 }}>MTR path (TCP)</h2>
          {!hideSessionChrome ? (
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              {loadingMe ? (
                <span className="server-ping-readonly-text" style={{ fontSize: '0.85rem' }}>
                  Session…
                </span>
              ) : user ? (
                <>
                  <span className="server-ping-readonly-text" style={{ fontSize: '0.85rem' }} title={user.email}>
                    {user.email}
                    {user.role === 'admin' ? ' · admin' : ''}
                  </span>
                  {privateSession && isAdmin ? (
                    <Link to="/admin/business-servers" className="btn btn-secondary" style={{ textDecoration: 'none' }}>
                      Admin console
                    </Link>
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => {
                      logout();
                      if (privateSession) navigate('/login', { replace: true });
                    }}
                  >
                    Sign out
                  </button>
                </>
              ) : privateSession ? (
                <span className="server-ping-readonly-text" style={{ fontSize: '0.85rem' }}>
                  Session expired — <Link to="/login">Sign in</Link>
                </span>
              ) : (
                <>
                  <button type="button" className="btn btn-secondary" onClick={() => setAuthModal('login')}>
                    Sign in
                  </button>
                  <button type="button" className="btn btn-primary" onClick={() => setAuthModal('signup')}>
                    Sign up
                  </button>
                </>
              )}
            </div>
          ) : user ? (
            <div className="server-ping-header-spacer" aria-hidden="true" />
          ) : (
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
              {loadingMe ? (
                <span className="server-ping-readonly-text" style={{ fontSize: '0.85rem' }}>
                  Session…
                </span>
              ) : privateSession ? (
                <span className="server-ping-readonly-text" style={{ fontSize: '0.85rem' }}>
                  Session expired — <Link to="/login">Sign in</Link>
                </span>
              ) : (
                <>
                  <button type="button" className="btn btn-secondary" onClick={() => setAuthModal('login')}>
                    Sign in
                  </button>
                  <button type="button" className="btn btn-primary" onClick={() => setAuthModal('signup')}>
                    Sign up
                  </button>
                </>
              )}
            </div>
          )}
        </div>
        <div className="controls server-ping-toolbar">
          {isAdmin ? (
            <div className="control-group">
              <div className="control-item">
                <label htmlFor="mtrProxyPort">Proxy: </label>
                <select
                  id="mtrProxyPort"
                  value={proxyPort}
                  onChange={(e) => setProxyPort(e.target.value)}
                  disabled={tableBusy || ports.length === 0}
                >
                  {ports.length > 0 ? (
                    ports.map((port) => (
                      <option key={port.portNumber} value={String(port.portNumber)}>
                        {formatPortLabel(port)}
                      </option>
                    ))
                  ) : (
                    <option value="">No ports</option>
                  )}
                </select>
              </div>
              <div className="control-item">
                <label htmlFor="mtrShowCount">History: </label>
                <select
                  id="mtrShowCount"
                  value={showCount}
                  onChange={(e) => setShowCount(Number(e.target.value))}
                  disabled={tableBusy}
                >
                  {SHOW_COUNT_OPTIONS.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ) : (
            <span className="server-ping-toolbar-spacer" aria-hidden="true" />
          )}
          <span className="server-ping-toolbar-flex" aria-hidden="true" />
          {isAdmin ? (
            <button
              type="button"
              onClick={mtrCheckAll}
              disabled={mtrBatchRunActive || !proxyPort || !canPing}
              className="btn btn-success"
              title={!canPing ? 'Sign in to run MTR' : undefined}
            >
              {mtrBatchRunActive
                ? `Checking ${mtrBatchProgress.current}/${mtrBatchProgress.total}…`
                : 'Check all'}
            </button>
          ) : null}
        </div>
        {!geoDbAvailable && (
          <div className="error-message" style={{ marginTop: '0.5rem' }}>
            <strong>GeoIP:</strong> optional for this page — server list still loads.
          </div>
        )}
      </div>

      {!privateSession && authModal && (
        <div
          className="server-ping-modal-backdrop"
          role="presentation"
          onClick={() => {
            if (!authBusy) closeAuthModal();
          }}
        >
          <div
            className="server-ping-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mtr-auth-title"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: '22rem' }}
          >
            <div className="server-ping-modal-header">
              <h2 id="mtr-auth-title">{authModal === 'signup' ? 'Sign up' : 'Sign in'}</h2>
              <button
                type="button"
                className="server-ping-modal-close"
                onClick={closeAuthModal}
                disabled={authBusy}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <form className="server-ping-modal-form" onSubmit={submitAuthModal}>
              <div className="server-ping-modal-field">
                <label htmlFor="mtrAuthEmail">Email</label>
                <input
                  id="mtrAuthEmail"
                  type="email"
                  autoComplete="email"
                  value={authEmail}
                  onChange={(e) => setAuthEmail(e.target.value)}
                  disabled={authBusy}
                  required
                />
              </div>
              <div className="server-ping-modal-field">
                <label htmlFor="mtrAuthPass">Password</label>
                <input
                  id="mtrAuthPass"
                  type="password"
                  autoComplete={authModal === 'signup' ? 'new-password' : 'current-password'}
                  value={authPassword}
                  onChange={(e) => setAuthPassword(e.target.value)}
                  disabled={authBusy}
                  required
                  minLength={authModal === 'signup' ? 8 : undefined}
                />
              </div>
              {authMessage && (
                <p className="server-ping-modal-geo-hint" style={{ color: authModal === 'signup' ? '#198754' : '#c00' }}>
                  {authMessage}
                </p>
              )}
              <div className="server-ping-modal-actions">
                <button type="button" className="btn server-ping-modal-btn-cancel" onClick={closeAuthModal} disabled={authBusy}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary" disabled={authBusy}>
                  {authBusy ? '…' : authModal === 'signup' ? 'Create account' : 'Sign in'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {detailRunId && (
        <div
          className="server-ping-modal-backdrop"
          role="presentation"
          onClick={() => {
            setDetailRunId(null);
            setDetailRun(null);
          }}
        >
          <div
            className="server-ping-modal mtr-modal-wide"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
            style={{ maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}
          >
            <div className="server-ping-modal-header">
              <h2>MTR path</h2>
              <button
                type="button"
                className="server-ping-modal-close"
                onClick={() => {
                  setDetailRunId(null);
                  setDetailRun(null);
                }}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <div className="mtr-modal-body">
              {detailLoading || !detailRun ? (
                <p className="server-ping-readonly-text">Loading…</p>
              ) : (
                <>
                  <p className="server-ping-readonly-text" style={{ fontSize: '0.82rem', marginBottom: '0.35rem' }}>
                    <span className={pathModePillClass(detailRun.path_mode)} style={{ marginRight: '0.35rem' }}>
                      {pathModeLabel(detailRun.path_mode)}
                    </span>
                    {isAdmin ? (
                      <>
                        {detailRun.proxy_host}:{detailRun.proxy_port}
                        {' · '}
                      </>
                    ) : null}
                    port {detailRun.target_port} ·{' '}
                    <span style={{ fontVariantNumeric: 'tabular-nums' }}>{detailRun.status}</span>
                  </p>
                  <p
                    className="server-ping-readonly-text"
                    style={{ fontSize: '0.76rem', color: '#6c757d', marginBottom: '0.5rem', lineHeight: 1.45 }}
                  >
                    {detailRun.path_mode === 'socks_proxy' ? (
                      <>
                        This run was executed with <strong>proxychains</strong> (SOCKS). If you expected an exit
                        country (e.g. Egypt) on the path, note: MTR still reports IP hops along the route its probes saw;
                        the SOCKS endpoint is often <strong>not</strong> listed as a traceroute hop. Ensure{' '}
                        <code>MTR_PATH_MODE</code> is <code>auto</code> or <code>socks</code>, proxy auth matches this
                        port, and <code>proxychains4</code> is installed—otherwise the UI falls back to{' '}
                        <strong>Local</strong>.
                      </>
                    ) : (
                      <>
                        This run used a <strong>direct</strong> path from this app server. To force traffic through SOCKS,
                        set <code>MTR_PATH_MODE=socks</code> (requires proxychains4) or fix SOCKS errors so{' '}
                        <code>auto</code> does not fall back to direct.
                      </>
                    )}
                  </p>
                  <MtrHopDiagram
                    hubs={detailRun.hubs}
                    targetPort={detailRun.target_port}
                    status={detailRun.status}
                    errorMessage={detailRun.error_message}
                  />
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {error && showError && (
        <div className="error-message">
          <strong>Error:</strong> {error}
          <button type="button" className="error-close" onClick={() => setShowError(false)}>
            ×
          </button>
        </div>
      )}

      <div className="table-scroll-container">
        {tableRows.length > 0 ? (
          <table className="rtt-table server-ping-flat-table" style={{ margin: 0 }}>
            <thead>
              <tr>
                {renderSortableTh(SORT_IP, 'IP', { textAlign: 'left' }, 'server-ping-fth server-ping-fth-1')}
                {renderSortableTh(SORT_GROUP, 'Group', { textAlign: 'left' }, 'server-ping-fth server-ping-fth-2')}
                {renderSortableTh(SORT_LOCATION, 'Location', { textAlign: 'left' }, 'server-ping-fth server-ping-fth-3')}
                <th className="server-ping-fth server-ping-fth-4" style={{ textAlign: 'left' }}>
                  Port
                </th>
                <th
                  colSpan={showCount}
                  className="server-ping-timeline-th mtr-history-colspan-th"
                  scope="colgroup"
                >
                  History
                </th>
                <th className="server-ping-fth mtr-ping-fth-actions" style={{ textAlign: 'left' }}>
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map(({ groupName, server }) => {
                const hist = server.mtrHistory || [];
                const portVal = Number(server.port) || 80;
                return (
                  <tr key={server.id} className="data-row server-ping-data-row">
                    <td className="server-ping-ftd server-ping-ftd-1" style={{ textAlign: 'left', padding: '0.5rem' }}>
                      {server.ip}
                    </td>
                    <td className="server-ping-ftd server-ping-ftd-2" style={{ textAlign: 'left', padding: '0.5rem' }}>
                      <span className="server-ping-readonly-text">{groupName}</span>
                    </td>
                    <td className="server-ping-ftd server-ping-ftd-3" style={{ textAlign: 'left', padding: '0.5rem' }}>
                      <span className="server-ping-readonly-text">{server.location}</span>
                    </td>
                    <td className="server-ping-ftd server-ping-ftd-4" style={{ textAlign: 'left', padding: '0.5rem' }}>
                      {portVal}
                    </td>
                    {Array.from({ length: showCount }, (_, hi) => {
                      const h = hist[hi];
                      if (!h || !h.id) {
                        return (
                          <td key={hi} className="mtr-last-run-cell-compact data-cell empty server-ping-timeline-cell">
                            <span className="mtr-cell-ago" style={{ marginTop: 0 }}>
                              —
                            </span>
                          </td>
                        );
                      }
                      const rttStr = formatMtrTargetRttCell(h.target_rtt_ms);
                      const hopPart =
                        h.hop_count != null ? `${h.hop_count} hops` : '—';
                      return (
                        <td key={hi} className={mtrSlotCellClass(h.status)}>
                          <button
                            type="button"
                            className="mtr-last-run-btn"
                            title={[h.error_message, h.created_at, pathModeLabel(h.path_mode)]
                              .filter(Boolean)
                              .join(' · ')}
                            onClick={() => openRunDetail(h.id)}
                          >
                            <span className="mtr-cell-primary">
                              <span
                                className={pathModePillClass(h.path_mode)}
                                title={
                                  h.path_mode === 'socks_proxy'
                                    ? 'MTR process used proxychains (SOCKS). Hop list is still the L3 path MTR reported.'
                                    : 'MTR ran on this host without proxychains (direct probes).'
                                }
                              >
                                {pathModeLabel(h.path_mode)}
                              </span>
                              {hopPart}
                              {rttStr ? ` · ${rttStr}` : ''}
                            </span>
                            <span className="mtr-cell-ago">{formatAgo(h.created_at, nowTick)}</span>
                          </button>
                        </td>
                      );
                    })}
                    <td className="server-ping-actions-cell server-ping-ftd mtr-ping-ftd-actions">
                      <button
                        type="button"
                        className="btn btn-secondary"
                        style={{ fontSize: '0.8rem', padding: '0.2rem 0.5rem' }}
                        disabled={tableBusy || !canPing || !proxyPort}
                        onClick={() => runSingleRow(groupName, server)}
                      >
                        {rowRunningId === server.id ? '…' : 'MTR'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="no-data" style={{ padding: '3rem', textAlign: 'center', color: '#6c757d' }}>
            {loading ? 'Loading…' : 'No servers. Add targets on Server ping.'}
          </div>
        )}
      </div>

      {tableRows.length > 0 && (
        <div className="table-footer">
          <p>
            Total groups: {Object.keys(serverList).length} · Total servers: {totalServers}
          </p>
        </div>
      )}
    </div>
  );
};

export default ServerMtrPanel;
