const crypto = require('crypto');

const PING_JOB_TTL_MS = 20 * 60 * 1000;
const PING_JOB_MAX_TARGETS = 200;
const PING_JOB_MAX_ROUNDS = 20;

function normalizeRegionParam(raw) {
	if (raw == null || raw === '') return '__none__';
	const s = String(raw).trim();
	if (s === '__legacy__' || s === '__none__') return s;
	if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
	return '__none__';
}

/** undefined = all ISPs in country; '__unknown__' = rows with no ISP; else exact viewer_isp */
function normalizeViewerIspParam(raw) {
	if (raw == null || raw === '') return undefined;
	return String(raw);
}

class ServerPingController {
	constructor(serverPingService, authService) {
		this.serverPingService = serverPingService;
		this.authService = authService;
		/** @type {Map<string, object>} */
		this._pingJobs = new Map();
	}

	purgeExpiredPingJobs() {
		const now = Date.now();
		for (const [id, v] of this._pingJobs) {
			if (v.expiresAt < now) {
				this._pingJobs.delete(id);
			}
		}
	}

	validatePingJob(req, jobId) {
		if (!jobId || typeof jobId !== 'string') {
			return null;
		}
		this.purgeExpiredPingJobs();
		const j = this._pingJobs.get(jobId);
		if (!j) {
			return null;
		}
		const clientIpNorm = this.clientIpNorm(req);
		const u = req.authUser;
		if (j.legacyBasic) {
			return u && u.legacyBasic ? j : null;
		}
		if (j.userId != null) {
			if (!u || u.legacyBasic) {
				return null;
			}
			return Number(u.id) === Number(j.userId) ? j : null;
		}
		if (!clientIpNorm || clientIpNorm !== j.clientIpNorm) {
			return null;
		}
		return j;
	}

	async runPingJob(jobId) {
		const job = this._pingJobs.get(jobId);
		if (!job) {
			return;
		}
		job.status = 'running';
		const rounds = job.rounds;
		const gap = job.roundGapMs;
		try {
			for (const row of job.orderedRows) {
				const sid = Number(row.id);
				const groupName = row.group_name;
				const targetIp = row.ip_address;
				const targetPort = this.serverPingService.rowTargetPort(row);
				for (let round = 0; round < rounds; round += 1) {
					if (round > 0 && gap > 0) {
						await new Promise((r) => setTimeout(r, gap));
					}
					const m = await this.serverPingService.measureTcpForServerPing(targetIp, targetPort);
					await this.serverPingService.persistServerPingMeasurement(
						{ id: sid, ip: targetIp, group: groupName },
						{ status: m.status, rtt_ms: m.rtt_ms, error_message: m.error_message },
						m.proxyHost,
						m.proxyPort,
						targetPort,
						{ serverPingTcpJob: true },
						job.viewerMeta
					);
					const ts = new Date().toISOString();
					job.results.push({
						serverId: sid,
						groupName,
						historyEntry: {
							status: m.status,
							rtt_ms: m.rtt_ms,
							error_message: m.error_message,
							created_at: ts,
							timestamp: ts,
						},
					});
				}
			}
			job.status = 'completed';
		} catch (e) {
			job.status = 'failed';
			job.error = e.message || 'Ping job failed';
		}
	}

