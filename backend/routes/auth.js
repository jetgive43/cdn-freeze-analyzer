const express = require('express');

module.exports = (authController) => {
  const router = express.Router();
  router.post('/signup', (req, res) => authController.signup(req, res));
  router.get('/verify-email', (req, res) => authController.verifyEmail(req, res));
  router.post('/verify-email', (req, res) => authController.verifyEmail(req, res));
  router.post('/login', (req, res) => authController.login(req, res));
  router.post('/forgot-password', (req, res) => authController.forgotPassword(req, res));
  router.post('/reset-password', (req, res) => authController.resetPassword(req, res));
  router.post('/change-password', (req, res) => authController.changePassword(req, res));
  router.get('/me', (req, res) => authController.me(req, res));
  return router;
};
