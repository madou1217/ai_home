'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  configureClaudeDesktopMode
} = require('../lib/cli/services/ai-cli/claude-desktop-inference');

const ACCOUNT_REF = 'acct_0123456789abcdef0123';

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-claude-desktop-inference-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profileDir = path.join(root, 'desktop-clients', 'claude', ACCOUNT_REF);
  const helperPath = path.join(root, 'claude-desktop-credential');
  fs.writeFileSync(helperPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { root, profileDir, helperPath };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('Claude Desktop API mode writes an applied local 3P gateway config without storing the API key', (t) => {
  const { profileDir, helperPath } = createFixture(t);
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'claude_desktop_config.json'), JSON.stringify({
    preferences: { sidebarMode: 'epitaxy' }
  }));

  const result = configureClaudeDesktopMode({
    fs,
    mode: 'api',
    accountRef: ACCOUNT_REF,
    profileDir,
    credentialHelperPath: helperPath,
    serverConfig: { host: '0.0.0.0', port: 9527, apiKey: 'must-not-be-persisted' }
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'api_configured');
  assert.equal(result.gatewayBaseUrl, 'http://127.0.0.1:9527');

  const libraryDir = path.join(profileDir, 'configLibrary');
  const meta = readJson(path.join(libraryDir, '_meta.json'));
  assert.equal(meta.entries.length, 1);
  assert.equal(meta.entries[0].name, 'ai-home API');
  assert.equal(meta.appliedId, meta.entries[0].id);
  assert.deepEqual(readJson(path.join(libraryDir, `${meta.appliedId}.json`)), {
    inferenceProvider: 'gateway',
    inferenceCredentialKind: 'helper-script',
    inferenceGatewayBaseUrl: 'http://127.0.0.1:9527',
    inferenceGatewayAuthScheme: 'bearer',
    inferenceCredentialHelper: helperPath,
    modelDiscoveryEnabled: true,
    inferenceModels: [
      {
        name: 'claude-sonnet-4-6',
        anthropicFamilyTier: 'sonnet',
        isFamilyDefault: true
      },
      {
        name: 'claude-opus-4-8',
        anthropicFamilyTier: 'opus',
        isFamilyDefault: true
      }
    ]
  });
  assert.equal(fs.readFileSync(path.join(libraryDir, `${meta.appliedId}.json`), 'utf8').includes('must-not-be-persisted'), false);
  assert.deepEqual(readJson(path.join(profileDir, 'developer_settings.json')), { allowDevTools: true });
  assert.deepEqual(readJson(path.join(profileDir, 'claude_desktop_config.json')), {
    preferences: { sidebarMode: 'epitaxy' },
    deploymentMode: '3p'
  });
  assert.equal(fs.statSync(path.join(libraryDir, '_meta.json')).mode & 0o777, 0o600);
});

test('Claude Desktop mode configuration is idempotent and preserves unrelated saved configs', (t) => {
  const { profileDir, helperPath } = createFixture(t);
  const first = configureClaudeDesktopMode({
    fs,
    mode: 'api',
    accountRef: ACCOUNT_REF,
    profileDir,
    credentialHelperPath: helperPath,
    serverConfig: { port: 9527 }
  });
  const libraryDir = path.join(profileDir, 'configLibrary');
  const metaPath = path.join(libraryDir, '_meta.json');
  const meta = readJson(metaPath);
  const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  meta.entries.unshift({ id: userId, name: 'User config' });
  fs.writeFileSync(path.join(libraryDir, `${userId}.json`), '{}\n');
  fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);

  const second = configureClaudeDesktopMode({
    fs,
    mode: 'api',
    accountRef: ACCOUNT_REF,
    profileDir,
    credentialHelperPath: helperPath,
    serverConfig: { port: 9528 }
  });
  const updated = readJson(metaPath);

  assert.equal(first.configId, second.configId);
  assert.equal(updated.entries.length, 2);
  assert.equal(updated.entries.some((entry) => entry.id === userId), true);
  assert.equal(readJson(path.join(libraryDir, `${second.configId}.json`)).inferenceGatewayBaseUrl, 'http://127.0.0.1:9528');
});

test('Claude Desktop web mode keeps the API config available but applies a clean 1P entry', (t) => {
  const { profileDir, helperPath } = createFixture(t);
  const api = configureClaudeDesktopMode({
    fs,
    mode: 'api',
    accountRef: ACCOUNT_REF,
    profileDir,
    credentialHelperPath: helperPath,
    serverConfig: { port: 9527 }
  });
  const web = configureClaudeDesktopMode({
    fs,
    mode: 'web',
    accountRef: ACCOUNT_REF,
    profileDir
  });
  const libraryDir = path.join(profileDir, 'configLibrary');
  const meta = readJson(path.join(libraryDir, '_meta.json'));

  assert.equal(web.ok, true);
  assert.equal(web.status, 'web_configured');
  assert.equal(meta.entries.length, 2);
  assert.notEqual(meta.appliedId, api.configId);
  assert.deepEqual(readJson(path.join(libraryDir, `${meta.appliedId}.json`)), {});
  assert.equal(readJson(path.join(profileDir, 'claude_desktop_config.json')).deploymentMode, '1p');
});

test('Claude Desktop API mode does not activate 3P after a supporting-file write fails', (t) => {
  const { profileDir, helperPath } = createFixture(t);
  fs.mkdirSync(profileDir, { recursive: true });
  const desktopConfigPath = path.join(profileDir, 'claude_desktop_config.json');
  fs.writeFileSync(desktopConfigPath, '{"deploymentMode":"1p"}\n');
  const failingFs = new Proxy(fs, {
    get(target, property) {
      if (property !== 'renameSync') return target[property];
      return (sourcePath, targetPath) => {
        if (targetPath.endsWith('developer_settings.json')) {
          const error = new Error('developer_settings_write_failed');
          error.code = 'EIO';
          throw error;
        }
        return target.renameSync(sourcePath, targetPath);
      };
    }
  });

  const result = configureClaudeDesktopMode({
    fs: failingFs,
    mode: 'api',
    accountRef: ACCOUNT_REF,
    profileDir,
    credentialHelperPath: helperPath,
    serverConfig: { port: 9527 }
  });

  assert.deepEqual(result, {
    ok: false,
    status: 'failed',
    reason: 'developer_settings_write_failed'
  });
  assert.equal(readJson(desktopConfigPath).deploymentMode, '1p');
  assert.equal(fs.readdirSync(profileDir).some((name) => name.includes('.aih-tmp-')), false);
});

test('Claude Desktop mode configuration rejects paths outside the account-scoped profile layout', () => {
  const result = configureClaudeDesktopMode({
    fs,
    mode: 'api',
    accountRef: ACCOUNT_REF,
    profileDir: path.join(os.tmpdir(), ACCOUNT_REF),
    credentialHelperPath: __filename
  });
  assert.deepEqual(result, { ok: false, status: 'failed', reason: 'invalid_account_scope' });
});
