const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getProviderLaunchStrategy } = require('../lib/cli/services/ai-cli/launch-profile');
const { homeRedirectStrategy } = require('../lib/cli/services/ai-cli/launch-profile/home-redirect-strategy');
const { agyStrategy } = require('../lib/cli/services/ai-cli/launch-profile/agy-strategy');
const { claudeStrategy } = require('../lib/cli/services/ai-cli/launch-profile/claude-strategy');
const { codexStrategy } = require('../lib/cli/services/ai-cli/launch-profile/codex-strategy');
const { geminiStrategy } = require('../lib/cli/services/ai-cli/launch-profile/gemini-strategy');
const {
  opencodeStrategy,
  reconcileSharedData: reconcileOpenCodeSharedData
} = require('../lib/cli/services/ai-cli/launch-profile/opencode-strategy');
const {
  buildProviderRuntimeEnv,
  normalizeUtf8LocaleEnv,
  prepareProviderRuntime,
  resolveProviderRuntimeScope
} = require('../lib/cli/services/ai-cli/provider-runtime-env');

const SANDBOX = '/home/u/.ai_home/run/auth-projections/claude/acct_1234567890abcdef1234';
const CODEX_CONFIG = path.join(SANDBOX, '.codex');

function baseCtx(cliName, extra = {}) {
  return { cliName, sandboxDir: SANDBOX, codexConfigDir: CODEX_CONFIG, codexSqliteHome: '', path, ...extra };
}

// ---- registry ----

test('registry maps known providers and defaults to home-redirect', () => {
  assert.equal(getProviderLaunchStrategy('claude'), claudeStrategy);
  assert.equal(getProviderLaunchStrategy('codex'), codexStrategy);
  assert.equal(getProviderLaunchStrategy('gemini'), geminiStrategy);
  assert.equal(getProviderLaunchStrategy('agy'), agyStrategy);
  assert.equal(getProviderLaunchStrategy('opencode'), opencodeStrategy);
  assert.equal(getProviderLaunchStrategy('unknown'), homeRedirectStrategy);
  assert.equal(getProviderLaunchStrategy(''), homeRedirectStrategy);
});

// ---- home-redirect fallback + AGY provider home ----

