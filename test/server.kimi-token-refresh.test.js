const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const {
  readAccountNativeAuth,
  writeAccountNativeAuth
} = require('../lib/server/account-credential-store');
const { refreshKimiAccessToken } = require('../lib/server/kimi-token-refresh');

function createKimiFixture(t, credentials) {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kimi-refresh-'));
  t.after(() => fs.rmSync(aiHomeDir, { recursive: true, force: true }));
  const registration = registerAccountIdentity(fs, aiHomeDir, {
    provider: 'kimi',
    cliAccountId: '1',
    identitySeed: 'oauth:kimi:refresh-user-1'
  });
  writeAccountNativeAuth(fs, aiHomeDir, registration.accountRef, { credentials });
  return { aiHomeDir, accountRef: registration.accountRef };
}

function expiredCredentials(refreshToken = 'rt_old') {
  return {
    access_token: 'at_old',
    refresh_token: refreshToken,
    expires_at: Math.floor(Date.now() / 1000) - 60,
    expires_in: 900,
    token_type: 'Bearer',
    scope: 'kimi-code'
  };
}

function okFetch(payload, capture) {
  return async (url, opts, _timeoutMs, proxyOptions) => {
    if (capture) {
      capture.url = url;
      capture.body = String(opts && opts.body || '');
      capture.proxyOptions = proxyOptions;
    }
    return { status: 200, json: async () => payload };
  };
}

