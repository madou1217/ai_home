'use strict';

const path = require('node:path');

const PROVIDER_RUNTIME_HOME_DIR = '.aih-runtime-home';
const ACCOUNT_PRIVATE_DESKTOP_USER_DATA = Object.freeze({
  path: Object.freeze(['electron-user-data'])
});

// CodeBuddy 家族（含 WorkBuddy）的主站登录态都落在宿主 HOME 下同一个平台固定目录：
//   ~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/<hostId>.info
// 它**不受 CODEBUDDY_CONFIG_DIR 约束**（宿主侧用 os.homedir() 定位），所以策略里必须
// 声明成 HOME 相对路径；账号沙箱里同样的相对路径就是被隔离的 HOME。
//
// 文件名规则（2026-09-15 实测 3 份并存文件后确定，纠正此前的两文件结论）：
//   - 它首先是**宿主机标识**（authentication.id / CODEBUDDY_HOST），不是站点标识；
//   - 同一产品的国内/国际构建**可能共用同一个 host id**，此时靠 host id 后缀区分站点：
//       WorkBuddy.app（workbuddy.cn）      → `workbuddy-desktop.info`
//       WorkBuddy AI.app（workbuddy.ai）   → `workbuddy-desktop-ai.info`
//     （两个 asar 里的 CODEBUDDY_HOST 字面量都是 `workbuddy-desktop`，`-ai` 由运行时
//     按构建拼接，所以"同名 host 落出两个文件"是厂商标识规则，不是 aih 的假设）
//   - 独立分发的 CLI（npm @tencent-ai/codebuddy-code 与官方 install.sh 拉的是同一个包）
//     用的是另一个 host id `Tencent-Cloud.coding-copilot`，且该文件**站点不可归因**：
//     国内站 install.sh 也写这一个文件名，里面可能是国际站 token。
//
// 因此每个 Provider 只声明"自己那支客户端真正读的那一个文件"：同名即同一账号，
// 不靠开关、不靠复制。realm（token 的 iss）才是站点真值，文件名不是。
const CODEBUDDY_EXTENSION_AUTH_DIR = Object.freeze([
  'Library',
  'Application Support',
  'CodeBuddyExtension',
  'Data',
  'Public',
  'auth'
]);

// 国内站（copilot.tencent.com / workbuddy.cn）：`codebuddycn` 与 `workbuddycn` 共用。
// WorkBuddy.app 与它内嵌的 CodeBuddy Code CLI 读写的就是这一个文件，所以"同一账号"
// 不需要任何开关或复制逻辑——两个 Provider 声明同一个 auth artifact 即可。
// 这是国内侧唯一的共享面：配置 / 会话 / 插件仍按各自 Provider 投影。
const CODEBUDDY_CN_SHARED_AUTH_PATH = Object.freeze([
  ...CODEBUDDY_EXTENSION_AUTH_DIR,
  'workbuddy-desktop.info'
]);

// 国际站 WorkBuddy AI（workbuddy.ai）：`workbuddy` 用。
// 与国内站那份文件名不同（后缀 -ai），因此两个站点的账号天然不会互相覆盖。
// 实测 realm = https://www.workbuddy.ai/auth/realms/copilot，uid 409f887f-…。
const CODEBUDDY_AI_SHARED_AUTH_PATH = Object.freeze([
  ...CODEBUDDY_EXTENSION_AUTH_DIR,
  'workbuddy-desktop-ai.info'
]);

