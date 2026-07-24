const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const {
  syncClaudeDesktopWebSession
} = require('../lib/cli/services/ai-cli/claude-desktop-session');

const ACCOUNT_REF = 'acct_66c0a9207ebbe639c664';
const COOKIE_TABLE_SQL = 'CREATE TABLE cookies(creation_utc INTEGER NOT NULL,host_key TEXT NOT NULL,top_frame_site_key TEXT NOT NULL,name TEXT NOT NULL,value TEXT NOT NULL,encrypted_value BLOB NOT NULL,path TEXT NOT NULL,expires_utc INTEGER NOT NULL,is_secure INTEGER NOT NULL,is_httponly INTEGER NOT NULL,last_access_utc INTEGER NOT NULL,has_expires INTEGER NOT NULL,is_persistent INTEGER NOT NULL,priority INTEGER NOT NULL,samesite INTEGER NOT NULL,source_scheme INTEGER NOT NULL,source_port INTEGER NOT NULL,last_update_utc INTEGER NOT NULL,source_type INTEGER NOT NULL,has_cross_site_ancestor INTEGER NOT NULL)';
const COOKIE_INDEX_SQL = 'CREATE UNIQUE INDEX cookies_unique_index ON cookies(host_key, top_frame_site_key, has_cross_site_ancestor, name, path, source_scheme, source_port)';
const INSERT_COOKIE_SQL = 'INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';

function deriveKey(password) {
  return crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
}

function encryptCookie(hostKey, value, password) {
  const key = deriveKey(password);
  const hostHash = crypto.createHash('sha256').update(hostKey).digest();
  const plaintext = Buffer.concat([hostHash, Buffer.from(value)]);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  key.fill(0);
  plaintext.fill(0);
  return Buffer.concat([Buffer.from('v10'), encrypted]);
}

function decryptCookie(hostKey, encryptedValue, password) {
  const key = deriveKey(password);
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encryptedValue).subarray(3)),
    decipher.final()
  ]);
  const expectedHash = crypto.createHash('sha256').update(hostKey).digest();
  assert.deepEqual(plaintext.subarray(0, expectedHash.length), expectedHash);
  const value = Buffer.from(plaintext.subarray(expectedHash.length));
  key.fill(0);
  plaintext.fill(0);
  return value;
}

function createCookieDatabase(filePath, cookies = []) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new DatabaseSync(filePath);
  try {
    db.exec('CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR)');
    db.exec(COOKIE_TABLE_SQL);
    db.exec(COOKIE_INDEX_SQL);
    db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('version', '24');
    db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)').run('last_compatible_version', '24');
    const insert = db.prepare(INSERT_COOKIE_SQL);
    cookies.forEach((cookie, index) => {
      insert.run(
        100 + index,
        cookie.hostKey || '.claude.ai',
        '',
        cookie.name,
        '',
        cookie.encryptedValue,
        '/',
        cookie.expiresUtc == null ? 20000000000000000 : cookie.expiresUtc,
        1,
        1,
        200 + index,
        1,
        1,
        1,
        -1,
        2,
        443,
        300 + index,
        2,
        0
      );
    });
  } finally {
    db.close();
  }
}

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-claude-desktop-session-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const hostHomeDir = path.join(root, 'home');
  const chromeRoot = path.join(hostHomeDir, 'Library', 'Application Support', 'Google', 'Chrome');
  const chromeProfileDir = path.join(chromeRoot, 'Default');
  const claudeRoot = path.join(hostHomeDir, 'Library', 'Application Support', 'Claude');
  const profileDir = path.join(root, '.ai_home', 'desktop-clients', 'claude', ACCOUNT_REF);
  fs.mkdirSync(chromeRoot, { recursive: true });
  fs.writeFileSync(path.join(chromeRoot, 'Local State'), JSON.stringify({
    profile: {
      info_cache: {
        Default: { user_name: 'target@example.com' },
        'Profile 1': { user_name: 'other@example.com' }
      }
    }
  }));
  createCookieDatabase(path.join(claudeRoot, 'Cookies'));
  return { root, hostHomeDir, chromeProfileDir, profileDir };
}

