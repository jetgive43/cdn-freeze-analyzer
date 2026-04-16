const express = require('express');
const router = express.Router();

const measurementRoutes = require('./measurements');
const systemRoutes = require('./system');
const historyRoutes = require('./history');
const bandwidthRoutes = require('./bandwidth');
const errorLogRoutes = require('./errorLog');
const portRoutes = require('./ports');
const serverPingRoutes = require('./serverPing');
const serverMtrRoutes = require('./serverMtr');
const groupMappingsRoutes = require('./groupMappings');

module.exports = (measurementController, systemController, historyController, bandwidthController, errorLogController, portController, serverPingController, serverMtrController, groupMappingController) => {
  router.use('/measurements', measurementRoutes(measurementController));
  router.use('/system', systemRoutes(systemController));
  router.use('/history', historyRoutes(historyController));
  router.use('/bandwidth', bandwidthRoutes(bandwidthController));
  router.use('/errors', errorLogRoutes(errorLogController));
  router.use('/ports', portRoutes(portController));
  router.use('/server-ping', serverPingRoutes(serverPingController));
  router.use('/server-mtr', serverMtrRoutes(serverMtrController));
  router.use('/group-mappings', groupMappingsRoutes(groupMappingController));
  return router;
};