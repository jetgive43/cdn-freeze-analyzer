import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { useOutletContext } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import BusinessServerMetricsCharts from './BusinessServerMetricsCharts';

function fmt(n, d = 2) {
	if (n == null || n === '') return '—';
	const x = Number(n);
	return Number.isFinite(x) ? x.toFixed(d) : '—';
}

/** Integer Mbps for cap field / utilization denominator. */
function capMbpsInt(v) {
	if (v == null || v === '') return null;
	const x = Number(v);
	if (!Number.isFinite(x) || x <= 0) return null;
	return Math.round(x);
}

function capInputValue(serverCap) {
	const n = capMbpsInt(serverCap);
	return n == null ? '' : String(n);
}

function groupLabel(s) {
	const g = s.group_name != null ? String(s.group_name).trim() : '';
	return g || 'General';
}

/** Sortable column ids for business servers table */
const SORT_NAME = 'name';
const SORT_IP = 'ip';
const SORT_CAP = 'cap';
const SORT_CPU_RAM = 'cpu_ram';
const SORT_BW = 'bw';
const SORT_RPS = 'rps';
const SORT_DB = 'db';
const SORT_AGO = 'ago';

function numSortable(a, b) {
	const na = a == null || a === '' || !Number.isFinite(Number(a)) ? null : Number(a);
	const nb = b == null || b === '' || !Number.isFinite(Number(b)) ? null : Number(b);
	if (na == null && nb == null) return 0;
	if (na == null) return 1;
	if (nb == null) return -1;
	return na - nb;
}

function numOrNull(v) {
	if (v == null || v === '') return null;
	const x = Number(v);
	return Number.isFinite(x) ? x : null;
}

/** Sort combined CPU/RAM column by average utilization %. */
function cpuRamSortKey(s) {
	const c = numOrNull(s.last_cpu);
	const r = numOrNull(s.last_ram);
	if (c == null && r == null) return null;
	if (c == null) return r;
	if (r == null) return c;
	return (c + r) / 2;
}

/** Sort bandwidth column by peak direction (max of up/down Mbps). */
function bwSortKey(s) {
	const d = numOrNull(s.last_dl_mbps);
	const u = numOrNull(s.last_ul_mbps);
	if (d == null && u == null) return null;
	if (d == null) return u;
	if (u == null) return d;
	return Math.max(d, u);
}

function agoSortKey(iso) {
	if (!iso) return null;
	const t = new Date(iso).getTime();
	return Number.isFinite(t) ? t : null;
}

function sortBusinessServerRows(rows, col, dir) {
	const mul = dir === 'asc' ? 1 : -1;
	const out = [...rows];
	out.sort((a, b) => {
		let cmp = 0;
		switch (col) {
			case SORT_NAME:
				cmp = String(a.display_name || '').localeCompare(String(b.display_name || ''), undefined, { sensitivity: 'base' });
				break;
			case SORT_IP:
				cmp = String(a.ssh_host || '').localeCompare(String(b.ssh_host || ''), undefined, {
					numeric: true,
					sensitivity: 'base',
				});
				break;
			case SORT_CAP:
				cmp = numSortable(a.bandwidth_capacity_mbps, b.bandwidth_capacity_mbps);
				break;
			case SORT_CPU_RAM:
				cmp = numSortable(cpuRamSortKey(a), cpuRamSortKey(b));
				break;
			case SORT_BW:
				cmp = numSortable(bwSortKey(a), bwSortKey(b));
				break;
			case SORT_RPS:
				cmp = numSortable(a.last_rps, b.last_rps);
				break;
			case SORT_DB:
				cmp = numSortable(a.last_db_qps, b.last_db_qps);
				break;
			case SORT_AGO: {
				const ta = agoSortKey(a.last_seen_at);
				const tb = agoSortKey(b.last_seen_at);
				if (ta == null && tb == null) cmp = 0;
				else if (ta == null) cmp = 1;
				else if (tb == null) cmp = -1;
				else cmp = ta - tb;
				break;
			}
			default:
				cmp = 0;
		}
		return cmp * mul;
	});
	return out;
}

