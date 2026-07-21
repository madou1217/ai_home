'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
const os = require('node:os');

const {
  validateCanonicalFabricServerId
} = require('./fabric-server-id');

const FABRIC_ROUTE_PROOF_PATH = '/v0/fabric/route-proof';
const FABRIC_ROUTE_PROOF_VERSION = 1;
const FABRIC_ROUTE_PROOF_TTL_MS = 120_000;
const FABRIC_ROUTE_PROOF_MAX_TTL_MS = 180_000;
const FABRIC_ROUTE_PROOF_MAX_BODY_BYTES = 1024;
const FABRIC_ROUTE_PROOF_MAX_RESPONSE_BYTES = 4096;
const FABRIC_ROUTE_PROOF_MAX_ENDPOINTS = 16;
const FABRIC_ROUTE_PROOF_DOMAIN = 'AIH-LAN-ROUTE-PROOF/1';
const FABRIC_ROUTE_PROOF_MIN_MANAGEMENT_KEY_BYTES = 32;
const FABRIC_ROUTE_PROOF_MAX_MANAGEMENT_KEY_BYTES = 8192;

function routeProofError(code, statusCode = 400) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function normalizeNonce(value) {
  const nonce = String(value || '');
  if (!/^[A-Za-z0-9_-]{43}$/.test(nonce)) return '';
  try {
    const decoded = Buffer.from(nonce, 'base64url');
    return decoded.length === 32 && decoded.toString('base64url') === nonce ? nonce : '';
  } catch (_error) {
    return '';
  }
}

function isUsableIpv4Address(value) {
  if (net.isIP(value) !== 4 || value.startsWith('127.') || value === '0.0.0.0') return false;
  const first = Number(value.split('.')[0]);
  return first > 0 && first < 224;
}

function isIpv4Interface(entry) {
  return entry
    && entry.internal !== true
    && (entry.family === 'IPv4' || entry.family === 4)
    && isUsableIpv4Address(String(entry.address || '').trim());
}

function normalizeListenPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
}

function normalizeExplicitListenAddress(value) {
  const host = String(value || '').trim().toLowerCase();
  if (!host || ['0.0.0.0', '::', '*'].includes(host)) return '';
  return isUsableIpv4Address(host) ? host : null;
}

function buildLanRouteEndpoints(input = {}, deps = {}) {
  const port = normalizeListenPort(input.port);
  if (!port) return [];
  const explicitAddress = normalizeExplicitListenAddress(input.host);
  if (explicitAddress === null) return [];
  const getNetworkInterfaces = deps.networkInterfaces || os.networkInterfaces;
  const addresses = Object.values(getNetworkInterfaces() || {})
    .flatMap((entries) => Array.isArray(entries) ? entries : [])
    .filter(isIpv4Interface)
    .map((entry) => String(entry.address).trim())
    .filter((address) => !explicitAddress || address === explicitAddress);
  return Array.from(new Set(addresses))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, FABRIC_ROUTE_PROOF_MAX_ENDPOINTS)
    .map((address) => `http://${address}:${port}`);
}

function normalizeProofEndpoint(value) {
  const endpoint = String(value || '');
  if (!endpoint || endpoint.length > 128 || /[\r\n]/.test(endpoint)) return '';
  try {
    const parsed = new URL(endpoint);
    const port = normalizeListenPort(parsed.port);
    if (
      parsed.protocol !== 'http:'
      || !isUsableIpv4Address(parsed.hostname)
      || !port
      || parsed.username
      || parsed.password
      || parsed.search
      || parsed.hash
      || (parsed.pathname && parsed.pathname !== '/')
    ) {
      return '';
    }
    return `http://${parsed.hostname}:${port}`;
  } catch (_error) {
    return '';
  }
}

function normalizeProofEndpoints(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > FABRIC_ROUTE_PROOF_MAX_ENDPOINTS) {
    throw routeProofError('invalid_fabric_route_proof_endpoints');
  }
  const endpoints = values.map(normalizeProofEndpoint);
  if (endpoints.some((endpoint) => !endpoint)) {
    throw routeProofError('invalid_fabric_route_proof_endpoints');
  }
  return Array.from(new Set(endpoints)).sort((left, right) => left.localeCompare(right));
}

function normalizeProofTimestamp(value) {
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : -1;
}

function canonicalizeFabricRouteProof(input = {}) {
  const nonce = normalizeNonce(input.nonce);
  const serverId = validateCanonicalFabricServerId(input.serverId);
  const issuedAt = normalizeProofTimestamp(input.issuedAt);
  const expiresAt = normalizeProofTimestamp(input.expiresAt);
  const endpoints = normalizeProofEndpoints(input.endpoints);
  if (!nonce) throw routeProofError('invalid_fabric_route_proof_nonce');
  if (!serverId) throw routeProofError('invalid_fabric_route_proof_server_id');
  if (
    issuedAt < 0
    || expiresAt <= issuedAt
    || expiresAt - issuedAt > FABRIC_ROUTE_PROOF_MAX_TTL_MS
  ) {
    throw routeProofError('invalid_fabric_route_proof_expiry');
  }
  return [
    FABRIC_ROUTE_PROOF_DOMAIN,
    `nonce=${nonce}`,
    `server=${serverId}`,
    `issued=${issuedAt}`,
    `expires=${expiresAt}`,
    `routes=${endpoints.length}`,
    ...endpoints
  ].join('\n');
}

