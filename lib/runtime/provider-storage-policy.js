'use strict';

const path = require('node:path');

const PROVIDER_RUNTIME_HOME_DIR = '.aih-runtime-home';
const ACCOUNT_PRIVATE_DESKTOP_USER_DATA = Object.freeze({
  path: Object.freeze(['electron-user-data'])
});

/**
 * Provider-owned persistent state is account-independent. Account projections
 * may contain credentials, but every resource/session/cache path below must
 * resolve to the provider's native host directory.
 */
const PROVIDER_STORAGE_POLICIES = Object.freeze({
  codex: Object.freeze({
    authArtifacts: Object.freeze([
      Object.freeze({ field: 'auth', path: Object.freeze(['.codex', 'auth.json']), format: 'json' })
    ]),
    privateArtifacts: Object.freeze([
      ACCOUNT_PRIVATE_DESKTOP_USER_DATA,
      Object.freeze({ path: Object.freeze(['.codex', 'config.toml']) }),
      Object.freeze({ path: Object.freeze(['Library', 'Keychains']) })
    ]),
    nativeRoot: Object.freeze(['.codex']),
    runtimeHomeRoot: Object.freeze(['.codex', PROVIDER_RUNTIME_HOME_DIR]),
    projectionRoots: Object.freeze([
      Object.freeze({ from: Object.freeze(['.codex']), to: Object.freeze(['.codex']) })
    ]),
    sharedEntries: Object.freeze([
      'sessions',
      'history.jsonl',
      'archived_sessions',
      'shell_snapshots',
      'version.json',
      'models_cache.json',
      '.personality_migration',
      'log',
      'memories',
      'rules',
      'skills',
      'sqlite',
      'prompts',
      'worktrees',
      'automations',
      'backup',
      'vendor_imports',
      'internal_storage.json',
      'AGENTS.md',
      '.tmp',
      'cache',
      'tmp',
      'session_index.jsonl'
    ]),
    precreatedDirectories: Object.freeze([
      'sessions',
      'archived_sessions',
      'shell_snapshots',
      'log',
      'memories',
      'rules',
      'skills',
      'sqlite',
      'prompts',
      'worktrees',
      'automations',
      'backup',
      'vendor_imports',
      '.tmp',
      'cache',
      'tmp'
    ]),
    attachmentSubdir: Object.freeze(['.tmp', 'model', 'images'])
  }),
  claude: Object.freeze({
    authArtifacts: Object.freeze([
      Object.freeze({ field: 'credentials', path: Object.freeze(['.claude', '.credentials.json']), format: 'json' })
    ]),
    privateArtifacts: Object.freeze([
      ACCOUNT_PRIVATE_DESKTOP_USER_DATA,
      Object.freeze({ path: Object.freeze(['Library', 'Keychains']) })
    ]),
    nativeRoot: Object.freeze(['.claude']),
    runtimeHomeRoot: Object.freeze(['.claude', PROVIDER_RUNTIME_HOME_DIR]),
    projectionRoots: Object.freeze([
      Object.freeze({ from: Object.freeze(['.claude']), to: Object.freeze(['.claude']) })
    ]),
    sharedEntries: Object.freeze([]),
    precreatedDirectories: Object.freeze([]),
    attachmentSubdir: Object.freeze(['tmp', 'model', 'images'])
  }),
  gemini: Object.freeze({
    authArtifacts: Object.freeze([
      Object.freeze({ field: 'oauthCreds', path: Object.freeze(['.gemini', 'oauth_creds.json']), format: 'json' }),
      Object.freeze({ field: 'googleAccounts', path: Object.freeze(['.gemini', 'google_accounts.json']), format: 'json', optional: true })
    ]),
    privateArtifacts: Object.freeze([
      Object.freeze({ path: Object.freeze(['Library', 'Keychains']) })
    ]),
    nativeRoot: Object.freeze(['.gemini']),
    runtimeHomeRoot: Object.freeze(['.gemini', PROVIDER_RUNTIME_HOME_DIR]),
    projectionRoots: Object.freeze([
      Object.freeze({ from: Object.freeze(['.gemini']), to: Object.freeze(['.gemini']) })
    ]),
    sharedEntries: Object.freeze(['history', 'projects.json', 'tmp']),
    precreatedDirectories: Object.freeze(['history', 'tmp']),
    attachmentSubdir: Object.freeze(['tmp', 'model', 'images'])
  }),
  agy: Object.freeze({
    authArtifacts: Object.freeze([
      Object.freeze({
        field: 'oauthToken',
        path: Object.freeze(['.gemini', 'antigravity-cli', 'antigravity-oauth-token']),
        format: 'json'
      }),
      // AGY Desktop passes --app_data_dir antigravity to language_server, but
      // its file-token fallback uses the standalone token at the Gemini home
      // root. The CLI keeps its canonical file under antigravity-cli.
      Object.freeze({
        field: 'desktopOauthToken',
        path: Object.freeze(['.gemini', 'jetski-standalone-oauth-token']),
        format: 'json',
        optional: true,
        derived: true
      }),
      Object.freeze({
        field: 'email',
        path: Object.freeze(['.gemini', 'antigravity-cli', 'email.cache']),
        format: 'text',
        optional: true
      }),
      // AGY Desktop 2.x also reads the generic Gemini OAuth projection under
      // HOME. These are derived from oauthToken/email by native-auth-projection.
      Object.freeze({
        field: 'oauthCreds',
        path: Object.freeze(['.gemini', 'oauth_creds.json']),
        format: 'json',
        optional: true,
        derived: true
      }),
      Object.freeze({
        field: 'googleAccounts',
        path: Object.freeze(['.gemini', 'google_accounts.json']),
        format: 'json',
        optional: true,
        derived: true
      })
    ]),
    privateArtifacts: Object.freeze([
      ACCOUNT_PRIVATE_DESKTOP_USER_DATA,
      // AGY runs with a fake HOME. Keychains are identity-bearing and must
      // remain account-owned even though the rest of Library is provider-shared.
      Object.freeze({ path: Object.freeze(['Library', 'Keychains']) })
    ]),
    nativeRoot: Object.freeze(['.gemini', 'antigravity-cli']),
    runtimeHomeRoot: Object.freeze([
      '.gemini',
      'antigravity-cli',
      PROVIDER_RUNTIME_HOME_DIR
    ]),
    projectionRoots: Object.freeze([
      Object.freeze({
        from: Object.freeze(['.gemini', 'antigravity-cli']),
        to: Object.freeze(['.gemini', 'antigravity-cli'])
      }),
      Object.freeze({
        from: Object.freeze(['.gemini', 'config']),
        to: Object.freeze(['.gemini', 'config'])
      }),
      Object.freeze({
        from: Object.freeze(['.gemini', 'GEMINI.md']),
        to: Object.freeze(['.gemini', 'GEMINI.md'])
      }),
      Object.freeze({
        from: Object.freeze(['.gemini']),
        to: Object.freeze(['.gemini', 'antigravity-cli', PROVIDER_RUNTIME_HOME_DIR, '.gemini'])
      }),
      Object.freeze({
        from: Object.freeze(['Library']),
        to: Object.freeze(['.gemini', 'antigravity-cli', PROVIDER_RUNTIME_HOME_DIR, 'Library'])
      }),
      Object.freeze({
        from: Object.freeze(['.local', 'share']),
        to: Object.freeze(['.gemini', 'antigravity-cli', PROVIDER_RUNTIME_HOME_DIR, 'xdg', 'data'])
      }),
      Object.freeze({
        from: Object.freeze(['.local', 'state']),
        to: Object.freeze(['.gemini', 'antigravity-cli', PROVIDER_RUNTIME_HOME_DIR, 'xdg', 'state'])
      }),
      Object.freeze({
        from: Object.freeze(['.cache']),
        to: Object.freeze(['.gemini', 'antigravity-cli', PROVIDER_RUNTIME_HOME_DIR, 'xdg', 'cache'])
      }),
      Object.freeze({
        from: Object.freeze(['.config']),
        to: Object.freeze(['.gemini', 'antigravity-cli', PROVIDER_RUNTIME_HOME_DIR, 'xdg', 'config'])
      }),
      Object.freeze({
        from: Object.freeze(['AppData', 'Roaming']),
        to: Object.freeze(['.gemini', 'antigravity-cli', PROVIDER_RUNTIME_HOME_DIR, 'AppData', 'Roaming'])
      }),
      Object.freeze({
        from: Object.freeze(['AppData', 'Local']),
        to: Object.freeze(['.gemini', 'antigravity-cli', PROVIDER_RUNTIME_HOME_DIR, 'AppData', 'Local'])
      }),
      Object.freeze({
        // Keep arbitrary $HOME children in their own namespace. Mapping them
        // into xdg/config would collapse `$HOME/foo` and `$HOME/.config/foo`.
        from: Object.freeze([]),
        to: Object.freeze(['.gemini', 'antigravity-cli', PROVIDER_RUNTIME_HOME_DIR, 'home'])
      })
    ]),
    sharedEntries: Object.freeze([
      'brain',
      'conversations',
      'knowledge',
      'scratch',
      'implicit',
      'builtin',
      'cache',
      'log',
      'bin',
      'updater'
    ]),
    precreatedDirectories: Object.freeze([
      'brain',
      'conversations',
      'knowledge',
      'scratch',
      'implicit',
      'builtin',
      'cache',
      'log',
      'bin',
      'updater'
    ]),
    attachmentSubdir: Object.freeze(['tmp', 'model', 'images'])
  }),
  opencode: Object.freeze({
    authArtifacts: Object.freeze([
      Object.freeze({
        field: 'auth',
        path: Object.freeze(['.local', 'share', 'opencode', 'auth.json']),
        format: 'json'
      })
    ]),
    privateArtifacts: Object.freeze([
      ACCOUNT_PRIVATE_DESKTOP_USER_DATA,
      // OpenCode reads account auth through the disposable XDG bridge. This is
      // an alias of the auth artifact above, never provider-shared state.
      Object.freeze({
        path: Object.freeze(['.local', 'share', 'aih-opencode-runtime', 'opencode', 'auth.json'])
      }),
      // Older layouts may have left credential backups under the projected
      // config root. Keep the exact auth basename account-private there too.
      Object.freeze({
        path: Object.freeze(['.config', 'opencode', 'auth.json'])
      }),
      Object.freeze({ path: Object.freeze(['Library', 'Keychains']) })
    ]),
    nativeRoot: Object.freeze(['.local', 'share', 'opencode']),
    runtimeHomeRoot: Object.freeze([
      '.local',
      'share',
      'opencode',
      PROVIDER_RUNTIME_HOME_DIR
    ]),
    projectionRoots: Object.freeze([
      Object.freeze({
        from: Object.freeze(['.local', 'share', 'aih-opencode-runtime', 'opencode']),
        to: Object.freeze(['.local', 'share', 'opencode'])
      }),
      Object.freeze({
        from: Object.freeze(['.local', 'share', 'opencode']),
        to: Object.freeze(['.local', 'share', 'opencode'])
      }),
      Object.freeze({
        from: Object.freeze(['.config', 'opencode']),
        to: Object.freeze(['.config', 'opencode'])
      })
    ]),
    sharedEntries: Object.freeze([]),
    precreatedDirectories: Object.freeze([]),
    attachmentSubdir: Object.freeze(['tmp', 'model', 'images'])
  }),
  grok: Object.freeze({
    hostAuthRoot: Object.freeze([]),
    authArtifacts: Object.freeze([
      Object.freeze({ field: 'auth', path: Object.freeze(['.grok', 'auth.json']), format: 'json' })
    ]),
    privateArtifacts: Object.freeze([
      Object.freeze({ path: Object.freeze(['Library', 'Keychains']) })
    ]),
    nativeRoot: Object.freeze(['.grok']),
    runtimeHomeRoot: Object.freeze(['.grok', PROVIDER_RUNTIME_HOME_DIR]),
    projectionRoots: Object.freeze([
      Object.freeze({ from: Object.freeze(['.grok']), to: Object.freeze(['.grok']) })
    ]),
    sharedEntries: Object.freeze(['sessions', 'cache', 'log']),
    precreatedDirectories: Object.freeze(['sessions', 'cache', 'log']),
    attachmentSubdir: Object.freeze(['tmp', 'model', 'images'])
  }),
  kimi: Object.freeze({
    // Kimi's native home is the directory selected by KIMI_CODE_HOME. Keep
    // the policy paths relative to the host HOME so the same artifact contract
    // works for both the real host home and an account projection.
    hostAuthRoot: Object.freeze([]),
    authArtifacts: Object.freeze([
      Object.freeze({
        field: 'credentials',
        path: Object.freeze(['.kimi-code', 'credentials', 'kimi-code.json']),
        format: 'json'
      }),
      Object.freeze({
        field: 'deviceId',
        path: Object.freeze(['.kimi-code', 'device_id']),
        format: 'text',
        optional: true
      })
    ]),
    privateArtifacts: Object.freeze([
      ACCOUNT_PRIVATE_DESKTOP_USER_DATA,
      Object.freeze({ path: Object.freeze(['.kimi-code', 'config.toml']) }),
      Object.freeze({ path: Object.freeze(['.kimi-code', 'credentials']) }),
      // The session index is a per-account view: kimi filters index entries by
      // a string-prefix check against its own KIMI_CODE_HOME/sessions, so a
      // shared index makes other accounts' sessions visible but unresumable
      // (session.not_found). aih regenerates each account's index from the
      // shared host index with sessionDir rewritten to this projection; the
      // sessions directory itself stays provider-shared (single physical copy).
      Object.freeze({ path: Object.freeze(['.kimi-code', 'session_index.jsonl']) })
    ]),
    nativeRoot: Object.freeze(['.kimi-code']),
    runtimeHomeRoot: Object.freeze(['.kimi-code', PROVIDER_RUNTIME_HOME_DIR]),
    projectionRoots: Object.freeze([
      Object.freeze({
        from: Object.freeze(['.kimi-code']),
        to: Object.freeze(['.kimi-code'])
      })
    ]),
    sharedEntries: Object.freeze([
      'sessions',
      'cache',
      'logs',
      'user-history',
      'updates',
      'workspace-trust',
      'bin',
      'telemetry',
      'oauth',
      'tui.toml',
      'workspaces.json',
      'migrations-effort.json'
    ]),
    precreatedDirectories: Object.freeze([
      'sessions',
      'cache',
      'logs',
      'user-history',
      'updates',
      'workspace-trust',
      'bin',
      'telemetry'
    ]),
    attachmentSubdir: Object.freeze(['tmp', 'model', 'images'])
  }),
  // ZCode data root is selected by ZCODE_DATA_BASE_DIR. v2/ holds the shared
  // credential store and provider registry (account-private); cli/ and
  // workspace/ hold session state that stays provider-shared from the host.
  // The actual link work lives in launch-profile/zcode-shared-session-store.js
  // (runs from zcodeStrategy.prepare on every launch): tasks-index.sqlite(+-wal/-shm),
  // v2/sessions, v2/session-bindings, v2/checkpoints, cli/, workspace/,
  // plugin-workspace/ are linked into the host ~/.zcode; credentials.json,
  // config.json, setting.json stay per-account.
  zcode: Object.freeze({
    hostAuthRoot: Object.freeze([]),
    authArtifacts: Object.freeze([
      Object.freeze({
        field: 'credentials',
        path: Object.freeze(['.zcode', 'v2', 'credentials.json']),
        format: 'json'
      }),
      Object.freeze({
        field: 'config',
        path: Object.freeze(['.zcode', 'v2', 'config.json']),
        format: 'json',
        optional: true
      })
    ]),
    privateArtifacts: Object.freeze([
      ACCOUNT_PRIVATE_DESKTOP_USER_DATA,
      Object.freeze({ path: Object.freeze(['Library', 'Keychains']) })
    ]),
    nativeRoot: Object.freeze(['.zcode']),
    runtimeHomeRoot: Object.freeze(['.zcode', PROVIDER_RUNTIME_HOME_DIR]),
    projectionRoots: Object.freeze([
      Object.freeze({ from: Object.freeze(['.zcode']), to: Object.freeze(['.zcode']) })
    ]),
    sharedEntries: Object.freeze(['cli', 'workspace']),
    precreatedDirectories: Object.freeze(['cli', 'workspace']),
    attachmentSubdir: Object.freeze(['tmp', 'model', 'images'])
  }),
  // Kiro CLI persists OAuth and session state in one SQLite database. AIH
  // redirects the CLI's database path into the account projection directory.
  kiro: Object.freeze({
    hostAuthRoot: Object.freeze(['.local', 'share', 'kiro-cli']),
    authArtifacts: Object.freeze([
      Object.freeze({
        field: 'database',
        path: Object.freeze(['data.sqlite3']),
        format: 'binary-base64'
      })
    ]),
    privateArtifacts: Object.freeze([
      ACCOUNT_PRIVATE_DESKTOP_USER_DATA,
      Object.freeze({ path: Object.freeze(['.kiro']) })
    ]),
    nativeRoot: Object.freeze([]),
    runtimeHomeRoot: Object.freeze([PROVIDER_RUNTIME_HOME_DIR]),
    projectionRoots: Object.freeze([
      Object.freeze({ from: Object.freeze([]), to: Object.freeze([]) })
    ]),
    sharedEntries: Object.freeze([]),
    precreatedDirectories: Object.freeze(['.kiro']),
    attachmentSubdir: Object.freeze(['tmp', 'model', 'images'])
  }),  // Qoder global: --config-dir points at the user-level config root itself,
  // so auth is written directly under <runtimeDir>/.auth/.
  qoder: Object.freeze({
    hostAuthRoot: Object.freeze(['.qoder']),
    authArtifacts: Object.freeze([
      Object.freeze({
        field: 'credentials',
        path: Object.freeze(['.auth', 'user']),
        format: 'text'
      }),
      Object.freeze({
        field: 'machineId',
        path: Object.freeze(['.auth', 'machine_id']),
        format: 'text',
        optional: true
      }),
      Object.freeze({
        field: 'dnsCache',
        path: Object.freeze(['.cache', 'dns-cache.json']),
        format: 'json',
        optional: true
      })
    ]),
    privateArtifacts: Object.freeze([
      ACCOUNT_PRIVATE_DESKTOP_USER_DATA,
      Object.freeze({ path: Object.freeze(['.auth']) }),
      Object.freeze({ path: Object.freeze(['Library', 'Keychains']) })
    ]),
    nativeRoot: Object.freeze([]),
    runtimeHomeRoot: Object.freeze([PROVIDER_RUNTIME_HOME_DIR]),
    projectionRoots: Object.freeze([
      Object.freeze({ from: Object.freeze([]), to: Object.freeze([]) })
    ]),
    sharedEntries: Object.freeze([]),
    precreatedDirectories: Object.freeze(['.auth', 'logs', '.cache']),
    attachmentSubdir: Object.freeze(['tmp', 'model', 'images'])
  }),
  // Qoder CN uses the same config-root-relative layout as global Qoder.
  qodercn: Object.freeze({
    hostAuthRoot: Object.freeze(['.qoder-cn']),
    authArtifacts: Object.freeze([
      Object.freeze({
        field: 'credentials',
        path: Object.freeze(['.auth', 'user']),
        format: 'text'
      }),
      Object.freeze({
        field: 'machineId',
        path: Object.freeze(['.auth', 'machine_id']),
        format: 'text',
        optional: true
      }),
      Object.freeze({
        field: 'dnsCache',
        path: Object.freeze(['.cache', 'dns-cache.json']),
        format: 'json',
        optional: true
      })
    ]),
    privateArtifacts: Object.freeze([
      ACCOUNT_PRIVATE_DESKTOP_USER_DATA,
      Object.freeze({ path: Object.freeze(['.auth']) }),
      Object.freeze({ path: Object.freeze(['Library', 'Keychains']) })
    ]),
    nativeRoot: Object.freeze([]),
    runtimeHomeRoot: Object.freeze([PROVIDER_RUNTIME_HOME_DIR]),
    projectionRoots: Object.freeze([
      Object.freeze({ from: Object.freeze([]), to: Object.freeze([]) })
    ]),
    sharedEntries: Object.freeze([]),
    precreatedDirectories: Object.freeze(['.auth', 'logs', '.cache']),
    attachmentSubdir: Object.freeze(['tmp', 'model', 'images'])
  }),
  // CodeBuddy Code（@tencent-ai/codebuddy-code）的原生根目录由环境变量
  // CODEBUDDY_CONFIG_DIR 选择，默认 ~/.codebuddy；CLI 没有 --config-dir 参数，
  // 所以账号隔离只能走 env（见 launch-profile/codebuddy-strategy.js）。
  //
  // 策略里的路径统一相对宿主 HOME，因此同一份 artifact 契约在真实 HOME 与
  // 账号沙箱下都成立：沙箱里 <runtimeDir>/.codebuddy 就是 CLI 的 configDir，
  // 与 kimi 的 <runtimeDir>/.kimi-code 同构。
  //
  // 账号私有：settings.json（user 级权限与开关，跨账号共享会互相覆盖）、
  // .mcp.json（可能内嵌 MCP 凭据）、sessions（后台会话索引含绝对路径）、
  // .credentials.json 保留已有投影形状；内嵌 CLI 的共享 .info 尚未接通捕获，
  // 其 HOME 下 CodeBuddyExtension 目录由启动策略整体隔离，不能仅依赖 configDir。
  // 本轮不向宿主共享任何条目：CLI 完全读 configDir，共享需要额外的链接器，
  // 属于后续迭代（与 qoder / qodercn 的 `sharedEntries: []` 取齐）。
  codebuddy: Object.freeze({
    hostAuthRoot: Object.freeze(['.codebuddy']),
    authArtifacts: Object.freeze([
      Object.freeze({
        field: 'credentials',
        path: Object.freeze(['.codebuddy', '.credentials.json']),
        format: 'json'
      })
    ]),
    privateArtifacts: Object.freeze([
      ACCOUNT_PRIVATE_DESKTOP_USER_DATA,
      Object.freeze({ path: Object.freeze(['.codebuddy', 'settings.json']) }),
      Object.freeze({ path: Object.freeze(['.codebuddy', '.mcp.json']) }),
      Object.freeze({ path: Object.freeze(['.codebuddy', 'sessions']) }),
      Object.freeze({ path: Object.freeze(['Library', 'Keychains']) })
    ]),
    nativeRoot: Object.freeze(['.codebuddy']),
    runtimeHomeRoot: Object.freeze(['.codebuddy', PROVIDER_RUNTIME_HOME_DIR]),
    projectionRoots: Object.freeze([
      Object.freeze({
        from: Object.freeze(['.codebuddy']),
        to: Object.freeze(['.codebuddy'])
      })
    ]),
    sharedEntries: Object.freeze([]),
    // CLI 首启自建这些目录（2026-09-14 用空 configDir 实测）：logs / plugins /
    // local_storage / sessions / shell-snapshots。显式声明可避免首启前的
    // 目录检查把它们当成"未知条目"。
    precreatedDirectories: Object.freeze([
      'logs',
      'plugins',
      'local_storage',
      'sessions',
      'shell-snapshots'
    ]),
    attachmentSubdir: Object.freeze(['tmp', 'model', 'images'])
  }),
  // CodeBuddy 国内站（copilot.tencent.com）。CLI 与国际站是同一个二进制、同一组
  // env 键，但站点是**独立 Provider**（账号体系不互通），所以投影根必须分开：
  // 否则同一台机器上的国内站账号与国际站账号会指向同一个 `.codebuddy`，
  // 违反"一账号一投影"。
  //
  // hostAuthRoot 刻意指向 `.codebuddy-cn` 而不是共用 `.codebuddy`：宿主的
  // `~/.codebuddy` 是"最近一次原生登录"的产物，无法判断它属于哪个站点，
  // 若拿它当国内站的导入源，会把国际站凭据静默导进国内站账号。宁可判不出
  // 宿主来源（走账号自己的 env / 重新登录），也不做错误的身份归因。
  codebuddycn: Object.freeze({
    hostAuthRoot: Object.freeze(['.codebuddy-cn']),
    authArtifacts: Object.freeze([
      Object.freeze({
        field: 'credentials',
        path: Object.freeze(['.codebuddy-cn', '.credentials.json']),
        format: 'json'
      })
    ]),
    privateArtifacts: Object.freeze([
      ACCOUNT_PRIVATE_DESKTOP_USER_DATA,
      Object.freeze({ path: Object.freeze(['.codebuddy-cn', 'settings.json']) }),
      Object.freeze({ path: Object.freeze(['.codebuddy-cn', '.mcp.json']) }),
      Object.freeze({ path: Object.freeze(['.codebuddy-cn', 'sessions']) }),
      Object.freeze({ path: Object.freeze(['Library', 'Keychains']) })
    ]),
    nativeRoot: Object.freeze(['.codebuddy-cn']),
    runtimeHomeRoot: Object.freeze(['.codebuddy-cn', PROVIDER_RUNTIME_HOME_DIR]),
    projectionRoots: Object.freeze([
      Object.freeze({
        from: Object.freeze(['.codebuddy-cn']),
        to: Object.freeze(['.codebuddy-cn'])
      })
    ]),
    sharedEntries: Object.freeze([]),
    precreatedDirectories: Object.freeze([
      'logs',
      'plugins',
      'local_storage',
      'sessions',
      'shell-snapshots'
    ]),
    attachmentSubdir: Object.freeze(['tmp', 'model', 'images'])
  }),
  // WorkBuddy（国内站 workbuddy.cn，bundle id com.tencent.workbuddy.mac）。
  //
  // 原生事实（2026-09-14 实测本机 WorkBuddy.app 5.5.6 的进程 env 与 app.asar）：
  //   - 配置根由 `WORKBUDDY_CONFIG_DIR`（其次 `CODEBUDDY_CONFIG_DIR`）决定，
  //     官方 fallback 是 `~/.workbuddy`。
  //   - Electron userData 根由 `WORKBUDDY_USER_DATA_DIR` 决定（实测
  //     /Users/<user>/.workbuddy/app）——这就是账号隔离要改写的键，
  //     已在 DesktopClient.userDataEnvKey 里声明。
  //   - 主站登录态另存于 HOME 下 CodeBuddyExtension 的共享 .info；本批尚未
  //     接通其捕获/导入，所以 authArtifacts 为空。~/.workbuddy/credentials/
  //     是连接器令牌，不能拿它冒充主站登录凭据。
  workbuddy: Object.freeze({
    hostAuthRoot: Object.freeze(['.workbuddy']),
    authArtifacts: Object.freeze([]),
    privateArtifacts: Object.freeze([
      ACCOUNT_PRIVATE_DESKTOP_USER_DATA,
      Object.freeze({ path: Object.freeze(['Library', 'Keychains']) })
    ]),
    nativeRoot: Object.freeze(['.workbuddy']),
    runtimeHomeRoot: Object.freeze(['.workbuddy', PROVIDER_RUNTIME_HOME_DIR]),
    projectionRoots: Object.freeze([
      Object.freeze({
        from: Object.freeze(['.workbuddy']),
        to: Object.freeze(['.workbuddy'])
      })
    ]),
    sharedEntries: Object.freeze([]),
    precreatedDirectories: Object.freeze([]),
    attachmentSubdir: Object.freeze(['tmp', 'model', 'images'])
  })
});

