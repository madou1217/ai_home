const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  stripAnsi,
  parseDeviceCodeExpiryMs,
  parseDeviceCodePollIntervalMs,
  isProcessAlive,
  normalizeAuthMode,
  getDefaultAuthMode,
  extractOAuthChallenge,
  extractBrowserOAuthHints,
  configureApiKeyAccount,
  createAuthJobManager
} = require('../lib/server/web-account-auth');

function makeJwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload || {})).toString('base64url'),
    'sig'
  ].join('.');
}

test('normalizeAuthMode maps aliases to supported auth modes', () => {
  assert.equal(normalizeAuthMode('oauth'), 'oauth-browser');
  assert.equal(normalizeAuthMode('device-code'), 'oauth-device');
  assert.equal(normalizeAuthMode('api_key'), 'api-key');
  assert.equal(normalizeAuthMode('unknown'), '');
});

test('getDefaultAuthMode keeps codex browser oauth as the default login mode', () => {
  assert.equal(getDefaultAuthMode('codex'), 'oauth-browser');
  assert.equal(getDefaultAuthMode('claude'), 'oauth-browser');
  assert.equal(getDefaultAuthMode('gemini'), 'oauth-browser');
});

test('extractOAuthChallenge parses verification url and user code from logs', () => {
  const challenge = extractOAuthChallenge(`
Open this URL in your browser:
https://auth.example.com/activate?user_code=ABCD-EFGH
Then enter device code: ABCD-EFGH
  `);

  assert.equal(challenge.verificationUri, 'https://auth.example.com/activate');
  assert.equal(challenge.verificationUriComplete, 'https://auth.example.com/activate?user_code=ABCD-EFGH');
  assert.equal(challenge.userCode, 'ABCD-EFGH');
});

test('stripAnsi removes terminal color escape sequences', () => {
  assert.equal(stripAnsi('hello \u001b[90mworld\u001b[0m'), 'hello world');
});

test('extractOAuthChallenge ignores ansi sequences embedded in oauth output', () => {
  const challenge = extractOAuthChallenge(`
Welcome to Codex [v\u001b[90m0.118.0\u001b[0m]
\u001b[94mhttps://auth.openai.com/codex/device\u001b[0m
\u001b[94m9YXS-QCQEL\u001b[0m
  `);

  assert.equal(challenge.verificationUri, 'https://auth.openai.com/codex/device');
  assert.equal(challenge.verificationUriComplete, 'https://auth.openai.com/codex/device');
  assert.equal(challenge.userCode, '9YXS-QCQEL');
});

test('extractBrowserOAuthHints parses authorization url and callback state', () => {
  const hints = extractBrowserOAuthHints(`
If your browser did not open:
https://auth.openai.com/oauth/authorize?response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&state=state-123&code_challenge=abc
  `);

  assert.equal(hints.redirectUri, 'http://localhost:1455/auth/callback');
  assert.equal(hints.state, 'state-123');
  assert.match(hints.authorizationUrl, /^https:\/\/auth\.openai\.com\/oauth\/authorize/);
});

test('parseDeviceCodeExpiryMs parses provider-declared device code expiry from output', () => {
  assert.equal(parseDeviceCodeExpiryMs('expires in 15 minutes'), 15 * 60 * 1000);
  assert.equal(parseDeviceCodeExpiryMs('expires in 45 seconds'), 45 * 1000);
  assert.equal(parseDeviceCodeExpiryMs('nothing here'), null);
});

test('parseDeviceCodePollIntervalMs parses provider polling hints when present', () => {
  assert.equal(parseDeviceCodePollIntervalMs('retry in 5 seconds'), 5 * 1000);
  assert.equal(parseDeviceCodePollIntervalMs('poll again in 2 minutes'), 2 * 60 * 1000);
  assert.equal(parseDeviceCodePollIntervalMs('nothing here'), null);
});

test('isProcessAlive uses process kill(0) semantics', () => {
  const fakeProcess = {
    kill(pid, signal) {
      assert.equal(signal, 0);
      if (pid === 123) return;
      const error = new Error('missing');
      error.code = 'ESRCH';
      throw error;
    }
  };

  assert.equal(isProcessAlive(123, fakeProcess), true);
  assert.equal(isProcessAlive(456, fakeProcess), false);
});

