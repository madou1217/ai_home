const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  stripAnsi,
  parseDeviceCodeExpiryMs,
  parseDeviceCodePollIntervalMs,
  isProcessAlive,
  normalizeAuthMode,
  getDefaultAuthMode,
  isSupportedAuthMode,
  extractOAuthChallenge,
  extractBrowserOAuthHints,
  configureApiKeyAccount,
  serializeAuthJob,
  createAuthJobManager: createAuthJobManagerImpl
} = require('../lib/server/web-account-auth');

test('Kimi WebUI auth contract supports browser OAuth and API keys', () => {
  assert.equal(getDefaultAuthMode('kimi'), 'oauth-browser');
  assert.equal(isSupportedAuthMode('kimi', 'oauth-browser'), true);
  assert.equal(isSupportedAuthMode('kimi', 'api-key'), true);
  assert.equal(isSupportedAuthMode('kimi', 'oauth-device'), false);
});

test('Kiro WebUI auth contract supports browser OAuth', () => {
  assert.equal(getDefaultAuthMode('kiro'), 'oauth-browser');
  assert.equal(isSupportedAuthMode('kiro', 'oauth-browser'), true);
  assert.equal(isSupportedAuthMode('kiro', 'api-key'), false);
});
const {
  readAccountCredentials,
  readAccountNativeAuth,
  writeAccountNativeAuth
} = require('../lib/server/account-credential-store');
const { registerAccountIdentity } = require('../lib/account/account-registration');
const { getPublicAccountRef } = require('../lib/account/public-account-ref');
const {
  OAUTH_PENDING_FALLBACK_STALE_MS,
  resolveOauthJobDeadline
} = require('../lib/server/oauth-pending-state');

function createAuthJobManager(options = {}) {
  const aiHomeDir = String(
    options.aiHomeDir
    || (options.processObj && typeof options.processObj.cwd === 'function' ? options.processObj.cwd() : '')
  ).trim();
  if (!aiHomeDir) throw new Error('test_auth_manager_missing_ai_home_dir');
  return createAuthJobManagerImpl({ ...options, aiHomeDir });
}

// Windows buildPtyLaunch wraps extensionless bins as:
//   cmd.exe /d /s /c "chcp 65001>nul & \"/path/bin\" arg1 arg2"
// Assert against the flattened command line so tests stay platform-agnostic.
function launchCommandLine(spawnCall) {
  if (!spawnCall) return '';
  return `${String(spawnCall.command || '')} ${(Array.isArray(spawnCall.args) ? spawnCall.args : []).join(' ')}`;
}

function assertLaunchIncludes(spawnCall, ...needles) {
  const blob = launchCommandLine(spawnCall);
  needles.forEach((needle) => {
    assert.match(blob, needle instanceof RegExp ? needle : new RegExp(String(needle).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
}

function makeJwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload || {})).toString('base64url'),
    'sig'
  ].join('.');
}

function createLoopbackCallbackStub(calls = []) {
  return (options) => {
    const record = {
      options,
      closed: false
    };
    calls.push(record);
    if (typeof options.onListening === 'function') {
      setImmediate(() => options.onListening({ url: options.redirectUri }));
    }
    return {
      close() {
        record.closed = true;
      }
    };
  };
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
  assert.equal(getDefaultAuthMode('agy'), 'oauth-browser');
  assert.equal(getDefaultAuthMode('opencode'), 'oauth-browser');
});

