'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  resolveClaudeDesktopGatewayCredential,
  resolveClaudeDesktopProfileScope
} = require('../lib/cli/services/ai-cli/claude-desktop-credential');

const ACCOUNT_REF = 'acct_0123456789abcdef0123';

test('Claude Desktop credential helper derives AIH_HOME from the isolated profile and reads the current server key', () => {
  const profileDir = path.join('/tmp', 'aih-test', 'desktop-clients', 'claude', ACCOUNT_REF);
  const calls = [];
  const credential = resolveClaudeDesktopGatewayCredential({
    profileDir,
    fs: {},
    readServerConfig: (options) => {
      calls.push(options.aiHomeDir);
      return { apiKey: 'rotated-key' };
    }
  });

  assert.deepEqual(credential, { token: 'rotated-key' });
  assert.deepEqual(calls, [path.join('/tmp', 'aih-test')]);
  assert.deepEqual(resolveClaudeDesktopProfileScope(profileDir), {
    accountRef: ACCOUNT_REF,
    aiHomeDir: path.join('/tmp', 'aih-test'),
    profileDir
  });
});

test('Claude Desktop credential helper uses the gateway placeholder when client auth is disabled', () => {
  const profileDir = path.join('/tmp', 'aih-test', 'desktop-clients', 'claude', ACCOUNT_REF);
  assert.deepEqual(resolveClaudeDesktopGatewayCredential({
    profileDir,
    fs: {},
    readServerConfig: () => ({ apiKey: '' })
  }), { token: 'dummy' });
});

test('Claude Desktop credential helper rejects unscoped profile paths', () => {
  assert.throws(() => resolveClaudeDesktopGatewayCredential({
    profileDir: path.join('/tmp', ACCOUNT_REF),
    readServerConfig: () => ({ apiKey: 'secret' })
  }), /invalid_claude_desktop_profile/);
});