function normalizeProvider(provider) {
  const value = String(provider || '').trim().toLowerCase();
  return PROVIDER_STORAGE_POLICIES[value] ? value : '';
}

function getProviderStoragePolicy(provider) {
  const normalized = normalizeProvider(provider);
  return normalized ? PROVIDER_STORAGE_POLICIES[normalized] : null;
}

function getProviderAuthArtifacts(provider) {
  const policy = getProviderStoragePolicy(provider);
  return policy ? Array.from(policy.authArtifacts) : [];
}

function getProviderHostAuthRoot(provider) {
  const policy = getProviderStoragePolicy(provider);
  return policy && Array.isArray(policy.hostAuthRoot)
    ? Array.from(policy.hostAuthRoot)
    : null;
}

function getProviderPrivateArtifacts(provider) {
  const policy = getProviderStoragePolicy(provider);
  return policy ? Array.from(policy.privateArtifacts || []) : [];
}

function getProviderProjectionMappings(provider) {
  const policy = getProviderStoragePolicy(provider);
  if (!policy) return [];
  const mappings = Array.from(policy.projectionRoots);
  const hasFallbackMapping = mappings.some((mapping) => (
    Array.isArray(mapping && mapping.from) && mapping.from.length === 0
  ));
  if (!hasFallbackMapping && Array.isArray(policy.runtimeHomeRoot) && policy.runtimeHomeRoot.length > 0) {
    mappings.push(Object.freeze({
      from: Object.freeze([]),
      to: policy.runtimeHomeRoot
    }));
  }
  return mappings;
}

