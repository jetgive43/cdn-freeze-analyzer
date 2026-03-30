const net = require('net');
const REQUEST_TIMEOUT_MS = 10_000;

class ServerPingService {
  constructor(proxyService, db, databaseService, geoIpService) {
    this.proxyService = proxyService;
    this.db = db;
    this.databaseService = databaseService;
    this.geoIpService = geoIpService;
  }

  rowsToGrouped(rows) {
    const grouped = {};
    for (const row of rows) {
      const g = row.group_name;
      if (!grouped[g]) {
        grouped[g] = [];
      }
      grouped[g].push({
        id: row.id,
        location: row.location,
        ip: row.ip_address,
      });
    }
    return grouped;
  }

  async loadRows() {
    const [rows] = await this.db.execute(
      `SELECT id, group_name, location, ip_address
       FROM server_ping_targets
       ORDER BY group_name ASC, sort_order ASC, id ASC`
    );
    return rows;
  }

  async listGroupNames() {
    const [rows] = await this.db.execute(
      `SELECT DISTINCT group_name FROM server_ping_targets ORDER BY group_name ASC`
    );
    return rows.map((r) => r.group_name);
  }

  async getServerList() {
    const rows = await this.loadRows();
    return this.rowsToGrouped(rows);
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

  async addServer({ groupName, newGroupName, ip, location }) {
    const g = this.resolveGroupName(groupName, newGroupName);
    const ipNorm = (ip || '').trim();
    if (!ipNorm) {
      throw new Error('ip is required');
    }
    if (net.isIP(ipNorm) === 0) {
      throw new Error('Invalid IP address');
    }

    let loc = (location || '').trim();
    if (!loc && this.geoIpService) {
      const { name } = await this.geoIpService.lookupCountry(ipNorm);
      loc = name || 'Unknown';
    }
    if (!loc) {
      loc = 'Unknown';
    }

    const [maxRows] = await this.db.execute(
      'SELECT COALESCE(MAX(sort_order), -1) AS m FROM server_ping_targets WHERE group_name = ?',
      [g]
    );
    const nextOrder = Number(maxRows[0]?.m ?? -1) + 1;
    const [result] = await this.db.execute(
      `INSERT INTO server_ping_targets (group_name, location, ip_address, sort_order)
       VALUES (?, ?, ?, ?)`,
      [g, loc, ipNorm, nextOrder]
    );
    return { id: result.insertId, groupName: g, location: loc, ip: ipNorm };
  }

  async deleteServer(id) {
    const numericId = Number(id);
    if (!Number.isFinite(numericId) || numericId <= 0) {
      throw new Error('Invalid server id');
    }
    const [res] = await this.db.execute(
      'DELETE FROM server_ping_targets WHERE id = ?',
      [numericId]
    );
    return res.affectedRows > 0;
  }

  async persistServerPingMeasurement(serverCtx, measurement, proxyHost, proxyPort, targetPort) {
    if (!this.databaseService) {
      return;
    }
    try {
      await this.databaseService.saveMeasurement({
        target_host: serverCtx.ip,
        target_port: targetPort,
        proxy_host: proxyHost,
        proxy_port: proxyPort,
        status: measurement.status,
        rtt_ms: measurement.rtt_ms,
        error_message: measurement.error_message,
        message: JSON.stringify({
          serverPingGroup: serverCtx.group,
          serverPingTargetId: serverCtx.id,
        }),
        measurement_type: 'server_ping',
      });
    } catch (e) {
      console.error('❌ Failed to persist server ping row:', e.message);
    }
  }

  async getFullListWithHistory(proxyPort, historyLimit) {
    const rows = await this.loadRows();
    const servers = this.rowsToGrouped(rows);
    const groups = [...new Set(rows.map((r) => r.group_name))].sort();
    const ips = [...new Set(rows.map((r) => r.ip_address))];
    const historyByIp = await this.databaseService.getServerPingHistoryBatch(
      proxyPort,
      ips,
      historyLimit
    );

    const serversWithHistory = {};
    for (const [gName, list] of Object.entries(servers)) {
      serversWithHistory[gName] = list.map((s) => ({
        ...s,
        history: historyByIp[s.ip] || [],
      }));
    }

    return {
      servers: serversWithHistory,
      groups,
      geoDbAvailable: this.geoIpService ? this.geoIpService.isDatabasePresent() : false,
    };
  }

  async pingAllServers(proxyPort = null) {
    try {
      const rows = await this.loadRows();
      const SERVER_LIST = this.rowsToGrouped(rows);
      const results = {};
      Object.keys(SERVER_LIST).forEach((group) => {
        results[group] = [];
      });

      const proxyPorts = proxyPort
        ? [Number(proxyPort)]
        : this.proxyService.config?.PROXY_PORTS || [];

      if (!proxyPorts.length || !Number.isFinite(Number(proxyPorts[0]))) {
        return {
          success: false,
          error: 'No active proxy ports available',
          timestamp: new Date().toISOString(),
        };
      }

      const testProxyPort = proxyPorts[0];
      const proxyHost = this.proxyService.config?.PROXY_HOST || 'proxy.soax.com';
      const targetPort = this.proxyService.config?.TARGET_PORT || 80;
      const timeout = REQUEST_TIMEOUT_MS;

      console.log(`🏓 Pinging servers via SOAX proxy: ${proxyHost}:${testProxyPort}`);

      const pingPromises = [];

      Object.keys(SERVER_LIST).forEach((group) => {
        SERVER_LIST[group].forEach((server) => {
          const pingPromise = this.proxyService
            .measureProxyToTargetLatency(
              server.ip,
              targetPort,
              proxyHost,
              testProxyPort,
              process.env.PROXY_USER,
              process.env.PROXY_PASS,
              timeout
            )
            .then(async (measurement) => {
              await this.persistServerPingMeasurement(
                { id: server.id, ip: server.ip, group },
                measurement,
                proxyHost,
                testProxyPort,
                targetPort
              );
              return {
                group,
                location: server.location,
                ip: server.ip,
                status: measurement.status,
                rtt: measurement.rtt_ms ? `${measurement.rtt_ms}ms` : null,
                error: measurement.error_message || null,
                timestamp: new Date().toISOString(),
              };
            })
            .catch(async (error) => {
              const fake = {
                status: 'error',
                rtt_ms: null,
                error_message: error.message,
                message: error.message,
              };
              await this.persistServerPingMeasurement(
                { id: server.id, ip: server.ip, group },
                fake,
                proxyHost,
                testProxyPort,
                targetPort
              );
              return {
                group,
                location: server.location,
                ip: server.ip,
                status: 'error',
                rtt: null,
                error: error.message,
                timestamp: new Date().toISOString(),
              };
            });

          pingPromises.push(pingPromise);
        });
      });

      const pingResults = await Promise.all(pingPromises);

      pingResults.forEach((result) => {
        if (!results[result.group]) {
          results[result.group] = [];
        }
        results[result.group].push({
          location: result.location,
          ip: result.ip,
          status: result.status,
          rtt: result.rtt,
          error: result.error,
          timestamp: result.timestamp,
        });
      });

      return {
        success: true,
        proxyPort: testProxyPort,
        proxyHost,
        results,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error('❌ Error pinging servers:', error.message);
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  async pingServerGroup(groupName, proxyPort = null) {
    try {
      const rows = await this.loadRows();
      const SERVER_LIST = this.rowsToGrouped(rows);
      if (!SERVER_LIST[groupName]) {
        throw new Error(`Group "${groupName}" not found`);
      }

      const servers = SERVER_LIST[groupName];
      const proxyPorts = proxyPort
        ? [Number(proxyPort)]
        : this.proxyService.config?.PROXY_PORTS || [];

      if (!proxyPorts.length || !Number.isFinite(Number(proxyPorts[0]))) {
        return {
          success: false,
          error: 'No active proxy ports available',
          timestamp: new Date().toISOString(),
        };
      }
      const testProxyPort = proxyPorts[0];
      const proxyHost = this.proxyService.config?.PROXY_HOST || 'proxy.soax.com';
      const targetPort = this.proxyService.config?.TARGET_PORT || 80;
      const timeout = REQUEST_TIMEOUT_MS;

      console.log(`🏓 Pinging group ${groupName} via SOAX proxy: ${proxyHost}:${testProxyPort}`);

      const pingPromises = servers.map((server) =>
        this.proxyService
          .measureProxyToTargetLatency(
            server.ip,
            targetPort,
            proxyHost,
            testProxyPort,
            process.env.PROXY_USER,
            process.env.PROXY_PASS,
            timeout
          )
          .then(async (measurement) => {
            await this.persistServerPingMeasurement(
              { id: server.id, ip: server.ip, group: groupName },
              measurement,
              proxyHost,
              testProxyPort,
              targetPort
            );
            return {
              location: server.location,
              ip: server.ip,
              status: measurement.status,
              rtt: measurement.rtt_ms ? `${measurement.rtt_ms}ms` : null,
              error: measurement.error_message || null,
              timestamp: new Date().toISOString(),
            };
          })
          .catch(async (error) => {
            const fake = {
              status: 'error',
              rtt_ms: null,
              error_message: error.message,
              message: error.message,
            };
            await this.persistServerPingMeasurement(
              { id: server.id, ip: server.ip, group: groupName },
              fake,
              proxyHost,
              testProxyPort,
              targetPort
            );
            return {
              location: server.location,
              ip: server.ip,
              status: 'error',
              rtt: null,
              error: error.message,
              timestamp: new Date().toISOString(),
            };
          })
      );

      const results = await Promise.all(pingPromises);

      return {
        success: true,
        group: groupName,
        proxyPort: testProxyPort,
        proxyHost,
        results,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      console.error(`❌ Error pinging group ${groupName}:`, error.message);
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }
}

module.exports = ServerPingService;
