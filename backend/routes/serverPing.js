const express = require('express');
const router = express.Router();

module.exports = (serverPingController) => {
  router.get('/list', (req, res) => serverPingController.getServerList(req, res));
  router.post('/servers', (req, res) => serverPingController.addServer(req, res));
  router.delete('/servers/:id', (req, res) => serverPingController.deleteServer(req, res));
  router.get('/ping/all', (req, res) => serverPingController.pingAllServers(req, res));
  router.get('/ping/group/:group', (req, res) => serverPingController.pingServerGroup(req, res));

  return router;
};