test('configureApiKeyAccount writes provider sandbox files without manual login flow', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-auth-'));
  const getProfileDir = (provider, accountId) => path.join(root, provider, String(accountId));
  const getToolConfigDir = (provider, accountId) => path.join(getProfileDir(provider, accountId), `.${provider}`);

  const result = configureApiKeyAccount({
    fs,
    provider: 'codex',
    accountId: '7',
    config: {
      apiKey: 'sk-test-123456',
      baseUrl: 'https://example.com/v1/'
    },
    getProfileDir,
    getToolConfigDir
  });

  const envJson = JSON.parse(fs.readFileSync(path.join(result.profileDir, '.aih_env.json'), 'utf8'));
  const authJson = JSON.parse(fs.readFileSync(path.join(result.configDir, 'auth.json'), 'utf8'));

  assert.equal(envJson.OPENAI_API_KEY, 'sk-test-123456');
  assert.equal(envJson.OPENAI_BASE_URL, 'https://example.com/v1');
  assert.equal(authJson.OPENAI_API_KEY, 'sk-test-123456');
});

test('createAuthJobManager allocates next account id and tracks oauth job progress', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-oauth-job-'));
  const getProfileDir = (provider, accountId) => path.join(root, provider, String(accountId));
  const getToolConfigDir = (provider, accountId) => path.join(getProfileDir(provider, accountId), `.${provider}`);

  let onDataHandler = null;
  let onExitHandler = null;
  let spawnCall = null;
  const finishedJobs = [];

  const manager = createAuthJobManager({
    fs,
    processObj: {
      ...process,
      cwd: () => root,
      env: { ...process.env },
      platform: process.platform
    },
    ptyImpl: {
      spawn(command, args, options) {
        spawnCall = { command, args, options };
        return {
          onData(handler) {
            onDataHandler = handler;
          },
          onExit(handler) {
            onExitHandler = handler;
          }
        };
      }
    },
    resolveCliPathImpl: () => '/usr/local/bin/codex',
    getToolAccountIds: () => ['1', '2'],
    getProfileDir,
    getToolConfigDir,
    onOauthJobFinished: async (job) => {
      finishedJobs.push(job);
    }
  });

  const started = manager.startOauthJob('codex', 'oauth-device');
  assert.equal(started.accountId, '3');
  assert.equal(Array.isArray(spawnCall.args), true);
  assert.equal(spawnCall.args.includes('login'), true);
  assert.equal(spawnCall.args.includes('--device-auth'), true);
  assert.equal(spawnCall.options.env.HOME, getProfileDir('codex', '3'));

  onDataHandler('Visit https://verify.example.com/device and enter code ZXCV-BNM1 (expires in 15 minutes)');
  const runningJob = manager.getJob(started.jobId);
  assert.equal(runningJob.userCode, 'ZXCV-BNM1');
  assert.equal(runningJob.verificationUri, 'https://verify.example.com/device');
  assert.equal(typeof runningJob.expiresAt, 'number');
  assert.equal(runningJob.pollIntervalMs, 5000);

  fs.writeFileSync(path.join(getToolConfigDir('codex', '3'), 'auth.json'), JSON.stringify({
    tokens: {
      access_token: 'new-access-token',
      refresh_token: 'rt_new'
    }
  }));
  onExitHandler({ exitCode: 0 });
  await new Promise((resolve) => setImmediate(resolve));

  const finishedJob = manager.getJob(started.jobId);
  assert.equal(finishedJob.status, 'succeeded');
  assert.equal(finishedJobs.length, 1);
  assert.equal(finishedJobs[0].accountId, '3');
});