function buildFabricRouteProof(input = {}, deps = {}) {
  const serverId = validateCanonicalFabricServerId(input.serverId);
  if (!serverId) throw routeProofError('invalid_fabric_route_proof_server_id', 503);
  const nonce = normalizeNonce(input.nonce);
  if (!nonce) throw routeProofError('invalid_fabric_route_proof_nonce');
  const managementKey = String(input.managementKey || '').trim();
  if (!managementKey) throw routeProofError('management_key_not_configured', 503);
  const managementKeyBytes = Buffer.byteLength(managementKey, 'utf8');
  if (
    managementKeyBytes < FABRIC_ROUTE_PROOF_MIN_MANAGEMENT_KEY_BYTES
    || managementKeyBytes > FABRIC_ROUTE_PROOF_MAX_MANAGEMENT_KEY_BYTES
    || /[\r\n\0]/.test(managementKey)
  ) {
    // A route proof is an offline HMAC verification sample. Refuse weak
    // legacy Keys instead of turning LAN discovery into a password oracle.
    throw routeProofError('management_key_route_proof_unavailable', 503);
  }
  const endpoints = buildLanRouteEndpoints({ host: input.host, port: input.port }, deps);
  if (endpoints.length < 1) {
    throw routeProofError('fabric_route_proof_endpoint_unavailable', 503);
  }
  const now = deps.now || Date.now;
  const issuedAt = normalizeProofTimestamp(Math.floor(Number(now())));
  if (issuedAt < 0) throw routeProofError('fabric_route_proof_clock_unavailable', 503);
  const result = {
    version: FABRIC_ROUTE_PROOF_VERSION,
    serverId,
    nonce,
    issuedAt,
    expiresAt: issuedAt + FABRIC_ROUTE_PROOF_TTL_MS,
    endpoints
  };
  result.proof = crypto
    .createHmac('sha256', managementKey)
    .update(canonicalizeFabricRouteProof(result), 'utf8')
    .digest('base64url');
  return result;
}

function requestHasAuthorization(req) {
  const value = req && req.headers ? req.headers.authorization : '';
  return String(Array.isArray(value) ? value[0] : value || '').trim().length > 0;
}

function writeRouteProofHeaders(res) {
  if (!res || typeof res.setHeader !== 'function') return;
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'POST,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('cache-control', 'no-store');
}

function writeRouteProofError(ctx, error) {
  const code = String(error && error.code || 'invalid_fabric_route_proof_request');
  const statusCode = Number(error && error.statusCode) || 400;
  ctx.deps.writeJson(ctx.res, statusCode, { ok: false, error: code });
}

function parseRouteProofRequest(body) {
  let payload;
  try {
    payload = body.length > 0 ? JSON.parse(body.toString('utf8')) : null;
  } catch (_error) {
    throw routeProofError('invalid_fabric_route_proof_request');
  }
  if (
    !payload
    || typeof payload !== 'object'
    || Array.isArray(payload)
    || payload.version !== FABRIC_ROUTE_PROOF_VERSION
    || Object.keys(payload).some((key) => !['version', 'nonce'].includes(key))
  ) {
    throw routeProofError('invalid_fabric_route_proof_request');
  }
  const nonce = normalizeNonce(payload.nonce);
  if (!nonce) throw routeProofError('invalid_fabric_route_proof_nonce');
  return { nonce };
}

async function handleFabricRouteProofRequest(ctx) {
  if (ctx.pathname !== FABRIC_ROUTE_PROOF_PATH) return false;
  writeRouteProofHeaders(ctx.res);
  if (ctx.method === 'OPTIONS') {
    ctx.res.statusCode = 204;
    ctx.res.end();
    return true;
  }
  if (ctx.method !== 'POST') return false;
  if (requestHasAuthorization(ctx.req)) {
    writeRouteProofError(ctx, routeProofError('fabric_route_proof_authorization_forbidden'));
    return true;
  }
  let body;
  try {
    body = await ctx.deps.readRequestBody(ctx.req, {
      maxBytes: FABRIC_ROUTE_PROOF_MAX_BODY_BYTES
    });
  } catch (error) {
    const tooLarge = error && (
      error.code === 'request_body_too_large'
      || error.message === 'request_body_too_large'
    );
    writeRouteProofError(ctx, routeProofError(
      tooLarge ? 'fabric_route_proof_body_too_large' : 'invalid_fabric_route_proof_request',
      tooLarge ? 413 : 400
    ));
    return true;
  }
  try {
    const request = parseRouteProofRequest(body);
    const result = buildFabricRouteProof({
      serverId: ctx.state && ctx.state.serverIdentity && ctx.state.serverIdentity.id,
      nonce: request.nonce,
      managementKey: ctx.requiredManagementKey,
      host: ctx.options && ctx.options.host,
      port: ctx.options && ctx.options.port
    }, {
      now: ctx.deps.routeProofNow,
      networkInterfaces: ctx.deps.routeProofNetworkInterfaces
    });
    const response = {
      ok: true,
      rpc: 'fabric.route-proof.create',
      result
    };
    if (Buffer.byteLength(JSON.stringify(response), 'utf8') > FABRIC_ROUTE_PROOF_MAX_RESPONSE_BYTES) {
      throw routeProofError('fabric_route_proof_response_too_large', 503);
    }
    ctx.deps.writeJson(ctx.res, 200, response);
  } catch (error) {
    writeRouteProofError(ctx, error);
  }
  return true;
}

module.exports = {
  FABRIC_ROUTE_PROOF_MAX_BODY_BYTES,
  FABRIC_ROUTE_PROOF_MAX_ENDPOINTS,
  FABRIC_ROUTE_PROOF_MAX_RESPONSE_BYTES,
  FABRIC_ROUTE_PROOF_MAX_TTL_MS,
  FABRIC_ROUTE_PROOF_PATH,
  FABRIC_ROUTE_PROOF_TTL_MS,
  buildFabricRouteProof,
  buildLanRouteEndpoints,
  canonicalizeFabricRouteProof,
  handleFabricRouteProofRequest,
  normalizeNonce
};
