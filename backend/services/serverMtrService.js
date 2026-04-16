const { execFile } = require('child_process');
const util = require('util');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const dns = require('dns').promises;

const execFileAsync = util.promisify(execFile);

const MTR_TIMEOUT_MS = Math.min(
  Math.max(30_000, parseInt(process.env.MTR_TIMEOUT_MS || '120000', 10) || 120_000),
  300_000
);
const MTR_REPORT_CYCLES = Math.min(
  Math.max(3, parseInt(process.env.MTR_REPORT_CYCLES || '8', 10) || 8),
  30
);
/** If true, omit mtr --no-dns (may resolve hop names; still not a full “exit country” traceroute). */
const MTR_USE_DNS = String(process.env.MTR_USE_DNS || '').toLowerCase() === 'true';

function targetRttMsFromMtrSummary(summary) {
  const hubs = summary?.report?.hubs;
  if (!Array.isArray(hubs) || hubs.length === 0) {
    return null;
  }
  const last = hubs[hubs.length - 1];
  const raw = last?.Avg ?? last?.avg ?? last?.Last ?? last?.last;
  if (raw == null) {
    return null;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function normalizeTargetPort(port) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    return null;
  }
  return n;
}

function effectiveHttpPort(row) {
  return normalizeTargetPort(row.target_port) ?? 80;
}

function mtrPath() {
  const p = (process.env.MTR_BIN || '/usr/bin/mtr').trim();
  return p || '/usr/bin/mtr';
}

function pathModeFromEnv() {
  const v = String(process.env.MTR_PATH_MODE || 'auto').toLowerCase().trim();
  if (v === 'socks' || v === 'direct' || v === 'auto') {
    return v;
  }
  return 'auto';
}

function socksHostForProxy(proxyHost) {
  const h = (process.env.SOCKS5_PROXY_HOST || '').trim();
  return h || proxyHost;
}

