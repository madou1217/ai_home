#!/usr/bin/env node
'use strict';

const fs = require('fs-extra');

const { startFabricSmokeServer } = require('./fabric-smoke-support');

async function main() {
  const smoke = await startFabricSmokeServer({
    name: 'Browser Smoke',
    dirPrefix: 'aih-fabric-browser-smoke-',
    argv: ['node', 'scripts/fabric-browser-pairing-smoke-server.js'],
    scopes: [
      'control-plane:read',
      'nodes:read',
      'status:read',
      'accounts:read',
      'usage:read',
      'sessions:read',
      'sessions:write'
    ]
  });

  process.once('SIGTERM', smoke.cleanup);
  process.once('SIGINT', smoke.cleanup);
  process.once('exit', () => {
    try {
      fs.rmSync(smoke.aiHomeDir, { recursive: true, force: true });
    } catch (_error) {}
  });

  console.log(`SMOKE_AI_HOME_DIR=${smoke.aiHomeDir}`);
  console.log(`SMOKE_ENDPOINT=${smoke.controlEndpoint}`);
  console.log(`SMOKE_PAIR_URL=${smoke.invite.pairUrl}`);
  console.log(`SMOKE_WEB_PAIR_URL=${smoke.invite.webPairUrl}`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
