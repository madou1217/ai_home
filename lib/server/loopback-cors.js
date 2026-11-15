'use strict';

/**
 * Loopback WebUI CORS shim.
 *
 * The local WebUI (http://127.0.0.1:<port> / http://localhost:<port>) adds a
 * remote AIH Server from another origin. The connect probe and the status
 * refresh call the remote management API directly, so the browser sends a
 * CORS preflight. The public management routes authenticate Bearer before
 * looking at the method, which turns the preflight into a 401 and blocks the
 * real request.
 *
 * Only loopback browser origins are allowed: a remote website cannot forge
 * the Origin header, and the actual request still needs the Management Key.
 * Non-loopback origins get no CORS headers and remain blocked by the browser.
 */

const MANAGEMENT_PREFIXES = ['/v0/node-rpc', '/v0/management'];
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const ALLOWED_HEADERS = new Set(['authorization', 'content-type', 'accept']);

function isLoopbackOrigin(origin) {
  let parsed;
  try {
    parsed = new URL(String(origin || '').trim());
  } catch (_error) {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (!parsed.hostname || parsed.username || parsed.password) return false;
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) return false;
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost') return true;
  if (host === '::1' || host === '[::1]') return true;
  return /^127(?:\.\d{1,3}){3}$/.test(host);
}

function isManagementPath(pathname) {
  return MANAGEMENT_PREFIXES.some((prefix) => (
    pathname === prefix || pathname.startsWith(prefix + '/')
  ));
}

function splitHeaderList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Apply CORS headers for loopback WebUI origins.
 * Returns true when the request was fully handled (preflight response).
 */
function applyLoopbackCors(req, res, pathname) {
  if (!req || !res || !isManagementPath(pathname)) return false;
  const origin = String((req.headers && req.headers.origin) || '').trim();
  if (!origin || !isLoopbackOrigin(origin)) return false;

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Type, Content-Disposition');
  res.setHeader('Access-Control-Max-Age', '600');

  if (String(req.method || '').toUpperCase() !== 'OPTIONS') return false;

  const requestedMethod = String(
    (req.headers && req.headers['access-control-request-method']) || 'GET'
  ).toUpperCase();
  if (!ALLOWED_METHODS.has(requestedMethod)) {
    res.statusCode = 403;
    res.end();
    return true;
  }
  const requestedHeaders = splitHeaderList(
    req.headers && req.headers['access-control-request-headers']
  );
  if (requestedHeaders.some((header) => !ALLOWED_HEADERS.has(header))) {
    res.statusCode = 403;
    res.end();
    return true;
  }

  res.statusCode = 204;
  res.end();
  return true;
}

module.exports = {
  applyLoopbackCors,
  isLoopbackOrigin,
  isManagementPath
};