	async startPingSequence(req, res) {
		try {
			const viewer = this.viewerFromRequest(req);
			const clientIpNorm = this.clientIpNorm(req);
			const u = req.authUser;
			const serverIds = req.body?.serverIds;
			if (!Array.isArray(serverIds) || serverIds.length === 0) {
				return res.status(400).json({ success: false, error: 'serverIds (non-empty array) is required' });
			}
			if (serverIds.length > PING_JOB_MAX_TARGETS) {
				return res.status(400).json({
					success: false,
					error: `At most ${PING_JOB_MAX_TARGETS} servers per run`,
				});
			}
			let rounds = parseInt(req.body?.rounds, 10);
			if (!Number.isFinite(rounds) || rounds < 1) {
				rounds = 3;
			}
			rounds = Math.min(PING_JOB_MAX_ROUNDS, rounds);
			let roundGapMs = parseInt(req.body?.roundGapMs, 10);
			if (!Number.isFinite(roundGapMs) || roundGapMs < 0) {
				roundGapMs = 0;
			}
			roundGapMs = Math.min(120000, roundGapMs);

			if (!clientIpNorm) {
				return res.status(400).json({ success: false, error: 'Could not determine client IP' });
			}

			let meta;
			try {
				meta = await this.serverPingService.resolveOrderedServerRows(viewer, serverIds, clientIpNorm);
			} catch (e) {
				const code = e.statusCode === 404 ? 404 : e.statusCode === 400 ? 400 : 500;
				if (code !== 500) {
					return res.status(code).json({ success: false, error: e.message || 'Invalid request' });
				}
				throw e;
			}

			const viewerMeta = await this.serverPingService.viewerMetaFromRequest(req);
			const jobId = crypto.randomUUID();
			const totalUnits = meta.orderedRows.length * rounds;
			this.purgeExpiredPingJobs();
			this._pingJobs.set(jobId, {
				userId: u && !u.legacyBasic ? u.id : null,
				legacyBasic: !!(u && u.legacyBasic),
				clientIpNorm,
				expiresAt: Date.now() + PING_JOB_TTL_MS,
				status: 'queued',
				orderedRows: meta.orderedRows,
				rounds,
				roundGapMs,
				results: [],
				error: null,
				viewerMeta,
				totalUnits,
			});

			setImmediate(() => {
				this.runPingJob(jobId).catch((err) => {
					console.error('❌ Server ping job crashed:', err.message);
					const j = this._pingJobs.get(jobId);
					if (j && j.status === 'running') {
						j.status = 'failed';
						j.error = err.message || 'Ping job crashed';
					}
				});
			});

			res.status(201).json({
				success: true,
				jobId,
				count: meta.orderedRows.length,
				total: totalUnits,
			});
		} catch (error) {
			console.error('❌ Error starting server ping job:', error.message);
			res.status(500).json({
				success: false,
				error: 'Failed to start ping batch',
				message: error.message,
			});
		}
	}

	async getPingJob(req, res) {
		try {
			const job = this.validatePingJob(req, req.params.jobId);
			if (!job) {
				return res.status(404).json({ success: false, error: 'Job not found or expired' });
			}
			res.json({
				success: true,
				jobId: req.params.jobId,
				status: job.status,
				completed: job.results.length,
				total: job.totalUnits,
				results: job.results,
				error: job.error,
			});
		} catch (error) {
			console.error('❌ Error reading server ping job:', error.message);
			res.status(500).json({ success: false, error: 'Failed to read job status' });
		}
	}

	clientIpNorm(req) {
		const { getClientIp, normalizeClientIp } = require('../utils/clientIp');
		return normalizeClientIp(getClientIp(req)) || null;
	}

	viewerFromRequest(req) {
		const u = req.authUser;
		if (!u) {
			return { anonymous: true };
		}
		if (u.legacyBasic) {
			return { ...u, anonymous: false };
		}
		return {
			id: u.id,
			email: u.email,
			role: u.role,
			verified: true,
			legacyBasic: false,
			anonymous: false,
		};
	}

	async getServerList(req, res) {
		try {
			const historyLimit = Math.min(
				Math.max(1, parseInt(req.query.historyLimit || '12', 10) || 12),
				50
			);
			const region = normalizeRegionParam(req.query.region);
			const viewerIsp = normalizeViewerIspParam(req.query.viewerIsp);
			const viewer = this.viewerFromRequest(req);
			const clientIpNorm = this.clientIpNorm(req);
			const payload = await this.serverPingService.getFullListWithHistory(
				region,
				historyLimit,
				viewer,
				viewerIsp,
				clientIpNorm
			);
			res.json({
				success: true,
				servers: payload.servers,
				groups: payload.groups,
				geoDbAvailable: payload.geoDbAvailable,
				region,
				viewerIsp: viewerIsp ?? null,
				historyLimit,
			});
		} catch (error) {
			console.error('❌ Error getting server list:', error.message);
			res.status(500).json({
				success: false,
				error: 'Failed to get server list',
			});
		}
	}

	async listPingRegions(req, res) {
		try {
			const rows = await this.serverPingService.databaseService.listServerPingViewerRegions();
			const geo = this.serverPingService.geoIpService;
			res.json({
				success: true,
				regions: rows,
				countryDbPresent: geo && typeof geo.isDatabasePresent === 'function' ? geo.isDatabasePresent() : false,
				asnDbPresent: geo && typeof geo.isAsnDatabasePresent === 'function' ? geo.isAsnDatabasePresent() : false,
			});
		} catch (error) {
			console.error('❌ Error listing ping regions:', error.message);
			res.status(500).json({ success: false, error: 'Failed to list regions' });
		}
	}

	async getVisitorGeo(req, res) {
		try {
			const { getClientIp, normalizeClientIp } = require('../utils/clientIp');
			const v = await this.serverPingService.viewerMetaFromRequest(req);
			const geo = this.serverPingService.geoIpService;
			res.json({
				success: true,
				ip: normalizeClientIp(getClientIp(req)) || null,
				countryCode: v.countryCode,
				countryName: v.countryName || 'Unknown',
				isp: v.isp,
				countryDbPresent: geo ? geo.isDatabasePresent() : false,
				asnDbPresent:
					geo && typeof geo.isAsnDatabasePresent === 'function' ? geo.isAsnDatabasePresent() : false,
			});
		} catch (error) {
			console.error('❌ Error visitor geo:', error.message);
			res.status(500).json({ success: false, error: 'Failed to resolve visitor location' });
		}
	}