test('createAuthJobManager cancelJob releases provider lock for retry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-oauth-cancel-'));
  const getProfileDir = (provider, accountId) => path.join(root, provider, String(accountId));
  const getToolConfigDir = (provider, accountId) => path.join(getProfileDir(provider, accountId), `.${provider}`);

  let onExitHandler = null;
  let killed = false;

  const manager = createAuthJobManager({
    fs,
    processObj: {
      ...process,
      cwd: () => root,
      env: { ...process.env },
      platform: process.platform
    },
    ptyImpl: {
      spawn() {
        return {
          onData() {},
          onExit(handler) {
            onExitHandler = handler;
          },
          kill() {
            killed = true;
          }
        };
      }
    },
    resolveCliPathImpl: () => '/usr/local/bin/gemini',
    getToolAccountIds: () => ['1'],
    getProfileDir,
    getToolConfigDir
  });

  const started = manager.startOauthJob('gemini', 'oauth-browser');
  assert.equal(manager.getRunningJob('gemini')?.id, started.jobId);

  const cancelled = manager.cancelJob(started.jobId);
  assert.equal(cancelled.ok, true);
  assert.equal(killed, true);
  assert.equal(manager.getRunningJob('gemini'), null);
  assert.equal(manager.getJob(started.jobId)?.status, 'cancelled');

  onExitHandler({ exitCode: 130 });
  assert.equal(manager.getJob(started.jobId)?.status, 'cancelled');

  const retried = manager.startOauthJob('gemini', 'oauth-browser');
  assert.notEqual(retried.jobId, started.jobId);
});

test('createAuthJobManager manages codex browser oauth without spawning a local browser', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-oauth-browser-callback-'));
  const getProfileDir = (provider, accountId) => path.join(root, provider, String(accountId));
  const getToolConfigDir = (provider, accountId) => path.join(getProfileDir(provider, accountId), `.${provider}`);

  const fetchCalls = [];
  const manager = createAuthJobManager({
    fs,
    processObj: {
      ...process,
      cwd: () => root,
      env: { ...process.env },
      platform: process.platform,
      kill() {
        return;
      }
    },
    ptyImpl: {
      spawn() {
        throw new Error('codex browser oauth should not spawn cli');
      }
    },
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, body: String(init && init.body || '') });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: 'new-access-token',
          refresh_token: 'rt_new',
          id_token: makeJwt({ email: 'code@example.com' }),
          expires_in: 3600
        })
      };
    },
    resolveCliPathImpl: () => '/usr/local/bin/codex',
    getToolAccountIds: () => [],
    getProfileDir,
    getToolConfigDir,
    onOauthJobFinished: async (job) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      job.logs = `${job.logs}状态同步：runtime reload 完成，账号已进入 codex runtime pool。\n`;
    }
  });

  const started = manager.startOauthJob('codex', 'oauth-browser');
  assert.match(started.authorizationUrl, /^https:\/\/auth\.openai\.com\/oauth\/authorize/);
  assert.match(decodeURIComponent(started.authorizationUrl), /http:\/\/localhost:1455\/auth\/callback/);

  const running = manager.getJob(started.jobId);
  assert.equal(running.redirectUri, 'http://localhost:1455/auth/callback');

  const completed = await manager.completeBrowserOauthCallback(
    started.jobId,
    `${running.redirectUri}?code=ok&state=${running.oauthState}`
  );
  assert.equal(completed.ok, true);
  assert.equal(fetchCalls[0].url, 'https://auth.openai.com/oauth/token');
  const tokenBody = new URLSearchParams(fetchCalls[0].body);
  assert.equal(tokenBody.get('code'), 'ok');
  assert.equal(tokenBody.get('redirect_uri'), running.redirectUri);
  const authJson = JSON.parse(fs.readFileSync(path.join(getToolConfigDir('codex', '1'), 'auth.json'), 'utf8'));
  assert.equal(authJson.tokens.access_token, 'new-access-token');
  assert.equal(authJson.tokens.refresh_token, 'rt_new');
  const finishedJob = manager.getJob(started.jobId);
  assert.equal(finishedJob.status, 'succeeded');
  assert.equal(finishedJob.email, 'code@example.com');
  assert.match(finishedJob.logs, /回调 state 校验通过/);
  assert.match(finishedJob.logs, /auth\.json 已写入/);
  assert.match(finishedJob.logs, /runtime reload 完成/);
});

