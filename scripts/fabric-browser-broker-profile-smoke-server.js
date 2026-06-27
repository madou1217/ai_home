#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('fs-extra');
const WebSocket = require('ws');

const { connectFabricBroker } = require('../lib/cli/services/fabric/broker-connect');
const { brokerProxyBase } = require('./fabric-real-broker-smoke');
const { startFabricSmokeServer } = require('./fabric-smoke-support');

async function main() {
  const serverId = `browser-broker-${Date.now().toString(36)}`;
  const brokerToken = crypto.randomBytes(24).toString('base64url');
  let brokerHandle = null;

  const smoke = await startFabricSmokeServer({
    name: 'Browser Broker Profile Smoke',
    dirPrefix: 'aih-fabric-browser-broker-smoke-',
    argv: ['node', 'scripts/fabric-browser-broker-profile-smoke-server.js'],
    scopes: [
      'control-plane:read',
      'nodes:read',
      'status:read',
      'accounts:read',
      'usage:read',
      'sessions:read',
      'sessions:write'
    ],
    serverOptions: {
      managementKey: brokerToken
    }
  });

  const cleanup = async () => {
    try {
      if (brokerHandle && typeof brokerHandle.close === 'function') brokerHandle.close();
    } catch (_error) {}
    await smoke.cleanup();
  };

  process.once('SIGTERM', cleanup);
  process.once('SIGINT', cleanup);
  process.once('exit', () => {
    try {
      if (brokerHandle && typeof brokerHandle.close === 'function') brokerHandle.close();
    } catch (_error) {}
    try {
      fs.rmSync(smoke.aiHomeDir, { recursive: true, force: true });
    } catch (_error) {}
  });

  brokerHandle = await connectFabricBroker({
    brokerUrl: smoke.controlEndpoint,
    serverId,
    token: brokerToken,
    localUrl: smoke.controlEndpoint,
    connectTimeoutMs: 10000,
    requestTimeoutMs: 10000,
    heartbeatMs: 1000
  }, { WebSocket });

  console.log(`SMOKE_AI_HOME_DIR=${smoke.aiHomeDir}`);
  console.log(`SMOKE_ENDPOINT=${smoke.controlEndpoint}`);
  console.log(`SMOKE_SERVER_SETUP_URL=${smoke.controlEndpoint}/ui/server-setup`);
  console.log(`SMOKE_PAIR_URL=${smoke.invite.pairUrl}`);
  console.log(`SMOKE_WEB_PAIR_URL=${smoke.invite.webPairUrl}`);
  console.log(`SMOKE_BROKER_ENDPOINT=${smoke.controlEndpoint}`);
  console.log(`SMOKE_BROKER_SERVER_ID=${serverId}`);
  console.log(`SMOKE_BROKER_PROXY_BASE=${brokerProxyBase(smoke.controlEndpoint, serverId)}`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
