'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const test = require('node:test');

const {
  FABRIC_ROUTE_PROOF_MAX_BODY_BYTES,
  FABRIC_ROUTE_PROOF_MAX_TTL_MS,
  FABRIC_ROUTE_PROOF_PATH,
  FABRIC_ROUTE_PROOF_TTL_MS,
  buildFabricRouteProof,
  canonicalizeFabricRouteProof
} = require('../lib/server/fabric-route-proof');
const { handleFabricRequest } = require('../lib/server/fabric-router');

const MANAGEMENT_KEY = 'management-key-with-at-least-thirty-two-bytes';
const NONCE = Buffer.alloc(32, 7).toString('base64url');

function writeJson(res, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  res.statusCode = statusCode;
  res.setHeader('content-type', 'application/json');
  res.setHeader('content-length', String(body.length));
  res.end(body);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) return resolve();
    server.close(resolve);
  });
}

function createBodyReader(observedLimits) {
  return (req, options = {}) => {
    observedLimits.push(Number(options.maxBytes) || 0);
    const maxBytes = Number(options.maxBytes) || Infinity;
    return new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      req.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          const error = new Error('request_body_too_large');
          error.code = 'request_body_too_large';
          reject(error);
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  };
}

async function createHarness(t, options = {}) {
  const observedLimits = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const handled = await handleFabricRequest({
      method: req.method,
      pathname: url.pathname,
      url,
      req,
      res,
      options: {
        host: '0.0.0.0',
        port: 9527
      },
      state: {
        serverIdentity: {
          id: 'server-stable-home',
          name: 'Home'
        }
      },
      requiredManagementKey: MANAGEMENT_KEY,
      deps: {
        writeJson,
        readRequestBody: createBodyReader(observedLimits),
        routeProofNow: () => 1_000,
        routeProofNetworkInterfaces: () => ({
          en0: [{ family: 'IPv4', address: '192.168.1.20', internal: false }],
          lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }]
        }),
        ...options.deps
      }
    });
    if (!handled && !res.writableEnded) {
      writeJson(res, 404, { ok: false, error: 'not_found' });
    }
  });
  const address = await listen(server);
  t.after(() => closeServer(server));
  return {
    origin: `http://127.0.0.1:${address.port}`,
    observedLimits
  };
}

test('LAN route proof signs the fixed canonical payload over server-owned endpoints', () => {
  const proof = buildFabricRouteProof({
    serverId: 'server-stable-home',
    nonce: NONCE,
    managementKey: MANAGEMENT_KEY,
    host: '0.0.0.0',
    port: 9527
  }, {
    now: () => 1_000,
    networkInterfaces: () => ({
      en10: [{ family: 4, address: '10.0.0.8', internal: false }],
      en0: [
        { family: 'IPv4', address: '192.168.1.20', internal: false },
        { family: 'IPv4', address: '192.168.1.20', internal: false }
      ],
      lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
      en6: [{ family: 'IPv6', address: 'fe80::1', internal: false }]
    })
  });
  const expected = {
    version: 1,
    serverId: 'server-stable-home',
    nonce: NONCE,
    issuedAt: 1_000,
    expiresAt: 1_000 + FABRIC_ROUTE_PROOF_TTL_MS,
    endpoints: [
      'http://10.0.0.8:9527',
      'http://192.168.1.20:9527'
    ]
  };
  const canonical = [
    'AIH-LAN-ROUTE-PROOF/1',
    `nonce=${NONCE}`,
    'server=server-stable-home',
    'issued=1000',
    `expires=${1_000 + FABRIC_ROUTE_PROOF_TTL_MS}`,
    'routes=2',
    'http://10.0.0.8:9527',
    'http://192.168.1.20:9527'
  ].join('\n');

  assert.deepEqual({ ...proof, proof: undefined }, { ...expected, proof: undefined });
  assert.equal(canonicalizeFabricRouteProof(expected), canonical);
  assert.equal(
    proof.proof,
    crypto.createHmac('sha256', MANAGEMENT_KEY).update(canonical).digest('base64url')
  );
  assert.equal(FABRIC_ROUTE_PROOF_TTL_MS, 120_000);
  assert.equal(FABRIC_ROUTE_PROOF_MAX_TTL_MS, 180_000);
  assert.match(proof.proof, /^[A-Za-z0-9_-]{43}$/u);
  assert.doesNotMatch(JSON.stringify(proof), /management-key|127\.0\.0\.1|fe80/iu);
});

test('LAN route proof refuses weak Management Keys that would expose an offline oracle', () => {
  assert.throws(
    () => buildFabricRouteProof({
      serverId: 'server-stable-home',
      nonce: NONCE,
      managementKey: 'short-key',
      host: '0.0.0.0',
      port: 9527
    }, {
      now: () => 1_000,
      networkInterfaces: () => ({
        en0: [{ family: 'IPv4', address: '192.168.1.20', internal: false }]
      })
    }),
    (error) => error && error.code === 'management_key_route_proof_unavailable'
  );
});

test('route proof endpoint rejects Authorization and bounds its request body', async (t) => {
  const harness = await createHarness(t);
  const authorized = await fetch(`${harness.origin}${FABRIC_ROUTE_PROOF_PATH}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${MANAGEMENT_KEY}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ version: 1, nonce: NONCE })
  });

  assert.equal(authorized.status, 400);
  assert.equal((await authorized.json()).error, 'fabric_route_proof_authorization_forbidden');
  assert.deepEqual(harness.observedLimits, []);

  const response = await fetch(`${harness.origin}${FABRIC_ROUTE_PROOF_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1, nonce: NONCE })
  });
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.equal(payload.ok, true);
  assert.deepEqual(harness.observedLimits, [FABRIC_ROUTE_PROOF_MAX_BODY_BYTES]);
  assert.equal(payload.result.serverId, 'server-stable-home');
  assert.equal(payload.result.nonce, NONCE);
  assert.deepEqual(payload.result.endpoints, ['http://192.168.1.20:9527']);
  assert.doesNotMatch(JSON.stringify(payload), new RegExp(MANAGEMENT_KEY, 'u'));
});

test('route proof endpoint rejects malformed nonce and unavailable LAN endpoints', async (t) => {
  const invalidHarness = await createHarness(t);
  const invalid = await fetch(`${invalidHarness.origin}${FABRIC_ROUTE_PROOF_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1, nonce: 'too-short' })
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error, 'invalid_fabric_route_proof_nonce');

  const unavailableHarness = await createHarness(t, {
    deps: {
      routeProofNetworkInterfaces: () => ({
        lo0: [{ family: 'IPv4', address: '127.0.0.1', internal: true }]
      })
    }
  });
  const unavailable = await fetch(`${unavailableHarness.origin}${FABRIC_ROUTE_PROOF_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1, nonce: NONCE })
  });
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error, 'fabric_route_proof_endpoint_unavailable');
});