test('agy strategy injects keychain bypass without provider-specific Codex behavior', () => {
  const agy = agyStrategy.buildEnvPatch(baseCtx('agy', { hostHomeDir: '/home/u' })).set;
  assert.equal(agy.HOME, SANDBOX);
  assert.equal(agy.SSH_CLIENT, '127.0.0.1 12345 22');
  assert.equal(agy.container, 'docker');
  assert.equal(Object.prototype.hasOwnProperty.call(agy, 'CODEX_HOME'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(agy, 'CLAUDE_CONFIG_DIR'), false);

  const gemini = homeRedirectStrategy.buildEnvPatch(baseCtx('gemini')).set;
  assert.ok(!('SSH_CLIENT' in gemini));
});

test('home-redirect fallback redirects regenerable caches to the shared host home', () => {
  const HOST = '/home/u';
  const { set } = homeRedirectStrategy.buildEnvPatch(baseCtx('unknown', { hostHomeDir: HOST }));
  // identity/state stays per-account...
  assert.equal(set.HOME, SANDBOX);
  assert.equal(set.XDG_DATA_HOME, path.join(SANDBOX, '.local', 'share'));
  // ...but build caches point at the shared real home (no per-account dup)
  assert.equal(set.CARGO_HOME, path.join(HOST, '.cargo'));
  assert.equal(set.GOPATH, path.join(HOST, 'go'));
  assert.equal(set.GOMODCACHE, path.join(HOST, 'go', 'pkg', 'mod'));
  assert.equal(set.GOCACHE, path.join(HOST, '.cache', 'go-build'));
  assert.equal(set.npm_config_cache, path.join(HOST, '.npm'));
  assert.equal(set.XDG_CACHE_HOME, path.join(HOST, '.cache'));
});

test('home-redirect fallback has no cache redirect when host home is unknown', () => {
  const { set } = homeRedirectStrategy.buildEnvPatch(baseCtx('unknown'));
  assert.ok(!('CARGO_HOME' in set) && !('GOPATH' in set) && !('XDG_CACHE_HOME' in set));
});

// ---- claude: one host state dir, disposable login auth dir ----

test('claude: normal launches always use the host CLAUDE_CONFIG_DIR', () => {
  const { set, unset } = claudeStrategy.buildEnvPatch(baseCtx('claude', { hostHomeDir: '/home/u' }));
  assert.deepEqual(set, { CLAUDE_CONFIG_DIR: '/home/u/.claude' });
  assert.ok(!('HOME' in set) && !('CLAUDE_CODE_OAUTH_TOKEN' in set));
  assert.deepEqual(unset, ['USER']);
});

test('claude: login keeps USER for native OAuth keychain writes', () => {
  const { set, unset } = claudeStrategy.buildEnvPatch(baseCtx('claude', {
    hostHomeDir: '/home/u',
    isLogin: true
  }));
  assert.deepEqual(set, { CLAUDE_CONFIG_DIR: path.join(SANDBOX, '.claude') });
  assert.deepEqual(unset, []);
});

test('claude: api credential accounts keep shared session config dir', () => {
  const { set, unset } = claudeStrategy.buildEnvPatch(baseCtx('claude', {
    hostHomeDir: '/home/u',
    baseEnv: {
      ANTHROPIC_API_KEY: 'sk-test',
      ANTHROPIC_BASE_URL: 'https://relay.example.com'
    }
  }));
  // A non-official, non-loopback endpoint also disables the first-party-only
  // advisor tool (Claude Code would otherwise inject advisor_20260301 and strict
  // third-party endpoints 400 on it).
  assert.deepEqual(set, {
    CLAUDE_CONFIG_DIR: '/home/u/.claude',
    CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1'
  });
  assert.deepEqual(unset, ['USER']);
});

test('claude: auth-token accounts keep shared session config dir', () => {
  const { set } = claudeStrategy.buildEnvPatch(baseCtx('claude', {
    hostHomeDir: '/home/u',
    baseEnv: {
      ANTHROPIC_AUTH_TOKEN: 'sk-token'
    }
  }));
  assert.deepEqual(set, { CLAUDE_CONFIG_DIR: '/home/u/.claude' });
});

test('claude launch strategy leaves auth projection lifecycle to the DB projection service', () => {
  assert.equal(claudeStrategy.prepare, undefined);
});

test('provider runtime scope keeps gateway and env-auth accounts on the shared host home', () => {
  const hostHomeDir = '/home/u';
  const gateway = resolveProviderRuntimeScope('claude', SANDBOX, { HOME: hostHomeDir }, {
    gateway: true,
    hostHomeDir
  });
  const apiKeyAccount = resolveProviderRuntimeScope('codex', SANDBOX, { HOME: hostHomeDir }, {
    accountEnv: { OPENAI_API_KEY: 'sk-test' },
    hostHomeDir
  });
  const oauthAccount = resolveProviderRuntimeScope('codex', SANDBOX, { HOME: hostHomeDir }, {
    accountEnv: {},
    hostHomeDir
  });
  const relayedClaudeAccount = resolveProviderRuntimeScope('claude', SANDBOX, { HOME: hostHomeDir }, {
    accountEnv: {},
    authRelayed: true,
    hostHomeDir
  });

  assert.deepEqual(gateway, {
    hostHomeDir,
    projectionRequired: false,
    runtimeDir: hostHomeDir
  });
  assert.equal(apiKeyAccount.projectionRequired, false);
  assert.equal(apiKeyAccount.runtimeDir, hostHomeDir);
  assert.equal(oauthAccount.projectionRequired, true);
  assert.equal(oauthAccount.runtimeDir, SANDBOX);
  assert.equal(relayedClaudeAccount.projectionRequired, false);
  assert.equal(relayedClaudeAccount.runtimeDir, hostHomeDir);
});

// ---- codex: per-account CODEX_HOME + shared sessions, no HOME/XDG ----

test('codex: per-account CODEX_HOME + shared CODEX_SQLITE_HOME, no HOME/XDG', () => {
  const { set, unset } = codexStrategy.buildEnvPatch(baseCtx('codex', { codexSqliteHome: '/home/u/.codex' }));
  assert.deepEqual(set, { CODEX_HOME: CODEX_CONFIG, CODEX_SQLITE_HOME: '/home/u/.codex' });
  assert.ok(!('HOME' in set) && !('XDG_CONFIG_HOME' in set) && !('CLAUDE_CONFIG_DIR' in set));
  assert.deepEqual(unset, []);
});

test('codex: omits CODEX_SQLITE_HOME when unavailable', () => {
  assert.deepEqual(codexStrategy.buildEnvPatch(baseCtx('codex')).set, { CODEX_HOME: CODEX_CONFIG });
});

test('codex: prepare creates CODEX_HOME before native startup', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-codex-launch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sandboxDir = path.join(root, 'pending-login');
  const codexConfigDir = path.join(sandboxDir, '.codex');

  codexStrategy.prepare(baseCtx('codex', {
    sandboxDir,
    codexConfigDir,
    fs
  }));

  assert.equal(fs.statSync(codexConfigDir).isDirectory(), true);
});

