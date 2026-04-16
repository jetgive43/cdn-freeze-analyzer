import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { Line } from 'react-chartjs-2';
import {
	Chart as ChartJS,
	CategoryScale,
	LinearScale,
	PointElement,
	LineElement,
	Title,
	Tooltip,
	Legend,
	TimeScale,
} from 'chart.js';
import 'chartjs-adapter-date-fns';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Title, Tooltip, Legend, TimeScale);

function toPoint(key, points) {
	return points
		.filter((p) => p[key] != null && Number.isFinite(Number(p[key])))
		.map((p) => ({
			x: p.recorded_at,
			y: Number(p[key]),
		}));
}

const baseOpts = {
	responsive: true,
	maintainAspectRatio: false,
	interaction: { mode: 'index', intersect: false },
	plugins: {
		legend: { position: 'top', labels: { boxWidth: 12, font: { size: 11 } } },
	},
	scales: {
		x: {
			type: 'time',
			ticks: { maxTicksLimit: 8, font: { size: 10 } },
		},
		y: {
			beginAtZero: true,
			ticks: { font: { size: 10 } },
		},
	},
};

/**
 * Fetches last-3-day metrics and renders Chart.js line charts.
 * @param {{ server: object, authHeader: () => object, embedded?: boolean }} props
 */