test('server auth wiring and CLI help do not require node-pty at module load', () => {
  const script = `
const Module = require('node:module');
const fs = require('node:fs');
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'node-pty') throw new Error('node-pty blocked');
  return originalLoad.call(this, request, parent, isMain);
};
const auth = require('./lib/server/web-account-auth');
auth.createAuthJobManager({
  fs,
  getToolAccountIds: () => [],
  getProfileDir: () => '',
  getToolConfigDir: () => ''
});
process.argv = [process.execPath, 'bin/ai-home.js', '--help'];
require('./bin/ai-home.js');
`;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Usage:/);
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

test('stripAnsi fully removes kitty keyboard protocol sequences from modern CLIs', () => {
  // Newer Claude/Codex CLIs push/pop/query the Kitty keyboard protocol on startup.
  // The "<=>" private prefix and `u` final byte must not leak fragments like "1u".
  assert.equal(stripAnsi('\u001b[>1u'), '');
  assert.equal(stripAnsi('\u001b[<u'), '');
  assert.equal(stripAnsi('\u001b[=1;2u'), '');
  assert.equal(stripAnsi('\u001b[?u'), '');
  assert.equal(
    stripAnsi('\u001b[>1u\u001b[1m\u001b[4mWelcome to Claude Code v2.1.158\u001b[0m'),
    'Welcome to Claude Code v2.1.158'
  );
});

test('stripAnsi unwraps OSC 8 hyperlinks so the wrapped url survives as plain text', () => {
  const url = 'https://claude.ai/oauth/authorize?code=true&state=abc';
  // OSC 8 form: ESC ]8;;URI ST  LABEL  ESC ]8;; ST  (ST = ESC backslash)
  const wrapped = `\u001b]8;;${url}\u001b\\Claude.ai\u001b]8;;\u001b\\`;
  const stripped = stripAnsi(wrapped);
  assert.ok(stripped.includes(url), 'url should remain in stripped text');
  assert.ok(!stripped.includes('\u001b'), 'no escape bytes should remain');
  assert.ok(!stripped.includes(']8;'), 'no OSC wrapper should remain');
});

test('extractBrowserOAuthHints extracts a clean url and state from an OSC 8 hyperlink', () => {
  const expected = 'https://claude.ai/oauth/authorize?response_type=code'
    + '&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback'
    + '&code_challenge=xyz&state=mystate';
  const hints = extractBrowserOAuthHints(
    'Open this link:\n'
    + `\u001b]8;;${expected}\u001b\\Claude.ai\u001b]8;;\u001b\\\n`
  );

  assert.equal(hints.authorizationUrl, expected);
  assert.equal(hints.redirectUri, 'https://console.anthropic.com/oauth/code/callback');
  assert.equal(hints.state, 'mystate');
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

test('extractBrowserOAuthHints rejoins terminal-wrapped authorization urls', () => {
  const hints = extractBrowserOAuthHints(`
Open this link in the browser:
 https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1071006060591-tmhssin2h21lcre235vtolojh4g403ep
 .apps.googleusercontent.com&code_challenge=abc123&code_challenge_method=S256&prom
 pt=consent&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&state=agy-state

If you aren't automatically redirected, paste the authorization code below:
  `);

  assert.match(hints.authorizationUrl, /^https:\/\/accounts\.google\.com\/o\/oauth2\/auth/);
  assert.match(hints.authorizationUrl, /1071006060591-tmhssin2h21lcre235vtolojh4g403ep\.apps\.googleusercontent\.com/);
  assert.equal(hints.redirectUri, 'https://antigravity.google/oauth-callback');
  assert.equal(hints.state, 'agy-state');
});

test('extractBrowserOAuthHints rejoins urls wrapped with CR CR LF (claude setup-token)', () => {
  // Claude's setup-token output wraps the URL with "\r\r\n" between SGR-colored
  // segments; after stripAnsi the CRs remain and must not break the rejoin.
  const hints = extractBrowserOAuthHints(
    'Browser didn\'t open? Use the url below to sign in (c to copy)\r\r\n'
    + 'https://claude.com/cai/oauth/authorize?code=true&client_id=abc&response_type=code&redir\r\r\n'
    + 'ect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=xyz\r\r\n'
    + '&code_challenge_method=S256&state=claude-state\r\r\n'
  );

  assert.match(hints.authorizationUrl, /^https:\/\/claude\.com\/cai\/oauth\/authorize/);
  assert.match(hints.authorizationUrl, /redirect_uri=https%3A%2F%2Fplatform\.claude\.com/);
  assert.equal(hints.redirectUri, 'https://platform.claude.com/oauth/code/callback');
  assert.equal(hints.state, 'claude-state');
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

test('configureApiKeyAccount writes provider credentials to DB without profile files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-auth-'));

  const result = configureApiKeyAccount({
    fs,
    provider: 'codex',
    aiHomeDir: root,
    config: {
      apiKey: 'sk-test-123456',
      baseUrl: 'https://example.com/v1/'
    }
  });

  const envJson = readAccountCredentials(fs, root, result.accountRef);

  assert.match(result.accountRef, /^acct_[a-f0-9]{20}$/);
  assert.equal(envJson.OPENAI_API_KEY, 'sk-test-123456');
  assert.equal(envJson.OPENAI_BASE_URL, 'https://example.com/v1');
  assert.equal(fs.existsSync(path.join(root, 'profiles')), false);
});

test('configureApiKeyAccount writes Claude auth-token credentials to DB', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-account-auth-token-'));

  const result = configureApiKeyAccount({
    fs,
    provider: 'claude',
    aiHomeDir: root,
    config: {
      apiKey: 'sk-auth-token',
      baseUrl: 'https://anyrouter.top',
      credentialType: 'auth-token'
    }
  });

  const envJson = readAccountCredentials(fs, root, result.accountRef);

  assert.equal(envJson.AIH_CLAUDE_CREDENTIAL_TYPE, 'auth-token');
  assert.equal(envJson.ANTHROPIC_AUTH_TOKEN, 'sk-auth-token');
  assert.equal(envJson.ANTHROPIC_BASE_URL, 'https://anyrouter.top');
  assert.equal(Object.prototype.hasOwnProperty.call(envJson, 'ANTHROPIC_API_KEY'), false);
});

test('createAuthJobManager uses a login runtime and exposes accountRef after OAuth', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-oauth-job-'));
  const getProfileDir = (provider, accountId) => path.join(root, provider, String(accountId));
  const getToolConfigDir = (provider, accountId) => path.join(getProfileDir(provider, accountId), `.${provider}`);

  let onDataHandler = null;
  let onExitHandler = null;
  let spawnCall = null;
  const finishedJobs = [];

  const manager = createAuthJobManager({
    fs,
    aiHomeDir: path.join(root, '.ai_home'),
    processObj: {
      ...process,
      cwd: () => root,
      env: { ...process.env, HOME: root, USERPROFILE: root },
      platform: process.platform,
      kill() {
        return true;
      }
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
  assert.equal(Object.hasOwn(started, 'accountId'), false);
  assert.equal(Array.isArray(spawnCall.args), true);
  assertLaunchIncludes(spawnCall, /codex/i, /\blogin\b/, /--device-auth/);
  assert.equal(spawnCall.options.env.HOME, root);
  assert.equal(spawnCall.options.env.USERPROFILE, root);
  assert.equal(spawnCall.options.env.CODEX_SQLITE_HOME, path.join(root, '.codex'));
  const runningJob = manager.getJob(started.jobId);
  assert.equal(spawnCall.options.env.CODEX_HOME, runningJob.configDir);

  onDataHandler('Visit https://verify.example.com/device and enter code ZXCV-BNM1 (expires in 15 minutes)');
  assert.equal(runningJob.userCode, 'ZXCV-BNM1');
  assert.equal(runningJob.verificationUri, 'https://verify.example.com/device');
  assert.equal(typeof runningJob.expiresAt, 'number');
  assert.equal(runningJob.pollIntervalMs, 5000);

  fs.writeFileSync(path.join(runningJob.configDir, 'auth.json'), JSON.stringify({
    tokens: {
      access_token: makeJwt({
        'https://api.openai.com/profile': { email: 'device@example.com' }
      }),
      refresh_token: 'rt_new',
      account_id: 'upstream-device-account'
    }
  }));
  onExitHandler({ exitCode: 0 });
  await new Promise((resolve) => setImmediate(resolve));

  const finishedJob = manager.getJob(started.jobId);
  assert.equal(finishedJob.status, 'succeeded');
  assert.match(finishedJob.accountRef, /^acct_[a-f0-9]{20}$/);
  assert.equal(Object.hasOwn(finishedJob, 'accountId'), false);
  assert.equal(finishedJobs.length, 1);
  assert.equal(finishedJobs[0].accountRef, finishedJob.accountRef);
});

test('createAuthJobManager starts opencode login with shared home and account auth data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-oauth-opencode-'));
  try {
    const getProfileDir = (provider, accountId) => path.join(root, '.ai_home', 'profiles', provider, String(accountId));
    const getToolConfigDir = (provider, accountId) => path.join(getProfileDir(provider, accountId), '.config', provider);
    let spawnCall = null;

    const manager = createAuthJobManager({
      fs,
      processObj: {
        ...process,
        cwd: () => root,
        env: {
          ...process.env,
          HOME: root,
          USERPROFILE: root,
          OPENCODE_CONFIG: '/tmp/leaked-opencode.json',
          OPENCODE_CONFIG_DIR: '/tmp/leaked-opencode',
          OPENCODE_API_KEY: 'sk-leaked'
        },
        platform: process.platform,
        kill() {
          return true;
        }
      },
      ptyImpl: {
        spawn(command, args, options) {
          spawnCall = { command, args, options };
          return {
            pid: 4901,
            onData() {},
            onExit() {},
            kill() {}
          };
        }
      },
      resolveCliPathImpl: () => '/usr/local/bin/opencode',
      getToolAccountIds: () => [],
      getProfileDir,
      getToolConfigDir
    });

    const started = manager.startOauthJob('opencode', 'oauth-browser');
    const profileDir = manager.getJob(started.jobId).runtimeDir;
    const accountAuthDir = path.join(profileDir, '.local', 'share', 'opencode');
    const bridgeDataDir = path.join(profileDir, '.local', 'share', 'aih-opencode-runtime', 'opencode');
    const sharedDataDir = path.join(root, '.local', 'share', 'opencode');

    assertLaunchIncludes(spawnCall, /opencode/, /\bauth\b/, /\blogin\b/);
    assert.equal(spawnCall.options.env.HOME, root);
    assert.equal(spawnCall.options.env.USERPROFILE, root);
    assert.equal(spawnCall.options.env.XDG_CONFIG_HOME, path.join(root, '.config'));
    assert.equal(spawnCall.options.env.XDG_DATA_HOME, path.join(profileDir, '.local', 'share', 'aih-opencode-runtime'));
    assert.equal(spawnCall.options.env.XDG_STATE_HOME, path.join(root, '.local', 'state'));
    assert.equal(spawnCall.options.env.XDG_CACHE_HOME, path.join(root, '.cache'));
    assert.equal(Object.prototype.hasOwnProperty.call(spawnCall.options.env, 'OPENCODE_CONFIG'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(spawnCall.options.env, 'OPENCODE_CONFIG_DIR'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(spawnCall.options.env, 'OPENCODE_API_KEY'), false);
    assert.equal(fs.lstatSync(path.join(bridgeDataDir, 'auth.json')).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(path.join(bridgeDataDir, 'auth.json')), path.join(accountAuthDir, 'auth.json'));
    assert.equal(fs.lstatSync(path.join(bridgeDataDir, 'storage')).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(path.join(bridgeDataDir, 'storage')), path.join(sharedDataDir, 'storage'));
    assert.equal(fs.existsSync(path.join(profileDir, '.opencode')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('createAuthJobManager notifies auth job changes for live watchers', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-oauth-job-events-'));
  const getProfileDir = (provider, accountId) => path.join(root, provider, String(accountId));
  const getToolConfigDir = (provider, accountId) => path.join(getProfileDir(provider, accountId), `.${provider}`);

  let onDataHandler = null;
  let onExitHandler = null;
  const events = [];

  const manager = createAuthJobManager({
    fs,
    processObj: {
      ...process,
      cwd: () => root,
      env: { ...process.env },
      platform: process.platform,
      kill() {
        return true;
      }
    },
    ptyImpl: {
      spawn() {
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
    getToolAccountIds: () => ['1'],
    getProfileDir,
    getToolConfigDir,
    onJobChanged(job) {
      events.push(serializeAuthJob(job));
    }
  });

  const started = manager.startOauthJob('codex', 'oauth-device');
  const runningJob = manager.getJob(started.jobId);
  onDataHandler('Visit https://verify.example.com/device and enter code LIVE-1234');
  fs.writeFileSync(path.join(runningJob.configDir, 'auth.json'), JSON.stringify({
    tokens: {
      access_token: makeJwt({
        'https://api.openai.com/profile': { email: 'live@example.com' }
      }),
      refresh_token: 'rt_new',
      account_id: 'upstream-live-account'
    }
  }));
  onExitHandler({ exitCode: 0 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(events.some((job) => job.id === started.jobId && job.status === 'running'), true);
  assert.equal(events.some((job) => job.id === started.jobId && job.userCode === 'LIVE-1234'), true);
  assert.equal(events.some((job) => job.id === started.jobId && job.status === 'succeeded'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(events[0], '_ptyProcess'), false);
});

test('createAuthJobManager expires stale browser oauth jobs without provider signal', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-oauth-stale-browser-'));
  const getProfileDir = (provider, accountId) => path.join(root, provider, String(accountId));
  const getToolConfigDir = (provider, accountId) => path.join(getProfileDir(provider, accountId), `.${provider}`);
  let killed = false;

  const manager = createAuthJobManager({
    fs,
    processObj: {
      ...process,
      cwd: () => root,
      env: { ...process.env },
      platform: process.platform,
      kill() {
        return true;
      }
    },
    ptyImpl: {
      spawn() {
        return {
          pid: 12345,
          onData() {},
          onExit() {},
          kill() {
            killed = true;
          }
        };
      }
    },
    resolveCliPathImpl: () => '/usr/local/bin/claude',
    getToolAccountIds: () => [],
    getProfileDir,
    getToolConfigDir
  });

  // gemini still spawns a CLI for browser oauth (no native loopback), so its job
  // starts without a provider-declared expiry and relies on the staleness fallback.
  const started = manager.startOauthJob('gemini', 'oauth-browser');
  const running = manager.getJob(started.jobId);
  assert.equal(running.status, 'running');
  assert.equal(running.expiresAt, null);

  running.createdAt = Date.now() - OAUTH_PENDING_FALLBACK_STALE_MS - 1000;
  running.expiresAt = 0;
  const expired = manager.getJob(started.jobId);

  assert.equal(expired.status, 'expired');
  assert.equal(expired.authProgressState, 'expired');
  assert.match(expired.error, /OAuth 授权已超时/);
  assert.equal(killed, true);
  assert.equal(manager.getRunningJob('gemini'), null);
});

test('resolveOauthJobDeadline prefers provider expiresAt over fallback age', () => {
  const now = Date.now();
  assert.equal(
    resolveOauthJobDeadline({
      createdAt: now - OAUTH_PENDING_FALLBACK_STALE_MS - 1000,
      expiresAt: now + 60_000
    }),
    now + 60_000
  );
  assert.equal(
    resolveOauthJobDeadline({
      createdAt: now,
      expiresAt: 0
    }),
    now + OAUTH_PENDING_FALLBACK_STALE_MS
  );
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
  const loopbackCalls = [];
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
    startLoopbackCallbackServerImpl: createLoopbackCallbackStub(loopbackCalls),
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
  assert.equal(running.callbackCaptureStatus, 'starting');
  assert.equal(loopbackCalls.length, 1);

  const completed = await manager.completeBrowserOauthCallback(
    started.jobId,
    `${running.redirectUri}?code=ok&state=${running.oauthState}`
  );
  assert.equal(completed.ok, true);
  assert.equal(fetchCalls[0].url, 'https://auth.openai.com/oauth/token');
  const tokenBody = new URLSearchParams(fetchCalls[0].body);
  assert.equal(tokenBody.get('code'), 'ok');
  assert.equal(tokenBody.get('redirect_uri'), running.redirectUri);
  const authJson = JSON.parse(fs.readFileSync(path.join(running.configDir, 'auth.json'), 'utf8'));
  assert.equal(authJson.tokens.access_token, 'new-access-token');
  assert.equal(authJson.tokens.refresh_token, 'rt_new');
  const finishedJob = manager.getJob(started.jobId);
  assert.equal(finishedJob.status, 'succeeded');
  assert.equal(loopbackCalls[0].closed, true);
  assert.equal(finishedJob.email, 'code@example.com');
  assert.match(finishedJob.logs, /回调 state 校验通过/);
  assert.match(finishedJob.logs, /auth\.json 已写入/);
  assert.match(finishedJob.logs, /runtime reload 完成/);
});

test('createAuthJobManager auto-completes codex browser oauth from loopback callback', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-oauth-loopback-auto-'));
  const getProfileDir = (provider, accountId) => path.join(root, provider, String(accountId));
  const getToolConfigDir = (provider, accountId) => path.join(getProfileDir(provider, accountId), `.${provider}`);

  const fetchCalls = [];
  const loopbackCalls = [];
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
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, body: String(init && init.body || '') });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: 'new-access-token',
          refresh_token: 'rt_new',
          id_token: makeJwt({ email: 'loopback@example.com' }),
          expires_in: 3600
        })
      };
    },
    startLoopbackCallbackServerImpl: createLoopbackCallbackStub(loopbackCalls),
    resolveCliPathImpl: () => '/usr/local/bin/codex',
    getToolAccountIds: () => [],
    getProfileDir,
    getToolConfigDir
  });

  const started = manager.startOauthJob('codex', 'oauth-browser');
  const running = manager.getJob(started.jobId);
  const result = await loopbackCalls[0].options.onCallback(`${running.redirectUri}?code=loopback&state=${running.oauthState}`);

  assert.equal(result.ok, true);
  const tokenBody = new URLSearchParams(fetchCalls[0].body);
  assert.equal(tokenBody.get('code'), 'loopback');
  assert.equal(manager.getJob(started.jobId).status, 'succeeded');
  assert.equal(loopbackCalls[0].closed, true);
});

test('createAuthJobManager keeps manual callback fallback when loopback callback server is unavailable', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-oauth-loopback-unavailable-'));
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
        id_token: makeJwt({ email: 'manual@example.com' }),
        expires_in: 3600
      })
    }),
    startLoopbackCallbackServerImpl() {
      const error = new Error('port in use');
      error.code = 'EADDRINUSE';
      throw error;
    },
    resolveCliPathImpl: () => '/usr/local/bin/codex',
    getToolAccountIds: () => [],
    getProfileDir,
    getToolConfigDir
  });

  const started = manager.startOauthJob('codex', 'oauth-browser');
  const running = manager.getJob(started.jobId);
  assert.equal(running.status, 'running');
  assert.equal(running.callbackCaptureStatus, 'unavailable');
  assert.match(running.logs, /保留手动提交回调兜底/);

  const result = await manager.completeBrowserOauthCallback(
    started.jobId,
    `${running.redirectUri}?code=manual&state=${running.oauthState}`
  );
  assert.equal(result.ok, true);
  assert.equal(manager.getJob(started.jobId).status, 'succeeded');
});

