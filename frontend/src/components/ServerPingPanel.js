import React, { useState, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import '../App.css';

const HISTORY_OPTIONS = [8, 12, 16, 20];
const PING_JOB_ROUNDS = 3;
const PING_JOB_ROUND_GAP_MS = 3000;
const PING_PROBE_TIMEOUT_MS = 15000;

/** Normalize path for probe: empty → `/`, always starts with `/`. */
function normalizeBrowserProbePath(raw) {
	const s = String(raw ?? '').trim();
	if (!s) return '/';
	if (!s.startsWith('/')) return `/${s}`;
	if (s.startsWith('//')) return `/${s.replace(/^\/+/, '')}`;
	return s.length > 512 ? s.slice(0, 512) : s;
}

/** Build http:// URL for a direct browser fetch (IPv6 bracketed). Path is path-only (e.g. `/` or `/health`). */
function buildHttpProbeUrl(ip, port, pathFragment) {
	const p = Number(port);
	const portNum = Number.isFinite(p) && p >= 1 && p <= 65535 ? p : 80;
	const s = String(ip || '').trim();
	if (!s) return null;
	const pathPart = normalizeBrowserProbePath(pathFragment);
	const authority = s.includes(':') ? `[${s}]` : s;
	return `http://${authority}:${portNum}${pathPart}`;
}

/**
 * Measure RTT from this browser to target over HTTP (opaque response; no CORS read).
 */
async function probeHttpFromBrowser(ip, port, pathFragment, timeoutMs = PING_PROBE_TIMEOUT_MS) {
	const url = buildHttpProbeUrl(ip, port, pathFragment);
	if (!url) {
		return { status: 'failed', rtt_ms: null, error_message: 'Invalid address' };
	}
	const t0 = performance.now();
	const ac = new AbortController();
	const tid = setTimeout(() => ac.abort(), timeoutMs);
	try {
		await fetch(url, {
			mode: 'no-cors',
			cache: 'no-store',
			signal: ac.signal,
		});
		const rtt = performance.now() - t0;
		return {
			status: 'success',
			rtt_ms: Math.round(rtt * 100) / 100,
			error_message: null,
		};
	} catch (e) {
		const name = e?.name;
		if (name === 'AbortError') {
			return { status: 'timeout', rtt_ms: null, error_message: 'Timeout' };
		}
		const msg = e?.message || 'Network error';
		return { status: 'failed', rtt_ms: null, error_message: String(msg).slice(0, 500) };
	} finally {
		clearTimeout(tid);
	}
}

function formatHistoryAgo(isoString, nowMs) {
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

const SORT_IP = 'ip';
const SORT_GROUP = 'group';
const SORT_LOCATION = 'location';
const SORT_CHECK = 'check';
const SORT_PORT = 'port';
const SORT_AVG = 'avg';

function serverAvgRttMs(server) {
	const hist = server.history || [];
	const vals = [];
	for (const h of hist) {
		if (h.status === 'success' && h.rtt_ms != null) {
			const v = Number(h.rtt_ms);
			if (!Number.isNaN(v) && v > 0) {
				vals.push(v);
			}
		}
	}
	if (vals.length === 0) {
		return null;
	}
	return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function formatServerAvgMs(server) {
	const n = serverAvgRttMs(server);
	return n == null ? '—' : n.toFixed(2);
}

function flattenServerRows(serverList) {
	const rows = [];
	Object.keys(serverList || {}).forEach((groupName) => {
		(serverList[groupName] || []).forEach((server) => {
			rows.push({ groupName, server });
		});
	});
	return rows;
}

function sortPingTableRows(rows, sortColumn, sortDir) {
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
			case SORT_CHECK: {
				const ca = a.server.checkType === 'ssh' ? 'ssh' : 'http';
				const cb = b.server.checkType === 'ssh' ? 'ssh' : 'http';
				c = ca.localeCompare(cb, undefined, { sensitivity: 'base' });
				break;
			}
			case SORT_PORT: {
				const pa = Number(a.server.port) || 80;
				const pb = Number(b.server.port) || 80;
				c = pa - pb;
				break;
			}
			case SORT_AVG: {
				const na = serverAvgRttMs(a.server);
				const nb = serverAvgRttMs(b.server);
				if (na == null && nb == null) {
					c = 0;
				} else if (na == null) {
					c = 1;
				} else if (nb == null) {
					c = -1;
				} else {
					c = na - nb;
				}
				break;
			}
			default:
				c = 0;
		}
		return c * dir;
	});
	return rows;
}

/**
 * Sidebar + list filter aligned with the logged-in visitor (GeoLite country + ASN when available).
 * @returns {{ region: string, viewerIsp: string|undefined } | null}
 */
function pickVisitorRegionMenu(visitorPayload, regionsList) {
	const raw = visitorPayload?.countryCode ? String(visitorPayload.countryCode).trim().toUpperCase() : '';
	if (!/^[A-Z]{2}$/.test(raw)) {
		return null;
	}
	const ro = (regionsList || []).find((r) => String(r.code || '').toUpperCase() === raw);
	const visIsp =
		visitorPayload?.isp != null && String(visitorPayload.isp).trim() !== ''
			? String(visitorPayload.isp).trim()
			: null;
	let viewerIsp;
	if (ro && Array.isArray(ro.isps) && visIsp) {
		const hit = ro.isps.find((x) => x.isp === visIsp);
		viewerIsp = hit ? visIsp : undefined;
	} else {
		viewerIsp = undefined;
	}
	return { region: raw, viewerIsp };
}

/** Basic client-side IP check; backend enforces full validation. */
function looksLikeIp(s) {
	const t = String(s || '').trim();
	if (!t) return false;
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
	const m = t.match(v4);
	if (m) {
		return m.slice(1, 5).every((p) => {
			const n = Number(p);
			return n >= 0 && n <= 255;
		});
	}
	if (t.includes(':')) {
		return t.length >= 3 && t.length <= 45;
	}
	return false;
}

function decodeURIComponentSafe(s) {
	const t = String(s ?? '').trim();
	if (!t) return '';
	try {
		return decodeURIComponent(t);
	} catch {
		return t;
	}
}

/**
 * Match URL segment to a group key in `servers` (exact, then case-insensitive).
 * @returns {string|null} matching group name or null
 */