// ---- gemini: per-account GEMINI_CLI_HOME, no HOME/XDG ----

test('gemini: per-account GEMINI_CLI_HOME + settings pointer, no HOME/XDG', () => {
  const { set, unset } = geminiStrategy.buildEnvPatch(baseCtx('gemini'));
  const geminiDir = path.join(SANDBOX, '.gemini');
  assert.deepEqual(set, {
    GEMINI_CLI_HOME: geminiDir,
    GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(geminiDir, 'settings.json')
  });
  assert.ok(!('HOME' in set) && !('XDG_CONFIG_HOME' in set) && !('CODEX_HOME' in set));
  assert.deepEqual(unset, []);
});

// ---- opencode: shared home/config/state/cache + account-owned auth ----

test('opencode: keeps host HOME and isolates only XDG data auth root', () => {
  const HOST = '/home/u';
  const { set, unset } = opencodeStrategy.buildEnvPatch(baseCtx('opencode', { hostHomeDir: HOST }));
  assert.equal(set.HOME, HOST);
  assert.equal(set.USERPROFILE, HOST);
  assert.equal(set.XDG_CONFIG_HOME, path.join(HOST, '.config'));
  assert.equal(set.XDG_DATA_HOME, path.join(SANDBOX, '.local', 'share', 'aih-opencode-runtime'));
  assert.equal(set.XDG_STATE_HOME, path.join(HOST, '.local', 'state'));
  assert.equal(set.XDG_CACHE_HOME, path.join(HOST, '.cache'));
  assert.equal(set.npm_config_cache, path.join(HOST, '.npm'));
  assert.ok(!('CODEX_HOME' in set) && !('CLAUDE_CONFIG_DIR' in set) && !('GEMINI_CLI_HOME' in set));
  assert.deepEqual(unset, [
    'OPENCODE_API_KEY',
    'OPENCODE_CONFIG',
    'OPENCODE_CONFIG_DIR',
    'OPENCODE_CONFIG_CONTENT',
    'OPENCODE_SERVER_PASSWORD',
    'OPENCODE_SERVER_USERNAME'
  ]);
});