// 国际站 CodeBuddy（www.codebuddy.ai）：`codebuddy` 用。实测 `codebuddy` 的 CLI
// （独立分发的 @tencent-ai/codebuddy-code）与 CodeBuddy.app IDE 是同一个 host id，
// 本机该文件里的 token realm 是 `https://www.codebuddy.ai/auth/realms/copilot`。
//
// ⚠️ 该文件**站点不可归因**：国内站独立分发的 CLI 也用这个 host id，所以它里面可能
// 换成一枚国内站 token（realm 变成 copilot.tencent.com）。因此国内站 Provider 刻意
// **不**声明它（宁可让国内站账号自己在沙箱里登录，也不把国际站 token 静默导进国内站）。
// realm 是唯一的判别依据；若将来观察到误导入，再按 realm 加校验。
const CODEBUDDY_INTL_SHARED_AUTH_PATH = Object.freeze([
  ...CODEBUDDY_EXTENSION_AUTH_DIR,
  'Tencent-Cloud.coding-copilot.info'
]);

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
  // .mcp.json（可能内嵌 MCP 凭据）、sessions（后台会话索引含绝对路径）。
  //
  // 凭据走共享 .info（见 CODEBUDDY_INTL_SHARED_AUTH_PATH）：国际站的 CLI 与国际站
  // IDE 是同一个 authentication.id，读写同一个文件，所以这里不能再假设
  // `~/.codebuddy/.credentials.json`——该文件在这两支 CLI 下都不存在（实测 2.151.0
  // 的独立分发件与 WorkBuddy 内嵌件都没有写它）。hostAuthRoot 为 [] 是因为该
  // artifact 相对宿主 HOME，不属于本 Provider 的配置根。
  codebuddy: Object.freeze({
    hostAuthRoot: Object.freeze([]),
    authArtifacts: Object.freeze([
      Object.freeze({
        field: 'credentials',
        path: CODEBUDDY_INTL_SHARED_AUTH_PATH,
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
  // 登录态与 WorkBuddy 桌面端**共用**：国内站唯一的主站凭据就是 HOME 下
  // CodeBuddyExtension 的共享 .info（见 CODEBUDDY_CN_SHARED_AUTH_PATH）。
  // hostAuthRoot 为 [] 是因为该 artifact 相对宿主 HOME，而不是某个 Provider
  // 配置根——写死 `.codebuddy-cn` 会让宿主的 `.codebuddy-cn`（CLI 首启产物）
  // 与真实凭据文件互相错认。
  //
  // **刻意不声明** CODEBUDDY_INTL_SHARED_AUTH_PATH：国内站的独立分发 CLI 确实也用
  // 那个 authentication.id，但该文件站点不可归因（可能是国际站 token）。把国际站
  // 凭据静默导进国内站账号，比"判不出宿主来源、让账号在沙箱里自己登录"更糟。
  codebuddycn: Object.freeze({
    hostAuthRoot: Object.freeze([]),
    authArtifacts: Object.freeze([
      Object.freeze({
        field: 'credentials',
        path: CODEBUDDY_CN_SHARED_AUTH_PATH,
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
  // WorkBuddy **国际站**（workbuddy.ai，bundle id com.workbuddy.workbuddy-ai）。
  //
  // 原生事实（2026-09-15 实测本机 WorkBuddy AI.app 与它的 asar）：
  //   - 配置根由 `WORKBUDDY_CONFIG_DIR`（其次 `CODEBUDDY_CONFIG_DIR`）决定，
  //     Electron userData 根由 `WORKBUDDY_USER_DATA_DIR` 决定。
  //   - 内嵌的是同一套 CodeBuddy Code runtime（`CODEBUDDY_HOST` 字面量同为
  //     `workbuddy-desktop`），但登录态落盘文件带 `-ai` 后缀，
  //     见 CODEBUDDY_AI_SHARED_AUTH_PATH。与国内站那份**不同文件**，因此两个
  //     站点的账号在同一台机器上不会互相覆盖。
  //   - `~/.workbuddy-ai/credentials/` 是连接器令牌，与主站登录无关，不参与共享。
  workbuddy: Object.freeze({
    hostAuthRoot: Object.freeze([]),
    authArtifacts: Object.freeze([
      Object.freeze({
        field: 'credentials',
        path: CODEBUDDY_AI_SHARED_AUTH_PATH,
        format: 'json'
      })
    ]),
    privateArtifacts: Object.freeze([
      ACCOUNT_PRIVATE_DESKTOP_USER_DATA,
      Object.freeze({ path: Object.freeze(['Library', 'Keychains']) })
    ]),
    // 官方 cask workbuddy-ai 的 zap 清单与实机目录都是 `.workbuddy-ai`，
    // 与国内站的 `.workbuddy` 不同名——两个站点各自持久化，不能共用投影根。
    nativeRoot: Object.freeze(['.workbuddy-ai']),
    runtimeHomeRoot: Object.freeze(['.workbuddy-ai', PROVIDER_RUNTIME_HOME_DIR]),
    projectionRoots: Object.freeze([
      Object.freeze({
        from: Object.freeze(['.workbuddy-ai']),
        to: Object.freeze(['.workbuddy-ai'])
      })
    ]),
    sharedEntries: Object.freeze([]),
    precreatedDirectories: Object.freeze([]),
    attachmentSubdir: Object.freeze(['tmp', 'model', 'images'])
  }),
  // WorkBuddy **国内站**（workbuddy.cn，bundle id com.tencent.workbuddy.mac）。
  //
  // 与国际站是**两个 App、两个 bundle id、两份登录态文件、两个数据根**，但共用
  // 同一账号体系与同一份主站凭据：`workbuddy-desktop.info`
  // （见 CODEBUDDY_CN_SHARED_AUTH_PATH），与 `codebuddycn` 指向同一个文件
  // = 国内侧"CLI 与 App 同一账号"。
  workbuddycn: Object.freeze({
    hostAuthRoot: Object.freeze([]),
    authArtifacts: Object.freeze([
      Object.freeze({
        field: 'credentials',
        path: CODEBUDDY_CN_SHARED_AUTH_PATH,
        format: 'json'
      })
    ]),
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
  CODEBUDDY_AI_SHARED_AUTH_PATH,
  CODEBUDDY_CN_SHARED_AUTH_PATH,
  CODEBUDDY_EXTENSION_AUTH_DIR,
  CODEBUDDY_INTL_SHARED_AUTH_PATH,
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