test('Claude desktop session migrates only matching auth cookies and re-encrypts them', (t) => {
  const fixture = createFixture(t);
  const chromePassword = Buffer.from('chrome-password');
  const claudePassword = Buffer.from('claude-password');
  const sourceCookiesPath = path.join(fixture.chromeProfileDir, 'Cookies');
  const expected = {
    sessionKey: 'sk-ant-sid-fake-session-for-tests',
    lastActiveOrg: '11111111-2222-4333-8444-555555555555'
  };
  createCookieDatabase(sourceCookiesPath, [
    {
      name: 'sessionKey',
      encryptedValue: encryptCookie('.claude.ai', expected.sessionKey, chromePassword)
    },
    {
      name: 'lastActiveOrg',
      encryptedValue: encryptCookie('.claude.ai', expected.lastActiveOrg, chromePassword)
    },
    {
      name: 'unrelated',
      encryptedValue: encryptCookie('.claude.ai', 'must-not-copy', chromePassword)
    }
  ]);

  const result = syncClaudeDesktopWebSession({
    fs,
    path,
    processObj: { platform: 'darwin', pid: 123 },
    hostHomeDir: fixture.hostHomeDir,
    profileDir: fixture.profileDir,
    accountRef: ACCOUNT_REF,
    readAccountNativeAuth: () => ({
      credentials: {
        claudeAiOauth: {
          account: { emailAddress: 'target@example.com' }
        }
      }
    }),
    readSafeStoragePassword({ service }) {
      return Buffer.from(service === 'Chrome Safe Storage' ? chromePassword : claudePassword);
    }
  });

  assert.deepEqual(result, {
    ok: true,
    status: 'migrated',
    sourceBrowser: 'chrome',
    sourceProfile: 'Default',
    cookieCount: 2
  });
  const targetCookiesPath = path.join(fixture.profileDir, 'Cookies');
  const db = new DatabaseSync(targetCookiesPath, { readOnly: true });
  try {
    const rows = db.prepare('SELECT host_key, name, encrypted_value FROM cookies ORDER BY name').all();
    assert.deepEqual(rows.map((row) => row.name), ['lastActiveOrg', 'sessionKey']);
    rows.forEach((row) => {
      const value = decryptCookie(row.host_key, row.encrypted_value, claudePassword);
      assert.equal(value.toString('utf8'), expected[row.name]);
      value.fill(0);
    });
  } finally {
    db.close();
  }
  assert.equal(fs.statSync(fixture.profileDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(targetCookiesPath).mode & 0o777, 0o600);
});

test('Claude desktop session reuses an existing account profile without reading browser secrets', (t) => {
  const fixture = createFixture(t);
  fs.mkdirSync(fixture.profileDir, { recursive: true });
  createCookieDatabase(path.join(fixture.profileDir, 'Cookies'), [
    { name: 'sessionKey', encryptedValue: Buffer.from('v10-existing-session') },
    { name: 'lastActiveOrg', encryptedValue: Buffer.from('v10-existing-org') }
  ]);

  const result = syncClaudeDesktopWebSession({
    fs,
    path,
    processObj: { platform: 'darwin', pid: 123 },
    hostHomeDir: fixture.hostHomeDir,
    profileDir: fixture.profileDir,
    accountRef: ACCOUNT_REF,
    readAccountNativeAuth: () => ({
      credentials: { claudeAiOauth: { account: { emailAddress: 'target@example.com' } } }
    }),
    readSafeStoragePassword() {
      throw new Error('existing profile must not access Safe Storage');
    }
  });

  assert.deepEqual(result, {
    ok: true,
    status: 'existing',
    cookieCount: 2
  });
});

test('Claude desktop session leaves a clean isolated profile when no browser login matches', (t) => {
  const fixture = createFixture(t);
  const result = syncClaudeDesktopWebSession({
    fs,
    path,
    processObj: { platform: 'darwin', pid: 123 },
    hostHomeDir: fixture.hostHomeDir,
    profileDir: fixture.profileDir,
    accountRef: ACCOUNT_REF,
    readAccountNativeAuth: () => ({
      credentials: { claudeAiOauth: { account: { emailAddress: 'missing@example.com' } } }
    })
  });

  assert.deepEqual(result, {
    ok: true,
    status: 'login_required',
    reason: 'matching_browser_session_not_found',
    cookieCount: 0
  });
  assert.equal(fs.statSync(fixture.profileDir).mode & 0o777, 0o700);
});

test('Claude desktop session skips expired Chrome auth and selects a matching Edge web session', (t) => {
  const fixture = createFixture(t);
  const chromePassword = Buffer.from('chrome-password');
  const edgePassword = Buffer.from('edge-password');
  const claudePassword = Buffer.from('claude-password');
  createCookieDatabase(path.join(fixture.chromeProfileDir, 'Cookies'), [
    {
      name: 'sessionKey',
      encryptedValue: encryptCookie('.claude.ai', 'sk-ant-sid-expired', chromePassword),
      expiresUtc: 1
    },
    {
      name: 'lastActiveOrg',
      encryptedValue: encryptCookie('.claude.ai', '11111111-2222-4333-8444-555555555555', chromePassword)
    }
  ]);
  const edgeRoot = path.join(
    fixture.hostHomeDir,
    'Library',
    'Application Support',
    'Microsoft Edge'
  );
  fs.mkdirSync(edgeRoot, { recursive: true });
  fs.writeFileSync(path.join(edgeRoot, 'Local State'), JSON.stringify({
    profile: { info_cache: { Default: { user_name: 'browser@example.com' } } }
  }));
  const edgeProfile = path.join(edgeRoot, 'Default');
  const edgeStorage = path.join(edgeProfile, 'Local Storage', 'leveldb');
  fs.mkdirSync(edgeStorage, { recursive: true });
  fs.writeFileSync(path.join(edgeStorage, '000001.log'), 'target@example.com');
  createCookieDatabase(path.join(edgeProfile, 'Cookies'), [
    {
      name: 'sessionKey',
      encryptedValue: encryptCookie('.claude.ai', 'sk-ant-sid-edge-session', edgePassword)
    },
    {
      name: 'lastActiveOrg',
      encryptedValue: encryptCookie('.claude.ai', '11111111-2222-4333-8444-555555555555', edgePassword)
    }
  ]);
  const accessedServices = [];

  const result = syncClaudeDesktopWebSession({
    fs,
    path,
    processObj: { platform: 'darwin', pid: 123 },
    hostHomeDir: fixture.hostHomeDir,
    profileDir: fixture.profileDir,
    accountRef: ACCOUNT_REF,
    readAccountNativeAuth: () => ({
      credentials: {
        claudeAiOauth: { account: { emailAddress: 'target@example.com' } }
      }
    }),
    readSafeStoragePassword({ service }) {
      accessedServices.push(service);
      if (service === 'Microsoft Edge Safe Storage') return Buffer.from(edgePassword);
      if (service === 'Claude Safe Storage') return Buffer.from(claudePassword);
      throw new Error(`unexpected Safe Storage service: ${service}`);
    }
  });

  assert.deepEqual(result, {
    ok: true,
    status: 'migrated',
    sourceBrowser: 'edge',
    sourceProfile: 'Default',
    cookieCount: 2
  });
  assert.deepEqual(accessedServices, [
    'Microsoft Edge Safe Storage',
    'Claude Safe Storage'
  ]);
});

test('Claude desktop session rejects an unsafe account scope', (t) => {
  const fixture = createFixture(t);
  assert.deepEqual(syncClaudeDesktopWebSession({
    fs,
    path,
    processObj: { platform: 'darwin', pid: 123 },
    hostHomeDir: fixture.hostHomeDir,
    profileDir: fixture.profileDir,
    accountRef: '../escape'
  }), {
    ok: false,
    status: 'failed',
    reason: 'invalid_account_scope',
    cookieCount: 0
  });
});
