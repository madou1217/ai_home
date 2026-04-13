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
  extractOAuthChallenge,
  configureApiKeyAccount,
  createAuthJobManager
} = require('../lib/server/web-account-auth');

test('normalizeAuthMode maps aliases to supported auth modes', () => {
  assert.equal(normalizeAuthMode('oauth'), 'oauth-browser');
  assert.equal(normalizeAuthMode('device-code'), 'oauth-device');
  assert.equal(normalizeAuthMode('api_key'), 'api-key');
  assert.equal(normalizeAuthMode('unknown'), '');
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
    resolveCliPathImpl: () => '/usr/local/bin/codex',
    getToolAccountIds: () => ['1'],
    getProfileDir,
    getToolConfigDir
  });

  const started = manager.startOauthJob('codex', 'oauth-browser');
  assert.equal(manager.getRunningJob('codex')?.id, started.jobId);

  const cancelled = manager.cancelJob(started.jobId);
  assert.equal(cancelled.ok, true);
  assert.equal(killed, true);
  assert.equal(manager.getRunningJob('codex'), null);
  assert.equal(manager.getJob(started.jobId)?.status, 'cancelled');

  onExitHandler({ exitCode: 130 });
  assert.equal(manager.getJob(started.jobId)?.status, 'cancelled');

  const retried = manager.startOauthJob('codex', 'oauth-browser');
  assert.notEqual(retried.jobId, started.jobId);
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

test('createAuthJobManager reauth requires fresh oauth artifacts instead of reusing old codex auth file', () => {
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

  let onExitHandler = null;
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
          pid: 2201,
          onData() {},
          onExit(handler) {
            onExitHandler = handler;
          },
          kill() {}
        };
      }
    },
    resolveCliPathImpl: () => '/usr/local/bin/codex',
    getToolAccountIds: () => ['9'],
    getProfileDir,
    getToolConfigDir
  });

  const started = manager.startOauthJob('codex', 'oauth-browser', { accountId: '9' });
  assert.equal(manager.getJob(started.jobId).status, 'running');

  onExitHandler({ exitCode: 0 });
  const failedJob = manager.getJob(started.jobId);
  assert.equal(failedJob.status, 'failed');
  assert.match(String(failedJob.error || ''), /未检测到新的授权结果/);

  const restarted = manager.startOauthJob('codex', 'oauth-browser', { accountId: '9' });
  fs.writeFileSync(authPath, JSON.stringify({
    tokens: {
      access_token: 'new-access-token',
      refresh_token: 'rt_new'
    }
  }));
  const succeededJob = manager.getJob(restarted.jobId);
  assert.equal(succeededJob.status, 'succeeded');
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
