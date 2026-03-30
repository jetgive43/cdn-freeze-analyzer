import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import axios from 'axios';

const COLUMN_WIDTH_LIMITS = {
  target: { min: 160, max: 420 },
  company: { min: 160, max: 420 },
  avg: { min: 100, max: 240 }
};

const StatusTable = () => {
  const [statusData, setStatusData] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [columnCount, setColumnCount] = useState(20);
  const [proxyPort, setProxyPort] = useState('');
  const [ports, setPorts] = useState([]);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [socketStatus, setSocketStatus] = useState('disconnected');
  const [measurementStatus, setMeasurementStatus] = useState('idle');
  const [showError, setShowError] = useState(true);
  const [ipInfoMap, setIpInfoMap] = useState({});
  const [columnWidths, setColumnWidths] = useState({
    target: 160,
    company: 160,
    avg: 100
  });

  const [stickyMetrics, setStickyMetrics] = useState({
    number: { left: 0, width: 60 },
    target: { left: 60, width: 160 },
    company: { left: 220, width: 160 },
    avg: { left: 380, width: 100 }
  });
  const [sortColumn, setSortColumn] = useState(null);
  const [sortDirection, setSortDirection] = useState('asc');
  const [expandedGroups, setExpandedGroups] = useState({});
  const resolveNodeGroupName = useCallback((row) => {
    const key = String(row?.groupKey || '').trim();
    if (key) return key;
    const label = String(row?.groupLabel || '').trim();
    return label || 'OTHERS';
  }, []);
  const ws = useRef(null);
  const abortControllerRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const dataFetchTimeoutRef = useRef(null);
  const wsFailureCountRef = useRef(0);
  const numberHeaderRef = useRef(null);
  const targetHeaderRef = useRef(null);
  const companyHeaderRef = useRef(null);
  const avgHeaderRef = useRef(null);
  const handleColumnWidthChange = useCallback((key, value) => {
    setColumnWidths((prev) => ({
      ...prev,
      [key]: value
    }));
  }, []);

  const handleColumnWidthInputChange = useCallback((key, rawValue) => {
    const limits = COLUMN_WIDTH_LIMITS[key];
    if (!limits) {
      return;
    }

    const numeric = Number(rawValue);
    if (Number.isNaN(numeric)) {
      return;
    }

    const clamped = Math.min(limits.max, Math.max(limits.min, numeric));
    handleColumnWidthChange(key, clamped);
  }, [handleColumnWidthChange]);
  const userTimeZone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch (error) {
      console.warn('⚠️ Unable to resolve user timezone, falling back to browser default');
      return undefined;
    }
  }, []);

  const parseTimestamp = useCallback((rawTimestamp) => {
    if (!rawTimestamp) {
      return null;
    }

    if (rawTimestamp instanceof Date) {
      return rawTimestamp;
    }

    if (typeof rawTimestamp === 'number') {
      const dateFromNumber = new Date(rawTimestamp);
      return Number.isNaN(dateFromNumber.getTime()) ? null : dateFromNumber;
    }

    if (typeof rawTimestamp === 'string') {
      let normalized = rawTimestamp.trim();

      if (!normalized) {
        return null;
      }

      if (!normalized.includes('T')) {
        normalized = normalized.replace(' ', 'T');
      }

      const dateFromString = new Date(normalized);
      return Number.isNaN(dateFromString.getTime()) ? null : dateFromString;
    }

    return null;
  }, []);

  const formatTimestampForDisplay = useCallback((timestamp, options = {}) => {
    const parsed = parseTimestamp(timestamp);

    if (!parsed) {
      return '-';
    }

    try {
      const formatter = new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: options.includeSeconds ? '2-digit' : undefined,
        hour12: options.hour12 ?? false,
        timeZone: userTimeZone
      });

      return formatter.format(parsed);
    } catch (error) {
      console.warn('⚠️ Failed to format timestamp, using locale default.', error);
      return parsed.toLocaleTimeString();
    }
  }, [parseTimestamp, userTimeZone]);

  const formatTimestampWithDate = useCallback((timestamp) => {
    const parsed = parseTimestamp(timestamp);

    if (!parsed) {
      return '-';
    }

    try {
      return new Intl.DateTimeFormat(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
        timeZone: userTimeZone
      }).format(parsed);
    } catch (error) {
      console.warn('⚠️ Failed to format timestamp with date, using default locale string.', error);
      return parsed.toLocaleString();
    }
  }, [parseTimestamp, userTimeZone]);
  const fetchIPInfo = useCallback(async (targets) => {
    try {
      const ipList = targets.map(target => {
        // Extract IP from target format (could be "ip:port" or just "ip")
        return target.split(':')[0];
      });

      const response = await axios.post(
        `/api/ip-info/batch`,
        { ipList },
        { timeout: 10000 }
      );

      if (response.data.success) {
        const infoMap = {};
        response.data.ipInfo.forEach(info => {
          infoMap[info.ip] = {
            displayText: `${info.ip} (${info.company}, ${info.country})`,
            company: info.company,
            country: info.country,
            found: info.found
          };
        });
        setIpInfoMap(infoMap);
      }
    } catch (err) {
      console.error('❌ Error fetching IP info:', err);
      // Continue without IP info if there's an error
    }
  }, []);
  const formatPortLabel = useCallback((port) => {
    if (!port) return '';
    const country = port.countryCode || port.countryShort || port.country;
    const provider = port.ispName || port.provider;
    const short = [country, provider].filter(Boolean).join(' ');
    return short ? `${short} (${port.portNumber})` : `Port ${port.portNumber}`;
  }, []);

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
      console.error('❌ Error fetching active proxy ports:', err);
      setPorts([]);
      setProxyPort('');
    }
  }, []);

  useEffect(() => {
    fetchPorts();
  }, [fetchPorts]);

  // FIXED: Optimized data fetching
  const fetchTimelineData = useCallback(async (silent = false) => {
    if (!proxyPort) {
      setStatusData([]);
      return;
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    abortControllerRef.current = new AbortController();

    if (!silent) {
      console.log('🔄 Fetching timeline data...');
      setLoading(true);
      setError(null);
    }

    try {
      const params = {
        proxyPort,
        limitPerTarget: columnCount,
        optimized: 'true',
        signal: abortControllerRef.current.signal
      };

      const response = await axios.get(
        `/api/measurements/timeline`,
        {
          params,
          timeout: 15000,
          signal: abortControllerRef.current.signal
        }
      );

      console.log('✅ Timeline data received for proxy port:', proxyPort);

      const data = response.data;

      if (data.success && Array.isArray(data.data)) {
        const formattedData = data.data.map((targetData, index) => {
          const measurements = targetData.measurements || [];
          const reversedHistory = [...measurements].reverse();
          const latestMeasurement = reversedHistory.length > 0 ? reversedHistory[0] : null;
          const target = targetData.target || `${latestMeasurement?.target_host}:${latestMeasurement?.target_port}`;

          const avgRtt = calculateAverageRTT(reversedHistory);

          return {
            target: target,
            proxy: latestMeasurement ? `proxy.soax.com:${latestMeasurement.proxy_port}` : `proxy.soax.com:${proxyPort}`,
            status: latestMeasurement?.status || 'pending',
            rtt: latestMeasurement?.rtt || null,
            error: latestMeasurement?.error_message || null,
            message: latestMeasurement?.message || 'No data available',
            rowNumber: index + 1,
            history: reversedHistory.slice(0, columnCount),
            avgRtt: avgRtt,
            groupKey: targetData.groupKey || latestMeasurement?.groupKey || null,
            groupLabel: targetData.groupLabel || latestMeasurement?.groupLabel || null,
            region: targetData.region || latestMeasurement?.region || null,
            id: `${target}-${Date.now()}`
          };
        });

        setStatusData(formattedData);
        setLastUpdate(new Date());

        // Get IP list and fetch company data in one go
        const targetList = formattedData.map(item => item.target.split(':')[0]);

        try {
          const companyResponse = await axios.post(
            `/api/ip-info/batch`,
            { ipList: targetList },
            { timeout: 10000 }
          );

          if (companyResponse.data.success) {
            const infoMap = {};
            companyResponse.data.ipInfo.forEach(info => {
              infoMap[info.ip] = {
                company: info.company,
                country: info.country || 'Unknown',
                found: info.found
              };
            });
            setIpInfoMap(infoMap);
          }
        } catch (err) {
          console.error('❌ Error fetching IP info:', err);
        }

        if (!silent) {
          console.log(`✅ Loaded ${formattedData.length} targets for proxy ${proxyPort}`);
        }
      }

    } catch (err) {
      if (err.name === 'CanceledError' || err.name === 'AbortError') {
        console.log('⚠️ Request cancelled');
        return;
      }
      console.error('❌ Error fetching timeline:', err);
      if (!silent) {
        setError('Failed to load data from server');
        setShowError(true);
      }
    } finally {
      if (!silent) {
        setLoading(false);
      }
      abortControllerRef.current = null;
    }
  }, [proxyPort, columnCount, fetchIPInfo]);

  // FIXED: Handle proxy port change - refetch data immediately
  const handleProxyPortChange = (newProxyPort) => {
    setProxyPort(newProxyPort);
    // Data will be fetched in the useEffect below
  };
  const measureStickyMetrics = useCallback(() => {
    const numberWidth = numberHeaderRef.current?.offsetWidth || 0;
    const targetWidth = targetHeaderRef.current?.offsetWidth || 0;
    const companyWidth = companyHeaderRef.current?.offsetWidth || 0;
    const avgWidth = avgHeaderRef.current?.offsetWidth || 0;

    return {
      number: { left: 0, width: numberWidth },
      target: { left: numberWidth, width: targetWidth },
      company: { left: numberWidth + targetWidth, width: companyWidth },
      avg: { left: numberWidth + targetWidth + companyWidth, width: avgWidth }
    };
  }, []);

  const applyStickyMetrics = useCallback(() => {
    const metrics = measureStickyMetrics();
    setStickyMetrics((prev) => {
      const keys = ['number', 'target', 'company', 'avg'];
      const changed = keys.some(
        (key) =>
          prev[key].left !== metrics[key].left || prev[key].width !== metrics[key].width
      );
      return changed ? metrics : prev;
    });
  }, [measureStickyMetrics]);

  const getStickyStyle = useCallback(
    (key) => {
      const metric = stickyMetrics[key];
      if (!metric) {
        return {};
      }

      const style = {
        left: `${metric.left}px`
      };

      if (metric.width) {
        const widthValue = `${metric.width}px`;
        style.width = widthValue;
        style.minWidth = widthValue;
        style.maxWidth = widthValue;
      }

      return style;
    },
    [stickyMetrics]
  );

  const handleSort = (column) => {
    if (sortColumn === column) {
      // Toggle direction if same column clicked again
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortColumn(column);
      setSortDirection('asc');
    }
  };
  const toggleGroup = useCallback((groupName) => {
    setExpandedGroups((prev) => ({
      ...prev,
      [groupName]: !prev[groupName],
    }));
  }, []);

  useEffect(() => {
    const groupsInView = new Set(
      statusData.map((row) => resolveNodeGroupName(row))
    );
    setExpandedGroups((prev) => {
      const next = { ...prev };
      groupsInView.forEach((groupName) => {
        if (typeof next[groupName] === 'undefined') {
          next[groupName] = true;
        }
      });
      return next;
    });
  }, [statusData, resolveNodeGroupName]);

  // Generate table rows - ENHANCED with IP info
  const generateTableRows = () => {
    const sortedData = [...statusData].sort((a, b) => {
      if (!sortColumn) return 0;

      if (sortColumn === 'company') {
        const ipA = a.target.split(':')[0];
        const ipB = b.target.split(':')[0];
        const companyA = (ipInfoMap[ipA]?.company || '').toLowerCase();
        const companyB = (ipInfoMap[ipB]?.company || '').toLowerCase();
        if (companyA < companyB) return sortDirection === 'asc' ? -1 : 1;
        if (companyA > companyB) return sortDirection === 'asc' ? 1 : -1;
        return 0;
      }

      if (sortColumn === 'avgRtt') {
        const valA = parseFloat(a.avgRtt) || 0;
        const valB = parseFloat(b.avgRtt) || 0;
        return sortDirection === 'asc' ? valA - valB : valB - valA;
      }

      return 0;
    });

    const grouped = sortedData.reduce((acc, row) => {
      const groupName = resolveNodeGroupName(row);
      if (!acc[groupName]) {
        acc[groupName] = [];
      }
      acc[groupName].push(row);
      return acc;
    }, {});

    const groupNames = Object.keys(grouped).sort((a, b) => a.localeCompare(b));
    let displayRowNumber = 0;
    const rendered = [];

    groupNames.forEach((groupName) => {
      const rows = grouped[groupName] || [];
      const isExpanded = expandedGroups[groupName] !== false;
      rendered.push(
        <tr key={`group-${groupName}`} className="status-group-row">
          <td colSpan={columnCount + 4} className="status-group-cell">
            <button
              type="button"
              className="status-group-toggle"
              onClick={() => toggleGroup(groupName)}
              aria-expanded={isExpanded}
              aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${groupName}`}
            >
              <span className="status-group-chevron">{isExpanded ? '▼' : '▶'}</span>
              <span className="status-group-name">{groupName}</span>
              <span className="status-group-meta">({rows.length} nodes)</span>
            </button>
          </td>
        </tr>
      );

      if (!isExpanded) return;

      rows.forEach((row, rowIndex) => {
      displayRowNumber += 1;
      const history = row.history || [];
      const displayHistory = [];
      for (let i = 0; i < columnCount; i++) {
        if (i < history.length) {
          displayHistory.push(history[i]);
        } else {
          displayHistory.push(null);
        }
      }

      // NEW: Get IP information for this target
      const targetIP = row.target.split(':')[0];
      const ipInfo = ipInfoMap[targetIP];
      const targetMetaText = String(ipInfo?.country || '').trim() || 'Unknown';

      rendered.push(
        <tr key={`${row.target}-${proxyPort}-${rowIndex}`} className="data-row">
          <td className="row-number fixed-column" style={getStickyStyle('number')}>
            {displayRowNumber}
          </td>

          {/* Target IP */}
          <td
            className="target-cell fixed-column"
            style={{
              ...getStickyStyle('target'),
              width: `${columnWidths.target}px`,
              minWidth: `${columnWidths.target}px`,
              maxWidth: `${columnWidths.target}px`
            }}
          >
            <div className="target-content">
              <span className="target-ip">{targetIP}</span>
              <span className="target-meta">
                {targetMetaText}
              </span>
            </div>
          </td>
          {/* Company (sticky) */}
          <td
            className="company-cell fixed-column"
            style={{
              ...getStickyStyle('company'),
              width: `${columnWidths.company}px`,
              minWidth: `${columnWidths.company}px`,
              maxWidth: `${columnWidths.company}px`
            }}
          >
            {ipInfo?.company || 'Unknown'}
          </td>
          {/* Average RTT (sticky) */}
          <td
            className="avg-rtt fixed-column"
            style={{
              ...getStickyStyle('avg'),
              width: `${columnWidths.avg}px`,
              minWidth: `${columnWidths.avg}px`,
              maxWidth: `${columnWidths.avg}px`
            }}
          >
            {row.avgRtt ? `${row.avgRtt} ms` : '-'}
          </td>

          {displayHistory.map((item, colIndex) => {
            const isEmpty = item === null;
            const rttValue = formatRTT(isEmpty ? null : (item.rtt || item.rtt_ms));
            const isHigh = !isEmpty && isHighRTT(item.rtt || item.rtt_ms);
            const status = item?.status || 'empty';
            const timestamp = item?.timestamp || item?.created_at;

            return (
              <td
                key={isEmpty ? `empty-${rowIndex}-${colIndex}` : `cell-${timestamp}-${rowIndex}-${colIndex}`}
                className={`data-cell ${isEmpty ? 'empty' : ''} ${isHigh ? 'high-rtt' : ''} status-${status}`}
                title={isEmpty ? 'Waiting for data' : `RTT: ${rttValue}ms | Status: ${status} | ${formatTimestampWithDate(timestamp)}`}
              >
                {status === 'failed' ? 'Null' : rttValue}
              </td>
            );
          })}
        </tr>
      );
    });
    });
    return rendered;
  };
  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    let frameId = window.requestAnimationFrame(() => {
      applyStickyMetrics();
    });

    return () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [statusData, columnCount, applyStickyMetrics]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    let resizeFrameId = null;

    const handleResize = () => {
      if (resizeFrameId) {
        window.cancelAnimationFrame(resizeFrameId);
      }

      resizeFrameId = window.requestAnimationFrame(() => {
        applyStickyMetrics();
      });
    };

    window.addEventListener('resize', handleResize);

    return () => {
      if (resizeFrameId) {
        window.cancelAnimationFrame(resizeFrameId);
      }
      window.removeEventListener('resize', handleResize);
    };
  }, [applyStickyMetrics]);

  useEffect(() => {
    applyStickyMetrics();
  }, [columnWidths, applyStickyMetrics]);
  // Manual packet send
  const sendPacket = async () => {
    try {
      setMeasurementStatus('manual_requested');
      setLoading(true);

      await axios.post('/api/measurements/refresh-ips', {}, { timeout: 10000 });

      await fetchTimelineData(true);

        const response = await axios.post(`/api/measurements/send-packet`, {}, {
        timeout: 5000,
      });

      console.log('✅ Packet send initiated:', response.data);

    } catch (err) {
      console.error('❌ Error sending packet:', err);
      setError('Failed to send packet. Please try again.');
      setShowError(true);
      setMeasurementStatus('idle');
    } finally {
      setLoading(false);
    }
  };

  // WebSocket connection
  useEffect(() => {
    let isMounted = true;

    const connectWebSocket = () => {
      if (!isMounted) return;

      try {
        if (ws.current) {
          ws.current.close();
        }

        // ✅ assign directly, don’t redeclare
        ws.current = new WebSocket(
          (window.location.protocol === 'https:' ? 'wss://' : 'ws://') +
          window.location.host +
          '/ws'
        );

        ws.current.onopen = () => {
          if (!isMounted) return;
          console.log('✅ WebSocket connected');
          setSocketStatus('connected');
          wsFailureCountRef.current = 0;
          clearTimeout(reconnectTimeoutRef.current);
        };

        ws.current.onmessage = (event) => {
          if (!isMounted) return;
          try {
            const data = JSON.parse(event.data);

            switch (data.type) {
              case 'connection_established':
                setSocketStatus('connected');
                break;

              case 'measurement_status':
                setMeasurementStatus(data.status);
                break;

              case 'data_updated':
                console.log('🔄 Data update received, refreshing...');
                clearTimeout(dataFetchTimeoutRef.current);
                dataFetchTimeoutRef.current = setTimeout(() => {
                  fetchTimelineData(true);
                }, 500);
                break;
              case 'ip_list_updated':
                console.log('📋 IP list update notification received, refreshing timeline...');
                fetchTimelineData(true);
                break;

              default:
                console.log('Unknown message type:', data.type);
            }
          } catch (error) {
            console.error('❌ Error parsing WebSocket message:', error);
          }
        };

        ws.current.onclose = (event) => {
          if (!isMounted) return;
          console.log('❌ WebSocket disconnected:', event.code, event.reason);
          setSocketStatus('disconnected');
          wsFailureCountRef.current += 1;

          clearTimeout(reconnectTimeoutRef.current);
          const retryDelay = wsFailureCountRef.current >= 3 ? 15000 : 5000;
          reconnectTimeoutRef.current = setTimeout(connectWebSocket, retryDelay);
        };

        ws.current.onerror = (error) => {
          if (!isMounted) return;
          console.error('❌ WebSocket error:', error);
          setSocketStatus('error');
        };

      } catch (error) {
        console.error('❌ WebSocket connection failed:', error);
        setSocketStatus('error');
        if (isMounted) {
          reconnectTimeoutRef.current = setTimeout(connectWebSocket, 5000);
        }
      }
    };


    connectWebSocket();

    const pingInterval = setInterval(() => {
      if (ws.current && ws.current.readyState === WebSocket.OPEN) {
        ws.current.send(JSON.stringify({ type: 'ping' }));
      }
    }, 30000);

    // Fallback refresh when websocket is unavailable.
    const fallbackPollInterval = setInterval(() => {
      if (!ws.current || ws.current.readyState !== WebSocket.OPEN) {
        fetchTimelineData(true);
      }
    }, 30000);

    return () => {
      isMounted = false;
      clearInterval(pingInterval);
      clearInterval(fallbackPollInterval);
      clearTimeout(reconnectTimeoutRef.current);
      clearTimeout(dataFetchTimeoutRef.current);
      if (ws.current) {
        ws.current.close();
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [fetchTimelineData]);

  // FIXED: Fetch data when proxy port changes
  useEffect(() => {
    fetchTimelineData();
  }, [proxyPort, fetchTimelineData]);

  // Close error message
  const closeError = () => {
    setShowError(false);
    setError(null);
  };

  // Format functions with safe replace handling
  const formatHeaderTime = useCallback((timestamp) => {
    if (!timestamp) {
      return '-';
    }

    return formatTimestampForDisplay(timestamp, { hour12: false });
  }, [formatTimestampForDisplay]);

  const formatRTT = (rtt) => {
    if (!rtt) return '-';
    if (typeof rtt === 'string') {
      // Safe replace - only remove 'ms' if it exists
      const cleaned = rtt.replace ? rtt.replace('ms', '') : rtt.toString();
      const match = cleaned.match(/(\d+\.?\d*)/);
      return match ? match[1] : cleaned;
    } else if (typeof rtt === 'number') {
      return rtt.toFixed(2);
    }
    return '-';
  };

  const isHighRTT = (rtt) => {
    if (!rtt) return false;

    let rttValue;
    if (typeof rtt === 'string') {
      // Safe string processing
      const cleaned = rtt.replace ? rtt.replace(/[^\d.]/g, '') : rtt;
      rttValue = parseFloat(cleaned) || 0;
    } else if (typeof rtt === 'number') {
      rttValue = rtt;
    } else {
      return false;
    }

    return rttValue > 1000;
  };
  const calculateAverageRTT = (history) => {
    if (!history || history.length === 0) return null;
    const validRtts = history
      .map(item => parseFloat(formatRTT(item?.rtt || item?.rtt_ms)))
      .filter(val => !isNaN(val));
    if (validRtts.length === 0) return null;
    const sum = validRtts.reduce((a, b) => a + b, 0);
    return (sum / validRtts.length).toFixed(2);
  };
  // Generate headers - Use actual available data from all rows
  const generateHeaders = () => {
    if (statusData.length === 0) {
      return Array(columnCount).fill(0).map((_, index) => (
        <th key={`empty-header-${index}`} className="time-header">
          ...
        </th>
      ));
    }

    // Collect ALL unique timestamps from ALL rows
    const allTimestamps = new Set();
    statusData.forEach(row => {
      (row.history || []).forEach(item => {
        if (item && (item.timestamp || item.created_at)) {
          allTimestamps.add(item.timestamp || item.created_at);
        }
      });
    });

    // Sort timestamps and take the most recent ones
    const sortedTimestamps = Array.from(allTimestamps).sort((a, b) =>
      new Date(b) - new Date(a)
    ).slice(0, columnCount);

    // If we don't have enough timestamps, fill with empty slots
    const displayTimestamps = [];
    for (let i = 0; i < columnCount; i++) {
      if (i < sortedTimestamps.length) {
        displayTimestamps.push(sortedTimestamps[i]);
      } else {
        displayTimestamps.push(null);
      }
    }

    return displayTimestamps.map((timestamp, index) => {
      const isEmpty = timestamp === null;

      return (
        <th
          key={isEmpty ? `empty-${index}` : `header-${timestamp}-${index}`}
          className="time-header"
          title={isEmpty ? 'Waiting for data' : formatTimestampWithDate(timestamp)}
        >
          {isEmpty ? '...' : formatHeaderTime(timestamp)}
        </th>
      );
    });
  };


  const getMeasurementStatusText = () => {
    switch (measurementStatus) {
      case 'manual_requested':
      case 'started':
        return 'Sending Packet...';
      case 'scheduled_started':
        return 'Auto-measuring...';
      case 'completed':
      case 'scheduled_completed':
        return 'Measurement Complete';
      case 'error':
        return 'Measurement Failed';
      case 'already_running':
        return 'Measurement in Progress';
      default:
        return 'Idle';
    }
  };

  const getSocketStatusColor = () => {
    switch (socketStatus) {
      case 'connected': return '#28a745';
      case 'disconnected': return '#dc3545';
      case 'error': return '#ffc107';
      default: return '#6c757d';
    }
  };

  return (
    <div className="status-table-container">
      <div className="table-header">
        <h2>Ping time to Big Nodes</h2>
        <div className="controls">
          <div className="control-group">
            <div className="control-item">
              <label htmlFor="proxyPort">Proxy: </label>
              <select
                id="proxyPort"
                value={proxyPort}
                onChange={(e) => handleProxyPortChange(e.target.value)}
                disabled={loading || ports.length === 0}
              >
                {ports.length === 0 ? (
                  <option value="">No active ports</option>
                ) : (
                  ports.map((port) => (
                    <option key={port.portNumber} value={String(port.portNumber)}>
                      {formatPortLabel(port)}
                    </option>
                  ))
                )}
              </select>
            </div>
            <div className="control-item">
              <label htmlFor="columnCount">Columns: </label>
              <select
                id="columnCount"
                value={columnCount}
                onChange={(e) => setColumnCount(Number(e.target.value))}
                disabled={loading}
              >
                <option value={10}>10</option>
                <option value={20}>20</option>
                <option value={30}>30</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
              </select>
            </div>
          </div>
          <div className="control-group column-width-group">
            <div className="control-item">
              <label htmlFor="targetWidth">Target width:</label>
              <input
                id="targetWidth"
                type="number"
                min={COLUMN_WIDTH_LIMITS.target.min}
                max={COLUMN_WIDTH_LIMITS.target.max}
                step={10}
                value={columnWidths.target}
                onChange={(e) => handleColumnWidthInputChange('target', e.target.value)}
                disabled={loading}
              />
              <span className="control-value">px</span>
            </div>
            <div className="control-item">
              <label htmlFor="companyWidth">Company width:</label>
              <input
                id="companyWidth"
                type="number"
                min={COLUMN_WIDTH_LIMITS.company.min}
                max={COLUMN_WIDTH_LIMITS.company.max}
                step={10}
                value={columnWidths.company}
                onChange={(e) => handleColumnWidthInputChange('company', e.target.value)}
                disabled={loading}
              />
              <span className="control-value">px</span>
            </div>
            <div className="control-item">
              <label htmlFor="avgWidth">RTT avg width:</label>
              <input
                id="avgWidth"
                type="number"
                min={COLUMN_WIDTH_LIMITS.avg.min}
                max={COLUMN_WIDTH_LIMITS.avg.max}
                step={5}
                value={columnWidths.avg}
                onChange={(e) => handleColumnWidthInputChange('avg', e.target.value)}
                disabled={loading}
              />
              <span className="control-value">px</span>
            </div>
          </div>

          <button
            onClick={sendPacket}
            disabled={loading || measurementStatus === 'manual_requested' || measurementStatus === 'started'}
            className="btn btn-success"
          >
            {measurementStatus === 'manual_requested' || measurementStatus === 'started' ? 'Sending Packet...' : 'Send Packet'}
          </button>

          <div className="status-info">
            <div>Auto-refresh: 3 min</div>
            <div>Status: {getMeasurementStatusText()}</div>
            <div>Targets: {statusData.length}</div>
            <div style={{ color: getSocketStatusColor() }}>
              ● {socketStatus.toUpperCase()}
            </div>
          </div>
        </div>
      </div>

      {error && showError && (
        <div className="error-message">
          <strong>Note:</strong> {error}
          <button className="error-close" onClick={closeError}>×</button>
        </div>
      )}

      <div className="table-scroll-container">
        <table className="rtt-table">
          <thead>
            <tr>
              <th
                ref={numberHeaderRef}
                className="fixed-column number-col sticky-header"
                style={{ ...getStickyStyle('number'), zIndex: 1000 }}
              >
                No
              </th>
              <th
                ref={targetHeaderRef}
                className="fixed-column target-col sticky-header"
                style={{
                  ...getStickyStyle('target'),
                  zIndex: 1000,
                  width: `${columnWidths.target}px`,
                  minWidth: `${columnWidths.target}px`,
                  maxWidth: `${columnWidths.target}px`
                }}
              >
                Target IP
              </th>
              <th
                ref={companyHeaderRef}
                className="fixed-column company-col sticky-header"
                style={{
                  ...getStickyStyle('company'),
                  zIndex: 1000,
                  width: `${columnWidths.company}px`,
                  minWidth: `${columnWidths.company}px`,
                  maxWidth: `${columnWidths.company}px`
                }}
                onClick={() => handleSort('company')}
              >
                Company {sortColumn === 'company' && (sortDirection === 'asc' ? '▲' : '▼')}
              </th>
              <th
                ref={avgHeaderRef}
                className="fixed-column avg-col sticky-header"
                style={{
                  ...getStickyStyle('avg'),
                  zIndex: 1000,
                  width: `${columnWidths.avg}px`,
                  minWidth: `${columnWidths.avg}px`,
                  maxWidth: `${columnWidths.avg}px`
                }}
                onClick={() => handleSort('avgRtt')}
              >
                RTT Avg {sortColumn === 'avgRtt' && (sortDirection === 'asc' ? '▲' : '▼')}
              </th>
              {generateHeaders()}
            </tr>
          </thead>
          <tbody>
            {statusData.length > 0 ? generateTableRows() : (
              <tr>
                <td colSpan={columnCount + 3} className="no-data">
                  {loading ? `Loading ${columnCount} columns for proxy ${proxyPort}...` : 'No measurement data available'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="table-footer">
        <p>
          Displaying: {statusData.length} targets × {columnCount} time points (Proxy: {proxyPort})
          {lastUpdate && ` • Last update: ${formatTimestampWithDate(lastUpdate)}`}
        </p>
      </div>
    </div>
  );
};

export default StatusTable;