test('createAuthJobManager runs claude browser oauth natively and writes .credentials.json', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-oauth-claude-native-'));
  const getProfileDir = (provider, accountId) => path.join(root, provider, String(accountId));
  const getToolConfigDir = (provider, accountId) => path.join(getProfileDir(provider, accountId), `.${provider}`);

  const fetchCalls = [];
  const loopbackCalls = [];
  const manager = createAuthJobManager({
    fs,
    processObj: {
      ...process,
      cwd: () => root,
      env: { ...process.env },
      platform: process.platform,
      kill() { return; }
    },
    ptyImpl: {
      spawn() {
        throw new Error('claude browser oauth should not spawn cli');
      }
    },
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, body: String(init && init.body || ''), headers: (init && init.headers) || {} });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: 'claude-access-token',
          refresh_token: 'claude-refresh-token',
          expires_in: 3600,
          scope: 'user:inference user:profile',
          account: {
            uuid: 'claude-browser-account',
            email_address: 'claude@example.com'
          }
        })
      };
    },
    startLoopbackCallbackServerImpl: createLoopbackCallbackStub(loopbackCalls),
    resolveCliPathImpl: () => '/usr/local/bin/claude',
    getToolAccountIds: () => [],
    getProfileDir,
    getToolConfigDir
  });

  const started = manager.startOauthJob('claude', 'oauth-browser');
  // aih builds the URL itself against its own loopback redirect — no CLI spawned.
  assert.match(started.authorizationUrl, /^https:\/\/claude\.com\/cai\/oauth\/authorize/);
  assert.match(decodeURIComponent(started.authorizationUrl), /http:\/\/localhost:54545\/callback/);

  const running = manager.getJob(started.jobId);
  assert.equal(running.redirectUri, 'http://localhost:54545/callback');
  assert.equal(running.callbackCaptureStatus, 'starting');
  assert.equal(loopbackCalls.length, 1);

  const completed = await manager.completeBrowserOauthCallback(
    started.jobId,
    `${running.redirectUri}?code=claude-code&state=${running.oauthState}`
  );
  assert.equal(completed.ok, true);

  // Token exchange goes to claude's endpoint as a JSON body.
  assert.equal(fetchCalls[0].url, 'https://platform.claude.com/v1/oauth/token');
  const tokenBody = JSON.parse(fetchCalls[0].body);
  assert.equal(tokenBody.grant_type, 'authorization_code');
  assert.equal(tokenBody.code, 'claude-code');
  assert.equal(tokenBody.redirect_uri, running.redirectUri);
  assert.equal(tokenBody.code_verifier && tokenBody.code_verifier.length > 0, true);

  // Credentials land in .credentials.json as claudeAiOauth (what aih reads).
  const creds = JSON.parse(fs.readFileSync(path.join(running.configDir, '.credentials.json'), 'utf8'));
  assert.equal(creds.claudeAiOauth.accessToken, 'claude-access-token');
  assert.equal(creds.claudeAiOauth.refreshToken, 'claude-refresh-token');
  assert.deepEqual(creds.claudeAiOauth.scopes, ['user:inference', 'user:profile']);
  assert.equal(typeof creds.claudeAiOauth.expiresAt, 'number');

  const finishedJob = manager.getJob(started.jobId);
  assert.equal(finishedJob.status, 'succeeded');
  assert.equal(loopbackCalls[0].closed, true);
  assert.match(finishedJob.logs, /回调 state 校验通过/);
  assert.match(finishedJob.logs, /\.credentials\.json 已写入/);
});

