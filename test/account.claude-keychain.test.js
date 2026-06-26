'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const {
  buildClaudeKeychainService,
  readClaudeKeychainCredentials,
  materializeClaudeKeychainCredentials
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
    const configDir = '/Users/model/.ai_home/profiles/claude/4/.claude';
    const expectedSuffix = crypto.createHash('sha256').update(configDir).digest('hex').slice(0, 8);
    assert.equal(buildClaudeKeychainService(configDir), `Claude Code-credentials-${expectedSuffix}`);
    assert.equal(buildClaudeKeychainService(''), 'Claude Code-credentials');
  });

  it('reads the account-scoped suffixed keychain entry, querying -a $USER -s <suffixed>', () => {
    const configDir = '/Users/model/.ai_home/profiles/claude/4/.claude';
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
    const configDir = '/Users/model/.ai_home/profiles/claude/4/.claude';
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

  it('materializes the keychain into .credentials.json when the file is missing', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-test-keychain-'));
    try {
      const profileDir = path.join(tmpDir, 'claude', '4');
      const claudeDir = path.join(profileDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });

      const wrote = materializeClaudeKeychainCredentials({
        profileDir,
        fs,
        path,
        processObj: { platform: 'darwin', pid: 123 },
        execFileSync: fakeSecuritySuccess()
      });

      assert.equal(wrote, true);
      const credPath = path.join(claudeDir, '.credentials.json');
      assert.ok(fs.existsSync(credPath));
      const written = JSON.parse(fs.readFileSync(credPath, 'utf8'));
      assert.equal(written.claudeAiOauth.refreshToken, 'sk-ant-ort01-KEYCHAINREFRESH');
      if (process.platform !== 'win32') {
        assert.equal(fs.statSync(credPath).mode & 0o777, 0o600);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('never overwrites an existing .credentials.json (preserves Web-UI per-account login)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-test-keychain-'));
    try {
      const profileDir = path.join(tmpDir, 'claude', '2');
      const claudeDir = path.join(profileDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const credPath = path.join(claudeDir, '.credentials.json');
      const existing = { claudeAiOauth: { accessToken: 'sk-ant-oat01-WEBUI-OWN-TOKEN' } };
      fs.writeFileSync(credPath, JSON.stringify(existing));

      const wrote = materializeClaudeKeychainCredentials({
        profileDir,
        fs,
        path,
        processObj: { platform: 'darwin', pid: 123 },
        execFileSync: fakeSecuritySuccess()
      });

      assert.equal(wrote, false);
      const after = JSON.parse(fs.readFileSync(credPath, 'utf8'));
      assert.equal(after.claudeAiOauth.accessToken, 'sk-ant-oat01-WEBUI-OWN-TOKEN');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not materialize off darwin or when .claude is absent', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-test-keychain-'));
    try {
      const profileDir = path.join(tmpDir, 'claude', '9');
      // .claude intentionally not created
      assert.equal(materializeClaudeKeychainCredentials({
        profileDir, fs, path, processObj: { platform: 'darwin', pid: 1 }, execFileSync: fakeSecuritySuccess()
      }), false);

      fs.mkdirSync(path.join(profileDir, '.claude'), { recursive: true });
      assert.equal(materializeClaudeKeychainCredentials({
        profileDir, fs, path, processObj: { platform: 'linux', pid: 1 }, execFileSync: fakeSecuritySuccess()
      }), false);
      assert.equal(fs.existsSync(path.join(profileDir, '.claude', '.credentials.json')), false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
