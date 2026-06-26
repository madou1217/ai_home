const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getProviderLaunchStrategy } = require('../lib/cli/services/ai-cli/launch-profile');
const { homeRedirectStrategy } = require('../lib/cli/services/ai-cli/launch-profile/home-redirect-strategy');
const { claudeStrategy } = require('../lib/cli/services/ai-cli/launch-profile/claude-strategy');
const { codexStrategy } = require('../lib/cli/services/ai-cli/launch-profile/codex-strategy');
const { geminiStrategy } = require('../lib/cli/services/ai-cli/launch-profile/gemini-strategy');
const { opencodeStrategy } = require('../lib/cli/services/ai-cli/launch-profile/opencode-strategy');
const {
  buildProviderRuntimeEnv,
  normalizeUtf8LocaleEnv,
  prepareProviderRuntime
} = require('../lib/cli/services/ai-cli/provider-runtime-env');

const SANDBOX = '/home/u/.ai_home/profiles/claude/4';
const CODEX_CONFIG = path.join(SANDBOX, '.codex');

function baseCtx(cliName, extra = {}) {
  return { cliName, sandboxDir: SANDBOX, codexConfigDir: CODEX_CONFIG, codexSqliteHome: '', path, ...extra };
}

// ---- registry ----

test('registry maps known providers and defaults to home-redirect', () => {
  assert.equal(getProviderLaunchStrategy('claude'), claudeStrategy);
  assert.equal(getProviderLaunchStrategy('codex'), codexStrategy);
  assert.equal(getProviderLaunchStrategy('gemini'), geminiStrategy);
  assert.equal(getProviderLaunchStrategy('agy'), homeRedirectStrategy);
  assert.equal(getProviderLaunchStrategy('opencode'), opencodeStrategy);
  assert.equal(getProviderLaunchStrategy('unknown'), homeRedirectStrategy);
  assert.equal(getProviderLaunchStrategy(''), homeRedirectStrategy);
});

// ---- home-redirect (agy + default) ----