test('createAuthJobManager rejects a claude browser oauth state mismatch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-oauth-claude-state-'));
  const getProfileDir = (provider, accountId) => path.join(root, provider, String(accountId));
  const getToolConfigDir = (provider, accountId) => path.join(getProfileDir(provider, accountId), `.${provider}`);
  let fetchCalled = false;

  const manager = createAuthJobManager({
    fs,
    processObj: { ...process, cwd: () => root, env: { ...process.env }, platform: process.platform },
    ptyImpl: { spawn() { throw new Error('claude browser oauth should not spawn cli'); } },
    fetchImpl: async () => { fetchCalled = true; throw new Error('unexpected token exchange'); },
    startLoopbackCallbackServerImpl: createLoopbackCallbackStub(),
    resolveCliPathImpl: () => '/usr/local/bin/claude',
    getToolAccountIds: () => [],
    getProfileDir,
    getToolConfigDir
  });

  const started = manager.startOauthJob('claude', 'oauth-browser');
  const running = manager.getJob(started.jobId);
  const result = await manager.completeBrowserOauthCallback(
    started.jobId,
    `${running.redirectUri}?code=evil&state=not-the-state`
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_callback_state');
  assert.equal(fetchCalled, false);
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
    startLoopbackCallbackServerImpl: createLoopbackCallbackStub(),
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

test('createAuthJobManager accepts opaque codex refresh token from browser oauth', async () => {
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
        id_token: makeJwt({ email: 'opaque@example.com' }),
        expires_in: 3600
      })
    }),
    startLoopbackCallbackServerImpl: createLoopbackCallbackStub(),
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

  assert.equal(result.ok, true);
  const job = manager.getJob(started.jobId);
  assert.equal(job.status, 'succeeded');
  const authJson = JSON.parse(fs.readFileSync(path.join(job.configDir, 'auth.json'), 'utf8'));
  assert.equal(authJson.tokens.refresh_token, 'not-rt-token');
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
    startLoopbackCallbackServerImpl: createLoopbackCallbackStub(),
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
  const credentialsPath = path.join(manager.getJob(started.jobId).configDir, '.credentials.json');
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
  fs.writeFileSync(credentialsPath, JSON.stringify({
    claudeAiOauth: {
      accessToken: 'claude-access-token',
      refreshToken: 'claude-refresh-token',
      account: { uuid: 'claude-file-account' }
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

  // gemini still spawns its CLI for browser oauth, so this exercises the PTY
  // onExit path after completion artifacts (oauth_creds.json) appear.
  const started = manager.startOauthJob('gemini', 'oauth-browser');
  const credentialsPath = path.join(manager.getJob(started.jobId).configDir, 'oauth_creds.json');
  fs.mkdirSync(path.dirname(credentialsPath), { recursive: true });
  fs.writeFileSync(credentialsPath, JSON.stringify({
    access_token: 'gemini-access-token',
    refresh_token: 'gemini-refresh-token',
    email: 'gemini@example.com'
  }));

  assert.equal(manager.getJob(started.jobId).status, 'succeeded');
  onExitHandler({ exitCode: 0 });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(manager.getJob(started.jobId).status, 'succeeded');
  assert.equal(finishedJobs.length, 1);
});

test('createAuthJobManager reauth requires fresh oauth artifacts instead of reusing old codex auth file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-oauth-codex-reauth-'));
  const getProfileDir = (provider, accountRef) => path.join(root, 'run', provider, String(accountRef));
  const getToolConfigDir = (provider, accountRef) => path.join(getProfileDir(provider, accountRef), `.${provider}`);
  const accountRef = registerAccountIdentity(fs, root, {
    provider: 'codex',
    cliAccountId: '9',
    identitySeed: 'oauth:codex:reauth@example.com'
  }).accountRef;
  writeAccountNativeAuth(fs, root, accountRef, {
    auth: {
      email: 'reauth@example.com',
      tokens: {
        access_token: 'old-access-token',
        refresh_token: 'rt_old',
        account_id: 'upstream-reauth'
      }
    }
  });

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
          id_token: makeJwt({
            email: 'reauth@example.com',
            'https://api.openai.com/auth': { account_id: 'upstream-reauth' }
          }),
          expires_in: 3600
        })
      };
    },
    startLoopbackCallbackServerImpl: createLoopbackCallbackStub(),
    resolveCliPathImpl: () => '/usr/local/bin/codex',
    getToolAccountIds: () => ['9'],
    getProfileDir,
    getToolConfigDir
  });

  const started = manager.startOauthJob('codex', 'oauth-browser', { accountRef });
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
  const actualAuthPath = path.join(succeededJob.configDir, 'auth.json');
  const authJson = JSON.parse(fs.readFileSync(actualAuthPath, 'utf8'));
  assert.equal(authJson.tokens.access_token, 'new-access-token');
  assert.equal(
    readAccountNativeAuth(fs, root, accountRef).auth.tokens.access_token,
    'new-access-token'
  );
});

