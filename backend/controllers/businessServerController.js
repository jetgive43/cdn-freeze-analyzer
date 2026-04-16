'use strict';

class BusinessServerController {
  constructor(service) {
    this.service = service;
  }

  isAdmin(req) {
    const u = req.authUser;
    return !!(u && (u.legacyBasic || u.role === 'admin'));
  }

  async list(req, res) {
    if (!this.isAdmin(req)) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    try {
      const servers = await this.service.list();
      return res.json({ success: true, servers });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  async metricsHistory(req, res) {
    if (!this.isAdmin(req)) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    try {
      const points = await this.service.metricsHistory(req.params.id);
      return res.json({ success: true, points });
    } catch (e) {
      const code = e.statusCode || 500;
      return res.status(code).json({ success: false, error: e.message });
    }
  }

  async create(req, res) {
    if (!this.isAdmin(req)) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    try {
      const out = await this.service.create(req.body || {});
      return res.status(201).json({ success: true, ...out });
    } catch (e) {
      const code = e.statusCode || 500;
      return res.status(code).json({ success: false, error: e.message });
    }
  }

  async patch(req, res) {
    if (!this.isAdmin(req)) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    try {
      const body = req.body || {};
      const keys = [
        'displayName',
        'groupName',
        'sshHost',
        'sshPort',
        'sshUser',
        'bandwidthCapacityMbps',
        'cpuCores',
        'ramTotalGb',
      ];
      const hasAny = keys.some((k) => Object.prototype.hasOwnProperty.call(body, k));
      if (!hasAny) {
        return res.status(400).json({
          success: false,
          error:
            'Provide at least one of: displayName, groupName, sshHost, sshPort, sshUser, bandwidthCapacityMbps, cpuCores, ramTotalGb',
        });
      }
      const out = await this.service.updateFields(req.params.id, body);
      return res.json({ success: true, ...out });
    } catch (e) {
      const code = e.statusCode || 500;
      return res.status(code).json({ success: false, error: e.message });
    }
  }

  async reinstall(req, res) {
    if (!this.isAdmin(req)) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    try {
      const pwd = req.body && req.body.sshPassword != null ? String(req.body.sshPassword) : '';
      const out = await this.service.reinstallAgent(req.params.id, pwd || undefined);
      return res.json({ success: true, ...out });
    } catch (e) {
      const code = e.statusCode || 500;
      return res.status(code).json({ success: false, error: e.message });
    }
  }

  async remove(req, res) {
    if (!this.isAdmin(req)) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }
    try {
      const ok = await this.service.remove(req.params.id);
      if (!ok) {
        return res.status(404).json({ success: false, error: 'Not found' });
      }
      return res.json({ success: true });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  async ingest(req, res) {
    try {
      await this.service.ingest(req.body || {});
      return res.json({ success: true });
    } catch (e) {
      const code = e.statusCode || 500;
      return res.status(code).json({ success: false, error: e.message });
    }
  }
}

module.exports = BusinessServerController;
