'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  buildClaudeKeychainService,
  readClaudeKeychainCredentials
} = require('../lib/account/claude-keychain');

const KEYCHAIN_JSON = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-KEYCHAINTOKEN',
    refreshToken: 'sk-ant-ort01-KEYCHAINREFRESH',
    subscriptionType: 'pro'
  }
});

function fakeSecuritySuccess() {
  return () => KEYCHAIN_JSON;
}

describe('claude keychain bridge', () => {
  it('reads keychain credentials on darwin', () => {
    const creds = readClaudeKeychainCredentials({
      processObj: { platform: 'darwin' },
      execFileSync: fakeSecuritySuccess()
    });
    assert.ok(creds && creds.claudeAiOauth);
    assert.equal(creds.claudeAiOauth.accessToken, 'sk-ant-oat01-KEYCHAINTOKEN');
  });

  it('derives the per-CLAUDE_CONFIG_DIR keychain service name (matches claude-code gE)', () => {
    const configDir = '/Users/model/.ai_home/run/login/claude/auth-test/.claude';
    const expectedSuffix = crypto.createHash('sha256').update(configDir).digest('hex').slice(0, 8);
    assert.equal(buildClaudeKeychainService(configDir), `Claude Code-credentials-${expectedSuffix}`);
    assert.equal(buildClaudeKeychainService(''), 'Claude Code-credentials');
  });

  it('reads the account-scoped suffixed keychain entry, querying -a $USER -s <suffixed>', () => {
    const configDir = '/Users/model/.ai_home/run/login/claude/auth-test/.claude';
    const expected = `Claude Code-credentials-${crypto.createHash('sha256').update(configDir).digest('hex').slice(0, 8)}`;
    const calls = [];
    const creds = readClaudeKeychainCredentials({
      processObj: { platform: 'darwin' },
      account: 'model',
      configDir,
      execFileSync: (_bin, args) => {
        calls.push(args);
        return KEYCHAIN_JSON;
      }
    });
    assert.ok(creds && creds.claudeAiOauth);
    // First lookup is account-scoped against the suffixed service.
    assert.deepEqual(calls[0].slice(0, 5), ['find-generic-password', '-a', 'model', '-s', expected]);
  });

  it('falls back to the bare global service when the suffixed entry is empty', () => {
    const configDir = '/Users/model/.ai_home/run/login/claude/auth-test/.claude';
    const queried = new Set();
    const creds = readClaudeKeychainCredentials({
      processObj: { platform: 'darwin' },
      account: 'model',
      configDir,
      execFileSync: (_bin, args) => {
        const service = args[args.indexOf('-s') + 1];
        queried.add(service);
        if (service.includes('-credentials-')) throw new Error('not found');
        return KEYCHAIN_JSON;
      }
    });
    assert.ok(creds && creds.claudeAiOauth);
    // Suffixed service was tried and the bare global service resolved it.
    assert.ok([...queried].some((s) => s.includes('-credentials-')));
    assert.ok(queried.has('Claude Code-credentials'));
  });

  it('does not fall back to global credentials while capturing a scoped login', () => {
    const configDir = '/tmp/aih-login/.claude';
    const queried = [];
    const creds = readClaudeKeychainCredentials({
      processObj: { platform: 'darwin' },
      account: 'model',
      configDir,
      includeDefaultService: false,
      execFileSync: (_bin, args) => {
        queried.push(args[args.indexOf('-s') + 1]);
        throw new Error('not found');
      }
    });

    assert.equal(creds, null);
    assert.equal(queried.length, 2);
    assert.equal(queried.every((service) => service === buildClaudeKeychainService(configDir)), true);
  });

  it('returns null off darwin without touching the keychain', () => {
    let called = false;
    const creds = readClaudeKeychainCredentials({
      processObj: { platform: 'linux' },
      execFileSync: () => { called = true; return KEYCHAIN_JSON; }
    });
    assert.equal(creds, null);
    assert.equal(called, false);
  });

  it('returns null when security fails (no keychain item / locked)', () => {
    const creds = readClaudeKeychainCredentials({
      processObj: { platform: 'darwin' },
      execFileSync: () => { throw new Error('SecKeychainSearchCopyNext: not found'); }
    });
    assert.equal(creds, null);
  });

});