function getProviderPrivateEntryNames(provider) {
  const policy = getProviderStoragePolicy(provider);
  if (!policy) return [];
  const root = normalizePathSegments(policy.nativeRoot);
  return [...policy.authArtifacts, ...getProviderPrivateArtifacts(provider)]
    .map((artifact) => normalizePathSegments(artifact.path))
    .filter((artifactPath) => (
      artifactPath.length > root.length
      && root.every((segment, index) => artifactPath[index] === segment)
    ))
    .map((artifactPath) => artifactPath[root.length]);
}

function isProviderPrivateEntryName(provider, entryName) {
  const actual = String(entryName || '').trim().toLowerCase();
  if (!actual) return false;
  return getProviderPrivateEntryNames(provider).some((expected) => (
    actual === expected || actual.startsWith(`${expected}.`)
  ));
}

function normalizePathSegments(segments) {
  return (Array.isArray(segments) ? segments : [])
    .map((segment) => String(segment || '').trim().toLowerCase())
    .filter(Boolean);
}

function isProviderAuthArtifactSegments(provider, segments) {
  const candidate = normalizePathSegments(segments);
  return getProviderAuthArtifacts(provider).some((artifact) => {
    const expected = normalizePathSegments(artifact.path);
    if (candidate.length !== expected.length) return false;
    return expected.every((segment, index) => {
      const actual = candidate[index];
      if (index < expected.length - 1) return actual === segment;
      return actual === segment || actual.startsWith(`${segment}.`);
    });
  });
}

