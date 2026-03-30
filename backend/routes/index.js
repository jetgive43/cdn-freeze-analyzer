const express = require('express');
const router = express.Router();

const measurementRoutes = require('./measurements');
const systemRoutes = require('./system');
const historyRoutes = require('./history');
const bandwidthRoutes = require('./bandwidth');
const errorLogRoutes = require('./errorLog');
const portRoutes = require('./ports');
const metricsRoutes = require('./metrics');
const serverPingRoutes = require('./serverPing');
const groupMappingsRoutes = require('./groupMappings');

module.exports = (measurementController, systemController, historyController, bandwidthController, errorLogController, metricsController, portController, serverPingController, groupMappingController) => {
  router.use('/measurements', measurementRoutes(measurementController));
  router.use('/system', systemRoutes(systemController));
  router.use('/history', historyRoutes(historyController));
  router.use('/bandwidth', bandwidthRoutes(bandwidthController));
  router.use('/errors', errorLogRoutes(errorLogController));
  router.use('/metrics', metricsRoutes(metricsController));
  router.use('/ports', portRoutes(portController));
  router.use('/server-ping', serverPingRoutes(serverPingController));
  router.use('/group-mappings', groupMappingsRoutes(groupMappingController));
  return router;
};