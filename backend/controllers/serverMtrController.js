const crypto = require('crypto');

const MTR_JOB_TTL_MS = 20 * 60 * 1000;

class ServerMtrController {
  constructor(serverMtrService, authService) {
    this.serverMtrService = serverMtrService;
    this.authService = authService;
    /** @type {Map<string, object>} */
    this._mtrJobs = new Map();
  }

  purgeExpiredMtrJobs() {
    const now = Date.now();
    for (const [id, v] of this._mtrJobs) {
      if (v.expiresAt < now) {
        this._mtrJobs.delete(id);
      }
    }
  }

  viewerFromJob(job) {
    if (job.legacyBasic) {
      return { legacyBasic: true, anonymous: false, role: job.role || 'admin' };
    }
    return {
      id: job.userId,
      email: job.email || '',
      role: job.role || 'user',
      verified: true,
      legacyBasic: false,
      anonymous: false,
    };
  }

  validateMtrJob(req, jobId) {
    if (!jobId || typeof jobId !== 'string') {
      return null;
    }
    this.purgeExpiredMtrJobs();
    const j = this._mtrJobs.get(jobId);
    if (!j) {
      return null;
    }
    const u = req.authUser;
    if (!u) {
      return null;
    }
    if (j.legacyBasic) {
      return u.legacyBasic ? j : null;
    }
    if (u.legacyBasic) {
      return null;
    }
    return Number(u.id) === Number(j.userId) ? j : null;
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

  async resolveMtrServerOrder(viewer, serverIds, clientIpNorm) {
    const rows = await this.serverMtrService.serverPingService.loadRowsForViewer(viewer, clientIpNorm);
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    const ordered = [];
    const seen = new Set();
    for (const raw of serverIds) {
      const sid = Number(raw);
      if (!Number.isFinite(sid) || sid <= 0) {
        continue;
      }
      if (seen.has(sid)) continue;
      seen.add(sid);
      const row = byId.get(sid);
      if (!row) {
        const err = new Error(`Server ${sid} not found or not visible`);
        err.statusCode = 404;
        throw err;
      }
      ordered.push(row);
    }
    if (ordered.length === 0) {
      const err = new Error('No valid server IDs');
      err.statusCode = 400;
      throw err;
    }
    const serverIdToGroup = {};
    for (const row of ordered) {
      serverIdToGroup[row.id] = row.group_name;
    }
    return {
      orderedServerIds: ordered.map((r) => Number(r.id)),
      serverIdToGroup,
    };
  }

  async getList(req, res) {
    try {
      const defaultPort = this.serverMtrService.serverPingService.proxyService?.config?.PROXY_PORTS?.[0];
      const proxyPort = req.query.proxyPort || (defaultPort != null ? String(defaultPort) : '');
      if (!proxyPort) {
        return res.json({
          success: true,
          servers: {},
          groups: [],
          geoDbAvailable: this.serverMtrService.serverPingService.geoIpService
            ? this.serverMtrService.serverPingService.geoIpService.isDatabasePresent()
            : false,
          proxyPort: null,
          historyLimit: 1,
        });
      }
      const historyLimit = Math.min(
        Math.max(1, parseInt(req.query.historyLimit || '1', 10) || 1),
        20
      );
      const viewer = this.viewerFromRequest(req);
      const { getClientIp, normalizeClientIp } = require('../utils/clientIp');
      const clientIpNorm = normalizeClientIp(getClientIp(req));
      const payload = await this.serverMtrService.getFullListWithHistory(
        proxyPort,
        historyLimit,
        viewer,
        clientIpNorm
      );
      res.json({
        success: true,
        servers: payload.servers,
        groups: payload.groups,
        geoDbAvailable: payload.geoDbAvailable,
        proxyPort: Number(proxyPort),
        historyLimit,
      });
    } catch (error) {
      console.error('❌ Error getting MTR list:', error.message);
      res.status(500).json({
        success: false,
        error: 'Failed to get MTR list',
      });
    }
  }

  async getRun(req, res) {
    try {
      const viewer = this.viewerFromRequest(req);
      const row = await this.serverMtrService.getRunById(req.params.id, viewer);
      res.json({ success: true, run: row });
    } catch (error) {
      const code = error.statusCode === 404 ? 404 : error.statusCode === 403 ? 403 : 500;
      if (code === 404 || code === 403) {
        return res.status(code).json({ success: false, error: error.message || 'Not found' });
      }
      console.error('❌ Error loading MTR run:', error.message);
      res.status(500).json({ success: false, error: 'Failed to load run' });
    }
  }

  buildMtrHistoryEntry(result) {
    const hopCount = result.summary?.report?.hubs?.length ?? null;
    return {
      id: result.runId,
      status: result.status,
      path_mode: result.pathMode,
      error_message: result.error_message,
      created_at: result.timestamp,
      hop_count: hopCount,
      target_rtt_ms: result.targetRttMs != null ? result.targetRttMs : null,
      preview:
        hopCount != null ? `${hopCount} hops` : result.status === 'success' ? 'OK' : '—',
    };
  }

  async runMtrJob(jobId) {
    const job = this._mtrJobs.get(jobId);
    if (!job || job.status !== 'queued') {
      return;
    }
    job.status = 'running';
    const viewer = this.viewerFromJob(job);
    try {
      for (let i = 0; i < job.serverIds.length; i += 1) {
        const serverId = job.serverIds[i];
        job.processingServerId = serverId;
        const groupName = job.serverIdToGroup[serverId] ?? job.serverIdToGroup[String(serverId)];
        try {
          const result = await this.serverMtrService.runMtrForServer(
            serverId,
            job.proxyPort,
            viewer,
            job.clientIpNorm || null
          );
          const historyEntry = this.buildMtrHistoryEntry(result);
          job.results.push({
            serverId: Number(serverId),
            groupName,
            historyEntry,
            result,
          });
        } catch (e) {
          const msg = e.message || 'MTR failed';
          job.results.push({
            serverId: Number(serverId),
            groupName,
            historyEntry: null,
            error: msg,
          });
        }
      }
      job.processingServerId = null;
      job.status = 'completed';
    } catch (e) {
      job.status = 'failed';
      job.error = e.message || 'MTR job failed';
      job.processingServerId = null;
    }
  }

  async startMtrSequence(req, res) {
    try {
      const viewer = this.viewerFromRequest(req);
      if (viewer.anonymous || !req.authUser) {
        return res.status(401).json({
          success: false,
          error: 'Sign in to run MTR',
        });
      }
      const serverIds = req.body?.serverIds;
      if (!Array.isArray(serverIds) || serverIds.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'serverIds (non-empty array) is required',
        });
      }

      const { getClientIp, normalizeClientIp } = require('../utils/clientIp');
      const clientIpNorm = normalizeClientIp(getClientIp(req));

      let meta;
      try {
        meta = await this.resolveMtrServerOrder(viewer, serverIds, clientIpNorm);
      } catch (e) {
        const code = e.statusCode === 404 ? 404 : e.statusCode === 400 ? 400 : 500;
        if (code !== 500) {
          return res.status(code).json({ success: false, error: e.message || 'Invalid request' });
        }
        throw e;
      }

      const multiTarget = meta.orderedServerIds.length > 1;
      if (multiTarget && !viewer.legacyBasic && viewer.role !== 'admin') {
        return res.status(403).json({
          success: false,
          error: 'Only administrators can run Check all',
        });
      }
      if (!multiTarget && !viewer.legacyBasic && viewer.id && viewer.role !== 'admin') {
        const limit = this.authService.pingCheckLimit();
        const used = await this.authService.countRecentPingChecks(viewer.id);
        if (used >= limit) {
          const mins = this.authService.pingCheckWindowMinutes();
          return res.status(429).json({
            success: false,
            error: `You can run at most ${limit} MTR runs per ${mins} minutes. Try again later.`,
          });
        }
        await this.authService.recordPingCheck(viewer.id);
      }

      const proxyPortRaw = req.body?.proxyPort ?? req.query?.proxyPort;
      const proxyPort =
        proxyPortRaw != null && proxyPortRaw !== '' ? Number(proxyPortRaw) : null;
      if (proxyPort == null || !Number.isFinite(proxyPort)) {
        return res.status(400).json({ success: false, error: 'proxyPort is required' });
      }

      const u = req.authUser;
      const jobId = crypto.randomUUID();
      this.purgeExpiredMtrJobs();
      this._mtrJobs.set(jobId, {
        userId: u.legacyBasic ? null : u.id,
        legacyBasic: !!u.legacyBasic,
        role: u.role,
        email: u.email,
        clientIpNorm: clientIpNorm || null,
        expiresAt: Date.now() + MTR_JOB_TTL_MS,
        status: 'queued',
        proxyPort,
        serverIds: meta.orderedServerIds,
        serverIdToGroup: meta.serverIdToGroup,
        results: [],
        error: null,
        processingServerId: null,
      });

      setImmediate(() => {
        this.runMtrJob(jobId).catch((err) => {
          console.error('❌ MTR job crashed:', err.message);
          const j = this._mtrJobs.get(jobId);
          if (j && j.status === 'running') {
            j.status = 'failed';
            j.error = err.message || 'MTR job crashed';
            j.processingServerId = null;
          }
        });
      });

      res.status(201).json({
        success: true,
        jobId,
        proxyPort,
        count: meta.orderedServerIds.length,
      });
    } catch (error) {
      console.error('❌ Error starting MTR job:', error.message);
      res.status(500).json({
        success: false,
        error: 'Failed to start MTR batch',
        message: error.message,
      });
    }
  }

  async getMtrJob(req, res) {
    try {
      const job = this.validateMtrJob(req, req.params.jobId);
      if (!job) {
        return res.status(404).json({ success: false, error: 'Job not found or expired' });
      }
      res.json({
        success: true,
        jobId: req.params.jobId,
        status: job.status,
        completed: job.results.length,
        total: job.serverIds.length,
        processingServerId: job.processingServerId,
        results: job.results,
        error: job.error,
      });
    } catch (error) {
      console.error('❌ Error reading MTR job:', error.message);
      res.status(500).json({ success: false, error: 'Failed to read job status' });
    }
  }
}

module.exports = ServerMtrController;
