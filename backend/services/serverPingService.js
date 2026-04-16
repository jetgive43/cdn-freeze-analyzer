const net = require('net');
const { getClientIp, normalizeClientIp } = require('../utils/clientIp');

function normalizeTargetPort(port) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    return null;
  }
  return n;
}

function serverHistoryKey(ip, port) {
  const p = normalizeTargetPort(port) ?? 80;
  return `${ip}:${p}`;
}

function effectiveHttpPort(row) {
  return normalizeTargetPort(row.target_port) ?? 80;
}

/** Path-only fragment for HTTP probe (e.g. `/` or `/health`). Admin-editable; empty stored as ''. */
function normalizeHttpProbePath(raw) {
  if (raw == null) {
    return '';
  }
  let s = String(raw).trim();
  if (s === '') {
    return '';
  }
  if (s.length > 512) {
    s = s.slice(0, 512);
  }
  if (!s.startsWith('/')) {
    s = `/${s}`;
  }
  if (s.startsWith('//')) {
    s = `/${s.replace(/^\/+/, '')}`;
  }
  return s;
}

class ServerPingService {
  constructor(proxyService, db, databaseService, geoIpService, authService) {
    this.proxyService = proxyService;
    this.db = db;
    this.databaseService = databaseService;
    this.geoIpService = geoIpService;
    this.authService = authService;
  }

  isAdminViewer(viewer) {
    return !!(viewer && (viewer.legacyBasic || viewer.role === 'admin'));
  }

  /**
   * @param {object} row - target row with creator_key, user_id, client_ip
   * @param {string|null} clientIpNorm - normalized client IP for this request
   */
  canModifyTarget(viewer, row, clientIpNorm) {
    if (!row) {
      return false;
    }
    if (this.isAdminViewer(viewer)) {
      return true;
    }
    const ck = String(row.creator_key || '');
    if (ck.startsWith('ip:') && clientIpNorm && ck === `ip:${clientIpNorm}`) {
      return true;
    }
    if (viewer && !viewer.anonymous && viewer.id != null && ck === `uid:${viewer.id}`) {
      return true;
    }
    return false;
  }

  async loadRowsForViewer(viewer, clientIpNorm = null) {
    const adminId = await this.authService.getAdminUserId();
    if (adminId == null) {
      throw new Error('Server ping is not configured (admin user missing)');
    }
    const adminKey = `uid:${adminId}`;
    const base = `SELECT id, group_name, location, ip_address, target_port, ssh_port, http_probe_path, user_id, client_ip, creator_key
       FROM server_ping_targets WHERE `;
    let sql;
    const params = [];
    if (this.isAdminViewer(viewer)) {
      sql = `${base}1=1`;
    } else {
      const keys = [adminKey];
      const ipN = clientIpNorm ? normalizeClientIp(clientIpNorm) : '';
      if (ipN) {
        keys.push(`ip:${ipN}`);
      }
      if (viewer && !viewer.anonymous && viewer.id != null) {
        keys.push(`uid:${viewer.id}`);
      }
      sql = `${base}creator_key IN (${keys.map(() => '?').join(',')})`;
      params.push(...keys);
    }
    sql += ' ORDER BY group_name ASC, sort_order ASC, id ASC';
    const [rows] = await this.db.execute(sql, params);
    return rows;
  }

  rowsToGrouped(rows) {
    const grouped = {};
    for (const row of rows) {
      const g = row.group_name;
      if (!grouped[g]) {
        grouped[g] = [];
      }
      const targetPort = normalizeTargetPort(row.target_port) ?? 80;
      const sshP = normalizeTargetPort(row.ssh_port) ?? 22;
      const httpPath = row.http_probe_path != null ? String(row.http_probe_path) : '';
      grouped[g].push({
        id: row.id,
        location: row.location,
        ip: row.ip_address,
        port: targetPort,
        targetPort,
        sshPort: sshP,
        httpProbePath: httpPath,
        userId: row.user_id != null ? Number(row.user_id) : null,
        clientIp: row.client_ip != null && String(row.client_ip).trim() !== '' ? String(row.client_ip) : null,
        creatorKey: row.creator_key != null ? String(row.creator_key) : null,
      });
    }
    return grouped;
  }

  async listGroupNames(viewer, clientIpNorm) {
    const rows = await this.loadRowsForViewer(viewer, clientIpNorm);
    return [...new Set(rows.map((r) => r.group_name))].sort();
  }

  resolveGroupName(groupName, newGroupName) {
    const sel = (groupName || '').trim();
    if (sel === '__new__' || sel === '') {
      const n = (newGroupName || '').trim();
      if (!n) {
        throw new Error('New group name is required');
      }
      return n;
    }
    return sel;
  }