	async addServer(req, res) {
		try {
			const viewer = this.viewerFromRequest(req);
			const clientIpNorm = this.clientIpNorm(req);
			if (!clientIpNorm) {
				return res.status(400).json({ success: false, error: 'Could not determine client IP' });
			}
			const { groupName, newGroupName, location, ip, port, targetPort, httpProbePath } = req.body || {};
			const created = await this.serverPingService.addServer(
				{
					groupName,
					newGroupName,
					location,
					ip,
					port,
					targetPort,
					httpProbePath,
				},
				viewer,
				clientIpNorm
			);
			res.status(201).json({ success: true, server: created });
		} catch (error) {
			const msg = error.message || 'Failed to add server';
			const status =
				error.statusCode && Number.isInteger(error.statusCode)
					? error.statusCode
					: msg.includes('required') || msg.includes('Invalid')
						? 400
						: 500;
			if (error.code === 'ER_DUP_ENTRY' || error.errno === 1062) {
				return res.status(409).json({
					success: false,
					error: 'That group and IP already exists for this account',
				});
			}
			console.error('❌ Error adding server ping target:', error.message);
			res.status(status).json({ success: false, error: msg });
		}
	}

	async deleteServer(req, res) {
		try {
			const viewer = this.viewerFromRequest(req);
			const clientIpNorm = this.clientIpNorm(req);
			const { id } = req.params;
			const removed = await this.serverPingService.deleteServer(id, viewer, clientIpNorm);
			if (!removed) {
				return res.status(404).json({ success: false, error: 'Server not found' });
			}
			res.json({ success: true });
		} catch (error) {
			if (error.statusCode === 403) {
				return res.status(403).json({ success: false, error: 'Forbidden' });
			}
			const msg = error.message || 'Failed to delete server';
			const status = msg.includes('Invalid') ? 400 : 500;
			console.error('❌ Error deleting server ping target:', error.message);
			res.status(status).json({ success: false, error: msg });
		}
	}

	async patchServer(req, res) {
		try {
			const viewer = this.viewerFromRequest(req);
			const clientIpNorm = this.clientIpNorm(req);
			const { id } = req.params;
			const { location, port, ip, targetPort, httpProbePath } = req.body || {};
			const updated = await this.serverPingService.updateServer(
				id,
				{
					location,
					port,
					ip,
					targetPort,
					httpProbePath,
				},
				viewer,
				clientIpNorm
			);
			if (!updated) {
				return res.status(404).json({ success: false, error: 'Server not found' });
			}
			res.json({ success: true, server: updated });
		} catch (error) {
			if (error.statusCode === 403) {
				return res.status(403).json({ success: false, error: 'Forbidden' });
			}
			const msg = error.message || 'Failed to update server';
			let status = 500;
			if (msg.includes('empty') || msg.includes('No fields') || msg.includes('Invalid') || msg.includes('integer')) {
				status = 400;
			}
			if (error.code === 'ER_DUP_ENTRY' || error.errno === 1062) {
				return res.status(409).json({
					success: false,
					error: 'That group and IP already exists for this account',
				});
			}
			console.error('❌ Error updating server ping target:', error.message);
			res.status(status).json({ success: false, error: msg });
		}
	}

	/** Browser runs HTTP(S) fetch to targets; this endpoint only persists rows (viewer geo from this request). */
	async postClientPingResults(req, res) {
		try {
			const viewer = this.viewerFromRequest(req);
			const clientIpNorm = this.clientIpNorm(req);
			const items = req.body?.results;
			if (!Array.isArray(items) || items.length === 0) {
				return res.status(400).json({
					success: false,
					error: 'results (non-empty array) is required',
				});
			}
			if (items.length > 250) {
				return res.status(400).json({
					success: false,
					error: 'Too many results in one request (max 250)',
				});
			}
			const viewerMeta = await this.serverPingService.viewerMetaFromRequest(req);
			const { saved, skipped } = await this.serverPingService.recordClientBrowserPingBatch(
				viewer,
				viewerMeta,
				items,
				clientIpNorm
			);
			res.json({ success: true, saved, skipped });
		} catch (error) {
			console.error('❌ Error saving client ping results:', error.message);
			res.status(500).json({ success: false, error: 'Failed to save results' });
		}
	}
}

module.exports = ServerPingController;
