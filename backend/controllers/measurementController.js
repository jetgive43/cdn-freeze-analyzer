class MeasurementController {
  constructor(databaseService, proxyService) {
    this.databaseService = databaseService;
    this.proxyService = proxyService;
  }

  async getLatestMeasurements(req, res) {
    try {
      const { proxyPort, limit = '100' } = req.query;
      const defaultProxyPort = this.proxyService?.config?.PROXY_PORTS?.[0];
      const effectiveProxyPort = proxyPort ?? defaultProxyPort;
      const proxyPortNum = parseInt(effectiveProxyPort, 10);
      const limitNum = Math.min(parseInt(limit, 10), 500);
      
      if (isNaN(proxyPortNum) || isNaN(limitNum)) {
        return res.status(400).json({ 
          success: false, 
          error: 'Invalid parameters' 
        });
      }

      console.log(`📊 Fetching latest measurements for proxy port ${proxyPortNum}, limit ${limitNum}`);
      
      const measurements = await this.databaseService.getLatestMeasurements(proxyPortNum, limitNum);
      
      const uniqueResults = measurements
        .map(measurement => measurement.toFrontendFormat())
        .sort((a, b) => a.target.localeCompare(b.target));
      
      res.json({
        success: true,
        count: uniqueResults.length,
        proxyPort: proxyPortNum,
        results: uniqueResults
      });
      
    } catch (error) {
      console.error('❌ Error in getLatestMeasurements:', error.message);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to fetch measurements',
        details: error.message
      });
    }
  }

  async getTimeline(req, res) {
    try {
      const { 
        proxyPort, 
        limitPerTarget = '30',
        page,
        pageSize = '20',
        optimized = 'true',
        safe = 'false' // Add safe mode parameter
      } = req.query;

      const defaultProxyPort = this.proxyService?.config?.PROXY_PORTS?.[0];
      const effectiveProxyPort = proxyPort ?? defaultProxyPort;
      const proxyPortNum = parseInt(effectiveProxyPort, 10);
      const limitNum = Math.min(parseInt(limitPerTarget, 10), 100);
      
      if (isNaN(proxyPortNum) || isNaN(limitNum)) {
        return res.status(400).json({ 
          success: false, 
          error: 'Invalid parameters' 
        });
      }

      let result;
      
      try {
        if (safe === 'true') {
          // Use safe method with template literals
          result = await this.databaseService.getMeasurementsTimelineSafe(proxyPortNum, limitNum, this.proxyService);
        } else if (page) {
          // Use paginated endpoint
          const pageNum = parseInt(page, 10);
          const pageSizeNum = Math.min(parseInt(pageSize, 10), 50);
          result = await this.databaseService.getMeasurementsTimelinePaginated(
            proxyPortNum, pageNum, pageSizeNum, limitNum, this.proxyService
          );
        } else if (optimized === 'true') {
          // Use optimized single query
          result = await this.databaseService.getMeasurementsTimelineOptimized(proxyPortNum, limitNum, this.proxyService);
        } else {
          // Use original method
          result = await this.databaseService.getMeasurementsTimeline(proxyPortNum, limitNum, this.proxyService);
        }
        // console.log({result})
        const enriched = result.map((row) => {
          const targetRaw = row.target || `${row.target_host || ''}:${row.target_port || ''}`;
          const ip = String(targetRaw).split(':')[0];
          const groupKey = this.proxyService.getGroupForIp(ip);
          const groupLabel = this.proxyService.getGroupLabel(groupKey);
          const region = this.proxyService.getRegionForIp(ip) || null;
          return {
            ...row,
            groupKey,
            groupLabel,
            region,
          };
        }).sort((a, b) => {
          const ga = (a.groupLabel || '').toLowerCase();
          const gb = (b.groupLabel || '').toLowerCase();
          if (ga !== gb) return ga.localeCompare(gb);
          const ta = (a.target || '').toLowerCase();
          const tb = (b.target || '').toLowerCase();
          return ta.localeCompare(tb);
        });
        res.json({
          success: true,
          count: enriched.length,
          proxyPort: proxyPortNum,
          data: enriched
        });
        
      } catch (dbError) {
        // If parameterized queries fail, fall back to safe method
        console.log('🔄 Parameterized query failed, falling back to safe method');
        result = await this.databaseService.getMeasurementsTimelineSafe(proxyPortNum, limitNum, this.proxyService);
        
        const enriched = result.map((row) => {
          const targetRaw = row.target || `${row.target_host || ''}:${row.target_port || ''}`;
          const ip = String(targetRaw).split(':')[0];
          const groupKey = this.proxyService.getGroupForIp(ip);
          const groupLabel = this.proxyService.getGroupLabel(groupKey);
          const region = this.proxyService.getRegionForIp(ip) || null;
          return {
            ...row,
            groupKey,
            groupLabel,
            region,
          };
        }).sort((a, b) => {
          const ga = (a.groupLabel || '').toLowerCase();
          const gb = (b.groupLabel || '').toLowerCase();
          if (ga !== gb) return ga.localeCompare(gb);
          return (a.target || '').localeCompare(b.target || '');
        });
        res.json({
          success: true,
          count: enriched.length,
          proxyPort: proxyPortNum,
          data: enriched,
          note: 'Used safe query method'
        });
      }
      
    } catch (error) {
      console.error('❌ Error in getTimeline:', error.message);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to fetch timeline',
        details: error.message
      });
    }
  }

  async getTimelineHealth(req, res) {
    try {
      const { proxyPort } = req.query;
      const defaultProxyPort = this.proxyService?.config?.PROXY_PORTS?.[0];
      const effectiveProxyPort = proxyPort ?? defaultProxyPort;
      const proxyPortNum = parseInt(effectiveProxyPort, 10);
      
      const healthData = await this.databaseService.getTimelineHealth(proxyPortNum);
      
      res.json({
        success: true,
        targetCount: healthData.targetCount,
        latestMeasurement: healthData.latestMeasurement,
        proxyPort: proxyPortNum
      });
      
    } catch (error) {
      console.error('❌ Error in timeline health check:', error.message);
      res.status(500).json({ 
        success: false, 
        error: 'Health check failed'
      });
    }
  }
  async getLiveServers(req, res) {
    try {
        // Get live IPs from ProxyService
        const ipList = await this.proxyService.getIPList();
        
        res.json({
            success: true,
            servers: ipList.map(ip => ({ 
                ip: ip,
                alive: true 
            })),
            total: ipList.length,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error('❌ Error getting live servers:', error.message);
        res.status(500).json({
            success: false,
            error: 'Failed to get live servers'
        });
    }
}
}

module.exports = MeasurementController;