test('createAuthJobManager reauth preserves the target when OAuth returns a different accountRef', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-oauth-codex-identity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const targetRef = registerAccountIdentity(fs, root, {
    provider: 'codex',
    cliAccountId: '9',
    identitySeed: 'oauth:codex:original@example.com'
  }).accountRef;
  writeAccountNativeAuth(fs, root, targetRef, {
    auth: {
      email: 'original@example.com',
      tokens: {
        access_token: 'original-access-token',
        refresh_token: 'rt_original',
        account_id: 'upstream-original'
      }
    }
  });

  const manager = createAuthJobManager({
    fs,
    processObj: {
      ...process,
      cwd: () => root,
      env: { ...process.env },
      platform: process.platform,
      kill() {}
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
        access_token: 'different-access-token',
        refresh_token: 'rt_different',
        id_token: makeJwt({
          email: 'different@example.com',
          'https://api.openai.com/auth': { account_id: 'upstream-different' }
        }),
        expires_in: 3600
      })
    }),
    startLoopbackCallbackServerImpl: createLoopbackCallbackStub(),
    resolveCliPathImpl: () => '/usr/local/bin/codex'
  });

  const started = manager.startOauthJob('codex', 'oauth-browser', { accountRef: targetRef });
  const running = manager.getJob(started.jobId);
  const completed = await manager.completeBrowserOauthCallback(
    started.jobId,
    `${running.redirectUri}?code=ok&state=${running.oauthState}`
  );

  const differentRef = getPublicAccountRef('unique:oauth:codex:different@example.com');
  assert.equal(completed.ok, true);
  assert.equal(manager.getJob(started.jobId).accountRef, differentRef);
  assert.equal(
    readAccountNativeAuth(fs, root, targetRef).auth.tokens.access_token,
    'original-access-token'
  );
  assert.equal(
    readAccountNativeAuth(fs, root, differentRef).auth.tokens.access_token,
    'different-access-token'
  );
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
  const oauthPath = path.join(manager.getJob(started.jobId).configDir, 'oauth_creds.json');
  fs.mkdirSync(path.dirname(oauthPath), { recursive: true });
  fs.writeFileSync(oauthPath, JSON.stringify({
    access_token: 'gemini-access-token',
    refresh_token: 'gemini-refresh-token',
    email: 'gemini-file@example.com'
  }));

  const job = manager.getJob(started.jobId);
  assert.equal(job.status, 'succeeded');
});

