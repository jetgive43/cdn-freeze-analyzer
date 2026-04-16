class GroupMappingService {
  constructor(db) {
    this.db = db;
  }

  async listConfig() {
    const [groups] = await this.db.execute(
      `SELECT group_key AS groupKey, label
       FROM proxy_groups
       ORDER BY group_key`
    );
    const [regionMappings] = await this.db.execute(
      `SELECT region_name AS regionName, group_key AS groupKey
       FROM proxy_group_regions
       ORDER BY region_name`
    );
    const [portLinks] = await this.db.execute(
      `SELECT l.port_number AS portNumber, l.group_key AS groupKey
       FROM proxy_port_group_links l
       INNER JOIN proxy_ports p ON p.port_number = l.port_number
       WHERE p.status = 1
       ORDER BY l.port_number, l.group_key`
    );
    return { groups, regionMappings, portLinks };
  }

  async createGroup({ groupKey, label }) {
    const normalizedKey = String(groupKey || '').trim().toUpperCase();
    const normalizedLabel = String(label || '').trim();
    if (!normalizedKey || !normalizedLabel) {
      throw new Error('groupKey and label are required');
    }
    if (!/^[A-Z0-9_]+$/.test(normalizedKey)) {
      throw new Error('groupKey must use A-Z, 0-9, or _');
    }
    await this.db.execute(
      `INSERT INTO proxy_groups (group_key, label)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE label = VALUES(label)`,
      [normalizedKey, normalizedLabel]
    );
    return this.listConfig();
  }

  async syncDiscoveredRegions(regions = []) {
    const normalized = [...new Set(
      (Array.isArray(regions) ? regions : [])
        .map((r) => String(r || '').trim())
        .filter(Boolean)
    )];
    if (!normalized.length) return false;

    let changed = false;
    const conn = await this.db.getConnection();
    try {
      await conn.beginTransaction();
      for (const regionName of normalized) {
        const [result] = await conn.execute(
          `INSERT INTO proxy_group_regions (region_name, group_key)
           VALUES (?, 'OTHERS')
           ON DUPLICATE KEY UPDATE group_key = group_key`,
          [regionName]
        );
        if (Number(result?.affectedRows || 0) > 0) changed = true;
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
    return changed;
  }

  async replaceRegionMappings(mappings = []) {
    const conn = await this.db.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute('DELETE FROM proxy_group_regions');
      for (const m of mappings) {
        const regionName = String(m.regionName || '').trim();
        const groupKey = String(m.groupKey || '').trim().toUpperCase();
        if (!regionName || !groupKey) continue;
        await conn.execute(
          `INSERT INTO proxy_group_regions (region_name, group_key)
           VALUES (?, ?)`,
          [regionName, groupKey]
        );
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
    return this.listConfig();
  }

  async replacePortLinks(links = []) {
    const conn = await this.db.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute('DELETE FROM proxy_port_group_links');
      for (const l of links) {
        const portNumber = Number(l.portNumber);
        const groupKey = String(l.groupKey || '').trim().toUpperCase();
        if (!Number.isFinite(portNumber) || !groupKey) continue;
        await conn.execute(
          `INSERT INTO proxy_port_group_links (port_number, group_key)
           VALUES (?, ?)`,
          [portNumber, groupKey]
        );
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
    return this.listConfig();
  }
}

module.exports = GroupMappingService;
