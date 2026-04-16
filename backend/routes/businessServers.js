'use strict';

const express = require('express');

module.exports = (controller) => {
  const router = express.Router();
  router.post('/ingest', (req, res) => controller.ingest(req, res));
  router.get('/', (req, res) => controller.list(req, res));
  router.get('/:id/metrics', (req, res) => controller.metricsHistory(req, res));
  router.post('/', (req, res) => controller.create(req, res));
  router.patch('/:id', (req, res) => controller.patch(req, res));
  router.post('/:id/reinstall', (req, res) => controller.reinstall(req, res));
  router.delete('/:id', (req, res) => controller.remove(req, res));
  return router;
};
