const express = require('express');
const router = express.Router();

module.exports = (groupMappingController) => {
  router.get('/', groupMappingController.getConfig);
  router.post('/groups', groupMappingController.createGroup);
  router.put('/regions', groupMappingController.updateRegionMappings);
  router.put('/port-links', groupMappingController.updatePortLinks);
  return router;
};