function isProviderAuthArtifactPath(filePath, pathImpl = path) {
  const normalized = String(filePath || '').trim();
  if (!normalized) return false;
  const parts = normalizePathSegments(normalized.split(/[\\/]+/));

  return Object.keys(PROVIDER_STORAGE_POLICIES).some((provider) => (
    getProviderAuthArtifacts(provider).some((artifact) => {
      const expected = normalizePathSegments(artifact.path);
      if (parts.length < expected.length) return false;
      const offset = parts.length - expected.length;
      return expected.every((segment, index) => {
        const actual = parts[offset + index];
        if (index < expected.length - 1) return actual === segment;
        return actual === segment || actual.startsWith(`${segment}.`);
      });
    })
  )) || pathImpl.basename(normalized).toLowerCase() === 'credentials.json';
}

function isProviderPrivateArtifactPath(filePath, pathImpl = path) {
  const normalized = String(filePath || '').trim();
  if (!normalized) return false;
  if (isProviderAuthArtifactPath(normalized, pathImpl)) return true;
  const parts = normalizePathSegments(normalized.split(/[\\/]+/));

  return Object.keys(PROVIDER_STORAGE_POLICIES).some((provider) => (
    getProviderPrivateArtifacts(provider).some((artifact) => {
      const expected = normalizePathSegments(artifact.path);
      if (parts.length < expected.length) return false;
      const offset = parts.length - expected.length;
      return expected.every((segment, index) => {
        const actual = parts[offset + index];
        if (index < expected.length - 1) return actual === segment;
        return actual === segment || actual.startsWith(`${segment}.`);
      });
    })
  ));
}