async function resolveProxychainsBin() {
  const fromEnv = (process.env.PROXYCHAINS_BIN || '').trim();
  if (fromEnv && fsSync.existsSync(fromEnv)) {
    return fromEnv;
  }
  for (const name of ['proxychains4', 'proxychains']) {
    try {
      const { stdout } = await execFileAsync('which', [name], { timeout: 3000 });
      const line = String(stdout || '').trim().split('\n')[0];
      if (line && fsSync.existsSync(line)) {
        return line;
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

function buildProxychainsConf(proxyHost, proxyPort, proxyUser, proxyPass) {
  const host = String(proxyHost || '').trim();
  const port = Number(proxyPort);
  if (!host || !Number.isFinite(port)) {
    return null;
  }
  const u = proxyUser != null ? String(proxyUser).replace(/[\r\n]/g, '') : '';
  const p = proxyPass != null ? String(proxyPass).replace(/[\r\n]/g, '') : '';
  const line =
    u && p
      ? `socks5 ${host} ${port} ${u} ${p}`
      : `socks5 ${host} ${port}`;
  return `strict_chain
proxy_dns
tcp_read_time_out 15000
tcp_connect_time_out 8000

[ProxyList]
${line}
`;
}

function parseMtrJson(stdout) {
  const t = String(stdout || '').trim();
  if (!t) {
    return { summary: null, pretty: '', parseError: 'empty output' };
  }
  try {
    const summary = JSON.parse(t);
    return { summary, pretty: JSON.stringify(summary, null, 2), parseError: null };
  } catch (e) {
    return { summary: null, pretty: t, parseError: e.message || 'invalid json' };
  }
}

class ServerMtrService {
  constructor(serverPingService, db, databaseService, authService) {
    this.serverPingService = serverPingService;
    this.db = db;
    this.databaseService = databaseService;
    this.authService = authService;
  }

  async assertCanViewTarget(viewer, ctx, clientIpNorm) {
    if (!viewer || viewer.anonymous) {
      const err = new Error('Authentication required');
      err.statusCode = 401;
      throw err;
    }
    if (this.serverPingService.isAdminViewer(viewer)) {
      return;
    }
    const adminId = await this.authService.getAdminUserId();
    const ck = ctx.creatorKey != null ? String(ctx.creatorKey) : '';
    const ipN = clientIpNorm ? String(clientIpNorm).trim() : '';
    if (ck.startsWith('ip:') && ipN && ck === `ip:${ipN}`) {
      return;
    }
    if (ctx.userId != null) {
      const uid = Number(ctx.userId);
      if (uid === Number(viewer.id) || uid === Number(adminId)) {
        return;
      }
    }
    const err = new Error('Forbidden');
    err.statusCode = 403;
    throw err;
  }

  async findServerContext(serverId, viewer, clientIpNorm) {
    const rows = await this.serverPingService.loadRowsForViewer(viewer, clientIpNorm);
    const sid = Number(serverId);
    if (!Number.isFinite(sid) || sid <= 0) {
      const err = new Error('Invalid server id');
      err.statusCode = 400;
      throw err;
    }
    for (const row of rows) {
      if (Number(row.id) === sid) {
        const group = row.group_name;
        const targetPort = effectiveHttpPort(row);
        return {
          id: sid,
          group,
          ip: row.ip_address,
          location: row.location,
          targetPort,
          userId: row.user_id != null ? Number(row.user_id) : null,
          creatorKey: row.creator_key != null ? String(row.creator_key) : null,
          clientIp: row.client_ip != null ? String(row.client_ip) : null,
        };
      }
    }
    const err = new Error('Server not found');
    err.statusCode = 404;
    throw err;
  }

  async getFullListWithHistory(proxyPort, historyLimit, viewer, clientIpNorm) {
    const rows = await this.serverPingService.loadRowsForViewer(viewer, clientIpNorm);
    const grouped = this.serverPingService.rowsToGrouped(rows);
    const groups = [...new Set(rows.map((r) => r.group_name))].sort();
    const targetIds = rows.map((r) => Number(r.id));
    const historyById = await this.databaseService.getServerMtrHistoryBatch(
      proxyPort,
      targetIds,
      historyLimit
    );

    const serversWithHistory = {};
    for (const [gName, list] of Object.entries(grouped)) {
      serversWithHistory[gName] = list.map((s) => ({
        ...s,
        mtrHistory: historyById[s.id] || [],
      }));
    }

    return {
      servers: serversWithHistory,
      groups,
      geoDbAvailable: this.serverPingService.geoIpService
        ? this.serverPingService.geoIpService.isDatabasePresent()
        : false,
    };
  }

  /**
   * Run TCP MTR toward target; prefer SOCKS path via proxychains when MTR_PATH_MODE allows it.
   */
  async runMtrForServer(serverId, proxyPort, viewer, clientIpNorm) {
    const ctx = await this.findServerContext(serverId, viewer, clientIpNorm);
    await this.assertCanViewTarget(viewer, ctx, clientIpNorm);

    const proxyPorts = proxyPort
      ? [Number(proxyPort)]
      : this.serverPingService.proxyService.config?.PROXY_PORTS || [];
    if (!proxyPorts.length || !Number.isFinite(Number(proxyPorts[0]))) {
      throw new Error('No proxy port selected');
    }
    const testProxyPort = proxyPorts[0];
    const proxyHostCfg =
      this.serverPingService.proxyService.config?.PROXY_HOST || 'proxy.soax.com';
    const socksHost = socksHostForProxy(proxyHostCfg);
    const proxyUser = process.env.PROXY_USER || '';
    const proxyPass = process.env.PROXY_PASS || '';

    const mode = pathModeFromEnv();
    const mtrBin = mtrPath();
    const host = ctx.ip;
    const cycles = MTR_REPORT_CYCLES;
    const targetPort = ctx.targetPort;

    const mtrArgs = ['-rwznc', String(cycles), '-T', '-P', String(targetPort)];
    if (!MTR_USE_DNS) {
      mtrArgs.push('--no-dns');
    }
    mtrArgs.push('--json', host);

    const execOpts = {
      timeout: MTR_TIMEOUT_MS,
      maxBuffer: 12 * 1024 * 1024,
    };

    let pathMode = 'direct';
    let stdout = '';
    let stderr = '';
    let exitCode = 0;

    const runMtrDirect = async () => {
      const r = await execFileAsync(mtrBin, mtrArgs, execOpts);
      return {
        pathMode: 'direct',
        stdout: String(r.stdout || ''),
        stderr: String(r.stderr || ''),
        exitCode: 0,
      };
    };

    const runMtrSocks = async (pcBin, confPath) => {
      const r = await execFileAsync(pcBin, ['-q', '-f', confPath, mtrBin, ...mtrArgs], execOpts);
      return {
        pathMode: 'socks_proxy',
        stdout: String(r.stdout || ''),
        stderr: String(r.stderr || ''),
        exitCode: 0,
      };
    };

    let confPath = null;
    try {
      if (mode === 'direct') {
        const out = await runMtrDirect();
        pathMode = out.pathMode;
        stdout = out.stdout;
        stderr = out.stderr;
        exitCode = out.exitCode;
      } else if (mode === 'socks') {
        const pcBin = await resolveProxychainsBin();
        if (!pcBin) {
          const err = new Error(
            'MTR_PATH_MODE=socks requires proxychains4 (e.g. apt install proxychains4)'
          );
          err.statusCode = 503;
          throw err;
        }
        const confBody = buildProxychainsConf(socksHost, testProxyPort, proxyUser, proxyPass);
        if (!confBody) {
          const err = new Error('Invalid proxy host/port for SOCKS');
          err.statusCode = 400;
          throw err;
        }
        confPath = path.join(
          os.tmpdir(),
          `mtr-pc-${Date.now()}-${Math.random().toString(16).slice(2)}.conf`
        );
        await fs.writeFile(confPath, confBody, { mode: 0o600 });
        const out = await runMtrSocks(pcBin, confPath);
        pathMode = out.pathMode;
        stdout = out.stdout;
        stderr = out.stderr;
        exitCode = out.exitCode;
      } else {
        const pcBin = await resolveProxychainsBin();
        const confBody = buildProxychainsConf(socksHost, testProxyPort, proxyUser, proxyPass);
        if (pcBin && confBody) {
          confPath = path.join(
            os.tmpdir(),
            `mtr-pc-${Date.now()}-${Math.random().toString(16).slice(2)}.conf`
          );
          await fs.writeFile(confPath, confBody, { mode: 0o600 });
          try {
            const out = await runMtrSocks(pcBin, confPath);
            pathMode = out.pathMode;
            stdout = out.stdout;
            stderr = out.stderr;
            exitCode = out.exitCode;
          } catch (socksErr) {
            const note = `SOCKS/proxychains MTR failed (${socksErr.message || socksErr.code}); retried direct from this host.`;
            try {
              const out = await runMtrDirect();
              pathMode = out.pathMode;
              stdout = out.stdout;
              stderr = [note, String(socksErr.stderr || ''), out.stderr].filter(Boolean).join('\n');
              exitCode = out.exitCode;
            } catch (directErr) {
              exitCode = typeof directErr.code === 'number' ? directErr.code : 1;
              stdout = String(directErr.stdout || '');
              stderr = [note, String(socksErr.stderr || ''), String(directErr.stderr || directErr.message || '')]
                .filter(Boolean)
                .join('\n');
            }
          }
        } else {
          const out = await runMtrDirect();
          pathMode = out.pathMode;
          stdout = out.stdout;
          stderr = [
            out.stderr,
            'proxychains not installed — MTR ran from this host only. Install proxychains4 to trace via SOCKS.',
          ]
            .filter(Boolean)
            .join('\n');
          exitCode = out.exitCode;
        }
      }
    } catch (e) {
      if (e.statusCode) {
        throw e;
      }
      exitCode = typeof e.code === 'number' ? e.code : 1;
      stdout = String(e.stdout || '');
      stderr = String(e.stderr || e.message || '');
    } finally {
      if (confPath) {
        try {
          await fs.unlink(confPath);
        } catch {
          /* ignore */
        }
      }
    }

    const { summary, pretty, parseError } = parseMtrJson(stdout);
    const hubs = summary?.report?.hubs;
    const okJson = summary && Array.isArray(hubs) && hubs.length > 0;
    const status =
      exitCode === 0 && okJson ? 'success' : exitCode === 0 && !okJson ? 'partial' : 'failed';
    const error_message =
      status === 'success'
        ? null
        : [stderr && stderr.trim(), parseError && `JSON: ${parseError}`].filter(Boolean).join(' · ') ||
          'MTR failed';

    const [ins] = await this.db.execute(
      `INSERT INTO server_mtr_runs (
        server_ping_target_id, proxy_host, proxy_port, path_mode, target_port,
        status, report_text, summary_json, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ctx.id,
        socksHost,
        testProxyPort,
        pathMode,
        targetPort,
        status,
        pretty || stdout || null,
        summary ? JSON.stringify(summary) : null,
        error_message,
      ]
    );

    return {
      runId: ins.insertId,
      serverId: ctx.id,
      group: ctx.group,
      location: ctx.location,
      ip: ctx.ip,
      targetPort,
      proxyPort: testProxyPort,
      pathMode,
      status,
      error_message,
      reportText: pretty || stdout || '',
      summary,
      targetRttMs: targetRttMsFromMtrSummary(summary),
      timestamp: new Date().toISOString(),
    };
  }

  async getRunById(runId, viewer) {
    const rid = Number(runId);
    if (!Number.isFinite(rid) || rid <= 0) {
      const err = new Error('Invalid run id');
      err.statusCode = 400;
      throw err;
    }
    const [rows] = await this.db.execute(
      `SELECT r.*, t.user_id AS target_user_id
       FROM server_mtr_runs r
       INNER JOIN server_ping_targets t ON t.id = r.server_ping_target_id
       WHERE r.id = ?`,
      [rid]
    );
    const row = rows[0];
    if (!row) {
      const err = new Error('Run not found');
      err.statusCode = 404;
      throw err;
    }
    await this.assertCanViewTarget(viewer, row.target_user_id);

    let summary = row.summary_json;
    if (typeof summary === 'string') {
      try {
        summary = JSON.parse(summary);
      } catch {
        summary = null;
      }
    }

    const rawHubs = summary?.report?.hubs;
    const hubs = await this.enrichMtrHubsGeo(Array.isArray(rawHubs) ? rawHubs : []);

    return {
      id: row.id,
      server_ping_target_id: row.server_ping_target_id,
      proxy_host: row.proxy_host,
      proxy_port: row.proxy_port,
      path_mode: row.path_mode,
      target_port: row.target_port,
      status: row.status,
      report_text: row.report_text,
      summary_json: summary,
      hubs,
      error_message: row.error_message,
      created_at: row.created_at,
    };
  }

  /** @param {Array<Record<string, unknown>>} hubList */
  async enrichMtrHubsGeo(hubList) {
    const geo = this.serverPingService.geoIpService;
    const out = [];
    for (const h of hubList) {
      const host = String(h?.host ?? '').trim();
      const entry = { ...h };
      let ipForGeo = null;
      if (host && geo) {
        if (net.isIP(host)) {
          ipForGeo = host;
        } else if (!/^\?+$/.test(host) && host.length > 1) {
          try {
            const { address } = await dns.lookup(host, { family: 4 });
            if (address && net.isIP(address)) {
              ipForGeo = address;
            }
          } catch {
            /* unresolved hostname */
          }
        }
      }
      if (ipForGeo) {
        const { code, name } = await geo.lookupCountry(ipForGeo);
        entry.country_code = code;
        entry.country_name = name;
      } else {
        entry.country_code = null;
        entry.country_name = null;
      }
      out.push(entry);
    }
    return out;
  }
}

module.exports = ServerMtrService;
