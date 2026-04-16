const {
  validateBasicAuthorization,
  getBasicAuthCredentials,
} = require('./basicAuth');

function isPublicRoute(req) {
  if (req.method === 'OPTIONS') {
    return true;
  }
  const p = req.path || '';
  if (p === '/api/system/health' || p.startsWith('/api/system/health/')) {
    return true;
  }
  if (p === '/api/auth/signup' && req.method === 'POST') {
    return true;
  }
  if (p === '/api/auth/verify-email' && (req.method === 'GET' || req.method === 'POST')) {
    return true;
  }
  if (p === '/api/auth/login' && req.method === 'POST') {
    return true;
  }
  if (p === '/api/auth/forgot-password' && req.method === 'POST') {
    return true;
  }
  if (p === '/api/auth/reset-password' && req.method === 'POST') {
    return true;
  }
  if (p === '/api/business-servers/ingest' && req.method === 'POST') {
    return true;
  }
  /** All server-ping APIs: public (optional Bearer). Controllers enforce client IP / role where needed. */
  if (p.startsWith('/api/server-ping')) {
    return true;
  }
  return false;
}

function createUnifiedAuthMiddleware(authService) {
  const { realm } = getBasicAuthCredentials();

  return function unifiedAuth(req, res, next) {
    if (req.headers.upgrade === 'websocket') {
      return next();
    }

    const tryBearer = () => {
      const h = req.headers.authorization;
      if (!h || !h.startsWith('Bearer ')) {
        return;
      }
      const token = h.slice(7).trim();
      if (!token) {
        return;
      }
      const u = authService.verifyAccessToken(token);
      if (u) {
        req.authUser = u;
      }
    };

    if (isPublicRoute(req)) {
      tryBearer();
      return next();
    }

    tryBearer();
    if (req.authUser) {
      return next();
    }

    if (validateBasicAuthorization(req.headers.authorization)) {
      req.authUser = {
        legacyBasic: true,
        role: 'admin',
        verified: true,
        id: null,
        email: null,
      };
      return next();
    }

    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ success: false, error: 'Authentication required' });
    }

    // React SPA + static files live outside /api — allow the browser to load the shell; JWT still required for API.
    if (req.method === 'GET' || req.method === 'HEAD') {
      return next();
    }

    res.setHeader('WWW-Authenticate', `Basic realm="${realm || 'Restricted'}"`);
    return res.status(401).send('Authentication required');
  };
}

module.exports = { createUnifiedAuthMiddleware };
