'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSessionStoreService } = require('../lib/cli/services/session-store');
const { AI_CLI_CONFIGS } = require('../lib/cli/services/ai-cli/provider-registry');

function makeStore(root) {
  return createSessionStoreService({
    fs,
    path,
    hostHomeDir: path.join(root, 'host'),
    aiHomeDir: path.join(root, 'aih'),
    cliConfigs: AI_CLI_CONFIGS
  });
}

test('qoder/qodercn configAtProjectionRoot: login reconcile does not leave .qoder unresolved', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-qoder-session-'));
  fs.mkdirSync(path.join(root, 'host'), { recursive: true });
  fs.mkdirSync(path.join(root, 'aih'), { recursive: true });
  const store = makeStore(root);

  for (const provider of ['qoder', 'qodercn']) {
    const projectionRoot = path.join(root, 'proj', provider);
    fs.mkdirSync(projectionRoot, { recursive: true });
    // Pretend auth files already projected
    const credName = provider === 'qodercn'
      ? 'qoder-cli-cn-credentials.json'
      : 'qoder-cli-credentials.json';
    fs.writeFileSync(path.join(projectionRoot, credName), 'iv:tag:cipher', 'utf8');
    fs.writeFileSync(path.join(projectionRoot, '.keychain-salt'), Buffer.alloc(32));

    const result = store.ensureSessionStoreLinks(provider, `login-test-${provider}`, {
      projectionRoot
    });
    assert.equal(
      Array.isArray(result.unresolved) ? result.unresolved.length : 0,
      0,
      `${provider} unresolved=${JSON.stringify(result.unresolved || [])}`
    );
    // Projection root remains the config root (no nested globalDir forced for projection)
    assert.ok(fs.existsSync(projectionRoot));
    assert.ok(fs.existsSync(path.join(projectionRoot, credName)));
  }
});

test('qodercn host store root uses .qoder-cn not .qoder', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-qoder-store-'));
  const host = path.join(root, 'host');
  fs.mkdirSync(host, { recursive: true });
  const store = makeStore(root);
  // ensureSessionStoreLinks creates host store via getGlobalToolConfigRoot
  const projectionRoot = path.join(root, 'proj-cn');
  fs.mkdirSync(projectionRoot, { recursive: true });
  store.ensureSessionStoreLinks('qodercn', 'login-cn', { projectionRoot });
  assert.ok(fs.existsSync(path.join(host, '.qoder-cn')));
  assert.equal(fs.existsSync(path.join(host, '.qoder')), false);
});