test('missing Kimi CLI waits for confirmation then installs and continues OAuth with the same job id', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-oauth-kimi-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let installed = false;
  const spawned = [];
  const changed = [];
  const manager = createAuthJobManager({
    fs,
    aiHomeDir: root,
    processObj: {
      ...process,
      cwd: () => root,
      env: { ...process.env },
      platform: 'win32',
      kill() {}
    },
    resolveCliPathImpl: () => installed ? 'C:\\Users\\test\\AppData\\Roaming\\npm\\kimi.cmd' : '',
    ensureNativeCliImpl: () => ({ cliPath: '', binaryName: 'kimi', installed: false, installAttempts: [] }),
    installNativeCliImpl: async (_provider, options) => {
      options.onPlanStart({ id: 'npm_global', label: 'npm global installer' });
      options.onOutput('installing kimi\n', 'stdout', { id: 'npm_global', label: 'npm global installer' });
      installed = true;
      options.onPlanFinish({ id: 'npm_global', label: 'npm global installer', ok: true, error: '' });
      return {
        cliPath: 'C:\\Users\\test\\AppData\\Roaming\\npm\\kimi.cmd',
        binaryName: 'kimi',
        installed: true,
        installAttempts: [{ id: 'npm_global', label: 'npm global installer', ok: true, error: '' }]
      };
    },
    ptyImpl: {
      spawn(command, args) {
        spawned.push({ command, args });
        return { pid: 4312, onData() {}, onExit() {}, kill() {} };
      }
    },
    onJobChanged(job) {
      changed.push(serializeAuthJob(job));
    }
  });

  const started = manager.startOauthJob('kimi', 'oauth-browser', { deferInstallConfirmation: true });
  assert.equal(started.installRequired, true);
  assert.equal(started.setupPhase, 'awaiting-install-confirmation');
  assert.equal(manager.getJob(started.jobId).authProgressState, 'awaiting_install_confirmation');

  const confirmed = await manager.confirmCliInstall(started.jobId);
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.job.id, started.jobId);
  assert.equal(confirmed.job.installRequired, undefined);
  assert.equal(spawned.length, 1);
  assert.match(launchCommandLine(spawned[0]), /kimi/);
  assert.match(launchCommandLine(spawned[0]), /login/);
  assert.ok(changed.some((job) => job.setupPhase === 'installing'));
});

test('createAuthJobManager marks grok oauth succeeded when auth.json appears', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-oauth-grok-complete-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let onExitHandler = null;
  const manager = createAuthJobManager({
    fs,
    processObj: {
      ...process,
      cwd: () => root,
      env: { ...process.env },
      platform: process.platform,
      kill() {}
    },
    ptyImpl: {
      spawn() {
        return {
          pid: 2201,
          onData() {},
          onExit(handler) { onExitHandler = handler; },
          kill() {}
        };
      }
    },
    resolveCliPathImpl: () => '/usr/local/bin/grok'
  });

  const started = manager.startOauthJob('grok', 'oauth-browser');
  const running = manager.getJob(started.jobId);
  fs.writeFileSync(path.join(running.configDir, 'auth.json'), JSON.stringify({
    'https://auth.x.ai::client': {
      key: 'grok-access-token',
      refresh_token: 'grok-refresh-token',
      email: 'grok@example.com',
      principal_id: 'grok-user-id'
    }
  }));
  onExitHandler({ exitCode: 0 });
  await new Promise((resolve) => setImmediate(resolve));

  const completed = manager.getJob(started.jobId);
  assert.equal(completed.status, 'succeeded');
  assert.match(completed.accountRef, /^acct_/);
  assert.equal(readAccountNativeAuth(fs, root, completed.accountRef).auth['https://auth.x.ai::client'].email, 'grok@example.com');
});