test('createAuthJobManager rejects codex browser oauth state mismatch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-oauth-state-'));
  const getProfileDir = (provider, accountId) => path.join(root, provider, String(accountId));
  const getToolConfigDir = (provider, accountId) => path.join(getProfileDir(provider, accountId), `.${provider}`);
  let fetchCalled = false;

  const manager = createAuthJobManager({
    fs,
    processObj: {
      ...process,
      cwd: () => root,
      env: { ...process.env },
      platform: process.platform
    },
    ptyImpl: {
      spawn() {
        throw new Error('codex browser oauth should not spawn cli');
      }
    },
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error('unexpected token exchange');
    },
    resolveCliPathImpl: () => '/usr/local/bin/codex',
    getToolAccountIds: () => [],
    getProfileDir,
    getToolConfigDir
  });

  const started = manager.startOauthJob('codex', 'oauth-browser');
  const running = manager.getJob(started.jobId);
  const result = await manager.completeBrowserOauthCallback(
    started.jobId,
    `${running.redirectUri}?code=ok&state=wrong`
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_callback_state');
  assert.equal(fetchCalled, false);
});

test('createAuthJobManager rejects codex token exchange without usable refresh token', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-oauth-refresh-'));
  const getProfileDir = (provider, accountId) => path.join(root, provider, String(accountId));
  const getToolConfigDir = (provider, accountId) => path.join(getProfileDir(provider, accountId), `.${provider}`);

  const manager = createAuthJobManager({
    fs,
    processObj: {
      ...process,
      cwd: () => root,
      env: { ...process.env },
      platform: process.platform
    },
    ptyImpl: {
      spawn() {
        throw new Error('codex browser oauth should not spawn cli');
      }
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        access_token: 'new-access-token',
        refresh_token: 'not-rt-token',
        id_token: '',
        expires_in: 3600
      })
    }),
    resolveCliPathImpl: () => '/usr/local/bin/codex',
    getToolAccountIds: () => [],
    getProfileDir,
    getToolConfigDir
  });

  const started = manager.startOauthJob('codex', 'oauth-browser');
  const running = manager.getJob(started.jobId);
  const result = await manager.completeBrowserOauthCallback(
    started.jobId,
    `${running.redirectUri}?code=ok&state=${running.oauthState}`
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'token_exchange_unusable_refresh_token');
  const job = manager.getJob(started.jobId);
  assert.equal(job.status, 'failed');
  assert.match(job.logs, /refresh_token 不符合/);
});

test('createAuthJobManager fails codex oauth when completion verifier rejects written auth', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-oauth-verify-'));
  const getProfileDir = (provider, accountId) => path.join(root, provider, String(accountId));
  const getToolConfigDir = (provider, accountId) => path.join(getProfileDir(provider, accountId), `.${provider}`);

  const manager = createAuthJobManager({
    fs,
    processObj: {
      ...process,
      cwd: () => root,
      env: { ...process.env },
      platform: process.platform
    },
    ptyImpl: {
      spawn() {
        throw new Error('codex browser oauth should not spawn cli');
      }
    },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        access_token: 'new-access-token',
        refresh_token: 'rt_new',
        id_token: '',
        expires_in: 3600
      })
    }),
    verifyOauthJobCompleted: async () => ({
      ok: false,
      message: 'auth.json written but account is not configured'
    }),
    resolveCliPathImpl: () => '/usr/local/bin/codex',
    getToolAccountIds: () => [],
    getProfileDir,
    getToolConfigDir
  });

  const started = manager.startOauthJob('codex', 'oauth-browser');
  const running = manager.getJob(started.jobId);
  const result = await manager.completeBrowserOauthCallback(
    started.jobId,
    `${running.redirectUri}?code=ok&state=${running.oauthState}`
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'oauth_completion_verification_failed');
  const job = manager.getJob(started.jobId);
  assert.equal(job.status, 'failed');
  assert.match(job.logs, /账号状态识别失败/);
});