function agoText(iso) {
	if (!iso) return '—';
	let t;
	try {
		t = new Date(iso).getTime();
	} catch {
		return '—';
	}
	if (!Number.isFinite(t)) return '—';
	const sec = Math.floor((Date.now() - t) / 1000);
	if (sec < 0) return 'just now';
	if (sec === 0) return 'just now';
	if (sec < 60) return `${sec}s ago`;
	const min = Math.floor(sec / 60);
	if (min < 60) return min === 1 ? '1min ago' : `${min}mins ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return hr === 1 ? '1hr ago' : `${hr}hrs ago`;
	const day = Math.floor(hr / 24);
	return day === 1 ? '1day ago' : `${day}days ago`;
}

/** CPU/RAM % and bandwidth util %: 0–40 green, 40–80 orange, 80–100 red */
function cpuRamUtilTierClass(pct) {
	if (pct == null || pct === '') return 'bm-metric-neutral';
	const x = Number(pct);
	if (!Number.isFinite(x)) return 'bm-metric-neutral';
	if (x >= 80) return 'bm-metric-crit';
	if (x >= 40) return 'bm-metric-warn';
	return 'bm-metric-ok';
}

/** RPS: 0–400 green, 400–800 orange, &gt;800 red */
function rpsTierClass(n) {
	if (n == null || n === '') return 'bm-metric-neutral';
	const x = Number(n);
	if (!Number.isFinite(x)) return 'bm-metric-neutral';
	if (x > 800) return 'bm-metric-crit';
	if (x > 400) return 'bm-metric-warn';
	return 'bm-metric-ok';
}

/** DB/s: 0–100 green, 100–300 orange, &gt;300 red */
function dbQpsTierClass(n) {
	if (n == null || n === '') return 'bm-metric-neutral';
	const x = Number(n);
	if (!Number.isFinite(x)) return 'bm-metric-neutral';
	if (x > 300) return 'bm-metric-crit';
	if (x > 100) return 'bm-metric-warn';
	return 'bm-metric-ok';
}

function renderMetricCell(value, tierClassFn, decimals = 2) {
	const show = fmt(value, decimals);
	if (show === '—') return <span className="bm-metric-neutral">—</span>;
	const x = Number(value);
	return <span className={tierClassFn(x)}>{show}</span>;
}

function buildServerTooltip(s) {
	const cpuPct = fmt(s.last_cpu, 0);
	const threads = s.cpu_cores != null && s.cpu_cores !== '' ? String(s.cpu_cores) : '—';
	const ramPct = fmt(s.last_ram, 0);
	const ramGb =
		s.ram_total_mb != null && Number.isFinite(Number(s.ram_total_mb))
			? `${(Number(s.ram_total_mb) / 1024).toFixed(2)} GB`
			: '—';
	const capStr = capInputValue(s.bandwidth_capacity_mbps);
	const netCap = capStr ? `${capStr} Mbps` : '—';
	const lines = [
		`CPU: ${cpuPct}% (capacity: ${threads} threads)`,
		`RAM: ${ramPct}% (capacity: ${ramGb})`,
		`Network capacity: ${netCap}`,
	];
	return lines.join('\n');
}

function MetricPercentBar({ label, pct }) {
	const p = numOrNull(pct);
	const tier = cpuRamUtilTierClass(p);
	const width = p == null ? 0 : Math.min(100, Math.max(0, p));
	return (
		<div className="bm-bar-row">
			<span className="bm-bar-label">{label}</span>
			<div className="bm-bar-track">
				<div className={`bm-bar-fill ${tier}`} style={{ width: `${width}%` }} />
			</div>
			<span className={`bm-bar-val ${tier}`}>{p == null ? '—' : `${Math.round(p)}%`}</span>
		</div>
	);
}

function BwMbpsBar({ label, mbps, capacityMbps }) {
	const m = numOrNull(mbps);
	const cap = capMbpsInt(capacityMbps);
	let tier = 'bm-metric-neutral';
	let width = 0;
	if (m != null && cap != null && cap > 0) {
		width = Math.min(100, (m / cap) * 100);
		tier = cpuRamUtilTierClass(width);
	}
	const valStr = m == null ? '—' : `${fmt(mbps, m >= 10 ? 1 : 2)} Mbps`;
	return (
		<div className="bm-bar-row">
			<span className="bm-bar-label bm-bar-label-bw" title={label === '↓' ? 'Download' : 'Upload'}>
				{label}
			</span>
			<div className="bm-bar-track">
				{cap != null && cap > 0 ? (
					<div className={`bm-bar-fill ${tier}`} style={{ width: `${width}%` }} />
				) : (
					<div className="bm-bar-fill bm-bar-fill-nocap" style={{ width: '0%' }} />
				)}
			</div>
			<span
				className={`bm-bar-val ${
					m == null ? 'bm-metric-neutral' : cap != null && cap > 0 ? tier : 'bm-metric-ok'
				}`}
			>
				{valStr}
			</span>
		</div>
	);
}

function renderCpuRamStack(server) {
	return (
		<div className="bm-stack-cell">
			<MetricPercentBar label="CPU" pct={server.last_cpu} />
			<MetricPercentBar label="RAM" pct={server.last_ram} />
		</div>
	);
}

function renderBwStack(server) {
	const cap = server.bandwidth_capacity_mbps;
	return (
		<div className="bm-stack-cell bm-stack-cell-bw">
			<BwMbpsBar label="↓" mbps={server.last_dl_mbps} capacityMbps={cap} />
			<BwMbpsBar label="↑" mbps={server.last_ul_mbps} capacityMbps={cap} />
		</div>
	);
}

function IconInstallDeploy({ size = 20 }) {
	const n = size;
	return (
		<svg viewBox="0 0 24 24" width={n} height={n} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
			<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

function IconPencil({ size = 20 }) {
	const n = size;
	return (
		<svg viewBox="0 0 24 24" width={n} height={n} fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
			<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

/** Same trash glyph as Server ping list (filled Material-style). */
function IconTrashDelete({ size = 20 }) {
	const n = size;
	return (
		<svg viewBox="0 0 24 24" width={n} height={n} aria-hidden="true">
			<path
				fill="currentColor"
				d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"
			/>
		</svg>
	);
}

function IconChart({ size = 16 }) {
	const n = size;
	return (
		<svg viewBox="0 0 24 24" width={n} height={n} aria-hidden="true">
			<path
				fill="currentColor"
				d="M3.5 18.49l6-6.01 4 4L22 6.92l-1.41-1.41-7.09 7.097-4-4L2 16.59l1.5 1.9z"
			/>
		</svg>
	);
}

const COL_COUNT = 10;

function BusinessServersTable({
	groupedRows,
	onRemove,
	onEdit,
	onReinstall,
	onGraph,
	selectedId,
	onRowSelect,
	sortColumn,
	sortDir,
	onToggleSort,
}) {
	const [, setAgoTick] = useState(0);
	useEffect(() => {
		const id = window.setInterval(() => setAgoTick((x) => x + 1), 1000);
		return () => window.clearInterval(id);
	}, []);

	const renderSortableTh = (col, label, thStyle = {}, extraClass = '', thTitle) => {
		const active = sortColumn === col;
		return (
			<th
				className={`server-ping-th-sort-wrap business-servers-sort-th ${extraClass}`.trim()}
				style={thStyle}
				title={thTitle}
				aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
			>
				<button type="button" className="server-ping-th-sort" onClick={() => onToggleSort(col)}>
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

	let rowNo = 0;
	const tbodyNodes = [];
	for (const { groupName, rows } of groupedRows) {
		tbodyNodes.push(
			<tr key={`g-${groupName}`} className="business-servers-group-row">
				<td colSpan={COL_COUNT} className="business-servers-group-cell">
					{groupName}
				</td>
			</tr>
		);
		for (const s of rows) {
			rowNo += 1;
			const sel = selectedId === s.id;
			tbodyNodes.push(
				<tr
					key={s.id}
					className={`business-servers-data-row ${sel ? 'business-servers-row-selected' : ''}`}
					title={buildServerTooltip(s)}
					onClick={() => onRowSelect(s)}
				>
					<td className="business-servers-no">{rowNo}</td>
					<td style={{ textAlign: 'left' }}>{s.display_name}</td>
					<td style={{ textAlign: 'left', fontFamily: 'ui-monospace, monospace' }}>{s.ssh_host || '—'}</td>
					<td className="business-servers-cap-readonly">{capInputValue(s.bandwidth_capacity_mbps) || '—'}</td>
					<td className="business-servers-stack-td">{renderCpuRamStack(s)}</td>
					<td className="business-servers-stack-td">{renderBwStack(s)}</td>
					<td>{renderMetricCell(s.last_rps, rpsTierClass)}</td>
					<td>{renderMetricCell(s.last_db_qps, dbQpsTierClass)}</td>
					<td style={{ textAlign: 'left', whiteSpace: 'nowrap' }} className="business-servers-ago">
						{agoText(s.last_seen_at)}
					</td>
					<td
						className="business-servers-actions server-ping-actions-cell"
						onClick={(e) => e.stopPropagation()}
						onKeyDown={(e) => e.stopPropagation()}
					>
						<button
							type="button"
							className="server-ping-icon-btn business-servers-icon-btn-sm"
							title="Show metrics charts (last 3 days)"
							aria-label={`Open metrics charts for ${s.display_name}`}
							onClick={() => onGraph(s)}
						>
							<IconChart size={16} />
						</button>
						<button
							type="button"
							className="server-ping-icon-btn business-servers-icon-btn-sm"
							title="Reinstall agent on server (SSH)"
							aria-label={`Reinstall metrics agent for ${s.display_name}`}
							onClick={() => onReinstall(s)}
						>
							<IconInstallDeploy size={16} />
						</button>
						<button
							type="button"
							className="server-ping-icon-btn business-servers-icon-btn-sm"
							title="Edit name, SSH host, cap…"
							aria-label={`Edit ${s.display_name}`}
							onClick={() => onEdit(s)}
						>
							<IconPencil size={16} />
						</button>
						<button
							type="button"
							className="server-ping-icon-btn server-ping-icon-danger business-servers-icon-btn-sm"
							title="Remove server from list"
							aria-label={`Delete ${s.display_name}`}
							onClick={() => onRemove(s.id)}
						>
							<IconTrashDelete size={16} />
						</button>
					</td>
				</tr>
			);
		}
	}

	const emptyAll = groupedRows.length === 0 || groupedRows.every((g) => g.rows.length === 0);

	return (
		<div className="table-scroll-container business-servers-table-wrap">
			<table className="rtt-table business-servers-table">
				<thead>
					<tr>
						<th className="business-servers-no-th">No</th>
						{renderSortableTh(SORT_NAME, 'Name', { textAlign: 'left' })}
						{renderSortableTh(
							SORT_IP,
							'IP',
							{ textAlign: 'left' },
							'business-servers-sort-th-ip',
							'SSH host (edit). Row hover: CPU, RAM, network capacity.'
						)}
						{renderSortableTh(
							SORT_CAP,
							'Cap Mbps',
							{ textAlign: 'right' },
							'business-servers-cap-th business-servers-sort-th-cap',
							'Link capacity (Mbps); edit via pencil. Bars use % of capacity for ↓/↑'
						)}
						{renderSortableTh(
							SORT_CPU_RAM,
							'CPU / RAM',
							{ textAlign: 'left' },
							'business-servers-sort-th-metric business-servers-sort-th-stack',
							'Sort by average of CPU% and RAM%'
						)}
						{renderSortableTh(
							SORT_BW,
							'↓ / ↑',
							{ textAlign: 'left' },
							'business-servers-sort-th-metric business-servers-sort-th-stack',
							'Sort by peak Mbps (max of download and upload)'
						)}
						{renderSortableTh(SORT_RPS, 'RPS', { textAlign: 'center' }, 'business-servers-sort-th-metric')}
						{renderSortableTh(SORT_DB, 'DB/s', { textAlign: 'center' }, 'business-servers-sort-th-metric')}
						{renderSortableTh(SORT_AGO, 'Ago', { textAlign: 'left' })}
						<th className="business-servers-actions-th" />
					</tr>
				</thead>
				<tbody>
					{emptyAll ? (
						<tr>
							<td colSpan={COL_COUNT} className="business-servers-empty-cell">
								<span className="server-ping-readonly-text">No servers yet. Add one to begin.</span>
							</td>
						</tr>
					) : (
						tbodyNodes
					)}
				</tbody>
			</table>
		</div>
	);
}

export default function BusinessServersPanel() {
	const { authHeader } = useAuth();
	const [servers, setServers] = useState([]);
	const [error, setError] = useState(null);
	const [busy, setBusy] = useState(false);
	const [addOpen, setAddOpen] = useState(false);
	const [form, setForm] = useState({
		displayName: '',
		groupKey: 'General',
		newGroupName: '',
		sshHost: '',
		sshPort: '22',
		sshUser: '',
		sshPassword: '',
		bandwidthCapacityMbps: '',
		cpuCores: '',
		ramTotalGb: '',
	});
	const [flash, setFlash] = useState(null);
	const [editTarget, setEditTarget] = useState(null);
	const [editForm, setEditForm] = useState({
		displayName: '',
		groupKey: 'General',
		newGroupName: '',
		sshHost: '',
		sshPort: '22',
		sshUser: '',
		bandwidthCapacityMbps: '',
		cpuCores: '',
		ramTotalGb: '',
	});
	const [editBusy, setEditBusy] = useState(false);
	const [reinstallTarget, setReinstallTarget] = useState(null);
	const [reinstallPassword, setReinstallPassword] = useState('');
	const [reinstallBusy, setReinstallBusy] = useState(false);
	const [selectedServer, setSelectedServer] = useState(null);
	const [sortColumn, setSortColumn] = useState(SORT_NAME);
	const [sortDir, setSortDir] = useState('asc');
	const { setAdminToolbarExtra } = useOutletContext() || {};

	useEffect(() => {
		if (typeof setAdminToolbarExtra !== 'function') return undefined;
		setAdminToolbarExtra(
			<button type="button" className="btn btn-primary app-session-add-server-btn" onClick={() => setAddOpen(true)}>
				Add server
			</button>
		);
		return () => setAdminToolbarExtra(null);
	}, [setAdminToolbarExtra]);

	const knownGroups = useMemo(() => {
		const set = new Set();
		servers.forEach((s) => set.add(groupLabel(s)));
		return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
	}, [servers]);

	const groupDropdownOptions = useMemo(() => {
		const set = new Set(['General', ...knownGroups]);
		return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
	}, [knownGroups]);

	function resolveGroupFromSelect(groupKey, newGroupName) {
		if (groupKey === '__new__') return (String(newGroupName || '').trim().slice(0, 128) || 'General');
		return String(groupKey || 'General').trim().slice(0, 128) || 'General';
	}

	const groupedRows = useMemo(() => {
		const map = new Map();
		for (const s of servers) {
			const g = groupLabel(s);
			if (!map.has(g)) map.set(g, []);
			map.get(g).push(s);
		}
		const keys = [...map.keys()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
		return keys.map((groupName) => ({
			groupName,
			rows: sortBusinessServerRows(map.get(groupName), sortColumn, sortDir),
		}));
	}, [servers, sortColumn, sortDir]);

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

	const failedDeploys = useMemo(
		() => servers.filter((s) => String(s.deploy_status || '').toLowerCase() === 'failed'),
		[servers]
	);

	const load = useCallback(async () => {
		setError(null);
		try {
			const { data } = await axios.get('/api/business-servers', { headers: { ...authHeader() } });
			if (data.success) setServers(data.servers || []);
		} catch (e) {
			setError(e.response?.data?.error || e.message);
		}
	}, [authHeader]);

	useEffect(() => {
		load();
	}, [load]);

	useEffect(() => {
		setSelectedServer((prev) => {
			if (!prev) return null;
			const fresh = servers.find((s) => s.id === prev.id);
			return fresh ?? null;
		});
	}, [servers]);

	useEffect(() => {
		if (!addOpen && !editTarget && !reinstallTarget) return undefined;
		const onKey = (e) => {
			if (e.key !== 'Escape') return;
			if (reinstallTarget) {
				setReinstallTarget(null);
				setReinstallPassword('');
			} else if (editTarget) {
				setEditTarget(null);
			} else if (addOpen) {
				setAddOpen(false);
			}
		};
		window.addEventListener('keydown', onKey);
		return () => window.removeEventListener('keydown', onKey);
	}, [addOpen, editTarget, reinstallTarget]);

	const onRowSelect = useCallback((s) => {
		setSelectedServer((prev) => (prev && prev.id === s.id ? null : s));
	}, []);

	const showGraphForServer = useCallback((s) => {
		setSelectedServer(s);
	}, []);

	const openEdit = useCallback(
		(s) => {
			setEditTarget(s);
			const ramGb =
				s.ram_total_mb != null && Number.isFinite(Number(s.ram_total_mb))
					? String(Math.round((Number(s.ram_total_mb) / 1024) * 1000) / 1000)
					: '';
			const g = groupLabel(s);
			const inList = groupDropdownOptions.includes(g);
			setEditForm({
				displayName: s.display_name || '',
				groupKey: inList ? g : '__new__',
				newGroupName: inList ? '' : g,
				sshHost: s.ssh_host || '',
				sshPort: String(s.ssh_port ?? 22),
				sshUser: s.ssh_user || '',
				bandwidthCapacityMbps: capInputValue(s.bandwidth_capacity_mbps),
				cpuCores: s.cpu_cores != null && s.cpu_cores !== '' ? String(s.cpu_cores) : '',
				ramTotalGb: ramGb,
			});
		},
		[groupDropdownOptions]
	);

	const submitEdit = async (e) => {
		e.preventDefault();
		if (!editTarget) return;
		setEditBusy(true);
		setError(null);
		try {
			const capT = editForm.bandwidthCapacityMbps.trim();
			const payload = {
				displayName: editForm.displayName.trim(),
				groupName: resolveGroupFromSelect(editForm.groupKey, editForm.newGroupName),
				sshHost: editForm.sshHost.trim() || null,
				sshPort: Number(editForm.sshPort) || 22,
				sshUser: editForm.sshUser.trim() || null,
				bandwidthCapacityMbps: capT === '' ? null : Math.round(Number(capT)),
				cpuCores: editForm.cpuCores.trim() === '' ? null : Number(editForm.cpuCores),
				ramTotalGb: editForm.ramTotalGb.trim() === '' ? null : Number(editForm.ramTotalGb),
			};
			if (!payload.displayName) {
				setError('Name is required');
				setEditBusy(false);
				return;
			}
			if (capT !== '' && !Number.isFinite(Number(capT))) {
				setError('Cap must be a number');
				setEditBusy(false);
				return;
			}
			if (editForm.cpuCores.trim() !== '' && !Number.isFinite(Number(editForm.cpuCores))) {
				setError('Thread count must be a number');
				setEditBusy(false);
				return;
			}
			if (editForm.ramTotalGb.trim() !== '' && !Number.isFinite(Number(editForm.ramTotalGb))) {
				setError('RAM (GB) must be a number');
				setEditBusy(false);
				return;
			}
			await axios.patch(`/api/business-servers/${editTarget.id}`, payload, { headers: { ...authHeader() } });
			setEditTarget(null);
			await load();
		} catch (err) {
			setError(err.response?.data?.error || err.message);
		} finally {
			setEditBusy(false);
		}
	};

	const submitReinstall = async (e) => {
		e.preventDefault();
		if (!reinstallTarget) return;
		setReinstallBusy(true);
		setError(null);
		try {
			const { data } = await axios.post(
				`/api/business-servers/${reinstallTarget.id}/reinstall`,
				{ sshPassword: reinstallPassword },
				{ headers: { ...authHeader() } }
			);
			if (data.success) {
				if (String(data.deployStatus || '').toLowerCase() === 'failed') {
					setFlash({
						alarm: true,
						message: data.deployMessage || 'Reinstall failed.',
					});
				} else {
					setFlash({
						simple: data.deployMessage || 'Reinstall completed.',
					});
				}
				setReinstallTarget(null);
				setReinstallPassword('');
				await load();
			}
		} catch (err) {
			setError(err.response?.data?.error || err.message);
		} finally {
			setReinstallBusy(false);
		}
	};

	const add = async (e) => {
		e.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const { data } = await axios.post(
				'/api/business-servers',
				{
					displayName: form.displayName,
					groupName: resolveGroupFromSelect(form.groupKey, form.newGroupName),
					sshHost: form.sshHost || undefined,
					sshPort: form.sshPort ? Number(form.sshPort) : undefined,
					sshUser: form.sshUser || undefined,
					sshPassword: form.sshPassword || undefined,
					bandwidthCapacityMbps: (() => {
						const t = form.bandwidthCapacityMbps.trim();
						if (t === '') return undefined;
						const n = Math.round(Number(t));
						if (!Number.isFinite(n) || n < 0) return undefined;
						return n;
					})(),
					cpuCores: form.cpuCores.trim() === '' ? undefined : Number(form.cpuCores),
					ramTotalGb: form.ramTotalGb.trim() === '' ? undefined : Number(form.ramTotalGb),
				},
				{ headers: { ...authHeader() } }
			);
			if (data.success) {
				if (String(data.deployStatus || '').toLowerCase() === 'failed') {
					setFlash({
						alarm: true,
						message: data.deployMessage || 'SSH deploy or first metrics push failed.',
						token: data.ingestToken,
						url: data.ingestUrl,
					});
				} else if (data.cronInstalled) {
					setFlash({
						simple: data.deployMessage || 'Remote cron installed (every minute); first metrics sent.',
					});
				} else {
					setFlash({
						token: data.ingestToken,
						url: data.ingestUrl,
						note: data.deployMessage,
					});
				}
				setForm({
					displayName: '',
					groupKey: 'General',
					newGroupName: '',
					sshHost: '',
					sshPort: '22',
					sshUser: '',
					sshPassword: '',
					bandwidthCapacityMbps: '',
					cpuCores: '',
					ramTotalGb: '',
				});
				setAddOpen(false);
				await load();
			}
		} catch (err) {
			setError(err.response?.data?.error || err.message);
		} finally {
			setBusy(false);
		}
	};

	const remove = async (id) => {
		if (!window.confirm('Remove this server?')) return;
		try {
			await axios.delete(`/api/business-servers/${id}`, { headers: { ...authHeader() } });
			if (selectedServer && selectedServer.id === id) setSelectedServer(null);
			await load();
		} catch (e) {
			setError(e.response?.data?.error || e.message);
		}
	};

	return (
		<div className="status-table-container business-servers-page" style={{ padding: '1rem' }}>
			{failedDeploys.length > 0 ? (
				<div className="business-servers-ssh-alarm" role="alert">
					<div className="business-servers-ssh-alarm-title">SSH / deploy error</div>
					<ul className="business-servers-ssh-alarm-list">
						{failedDeploys.map((s) => (
							<li key={s.id}>
								<strong>{s.display_name}</strong>
								{s.deploy_message ? <span className="business-servers-ssh-alarm-msg"> — {s.deploy_message}</span> : null}
							</li>
						))}
					</ul>
				</div>
			) : null}

			{flash ? (
				<div
					className={flash.alarm ? 'business-servers-flash-alarm' : 'business-servers-flash-ok'}
					role={flash.alarm ? 'alert' : 'status'}
				>
					{flash.alarm ? (
						<>
							<div className="business-servers-flash-alarm-title">Deploy failed</div>
							<p className="business-servers-flash-alarm-body">{flash.message}</p>
							{flash.token ? (
								<p className="server-ping-readonly-text" style={{ margin: '0.5rem 0 0', fontSize: '0.82rem' }}>
									You can run the agent manually. Token:{' '}
									<code style={{ wordBreak: 'break-all' }}>{flash.token}</code>
								</p>
							) : null}
							{flash.url ? (
								<p className="server-ping-readonly-text" style={{ margin: '0.35rem 0 0', fontSize: '0.82rem' }}>
									POST: <code style={{ wordBreak: 'break-all' }}>{flash.url}</code>
								</p>
							) : null}
						</>
					) : flash.simple ? (
						<span>{flash.simple}</span>
					) : (
						<>
							<strong>Ingest token:</strong> <code style={{ wordBreak: 'break-all' }}>{flash.token}</code>
							{flash.url ? (
								<div className="server-ping-readonly-text" style={{ marginTop: '0.25rem' }}>
									POST URL: <code style={{ wordBreak: 'break-all' }}>{flash.url}</code>
								</div>
							) : null}
							{flash.note ? (
								<div className="server-ping-readonly-text" style={{ marginTop: '0.25rem' }}>
									{flash.note}
								</div>
							) : null}
						</>
					)}
					<button type="button" className="error-close" onClick={() => setFlash(null)} aria-label="Dismiss">
						×
					</button>
				</div>
			) : null}
			{error ? (
				<div className="error-message" style={{ marginBottom: '0.75rem' }}>
					{error}
				</div>
			) : null}

			<div className="business-servers-split">
				<div className="business-servers-main">
					<BusinessServersTable
						groupedRows={groupedRows}
						onRemove={remove}
						onEdit={openEdit}
						onReinstall={setReinstallTarget}
						onGraph={showGraphForServer}
						selectedId={selectedServer ? selectedServer.id : null}
						onRowSelect={onRowSelect}
						sortColumn={sortColumn}
						sortDir={sortDir}
						onToggleSort={toggleSort}
					/>
				</div>
				<aside className="business-servers-side" aria-label="Server metrics charts">
					{selectedServer ? (
						<div className="business-servers-side-charts">
							<BusinessServerMetricsCharts server={selectedServer} authHeader={authHeader} embedded />
						</div>
					) : (
						<div className="business-servers-side-placeholder">
							<p>Select a server row or click the graph button to show the last 3 days of metrics here.</p>
						</div>
					)}
				</aside>
			</div>

			{addOpen ? (
				<div
					className="server-ping-modal-backdrop"
					role="presentation"
					onClick={(e) => {
						if (e.target === e.currentTarget) setAddOpen(false);
					}}
				>
					<div
						className="server-ping-modal business-servers-add-modal"
						role="dialog"
						aria-modal="true"
						aria-labelledby="business-servers-add-title"
						onClick={(e) => e.stopPropagation()}
					>
						<div className="server-ping-modal-header">
							<h2 id="business-servers-add-title">Add server</h2>
							<button
								type="button"
								className="server-ping-modal-close"
								onClick={() => setAddOpen(false)}
								disabled={busy}
								aria-label="Close"
							>
								×
							</button>
						</div>
						<form className="server-ping-modal-form" onSubmit={add}>
							<div className="server-ping-modal-field">
								<label htmlFor="bm-display-name">Display name</label>
								<input
									id="bm-display-name"
									required
									value={form.displayName}
									onChange={(e) => setForm({ ...form, displayName: e.target.value })}
									autoComplete="off"
								/>
							</div>
							<div className="server-ping-modal-field">
								<label htmlFor="bm-group">Group</label>
								<select
									id="bm-group"
									className="business-servers-group-select"
									value={form.groupKey}
									onChange={(e) => {
										const v = e.target.value;
										setForm((f) => ({ ...f, groupKey: v, newGroupName: v === '__new__' ? f.newGroupName : '' }));
									}}
									disabled={busy}
								>
									{groupDropdownOptions.map((g) => (
										<option key={g} value={g}>
											{g}
										</option>
									))}
									<option value="__new__">+ New group…</option>
								</select>
							</div>
							{form.groupKey === '__new__' ? (
								<div className="server-ping-modal-field">
									<label htmlFor="bm-group-new">New group name</label>
									<input
										id="bm-group-new"
										value={form.newGroupName}
										onChange={(e) => setForm({ ...form, newGroupName: e.target.value })}
										placeholder="e.g. Production"
										autoComplete="off"
										disabled={busy}
									/>
								</div>
							) : null}
							<div className="server-ping-modal-field">
								<label htmlFor="bm-cpu-threads">Thread count</label>
								<input
									id="bm-cpu-threads"
									type="number"
									min={1}
									max={65535}
									step={1}
									value={form.cpuCores}
									onChange={(e) => setForm({ ...form, cpuCores: e.target.value })}
									placeholder="e.g. 8"
								/>
							</div>
							<div className="server-ping-modal-field">
								<label htmlFor="bm-ram-gb">RAM capacity (GB)</label>
								<input
									id="bm-ram-gb"
									type="number"
									min={0.25}
									step="any"
									value={form.ramTotalGb}
									onChange={(e) => setForm({ ...form, ramTotalGb: e.target.value })}
									placeholder="e.g. 32"
								/>
							</div>
							<div className="server-ping-modal-field">
								<label htmlFor="bm-ssh-host">SSH host</label>
								<input
									id="bm-ssh-host"
									value={form.sshHost}
									onChange={(e) => setForm({ ...form, sshHost: e.target.value })}
									autoComplete="off"
								/>
							</div>
							<div className="server-ping-modal-field">
								<label htmlFor="bm-ssh-port">SSH port</label>
								<input
									id="bm-ssh-port"
									type="number"
									min={1}
									max={65535}
									value={form.sshPort}
									onChange={(e) => setForm({ ...form, sshPort: e.target.value })}
								/>
							</div>
							<div className="server-ping-modal-field">
								<label htmlFor="bm-ssh-user">SSH user</label>
								<input
									id="bm-ssh-user"
									value={form.sshUser}
									onChange={(e) => setForm({ ...form, sshUser: e.target.value })}
									autoComplete="off"
								/>
							</div>
							<div className="server-ping-modal-field">
								<label htmlFor="bm-ssh-pass">SSH password (once)</label>
								<input
									id="bm-ssh-pass"
									type="password"
									value={form.sshPassword}
									onChange={(e) => setForm({ ...form, sshPassword: e.target.value })}
									autoComplete="new-password"
								/>
							</div>
							<div className="server-ping-modal-field">
								<label htmlFor="bm-bw-cap">Bandwidth capacity (Mbps, optional)</label>
								<input
									id="bm-bw-cap"
									type="number"
									min={0}
									step={1}
									value={form.bandwidthCapacityMbps}
									onChange={(e) => setForm({ ...form, bandwidthCapacityMbps: e.target.value })}
									placeholder="e.g. 1000"
								/>
							</div>
							<p className="server-ping-modal-geo-hint" style={{ margin: 0 }}>
								Cron is installed only after the first metrics POST succeeds. If that fails, nothing is scheduled on the remote host.
							</p>
							<div className="server-ping-modal-actions">
								<button type="button" className="btn server-ping-modal-btn-cancel" onClick={() => setAddOpen(false)} disabled={busy}>
									Cancel
								</button>
								<button type="submit" className="btn btn-primary" disabled={busy}>
									{busy ? 'Saving…' : 'Add server'}
								</button>
							</div>
						</form>
					</div>
				</div>
			) : null}

			{editTarget ? (
				<div
					className="server-ping-modal-backdrop"
					role="presentation"
					onClick={(e) => {
						if (e.target === e.currentTarget) setEditTarget(null);
					}}
				>
					<div
						className="server-ping-modal business-servers-add-modal"
						role="dialog"
						aria-modal="true"
						aria-labelledby="business-servers-edit-title"
						onClick={(e) => e.stopPropagation()}
					>
						<div className="server-ping-modal-header">
							<h2 id="business-servers-edit-title">Edit server</h2>
							<button
								type="button"
								className="server-ping-modal-close"
								onClick={() => setEditTarget(null)}
								disabled={editBusy}
								aria-label="Close"
							>
								×
							</button>
						</div>
						<form className="server-ping-modal-form" onSubmit={submitEdit}>
							<div className="server-ping-modal-field">
								<label htmlFor="bm-edit-name">Name</label>
								<input
									id="bm-edit-name"
									required
									value={editForm.displayName}
									onChange={(e) => setEditForm({ ...editForm, displayName: e.target.value })}
									autoComplete="off"
								/>
							</div>
							<div className="server-ping-modal-field">
								<label htmlFor="bm-edit-group">Group</label>
								<select
									id="bm-edit-group"
									className="business-servers-group-select"
									value={editForm.groupKey}
									onChange={(e) => {
										const v = e.target.value;
										setEditForm((f) => ({ ...f, groupKey: v, newGroupName: v === '__new__' ? f.newGroupName : '' }));
									}}
									disabled={editBusy}
								>
									{(() => {
										const opts = new Set(groupDropdownOptions);
										if (editTarget) opts.add(groupLabel(editTarget));
										return [...opts].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
									})().map((g) => (
										<option key={g} value={g}>
											{g}
										</option>
									))}
									<option value="__new__">+ New group…</option>
								</select>
							</div>
							{editForm.groupKey === '__new__' ? (
								<div className="server-ping-modal-field">
									<label htmlFor="bm-edit-group-new">New group name</label>
									<input
										id="bm-edit-group-new"
										value={editForm.newGroupName}
										onChange={(e) => setEditForm({ ...editForm, newGroupName: e.target.value })}
										placeholder="e.g. Production"
										autoComplete="off"
										disabled={editBusy}
									/>
								</div>
							) : null}
							<div className="server-ping-modal-field">
								<label htmlFor="bm-edit-cpu">Thread count</label>
								<input
									id="bm-edit-cpu"
									type="number"
									min={1}
									max={65535}
									step={1}
									value={editForm.cpuCores}
									onChange={(e) => setEditForm({ ...editForm, cpuCores: e.target.value })}
									placeholder="Leave empty if unknown"
								/>
							</div>
							<div className="server-ping-modal-field">
								<label htmlFor="bm-edit-ram">RAM capacity (GB)</label>
								<input
									id="bm-edit-ram"
									type="number"
									min={0.25}
									step="any"
									value={editForm.ramTotalGb}
									onChange={(e) => setEditForm({ ...editForm, ramTotalGb: e.target.value })}
									placeholder="Leave empty if unknown"
								/>
							</div>
							<div className="server-ping-modal-field">
								<label htmlFor="bm-edit-ssh-host">SSH host / IP</label>
								<input
									id="bm-edit-ssh-host"
									value={editForm.sshHost}
									onChange={(e) => setEditForm({ ...editForm, sshHost: e.target.value })}
									autoComplete="off"
								/>
							</div>
							<div className="server-ping-modal-field">
								<label htmlFor="bm-edit-ssh-port">SSH port</label>
								<input
									id="bm-edit-ssh-port"
									type="number"
									min={1}
									max={65535}
									value={editForm.sshPort}
									onChange={(e) => setEditForm({ ...editForm, sshPort: e.target.value })}
								/>
							</div>
							<div className="server-ping-modal-field">
								<label htmlFor="bm-edit-ssh-user">SSH user</label>
								<input
									id="bm-edit-ssh-user"
									value={editForm.sshUser}
									onChange={(e) => setEditForm({ ...editForm, sshUser: e.target.value })}
									autoComplete="off"
								/>
							</div>
							<div className="server-ping-modal-field">
								<label htmlFor="bm-edit-bw">Cap bandwidth (Mbps, optional)</label>
								<input
									id="bm-edit-bw"
									type="number"
									min={0}
									step={1}
									value={editForm.bandwidthCapacityMbps}
									onChange={(e) => setEditForm({ ...editForm, bandwidthCapacityMbps: e.target.value })}
									placeholder="e.g. 1000"
								/>
							</div>
							<div className="server-ping-modal-actions">
								<button type="button" className="btn server-ping-modal-btn-cancel" onClick={() => setEditTarget(null)} disabled={editBusy}>
									Cancel
								</button>
								<button type="submit" className="btn btn-primary" disabled={editBusy}>
									{editBusy ? 'Saving…' : 'Save'}
								</button>
							</div>
						</form>
					</div>
				</div>
			) : null}

			{reinstallTarget ? (
				<div
					className="server-ping-modal-backdrop"
					role="presentation"
					onClick={(e) => {
						if (e.target === e.currentTarget) {
							setReinstallTarget(null);
							setReinstallPassword('');
						}
					}}
				>
					<div
						className="server-ping-modal business-servers-add-modal"
						role="dialog"
						aria-modal="true"
						aria-labelledby="business-servers-reinstall-title"
						onClick={(e) => e.stopPropagation()}
					>
						<div className="server-ping-modal-header">
							<h2 id="business-servers-reinstall-title">Reinstall agent</h2>
							<button
								type="button"
								className="server-ping-modal-close"
								onClick={() => {
									setReinstallTarget(null);
									setReinstallPassword('');
								}}
								disabled={reinstallBusy}
								aria-label="Close"
							>
								×
							</button>
						</div>
						<form className="server-ping-modal-form" onSubmit={submitReinstall}>
							<p className="server-ping-modal-geo-hint" style={{ margin: '0 0 0.5rem' }}>
								Re-upload scripts and cron on <strong>{reinstallTarget.display_name}</strong> ({reinstallTarget.ssh_host || '—'}). Leave password
								empty if the monitor uses <code>BUSINESS_SSH_PRIVATE_KEY_PATH</code>.
							</p>
							<div className="server-ping-modal-field">
								<label htmlFor="bm-reinstall-pass">SSH password</label>
								<input
									id="bm-reinstall-pass"
									type="password"
									value={reinstallPassword}
									onChange={(e) => setReinstallPassword(e.target.value)}
									autoComplete="new-password"
									placeholder="Optional if key auth is configured"
								/>
							</div>
							<div className="server-ping-modal-actions">
								<button
									type="button"
									className="btn server-ping-modal-btn-cancel"
									onClick={() => {
										setReinstallTarget(null);
										setReinstallPassword('');
									}}
									disabled={reinstallBusy}
								>
									Cancel
								</button>
								<button type="submit" className="btn btn-primary" disabled={reinstallBusy}>
									<span className="business-servers-reinstall-submit-inner">
										<IconInstallDeploy />
										{reinstallBusy ? ' Installing…' : ' Install / redeploy'}
									</span>
								</button>
							</div>
						</form>
					</div>
				</div>
			) : null}
		</div>
	);
}
