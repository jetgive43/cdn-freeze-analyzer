import React, { useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import '../App.css';

const HISTORY_OPTIONS = [8, 12, 16, 20];

const ServerPingPanel = () => {
  const [serverList, setServerList] = useState({});
  const [knownGroups, setKnownGroups] = useState([]);
  const [geoDbAvailable, setGeoDbAvailable] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [showError, setShowError] = useState(true);
  const [lastPingTime, setLastPingTime] = useState(null);
  const [expandedGroups, setExpandedGroups] = useState({});
  const [proxyPort, setProxyPort] = useState('');
  const [historyColumns, setHistoryColumns] = useState(12);
  const [ports, setPorts] = useState([]);
  const [addGroup, setAddGroup] = useState('');
  const [newGroupName, setNewGroupName] = useState('');
  const [addIp, setAddIp] = useState('');
  const [adding, setAdding] = useState(false);
  const wsRef = useRef(null);
  const proxyPortRef = useRef(proxyPort);
  proxyPortRef.current = proxyPort;

  const fetchPorts = useCallback(async () => {
    try {
      const response = await fetch('/api/ports');
      if (!response.ok) {
        throw new Error(`Failed to load ports (${response.status})`);
      }
      const data = await response.json();
      const activePorts = (Array.isArray(data.ports) ? data.ports : [])
        .filter((p) => Number(p.status) === 1)
        .sort((a, b) => Number(a.portNumber) - Number(b.portNumber));
      setPorts(activePorts);
      setProxyPort((prev) => {
        if (prev && activePorts.some((p) => String(p.portNumber) === String(prev))) {
          return prev;
        }
        return activePorts[0] ? String(activePorts[0].portNumber) : '';
      });
    } catch (err) {
      console.error('❌ Error fetching ports:', err);
      setPorts([]);
      setProxyPort('');
    }
  }, []);

  const fetchServerList = useCallback(async () => {
    if (!proxyPort) {
      setServerList({});
      return;
    }
    try {
      const response = await axios.get('/api/server-ping/list', {
        params: { proxyPort, historyLimit: historyColumns },
      });
      if (response.data.success) {
        setServerList(response.data.servers || {});
        setKnownGroups(response.data.groups || []);
        if (typeof response.data.geoDbAvailable === 'boolean') {
          setGeoDbAvailable(response.data.geoDbAvailable);
        }
        setExpandedGroups((prev) => {
          const next = { ...prev };
          Object.keys(response.data.servers || {}).forEach((group) => {
            if (next[group] === undefined) {
              next[group] = true;
            }
          });
          return next;
        });
      }
    } catch (err) {
      console.error('❌ Error fetching server list:', err);
      setError('Failed to load server list');
    }
  }, [proxyPort, historyColumns]);

  useEffect(() => {
    fetchPorts();
  }, [fetchPorts]);

  useEffect(() => {
    fetchServerList();
  }, [fetchServerList]);

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}/ws`;
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'server_ping_updated' && data.results) {
          if (
            data.source === 'scheduled' &&
            data.proxyPort != null &&
            String(data.proxyPort) !== String(proxyPortRef.current)
          ) {
            return;
          }
          setLastPingTime(new Date(data.timestamp));
          fetchServerList();
        }
      } catch {
        /* ignore */
      }
    };

    return () => {
      ws.close();
      wsRef.current = null;
    };
  }, [fetchServerList]);

  const formatPortLabel = (port) => {
    if (!port) return '';
    const country = port.countryShort || port.country;
    const provider = port.providerShort || port.provider;
    const short = [country, provider].filter(Boolean).join(' ');
    return short ? `${short} (${port.portNumber})` : `Port ${port.portNumber}`;
  };

  const pingAllServers = useCallback(async () => {
    setLoading(true);
    setError(null);
    setShowError(true);
    try {
      const response = await axios.get('/api/server-ping/ping/all', {
        params: { proxyPort },
      });
      if (response.data.success) {
        setLastPingTime(new Date(response.data.timestamp));
        await fetchServerList();
      } else {
        setError(response.data.error || 'Failed to ping servers');
      }
    } catch (err) {
      console.error('❌ Error pinging servers:', err);
      setError(err.response?.data?.error || 'Failed to ping servers');
    } finally {
      setLoading(false);
    }
  }, [proxyPort, fetchServerList]);

  const pingGroup = useCallback(
    async (groupName) => {
      setLoading(true);
      setError(null);
      setShowError(true);
      try {
        const response = await axios.get(
          `/api/server-ping/ping/group/${encodeURIComponent(groupName)}`,
          { params: { proxyPort } }
        );
        if (response.data.success) {
          setLastPingTime(new Date(response.data.timestamp));
          await fetchServerList();
        } else {
          setError(response.data.error || `Failed to ping group ${groupName}`);
        }
      } catch (err) {
        console.error(`❌ Error pinging group ${groupName}:`, err);
        setError(err.response?.data?.error || `Failed to ping group ${groupName}`);
      } finally {
        setLoading(false);
      }
    },
    [proxyPort, fetchServerList]
  );

  const handleAddServer = async (e) => {
    e.preventDefault();
    setAdding(true);
    setError(null);
    setShowError(true);
    try {
      await axios.post('/api/server-ping/servers', {
        groupName: addGroup,
        newGroupName: addGroup === '__new__' ? newGroupName.trim() : undefined,
        ip: addIp.trim(),
      });
      setAddIp('');
      if (addGroup === '__new__') {
        setNewGroupName('');
      }
      await fetchServerList();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to add server');
    } finally {
      setAdding(false);
    }
  };

  const handleDeleteServer = async (id) => {
    if (!window.confirm('Remove this server from the list?')) return;
    setLoading(true);
    setError(null);
    try {
      await axios.delete(`/api/server-ping/servers/${id}`);
      await fetchServerList();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to delete server');
    } finally {
      setLoading(false);
    }
  };

  const toggleGroup = (groupName) => {
    setExpandedGroups((prev) => ({
      ...prev,
      [groupName]: !prev[groupName],
    }));
  };

  const closeError = () => {
    setShowError(false);
  };

  const formatHeaderTime = (ts) => {
    if (!ts) return '…';
    try {
      const d = new Date(ts);
      return new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).format(d);
    } catch {
      return '…';
    }
  };

  const formatRttMs = (rttMs) => {
    if (rttMs == null || rttMs === '') return '—';
    const n = Number(rttMs);
    if (Number.isNaN(n)) return '—';
    return n.toFixed(2);
  };

  const historyCellClass = (status) => {
    if (status === 'success') return 'data-cell status-success';
    if (status === 'timeout') return 'data-cell status-timeout';
    if (status === 'failed' || status === 'error' || status === 'proxy_rejected') {
      return 'data-cell status-failed';
    }
    return 'data-cell empty';
  };

  const isHighRtt = (rttMs) => {
    const n = Number(rttMs);
    return !Number.isNaN(n) && n > 1000;
  };

  const calculateAverageRTT = (groupName) => {
    const servers = serverList[groupName] || [];
    const values = [];
    servers.forEach((s) => {
      (s.history || []).forEach((h) => {
        if (h.status === 'success' && h.rtt_ms != null) {
          const v = Number(h.rtt_ms);
          if (!Number.isNaN(v) && v > 0) {
            values.push(v);
          }
        }
      });
    });
    if (values.length === 0) return null;
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    return avg.toFixed(2);
  };

  const getSortedGroupNames = () => {
    const groupNames = Object.keys(serverList);
    return groupNames.sort((a, b) => {
      const avgA = calculateAverageRTT(a);
      const avgB = calculateAverageRTT(b);
      if (!avgA && !avgB) return 0;
      if (!avgA) return 1;
      if (!avgB) return -1;
      return parseFloat(avgA) - parseFloat(avgB);
    });
  };

  const totalServers = Object.values(serverList).reduce((sum, servers) => sum + servers.length, 0);

  const renderHistoryHeaders = (groupName) => {
    const servers = serverList[groupName] || [];
    const refHist = servers[0]?.history || [];
    return refHist.map((h, idx) => (
      <th key={idx} className="time-header" title={h.created_at ? String(h.created_at) : ''}>
        {formatHeaderTime(h.created_at || h.timestamp)}
      </th>
    ));
  };

  return (
    <div className="status-table-container">
      <div className="table-header">
        <h2>Server ping (via proxy)</h2>
        <div className="controls">
          <div className="control-group">
            <div className="control-item">
              <label htmlFor="proxyPort">Proxy: </label>
              <select
                id="proxyPort"
                value={proxyPort}
                onChange={(e) => setProxyPort(e.target.value)}
                disabled={loading || ports.length === 0}
              >
                {ports.length > 0 ? (
                  ports.map((port) => (
                    <option key={port.portNumber} value={String(port.portNumber)}>
                      {formatPortLabel(port)}
                    </option>
                  ))
                ) : (
                  <option value="">No active ports</option>
                )}
              </select>
            </div>
            <div className="control-item">
              <label htmlFor="histCols">History cols: </label>
              <select
                id="histCols"
                value={historyColumns}
                onChange={(e) => setHistoryColumns(Number(e.target.value))}
                disabled={loading}
              >
                {HISTORY_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <button type="button" onClick={pingAllServers} disabled={loading || !proxyPort} className="btn btn-success">
            {loading ? 'Pinging...' : 'Ping all'}
          </button>
        </div>

        {!geoDbAvailable && (
          <div className="error-message" style={{ marginTop: '0.5rem' }}>
            <strong>GeoIP:</strong> GeoLite2-Country.mmdb not installed — new servers get location &quot;Unknown&quot;.
            Run <code>backend/scripts/download-maxmind-country.sh</code> with MAXMIND_LICENSE_KEY.
          </div>
        )}

        <form className="server-ping-add-panel" onSubmit={handleAddServer}>
          <div className="control-item">
            <label htmlFor="spGroup">Group</label>
            <select
              id="spGroup"
              value={addGroup}
              onChange={(e) => setAddGroup(e.target.value)}
              disabled={adding || loading}
            >
              <option value="">— Select —</option>
              {knownGroups.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
              <option value="__new__">+ New group…</option>
            </select>
          </div>
          {addGroup === '__new__' && (
            <div className="control-item">
              <label htmlFor="spNewG">New group name</label>
              <input
                id="spNewG"
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="e.g. Delta"
                disabled={adding || loading}
              />
            </div>
          )}
          <div className="control-item">
            <label htmlFor="spIp">IP address</label>
            <input
              id="spIp"
              value={addIp}
              onChange={(e) => setAddIp(e.target.value)}
              placeholder="IPv4 / IPv6 (country from MMDB)"
              disabled={adding || loading}
            />
          </div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={
              adding ||
              loading ||
              !addGroup ||
              (addGroup === '__new__' && !newGroupName.trim())
            }
          >
            {adding ? 'Adding…' : 'Add server'}
          </button>
        </form>
      </div>

      {error && showError && (
        <div className="error-message">
          <strong>Error:</strong> {error}
          <button type="button" className="error-close" onClick={closeError}>
            ×
          </button>
        </div>
      )}

      <div className="table-scroll-container">
        {Object.keys(serverList).length > 0 ? (
          <div className="server-ping-groups">
            {getSortedGroupNames().map((groupName) => {
              const servers = serverList[groupName];
              const isExpanded = expandedGroups[groupName];
              const avgRTT = calculateAverageRTT(groupName);

              return (
                <div key={groupName} className="server-ping-group">
                  <div
                    role="button"
                    tabIndex={0}
                    className={`server-ping-group-header ${isExpanded ? '' : 'server-ping-collapsed'}`}
                    onClick={() => toggleGroup(groupName)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        toggleGroup(groupName);
                      }
                    }}
                  >
                    <div className="server-ping-group-title">
                      <span className="server-ping-chevron">{isExpanded ? '▼' : '▶'}</span>
                      <span className="server-ping-group-name">{groupName}</span>
                      <span className="server-ping-group-meta">({servers.length} servers)</span>
                      {avgRTT ? (
                        <span className="server-ping-avg-rtt">Avg RTT (history): {avgRTT} ms</span>
                      ) : null}
                    </div>
                    <div className="server-ping-group-actions">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          pingGroup(groupName);
                        }}
                        disabled={loading || !proxyPort}
                        className="btn btn-sm"
                      >
                        Ping group
                      </button>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="server-ping-group-body">
                      <table className="rtt-table" style={{ margin: 0 }}>
                        <thead>
                          <tr>
                            <th style={{ textAlign: 'left', minWidth: '120px' }}>Location</th>
                            <th style={{ textAlign: 'left', minWidth: '180px' }}>IP</th>
                            {renderHistoryHeaders(groupName)}
                          </tr>
                        </thead>
                        <tbody>
                          {servers.map((server) => {
                            const hist = server.history || [];
                            const last = hist[hist.length - 1];
                            const errorMsg = last?.error_message || '';

                            return (
                              <tr key={server.id} className="data-row">
                                <td style={{ textAlign: 'left', padding: '0.75rem 0.5rem' }}>
                                  {server.location}
                                </td>
                                <td
                                  className="server-ping-ip-cell"
                                  title={errorMsg || undefined}
                                >
                                  <span className="server-ping-ip-text">{server.ip}</span>
                                  <button
                                    type="button"
                                    className="server-ping-remove-icon"
                                    disabled={loading}
                                    onClick={() => handleDeleteServer(server.id)}
                                    aria-label={`Remove ${server.ip}`}
                                    title="Remove server"
                                  >
                                    <svg
                                      viewBox="0 0 24 24"
                                      width="18"
                                      height="18"
                                      fill="currentColor"
                                      aria-hidden="true"
                                    >
                                      <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z" />
                                    </svg>
                                  </button>
                                </td>
                                {hist.map((h, hi) => {
                                  const cls = historyCellClass(h.status);
                                  const extra = isHighRtt(h.rtt_ms) ? ' high-rtt' : '';
                                  return (
                                    <td
                                      key={hi}
                                      className={cls + extra}
                                      title={h.error_message || h.status}
                                    >
                                      {formatRttMs(h.rtt_ms)}
                                    </td>
                                  );
                                })}
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="no-data" style={{ padding: '3rem', textAlign: 'center', color: '#6c757d' }}>
            {loading ? 'Loading servers...' : 'No servers configured. Add one above.'}
          </div>
        )}
      </div>

      {Object.keys(serverList).length > 0 && (
        <div className="table-footer">
          <p>
            Total groups: {Object.keys(serverList).length} · Total servers: {totalServers}
            {lastPingTime && ` · Last ping: ${formatHeaderTime(lastPingTime)}`}
            {` · Proxy: ${proxyPort} · History: ${historyColumns} samples`}
          </p>
        </div>
      )}
    </div>
  );
};

export default ServerPingPanel;