test('createAuthJobManager treats fresh agy oauth token file as reauth completion evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-oauth-agy-reauth-'));
  const getProfileDir = (provider, accountId) => path.join(root, provider, String(accountId));
  const getToolConfigDir = (provider, accountId) => (
    provider === 'agy'
      ? path.join(getProfileDir(provider, accountId), '.gemini', 'antigravity-cli')
      : path.join(getProfileDir(provider, accountId), `.${provider}`)
  );
  const accountRef = registerAccountIdentity(fs, root, {
    provider: 'agy',
    cliAccountId: '1',
    identitySeed: 'oauth:agy:agy-reauth@example.com'
  }).accountRef;
  writeAccountNativeAuth(fs, root, accountRef, {
    oauthToken: {
      token: {
        access_token: 'old-access-token',
        refresh_token: 'old-refresh-token'
      },
      auth_method: 'oauth'
    },
    email: 'agy-reauth@example.com'
  });

  let killed = false;
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
          pid: 2202,
          onData() {},
          onExit() {},
          kill() {
            killed = true;
          }
        };
      }
    },
    resolveCliPathImpl: () => '/usr/local/bin/agy',
    getToolAccountIds: () => ['1'],
    getProfileDir,
    getToolConfigDir
  });

  const started = manager.startOauthJob('agy', 'oauth-browser', { accountRef });
  assert.equal(started.provider, 'agy');
  assert.equal(Object.hasOwn(started, 'accountId'), false);
  const runningJob = manager.getJob(started.jobId);
  assert.equal(runningJob.status, 'running');
  assert.equal(runningJob.reauth, true);
  assert.equal(runningJob._reauthTargetRef, accountRef);

  const configDir = runningJob.configDir;
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'antigravity-oauth-token'),
    JSON.stringify({
      token: {
        access_token: 'dummy-access-token'
      },
      auth_method: 'oauth'
    })
  );

  const job = manager.getJob(started.jobId);
  assert.equal(job.status, 'succeeded');
  assert.equal(killed, true);
  assert.equal(
    readAccountNativeAuth(fs, root, accountRef).oauthToken.token.access_token,
    'dummy-access-token'
  );
});

test('createAuthJobManager resolves native oauth cli from runtime-tools fallback', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-oauth-runtime-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeBin = path.join(root, '.runtime-tools', 'bin');
  const agyPath = path.join(runtimeBin, 'agy');
  fs.mkdirSync(runtimeBin, { recursive: true });
  fs.writeFileSync(agyPath, '#!/bin/sh\nexit 0\n', 'utf8');
  fs.chmodSync(agyPath, 0o755);

  const getProfileDir = (provider, accountId) => path.join(root, provider, String(accountId));
  const getToolConfigDir = (provider, accountId) => (
    provider === 'agy'
      ? path.join(getProfileDir(provider, accountId), '.gemini', 'antigravity-cli')
      : path.join(getProfileDir(provider, accountId), `.${provider}`)
  );

  let spawnCall = null;
  const manager = createAuthJobManager({
    fs,
    processObj: {
      ...process,
      cwd: () => root,
      env: {
        PATH: '',
        AIH_RUNTIME_TOOLS_DIR: runtimeBin
      },
      platform: process.platform,
      kill() {
        return;
      }
    },
    ptyImpl: {
      spawn(command, args, options) {
        spawnCall = { command, args, options };
        return {
          pid: 2301,
          onData() {},
          onExit() {},
          write() {},
          kill() {}
        };
      }
    },
    getToolAccountIds: () => [],
    getProfileDir,
    getToolConfigDir
  });

  const started = manager.startOauthJob('agy', 'oauth-browser');
  assert.equal(started.provider, 'agy');
  // Match path separators as either / or \ so Windows cmd wrappers still pass.
  const agyPathPattern = new RegExp(agyPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\//g, '[\\\\/]'));
  assertLaunchIncludes(spawnCall, agyPathPattern, /\bagy\b/);
});

test('createAuthJobManager auto-confirms agy Google OAuth login method prompt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-oauth-agy-prompt-'));
  const getProfileDir = (provider, accountId) => path.join(root, provider, String(accountId));
  const getToolConfigDir = (provider, accountId) => (
    provider === 'agy'
      ? path.join(getProfileDir(provider, accountId), '.gemini', 'antigravity-cli')
      : path.join(getProfileDir(provider, accountId), `.${provider}`)
  );

  let onDataHandler = null;
  const writes = [];
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
          pid: 2302,
          onData(handler) {
            onDataHandler = handler;
          },
          onExit() {},
          write(chunk) {
            writes.push(chunk);
          },
          kill() {}
        };
      }
    },
    resolveCliPathImpl: () => '/usr/local/bin/agy',
    getToolAccountIds: () => [],
    getProfileDir,
    getToolConfigDir
  });

  const started = manager.startOauthJob('agy', 'oauth-browser');
  assert.equal(started.provider, 'agy');
  assert.equal(started.authProgressState, 'awaiting_login_method');
  assert.equal(typeof onDataHandler, 'function');

  onDataHandler([
    'Welcome to the Antigravity CLI. You are currently not signed in.',
    'Signing in...',
    'Select login method:',
    '> 1. Google OAuth',
    '2. Use a Google Cloud project',
    '[Use arrow keys to navigate, Enter to select]'
  ].join('\n'));
  onDataHandler('Select login method:\n> 1. Google OAuth\n2. Use a Google Cloud project\n');

  assert.deepEqual(writes, ['1\r']);
  assert.equal(manager.getJob(started.jobId).authProgressState, 'login_method_selected');
  assert.match(manager.getJob(started.jobId).logs, /自动选择 1\. Google OAuth/);
});

test('createAuthJobManager rejects agy authorization code before auth url is ready', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-oauth-agy-code-not-ready-'));
  const getProfileDir = (provider, accountId) => path.join(root, provider, String(accountId));
  const getToolConfigDir = (provider, accountId) => (
    provider === 'agy'
      ? path.join(getProfileDir(provider, accountId), '.gemini', 'antigravity-cli')
      : path.join(getProfileDir(provider, accountId), `.${provider}`)
  );

  const writes = [];
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
          pid: 2304,
          onData() {},
          onExit() {},
          write(chunk) {
            writes.push(chunk);
          },
          kill() {}
        };
      }
    },
    resolveCliPathImpl: () => '/usr/local/bin/agy',
    getToolAccountIds: () => [],
    getProfileDir,
    getToolConfigDir
  });

  const started = manager.startOauthJob('agy', 'oauth-browser');
  const result = await manager.completeBrowserOauthCallback(started.jobId, '4/0AgyAuthorizationCode');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'oauth_redirect_not_ready');
  assert.deepEqual(writes, []);
  assert.equal(manager.getJob(started.jobId).authProgressState, 'awaiting_login_method');
  assert.match(manager.getJob(started.jobId).logs, /授权链接尚未准备好/);
});

