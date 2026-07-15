'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  readAccountNativeAuth,
  writeAccountCredentials,
  writeAccountNativeAuth
} = require('../lib/server/account-credential-store');
const {
  captureProviderAuth,
  materializeProviderAuth,
  registerProviderAuthProjection
} = require('../lib/account/native-auth-projection');
const { listCliAccountRefRecords } = require('../lib/server/account-ref-store');
const { upsertAccountRef } = require('../lib/server/account-ref-store');
const { buildProviderEnv } = require('../lib/server/native-session-chat');

function createProjectionFixture(t) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-auth-projection-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  return {
    aiHomeDir,
    runtimeDir(provider, accountRef) {
      return path.join(aiHomeDir, 'run', 'auth', provider, accountRef);
    }
  };
}

function registerAccount(fixture, provider, cliAccountId) {
  return upsertAccountRef(fs, fixture.aiHomeDir, {
    provider,
    cliAccountId,
    identitySeed: `oauth:${provider}:projection-${cliAccountId}@example.com`
  });
}

function projectionOptions(fixture, accountRef) {
  return { aiHomeDir: fixture.aiHomeDir, accountRef };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('Gemini auth materializes from DB and captures refreshed runtime artifacts', (t) => {
  const fixture = createProjectionFixture(t);
  const accountRef = registerAccount(fixture, 'gemini', '1');
  const runtimeDir = fixture.runtimeDir('gemini', accountRef);
  const oauthPath = path.join(runtimeDir, '.gemini', 'oauth_creds.json');
  const accountsPath = path.join(runtimeDir, '.gemini', 'google_accounts.json');

  writeAccountNativeAuth(fs, fixture.aiHomeDir, accountRef, {
    oauthCreds: { access_token: 'db-access', refresh_token: 'db-refresh' },
    googleAccounts: { active: 'gemini@example.com' }
  });

  assert.deepEqual(materializeProviderAuth(fs, runtimeDir, 'gemini', projectionOptions(fixture, accountRef)), {
    materialized: 2,
    removed: 0,
    missing: false
  });
  assert.equal(readJson(oauthPath).access_token, 'db-access');
  assert.equal(readJson(accountsPath).active, 'gemini@example.com');

  fs.writeFileSync(oauthPath, JSON.stringify({
    access_token: 'runtime-access',
    refresh_token: 'db-refresh'
  }), 'utf8');
  fs.unlinkSync(accountsPath);

  const captured = captureProviderAuth(fs, runtimeDir, 'gemini', projectionOptions(fixture, accountRef));
  assert.equal(captured.captured, true);
  assert.deepEqual(readAccountNativeAuth(fs, fixture.aiHomeDir, accountRef), {
    oauthCreds: { access_token: 'runtime-access', refresh_token: 'db-refresh' },
    googleAccounts: { active: 'gemini@example.com' }
  });
});

test('AGY and OpenCode projections round-trip through the account database', (t) => {
  const fixture = createProjectionFixture(t);
  const cases = [
    {
      provider: 'agy',
      nativeAuth: {
        oauthToken: { auth_method: 'consumer', token: { refresh_token: 'agy-refresh' } },
        email: 'agy@example.com'
      },
      authPath: ['.gemini', 'antigravity-cli', 'antigravity-oauth-token'],
      mutate(payload) {
        payload.token.access_token = 'agy-access';
        return payload;
      },
      expectedField: 'oauthToken'
    },
    {
      provider: 'opencode',
      nativeAuth: { auth: { 'opencode-go': { type: 'api', key: 'open-key' } } },
      authPath: ['.local', 'share', 'opencode', 'auth.json'],
      mutate(payload) {
        payload['opencode-go'].key = 'refreshed-key';
        return payload;
      },
      expectedField: 'auth'
    }
  ];

  cases.forEach((item, index) => {
    const cliAccountId = String(index + 1);
    const accountRef = registerAccount(fixture, item.provider, cliAccountId);
    const runtimeDir = fixture.runtimeDir(item.provider, accountRef);
    const authPath = path.join(runtimeDir, ...item.authPath);
    writeAccountNativeAuth(fs, fixture.aiHomeDir, accountRef, item.nativeAuth);

    const options = projectionOptions(fixture, accountRef);
    const materialized = materializeProviderAuth(fs, runtimeDir, item.provider, options);
    assert.equal(materialized.missing, false);
    const changed = item.mutate(readJson(authPath));
    fs.writeFileSync(authPath, JSON.stringify(changed), 'utf8');
    assert.equal(captureProviderAuth(fs, runtimeDir, item.provider, options).captured, true);
    assert.deepEqual(
      readAccountNativeAuth(fs, fixture.aiHomeDir, accountRef)[item.expectedField],
      changed
    );
  });
});

test('materialization removes stale auth artifacts when DB has no required auth', (t) => {
  const fixture = createProjectionFixture(t);
  const cases = [
    ['agy', ['.gemini', 'antigravity-cli', 'antigravity-oauth-token']],
    ['gemini', ['.gemini', 'oauth_creds.json']],
    ['opencode', ['.local', 'share', 'opencode', 'auth.json']]
  ];

  cases.forEach(([provider, relativePath], index) => {
    const accountRef = registerAccount(fixture, provider, String(index + 10));
    const runtimeDir = fixture.runtimeDir(provider, accountRef);
    const authPath = path.join(runtimeDir, ...relativePath);
    fs.mkdirSync(path.dirname(authPath), { recursive: true });
    fs.writeFileSync(authPath, '{"stale":true}\n', 'utf8');

    const result = materializeProviderAuth(fs, runtimeDir, provider, projectionOptions(fixture, accountRef));
    assert.equal(result.missing, true);
    assert.equal(result.removed, 1);
    assert.equal(fs.existsSync(authPath), false);
  });
});

test('capture rejects partial and cross-provider projections without changing DB', (t) => {
  const fixture = createProjectionFixture(t);
  const accountRef = registerAccount(fixture, 'gemini', '1');
  const runtimeDir = fixture.runtimeDir('gemini', accountRef);
  const accountsPath = path.join(runtimeDir, '.gemini', 'google_accounts.json');
  fs.mkdirSync(path.dirname(accountsPath), { recursive: true });
  fs.writeFileSync(accountsPath, '{"active":"partial@example.com"}', 'utf8');

  assert.deepEqual(captureProviderAuth(fs, runtimeDir, 'gemini', projectionOptions(fixture, accountRef)), {
    captured: false,
    reason: 'missing_projection'
  });
  assert.deepEqual(readAccountNativeAuth(fs, fixture.aiHomeDir, accountRef), {});

  const mismatch = materializeProviderAuth(fs, runtimeDir, 'opencode', projectionOptions(fixture, accountRef));
  assert.equal(mismatch.missing, true);
  assert.equal(mismatch.reason, 'unknown_account_ref');
  assert.equal(fs.existsSync(path.join(runtimeDir, '.local', 'share', 'opencode', 'auth.json')), false);
});

test('editing a runtime projection does not change business reads until capture', (t) => {
  const fixture = createProjectionFixture(t);
  const accountRef = registerAccount(fixture, 'opencode', '1');
  const runtimeDir = fixture.runtimeDir('opencode', accountRef);
  const authPath = path.join(runtimeDir, '.local', 'share', 'opencode', 'auth.json');
  const stored = { auth: { openai: { type: 'api', key: 'db-key' } } };
  writeAccountNativeAuth(fs, fixture.aiHomeDir, accountRef, stored);
  materializeProviderAuth(fs, runtimeDir, 'opencode', projectionOptions(fixture, accountRef));
  fs.writeFileSync(authPath, '{"openai":{"type":"api","key":"tampered"}}', 'utf8');

  assert.deepEqual(readAccountNativeAuth(fs, fixture.aiHomeDir, accountRef), stored);
});

test('native provider env accepts DB env credentials without native auth projection', (t) => {
  const fixture = createProjectionFixture(t);
  const accountRef = registerAccount(fixture, 'gemini', '1');
  const runtimeDir = fixture.runtimeDir('gemini', accountRef);
  writeAccountCredentials(fs, fixture.aiHomeDir, accountRef, { GEMINI_API_KEY: 'db-key' });

  const env = buildProviderEnv('gemini', runtimeDir, { HOME: fixture.aiHomeDir }, {
    aiHomeDir: fixture.aiHomeDir,
    accountRef
  });

  assert.equal(env.GEMINI_API_KEY, 'db-key');
  assert.equal(env.GEMINI_CLI_HOME, path.join(fixture.aiHomeDir, '.gemini'));
  assert.equal(fs.existsSync(runtimeDir), false);
});

test('native provider env fails before spawn when DB has neither env nor native auth', (t) => {
  const fixture = createProjectionFixture(t);
  const accountRef = registerAccount(fixture, 'opencode', '1');
  const runtimeDir = fixture.runtimeDir('opencode', accountRef);

  assert.throws(
    () => buildProviderEnv('opencode', runtimeDir, { HOME: fixture.aiHomeDir }, {
      aiHomeDir: fixture.aiHomeDir,
      accountRef
    }),
    /account_auth_projection_failed:missing_credentials/
  );
});

test('Claude login captures its scoped keychain directly into DB without a credential file', (t) => {
  const fixture = createProjectionFixture(t);
  const runtimeDir = path.join(fixture.aiHomeDir, 'run', 'login', 'claude', 'scoped');
  const credentials = {
    claudeAiOauth: {
      accessToken: 'claude-access',
      refreshToken: 'claude-refresh',
      account: { uuid: 'claude-account-uuid' }
    }
  };

  const registration = registerProviderAuthProjection(fs, runtimeDir, 'claude', {
    aiHomeDir: fixture.aiHomeDir,
    cliAccountId: '14',
    processObj: { platform: 'darwin' },
    execFileSync: () => JSON.stringify(credentials)
  });

  assert.equal(registration.registered, true);
  assert.equal(registration.cliAccountId, '14');
  assert.deepEqual(
    readAccountNativeAuth(fs, fixture.aiHomeDir, registration.accountRef),
    { credentials }
  );
  assert.equal(fs.existsSync(path.join(runtimeDir, '.claude', '.credentials.json')), false);
});

test('AGY, Gemini and OpenCode login projections register one accountRef-backed DB record', (t) => {
  const fixture = createProjectionFixture(t);
  const cases = [
    {
      provider: 'agy',
      cliAccountId: '11',
      files: [
        [['.gemini', 'antigravity-cli', 'antigravity-oauth-token'], {
          auth_method: 'consumer',
          token: { refresh_token: 'agy-refresh' }
        }],
        [['.gemini', 'antigravity-cli', 'email.cache'], 'agy-login@example.com']
      ],
      expectedNativeAuth: {
        oauthToken: {
          auth_method: 'consumer',
          token: { refresh_token: 'agy-refresh' }
        },
        email: 'agy-login@example.com'
      }
    },
    {
      provider: 'gemini',
      cliAccountId: '12',
      files: [
        [['.gemini', 'oauth_creds.json'], { refresh_token: 'gemini-refresh' }],
        [['.gemini', 'google_accounts.json'], { active: 'gemini-login@example.com' }]
      ],
      expectedNativeAuth: {
        oauthCreds: { refresh_token: 'gemini-refresh' },
        googleAccounts: { active: 'gemini-login@example.com' }
      }
    },
    {
      provider: 'opencode',
      cliAccountId: '13',
      files: [
        [['.local', 'share', 'opencode', 'auth.json'], {
          openai: { type: 'oauth', refresh: 'opencode-refresh' }
        }]
      ],
      expectedNativeAuth: {
        auth: { openai: { type: 'oauth', refresh: 'opencode-refresh' } }
      }
    }
  ];

  cases.forEach((item) => {
    const runtimeDir = path.join(fixture.aiHomeDir, 'run', 'login', item.provider, item.cliAccountId);
    item.files.forEach(([segments, value]) => {
      const filePath = path.join(runtimeDir, ...segments);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        typeof value === 'string' ? value : JSON.stringify(value),
        'utf8'
      );
    });

    const registration = registerProviderAuthProjection(fs, runtimeDir, item.provider, {
      aiHomeDir: fixture.aiHomeDir,
      cliAccountId: item.cliAccountId
    });

    assert.equal(registration.registered, true);
    assert.match(registration.accountRef, /^acct_[a-f0-9]{20}$/);
    assert.equal(registration.cliAccountId, item.cliAccountId);
    assert.deepEqual(
      readAccountNativeAuth(fs, fixture.aiHomeDir, registration.accountRef),
      item.expectedNativeAuth
    );
  });

  assert.deepEqual(
    listCliAccountRefRecords(fs, fixture.aiHomeDir).map((record) => ({
      provider: record.provider,
      cliAccountId: record.cliAccountId
    })),
    [
      { provider: 'agy', cliAccountId: '11' },
      { provider: 'gemini', cliAccountId: '12' },
      { provider: 'opencode', cliAccountId: '13' }
    ]
  );
  assert.deepEqual(fs.readdirSync(fixture.aiHomeDir).sort(), ['app-state.db', 'run']);
  assert.equal(fs.existsSync(path.join(fixture.aiHomeDir, 'profiles')), false);
});