  /**
   * Admin / basic-auth: targets owned by admin user_id.
   * Everyone else: identity is client IP — store normalized client IP, no user_id (JWT optional).
   */
  async addServer({ groupName, newGroupName, ip, location, port, targetPort, httpProbePath }, viewer, clientIpNorm) {
    const g = this.resolveGroupName(groupName, newGroupName);
    const ipNorm = (ip || '').trim();
    if (!ipNorm) {
      throw new Error('ip is required');
    }
    if (net.isIP(ipNorm) === 0) {
      throw new Error('Invalid IP address');
    }
    const tp =
      normalizeTargetPort(targetPort != null && targetPort !== '' ? targetPort : null) ??
      normalizeTargetPort(port != null && port !== '' ? port : null) ??
      80;

    let loc = (location || '').trim();
    if (!loc && this.geoIpService) {
      const { name } = await this.geoIpService.lookupCountry(ipNorm);
      loc = name || 'Unknown';
    }
    if (!loc) {
      loc = 'Unknown';
    }

    const adminId = await this.authService.getAdminUserId();
    if (adminId == null) {
      throw new Error('Server configuration error');
    }

    let userIdIns = null;
    let clientIpIns = null;
    let creatorKey;

    if (this.isAdminViewer(viewer)) {
      userIdIns = Number(adminId);
      creatorKey = `uid:${adminId}`;
    } else {
      const ipN = clientIpNorm ? normalizeClientIp(clientIpNorm) : '';
      if (!ipN) {
        const err = new Error('Could not determine client IP');
        err.statusCode = 400;
        throw err;
      }
      userIdIns = null;
      clientIpIns = ipN;
      creatorKey = `ip:${ipN}`;
    }

    const [maxRows] = await this.db.execute(
      'SELECT COALESCE(MAX(sort_order), -1) AS m FROM server_ping_targets WHERE group_name = ?',
      [g]
    );
    const nextOrder = Number(maxRows[0]?.m ?? -1) + 1;
    const pathIns = this.isAdminViewer(viewer) ? normalizeHttpProbePath(httpProbePath) : '';
    const [result] = await this.db.execute(
      `INSERT INTO server_ping_targets (group_name, location, ip_address, target_port, ssh_port, http_probe_path, sort_order, user_id, client_ip, creator_key)
       VALUES (?, ?, ?, ?, 22, ?, ?, ?, ?, ?)`,
      [g, loc, ipNorm, tp, pathIns, nextOrder, userIdIns, clientIpIns, creatorKey]
    );
    return {
      id: result.insertId,
      groupName: g,
      location: loc,
      ip: ipNorm,
      port: tp,
      targetPort: tp,
      httpProbePath: pathIns,
      userId: userIdIns,
      clientIp: clientIpIns,
      creatorKey,
    };
  }

