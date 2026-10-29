'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { preparePiHarness, buildPiModelsDocument } = require('../lib/harness/pi');
const { buildCodexGatewayConnection } = require('../lib/server/codex-gateway-connection');
const { collectLocalRuntimePathEntries } = require('../lib/cli/services/ai-cli/provider-runtime-env');

test('preparePiHarness populates both OPENAI_API_KEY and $OPENAI_API_KEY in child env for compatibility', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-pi-test-'));
  try {
    const fakeCatalog = {
      models: [
        { id: 'gpt-5.6-luna', name: 'GPT 5.6 Luna' }
      ]
    };
    const prepared = await preparePiHarness({
      fs,
      path,
      aiHomeDir: tempDir,
      hostHomeDir: tempDir,
      accountRef: 'acct_test123',
      provider: 'codex',
      gateway: {
        baseUrl: 'http://127.0.0.1:9527/v1',
        apiKey: 'secret_client_key_123'
      },
      catalog: fakeCatalog
    });

    assert.equal(prepared.ok, true);
    assert.equal(prepared.env.OPENAI_API_KEY, 'secret_client_key_123');
    assert.equal(prepared.env['$OPENAI_API_KEY'], 'secret_client_key_123');

    const modelsDoc = buildPiModelsDocument({
      baseUrl: 'http://127.0.0.1:9527/v1',
      accountRef: 'acct_test123',
      models: prepared.models
    });
    assert.equal(modelsDoc.providers.aih.apiKey, '$OPENAI_API_KEY');
    assert.equal(modelsDoc.providers.aih.headers['x-account-ref'], 'acct_test123');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('buildCodexGatewayConnection falls back to AIH_GATEWAY_API_KEY or AIH_SERVER_API_KEY when config.apiKey is empty', () => {
  const originalGatewayKey = process.env.AIH_GATEWAY_API_KEY;
  const originalServerKey = process.env.AIH_SERVER_API_KEY;
  try {
    process.env.AIH_GATEWAY_API_KEY = 'env_gateway_token_xyz';
    delete process.env.AIH_SERVER_API_KEY;

    const connectionWithGatewayKey = buildCodexGatewayConnection({ apiKey: '' }, 'acct_abc');
    assert.equal(connectionWithGatewayKey.apiKey, 'env_gateway_token_xyz');
    assert.equal(connectionWithGatewayKey.env.OPENAI_API_KEY, 'env_gateway_token_xyz');

    delete process.env.AIH_GATEWAY_API_KEY;
    process.env.AIH_SERVER_API_KEY = 'env_server_token_uvw';
    const connectionWithServerKey = buildCodexGatewayConnection({}, 'acct_abc');
    assert.equal(connectionWithServerKey.apiKey, 'env_server_token_uvw');

    delete process.env.AIH_SERVER_API_KEY;
    const connectionDefault = buildCodexGatewayConnection({}, 'acct_abc');
    assert.equal(connectionDefault.apiKey, 'dummy');
  } finally {
    if (originalGatewayKey !== undefined) process.env.AIH_GATEWAY_API_KEY = originalGatewayKey;
    else delete process.env.AIH_GATEWAY_API_KEY;
    if (originalServerKey !== undefined) process.env.AIH_SERVER_API_KEY = originalServerKey;
    else delete process.env.AIH_SERVER_API_KEY;
  }
});

test('collectLocalRuntimePathEntries sorts .node-runtime versions descending and prevents downgrading newer host node', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-runtime-test-'));
  try {
    const runtimeRoot = path.join(tempDir, '.node-runtime');
    const bin16 = path.join(runtimeRoot, 'node-v22.16.0-linux-x64', 'bin');
    const bin22 = path.join(runtimeRoot, 'node-v22.22.0-linux-x64', 'bin');
    fs.mkdirSync(bin16, { recursive: true });
    fs.mkdirSync(bin22, { recursive: true });

    // Case 1: When host process has a lower version (v18.0.0), it should prepend the highest version in .node-runtime
    const entriesLowHost = collectLocalRuntimePathEntries({
      runtimeRootDir: tempDir,
      processVersion: 'v18.0.0',
      fs,
      path
    });
    assert.equal(entriesLowHost.length, 2);
    assert.equal(entriesLowHost[0], bin22);
    assert.equal(entriesLowHost[1], bin16);

    // Case 2: When host process already has an equal or higher version (v22.22.1 >= v22.22.0), it should NOT downgrade
    const entriesHighHost = collectLocalRuntimePathEntries({
      runtimeRootDir: tempDir,
      processVersion: 'v22.22.1',
      fs,
      path
    });
    assert.equal(entriesHighHost.length, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