function readProjectionCredentials(aiHomeDir, accountRef) {
  const filePath = path.join(
    aiHomeDir, 'run', 'auth-projections', 'kimi', accountRef,
    '.kimi-code', 'credentials', 'kimi-code.json'
  );
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('refreshKimiAccessToken persists rotated refresh_token to DB and writes back projection file', async (t) => {
  const fixture = createKimiFixture(t, expiredCredentials('rt_old'));
  const account = { provider: 'kimi', accountRef: fixture.accountRef };
  const capture = {};
  const resolvedInputs = [];

  const result = await refreshKimiAccessToken(account, {
    force: true,
    proxyUrl: 'http://global-proxy.example:7890',
    noProxy: 'global.example'
  }, {
    fs,
    aiHomeDir: fixture.aiHomeDir,
    async resolveAccountEgressRequestOptions(input) {
      resolvedInputs.push(input);
      return {
        ok: true,
        bound: true,
        options: {
          ...input.options,
          proxyUrl: 'http://127.0.0.1:23116',
          noProxy: 'localhost,127.0.0.1,::1'
        }
      };
    },
    fetchWithTimeout: okFetch({
      access_token: 'at_new',
      refresh_token: 'rt_new',
      expires_in: 900,
      token_type: 'Bearer'
    }, capture)
  });

  assert.equal(result.ok, true);
  assert.equal(result.refreshed, true);
  assert.equal(resolvedInputs.length, 1);
  assert.equal(resolvedInputs[0].provider, 'kimi');
  assert.equal(resolvedInputs[0].accountRef, fixture.accountRef);
  assert.deepEqual(capture.proxyOptions, {
    proxyUrl: 'http://127.0.0.1:23116',
    noProxy: 'localhost,127.0.0.1,::1'
  });

  const stored = readAccountNativeAuth(fs, fixture.aiHomeDir, fixture.accountRef);
  assert.equal(stored.credentials.refresh_token, 'rt_new');
  assert.equal(stored.credentials.access_token, 'at_new');

  // 写回 projection：运行中的 kimi-code CLI ensureFresh 会重读这个文件拿最新 grant
  const projected = readProjectionCredentials(fixture.aiHomeDir, fixture.accountRef);
  assert.equal(projected.refresh_token, 'rt_new');
  assert.equal(projected.access_token, 'at_new');
  assert.equal(account.accessToken, 'at_new');
});

test('refreshKimiAccessToken keeps projection file when CLI raced the rotation', async (t) => {
  const fixture = createKimiFixture(t, expiredCredentials('rt_old'));
  const projectionDir = path.join(
    fixture.aiHomeDir, 'run', 'auth-projections', 'kimi', fixture.accountRef,
    '.kimi-code', 'credentials'
  );
  fs.mkdirSync(projectionDir, { recursive: true });
  // CLI 在 server 刷新前已自行轮换：文件里的 refresh_token 既不是被消费的也不是新签发的
  fs.writeFileSync(
    path.join(projectionDir, 'kimi-code.json'),
    `${JSON.stringify({ ...expiredCredentials('rt_cli_newer'), access_token: 'at_cli_newer' }, null, 2)}\n`
  );

  const result = await refreshKimiAccessToken(
    { provider: 'kimi', accountRef: fixture.accountRef },
    { force: true },
    {
      fs,
      aiHomeDir: fixture.aiHomeDir,
      fetchWithTimeout: okFetch({
        access_token: 'at_new',
        refresh_token: 'rt_new',
        expires_in: 900
      })
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.refreshed, true);
  // DB 照常推进，但 projection 里更新的 CLI grant 绝不被覆盖
  const stored = readAccountNativeAuth(fs, fixture.aiHomeDir, fixture.accountRef);
  assert.equal(stored.credentials.refresh_token, 'rt_new');
  const projected = readProjectionCredentials(fixture.aiHomeDir, fixture.accountRef);
  assert.equal(projected.refresh_token, 'rt_cli_newer');
  assert.equal(projected.access_token, 'at_cli_newer');
});

test('refreshKimiAccessToken adopts newer host grant via reconcileHostCredentials before refreshing', async (t) => {
  const fixture = createKimiFixture(t, expiredCredentials('rt_old'));
  const capture = {};

  const result = await refreshKimiAccessToken(
    { provider: 'kimi', accountRef: fixture.accountRef },
    { force: true },
    {
      fs,
      aiHomeDir: fixture.aiHomeDir,
      reconcileHostCredentials: (accountRef) => {
        // 模拟 reconciler 吸收了 host 侧更新的凭证并落 DB
        writeAccountNativeAuth(fs, fixture.aiHomeDir, accountRef, {
          credentials: expiredCredentials('rt_host')
        });
        return { ok: true, adopted: true, reason: 'host_credentials_newer' };
      },
      fetchWithTimeout: okFetch({
        access_token: 'at_new',
        refresh_token: 'rt_new',
        expires_in: 900
      }, capture)
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.refreshed, true);
  assert.match(capture.body, /refresh_token=rt_host/);
});

test('refreshKimiAccessToken never creates host ~/.kimi-code from a refresh', async (t) => {
  const fixture = createKimiFixture(t, expiredCredentials('rt_old'));
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kimi-host-'));
  t.after(() => fs.rmSync(hostHomeDir, { recursive: true, force: true }));

  const result = await refreshKimiAccessToken(
    { provider: 'kimi', accountRef: fixture.accountRef },
    { force: true },
    {
      fs,
      aiHomeDir: fixture.aiHomeDir,
      hostHomeDir,
      fetchWithTimeout: okFetch({
        access_token: 'at_new',
        refresh_token: 'rt_new',
        expires_in: 900
      })
    }
  );

  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(path.join(hostHomeDir, '.kimi-code')), false);
});

test('refreshKimiAccessToken updates host credentials when host still holds the consumed grant', async (t) => {
  const fixture = createKimiFixture(t, expiredCredentials('rt_old'));
  const hostHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-kimi-host-'));
  t.after(() => fs.rmSync(hostHomeDir, { recursive: true, force: true }));
  const hostCredentialsDir = path.join(hostHomeDir, '.kimi-code', 'credentials');
  fs.mkdirSync(hostCredentialsDir, { recursive: true });
  fs.writeFileSync(
    path.join(hostCredentialsDir, 'kimi-code.json'),
    `${JSON.stringify(expiredCredentials('rt_old'), null, 2)}\n`
  );

  const result = await refreshKimiAccessToken(
    { provider: 'kimi', accountRef: fixture.accountRef },
    { force: true },
    {
      fs,
      aiHomeDir: fixture.aiHomeDir,
      hostHomeDir,
      fetchWithTimeout: okFetch({
        access_token: 'at_new',
        refresh_token: 'rt_new',
        expires_in: 900
      })
    }
  );

  assert.equal(result.ok, true);
  const hostCredentials = JSON.parse(
    fs.readFileSync(path.join(hostCredentialsDir, 'kimi-code.json'), 'utf8')
  );
  assert.equal(hostCredentials.refresh_token, 'rt_new');
  assert.equal(hostCredentials.access_token, 'at_new');
});

test('refreshKimiAccessToken adopts newer projection grant before refreshing', async (t) => {
  const fixture = createKimiFixture(t, { ...expiredCredentials('rt_old'), user_id: 'user-1' });
  // 模拟 aih 沙箱里的 kimi-code CLI 已自行轮换：projection 文件比 DB 新
  const projectionDir = path.join(
    fixture.aiHomeDir, 'run', 'auth-projections', 'kimi', fixture.accountRef,
    '.kimi-code', 'credentials'
  );
  fs.mkdirSync(projectionDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectionDir, 'kimi-code.json'),
    `${JSON.stringify({ ...expiredCredentials('rt_proj'), user_id: 'user-1' }, null, 2)}\n`
  );
  const capture = {};

  const result = await refreshKimiAccessToken(
    { provider: 'kimi', accountRef: fixture.accountRef },
    { force: true },
    {
      fs,
      aiHomeDir: fixture.aiHomeDir,
      fetchWithTimeout: okFetch({
        access_token: 'at_new',
        refresh_token: 'rt_new',
        expires_in: 900
      }, capture)
    }
  );

  assert.equal(result.ok, true);
  assert.equal(result.refreshed, true);
  // 必须用 projection 里最新的 grant 发起刷新，而不是 DB 里已轮换掉的旧 grant
  assert.match(capture.body, /refresh_token=rt_proj/);
  const stored = readAccountNativeAuth(fs, fixture.aiHomeDir, fixture.accountRef);
  assert.equal(stored.credentials.refresh_token, 'rt_new');
});

test('refreshKimiAccessToken skips refresh when token is not due', async (t) => {
  const fixture = createKimiFixture(t, {
    ...expiredCredentials('rt_old'),
    expires_at: Math.floor(Date.now() / 1000) + 3600
  });
  let fetchCalled = false;

  const result = await refreshKimiAccessToken(
    { provider: 'kimi', accountRef: fixture.accountRef },
    { force: false },
    {
      fs,
      aiHomeDir: fixture.aiHomeDir,
      fetchWithTimeout: async () => {
        fetchCalled = true;
        throw new Error('should_not_call');
      }
    }
  );

  assert.equal(fetchCalled, false);
  assert.equal(result.ok, true);
  assert.equal(result.refreshed, false);
  assert.equal(result.reason, 'not_due');
});
