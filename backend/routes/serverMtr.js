const express = require('express');
const router = express.Router();

function requireMtrAdmin(req, res, next) {
  const u = req.authUser;
  if (!u) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  if (u.legacyBasic || u.role === 'admin') {
    return next();
  }
  return res.status(403).json({ success: false, error: 'MTR is only available to administrators' });
}

module.exports = (serverMtrController) => {
  router.use(requireMtrAdmin);
  router.get('/list', (req, res) => serverMtrController.getList(req, res));
  router.get('/runs/:id', (req, res) => serverMtrController.getRun(req, res));
  router.post('/sequence/start', (req, res) => serverMtrController.startMtrSequence(req, res));
  router.get('/job/:jobId', (req, res) => serverMtrController.getMtrJob(req, res));

  return router;
};