test('opencode prepare links shared data entries and keeps auth account-owned', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-opencode-bridge-'));
  try {
    const hostHome = path.join(root, 'home');
    const sandboxDir = path.join(root, '.ai_home', 'run', 'auth-projections', 'opencode', 'acct_1234567890abcdef1234');
    const accountAuthDir = path.join(sandboxDir, '.local', 'share', 'opencode');
    const bridgeDataDir = path.join(sandboxDir, '.local', 'share', 'aih-opencode-runtime', 'opencode');
    const sharedDataDir = path.join(hostHome, '.local', 'share', 'opencode');
    fs.mkdirSync(accountAuthDir, { recursive: true });
    fs.writeFileSync(path.join(accountAuthDir, 'auth.json'), '{"openai":{"type":"api","key":"sk-test"}}\n');

    prepareProviderRuntime('opencode', sandboxDir, { HOME: hostHome }, {
      path,
      fs,
      hostHomeDir: hostHome
    });

    assert.equal(fs.lstatSync(path.join(accountAuthDir, 'auth.json')).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(path.join(bridgeDataDir, 'auth.json')).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(path.join(bridgeDataDir, 'auth.json')), path.join(accountAuthDir, 'auth.json'));
    for (const name of ['bin', 'log', 'repos', 'snapshot', 'storage']) {
      const linkPath = path.join(bridgeDataDir, name);
      assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true, `${name} should link to shared data`);
      assert.equal(fs.readlinkSync(linkPath), path.join(sharedDataDir, name));
      assert.equal(fs.statSync(path.join(sharedDataDir, name)).isDirectory(), true);
    }
    for (const name of ['opencode.db', 'opencode.db-shm', 'opencode.db-wal']) {
      const linkPath = path.join(bridgeDataDir, name);
      assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true, `${name} should link to shared data`);
      assert.equal(fs.readlinkSync(linkPath), path.join(sharedDataDir, name));
    }
    assert.equal(fs.existsSync(path.join(sandboxDir, '.opencode')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('opencode prepare rebuilds stale auth projection from canonical runtime auth', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-opencode-bridge-conflict-'));
  try {
    const hostHome = path.join(root, 'home');
    const sandboxDir = path.join(root, '.ai_home', 'run', 'auth-projections', 'opencode', 'acct_1234567890abcdef1234');
    const bridgeDataDir = path.join(sandboxDir, '.local', 'share', 'aih-opencode-runtime', 'opencode');
    fs.mkdirSync(bridgeDataDir, { recursive: true });
    fs.writeFileSync(path.join(bridgeDataDir, 'auth.json'), '{"split":true}\n', 'utf8');

    prepareProviderRuntime('opencode', sandboxDir, { HOME: hostHome }, {
      path,
      fs,
      hostHomeDir: hostHome
    });

    const authLink = path.join(bridgeDataDir, 'auth.json');
    assert.equal(fs.lstatSync(authLink).isSymbolicLink(), true);
    assert.equal(
      fs.readlinkSync(authLink),
      path.join(sandboxDir, '.local', 'share', 'opencode', 'auth.json')
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('opencode prepare migrates account runtime data before rebuilding shared links', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-opencode-shared-conflict-'));
  try {
    const hostHome = path.join(root, 'home');
    const sandboxDir = path.join(root, '.ai_home', 'run', 'auth-projections', 'opencode', 'acct_1234567890abcdef1234');
    const bridgeDataDir = path.join(sandboxDir, '.local', 'share', 'aih-opencode-runtime', 'opencode');
    const accountDataDir = path.join(sandboxDir, '.local', 'share', 'opencode');
    const projectedConfigDir = path.join(sandboxDir, '.config', 'opencode');
    const sharedDataDir = path.join(hostHome, '.local', 'share', 'opencode');
    const sharedConfigDir = path.join(hostHome, '.config', 'opencode');
    fs.mkdirSync(bridgeDataDir, { recursive: true });
    fs.mkdirSync(accountDataDir, { recursive: true });
    fs.mkdirSync(projectedConfigDir, { recursive: true });
    fs.mkdirSync(path.join(bridgeDataDir, 'log'), { recursive: true });
    fs.writeFileSync(path.join(bridgeDataDir, 'log', 'opencode.log'), 'prior-run-logs\n', 'utf8');
    fs.writeFileSync(path.join(bridgeDataDir, 'opencode.db'), 'sqlite-bytes', 'utf8');
    fs.writeFileSync(path.join(accountDataDir, 'auth.json'), '{"token":"private"}\n', 'utf8');
    fs.writeFileSync(path.join(accountDataDir, 'auth.json.corrupted.bak'), 'private backup\n', 'utf8');
    fs.writeFileSync(path.join(accountDataDir, 'legacy-state.json'), '{"legacy":true}\n', 'utf8');
    fs.writeFileSync(path.join(projectedConfigDir, 'auth.json.backup'), 'config private backup\n', 'utf8');
    fs.writeFileSync(path.join(projectedConfigDir, 'opencode.json'), '{"theme":"system"}\n', 'utf8');

    prepareProviderRuntime('opencode', sandboxDir, { HOME: hostHome }, {
      path,
      fs,
      hostHomeDir: hostHome
    });

    const logLink = path.join(bridgeDataDir, 'log');
    assert.equal(fs.lstatSync(logLink).isSymbolicLink(), true, 'log should become a canonical symlink');
    assert.equal(fs.readlinkSync(logLink), path.join(sharedDataDir, 'log'));
    assert.equal(fs.readFileSync(path.join(sharedDataDir, 'log', 'opencode.log'), 'utf8'), 'prior-run-logs\n');

    const dbLink = path.join(bridgeDataDir, 'opencode.db');
    assert.equal(fs.lstatSync(dbLink).isSymbolicLink(), true, 'opencode.db should become a canonical symlink');
    assert.equal(fs.readlinkSync(dbLink), path.join(sharedDataDir, 'opencode.db'));
    assert.equal(fs.readFileSync(path.join(sharedDataDir, 'opencode.db'), 'utf8'), 'sqlite-bytes');
    assert.equal(fs.readFileSync(path.join(sharedDataDir, 'legacy-state.json'), 'utf8'), '{"legacy":true}\n');
    assert.equal(fs.lstatSync(path.join(accountDataDir, 'legacy-state.json')).isSymbolicLink(), true);
    assert.equal(fs.existsSync(path.join(sharedDataDir, 'auth.json')), false);
    assert.equal(fs.existsSync(path.join(sharedDataDir, 'auth.json.corrupted.bak')), false);
    assert.equal(fs.lstatSync(path.join(accountDataDir, 'auth.json')).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(path.join(accountDataDir, 'auth.json.corrupted.bak')).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(sharedConfigDir, 'opencode.json'), 'utf8'), '{"theme":"system"}\n');
    assert.equal(fs.existsSync(path.join(sharedConfigDir, 'auth.json.backup')), false);
    assert.equal(fs.lstatSync(path.join(projectedConfigDir, 'auth.json.backup')).isSymbolicLink(), false);
    assert.equal(fs.lstatSync(path.join(projectedConfigDir, 'opencode.json')).isSymbolicLink(), true);
    assert.equal(
      fs.realpathSync(path.join(projectedConfigDir, 'opencode.json')),
      fs.realpathSync(path.join(sharedConfigDir, 'opencode.json'))
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('opencode prepare preserves a conflicting account copy under the provider-native root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-opencode-shared-merge-'));
  try {
    const hostHome = path.join(root, 'home');
    const sandboxDir = path.join(root, '.ai_home', 'run', 'auth-projections', 'opencode', 'acct_1234567890abcdef1234');
    const bridgeDataDir = path.join(sandboxDir, '.local', 'share', 'aih-opencode-runtime', 'opencode');
    const sharedDataDir = path.join(hostHome, '.local', 'share', 'opencode');
    fs.mkdirSync(bridgeDataDir, { recursive: true });
    // 共享侧已有权威 db；账号本地又存了一个独立 db。共享侧继续做单一真相，
    // 但账号副本必须进入 provider-native recovery 目录，不能随 projection 被丢弃。
    fs.mkdirSync(sharedDataDir, { recursive: true });
    fs.writeFileSync(path.join(sharedDataDir, 'opencode.db'), 'shared-authoritative', 'utf8');
    fs.writeFileSync(path.join(bridgeDataDir, 'opencode.db'), 'stale-account-local', 'utf8');

    prepareProviderRuntime('opencode', sandboxDir, { HOME: hostHome }, {
      path,
      fs,
      hostHomeDir: hostHome
    });

    const dbLink = path.join(bridgeDataDir, 'opencode.db');
    assert.equal(fs.lstatSync(dbLink).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(dbLink), path.join(sharedDataDir, 'opencode.db'));
    assert.equal(fs.readFileSync(path.join(sharedDataDir, 'opencode.db'), 'utf8'), 'shared-authoritative');
    assert.equal(
      fs.readFileSync(path.join(
        sharedDataDir,
        '.aih-migration-conflicts',
        'acct_1234567890abcdef1234',
        'bridge-data',
        'opencode.db'
      ), 'utf8'),
      'stale-account-local'
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('opencode reconcile migrates legacy data and config even when the runtime bridge is absent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-opencode-legacy-without-bridge-'));
  try {
    const hostHomeDir = path.join(root, 'home');
    const sandboxDir = path.join(root, '.ai_home', 'run', 'auth-projections', 'opencode', 'acct_1234567890abcdef1234');
    const accountDataDir = path.join(sandboxDir, '.local', 'share', 'opencode');
    const projectedConfigDir = path.join(sandboxDir, '.config', 'opencode');
    fs.mkdirSync(accountDataDir, { recursive: true });
    fs.mkdirSync(projectedConfigDir, { recursive: true });
    fs.writeFileSync(path.join(accountDataDir, 'legacy-state.json'), '{"legacy":true}\n', 'utf8');
    fs.writeFileSync(path.join(projectedConfigDir, 'opencode.jsonc'), '{"theme":"dark"}\n', 'utf8');

    const result = reconcileOpenCodeSharedData({ fs, path, sandboxDir, hostHomeDir });

    assert.equal(result.migrated >= 2, true);
    assert.equal(
      fs.readFileSync(path.join(hostHomeDir, '.local', 'share', 'opencode', 'legacy-state.json'), 'utf8'),
      '{"legacy":true}\n'
    );
    assert.equal(
      fs.readFileSync(path.join(hostHomeDir, '.config', 'opencode', 'opencode.jsonc'), 'utf8'),
      '{"theme":"dark"}\n'
    );
    assert.equal(fs.lstatSync(path.join(accountDataDir, 'legacy-state.json')).isSymbolicLink(), true);
    assert.equal(fs.lstatSync(path.join(projectedConfigDir, 'opencode.jsonc')).isSymbolicLink(), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('opencode gateway runtime injects an in-memory overlay without an internal profile', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-opencode-gateway-'));
  try {
    const hostHome = path.join(root, 'home');
    const internalDir = path.join(root, '.ai_home', 'run', 'internal', 'opencode');
    fs.mkdirSync(hostHome, { recursive: true });
    const baseEnv = {
      HOME: hostHome,
      AIH_OPENCODE_GATEWAY_BASE_URL: 'http://127.0.0.1:9527/v1',
      AIH_OPENCODE_GATEWAY_KEY: 'dummy'
    };
    prepareProviderRuntime('opencode', hostHome, baseEnv, {
      path,
      fs,
      hostHomeDir: hostHome,
      materializeAuth: false
    });

    const env = buildProviderRuntimeEnv('opencode', hostHome, baseEnv, {
      path, fs, hostHomeDir: hostHome, platform: 'linux'
    });
    const overlay = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
    assert.equal(overlay.provider.anthropic.options.baseURL, 'http://127.0.0.1:9527/v1');
    assert.equal(overlay.provider.anthropic.options.apiKey, 'dummy');
    assert.equal(Object.keys(overlay.provider.anthropic.models).length > 0, true);
    assert.equal(env.OPENCODE_CONFIG, undefined);
    assert.equal(env.XDG_CONFIG_HOME, path.join(hostHome, '.config'));
    assert.equal(env.XDG_DATA_HOME, path.join(hostHome, '.local', 'share'));
    assert.equal(fs.existsSync(internalDir), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('opencode account runtime gets no gateway overlay and still scrubs OPENCODE_CONFIG', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-opencode-plain-'));
  try {
    const hostHome = path.join(root, 'home');
    const sandboxDir = path.join(root, '.ai_home', 'run', 'auth-projections', 'opencode', 'acct_1234567890abcdef1234');
    fs.mkdirSync(sandboxDir, { recursive: true });
    const baseEnv = { HOME: hostHome, OPENCODE_CONFIG: '/stray/host/opencode.json' };
    prepareProviderRuntime('opencode', sandboxDir, baseEnv, { path, fs, hostHomeDir: hostHome });
    assert.equal(fs.existsSync(path.join(sandboxDir, '.aih-opencode-gateway.json')), false);
    const env = buildProviderRuntimeEnv('opencode', sandboxDir, baseEnv, {
      path, fs, hostHomeDir: hostHome, platform: 'linux'
    });
    assert.equal(env.OPENCODE_CONFIG, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- runtime env composition ----

test('runtime env: normalizes missing and POSIX C locales to UTF-8', () => {
  const env = buildProviderRuntimeEnv('codex', '/home/u/.ai_home/run/auth-projections/codex/acct_1234567890abcdef1234', {
    HOME: '/home/u',
    LANG: 'C'
  }, { path, platform: 'linux' });

  assert.equal(env.LANG, 'C.UTF-8');
  assert.equal(env.LC_CTYPE, 'C.UTF-8');
  assert.equal(env.LC_ALL, 'C.UTF-8');
});

test('runtime env: preserves existing UTF-8 locale values', () => {
  const env = normalizeUtf8LocaleEnv({
    LANG: 'zh_CN.UTF-8',
    LC_CTYPE: 'en_US.UTF-8'
  }, { platform: 'linux' });

  assert.equal(env.LANG, 'zh_CN.UTF-8');
  assert.equal(env.LC_CTYPE, 'en_US.UTF-8');
  assert.equal(env.LC_ALL, 'en_US.UTF-8');
});

test('runtime env: corrects non-UTF-8 LC_ALL because it overrides LANG', () => {
  const env = normalizeUtf8LocaleEnv({
    LANG: 'en_US.UTF-8',
    LC_ALL: 'C'
  }, { platform: 'linux' });

  assert.equal(env.LANG, 'en_US.UTF-8');
  assert.equal(env.LC_CTYPE, 'en_US.UTF-8');
  assert.equal(env.LC_ALL, 'en_US.UTF-8');
});

test('runtime env: adds Windows UTF-8 process knobs without dropping locale', () => {
  const env = normalizeUtf8LocaleEnv({
    LANG: 'C'
  }, { platform: 'win32' });

  assert.equal(env.LANG, 'C.UTF-8');
  assert.equal(env.LC_CTYPE, 'C.UTF-8');
  assert.equal(env.LC_ALL, 'C.UTF-8');
  assert.equal(env.PYTHONUTF8, '1');
  assert.equal(env.PYTHONIOENCODING, 'utf-8');
});

test('runtime env: prefers zh_CN UTF-8 for macOS tmux, SSH and Warp CJK rendering', () => {
  const tmuxEnv = normalizeUtf8LocaleEnv({
    LANG: 'C.UTF-8'
  }, { platform: 'darwin' });
  assert.equal(tmuxEnv.LANG, 'zh_CN.UTF-8');
  assert.equal(tmuxEnv.LC_CTYPE, 'zh_CN.UTF-8');
  assert.equal(tmuxEnv.LC_ALL, 'zh_CN.UTF-8');

  const sshEnv = normalizeUtf8LocaleEnv({
    LANG: 'C.UTF-8',
    SSH_CONNECTION: '127.0.0.1 50000 127.0.0.1 22'
  }, { platform: 'darwin' });
  assert.equal(sshEnv.LANG, 'zh_CN.UTF-8');
  assert.equal(sshEnv.LC_CTYPE, 'zh_CN.UTF-8');
  assert.equal(sshEnv.LC_ALL, 'zh_CN.UTF-8');

  const warpEnv = normalizeUtf8LocaleEnv({
    LANG: 'en_US.UTF-8',
    TERM_PROGRAM: 'WarpTerminal'
  }, { platform: 'darwin' });
  assert.equal(warpEnv.LANG, 'zh_CN.UTF-8');
  assert.equal(warpEnv.LC_CTYPE, 'zh_CN.UTF-8');
  assert.equal(warpEnv.LC_ALL, 'zh_CN.UTF-8');

  const nestedTmuxEnv = normalizeUtf8LocaleEnv({
    LANG: 'en_US.UTF-8',
    TERM_PROGRAM: 'tmux'
  }, { platform: 'darwin' });
  assert.equal(nestedTmuxEnv.LANG, 'zh_CN.UTF-8');
  assert.equal(nestedTmuxEnv.LC_CTYPE, 'zh_CN.UTF-8');
  assert.equal(nestedTmuxEnv.LC_ALL, 'zh_CN.UTF-8');
});

test('runtime env: keeps macOS English locale when CJK override is disabled', () => {
  const env = normalizeUtf8LocaleEnv({
    LANG: 'en_US.UTF-8',
    TERM_PROGRAM: 'tmux',
    AIH_CJK_LOCALE: '0'
  }, { platform: 'darwin' });

  assert.equal(env.LANG, 'en_US.UTF-8');
  assert.equal(env.LC_CTYPE, 'en_US.UTF-8');
  assert.equal(env.LC_ALL, 'en_US.UTF-8');
});

test('runtime env: codex uses explicit host home without profile-path compatibility inference', () => {
  const profileDir = '/home/u/.ai_home/run/auth-projections/codex/acct_0123456789abcdefabcd';
  const env = buildProviderRuntimeEnv('codex', profileDir, {
    HOME: '/isolated/codex-home',
    USERPROFILE: '/isolated/codex-home',
    XDG_CONFIG_HOME: '/isolated/codex-home',
    CLAUDE_CONFIG_DIR: '/leaked/claude',
    GEMINI_CLI_HOME: '/leaked/gemini',
    OPENAI_BASE_URL: 'https://leak.example.com'
  }, { path, hostHomeDir: '/home/u' });

  assert.equal(env.HOME, '/home/u');
  assert.equal(env.USERPROFILE, '/home/u');
  assert.equal(env.XDG_CONFIG_HOME, '/isolated/codex-home');
  assert.equal(env.CODEX_HOME, path.join(profileDir, '.codex'));
  assert.equal(env.CODEX_SQLITE_HOME, path.join('/home/u', '.codex'));
  assert.equal(Object.prototype.hasOwnProperty.call(env, 'CLAUDE_CONFIG_DIR'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(env, 'GEMINI_CLI_HOME'), false);
  assert.equal(env.OPENAI_BASE_URL, undefined);
});

test('runtime env: account credentials override stripped host credentials', () => {
  const profileDir = '/home/u/.ai_home/run/auth-projections/codex/acct_0123456789abcdefabcd';
  const env = buildProviderRuntimeEnv('codex', profileDir, {
    HOME: '/home/u',
    OPENAI_API_KEY: 'host-key',
    OPENAI_BASE_URL: 'https://host.example.com/v1'
  }, {
    path,
    hostHomeDir: '/home/u',
    accountEnv: {
      OPENAI_API_KEY: 'account-key',
      OPENAI_BASE_URL: 'https://account.example.com/v1'
    }
  });

  assert.equal(env.OPENAI_API_KEY, 'account-key');
  assert.equal(env.OPENAI_BASE_URL, 'https://account.example.com/v1');
  assert.equal(env.CODEX_HOME, path.join('/home/u', '.codex'));
});

test('runtime env: gemini uses host HOME with per-account credential dir', () => {
  const profileDir = '/home/u/.ai_home/run/auth-projections/gemini/acct_1234567890abcdef1234';
  const env = buildProviderRuntimeEnv('gemini', profileDir, {
    HOME: '/home/u'
  }, { path });

  assert.equal(env.HOME, '/home/u');
  assert.equal(env.GEMINI_CLI_HOME, path.join(profileDir, '.gemini'));
  assert.equal(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, path.join(profileDir, '.gemini', 'settings.json'));
  assert.equal(Object.prototype.hasOwnProperty.call(env, 'XDG_CONFIG_HOME'), false);
});

test('runtime env: agy remains fake-HOME but redirects regenerable caches', () => {
  const profileDir = '/home/u/.ai_home/run/auth-projections/agy/acct_1234567890abcdef1234';
  const env = buildProviderRuntimeEnv('agy', profileDir, {
    HOME: '/home/u'
  }, { path });

  assert.equal(env.HOME, profileDir);
  assert.equal(env.USERPROFILE, profileDir);
  const runtimeHome = path.join('/home/u', '.gemini', 'antigravity-cli', '.aih-runtime-home');
  assert.equal(env.XDG_CONFIG_HOME, path.join(runtimeHome, 'xdg', 'config'));
  assert.equal(env.XDG_DATA_HOME, path.join(runtimeHome, 'xdg', 'data'));
  assert.equal(env.XDG_STATE_HOME, path.join(runtimeHome, 'xdg', 'state'));
  assert.equal(env.XDG_CACHE_HOME, path.join(runtimeHome, 'xdg', 'cache'));
  assert.equal(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, path.join(runtimeHome, '.gemini', 'settings.json'));
  assert.equal(env.CARGO_HOME, path.join('/home/u', '.cargo'));
  assert.equal(env.GOPATH, path.join('/home/u', 'go'));
  assert.equal(env.SSH_CLIENT, '127.0.0.1 12345 22');
  assert.equal(Object.prototype.hasOwnProperty.call(env, 'CODEX_HOME'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(env, 'CLAUDE_CONFIG_DIR'), false);
});

test('runtime env: agy redirects Windows roaming and local app data to provider storage', () => {
  const profileDir = 'C:\\Users\\u\\.ai_home\\run\\auth-projections\\agy\\acct_1234567890abcdef1234';
  const hostHomeDir = 'C:\\Users\\u';
  const env = buildProviderRuntimeEnv('agy', profileDir, {
    HOME: hostHomeDir,
    APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local'
  }, {
    path: path.win32,
    platform: 'win32',
    hostHomeDir
  });
  const runtimeHome = path.win32.join(
    hostHomeDir,
    '.gemini',
    'antigravity-cli',
    '.aih-runtime-home'
  );

  assert.equal(env.APPDATA, path.win32.join(runtimeHome, 'AppData', 'Roaming'));
  assert.equal(env.LOCALAPPDATA, path.win32.join(runtimeHome, 'AppData', 'Local'));
});

test('agy runtime preparation does not delete provider resources from the projected HOME', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-agy-prepare-preserves-'));
  const profileDir = path.join(root, '.ai_home', 'run', 'auth-projections', 'agy', 'acct_1234567890abcdef1234');
  const cachePath = path.join(profileDir, 'Library', 'Caches', 'ms-playwright-go', 'version.txt');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, '1.57.0', 'utf8');

  prepareProviderRuntime('agy', profileDir, { HOME: root }, {
    path,
    fs,
    hostHomeDir: root,
    materializeAuth: false,
    installSkill: false
  });

  assert.equal(fs.readFileSync(cachePath, 'utf8'), '1.57.0');
});

test('runtime env: opencode keeps host HOME/config and removes host overrides', () => {
  const profileDir = '/home/u/.ai_home/run/auth-projections/opencode/acct_1234567890abcdef1234';
  const env = buildProviderRuntimeEnv('opencode', profileDir, {
    HOME: '/home/u',
    OPENCODE_CONFIG: '/host/opencode.json',
    OPENCODE_CONFIG_DIR: '/host/opencode',
    OPENCODE_CONFIG_CONTENT: '{"model":"leaked"}',
    OPENCODE_API_KEY: 'sk-host',
    OPENCODE_SERVER_PASSWORD: 'host-server-password'
  }, { path });

  assert.equal(env.HOME, '/home/u');
  assert.equal(env.USERPROFILE, '/home/u');
  assert.equal(env.XDG_CONFIG_HOME, path.join('/home/u', '.config'));
  assert.equal(env.XDG_DATA_HOME, path.join(profileDir, '.local', 'share', 'aih-opencode-runtime'));
  assert.equal(env.XDG_STATE_HOME, path.join('/home/u', '.local', 'state'));
  assert.equal(env.XDG_CACHE_HOME, path.join('/home/u', '.cache'));
  assert.equal(Object.prototype.hasOwnProperty.call(env, 'OPENCODE_CONFIG'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(env, 'OPENCODE_CONFIG_DIR'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(env, 'OPENCODE_CONFIG_CONTENT'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(env, 'OPENCODE_API_KEY'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(env, 'OPENCODE_SERVER_PASSWORD'), false);
});
