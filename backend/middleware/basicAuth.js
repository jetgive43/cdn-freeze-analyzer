/**
 * HTTP Basic Auth. Set DISABLE_BASIC_AUTH=true to skip (local dev).
 * Credentials: BASIC_AUTH_USER / BASIC_AUTH_PASSWORD (see .env).
 */

function isBasicAuthDisabled() {
  return (
    process.env.DISABLE_BASIC_AUTH === 'true' ||
    process.env.DISABLE_BASIC_AUTH === '1'
  );
}

function getBasicAuthCredentials() {
  return {
    user: process.env.BASIC_AUTH_USER,
    pass: process.env.BASIC_AUTH_PASSWORD,
    realm: process.env.BASIC_AUTH_REALM,
  };
}

/** @param {string | undefined} authorizationHeader */
function validateBasicAuthorization(authorizationHeader) {
  if (isBasicAuthDisabled()) {
    return true;
  }
  const { user, pass } = getBasicAuthCredentials();
  const hdr = authorizationHeader;
  if (!hdr || !hdr.startsWith('Basic ')) {
    return false;
  }
  let decoded;
  try {
    decoded = Buffer.from(hdr.slice(6), 'base64').toString('utf8');
  } catch {
    return false;
  }
  const colon = decoded.indexOf(':');
  const u = colon >= 0 ? decoded.slice(0, colon) : decoded;
  const p = colon >= 0 ? decoded.slice(colon + 1) : '';
  return u === user && p === pass;
}

function createBasicAuthMiddleware() {
  const { realm } = getBasicAuthCredentials();
  const publicPrefixes = ['/api/system/health'];
  const publicExact = [];

  return function basicAuth(req, res, next) {
    if (isBasicAuthDisabled()) {
      return next();
    }
    if (req.method === 'OPTIONS') {
      return next();
    }
    if (req.headers.upgrade === 'websocket') {
      return next();
    }
    if (publicExact.includes(req.path)) {
      return next();
    }
    if (publicPrefixes.some((p) => req.path === p || req.path.startsWith(`${p}/`))) {
      return next();
    }

    if (!validateBasicAuthorization(req.headers.authorization)) {
      res.setHeader('WWW-Authenticate', `Basic realm="${realm}"`);
      return res.status(401).send(
        req.headers.authorization ? 'Invalid credentials' : 'Authentication required'
      );
    }

    return next();
  };
}

module.exports = {
  createBasicAuthMiddleware,
  validateBasicAuthorization,
  isBasicAuthDisabled,
  getBasicAuthCredentials,
};