  async updateServer(id, { location, port, ip, targetPort, httpProbePath }, viewer, clientIpNorm) {
    const numericId = Number(id);
    if (!Number.isFinite(numericId) || numericId <= 0) {
      throw new Error('Invalid server id');
    }
    const [existingRows] = await this.db.execute(
      'SELECT group_name, ip_address, target_port, ssh_port, http_probe_path, user_id, client_ip, creator_key FROM server_ping_targets WHERE id = ?',
      [numericId]
    );
    const existing = existingRows[0];
    if (!existing) {
      return null;
    }
    if (!this.canModifyTarget(viewer, existing, clientIpNorm ? normalizeClientIp(clientIpNorm) : null)) {
      const err = new Error('Forbidden');
      err.statusCode = 403;
      throw err;
    }

    const updates = [];
    const params = [];
    if (ip !== undefined) {
      const ipNorm = String(ip ?? '').trim();
      if (!ipNorm) {
        throw new Error('ip cannot be empty');
      }
      if (net.isIP(ipNorm) === 0) {
        throw new Error('Invalid IP address');
      }
      updates.push('ip_address = ?');
      params.push(ipNorm);
    }
    if (location !== undefined) {
      const loc = String(location ?? '').trim();
      if (!loc) {
        throw new Error('location cannot be empty');
      }
      updates.push('location = ?');
      params.push(loc);
    }

    const hasExplicitTargetPort =
      targetPort !== undefined && targetPort !== null && targetPort !== '';

    if (hasExplicitTargetPort) {
      const tpn = normalizeTargetPort(targetPort);
      if (tpn == null) {
        throw new Error('targetPort must be an integer from 1 to 65535');
      }
      updates.push('target_port = ?');
      params.push(tpn);
    }
    if (port !== undefined && port !== null && port !== '') {
      const p = normalizeTargetPort(port);
      if (p == null) {
        throw new Error('port must be an integer from 1 to 65535');
      }
      if (!hasExplicitTargetPort) {
        updates.push('target_port = ?');
        params.push(p);
      }
    }

    if (httpProbePath !== undefined && this.isAdminViewer(viewer)) {
      updates.push('http_probe_path = ?');
      params.push(normalizeHttpProbePath(httpProbePath));
    }

    if (updates.length === 0) {
      throw new Error('No fields to update');
    }
    params.push(numericId);
    const [res] = await this.db.execute(
      `UPDATE server_ping_targets SET ${updates.join(', ')} WHERE id = ?`,
      params
    );
    if (res.affectedRows === 0) {
      return null;
    }
    const [rows] = await this.db.execute(
      'SELECT id, group_name, location, ip_address, target_port, ssh_port, http_probe_path, user_id, client_ip, creator_key FROM server_ping_targets WHERE id = ?',
      [numericId]
    );
    const row = rows[0];
    const tp = normalizeTargetPort(row.target_port) ?? 80;
    const sshP = normalizeTargetPort(row.ssh_port) ?? 22;
    const hPath = row.http_probe_path != null ? String(row.http_probe_path) : '';
    return {
      id: row.id,
      groupName: row.group_name,
      location: row.location,
      ip: row.ip_address,
      port: tp,
      targetPort: tp,
      sshPort: sshP,
      httpProbePath: hPath,
      userId: row.user_id != null ? Number(row.user_id) : null,
      clientIp: row.client_ip != null ? String(row.client_ip) : null,
      creatorKey: row.creator_key != null ? String(row.creator_key) : null,
    };
  }

  async deleteServer(id, viewer, clientIpNorm) {
    const numericId = Number(id);
    if (!Number.isFinite(numericId) || numericId <= 0) {
      throw new Error('Invalid server id');
    }
    const [existingRows] = await this.db.execute(
      'SELECT user_id, client_ip, creator_key FROM server_ping_targets WHERE id = ?',
      [numericId]
    );
    if (!existingRows[0]) {
      return false;
    }
    if (!this.canModifyTarget(viewer, existingRows[0], clientIpNorm ? normalizeClientIp(clientIpNorm) : null)) {
      const err = new Error('Forbidden');
      err.statusCode = 403;
      throw err;
    }
    const [res] = await this.db.execute(
      'DELETE FROM server_ping_targets WHERE id = ?',
      [numericId]
    );
    return res.affectedRows > 0;
  }

  /**
   * Persist rows from browser-originated HTTP probes (traffic from the user's browser, not this server).
   * proxy_host is stored as "browser" for filtering/debugging.
   */
  async recordClientBrowserPingBatch(viewer, viewerMeta, items, clientIpNorm) {
    if (!Array.isArray(items) || items.length === 0) {
      return { saved: 0, skipped: 0 };
    }
    const rows = await this.loadRowsForViewer(viewer, clientIpNorm);
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    let saved = 0;
    let skipped = 0;
    for (const it of items) {
      const sid = Number(it.serverId);
      if (!Number.isFinite(sid) || sid <= 0) {
        skipped += 1;
        continue;
      }
      const row = byId.get(sid);
      if (!row) {
        skipped += 1;
        continue;
      }
      const st = String(it.status || '').toLowerCase();
      const status = st === 'success' || st === 'timeout' || st === 'failed' ? st : 'failed';
      const rttRaw = it.rtt_ms;
      const rtt_ms =
        rttRaw != null && rttRaw !== '' && Number.isFinite(Number(rttRaw)) ? Number(rttRaw) : null;
      const err = it.error_message != null ? String(it.error_message).slice(0, 2000) : null;
      const group = row.group_name;
      const targetPort = effectiveHttpPort(row);
      await this.persistServerPingMeasurement(
        { id: row.id, ip: row.ip_address, group },
        { status, rtt_ms, error_message: err },
        'browser',
        0,
        targetPort,
        { clientBrowserProbe: true },
        viewerMeta
      );
      saved += 1;
    }
    return { saved, skipped };
  }