function resolvePublicGroupKey(servers, slug) {
	if (slug == null || String(slug).trim() === '') {
		return null;
	}
	const decoded = decodeURIComponentSafe(slug);
	const keys = Object.keys(servers || {});
	if (keys.length === 0) {
		return null;
	}
	if (keys.includes(decoded)) {
		return decoded;
	}
	const lower = decoded.toLowerCase();
	const hit = keys.find((k) => k.toLowerCase() === lower);
	return hit || null;
}

const ServerPingPanel = ({
	privateSession = false,
	hideSessionChrome = false,
	publicMode = false,
	publicGroupSlug = null,
}) => {
	const navigate = useNavigate();
	const { authHeader, user, canPing, canManageServers, isAdmin, loadingMe, login, signup, logout } =
		useAuth();

	const canPingEffective = publicMode || canPing;
	const canManageEffective = publicMode || canManageServers;
	const [authModal, setAuthModal] = useState(null);
	const [authEmail, setAuthEmail] = useState('');
	const [authPassword, setAuthPassword] = useState('');
	const [authBusy, setAuthBusy] = useState(false);
	const [authMessage, setAuthMessage] = useState(null);

	const [serverList, setServerList] = useState({});
	const [knownGroups, setKnownGroups] = useState([]);
	const [geoDbAvailable, setGeoDbAvailable] = useState(true);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState(null);
	const [showError, setShowError] = useState(true);
	const [lastPingTime, setLastPingTime] = useState(null);
	const [nowTick, setNowTick] = useState(() => Date.now());
	const [historyColumns, setHistoryColumns] = useState(12);
	const [regions, setRegions] = useState([]);
	const [selectedRegion, setSelectedRegion] = useState('__none__');
	/** Omitted / undefined = all ISPs in the selected country; '__unknown__' = empty ISP; else exact stored viewer_isp */
	const [selectedViewerIsp, setSelectedViewerIsp] = useState(undefined);
	const [expandedRegionCodes, setExpandedRegionCodes] = useState(() => new Set());
	const [visitorInfo, setVisitorInfo] = useState(null);
	/** Public home: targets are owned by client IP; only allow add once visitor IP is known. */
	const canCreateServer = publicMode ? !!visitorInfo?.ip : canManageServers;
	const [addGroup, setAddGroup] = useState('');
	const [newGroupName, setNewGroupName] = useState('');
	const [addIp, setAddIp] = useState('');
	const [addCheckType, setAddCheckType] = useState('http');
	const [addPort, setAddPort] = useState('80');
	const [addProbeUri, setAddProbeUri] = useState('');
	const [adding, setAdding] = useState(false);
	const [addModalOpen, setAddModalOpen] = useState(false);
	const [editingServerId, setEditingServerId] = useState(null);
	const [editIp, setEditIp] = useState('');
	const [editLocation, setEditLocation] = useState('');
	const [editPort, setEditPort] = useState('');
	const [editCheckType, setEditCheckType] = useState('http');
	const [editProbeUri, setEditProbeUri] = useState('');
	const [rowSavingId, setRowSavingId] = useState(null);
	const [sortColumn, setSortColumn] = useState(SORT_IP);
	const [sortDir, setSortDir] = useState('asc');
	const [pingRunActive, setPingRunActive] = useState(false);
	const [pingRunProgress, setPingRunProgress] = useState({ current: 0, total: 0 });

	const tableBusy = loading || pingRunActive;

	const fetchPingRegions = useCallback(async () => {
		try {
			const response = await axios.get('/api/server-ping/regions');
			const list = response.data?.regions || [];
			setRegions(Array.isArray(list) ? list : []);
		} catch (err) {
			console.error('❌ Error fetching ping regions:', err);
			setRegions([]);
		}
	}, []);

	const fetchVisitorGeo = useCallback(async () => {
		try {
			const response = await axios.get('/api/server-ping/visitor');
			if (response.data?.success) {
				setVisitorInfo(response.data);
			} else {
				setVisitorInfo(null);
			}
		} catch (err) {
			console.error('❌ Error fetching visitor geo:', err);
			setVisitorInfo(null);
		}
	}, []);

	const fetchServerList = useCallback(async () => {
		try {
			const params = { region: selectedRegion, historyLimit: historyColumns };
			if (selectedViewerIsp !== undefined && selectedViewerIsp !== null && selectedViewerIsp !== '') {
				params.viewerIsp = selectedViewerIsp;
			}
			const response = await axios.get('/api/server-ping/list', {
				params,
				headers: { ...authHeader() },
			});
			if (response.data.success) {
				setServerList(response.data.servers || {});
				setKnownGroups(response.data.groups || []);
				if (typeof response.data.geoDbAvailable === 'boolean') {
					setGeoDbAvailable(response.data.geoDbAvailable);
				}
			}
		} catch (err) {
			console.error('❌ Error fetching server list:', err);
			setError('Failed to load server list');
		}
	}, [selectedRegion, selectedViewerIsp, historyColumns, authHeader]);

	useEffect(() => {
		fetchPingRegions();
		fetchVisitorGeo();
	}, [fetchPingRegions, fetchVisitorGeo]);

	useEffect(() => {
		if (!selectedRegion || selectedRegion === '__none__') return;
		setExpandedRegionCodes((prev) => {
			const n = new Set(prev);
			n.add(selectedRegion);
			return n;
		});
	}, [selectedRegion]);

	useEffect(() => {
		if (selectedRegion !== '__none__') return;
		const cc = visitorInfo?.countryCode ? String(visitorInfo.countryCode).toUpperCase() : '';
		const codes = regions.map((r) => String(r.code || '').toUpperCase());
		if (cc && codes.includes(cc)) {
			setSelectedRegion(cc);
			const ro = regions.find((r) => String(r.code || '').toUpperCase() === cc);
			const visIsp =
				visitorInfo?.isp != null && String(visitorInfo.isp).trim() !== ''
					? String(visitorInfo.isp).trim()
					: null;
			if (ro && Array.isArray(ro.isps) && visIsp) {
				const hit = ro.isps.find((x) => x.isp === visIsp);
				setSelectedViewerIsp(hit ? visIsp : undefined);
			} else {
				setSelectedViewerIsp(undefined);
			}
			return;
		}
		if (regions.length > 0) {
			const firstReal = regions.find((r) => r.code && r.code !== '__legacy__');
			if (firstReal) {
				setSelectedRegion(String(firstReal.code).toUpperCase());
				setSelectedViewerIsp(undefined);
				return;
			}
			setSelectedRegion(String(regions[0].code));
			setSelectedViewerIsp(undefined);
		}
	}, [regions, visitorInfo, selectedRegion]);

	const toggleRegionExpand = useCallback((code) => {
		setExpandedRegionCodes((prev) => {
			const n = new Set(prev);
			if (n.has(code)) n.delete(code);
			else n.add(code);
			return n;
		});
	}, []);

	useEffect(() => {
		const id = setInterval(() => setNowTick(Date.now()), 30_000);
		return () => clearInterval(id);
	}, []);

	useEffect(() => {
		if (loadingMe) return;
		fetchServerList();
	}, [fetchServerList, loadingMe]);

	useEffect(() => {
		if (addModalOpen && !canCreateServer) setAddModalOpen(false);
	}, [addModalOpen, canCreateServer]);

	const closeAddModal = useCallback(() => {
		setAddModalOpen(false);
		setAddGroup('');
		setNewGroupName('');
		setAddIp('');
		setAddCheckType('http');
		setAddPort('80');
		setAddProbeUri('');
	}, []);

	const openAddModal = useCallback(() => {
		if (!canCreateServer) return;
		setAddGroup(publicGroupResolvedName || '');
		setNewGroupName('');
		setAddIp('');
		setAddCheckType('http');
		setAddPort('80');
		setAddProbeUri('');
		setError(null);
		setAddModalOpen(true);
	}, [canCreateServer, publicGroupResolvedName]);

	useEffect(() => {
		if (!addModalOpen) return undefined;
		const onKey = (e) => {
			if (e.key === 'Escape' && !adding) {
				closeAddModal();
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [addModalOpen, adding, closeAddModal]);

	const beginEditRow = useCallback(
		(server) => {
			if (!isAdmin) return;
			const ct = server.checkType === 'ssh' ? 'ssh' : 'http';
			setEditingServerId(server.id);
			setEditIp(server.ip);
			setEditLocation(server.location);
			setEditCheckType(ct);
			const p =
				ct === 'ssh'
					? Number(server.sshPort) || 22
					: Number(server.targetPort ?? server.port) || 80;
			setEditPort(String(p));
			setEditProbeUri(server.httpProbePath != null ? String(server.httpProbePath) : '');
			setError(null);
		},
		[isAdmin]
	);

	const saveEditedRow = useCallback(
		async (server) => {
			const ipNorm = editIp.trim();
			const loc = editLocation.trim();
			const portNum = parseInt(String(editPort).trim(), 10);
			if (!ipNorm) {
				setError('IP address cannot be empty');
				setShowError(true);
				return;
			}
			if (!looksLikeIp(ipNorm)) {
				setError('Enter a valid IPv4 or IPv6 address');
				setShowError(true);
				return;
			}
			if (!loc) {
				setError('Location cannot be empty');
				setShowError(true);
				return;
			}
			if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
				setError('Port must be 1–65535');
				setShowError(true);
				return;
			}
			const origCt = server.checkType === 'ssh' ? 'ssh' : 'http';
			const origPortForType =
				origCt === 'ssh'
					? Number(server.sshPort) || 22
					: Number(server.targetPort ?? server.port) || 80;
			const payload = {};
			if (ipNorm !== server.ip) {
				payload.ip = ipNorm;
			}
			if (loc !== server.location) {
				payload.location = loc;
			}
			if (editCheckType !== origCt) {
				payload.checkType = editCheckType;
			}
			if (portNum !== origPortForType || editCheckType !== origCt) {
				payload.port = portNum;
			}
			const origPath = server.httpProbePath != null ? String(server.httpProbePath) : '';
			if (isAdmin && editCheckType === 'http' && editProbeUri.trim() !== origPath.trim()) {
				payload.httpProbePath = editProbeUri.trim();
			}
			if (Object.keys(payload).length === 0) {
				setEditingServerId(null);
				return;
			}
			try {
				setRowSavingId(server.id);
				setError(null);
				setShowError(true);
				await axios.patch(`/api/server-ping/servers/${server.id}`, payload, {
					headers: { ...authHeader() },
				});
				await fetchServerList();
				setEditingServerId(null);
			} catch (err) {
				setError(err.response?.data?.error || 'Failed to update server');
				setShowError(true);
			} finally {
				setRowSavingId(null);
			}
		},
		[editIp, editLocation, editPort, editCheckType, editProbeUri, isAdmin, fetchServerList, authHeader]
	);

	const handleAddServer = async (e) => {
		e.preventDefault();
		if (!canCreateServer) return;
		setAdding(true);
		setError(null);
		setShowError(true);
		try {
			const portNum = parseInt(String(addPort).trim(), 10);
			const portToSend = Number.isInteger(portNum) ? portNum : addCheckType === 'ssh' ? 22 : 80;
			if (portToSend < 1 || portToSend > 65535) {
				setError('Port must be between 1 and 65535');
				setAdding(false);
				return;
			}
			const body = {
				groupName: addGroup,
				newGroupName: addGroup === '__new__' ? newGroupName.trim() : undefined,
				ip: addIp.trim(),
				checkType: addCheckType,
				port: portToSend,
			};
			if (isAdmin && addCheckType === 'http') {
				body.httpProbePath = addProbeUri.trim();
			}
			await axios.post('/api/server-ping/servers', body, { headers: { ...authHeader() } });
			closeAddModal();
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
			await axios.delete(`/api/server-ping/servers/${id}`, {
				headers: { ...authHeader() },
			});
			setEditingServerId((cur) => (cur === id ? null : cur));
			await fetchServerList();
		} catch (err) {
			setError(err.response?.data?.error || 'Failed to delete server');
		} finally {
			setLoading(false);
		}
	};

	const closeError = () => {
		setShowError(false);
	};

	const canEditServer = useCallback(
		(server) => {
			if (!canManageEffective) return false;
			if (isAdmin) return true;
			if (server.userId != null && user?.id != null && Number(server.userId) === Number(user.id)) {
				return true;
			}
			const vip = visitorInfo?.ip;
			if (server.clientIp != null && vip != null && String(server.clientIp) === String(vip)) {
				return true;
			}
			return false;
		},
		[canManageEffective, isAdmin, user?.id, visitorInfo?.ip]
	);

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
		if (status === 'pending') return 'data-cell status-pending';
		if (status === 'failed' || status === 'error' || status === 'proxy_rejected') {
			return 'data-cell status-failed';
		}
		return 'data-cell empty';
	};

	const isHighRtt = (rttMs) => {
		const n = Number(rttMs);
		return !Number.isNaN(n) && n > 1000;
	};

	const { displayServerList, publicGroupResolvedName, publicGroupUnknown } = useMemo(() => {
		if (!publicMode || publicGroupSlug == null || String(publicGroupSlug).trim() === '') {
			return {
				displayServerList: serverList,
				publicGroupResolvedName: null,
				publicGroupUnknown: false,
			};
		}
		const keys = Object.keys(serverList || {});
		if (keys.length === 0) {
			return {
				displayServerList: {},
				publicGroupResolvedName: null,
				publicGroupUnknown: false,
			};
		}
		const key = resolvePublicGroupKey(serverList, publicGroupSlug);
		if (!key) {
			return {
				displayServerList: {},
				publicGroupResolvedName: null,
				publicGroupUnknown: true,
			};
		}
		return {
			displayServerList: { [key]: serverList[key] || [] },
			publicGroupResolvedName: key,
			publicGroupUnknown: false,
		};
	}, [publicMode, publicGroupSlug, serverList]);

	const totalServers = Object.values(displayServerList).reduce((sum, servers) => sum + servers.length, 0);

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

	/** Admin-only columns: Check, Port, Actions */
	const showAdminTableColumns = !!isAdmin;

	useEffect(() => {
		if (!showAdminTableColumns && (sortColumn === SORT_CHECK || sortColumn === SORT_PORT)) {
			setSortColumn(SORT_IP);
			setSortDir('asc');
		}
	}, [showAdminTableColumns, sortColumn]);

	useEffect(() => {
		if (!showAdminTableColumns) {
			setEditingServerId(null);
		}
	}, [showAdminTableColumns]);

	const tableRows = useMemo(() => {
		const rows = flattenServerRows(displayServerList);
		return sortPingTableRows(rows, sortColumn, sortDir);
	}, [displayServerList, sortColumn, sortDir]);

	const mergeHistoryAfterPing = useCallback((groupName, serverId, historyEntry) => {
		setServerList((prev) => {
			const list = prev[groupName];
			if (!list) return prev;
			const idx = list.findIndex((s) => Number(s.id) === Number(serverId));
			if (idx < 0) return prev;
			const s = list[idx];
			const prevH = s.history || [];
			const rest =
				prevH.length > 0 && prevH[0].status === 'pending' ? prevH.slice(1) : prevH;
			const h = [historyEntry, ...rest].slice(0, historyColumns);
			const nextList = [...list];
			nextList[idx] = { ...s, history: h };
			return { ...prev, [groupName]: nextList };
		});
	}, [historyColumns]);

	const pingPublicAll = useCallback(async () => {
		if (!canPingEffective) return;
		setError(null);
		setShowError(true);
		setPingRunActive(true);

		const headers = { ...authHeader(), 'Content-Type': 'application/json' };

		let vi = null;
		let regList = [];
		try {
			const [vr, rr] = await Promise.all([
				axios.get('/api/server-ping/visitor'),
				axios.get('/api/server-ping/regions'),
			]);
			if (vr.data?.success) {
				vi = vr.data;
				setVisitorInfo(vi);
			}
			regList = Array.isArray(rr.data?.regions) ? rr.data.regions : [];
			setRegions(regList);
		} catch (e) {
			console.error('❌ visitor/regions refresh:', e);
		}

		const picked = vi ? pickVisitorRegionMenu(vi, regList) : null;
		let nextRegion = selectedRegion;
		let nextIsp = selectedViewerIsp;
		if (picked) {
			nextRegion = picked.region;
			nextIsp = picked.viewerIsp;
			setSelectedRegion(picked.region);
			setSelectedViewerIsp(picked.viewerIsp);
			setExpandedRegionCodes((prev) => {
				const n = new Set(prev);
				n.add(picked.region);
				return n;
			});
		}

		const listParams = { region: nextRegion, historyLimit: historyColumns };
		if (nextIsp !== undefined && nextIsp !== null && nextIsp !== '') {
			listParams.viewerIsp = nextIsp;
		}

		let listRes;
		try {
			listRes = await axios.get('/api/server-ping/list', {
				params: listParams,
				headers: { ...authHeader() },
			});
		} catch (err) {
			console.error('❌ Error loading list for ping:', err);
			setError('Failed to load server list');
			setPingRunActive(false);
			setPingRunProgress({ current: 0, total: 0 });
			return;
		}

		if (!listRes.data?.success) {
			setError(listRes.data?.error || 'Failed to load server list');
			setPingRunActive(false);
			setPingRunProgress({ current: 0, total: 0 });
			return;
		}

		const servers = listRes.data.servers || {};
		setServerList(servers);
		setKnownGroups(listRes.data.groups || []);
		if (typeof listRes.data.geoDbAvailable === 'boolean') {
			setGeoDbAvailable(listRes.data.geoDbAvailable);
		}

		let pingServers = servers;
		if (publicMode && publicGroupSlug != null && String(publicGroupSlug).trim() !== '') {
			const gKey = resolvePublicGroupKey(servers, publicGroupSlug);
			if (!gKey) {
				setError(
					`Group not found: ${decodeURIComponentSafe(publicGroupSlug)}. Use the home page to browse all groups.`
				);
				setPingRunActive(false);
				setPingRunProgress({ current: 0, total: 0 });
				return;
			}
			pingServers = { [gKey]: servers[gKey] || [] };
		}

		const rows = sortPingTableRows(flattenServerRows(pingServers), sortColumn, sortDir);
		if (rows.length === 0) {
			const groupScoped =
				publicMode && publicGroupSlug != null && String(publicGroupSlug).trim() !== '';
			setError(
				groupScoped
					? 'No servers in this group for the current country/ISP view. Adjust the sidebar or add servers.'
					: 'No servers to check for this country/ISP view. Adjust the sidebar or add servers.'
			);
			setPingRunActive(false);
			setPingRunProgress({ current: 0, total: 0 });
			return;
		}

		const totalUnits = rows.length * PING_JOB_ROUNDS;
		setPingRunProgress({ current: 0, total: totalUnits });

		try {
			const allResults = [];

			const probeOneRow = async ({ groupName, server }) => {
				const sid = Number(server.id);
				let m;
				if (server.checkType === 'ssh') {
					m = {
						status: 'failed',
						rtt_ms: null,
						error_message:
							'SSH cannot be checked from the browser; switch the row to HTTP or use a server-side check.',
					};
				} else {
					const port = Number(server.targetPort ?? server.port) || 80;
					const pathFrag =
						server.httpProbePath != null && String(server.httpProbePath).trim() !== ''
							? String(server.httpProbePath).trim()
							: '';
					m = await probeHttpFromBrowser(server.ip, port, pathFrag);
				}
				const ts = new Date().toISOString();
				const historyEntry = {
					status: m.status,
					rtt_ms: m.rtt_ms,
					error_message: m.error_message,
					created_at: ts,
					timestamp: ts,
				};
				return {
					groupName,
					serverId: sid,
					historyEntry,
					persist: {
						serverId: sid,
						status: m.status,
						rtt_ms: m.rtt_ms,
						error_message: m.error_message,
					},
				};
			};

			for (let round = 0; round < PING_JOB_ROUNDS; round += 1) {
				if (round > 0 && PING_JOB_ROUND_GAP_MS > 0) {
					await new Promise((r) => setTimeout(r, PING_JOB_ROUND_GAP_MS));
				}
				const roundResults = await Promise.all(rows.map((row) => probeOneRow(row)));
				for (const r of roundResults) {
					mergeHistoryAfterPing(r.groupName, r.serverId, r.historyEntry);
				}
				allResults.push(...roundResults.map((r) => r.persist));
				setPingRunProgress({ current: (round + 1) * rows.length, total: totalUnits });
			}

			for (let i = 0; i < allResults.length; i += 250) {
				const chunk = allResults.slice(i, i + 250);
				await axios.post('/api/server-ping/ping/client-results', { results: chunk }, { headers });
			}
			await fetchPingRegions();
			await fetchServerList();
			setLastPingTime(new Date());
		} catch (err) {
			console.error('❌ Error during browser ping:', err);
			setError(err.response?.data?.error || err.message || 'Failed to ping servers');
		} finally {
			setPingRunActive(false);
			setPingRunProgress({ current: 0, total: 0 });
		}
	}, [
		authHeader,
		fetchPingRegions,
		fetchServerList,
		mergeHistoryAfterPing,
		canPingEffective,
		selectedRegion,
		selectedViewerIsp,
		historyColumns,
		sortColumn,
		sortDir,
		publicMode,
		publicGroupSlug,
	]);

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

	const visitorCountry = visitorInfo?.countryName || '—';
	const visitorIsp =
		visitorInfo?.isp ||
		(visitorInfo && visitorInfo.asnDbPresent === false
			? 'ISP: add GeoLite2-ASN.mmdb (optional)'
			: '—');

	return (
		<div className="status-table-container server-ping-with-regions">
			<aside className="server-ping-region-sidebar" aria-label="Regions from past checks">
				<div className="server-ping-visitor-card">
					<div className="server-ping-visitor-card-label">Your connection</div>
					<div className="server-ping-visitor-country">{visitorCountry}</div>
					<div className="server-ping-visitor-isp" title={visitorInfo?.isp || ''}>
						{visitorIsp}
					</div>
					{visitorInfo?.ip ? (
						<div className="server-ping-visitor-ip" title="Your public IP as seen by this server">
							{visitorInfo.ip}
						</div>
					) : null}
				</div>
				<div className="server-ping-region-nav-label">History by viewer region</div>
				<nav className="server-ping-region-nav server-ping-region-tree" aria-label="Regions tree">
					{regions.map((r) => {
						const code = String(r.code || '');
						const isps = Array.isArray(r.isps) ? r.isps : [];
						const hasIspChildren = isps.length > 0;
						const expanded = expandedRegionCodes.has(code);
						const you =
							visitorInfo?.countryCode &&
							String(visitorInfo.countryCode).toUpperCase() === code.toUpperCase();
						const countryActive =
							selectedRegion === code && (selectedViewerIsp === undefined || selectedViewerIsp === null);

						if (!hasIspChildren) {
							return (
								<button
									key={code}
									type="button"
									className={`server-ping-region-item${countryActive ? ' server-ping-region-item--active' : ''}`}
									onClick={() => {
										setSelectedRegion(code);
										setSelectedViewerIsp(undefined);
									}}
								>
									<span className="server-ping-region-item-name">{r.name || code}</span>
									{you ? <span className="server-ping-region-you">you</span> : null}
									{r.count != null ? (
										<span className="server-ping-region-count">{r.count}</span>
									) : null}
								</button>
							);
						}

						return (
							<div key={code} className="server-ping-region-country-block">
								<div className="server-ping-region-country-row">
									<button
										type="button"
										className="server-ping-region-toggle"
										aria-expanded={expanded}
										aria-label={expanded ? 'Collapse networks' : 'Expand networks'}
										onClick={() => toggleRegionExpand(code)}
									>
										<span className="server-ping-region-toggle-glyph" aria-hidden>
											{expanded ? '▼' : '▶'}
										</span>
									</button>
									<button
										type="button"
										className={`server-ping-region-item server-ping-region-item--country${countryActive ? ' server-ping-region-item--active' : ''}`}
										onClick={() => {
											setSelectedRegion(code);
											setSelectedViewerIsp(undefined);
										}}
									>
										<span className="server-ping-region-item-name">{r.name || code}</span>
										{you ? <span className="server-ping-region-you">you</span> : null}
										{r.count != null ? (
											<span className="server-ping-region-count">{r.count}</span>
										) : null}
									</button>
								</div>
								{expanded ? (
									<div className="server-ping-region-isp-list" role="group" aria-label={`Networks in ${r.name || code}`}>
										{isps.map((row) => {
											const ispKey = row.isp == null ? '__unknown__' : String(row.isp);
											const ispLabel = row.isp == null || String(row.isp).trim() === '' ? 'Unknown network' : String(row.isp);
											const ispActive =
												selectedRegion === code &&
												(row.isp == null
													? selectedViewerIsp === '__unknown__'
													: selectedViewerIsp === row.isp);
											return (
												<button
													key={`${code}:${ispKey}`}
													type="button"
													className={`server-ping-region-item server-ping-region-item--isp${ispActive ? ' server-ping-region-item--active' : ''}`}
													onClick={() => {
														setSelectedRegion(code);
														setSelectedViewerIsp(row.isp == null ? '__unknown__' : String(row.isp));
													}}
												>
													<span className="server-ping-region-item-name">{ispLabel}</span>
													{row.count != null ? (
														<span className="server-ping-region-count">{row.count}</span>
													) : null}
												</button>
											);
										})}
									</div>
								) : null}
							</div>
						);
					})}
				</nav>
			</aside>
			<div className="server-ping-region-main">
					<div className="table-header">
					<div className="server-ping-header-row" style={{ flexWrap: 'wrap', gap: '0.75rem' }}>
						<h2 style={{ margin: 0 }}>Server ping</h2>
						{publicMode && publicGroupSlug != null && String(publicGroupSlug).trim() !== '' ? (
							publicGroupUnknown && !loading ? (
								<p
									className="server-ping-public-group-banner server-ping-public-group-banner--warn"
									style={{ margin: 0, flex: '1 1 100%' }}
								>
									Unknown group <strong>{decodeURIComponentSafe(publicGroupSlug)}</strong>.{' '}
									<Link to="/">View all groups</Link>
								</p>
							) : publicGroupResolvedName ? (
								<p className="server-ping-public-group-banner" style={{ margin: 0, flex: '1 1 100%' }}>
									Group <strong>{publicGroupResolvedName}</strong>
									{' · '}
									<Link to="/">All groups</Link>
								</p>
							) : null
						) : null}
						{publicMode ? (
							<div style={{ marginLeft: 'auto', flex: '1 1 auto' }} aria-hidden="true" />
						) : !hideSessionChrome ? (
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
												Operator tools
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
						<button
							type="button"
							className="btn btn-primary"
							onClick={openAddModal}
							disabled={tableBusy || adding || !canCreateServer}
							title={
								!canCreateServer
									? publicMode
										? 'Your client IP must be resolved before you can add a server'
										: 'Unable to add targets'
									: undefined
							}
						>
							New
						</button>
					</div>
					<div className="controls server-ping-toolbar">
						{isAdmin ? (
							<div className="control-group">
								<div className="control-item">
									<label htmlFor="histCols">History cols: </label>
									<select
										id="histCols"
										value={historyColumns}
										onChange={(e) => setHistoryColumns(Number(e.target.value))}
										disabled={tableBusy}
									>
										{HISTORY_OPTIONS.map((n) => (
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
						{canPingEffective ? (
							<button
								type="button"
								onClick={pingPublicAll}
								disabled={pingRunActive || totalServers === 0}
								className="btn btn-success"
							>
								{pingRunActive
									? `Checking ${pingRunProgress.current}/${pingRunProgress.total}…`
									: 'Public ping'}
							</button>
						) : null}
					</div>

					{!geoDbAvailable && (
						<div className="error-message" style={{ marginTop: '0.5rem' }}>
							<strong>GeoIP:</strong> GeoLite2-Country.mmdb not installed — new servers get location &quot;Unknown&quot;.
							Run <code>backend/scripts/download-maxmind-country.sh</code> with MAXMIND_LICENSE_KEY.
						</div>
					)}
				</div>

				{!publicMode && !privateSession && authModal && (
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
							aria-labelledby="server-ping-auth-title"
							onClick={(e) => e.stopPropagation()}
							style={{ maxWidth: '22rem' }}
						>
							<div className="server-ping-modal-header">
								<h2 id="server-ping-auth-title">{authModal === 'signup' ? 'Sign up' : 'Sign in'}</h2>
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
									<label htmlFor="spAuthEmail">Email</label>
									<input
										id="spAuthEmail"
										type="email"
										autoComplete="email"
										value={authEmail}
										onChange={(e) => setAuthEmail(e.target.value)}
										disabled={authBusy}
										required
									/>
								</div>
								<div className="server-ping-modal-field">
									<label htmlFor="spAuthPass">Password</label>
									<input
										id="spAuthPass"
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

				{addModalOpen && (
					<div
						className="server-ping-modal-backdrop"
						role="presentation"
						onClick={() => {
							if (!adding) closeAddModal();
						}}
					>
						<div
							className="server-ping-modal"
							role="dialog"
							aria-modal="true"
							aria-labelledby="server-ping-add-modal-title"
							onClick={(e) => e.stopPropagation()}
						>
							<div className="server-ping-modal-header">
								<h2 id="server-ping-add-modal-title">Add server</h2>
								<button
									type="button"
									className="server-ping-modal-close"
									onClick={closeAddModal}
									disabled={adding}
									aria-label="Close"
								>
									×
								</button>
							</div>
							<form className="server-ping-modal-form" onSubmit={handleAddServer}>
								{!geoDbAvailable && (
									<p className="server-ping-modal-geo-hint">
										GeoIP database missing — location may show as &quot;Unknown&quot;.
									</p>
								)}
								<div className="server-ping-modal-field">
									<label htmlFor="spGroup">Group</label>
									<select
										id="spGroup"
										value={addGroup}
										onChange={(e) => setAddGroup(e.target.value)}
										disabled={adding}
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
									<div className="server-ping-modal-field">
										<label htmlFor="spNewG">New group name</label>
										<input
											id="spNewG"
											value={newGroupName}
											onChange={(e) => setNewGroupName(e.target.value)}
											placeholder="e.g. Delta"
											disabled={adding}
										/>
									</div>
								)}
								<div className="server-ping-modal-field">
									<label htmlFor="spIp">IP address</label>
									<input
										id="spIp"
										value={addIp}
										onChange={(e) => setAddIp(e.target.value)}
										placeholder="IPv4 / IPv6 (country from MMDB)"
										disabled={adding}
									/>
								</div>
								<div className="server-ping-modal-field">
									<label htmlFor="spCheckType">Target check</label>
									<select
										id="spCheckType"
										value={addCheckType}
										onChange={(e) => {
											const v = e.target.value;
											setAddCheckType(v);
											if (v === 'ssh') {
												setAddPort((prev) => (prev === '80' || prev === '' ? '22' : prev));
											} else if (v === 'http') {
												setAddPort((prev) => (prev === '22' || prev === '' ? '80' : prev));
											}
										}}
										disabled={adding}
									>
										<option value="http">HTTP (TCP to service port)</option>
										<option value="ssh">SSH (TCP to SSH port)</option>
									</select>
								</div>
								<div className="server-ping-modal-field">
									<label htmlFor="spPort">{addCheckType === 'ssh' ? 'SSH port' : 'HTTP port'}</label>
									<input
										id="spPort"
										type="number"
										min={1}
										max={65535}
										value={addPort}
										onChange={(e) => setAddPort(e.target.value)}
										placeholder={addCheckType === 'ssh' ? '22' : '80'}
										disabled={adding}
									/>
								</div>
								{isAdmin && addCheckType === 'http' ? (
									<div className="server-ping-modal-field">
										<label htmlFor="spProbeUri">HTTP path (URI)</label>
										<input
											id="spProbeUri"
											value={addProbeUri}
											onChange={(e) => setAddProbeUri(e.target.value)}
											placeholder="/ or /health"
											disabled={adding}
											autoComplete="off"
											spellCheck={false}
										/>
										<p className="server-ping-modal-field-hint">Path only; empty uses /</p>
									</div>
								) : null}
								<div className="server-ping-modal-actions">
									<button
										type="button"
										className="btn server-ping-modal-btn-cancel"
										onClick={closeAddModal}
										disabled={adding}
									>
										Cancel
									</button>
									<button
										type="submit"
										className="btn btn-primary"
										disabled={
											adding || !addGroup || (addGroup === '__new__' && !newGroupName.trim())
										}
									>
										{adding ? 'Adding…' : 'Add server'}
									</button>
								</div>
							</form>
						</div>
					</div>
				)}

				{error && showError && (
					<div className="error-message">
						<strong>Error:</strong> {error}
						<button type="button" className="error-close" onClick={closeError}>
							×
						</button>
					</div>
				)}

				<div className="table-scroll-container">
					{tableRows.length > 0 ? (
						<table
							className={`rtt-table server-ping-flat-table${showAdminTableColumns ? '' : ' server-ping-compact-grid'}`}
							style={{ margin: 0 }}
						>
							<colgroup>
								<col className="server-ping-col-ip" />
								<col className="server-ping-col-group" />
								<col className="server-ping-col-location" />
								{showAdminTableColumns ? (
									<>
										<col className="server-ping-col-check" />
										<col className="server-ping-col-port" />
										<col className="server-ping-col-uri" />
									</>
								) : null}
								<col className="server-ping-col-avg" />
								{showAdminTableColumns ? <col className="server-ping-col-actions" /> : null}
								{Array.from({ length: historyColumns }, (_, hi) => (
									<col key={`ping-hist-${hi}`} className="server-ping-col-history" />
								))}
							</colgroup>
							<thead>
								<tr>
									{renderSortableTh(SORT_IP, 'IP', { textAlign: 'left' }, 'server-ping-fth server-ping-fth-1')}
									{renderSortableTh(SORT_GROUP, 'Group', { textAlign: 'left' }, 'server-ping-fth server-ping-fth-2')}
									{renderSortableTh(SORT_LOCATION, 'Location', { textAlign: 'left' }, 'server-ping-fth server-ping-fth-3')}
									{showAdminTableColumns ? (
										<>
											{renderSortableTh(SORT_CHECK, 'Check', { textAlign: 'left' }, 'server-ping-fth server-ping-fth-4')}
											{renderSortableTh(SORT_PORT, 'Port', { textAlign: 'left' }, 'server-ping-fth server-ping-fth-5')}
											<th
												className="server-ping-fth server-ping-fth-uri"
												style={{ textAlign: 'left' }}
												scope="col"
											>
												URI
											</th>
										</>
									) : null}
									{renderSortableTh(
										SORT_AVG,
										'Avg (ms)',
										{ textAlign: 'right' },
										showAdminTableColumns
											? 'server-ping-fth server-ping-fth-6'
											: 'server-ping-fth server-ping-fth-6-compact'
									)}
									{showAdminTableColumns ? (
										<th className="server-ping-fth server-ping-fth-7" style={{ textAlign: 'center' }}>
											Actions
										</th>
									) : null}
									<th
										colSpan={historyColumns}
										className="server-ping-timeline-th server-ping-history-colspan-th"
										scope="colgroup"
									>
										History
									</th>
								</tr>
							</thead>
							<tbody>
								{tableRows.map(({ groupName, server }) => {
									const hist = server.history || [];
									const latest = hist.length ? hist[0] : null;
									const errorMsg = latest?.error_message || '';
									const portVal = Number(server.port) || 80;
									const checkLabel = server.checkType === 'ssh' ? 'SSH' : 'HTTP';
									const isEditing = editingServerId === server.id;
									const rowBusy = rowSavingId === server.id;
									const anotherRowEditing = editingServerId != null && editingServerId !== server.id;
									const avgStr = formatServerAvgMs(server);
									const adminClientIpTip = isAdmin
										? `Client IP: ${server.clientIp != null && server.clientIp !== '' ? server.clientIp : '—'}`
										: null;
									const cellTitleWithClient = (base) => {
										if (!adminClientIpTip) return base || undefined;
										const b = base && String(base).trim();
										return b ? `${b} · ${adminClientIpTip}` : adminClientIpTip;
									};
									return (
										<tr key={server.id} className="data-row server-ping-data-row">
											<td
												className="server-ping-ip-plain server-ping-ftd server-ping-ftd-1"
												style={{ textAlign: 'left', padding: '0.5rem' }}
												title={cellTitleWithClient(errorMsg || undefined)}
											>
												{isEditing && showAdminTableColumns ? (
													<input
														className="server-ping-table-input server-ping-ip-edit"
														value={editIp}
														onChange={(e) => setEditIp(e.target.value)}
														disabled={tableBusy || rowBusy}
														aria-label="IP address"
														autoComplete="off"
													/>
												) : (
													server.ip
												)}
											</td>
											<td
												className="server-ping-ftd server-ping-ftd-2"
												style={{ textAlign: 'left', padding: '0.5rem' }}
												title={cellTitleWithClient(undefined)}
											>
												<span className="server-ping-readonly-text">{groupName}</span>
											</td>
											<td
												className="server-ping-ftd server-ping-ftd-3"
												style={{ textAlign: 'left', padding: '0.5rem' }}
												title={cellTitleWithClient(undefined)}
											>
												{isEditing && showAdminTableColumns ? (
													<input
														className="server-ping-table-input"
														value={editLocation}
														onChange={(e) => setEditLocation(e.target.value)}
														disabled={tableBusy || rowBusy}
														aria-label={`Location for ${server.ip}`}
													/>
												) : (
													<span className="server-ping-readonly-text">{server.location}</span>
												)}
											</td>
											{showAdminTableColumns ? (
												<>
													<td
														className="server-ping-ftd server-ping-ftd-4"
														style={{ textAlign: 'left', padding: '0.5rem', verticalAlign: 'middle' }}
														title={cellTitleWithClient(undefined)}
													>
														{isEditing ? (
															<select
																className="server-ping-table-input"
																value={editCheckType}
																onChange={(e) => {
																	const v = e.target.value;
																	setEditCheckType(v);
																	if (v === 'ssh') {
																		setEditPort(String(Number(server.sshPort) || 22));
																	} else {
																		setEditPort(String(Number(server.targetPort ?? server.port) || 80));
																	}
																}}
																disabled={tableBusy || rowBusy}
																aria-label={`Check type for ${server.ip}`}
															>
																<option value="http">HTTP</option>
																<option value="ssh">SSH</option>
															</select>
														) : (
															<span className="server-ping-readonly-text">{checkLabel}</span>
														)}
													</td>
													<td
														className="server-ping-ftd server-ping-ftd-5"
														style={{ padding: '0.5rem', verticalAlign: 'middle' }}
														title={cellTitleWithClient(undefined)}
													>
														{isEditing ? (
															<input
																type="number"
																min={1}
																max={65535}
																className="server-ping-table-input server-ping-port-input"
																value={editPort}
																onChange={(e) => setEditPort(e.target.value)}
																disabled={tableBusy || rowBusy}
																aria-label={
																	editCheckType === 'ssh'
																		? `SSH port for ${server.ip}`
																		: `HTTP port for ${server.ip}`
																}
															/>
														) : (
															<span className="server-ping-readonly-text">{portVal}</span>
														)}
													</td>
													<td
														className="server-ping-ftd server-ping-ftd-uri"
														style={{
															textAlign: 'left',
															padding: '0.5rem',
															verticalAlign: 'middle',
															wordBreak: 'break-all',
														}}
														title={cellTitleWithClient(
															'HTTP path for browser probe (admin only). Empty = /'
														)}
													>
														{isEditing && editCheckType === 'http' ? (
															<input
																className="server-ping-table-input server-ping-uri-input"
																value={editProbeUri}
																onChange={(e) => setEditProbeUri(e.target.value)}
																placeholder="/"
																disabled={tableBusy || rowBusy}
																aria-label={`HTTP path for ${server.ip}`}
																autoComplete="off"
															/>
														) : server.checkType === 'ssh' || (isEditing && editCheckType === 'ssh') ? (
															<span className="server-ping-readonly-text">—</span>
														) : (
															<span className="server-ping-readonly-text server-ping-uri-readonly">
																{(() => {
																	const u =
																		server.httpProbePath != null &&
																		String(server.httpProbePath).trim() !== ''
																			? String(server.httpProbePath).trim()
																			: '';
																	return u === '' ? '/' : u;
																})()}
															</span>
														)}
													</td>
												</>
											) : null}
											<td
												className={`server-ping-ftd ${showAdminTableColumns ? 'server-ping-ftd-6' : 'server-ping-ftd-6-compact'}`}
												style={{ textAlign: 'right', padding: '0.5rem', fontVariantNumeric: 'tabular-nums' }}
												title={cellTitleWithClient('Average of successful samples in loaded history')}
											>
												{avgStr}
											</td>
											{showAdminTableColumns ? (
												<td
													className="server-ping-actions-cell server-ping-ftd server-ping-ftd-7"
													title={cellTitleWithClient(undefined)}
												>
													{canEditServer(server) ? (
														<>
															{isEditing ? (
																<button
																	type="button"
																	className="server-ping-icon-btn server-ping-icon-save"
																	title="Save"
																	aria-label="Save changes"
																	disabled={tableBusy || rowBusy}
																	onClick={() => saveEditedRow(server)}
																>
																	<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
																		<path
																			fill="currentColor"
																			d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"
																		/>
																	</svg>
																</button>
															) : (
																<button
																	type="button"
																	className="server-ping-icon-btn"
																	title="Edit"
																	aria-label="Edit IP, location, check type, and port"
																	disabled={tableBusy || anotherRowEditing || rowBusy}
																	onClick={() => beginEditRow(server)}
																>
																	<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
																		<path
																			fill="currentColor"
																			d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a.996.996 0 0 0 0-1.41l-2.34-2.34a.996.996 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"
																		/>
																	</svg>
																</button>
															)}
															<button
																type="button"
																className="server-ping-icon-btn server-ping-icon-danger"
																title="Delete"
																aria-label={`Delete ${server.ip}`}
																disabled={tableBusy || rowBusy}
																onClick={() => handleDeleteServer(server.id)}
															>
																<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
																	<path
																		fill="currentColor"
																		d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"
																	/>
																</svg>
															</button>
														</>
													) : (
														<span className="server-ping-readonly-text" title="Sign in as owner or admin to edit">
															—
														</span>
													)}
												</td>
											) : null}
											{Array.from({ length: historyColumns }, (_, hi) => {
												const h = hist[hi];
												if (!h) {
													return (
														<td
															key={hi}
															className="data-cell empty server-ping-timeline-cell"
															aria-label={`History slot ${hi + 1}`}
															title={cellTitleWithClient(undefined)}
														>
															—
														</td>
													);
												}
												const cls = historyCellClass(h.status);
												const extra = isHighRtt(h.rtt_ms) ? ' high-rtt' : '';
												const ts = h.created_at || h.timestamp;
												return (
													<td
														key={hi}
														className={`${cls + extra} server-ping-timeline-cell`}
														title={cellTitleWithClient(h.error_message || h.status)}
													>
														<span className="ping-cell-rtt">
															{h.status === 'pending' ? '…' : formatRttMs(h.rtt_ms)}
														</span>
														<span className="ping-cell-ago">{formatHistoryAgo(ts, nowTick)}</span>
													</td>
												);
											})}
										</tr>
									);
								})}
							</tbody>
						</table>
					) : (
						<div className="no-data" style={{ padding: '3rem', textAlign: 'center', color: '#6c757d' }}>
							{loading && !pingRunActive ? 'Loading servers...' : 'No servers configured. Add one above.'}
						</div>
					)}
				</div>

				{tableRows.length > 0 && (
					<div className="table-footer">
						<p>
							Total groups: {Object.keys(serverList).length} · Total servers: {totalServers}
							{lastPingTime && ` · Last update: ${formatHeaderTime(lastPingTime)}`}
							{' '}
						</p>
					</div>
				)}
			</div>
		</div>
	);
};

export default ServerPingPanel;
