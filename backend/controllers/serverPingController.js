class ServerPingController {
  constructor(serverPingService) {
    this.serverPingService = serverPingService;
  }

  async getServerList(req, res) {
    try {
      const defaultPort = this.serverPingService.proxyService?.config?.PROXY_PORTS?.[0];
      const proxyPort = req.query.proxyPort || (defaultPort != null ? String(defaultPort) : '');
      if (!proxyPort) {
        return res.json({
          success: true,
          servers: {},
          groups: [],
          geoDbAvailable: this.serverPingService.geoIpService
            ? this.serverPingService.geoIpService.isDatabasePresent()
            : false,
          proxyPort: null,
          historyLimit: Math.min(
            Math.max(1, parseInt(req.query.historyLimit || '12', 10) || 12),
            50
          ),
        });
      }
      const historyLimit = Math.min(
        Math.max(1, parseInt(req.query.historyLimit || '12', 10) || 12),
        50
      );
      const payload = await this.serverPingService.getFullListWithHistory(
        proxyPort,
        historyLimit
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
      console.error('❌ Error getting server list:', error.message);
      res.status(500).json({
        success: false,
        error: 'Failed to get server list',
      });
    }
  }

  async addServer(req, res) {
    try {
      const { groupName, newGroupName, location, ip } = req.body || {};
      const created = await this.serverPingService.addServer({
        groupName,
        newGroupName,
        location,
        ip,
      });
      res.status(201).json({ success: true, server: created });
    } catch (error) {
      const msg = error.message || 'Failed to add server';
      const status = msg.includes('required') || msg.includes('Invalid') ? 400 : 500;
      if (error.code === 'ER_DUP_ENTRY' || error.errno === 1062) {
        return res.status(409).json({ success: false, error: 'That group and IP already exists' });
      }
      console.error('❌ Error adding server ping target:', error.message);
      res.status(status).json({ success: false, error: msg });
    }
  }

  async deleteServer(req, res) {
    try {
      const { id } = req.params;
      const removed = await this.serverPingService.deleteServer(id);
      if (!removed) {
        return res.status(404).json({ success: false, error: 'Server not found' });
      }
      res.json({ success: true });
    } catch (error) {
      const msg = error.message || 'Failed to delete server';
      const status = msg.includes('Invalid') ? 400 : 500;
      console.error('❌ Error deleting server ping target:', error.message);
      res.status(status).json({ success: false, error: msg });
    }
  }

  async pingAllServers(req, res) {
    try {
      const { proxyPort } = req.query;
      const result = await this.serverPingService.pingAllServers(proxyPort);
      
      if (result.success) {
        res.json(result);
      } else {
        res.status(500).json(result);
      }
    } catch (error) {
      console.error('❌ Error pinging all servers:', error.message);
      res.status(500).json({
        success: false,
        error: 'Failed to ping servers',
        message: error.message
      });
    }
  }

  async pingServerGroup(req, res) {
    try {
      const { group } = req.params;
      const { proxyPort } = req.query;
      const result = await this.serverPingService.pingServerGroup(group, proxyPort);
      
      if (result.success) {
        res.json(result);
      } else {
        res.status(404).json(result);
      }
    } catch (error) {
      console.error(`❌ Error pinging server group ${req.params.group}:`, error.message);
      res.status(500).json({
        success: false,
        error: 'Failed to ping server group',
        message: error.message
      });
    }
  }
}

module.exports = ServerPingController;

