const express = require('express');
const cors = require('cors');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { createUnifiedAuthMiddleware } = require('./middleware/unifiedAuth');
const { createDbConnection, initializeDatabase } = require('./config/database');
const DatabaseService = require('./services/databaseService');
const ProxyService = require('./services/proxyService');
const MeasurementController = require('./controllers/measurementController');
const SystemController = require('./controllers/systemController');
const apiRoutes = require('./routes');
const BandwidthService = require('./services/bandwidthService');
const BandwidthController = require('./controllers/bandwidthController');
const SettingsService = require('./services/settingsService');
const SettingsController = require('./controllers/settingsController');
const settingsRoutes = require('./routes/settings');
const AuthService = require('./services/authService');
const AuthController = require('./controllers/authController');
const authRoutes = require('./routes/auth');


const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({
  server,
  path: '/ws',
});

const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
  origin: '*',
  optionsSuccessStatus: 200,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// WebSocket connections storage
const clients = new Set();

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  console.log('🔌 New WebSocket connection from:', req.headers.origin);
  clients.add(ws);

  ws.send(JSON.stringify({
    type: 'connection_established',
    message: 'Connected to measurement server',
    timestamp: new Date().toISOString()
  }));

  ws.on('close', () => {
    console.log('🔌 WebSocket connection closed');
    clients.delete(ws);
  });

  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error);
    clients.delete(ws);
  });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);

      if (data.type === 'ping') {
        ws.send(JSON.stringify({
          type: 'pong',
          timestamp: new Date().toISOString()
        }));
      }
    } catch (error) {
      console.error('❌ Error parsing WebSocket message:', error);
    }
  });
});

// Broadcast to all connected clients
const broadcastToClients = (data) => {
  const message = JSON.stringify(data);
  let sentCount = 0;

  clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
      sentCount++;
    }
  });

  console.log(`📤 Broadcast to ${sentCount}/${clients.size} clients`);
};

