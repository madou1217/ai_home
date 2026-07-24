'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  buildClaudeKeychainService,
  parseClaudeKeychainModifiedAt,
  readClaudeKeychainCredentialRecord,
  readClaudeKeychainCredentials,
  writeClaudeKeychainCredentials
} = require('../lib/account/claude-keychain');

const KEYCHAIN_JSON = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-KEYCHAINTOKEN',
    refreshToken: 'sk-ant-ort01-KEYCHAINREFRESH',
    subscriptionType: 'pro'
  }
});

const KEYCHAIN_METADATA = `keychain: "/Users/model/Library/Keychains/login.keychain-db"
class: "genp"
attributes:
    "mdat"<timedate>=0x32303236303732343134313031355A00  "20260724141015Z\\000"
`;

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
    assert.equal(queried.length, 1);
    assert.equal(queried.every((service) => service === buildClaudeKeychainService(configDir)), true);
  });

  it('does not read a different account entry from the same keychain service', () => {
    const calls = [];
    const creds = readClaudeKeychainCredentials({
      processObj: { platform: 'darwin' },
      account: 'model',
      configDir: '/Users/model/.claude',
      includeDefaultService: false,
      execFileSync: (_bin, args) => {
        calls.push(args);
        throw new Error('account item not found');
      }
    });

    assert.equal(creds, null);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 5), [
      'find-generic-password',
      '-a',
      'model',
      '-s',
      buildClaudeKeychainService('/Users/model/.claude')
    ]);
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

  it('parses the keychain modification timestamp without reading the password', () => {
    assert.equal(
      parseClaudeKeychainModifiedAt(KEYCHAIN_METADATA),
      Date.UTC(2026, 6, 24, 14, 10, 15)
    );
    assert.equal(parseClaudeKeychainModifiedAt('missing mdat'), 0);
  });

  it('reads credentials and metadata from the exact scoped keychain item', () => {
    const calls = [];
    const configDir = '/Users/model/.claude';
    const record = readClaudeKeychainCredentialRecord({
      processObj: { platform: 'darwin' },
      account: 'model',
      configDir,
      includeDefaultService: false,
      execFileSync: (_bin, args) => {
        calls.push(args);
        return args.includes('-w') ? KEYCHAIN_JSON : KEYCHAIN_METADATA;
      }
    });

    assert.deepEqual(record.credentials, JSON.parse(KEYCHAIN_JSON));
    assert.equal(record.modifiedAtMs, Date.UTC(2026, 6, 24, 14, 10, 15));
    assert.equal(record.account, 'model');
    assert.equal(record.service, buildClaudeKeychainService(configDir));
    assert.equal(calls.length, 2);
  });

  it('writes credentials through stdin so secrets never enter process argv', () => {
    const calls = [];
    const configDir = '/Users/model/.claude';
    const credentials = JSON.parse(KEYCHAIN_JSON);
    const result = writeClaudeKeychainCredentials(credentials, {
      processObj: { platform: 'darwin' },
      account: 'model',
      configDir,
      execFileSync: (bin, args, options) => {
        calls.push({ bin, args, options });
        return args[0] === 'find-generic-password' ? KEYCHAIN_JSON : '';
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.service, buildClaudeKeychainService(configDir));
    assert.equal(calls.length, 2);
    assert.equal(calls[0].bin, 'security');
    assert.deepEqual(calls[0].args, ['-i']);
    const hexMatch = calls[0].options.input.match(/-X "([0-9a-f]+)"\n$/);
    assert.ok(hexMatch);
    assert.deepEqual(JSON.parse(Buffer.from(hexMatch[1], 'hex').toString('utf8')), credentials);
    assert.equal(calls[0].args.some((value) => String(value).includes('KEYCHAINTOKEN')), false);
    assert.deepEqual(calls[1].args.slice(0, 6), [
      'find-generic-password',
      '-a',
      'model',
      '-s',
      buildClaudeKeychainService(configDir),
      '-w'
    ]);
  });

  it('fails closed when keychain read-back does not match the requested credentials', () => {
    const result = writeClaudeKeychainCredentials(JSON.parse(KEYCHAIN_JSON), {
      processObj: { platform: 'darwin' },
      account: 'model',
      configDir: '/Users/model/.claude',
      execFileSync: (_bin, args) => args[0] === 'find-generic-password'
        ? JSON.stringify({ claudeAiOauth: { accessToken: 'other', refreshToken: 'other' } })
        : ''
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'verification_failed');
  });

});
