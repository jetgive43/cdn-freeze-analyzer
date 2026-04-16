import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../context/AuthContext';

const GroupManagementPanel = () => {
  const { authHeader } = useAuth();
  const [loading, setLoading] = useState(false);
  const [savingRegions, setSavingRegions] = useState(false);
  const [savingPorts, setSavingPorts] = useState(false);
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [error, setError] = useState('');
  const [groups, setGroups] = useState([]);
  const [availableRegions, setAvailableRegions] = useState([]);
  const [activePorts, setActivePorts] = useState([]);
  const [regionMap, setRegionMap] = useState({});
  const [portLinks, setPortLinks] = useState({});
  const [newGroupKey, setNewGroupKey] = useState('');
  const [newGroupLabel, setNewGroupLabel] = useState('');

  const loadConfig = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/group-mappings', { headers: { ...authHeader() } });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || `Failed (${response.status})`);
      }
      const groupList = Array.isArray(data.groups) ? data.groups : [];
      const regionMappings = Array.isArray(data.regionMappings) ? data.regionMappings : [];
      const links = Array.isArray(data.portLinks) ? data.portLinks : [];
      const regions = Array.isArray(data.availableRegions) ? data.availableRegions : [];
      const ports = Array.isArray(data.activePorts) ? data.activePorts : [];

      const nextRegionMap = {};
      regionMappings.forEach((m) => {
        nextRegionMap[m.regionName] = m.groupKey;
      });
      const nextPortLinks = {};
      links.forEach((l) => {
        const key = String(l.portNumber);
        if (!nextPortLinks[key]) nextPortLinks[key] = [];
        if (!nextPortLinks[key].includes(l.groupKey)) {
          nextPortLinks[key].push(l.groupKey);
        }
      });

      setGroups(groupList);
      setAvailableRegions(regions);
      setActivePorts(ports);
      setRegionMap(nextRegionMap);
      setPortLinks(nextPortLinks);
    } catch (e) {
      setError(e.message || 'Failed to load group config');
    } finally {
      setLoading(false);
    }
  }, [authHeader]);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const sortedGroups = useMemo(
    () => [...groups].sort((a, b) => String(a.groupKey).localeCompare(String(b.groupKey))),
    [groups]
  );

  const saveRegions = async () => {
    setSavingRegions(true);
    setError('');
    try {
      const mappings = Object.entries(regionMap)
        .filter(([, groupKey]) => groupKey)
        .map(([regionName, groupKey]) => ({ regionName, groupKey }));
      const response = await fetch('/api/group-mappings/regions', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ mappings }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || `Failed (${response.status})`);
      }
      await loadConfig();
    } catch (e) {
      setError(e.message || 'Failed to save region mappings');
    } finally {
      setSavingRegions(false);
    }
  };

  const savePortLinks = async () => {
    setSavingPorts(true);
    setError('');
    try {
      const links = Object.entries(portLinks)
        .flatMap(([portNumber, groupKeys]) =>
          (Array.isArray(groupKeys) ? groupKeys : [])
            .filter(Boolean)
            .map((groupKey) => ({ portNumber: Number(portNumber), groupKey }))
        );
      const response = await fetch('/api/group-mappings/port-links', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ links }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || `Failed (${response.status})`);
      }
      await loadConfig();
    } catch (e) {
      setError(e.message || 'Failed to save port links');
    } finally {
      setSavingPorts(false);
    }
  };

  const groupLabel = (groupKey) => {
    const g = groups.find((x) => x.groupKey === groupKey);
    return g ? `${g.label} (${g.groupKey})` : groupKey;
  };

  const togglePortGroup = (portNumber, groupKey, checked) => {
    const portKey = String(portNumber);
    setPortLinks((current) => {
      const existing = Array.isArray(current[portKey]) ? current[portKey] : [];
      const next = checked
        ? Array.from(new Set([...existing, groupKey]))
        : existing.filter((g) => g !== groupKey);
      return { ...current, [portKey]: next };
    });
  };

  const createGroup = async () => {
    const groupKey = newGroupKey.trim().toUpperCase();
    const label = newGroupLabel.trim();
    if (!groupKey || !label) {
      setError('Group key and label are required');
      return;
    }
    setCreatingGroup(true);
    setError('');
    try {
      const response = await fetch('/api/group-mappings/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeader() },
        body: JSON.stringify({ groupKey, label }),
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || `Failed (${response.status})`);
      }
      setNewGroupKey('');
      setNewGroupLabel('');
      await loadConfig();
    } catch (e) {
      setError(e.message || 'Failed to create group');
    } finally {
      setCreatingGroup(false);
    }
  };

  return (
    <div className="page-content">
      <div className="table-header">
        <h2>Group Management (proxy : group : node region)</h2>
      </div>
      {error && <div className="error-message"><strong>Error:</strong> {error}</div>}
      {loading ? (
        <div style={{ padding: '1rem' }}>Loading…</div>
      ) : (
        <div style={{ display: 'grid', gap: '1rem' }}>
          <section style={{ background: '#fff', padding: '1rem', borderRadius: 8 }}>
            <h3>Add Group</h3>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', marginBottom: '1rem' }}>
              <input
                type="text"
                placeholder="Group key (e.g. US_WEST)"
                value={newGroupKey}
                onChange={(e) => setNewGroupKey(e.target.value)}
                style={{ minWidth: 220 }}
              />
              <input
                type="text"
                placeholder="Label (e.g. US West)"
                value={newGroupLabel}
                onChange={(e) => setNewGroupLabel(e.target.value)}
                style={{ minWidth: 220 }}
              />
              <button className="btn btn-success" onClick={createGroup} disabled={creatingGroup}>
                {creatingGroup ? 'Adding…' : 'Add / Update Group'}
              </button>
            </div>
          </section>

          <section style={{ background: '#fff', padding: '1rem', borderRadius: 8 }}>
            <h3>Region → Group</h3>
            <div style={{ overflowX: 'auto' }}>
              <table className="rtt-table">
                <thead>
                  <tr>
                    <th>Region (from node API)</th>
                    <th>Group</th>
                  </tr>
                </thead>
                <tbody>
                  {availableRegions.map((region) => (
                    <tr key={region}>
                      <td>{region}</td>
                      <td>
                        <select
                          value={regionMap[region] || ''}
                          onChange={(e) => setRegionMap((m) => ({ ...m, [region]: e.target.value }))}
                        >
                          <option value="">Unmapped</option>
                          {sortedGroups.map((g) => (
                            <option key={g.groupKey} value={g.groupKey}>
                              {g.label} ({g.groupKey})
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button className="btn btn-success" onClick={saveRegions} disabled={savingRegions}>
              {savingRegions ? 'Saving…' : 'Save Region Mapping'}
            </button>
          </section>

          <section style={{ background: '#fff', padding: '1rem', borderRadius: 8 }}>
            <h3>Proxy Port (country) → Group (multi-select)</h3>
            <div style={{ overflowX: 'auto' }}>
              <table className="rtt-table">
                <thead>
                  <tr>
                    <th>Port</th>
                    <th>Country</th>
                    <th>ISP</th>
                    <th>Groups</th>
                  </tr>
                </thead>
                <tbody>
                  {activePorts.map((p) => (
                    <tr key={p.portNumber}>
                      <td>{p.portNumber}</td>
                      <td>{p.countryCode || p.country}</td>
                      <td>{p.ispName || p.provider}</td>
                      <td>
                        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                          {sortedGroups.map((g) => {
                            const selected = (portLinks[String(p.portNumber)] || []).includes(g.groupKey);
                            return (
                              <label key={g.groupKey} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                <input
                                  type="checkbox"
                                  checked={selected}
                                  onChange={(e) => togglePortGroup(p.portNumber, g.groupKey, e.target.checked)}
                                />
                                <span>{g.label} ({g.groupKey})</span>
                              </label>
                            );
                          })}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button className="btn btn-success" onClick={savePortLinks} disabled={savingPorts}>
              {savingPorts ? 'Saving…' : 'Save Port Mapping'}
            </button>
          </section>

          <section style={{ background: '#fff', padding: '1rem', borderRadius: 8 }}>
            <h3>Groups</h3>
            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
              {sortedGroups.map((g) => (
                <span key={g.groupKey} className="server-ping-group-meta">
                  {groupLabel(g.groupKey)}
                </span>
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
};

export default GroupManagementPanel;