test('createAuthJobManager marks device auth job expired based on provider output expiry', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-oauth-expire-'));
  const getProfileDir = (provider, accountId) => path.join(root, provider, String(accountId));
  const getToolConfigDir = (provider, accountId) => path.join(getProfileDir(provider, accountId), `.${provider}`);

  let onDataHandler = null;
  let killed = false;
  let now = 1_700_000_000_000;

  const manager = createAuthJobManager({
    fs,
    processObj: {
      ...process,
      cwd: () => root,
      env: { ...process.env },
      platform: process.platform,
      kill() {
        return;
      }
    },
    ptyImpl: {
      spawn() {
        return {
          pid: 999,
          onData(handler) {
            onDataHandler = handler;
          },
          onExit() {},
          kill() {
            killed = true;
          }
        };
      }
    },
    resolveCliPathImpl: () => '/usr/local/bin/codex',
    getToolAccountIds: () => ['1'],
    getProfileDir,
    getToolConfigDir
  });

  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const started = manager.startOauthJob('codex', 'oauth-device');
    onDataHandler('Enter this one-time code (expires in 15 minutes)');
    const activeJob = manager.getJob(started.jobId);
    assert.equal(activeJob.status, 'running');
    now += 15 * 60 * 1000 + 1;
    const expiredJob = manager.getJob(started.jobId);
    assert.equal(expiredJob.status, 'expired');
    assert.equal(killed, true);
  } finally {
    Date.now = originalNow;
  }
});

test('createAuthJobManager marks claude oauth job succeeded when credentials file appears', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-oauth-claude-complete-'));
  const getProfileDir = (provider, accountId) => path.join(root, provider, String(accountId));
  const getToolConfigDir = (provider, accountId) => path.join(getProfileDir(provider, accountId), `.${provider}`);

  const manager = createAuthJobManager({
    fs,
    processObj: {
      ...process,
      cwd: () => root,
      env: { ...process.env },
      platform: process.platform,
      kill() {
        return;
      }
    },
    ptyImpl: {
      spawn() {
        return {
          pid: 2001,
          onData() {},
          onExit() {},
          kill() {}
        };
      }
    },
    resolveCliPathImpl: () => '/usr/local/bin/claude',
    getToolAccountIds: () => ['1'],
    getProfileDir,
    getToolConfigDir
  });

  const started = manager.startOauthJob('claude', 'oauth-browser');
  const credentialsPath = path.join(getToolConfigDir('claude', started.accountId), '.credentials.json');
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
  fs.writeFileSync(credentialsPath, JSON.stringify({
    claudeAiOauth: {
      accessToken: 'claude-access-token'
    }
  }));

  const job = manager.getJob(started.jobId);
  assert.equal(job.status, 'succeeded');
});

test('createAuthJobManager preserves succeeded status after oauth artifact completion triggers onExit', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-oauth-claude-exit-'));
  const getProfileDir = (provider, accountId) => path.join(root, provider, String(accountId));
  const getToolConfigDir = (provider, accountId) => path.join(getProfileDir(provider, accountId), `.${provider}`);

  let onExitHandler = null;
  const finishedJobs = [];
  const manager = createAuthJobManager({
    fs,
    processObj: {
      ...process,
      cwd: () => root,
      env: { ...process.env },
      platform: process.platform,
      kill() {
        return;
      }
    },
    ptyImpl: {
      spawn() {
        return {
          pid: 2101,
          onData() {},
          onExit(handler) {
            onExitHandler = handler;
          },
          kill() {}
        };
      }
    },
    resolveCliPathImpl: () => '/usr/local/bin/claude',
    getToolAccountIds: () => ['1'],
    getProfileDir,
    getToolConfigDir,
    onOauthJobFinished: async (job) => {
      finishedJobs.push(job);
    }
  });

  const started = manager.startOauthJob('claude', 'oauth-browser');
  const credentialsPath = path.join(getToolConfigDir('claude', started.accountId), '.credentials.json');
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
  fs.writeFileSync(credentialsPath, JSON.stringify({
    claudeAiOauth: {
      accessToken: 'claude-access-token'
    }
  }));

  assert.equal(manager.getJob(started.jobId).status, 'succeeded');
  onExitHandler({ exitCode: 0 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(manager.getJob(started.jobId).status, 'succeeded');
  assert.equal(finishedJobs.length, 1);
});

test('createAuthJobManager reauth requires fresh oauth artifacts instead of reusing old codex auth file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-oauth-codex-reauth-'));
  const getProfileDir = (provider, accountId) => path.join(root, provider, String(accountId));
  const getToolConfigDir = (provider, accountId) => path.join(getProfileDir(provider, accountId), `.${provider}`);
  const configDir = getToolConfigDir('codex', '9');
  fs.mkdirSync(configDir, { recursive: true });
  const authPath = path.join(configDir, 'auth.json');
  fs.writeFileSync(authPath, JSON.stringify({
    tokens: {
      access_token: 'old-access-token',
      refresh_token: 'rt_old'
    }
  }));

  const fetchCalls = [];
  const manager = createAuthJobManager({
    fs,
    processObj: {
      ...process,
      cwd: () => root,
      env: { ...process.env },
      platform: process.platform,
      kill() {
        return;
      }
    },
    ptyImpl: {
      spawn() {
        throw new Error('codex browser oauth should not spawn cli');
      }
    },
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, body: String(init && init.body || '') });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: 'new-access-token',
          refresh_token: 'rt_new',
          id_token: '',
          expires_in: 3600
        })
      };
    },
    resolveCliPathImpl: () => '/usr/local/bin/codex',
    getToolAccountIds: () => ['9'],
    getProfileDir,
    getToolConfigDir
  });

  const started = manager.startOauthJob('codex', 'oauth-browser', { accountId: '9' });
  const running = manager.getJob(started.jobId);
  assert.equal(running.status, 'running');
  assert.equal(fetchCalls.length, 0);

  const completed = await manager.completeBrowserOauthCallback(
    started.jobId,
    `${running.redirectUri}?code=ok&state=${running.oauthState}`
  );
  assert.equal(completed.ok, true);
  const succeededJob = manager.getJob(started.jobId);
  assert.equal(succeededJob.status, 'succeeded');
  const authJson = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  assert.equal(authJson.tokens.access_token, 'new-access-token');
});