test('home-redirect: agy injects keychain bypass; codex adds sqlite + unsets base url', () => {
  const agy = homeRedirectStrategy.buildEnvPatch(baseCtx('agy')).set;
  assert.equal(agy.HOME, SANDBOX);
  assert.equal(agy.SSH_CLIENT, '127.0.0.1 12345 22');
  assert.equal(agy.container, 'docker');
  assert.equal(Object.prototype.hasOwnProperty.call(agy, 'CODEX_HOME'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(agy, 'CLAUDE_CONFIG_DIR'), false);

  const codex = homeRedirectStrategy.buildEnvPatch(baseCtx('codex', { codexSqliteHome: '/shared/codex' }));
  assert.equal(codex.set.CODEX_SQLITE_HOME, '/shared/codex');
  assert.deepEqual(codex.unset, ['OPENAI_BASE_URL']);

  const gemini = homeRedirectStrategy.buildEnvPatch(baseCtx('gemini')).set;
  assert.ok(!('SSH_CLIENT' in gemini));
});

test('home-redirect: redirects regenerable caches to the shared host home', () => {
  const HOST = '/home/u';
  const { set } = homeRedirectStrategy.buildEnvPatch(baseCtx('agy', { hostHomeDir: HOST }));
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

test('home-redirect: no cache redirect when host home unknown', () => {
  const { set } = homeRedirectStrategy.buildEnvPatch(baseCtx('agy'));
  assert.ok(!('CARGO_HOME' in set) && !('GOPATH' in set) && !('XDG_CACHE_HOME' in set));
});

test('home-redirect prepare trims regenerable caches, never identity/state', () => {
  const appSupport = path.join(SANDBOX, 'Library', 'Application Support');
  const geminiDir = path.join(SANDBOX, '.gemini');
  const removed = [];
  const fakeFs = {
    rmSync: (p) => removed.push(p),
    readdirSync: (p) => {
      if (p === geminiDir) return ['projects.json.123.tmp', 'projects.json', 'oauth_creds.json'];
      if (p === appSupport) return ['Antigravity'];
      throw new Error('ENOENT');
    }
  };
  homeRedirectStrategy.prepare(baseCtx('agy', { fs: fakeFs }));

  // OS cache bucket + Electron per-app caches are trimmed
  assert.ok(removed.includes(path.join(SANDBOX, 'Library', 'Caches')));
  assert.ok(removed.includes(path.join(appSupport, 'Antigravity', 'Cache')));
  assert.ok(removed.includes(path.join(appSupport, 'Antigravity', 'GPUCache')));
  assert.ok(removed.includes(path.join(geminiDir, 'projects.json.123.tmp')));

  // identity/state paths are NEVER touched
  for (const p of removed) {
    assert.ok(!/User$|globalStorage|Local Storage|IndexedDB|oauth_creds|\.codex|\.claude/.test(p), `must not remove ${p}`);
    assert.notEqual(p, geminiDir);
  }
});

test('home-redirect prepare is a safe no-op without a usable fs', () => {
  assert.doesNotThrow(() => homeRedirectStrategy.prepare(baseCtx('agy')));
  assert.doesNotThrow(() => homeRedirectStrategy.prepare(baseCtx('agy', { fs: {} })));
});

// ---- claude: per-account CLAUDE_CONFIG_DIR, real HOME, no env-token ----

test('claude: per-account CLAUDE_CONFIG_DIR, no HOME override, no injected token', () => {
  const { set, unset } = claudeStrategy.buildEnvPatch(baseCtx('claude'));
  assert.deepEqual(set, { CLAUDE_CONFIG_DIR: path.join(SANDBOX, '.claude') });
  // HOME stays real (fixes the doctor bug); never inject a static OAuth token
  // (it would bypass Claude's own refresh and die on expiry).
  assert.ok(!('HOME' in set) && !('CLAUDE_CODE_OAUTH_TOKEN' in set));
  assert.deepEqual(unset, []);
});

test('claude: api credential accounts keep shared session config dir', () => {
  const { set, unset } = claudeStrategy.buildEnvPatch(baseCtx('claude', {
    baseEnv: {
      ANTHROPIC_API_KEY: 'sk-test',
      ANTHROPIC_BASE_URL: 'https://relay.example.com'
    }
  }));
  assert.deepEqual(set, { CLAUDE_CONFIG_DIR: path.join(SANDBOX, '.claude') });
  assert.deepEqual(unset, []);
});

test('claude: auth-token accounts keep shared session config dir', () => {
  const { set } = claudeStrategy.buildEnvPatch(baseCtx('claude', {
    baseEnv: {
      ANTHROPIC_AUTH_TOKEN: 'sk-token'
    }
  }));
  assert.deepEqual(set, { CLAUDE_CONFIG_DIR: path.join(SANDBOX, '.claude') });
});

test('claude prepare removes account-owned oauth artifacts only for api credential accounts', () => {
  const calls = [];
  const fakeFs = {
    mkdirSync: (target, options) => calls.push(['mkdir', target, options]),
    rmSync: (target, options) => calls.push(['rm', target, options])
  };

  claudeStrategy.prepare(baseCtx('claude', {
    baseEnv: { ANTHROPIC_API_KEY: 'sk-test' },
    fs: fakeFs
  }));

  assert.deepEqual(calls, [
    ['mkdir', path.join(SANDBOX, '.claude'), { recursive: true }],
    ['rm', path.join(SANDBOX, '.claude', '.credentials.json'), { force: true }]
  ]);

  calls.length = 0;
  claudeStrategy.prepare(baseCtx('claude', { fs: fakeFs }));
  assert.deepEqual(calls, []);
});

// ---- codex: per-account CODEX_HOME + shared sessions, no HOME/XDG ----

test('codex: per-account CODEX_HOME + shared CODEX_SQLITE_HOME, no HOME/XDG', () => {
  const { set, unset } = codexStrategy.buildEnvPatch(baseCtx('codex', { codexSqliteHome: '/home/u/.codex' }));
  assert.deepEqual(set, { CODEX_HOME: CODEX_CONFIG, CODEX_SQLITE_HOME: '/home/u/.codex' });
  assert.ok(!('HOME' in set) && !('XDG_CONFIG_HOME' in set) && !('CLAUDE_CONFIG_DIR' in set));
  assert.deepEqual(unset, ['OPENAI_BASE_URL']);
});

test('codex: omits CODEX_SQLITE_HOME when unavailable', () => {
  assert.deepEqual(codexStrategy.buildEnvPatch(baseCtx('codex')).set, { CODEX_HOME: CODEX_CONFIG });
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
    const sandboxDir = path.join(root, '.ai_home', 'profiles', 'opencode', '1');
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

test('opencode prepare rejects bridge auth conflicts instead of splitting truth', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-opencode-bridge-conflict-'));
  try {
    const hostHome = path.join(root, 'home');
    const sandboxDir = path.join(root, '.ai_home', 'profiles', 'opencode', '1');
    const bridgeDataDir = path.join(sandboxDir, '.local', 'share', 'aih-opencode-runtime', 'opencode');
    fs.mkdirSync(bridgeDataDir, { recursive: true });
    fs.writeFileSync(path.join(bridgeDataDir, 'auth.json'), '{"split":true}\n', 'utf8');

    assert.throws(
      () => prepareProviderRuntime('opencode', sandboxDir, { HOME: hostHome }, {
        path,
        fs,
        hostHomeDir: hostHome
      }),
      /opencode_auth_bridge_conflict/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('opencode prepare rejects shared data conflicts instead of using account-local db', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-opencode-shared-conflict-'));
  try {
    const hostHome = path.join(root, 'home');
    const sandboxDir = path.join(root, '.ai_home', 'profiles', 'opencode', '1');
    const bridgeDataDir = path.join(sandboxDir, '.local', 'share', 'aih-opencode-runtime', 'opencode');
    fs.mkdirSync(bridgeDataDir, { recursive: true });
    fs.mkdirSync(path.join(bridgeDataDir, 'storage'), { recursive: true });

    assert.throws(
      () => prepareProviderRuntime('opencode', sandboxDir, { HOME: hostHome }, {
        path,
        fs,
        hostHomeDir: hostHome
      }),
      /opencode_shared_bridge_conflict/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- runtime env composition ----

test('runtime env: normalizes missing and POSIX C locales to UTF-8', () => {
  const env = buildProviderRuntimeEnv('codex', '/home/u/.ai_home/profiles/codex/1', {
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

test('runtime env: codex corrects inherited fake HOME back to host home', () => {
  const profileDir = '/home/u/.ai_home/profiles/codex/1';
  const env = buildProviderRuntimeEnv('codex', profileDir, {
    HOME: '/home/u/.ai_home/profiles/codex/99',
    USERPROFILE: '/home/u/.ai_home/profiles/codex/99',
    XDG_CONFIG_HOME: '/home/u/.ai_home/profiles/codex/99',
    CLAUDE_CONFIG_DIR: '/leaked/claude',
    GEMINI_CLI_HOME: '/leaked/gemini',
    OPENAI_BASE_URL: 'https://leak.example.com'
  }, { path });

  assert.equal(env.HOME, '/home/u');
  assert.equal(env.USERPROFILE, '/home/u');
  assert.equal(env.XDG_CONFIG_HOME, path.join('/home/u', '.config'));
  assert.equal(env.CODEX_HOME, path.join(profileDir, '.codex'));
  assert.equal(env.CODEX_SQLITE_HOME, path.join('/home/u', '.codex'));
  assert.equal(Object.prototype.hasOwnProperty.call(env, 'CLAUDE_CONFIG_DIR'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(env, 'GEMINI_CLI_HOME'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(env, 'OPENAI_BASE_URL'), false);
});

test('runtime env: gemini uses host HOME with per-account credential dir', () => {
  const profileDir = '/home/u/.ai_home/profiles/gemini/1';
  const env = buildProviderRuntimeEnv('gemini', profileDir, {
    HOME: '/home/u'
  }, { path });

  assert.equal(env.HOME, '/home/u');
  assert.equal(env.GEMINI_CLI_HOME, path.join(profileDir, '.gemini'));
  assert.equal(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, path.join(profileDir, '.gemini', 'settings.json'));
  assert.equal(Object.prototype.hasOwnProperty.call(env, 'XDG_CONFIG_HOME'), false);
});

test('runtime env: agy remains fake-HOME but redirects regenerable caches', () => {
  const profileDir = '/home/u/.ai_home/profiles/agy/1';
  const env = buildProviderRuntimeEnv('agy', profileDir, {
    HOME: '/home/u'
  }, { path });

  assert.equal(env.HOME, profileDir);
  assert.equal(env.USERPROFILE, profileDir);
  assert.equal(env.XDG_CONFIG_HOME, profileDir);
  assert.equal(env.XDG_CACHE_HOME, path.join('/home/u', '.cache'));
  assert.equal(env.CARGO_HOME, path.join('/home/u', '.cargo'));
  assert.equal(env.GOPATH, path.join('/home/u', 'go'));
  assert.equal(env.SSH_CLIENT, '127.0.0.1 12345 22');
  assert.equal(Object.prototype.hasOwnProperty.call(env, 'CODEX_HOME'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(env, 'CLAUDE_CONFIG_DIR'), false);
});

test('runtime env: opencode keeps host HOME/config and removes host overrides', () => {
  const profileDir = '/home/u/.ai_home/profiles/opencode/1';
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