export default function BusinessServerMetricsCharts({ server, authHeader, embedded = false }) {
	const [points, setPoints] = useState([]);
	const [loading, setLoading] = useState(false);
	const [err, setErr] = useState(null);

	const chartArea = embedded ? { height: 212 } : { height: 175 };

	useEffect(() => {
		if (!server) return undefined;
		let cancelled = false;
		setLoading(true);
		setErr(null);
		setPoints([]);
		(async () => {
			try {
				const { data } = await axios.get(`/api/business-servers/${server.id}/metrics`, {
					headers: { ...authHeader() },
				});
				if (cancelled) return;
				if (data.success) setPoints(data.points || []);
				else setErr(data.error || 'Failed to load metrics');
			} catch (e) {
				if (!cancelled) setErr(e.response?.data?.error || e.message);
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [server, authHeader]);

	const cpuRam = useMemo(
		() => ({
			datasets: [
				{
					label: 'CPU %',
					data: toPoint('cpu_percent', points),
					borderColor: 'rgb(37, 99, 235)',
					backgroundColor: 'rgba(37, 99, 235, 0.08)',
					tension: 0.15,
					pointRadius: 0,
					pointHoverRadius: 3,
					spanGaps: true,
				},
				{
					label: 'RAM %',
					data: toPoint('ram_percent', points),
					borderColor: 'rgb(22, 163, 74)',
					backgroundColor: 'rgba(22, 163, 74, 0.08)',
					tension: 0.15,
					pointRadius: 0,
					pointHoverRadius: 3,
					spanGaps: true,
				},
			],
		}),
		[points]
	);

	const bw = useMemo(
		() => ({
			datasets: [
				{
					label: 'In Mbps',
					data: toPoint('dl_mbps', points),
					borderColor: 'rgb(14, 165, 233)',
					backgroundColor: 'rgba(14, 165, 233, 0.08)',
					tension: 0.15,
					pointRadius: 0,
					pointHoverRadius: 3,
					spanGaps: true,
				},
				{
					label: 'Out Mbps',
					data: toPoint('ul_mbps', points),
					borderColor: 'rgb(234, 88, 12)',
					backgroundColor: 'rgba(234, 88, 12, 0.08)',
					tension: 0.15,
					pointRadius: 0,
					pointHoverRadius: 3,
					spanGaps: true,
				},
			],
		}),
		[points]
	);

	const rpsDs = useMemo(
		() => ({
			datasets: [
				{
					label: 'RPS',
					data: toPoint('rps', points),
					borderColor: 'rgb(124, 58, 237)',
					backgroundColor: 'rgba(124, 58, 237, 0.1)',
					tension: 0.15,
					pointRadius: 0,
					pointHoverRadius: 3,
					spanGaps: true,
				},
			],
		}),
		[points]
	);

	const dbDs = useMemo(
		() => ({
			datasets: [
				{
					label: 'DB/s',
					data: toPoint('db_qps', points),
					borderColor: 'rgb(219, 39, 119)',
					backgroundColor: 'rgba(219, 39, 119, 0.1)',
					tension: 0.15,
					pointRadius: 0,
					pointHoverRadius: 3,
					spanGaps: true,
				},
			],
		}),
		[points]
	);

	const cpuOpts = useMemo(
		() => ({
			...baseOpts,
			plugins: {
				...baseOpts.plugins,
				title: { display: true, text: 'CPU & RAM %', font: { size: embedded ? 11 : 13, weight: '600' } },
			},
			scales: {
				...baseOpts.scales,
				y: {
					...baseOpts.scales.y,
					suggestedMax: 100,
					title: { display: true, text: '%' },
				},
			},
		}),
		[embedded]
	);

	const bwOpts = useMemo(
		() => ({
			...baseOpts,
			plugins: {
				...baseOpts.plugins,
				title: { display: true, text: 'Bandwidth (in / out)', font: { size: embedded ? 11 : 13, weight: '600' } },
			},
			scales: {
				...baseOpts.scales,
				y: { ...baseOpts.scales.y, title: { display: true, text: 'Mbps' } },
			},
		}),
		[embedded]
	);

	const rpsOpts = useMemo(
		() => ({
			...baseOpts,
			plugins: {
				...baseOpts.plugins,
				title: { display: true, text: 'Requests per second', font: { size: embedded ? 11 : 13, weight: '600' } },
			},
			scales: {
				...baseOpts.scales,
				y: { ...baseOpts.scales.y, title: { display: true, text: 'RPS' } },
			},
		}),
		[embedded]
	);

	const dbOpts = useMemo(
		() => ({
			...baseOpts,
			plugins: {
				...baseOpts.plugins,
				title: { display: true, text: 'DB queries / s', font: { size: embedded ? 11 : 13, weight: '600' } },
			},
			scales: {
				...baseOpts.scales,
				y: { ...baseOpts.scales.y, title: { display: true, text: 'DB/s' } },
			},
		}),
		[embedded]
	);

	if (!server) return null;

	const title = server.display_name || `Server ${server.id}`;

	const chartGrid = (
		<div
			className={`business-servers-metrics-chart-grid${embedded ? ' business-servers-metrics-chart-grid-embedded' : ''}`}
		>
			<div className="business-servers-metrics-chart-wrap" style={chartArea}>
				<Line data={cpuRam} options={cpuOpts} />
			</div>
			<div className="business-servers-metrics-chart-wrap" style={chartArea}>
				<Line data={bw} options={bwOpts} />
			</div>
			<div className="business-servers-metrics-chart-wrap" style={chartArea}>
				<Line data={rpsDs} options={rpsOpts} />
			</div>
			<div className="business-servers-metrics-chart-wrap" style={chartArea}>
				<Line data={dbDs} options={dbOpts} />
			</div>
		</div>
	);

	return (
		<div className={embedded ? 'business-servers-metrics-embedded-inner' : undefined}>
			{embedded ? (
				<>
					<div className="business-servers-metrics-side-head">
						<h3 className="business-servers-metrics-side-title">{title}</h3>
						<p className="business-servers-metrics-embedded-hint">Last 3 days (auto-pruned). Scroll to see all charts.</p>
					</div>
					<div className="business-servers-metrics-embedded-body">
						{loading ? (
							<div className="business-servers-metrics-loading">Loading charts…</div>
						) : err ? (
							<div className="error-message" style={{ marginBottom: '0.5rem' }}>
								{err}
							</div>
						) : points.length === 0 ? (
							<div className="business-servers-metrics-loading">No metrics in the last 3 days.</div>
						) : (
							chartGrid
						)}
					</div>
				</>
			) : (
				<>
					<p className="server-ping-modal-geo-hint">Last 3 days of samples (older points are removed automatically).</p>
					{loading ? (
						<div className="business-servers-metrics-loading">Loading charts…</div>
					) : err ? (
						<div className="error-message" style={{ marginBottom: '0.5rem' }}>
							{err}
						</div>
					) : points.length === 0 ? (
						<div className="business-servers-metrics-loading">No metrics in the last 3 days.</div>
					) : (
						chartGrid
					)}
				</>
			)}
		</div>
	);
}