function resolveProviderNativeRoot(hostHomeDir, provider, pathImpl = path) {
  const root = String(hostHomeDir || '').trim();
  const policy = getProviderStoragePolicy(provider);
  return root && policy ? pathImpl.join(root, ...policy.nativeRoot) : '';
}

function resolveProviderRuntimeHomeRoot(hostHomeDir, provider, pathImpl = path) {
  const root = String(hostHomeDir || '').trim();
  const policy = getProviderStoragePolicy(provider);
  return root && policy && Array.isArray(policy.runtimeHomeRoot)
    ? pathImpl.join(root, ...policy.runtimeHomeRoot)
    : '';
}

function resolveProviderAttachmentRoot(hostHomeDir, provider, pathImpl = path) {
  const root = resolveProviderNativeRoot(hostHomeDir, provider, pathImpl);
  const policy = getProviderStoragePolicy(provider);
  return root && policy ? pathImpl.join(root, ...policy.attachmentSubdir) : '';
}

function getProviderSharedEntries(provider) {
  const policy = getProviderStoragePolicy(provider);
  return policy ? Array.from(policy.sharedEntries) : [];
}

function isProviderPrecreatedDirectory(provider, entryName) {
  const policy = getProviderStoragePolicy(provider);
  return Boolean(policy && policy.precreatedDirectories.includes(String(entryName || '')));
}

module.exports = {
  PROVIDER_RUNTIME_HOME_DIR,
  PROVIDER_STORAGE_POLICIES,
  getProviderAuthArtifacts,
  getProviderHostAuthRoot,
  getProviderPrivateArtifacts,
  getProviderPrivateEntryNames,
  getProviderProjectionMappings,
  getProviderSharedEntries,
  getProviderStoragePolicy,
  isProviderAuthArtifactPath,
  isProviderAuthArtifactSegments,
  isProviderPrivateArtifactPath,
  isProviderPrivateEntryName,
  isProviderPrecreatedDirectory,
  normalizeProvider,
  resolveProviderAttachmentRoot,
  resolveProviderNativeRoot,
  resolveProviderRuntimeHomeRoot
};