test('createAuthJobManager marks gemini oauth job succeeded when oauth_creds file appears', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-oauth-gemini-complete-'));
  const getProfileDir = (provider, accountId) => path.join(root, provider, String(accountId));
  const getToolConfigDir = (provider, accountId) => path.join(getProfileDir(provider, accountId), `.${provider}`);

  const manager = createAuthJobManager({
    fs,
    processObj: {
      ...process,
      cwd: () => root,
      env: { ...process.env },
      platform: process.platform,
      kill() {
        return;
      }
    },
    ptyImpl: {
      spawn() {
        return {
          pid: 2002,
          onData() {},
          onExit() {},
          kill() {}
        };
      }
    },
    resolveCliPathImpl: () => '/usr/local/bin/gemini',
    getToolAccountIds: () => ['1'],
    getProfileDir,
    getToolConfigDir
  });

  const started = manager.startOauthJob('gemini', 'oauth-browser');
  const oauthPath = path.join(getToolConfigDir('gemini', started.accountId), 'oauth_creds.json');
  fs.mkdirSync(path.dirname(oauthPath), { recursive: true });
  fs.writeFileSync(oauthPath, JSON.stringify({
    access_token: 'gemini-access-token'
  }));

  const job = manager.getJob(started.jobId);
  assert.equal(job.status, 'succeeded');
});

test('createAuthJobManager preserves expired status after device auth expiry triggers onExit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-oauth-expire-exit-'));
  const getProfileDir = (provider, accountId) => path.join(root, provider, String(accountId));
  const getToolConfigDir = (provider, accountId) => path.join(getProfileDir(provider, accountId), `.${provider}`);

  let onDataHandler = null;
  let onExitHandler = null;
  let now = 1_700_000_000_000;

  const manager = createAuthJobManager({
    fs,
    processObj: {
      ...process,
      cwd: () => root,
      env: { ...process.env },
      platform: process.platform,
      kill() {
        return;
      }
    },
    ptyImpl: {
      spawn() {
        return {
          pid: 2102,
          onData(handler) {
            onDataHandler = handler;
          },
          onExit(handler) {
            onExitHandler = handler;
          },
          kill() {}
        };
      }
    },
    resolveCliPathImpl: () => '/usr/local/bin/codex',
    getToolAccountIds: () => ['1'],
    getProfileDir,
    getToolConfigDir
  });

  const originalNow = Date.now;
  Date.now = () => now;
  try {
    const started = manager.startOauthJob('codex', 'oauth-device');
    onDataHandler('Enter this one-time code (expires in 15 minutes)');
    now += 15 * 60 * 1000 + 1;
    assert.equal(manager.getJob(started.jobId).status, 'expired');
    onExitHandler({ exitCode: 130 });
    assert.equal(manager.getJob(started.jobId).status, 'expired');
  } finally {
    Date.now = originalNow;
  }
});
