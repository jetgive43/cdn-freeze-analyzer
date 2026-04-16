/**
 * Best-effort client IP for GeoIP (honor X-Forwarded-For when present).
 * @param {import('express').Request} req
 * @returns {string}
 */
function getClientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.trim()) {
    return xf.split(',')[0].trim();
  }
  if (Array.isArray(xf) && xf[0]) {
    return String(xf[0]).split(',')[0].trim();
  }
  const raw = req.socket?.remoteAddress || '';
  return String(raw).trim();
}

/** Strip IPv4-mapped IPv6 prefix. */
function normalizeClientIp(ip) {
  let s = String(ip || '').trim();
  if (s.startsWith('::ffff:')) {
    s = s.slice(7);
  }
  return s;
}

module.exports = { getClientIp, normalizeClientIp };