// Enhanced IP information service initialization with MySQL memory table
async function initializeIPDatabase() {
  try {
    console.log('🔄 Initializing IP information service with MySQL memory table...');
    const startTime = Date.now();

    const IPInfoService = require('./services/ipInfoService');

    // Make sure IPInfoService has the database connection
    if (!IPInfoService.isInitialized && db) {
      IPInfoService.setDatabase(db);
    }

    if (!IPInfoService.isInitialized) {
      console.log('⚠️ IPInfoService not initialized yet, waiting for database...');
      return 0;
    }

    const loadedCount = await IPInfoService.loadIPRangesFromCSV(
      path.join(__dirname, 'data', 'asn.csv')
    );

    const loadTime = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ IP information service ready in ${loadTime}s with ${loadedCount} ranges`);

    return loadedCount;
  } catch (error) {
    console.error('❌ Failed to initialize IP information service:', error);
    return 0;
  }
}

// Global state
let db;
let databaseService;
let proxyService;
let measurementController;
let systemController;
let cleanupInterval;
let isMeasuring = false;
let measurementTimer = null;
/** Set in initializeApp — used by schedulers to require active proxy_ports (status=1). */
let portServiceForSchedulers = null;
let groupMappingServiceForSync = null;
const NORMAL_MEASUREMENT_INTERVAL_MS = 15 * 60 * 1000;
let currentMeasurementIntervalMs = NORMAL_MEASUREMENT_INTERVAL_MS;

const formatIntervalMinutes = (ms) => (ms / 60000).toFixed(1);

function stopScheduledMeasurements() {
  if (measurementTimer) {
    clearTimeout(measurementTimer);
    measurementTimer = null;
    console.log('🛑 Stopped automatic measurements');
  }
}

function scheduleNextMeasurement(delayMs) {
  const wait = typeof delayMs === 'number' && !Number.isNaN(delayMs)
    ? Math.max(delayMs, 30 * 1000)
    : currentMeasurementIntervalMs;

  if (measurementTimer) {
    clearTimeout(measurementTimer);
    measurementTimer = null;
  }

  measurementTimer = setTimeout(async () => {
    measurementTimer = null;
    await runScheduledMeasurements();
  }, wait);

  console.log(`⏰ Next automatic measurement scheduled in ${formatIntervalMinutes(wait)} minutes`);
}

// Function to refresh IP list
const refreshIpList = async () => {
  try {
    console.log('🔄 Refreshing IP list...');
    await proxyService.refreshTargets();
    const discoveredRegions = proxyService.getLastFetchedRegions();
    if (groupMappingServiceForSync && discoveredRegions.length) {
      const discoveredChanged = await groupMappingServiceForSync.syncDiscoveredRegions(discoveredRegions);
      const updatedGroupingConfig = await groupMappingServiceForSync.listConfig();
      proxyService.setGroupingConfig(updatedGroupingConfig);
      if (discoveredChanged) {
        await proxyService.refreshTargets();
      }
    }
    const currentTargets = proxyService.getTargets();

    console.log(`✅ IP list refreshed. Current targets: ${currentTargets.length}`);
    broadcastToClients({
      type: 'ip_list_updated',
      message: `IP list updated with ${currentTargets.length} targets`,
      targetCount: currentTargets.length,
      timestamp: new Date().toISOString()
    });

    return currentTargets;
  } catch (error) {
    console.error('❌ Error refreshing IP list:', error.message);
    throw error;
  }
};

// Manual measurement function
const runManualMeasurements = async () => {
  if (isMeasuring) {
    console.log('⏳ Measurement already in progress, skipping manual request...');
    broadcastToClients({
      type: 'measurement_status',
      status: 'already_running',
      message: 'Measurement already in progress',
      timestamp: new Date().toISOString()
    });
    return;
  }

  isMeasuring = true;

  try {
    console.log('🚀 Starting manual measurements...');
    broadcastToClients({
      type: 'measurement_status',
      status: 'started',
      message: 'Manual measurement started',
      timestamp: new Date().toISOString()
    });

    await refreshIpList();
    await proxyService.runMeasurements(databaseService, 'http', { refreshTargets: false });

    broadcastToClients({
      type: 'measurement_status',
      status: 'completed',
      message: 'Manual measurement completed',
      timestamp: new Date().toISOString()
    });

    broadcastToClients({
      type: 'data_updated',
      message: 'New measurement data available',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error during manual measurements:', error.message);
    broadcastToClients({
      type: 'measurement_status',
      status: 'error',
      message: 'Measurement failed',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  } finally {
    isMeasuring = false;
    scheduleNextMeasurement(currentMeasurementIntervalMs);
  }
};

// Scheduled measurement function
async function runScheduledMeasurements() {
  if (isMeasuring) {
    console.log('⏳ Measurement already in progress, skipping scheduled run...');
    scheduleNextMeasurement(currentMeasurementIntervalMs);
    return;
  }

  if (portServiceForSchedulers) {
    const activePorts = await portServiceForSchedulers.listActivePorts();
    if (!activePorts.length) {
      console.log('⏭️ Scheduled TTL measurements skipped — no active proxy ports');
      scheduleNextMeasurement();
      return;
    }
  }

  isMeasuring = true;

  try {
    console.log('🔄 Starting scheduled measurements...');
    broadcastToClients({
      type: 'measurement_status',
      status: 'scheduled_started',
      message: 'Scheduled measurement started',
      timestamp: new Date().toISOString()
    });

    await refreshIpList();
    await proxyService.runMeasurements(databaseService, 'http', { refreshTargets: false });

    broadcastToClients({
      type: 'measurement_status',
      status: 'scheduled_completed',
      message: 'Scheduled measurement completed',
      timestamp: new Date().toISOString()
    });

    broadcastToClients({
      type: 'data_updated',
      message: 'New measurement data available from scheduled run',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Error during scheduled measurements:', error.message);
    broadcastToClients({
      type: 'measurement_status',
      status: 'error',
      message: 'Scheduled measurement failed',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  } finally {
    isMeasuring = false;
    scheduleNextMeasurement();
  }
}


// Manual IP list refresh endpoint
app.post('/api/measurements/refresh-ips', async (req, res) => {
  try {
    console.log('🔄 Manual IP list refresh requested');
    const targets = await refreshIpList();

    res.json({
      success: true,
      message: `IP list refreshed with ${targets.length} targets`,
      targetCount: targets.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Error refreshing IP list:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to refresh IP list'
    });
  }
});

// WebSocket info endpoint
app.get('/api/websocket/info', (req, res) => {
  res.json({
    connectedClients: clients.size,
    isWebSocketServer: true,
    serverTime: new Date().toISOString()
  });
});

// IP Information endpoints - Updated to use MySQL
app.get('/api/ip-info/:ip', async (req, res) => {
  try {
    const { ip } = req.params;
    const IPInfoService = require('./services/ipInfoService');

    // Check if initialized
    if (!IPInfoService.isInitialized) {
      return res.status(503).json({
        success: false,
        error: 'IP information service not initialized'
      });
    }

    const info = await IPInfoService.getIPInfo(ip);

    res.json({
      success: true,
      ipInfo: info
    });
  } catch (error) {
    console.error('❌ Error in IP info route:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get IP information'
    });
  }
});

// Get IP information for multiple IPs
app.post('/api/ip-info/batch', async (req, res) => {
  try {
    const { ipList } = req.body;

    if (!ipList || !Array.isArray(ipList)) {
      return res.status(400).json({
        success: false,
        error: 'IP list is required'
      });
    }

    const IPInfoService = require('./services/ipInfoService');

    // Check if initialized
    if (!IPInfoService.isInitialized) {
      return res.status(503).json({
        success: false,
        error: 'IP information service not initialized'
      });
    }

    const ipInfo = await IPInfoService.getIPInfoBatch(ipList);
    const geoIpService = require('./services/geoIpService');
    const countryByIp = new Map();
    if (geoIpService && typeof geoIpService.lookupCountry === 'function') {
      const lookups = await Promise.all(
        ipList.map(async (ip) => {
          const result = await geoIpService.lookupCountry(ip);
          return [ip, result?.name || 'Unknown'];
        })
      );
      lookups.forEach(([ip, country]) => countryByIp.set(ip, country));
    }
    const merged = (Array.isArray(ipInfo) ? ipInfo : []).map((info) => {
      const ip = info?.ip;
      const mmdbCountry = ip ? countryByIp.get(ip) : null;
      return {
        ...info,
        country: mmdbCountry && mmdbCountry !== 'Unknown'
          ? mmdbCountry
          : (info?.country || 'Unknown'),
      };
    });

    res.json({
      success: true,
      ipInfo: merged
    });
  } catch (error) {
    console.error('❌ Error in batch IP info route:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get batch IP information'
    });
  }
});

const initializeApp = async () => {
  try {
    // Initialize database
    db = createDbConnection();
    await initializeDatabase(db);

    // Initialize IPInfoService FIRST
    const IPInfoService = require('./services/ipInfoService');
    IPInfoService.setDatabase(db);
    console.log('✅ IPInfoService initialized with database connection');

    // Initialize services
    databaseService = new DatabaseService(db);
    proxyService = new ProxyService();
    const authService = new AuthService(db);
    app.use(createUnifiedAuthMiddleware(authService));
    const authController = new AuthController(authService);
    app.use('/api/auth', authRoutes(authController));
    const settingsService = new SettingsService(db);

    const bandwidthService = new BandwidthService(proxyService, databaseService);
    const bandwidthController = new BandwidthController(bandwidthService);
    const ServerPingService = require('./services/serverPingService');
    const ServerPingController = require('./controllers/serverPingController');
    const geoIpService = require('./services/geoIpService');
    const serverPingService = new ServerPingService(
      proxyService,
      db,
      databaseService,
      geoIpService,
      authService
    );
    if (!geoIpService.isDatabasePresent()) {
      console.log(
        'ℹ️  GeoLite2-Country.mmdb not found — country labels default to Unknown. Place the file at repo root or backend/data/, set MMDB_COUNTRY_PATH, or run backend/scripts/download-maxmind-country.sh with MAXMIND_LICENSE_KEY.'
      );
    }
    if (!geoIpService.isAsnDatabasePresent()) {
      console.log(
        'ℹ️  GeoLite2-ASN.mmdb not found — viewer ISP/network names will be empty. Run backend/scripts/download-maxmind-asn.sh with MAXMIND_LICENSE_KEY, or place GeoLite2-ASN.mmdb at repo root or backend/data/, or set MMDB_ASN_PATH.'
      );
    }
    const serverPingController = new ServerPingController(serverPingService, authService);
    const ServerMtrService = require('./services/serverMtrService');
    const ServerMtrController = require('./controllers/serverMtrController');
    const serverMtrService = new ServerMtrService(
      serverPingService,
      db,
      databaseService,
      authService
    );
    const serverMtrController = new ServerMtrController(serverMtrService, authService);
    const BusinessServerService = require('./services/businessServerService');
    const BusinessServerController = require('./controllers/businessServerController');
    const businessServerRoutes = require('./routes/businessServers');
    const businessServerService = new BusinessServerService(db);
    const businessServerController = new BusinessServerController(businessServerService);
    // Initialize Cache Service and start scheduler
    const CacheService = require('./services/cacheService');
    const cacheService = new CacheService(databaseService);


    const startBandwidthCollection = () => {
      const BANDWIDTH_INTERVAL = 60 * 1000; // 1 minute
      console.log(`📊 Starting bandwidth collection every ${BANDWIDTH_INTERVAL / 1000} seconds`);

      // Run immediately on startup
      bandwidthService.collectBandwidthData();

      // Schedule recurring collection
      const bandwidthInterval = setInterval(() => {
        bandwidthService.collectBandwidthData();
      }, BANDWIDTH_INTERVAL);

      return bandwidthInterval;
    };

    let bandwidthInterval;
    // Add in initializeApp function after server.listen:
    bandwidthInterval = startBandwidthCollection();

    // Start cleanup scheduler for old data
    const startCleanupScheduler = () => {
      const CLEANUP_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
      const DATA_RETENTION_DAYS = 7;

      console.log(`🧹 Starting cleanup scheduler (runs every ${CLEANUP_INTERVAL / (60 * 60 * 1000)} hours)`);
      console.log(`   - all time-series tables: ${DATA_RETENTION_DAYS} days retention`);

      // Helper function to run cleanup tasks
      const runCleanups = async () => {
        const cleanup = await databaseService.cleanupAllDataOlderThan(DATA_RETENTION_DAYS);
        if (cleanup.totalDeleted > 0) {
          console.log(`✅ Cleanup summary: deleted ${cleanup.totalDeleted} rows older than ${DATA_RETENTION_DAYS} days`);
        }
        cleanup.results.forEach((r) => {
          if (r.deletedCount > 0) {
            console.log(`   - ${r.table}: ${r.deletedCount} rows`);
          }
          if (!r.success) {
            console.warn(`⚠️ Cleanup issue in ${r.table}: ${r.error || 'unknown error'}`);
          }
        });
        if (!cleanup.success) {
          throw new Error('One or more cleanup tasks failed');
        }
      };

      // Run cleanup immediately on startup
      runCleanups().catch(error => {
        console.error('❌ Initial cleanup failed:', error.message);
      });

      // Schedule recurring cleanup
      const cleanupInterval = setInterval(() => {
        runCleanups().catch(error => {
          console.error('❌ Scheduled cleanup failed:', error.message);
        });
      }, CLEANUP_INTERVAL);

      return cleanupInterval;
    };

    cleanupInterval = startCleanupScheduler();

    // Initialize MEMORY cache
    await databaseService.initializeMemoryCache();

    // Initialize controllers
    measurementController = new MeasurementController(databaseService, proxyService);
    systemController = new SystemController(databaseService);

    // Initialize history controller
    const HistoryController = require('./controllers/historyController');
    const historyController = new HistoryController(databaseService, proxyService);

    const ErrorLogService = require('./services/errorLogService');
    const ErrorLogController = require('./controllers/errorLogController');
    const GroupMappingService = require('./services/groupMappingService');
    const GroupMappingController = require('./controllers/groupMappingController');
    const errorLogService = new ErrorLogService(proxyService);
    const errorLogController = new ErrorLogController(errorLogService);

    const PortService = require('./services/portService');
    const PortController = require('./controllers/portController');
    const portService = new PortService(databaseService);
    const groupMappingService = new GroupMappingService(db);
    groupMappingServiceForSync = groupMappingService;
    const ports = await portService.listActivePorts();
    proxyService.setPortMetadata(ports);
    const initialGroupingConfig = await groupMappingService.listConfig();
    proxyService.setGroupingConfig(initialGroupingConfig);

    const refreshPortMetadata = async () => {
      const latestPorts = await portService.listActivePorts();
      proxyService.setPortMetadata(latestPorts);
      return latestPorts;
    };

    const portController = new PortController(portService, refreshPortMetadata);
    portServiceForSchedulers = portService;
    const settingsController = new SettingsController(settingsService);
    const groupMappingController = new GroupMappingController(groupMappingService, proxyService, portService);

    // Update routes setup:
    app.use('/api/settings', settingsRoutes(settingsController));
    app.use('/api/business-servers', businessServerRoutes(businessServerController));
    app.use('/api', apiRoutes(
      measurementController,
      systemController,
      historyController,
      bandwidthController,
      errorLogController,
      portController,
      serverPingController,
      serverMtrController,
      groupMappingController
    ));

    // Get companies from historical IPs in measurements table
    app.get('/api/companies/historical', async (req, res) => {
      try {
        const { proxyPort = '10220', period = '24h' } = req.query;
        const proxyPortNum = parseInt(proxyPort, 10);

        // Calculate time range based on period
        const endTime = new Date();
        let startTime = new Date();

        switch (period) {
          case '6h': startTime.setTime(endTime.getTime() - (6 * 60 * 60 * 1000)); break;
          case '24h': startTime.setTime(endTime.getTime() - (24 * 60 * 60 * 1000)); break;
          case '7d': startTime.setTime(endTime.getTime() - (7 * 24 * 60 * 60 * 1000)); break;
          case '30d': startTime.setTime(endTime.getTime() - (30 * 24 * 60 * 60 * 1000)); break;
          default: startTime.setTime(endTime.getTime() - (24 * 60 * 60 * 1000));
        }

        // Get distinct IPs from measurements in this period
        const query = `
          SELECT DISTINCT target_host 
          FROM measurements 
          WHERE proxy_port = ? 
          AND created_at BETWEEN ? AND ?
          AND COALESCE(measurement_type, 'http') <> 'server_ping'
          ORDER BY target_host
          LIMIT 1000
      `;

        const [ipRows] = await db.execute(query, [proxyPortNum, startTime, endTime]);
        const ipList = ipRows.map(row => row.target_host);

        if (ipList.length === 0) {
          return res.json({ success: true, companies: [] });
        }

        // Get company info using binary search
        const IPInfoService = require('./services/ipInfoService');

        // Check if initialized
        if (!IPInfoService.isInitialized) {
          return res.status(503).json({
            success: false,
            error: 'IP information service not initialized'
          });
        }

        const companiesData = await IPInfoService.getCompaniesForIPs(ipList);

        // Extract unique company names
        const uniqueCompanies = [...new Set(
          Object.values(companiesData)
            .filter(info => info.found && info.company && info.company !== 'Unknown')
            .map(info => info.company)
        )].sort();

        console.log(`🏢 Found ${uniqueCompanies.length} companies from ${ipList.length} historical IPs`);

        res.json({
          success: true,
          companies: uniqueCompanies,
          totalIPs: ipList.length
        });

      } catch (error) {
        console.error('❌ Error in companies/historical:', error);
        res.status(500).json({
          success: false,
          error: 'Failed to fetch historical companies'
        });
      }
    });

    // Manual measurement endpoint
    app.post('/api/measurements/send-packet', async (req, res) => {
      try {
        console.log('📦 Manual packet send requested');
        broadcastToClients({
          type: 'measurement_status',
          status: 'manual_requested',
          message: 'Manual packet send requested',
          timestamp: new Date().toISOString()
        });

        runManualMeasurements();

        res.json({
          success: true,
          message: 'Packet send initiated',
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        console.error('❌ Error initiating manual measurement:', error.message);
        res.status(500).json({
          success: false,
          error: 'Failed to initiate measurement'
        });
      }
    });

    // React SPA: deep links like /admin/server-ping need index.html (same origin as /api when proxied to this server).
    const frontendBuildPath = path.resolve(
      process.env.FRONTEND_BUILD_PATH || path.join(__dirname, '../frontend/build')
    );
    const spaIndexHtml = path.join(frontendBuildPath, 'index.html');
    if (fs.existsSync(spaIndexHtml)) {
      app.use(express.static(frontendBuildPath));
      app.use((req, res, next) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return next();
        }
        if (req.path.startsWith('/api') || req.path.startsWith('/ws')) {
          return next();
        }
        return res.sendFile(spaIndexHtml);
      });
      console.log(`📂 Serving React SPA from ${frontendBuildPath} (client-side routes)`);
    } else {
      console.log(
        `ℹ️  No React build at ${frontendBuildPath} — run cd frontend && npm run build, or set FRONTEND_BUILD_PATH`
      );
    }

    // Initialize IP database and start server
    initializeIPDatabase().then((loadedCount) => {
      // Start cache scheduler AFTER IP ranges are loaded
      cacheService.startScheduler();

      const bindHost = process.env.BIND_HOST || '0.0.0.0';
      server.listen(PORT, bindHost, () => {
        console.log(`🚀 HTTP API listening on http://${bindHost}:${PORT} (use your server IP or DNS in the browser)`);
        console.log(`🔌 WebSocket path /ws on port ${PORT}`);
        console.log(`⏰ Automatic TTL measurements: every ${formatIntervalMinutes(NORMAL_MEASUREMENT_INTERVAL_MS)} min when active proxy ports exist`);
        console.log(`📦 Manual packet endpoint: POST /api/measurements/send-packet`);
        console.log(`🔄 IP refresh endpoint: POST /api/measurements/refresh-ips`);
        console.log(`🌐 IP info endpoints: GET /api/ip-info/:ip, POST /api/ip-info/batch`);
        console.log(`📊 IP ranges loaded: ${loadedCount} entries`);
        console.log(`💾 Cache scheduler: STARTED`);
        console.log(`🧹 Cleanup scheduler: STARTED (all time-series tables: 7 days)`);

        scheduleNextMeasurement(60 * 1000);
      });
    });

  } catch (error) {
    console.error('❌ Failed to initialize application:', error.message);
    process.exit(1);
  }
};

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down gracefully...');
  stopScheduledMeasurements();

  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    console.log('🧹 Cleanup scheduler stopped');
  }

  clients.forEach(client => {
    client.close();
  });

  if (db) {
    db.end();
  }
  process.exit(0);
});

// Start the application
initializeApp();