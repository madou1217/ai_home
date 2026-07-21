'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('Codex app-server facade delegates focused endpoint, pool, and legacy runner modules', () => {
  const facade = require('../lib/server/codex-app-server-runner');
  const endpoint = require('../lib/server/codex-app-server-endpoint');
  const pool = require('../lib/server/codex-app-server-client-pool');
  const legacy = require('../lib/server/codex-app-server-legacy-runner');

  assert.strictEqual(facade.appServerSocketName, endpoint.appServerSocketName);
  assert.strictEqual(facade.ensureCodexAppServerEndpoint, endpoint.ensureCodexAppServerEndpoint);
  assert.strictEqual(facade.acquireAppServerClient, pool.acquireAppServerClient);
  assert.strictEqual(facade.getAppServerClient, pool.getAppServerClient);
  assert.strictEqual(facade.startCodexAppServerTurn, legacy.startCodexAppServerTurn);
});

test('canonical Codex driver depends on the resident pool instead of the legacy facade', () => {
  const source = fs.readFileSync(path.join(
    __dirname,
    '..',
    'lib',
    'server',
    'chat-runtime',
    'codex-session-driver.js'
  ), 'utf8');

  assert.match(source, /codex-app-server-client-pool/);
  assert.doesNotMatch(source, /codex-app-server-runner/);
});

test('generic provider driver registry has no concrete Codex dependency', () => {
  const source = fs.readFileSync(path.join(
    __dirname,
    '..',
    'lib',
    'server',
    'chat-runtime',
    'provider-driver-registry.js'
  ), 'utf8');

  assert.doesNotMatch(source, /codex-session-driver/);
});

test('Codex interaction facade delegates provider-specific request strategies', () => {
  const source = sourceFile('chat-runtime/codex-interaction-request-adapter.js');

  assert.match(source, /codex-approval-request-adapter/);
  assert.match(source, /codex-tool-question-request-adapter/);
  assert.match(source, /codex-mcp-elicitation-request-adapter/);
  assert.equal(source.split('\n').length < 140, true);
});

test('generic interaction persistence never understands Codex wire vocabulary', () => {
  const source = [
    sourceFile('chat-runtime/canonical-interaction-payload.js'),
    sourceFile('chat-runtime/interaction-repository.js'),
    sourceFile('chat-runtime/interaction-secret-policy.js')
  ].join('\n');

  assert.doesNotMatch(
    source,
    /availableDecisions|requestedSchema|isSecret|acceptForSession|execpolicy_amendment/
  );
});

function sourceFile(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', 'lib', 'server', relativePath), 'utf8');
}