  async persistServerPingMeasurement(
    serverCtx,
    measurement,
    proxyHost,
    proxyPort,
    targetPort,
    messageExtra = null,
    viewerMeta = null
  ) {
    if (!this.databaseService) {
      return;
    }
    try {
      const baseMsg = {
        serverPingGroup: serverCtx.group,
        serverPingTargetId: serverCtx.id,
      };
      if (messageExtra && typeof messageExtra === 'object') {
        Object.assign(baseMsg, messageExtra);
      }
      await this.databaseService.saveMeasurement({
        target_host: serverCtx.ip,
        target_port: targetPort,
        proxy_host: proxyHost,
        proxy_port: proxyPort,
        status: measurement.status,
        rtt_ms: measurement.rtt_ms,
        error_message: measurement.error_message,
        message: JSON.stringify(baseMsg),
        measurement_type: 'server_ping',
        check_type: 'http',
        viewer_country_code: viewerMeta?.countryCode ?? null,
        viewer_country_name: viewerMeta?.countryName ?? null,
        viewer_isp: viewerMeta?.isp ?? null,
      });
    } catch (e) {
      console.error('❌ Failed to persist server ping row:', e.message);
    }
  }

  async viewerMetaFromRequest(req) {
    if (!this.geoIpService || typeof this.geoIpService.lookupVisitor !== 'function') {
      return { countryCode: null, countryName: null, isp: null };
    }
    const ip = normalizeClientIp(getClientIp(req));
    if (!ip) {
      return { countryCode: null, countryName: null, isp: null };
    }
    const v = await this.geoIpService.lookupVisitor(ip);
    return {
      countryCode: v.countryCode || null,
      countryName: v.countryName || null,
      isp: v.isp || null,
    };
  }

  rowTargetPort(row) {
    return effectiveHttpPort(row);
  }

  /**
   * Resolve and order DB rows for server IDs visible to this viewer (same rules as list).
   */
  async resolveOrderedServerRows(viewer, serverIds, clientIpNorm) {
    const rows = await this.loadRowsForViewer(viewer, clientIpNorm);
    const byId = new Map(rows.map((r) => [Number(r.id), r]));
    const ordered = [];
    const seen = new Set();
    for (const raw of serverIds || []) {
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
    return { orderedRows: ordered, serverIdToGroup };
  }

  /**
   * TCP connect RTT toward target; uses SERVER_PING_TCP_MODE (auto|direct|socks) and proxy ports when applicable.
   * @returns {{ status: string, rtt_ms: number|null, error_message: string|null, proxyHost: string, proxyPort: number }}
   */
  async measureTcpForServerPing(targetHost, targetPort) {
    const ps = this.proxyService;
    const mode = String(process.env.SERVER_PING_TCP_MODE || 'auto').toLowerCase();
    const timeout = Math.min(
      120000,
      Math.max(500, Number(process.env.SERVER_PING_TCP_TIMEOUT_MS) || 15000)
    );
    const ports = (ps && ps.config && ps.config.PROXY_PORTS) || [];
    const proxyHost = (ps && ps.config && ps.config.PROXY_HOST) || '127.0.0.1';
    const user = process.env.PROXY_USER || '';
    const pass = process.env.PROXY_PASS || '';

    let useSocks = mode === 'socks' || (mode === 'auto' && ports.length > 0);
    if (mode === 'direct') {
      useSocks = false;
    }

    if (useSocks && ports.length) {
      const proxyPort = Number(ports[0]);
      const r = await ps.measureTcpViaSocks5(targetHost, targetPort, proxyHost, proxyPort, user, pass, timeout);
      return { ...r, proxyHost: String(proxyHost), proxyPort };
    }
    const r = await ps.measureTcpDirect(targetHost, targetPort, timeout);
    return { ...r, proxyHost: 'direct', proxyPort: 0 };
  }

  async getFullListWithHistory(regionCode, historyLimit, viewer, viewerIspFilter, clientIpNorm) {
    const rows = await this.loadRowsForViewer(viewer, clientIpNorm);
    const servers = this.rowsToGrouped(rows);
    const groups = [...new Set(rows.map((r) => r.group_name))].sort();
    const targets = rows.map((r) => ({
      ip: r.ip_address,
      port: effectiveHttpPort(r),
    }));
    const historyByKey = await this.databaseService.getServerPingHistoryBatch(
      regionCode,
      targets,
      historyLimit,
      viewerIspFilter
    );

    const serversWithHistory = {};
    for (const [gName, list] of Object.entries(servers)) {
      serversWithHistory[gName] = list.map((s) => ({
        ...s,
        history: historyByKey[serverHistoryKey(s.ip, s.port)] || [],
      }));
    }

    return {
      servers: serversWithHistory,
      groups,
      geoDbAvailable: this.geoIpService ? this.geoIpService.isDatabasePresent() : false,
    };
  }
}

module.exports = ServerPingService;