test('createAuthJobManager rejects agy authorization code until native cli awaits code input', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-oauth-agy-code-url-only-'));
  const getProfileDir = (provider, accountId) => path.join(root, provider, String(accountId));
  const getToolConfigDir = (provider, accountId) => (
    provider === 'agy'
      ? path.join(getProfileDir(provider, accountId), '.gemini', 'antigravity-cli')
      : path.join(getProfileDir(provider, accountId), `.${provider}`)
  );

  let onDataHandler = null;
  const writes = [];
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
          pid: 2305,
          onData(handler) {
            onDataHandler = handler;
          },
          onExit() {},
          write(chunk) {
            writes.push(chunk);
          },
          kill() {}
        };
      }
    },
    resolveCliPathImpl: () => '/usr/local/bin/agy',
    getToolAccountIds: () => [],
    getProfileDir,
    getToolConfigDir
  });

  const started = manager.startOauthJob('agy', 'oauth-browser');
  onDataHandler([
    'Select login method:',
    '> 1. Google OAuth',
    '2. Use a Google Cloud project',
    'Open this link in the browser:',
    ' https://accounts.google.com/o/oauth2/auth?client_id=agy-client&code_challenge=abc123',
    ' &redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=agy-state'
  ].join('\n'));

  const job = manager.getJob(started.jobId);
  assert.equal(job.authProgressState, 'auth_url_ready');
  assert.match(job.authorizationUrl, /accounts\.google\.com/);

  const result = await manager.completeBrowserOauthCallback(started.jobId, '4/0AgyAuthorizationCode');

  assert.equal(result.ok, false);
  assert.equal(result.code, 'oauth_redirect_not_ready');
  assert.deepEqual(writes, ['1\r']);
  assert.equal(manager.getJob(started.jobId).authProgressState, 'auth_url_ready');
});

test('createAuthJobManager submits agy browser authorization code to pty', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-web-oauth-agy-code-'));
  const getProfileDir = (provider, accountId) => path.join(root, provider, String(accountId));
  const getToolConfigDir = (provider, accountId) => (
    provider === 'agy'
      ? path.join(getProfileDir(provider, accountId), '.gemini', 'antigravity-cli')
      : path.join(getProfileDir(provider, accountId), `.${provider}`)
  );

  let onDataHandler = null;
  const writes = [];
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
          pid: 2303,
          onData(handler) {
            onDataHandler = handler;
          },
          onExit() {},
          write(chunk) {
            writes.push(chunk);
          },
          kill() {}
        };
      }
    },
    resolveCliPathImpl: () => '/usr/local/bin/agy',
    getToolAccountIds: () => [],
    getProfileDir,
    getToolConfigDir
  });

  const started = manager.startOauthJob('agy', 'oauth-browser');
  onDataHandler([
    'Select login method:',
    '> 1. Google OAuth',
    '2. Use a Google Cloud project',
    'Open this link in the browser (be sure to copy-paste the whole URL):',
    ' https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1071006060591-tmhssin2h21lcre235vtolojh4g403ep',
    ' .apps.googleusercontent.com&code_challenge=abc123&code_challenge_method=S256&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=agy-state',
    "If you aren't automatically redirected, paste the authorization code below:",
    'authorization code...'
  ].join('\n'));

  const job = manager.getJob(started.jobId);
  assert.equal(job.redirectUri, 'https://antigravity.google/oauth-callback');
  assert.equal(job.oauthState, 'agy-state');
  assert.match(job.authorizationUrl, /accounts\.google\.com/);
  assert.equal(job.authProgressState, 'awaiting_code');

  const result = await manager.completeBrowserOauthCallback(started.jobId, '4/0AgyAuthorizationCode');
  assert.equal(result.ok, true);
  assert.equal(manager.getJob(started.jobId).status, 'running');
  assert.equal(manager.getJob(started.jobId).authProgressState, 'submitted_code');
  assert.deepEqual(writes, ['1\r', '4/0AgyAuthorizationCode\r']);
  assert.match(manager.getJob(started.jobId).logs, /已写回 CLI/);
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

test('startOauthJob auto-installs qodercn CLI via ensureNativeCli before failing closed', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-qodercn-auth-'));
  let ensureCalls = 0;
  const manager = createAuthJobManager({
    fs,
    aiHomeDir,
    processObj: { platform: 'win32', env: process.env, cwd: () => aiHomeDir },
    ensureNativeCliImpl: (provider) => {
      ensureCalls += 1;
      assert.equal(provider, 'qodercn');
      return {
        cliPath: '',
        binaryName: 'qoderclicn',
        installed: false,
        installAttempts: [{
          id: 'qoder_cn_windows',
          label: 'Qoder CLI CN official installer',
          ok: false,
          error: 'simulated'
        }]
      };
    },
    resolveCliPathImpl: null
  });
  assert.throws(
    () => manager.startOauthJob('qodercn', 'oauth-browser'),
    (error) => {
      assert.equal(error.code, 'cli_not_found');
      assert.match(String(error.message), /qoderclicn/);
      assert.match(String(error.message), /自动安装失败/);
      assert.equal(Array.isArray(error.installAttempts), true);
      return true;
    }
  );
  assert.equal(ensureCalls, 1);
});

test('startOauthJob resolves qodercn through ensureNativeCli success path', async () => {
  const aiHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-qodercn-ok-'));
  const spawned = [];
  const manager = createAuthJobManager({
    fs,
    aiHomeDir,
    processObj: { platform: 'win32', env: process.env, cwd: () => aiHomeDir },
    ensureNativeCliImpl: (provider) => {
      assert.equal(provider, 'qodercn');
      return {
        cliPath: 'C:\\tools\\qoderclicn.exe',
        binaryName: 'qoderclicn',
        installed: true,
        installAttempts: [{
          id: 'qoder_cn_windows',
          label: 'Qoder CLI CN official installer',
          ok: true
        }]
      };
    },
    resolveCliPathImpl: null,
    ptyImpl: {
      spawn: (command, args, opts) => {
        spawned.push({ command, args, opts });
        return {
          onData() {},
          onExit(cb) { setImmediate(() => cb({ exitCode: 1 })); },
          write() {},
          kill() {}
        };
      }
    }
  });
  const started = manager.startOauthJob('qodercn', 'oauth-browser');
  assert.ok(started && started.jobId);
  assert.equal(started.provider, 'qodercn');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(spawned.length >= 1);
  // Windows may wrap extensionless bins with cmd.exe; .exe should spawn directly.
  const launch = spawned[0];
  const launchBlob = `${launch.command} ${(launch.args || []).join(' ')}`;
  assert.match(launchBlob, /qoderclicn\.exe/i);
});
