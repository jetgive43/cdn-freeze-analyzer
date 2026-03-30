class GroupMappingController {
  constructor(groupMappingService, proxyService, portService = null) {
    this.groupMappingService = groupMappingService;
    this.proxyService = proxyService;
    this.portService = portService;
  }

  getConfig = async (req, res) => {
    try {
      const regions = await this.proxyService.fetchCategoryFourNodes().then((nodes) =>
        [...new Set(nodes.map((n) => String(n.region || '').trim()).filter(Boolean))].sort()
      ).catch(() => []);
      const discoveredChanged = await this.groupMappingService.syncDiscoveredRegions(regions);
      const cfg = await this.groupMappingService.listConfig();
      this.proxyService.setGroupingConfig(cfg);
      if (discoveredChanged) {
        await this.proxyService.refreshTargets().catch(() => {});
      }
      const activePorts = this.portService ? await this.portService.listActivePorts() : [];
      res.json({
        success: true,
        ...cfg,
        availableRegions: cfg.regionMappings.map((m) => m.regionName),
        activePorts,
      });
    } catch (error) {
      console.error('❌ Error loading group mappings:', error.message);
      res.status(500).json({ success: false, error: 'Failed to load group mappings' });
    }
  };

  updateRegionMappings = async (req, res) => {
    try {
      const mappings = Array.isArray(req.body?.mappings) ? req.body.mappings : [];
      const cfg = await this.groupMappingService.replaceRegionMappings(mappings);
      this.proxyService.setGroupingConfig(cfg);
      await this.proxyService.refreshTargets().catch(() => {});
      res.json({ success: true, ...cfg });
    } catch (error) {
      console.error('❌ Error updating region mappings:', error.message);
      res.status(500).json({ success: false, error: 'Failed to update region mappings' });
    }
  };

  updatePortLinks = async (req, res) => {
    try {
      const links = Array.isArray(req.body?.links) ? req.body.links : [];
      const cfg = await this.groupMappingService.replacePortLinks(links);
      this.proxyService.setGroupingConfig(cfg);
      await this.proxyService.refreshTargets().catch(() => {});
      res.json({ success: true, ...cfg });
    } catch (error) {
      console.error('❌ Error updating port links:', error.message);
      res.status(500).json({ success: false, error: 'Failed to update port links' });
    }
  };

  createGroup = async (req, res) => {
    try {
      const groupKey = req.body?.groupKey;
      const label = req.body?.label;
      const cfg = await this.groupMappingService.createGroup({ groupKey, label });
      this.proxyService.setGroupingConfig(cfg);
      await this.proxyService.refreshTargets().catch(() => {});
      res.json({ success: true, ...cfg });
    } catch (error) {
      console.error('❌ Error creating group:', error.message);
      res.status(400).json({ success: false, error: error.message || 'Failed to create group' });
    }
  };
}

module.exports = GroupMappingController;
