const express = require('express');
const router = express.Router();

module.exports = (serverPingController) => {
  router.get('/visitor', (req, res) => serverPingController.getVisitorGeo(req, res));
  router.get('/regions', (req, res) => serverPingController.listPingRegions(req, res));
  router.get('/list', (req, res) => serverPingController.getServerList(req, res));
  router.post('/servers', (req, res) => serverPingController.addServer(req, res));
  router.patch('/servers/:id', (req, res) => serverPingController.patchServer(req, res));
  router.delete('/servers/:id', (req, res) => serverPingController.deleteServer(req, res));
  router.post('/ping/client-results', (req, res) => serverPingController.postClientPingResults(req, res));
  router.post('/ping/sequence/start', (req, res) => serverPingController.startPingSequence(req, res));
  router.get('/ping/job/:jobId', (req, res) => serverPingController.getPingJob(req, res));

  return router;
};

