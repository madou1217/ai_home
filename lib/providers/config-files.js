'use strict';

// Provider CLI 配置文件注册表（声明式）。
//
// 一个 provider 需要展示哪些配置文件、文件在哪里、用什么格式解析、是否包含凭据，
// 全部在 FILE_DEFINITIONS 里声明。WebUI / 路由 / 历史版本只按 id 查表，不认 provider 名，
// 也不允许用户传入任意路径——新增 provider 只需要在这里加一条声明（或在合同里声明
// cli.configFile，由 fallback 自动生成主配置文件）。
//
// 路径只描述“宿主全局配置”。账号投影（run/accounts/...）由账号管理自行负责，
// 这里不暴露也不改写它，避免把某个账号的凭据误当成全局配置。

const nodePath = require('node:path');
const {
  getProviderCLIConfig,
  getProviderMenuLabel,
  listProviderIds
} = require('../provider-catalog');

const FORMAT_BY_EXTENSION = Object.freeze({
  '.toml': 'toml',
  '.json': 'json',
  '.jsonc': 'jsonc',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.ini': 'ini',
  '.conf': 'ini'
});

function splitParts(value) {
  return String(value || '')
    .replace(/^[/\\]+|[/\\]+$/g, '')
    .split(/[\\/]+/)
    .filter(Boolean);
}

function resolveHome(options = {}) {
  return String(options.home || options.hostHomeDir || options.env?.HOME || '').trim();
}

function resolvePathApi(options = {}) {
  return options.path || nodePath;
}

function resolveEnv(options = {}) {
  return options.env || process.env;
}

function resolvePlatform(options = {}) {
  const value = String(options.platform || process.platform).toLowerCase();
  if (value === 'win32' || value === 'windows') return 'windows';
  if (value === 'darwin' || value === 'mac' || value === 'macos') return 'macos';
  return value;
}

function configHomeFor(options = {}) {
  const env = resolveEnv(options);
  const path = resolvePathApi(options);
  const home = resolveHome(options);
  const platform = resolvePlatform(options);
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  return env.XDG_CONFIG_HOME
    || (platform === 'windows' ? appData : path.join(home, '.config'));
}

/**
 * provider 的全局配置根目录：与合同里的 cli.globalDir / configSubDir 同源。
 * 这是唯一一处把 `.config` 映射到 XDG/APPDATA 的逻辑，消费方不要重复推导。
 */
function resolveProviderRoot(provider, options = {}) {
  const path = resolvePathApi(options);
  const home = resolveHome(options);
  if (!home) return '';
  const cli = getProviderCLIConfig(provider) || {};
  const rawGlobal = String(cli.globalDir || `.${provider}`).trim();
  const globalParts = splitParts(rawGlobal);
  let root;
  if (globalParts[0] === '.config') {
    root = path.join(configHomeFor(options), ...globalParts.slice(1));
  } else {
    root = path.join(home, ...globalParts);
  }
  if (cli.configSubDir) root = path.join(root, ...splitParts(cli.configSubDir));
  return root;
}

function formatFromPath(parts) {
  const fileName = String((parts || []).slice(-1)[0] || '');
  return FORMAT_BY_EXTENSION[nodePath.extname(fileName).toLowerCase()] || 'text';
}

function locationParts(location) {
  return Array.isArray(location?.parts) ? location.parts.filter(Boolean) : [];
}

function resolveLocation(location, options = {}) {
  const path = resolvePathApi(options);
  const parts = locationParts(location);
  switch (location?.kind) {
    case 'home':
      return path.join(resolveHome(options), ...parts);
    case 'xdg-data': {
      const env = resolveEnv(options);
      const home = resolveHome(options);
      const dataHome = env.XDG_DATA_HOME
        || (resolvePlatform(options) === 'windows'
          ? (env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'))
          : path.join(home, '.local', 'share'));
      return path.join(dataHome, ...parts);
    }
    case 'xdg-config':
      return path.join(configHomeFor(options), ...parts);
    case 'provider-root':
    default:
      return path.join(resolveProviderRoot(location?.provider, options), ...parts);
  }
}

function resolveCandidates(definition, options = {}) {
  const locations = [definition.location, ...(definition.alternatives || [])].filter(Boolean);
  return locations.map((location) => {
    // provider-root 的 owner 默认就是声明所属 Provider；显式 provider 只用于复用同一路径族。
    const resolvedLocation = location.kind === 'provider-root' && !location.provider
      ? { ...location, provider: definition.provider }
      : location;
    return resolveLocation(resolvedLocation, options);
  }).filter(Boolean);
}

function chooseCandidate(paths, options = {}) {
  const fs = options.fs || require('node:fs');
  for (const candidate of paths) {
    try {
      if (fs.existsSync(candidate)) return { path: candidate, exists: true };
    } catch (_error) {
      // 无权限读取时仍返回第一个候选路径，让详情页给出可理解的错误。
    }
  }
  return { path: paths[0] || '', exists: false };
}

function displayPath(absolutePath, options = {}) {
  const home = resolveHome(options);
  const path = resolvePathApi(options);
  const raw = String(absolutePath || '');
  if (!raw) return '';
  if (home && (raw === home || raw.startsWith(`${home}${path.sep}`))) {
    return `~${raw.slice(home.length)}`;
  }
  return raw;
}

function normalizeAlternative(entry) {
  if (Array.isArray(entry)) return { kind: 'provider-root', parts: entry };
  return entry;
}

const FILE_DEFINITIONS = Object.freeze([
  // ---------------- Codex ----------------
  {
    provider: 'codex',
    id: 'config',
    label: 'config.toml',
    location: { kind: 'provider-root', parts: ['config.toml'] },
    format: 'toml',
    schemaId: 'codex.config',
    description: 'Codex CLI 主配置：模型、审批策略、沙箱、MCP、profiles 与通知。',
    docsUrl: 'https://developers.openai.com/codex/config-reference'
  },
  {
    provider: 'codex',
    id: 'auth',
    label: 'auth.json',
    location: { kind: 'home', parts: ['.codex', 'auth.json'] },
    format: 'json',
    schemaId: 'codex.auth',
    sensitive: true,
    description: 'ChatGPT 登录态与 API Key。包含 token，编辑前请确认当前环境。',
    docsUrl: 'https://developers.openai.com/codex/auth'
  },
  {
    provider: 'codex',
    id: 'hooks',
    label: 'hooks.json',
    location: { kind: 'home', parts: ['.codex', 'hooks.json'] },
    format: 'json',
    description: 'Codex 生命周期 Hook 配置（SessionStart / UserPromptSubmit / Stop 等）。',
    docsUrl: 'https://developers.openai.com/codex/hooks'
  },

  // ---------------- Claude ----------------
  {
    provider: 'claude',
    id: 'settings',
    label: 'settings.json',
    location: { kind: 'provider-root', parts: ['settings.json'] },
    format: 'json',
    schemaId: 'claude.settings',
    description: 'Claude Code 用户设置：模型、权限、Hook、状态栏与环境变量。',
    docsUrl: 'https://code.claude.com/docs/en/settings'
  },
  {
    provider: 'claude',
    id: 'credentials',
    label: '.credentials.json',
    location: { kind: 'home', parts: ['.claude', '.credentials.json'] },
    alternatives: [{ kind: 'home', parts: ['.claude', 'credentials.json'] }],
    format: 'json',
    schemaId: 'claude.credentials',
    sensitive: true,
    description: 'Claude OAuth 凭据。通常由 CLI 自动维护，只在必要时手动修复。',
    docsUrl: 'https://code.claude.com/docs/en/authentication'
  },

  // ---------------- Gemini ----------------
  {
    provider: 'gemini',
    id: 'settings',
    label: 'settings.json',
    location: { kind: 'provider-root', parts: ['settings.json'] },
    format: 'json',
    schemaId: 'gemini.settings',
    description: 'Gemini CLI 设置：UI、模型、工具、上下文、MCP 与安全策略。',
    docsUrl: 'https://geminicli.com/docs/cli/settings/'
  },
  {
    provider: 'gemini',
    id: 'oauth',
    label: 'oauth_creds.json',
    location: { kind: 'home', parts: ['.gemini', 'oauth_creds.json'] },
    format: 'json',
    schemaId: 'gemini.oauth',
    sensitive: true,
    description: 'Google OAuth 凭据（个人登录态）。包含访问令牌与刷新令牌。',
    docsUrl: 'https://geminicli.com/docs/get-started/authentication/'
  },
  {
    provider: 'gemini',
    id: 'accounts',
    label: 'google_accounts.json',
    location: { kind: 'home', parts: ['.gemini', 'google_accounts.json'] },
    format: 'json',
    description: 'Gemini CLI 记录的 Google 账号列表（用于账号切换）。',
    docsUrl: 'https://geminicli.com/docs/get-started/authentication/'
  },

  // ---------------- Antigravity (agy) ----------------
  {
    provider: 'agy',
    id: 'settings',
    label: 'settings.json',
    location: { kind: 'home', parts: ['.gemini', 'antigravity-cli', 'settings.json'] },
    format: 'json',
    schemaId: 'agy.settings',
    description: 'Antigravity CLI 设置：模型、状态栏、工具权限与受信任工作区。',
    docsUrl: 'https://antigravity.google/docs/cli'
  },
  {
    provider: 'agy',
    id: 'hooks',
    label: 'hooks.json',
    location: { kind: 'home', parts: ['.gemini', 'antigravity-cli', 'hooks.json'] },
    format: 'json',
    description: 'Antigravity CLI 生命周期 Hook 配置。',
    docsUrl: 'https://antigravity.google/docs/cli'
  },

  // ---------------- OpenCode ----------------
  {
    provider: 'opencode',
    id: 'config',
    label: 'opencode.json',
    location: { kind: 'provider-root', parts: ['opencode.json'] },
    alternatives: [{ kind: 'provider-root', parts: ['opencode.jsonc'] }],
    format: 'jsonc',
    schemaId: 'opencode.config',
    description: 'OpenCode 主配置：默认模型、Provider、Agent、权限、MCP、LSP 与格式化。',
    docsUrl: 'https://opencode.ai/docs/config/'
  },
  {
    provider: 'opencode',
    id: 'auth',
    label: 'auth.json',
    location: { kind: 'xdg-data', parts: ['opencode', 'auth.json'] },
    format: 'json',
    schemaId: 'opencode.auth',
    sensitive: true,
    description: 'OpenCode Provider 凭据（API Key / OAuth）。',
    docsUrl: 'https://opencode.ai/docs/providers/'
  },

  // ---------------- Grok ----------------
  {
    provider: 'grok',
    id: 'config',
    label: 'config.toml',
    location: { kind: 'provider-root', parts: ['config.toml'] },
    format: 'toml',
    schemaId: 'grok.config',
    description: 'Grok Build 主配置：模型、Agent、沙箱、MCP、权限与终端行为。',
    docsUrl: ''
  },
  {
    provider: 'grok',
    id: 'auth',
    label: 'auth.json',
    location: { kind: 'provider-root', parts: ['auth.json'] },
    format: 'json',
    sensitive: true,
    description: 'Grok 登录态与 API 凭据。',
    docsUrl: ''
  },

  // ---------------- Qoder ----------------
  {
    provider: 'qoder',
    id: 'config',
    label: 'config.json',
    location: { kind: 'provider-root', parts: ['config.json'] },
    format: 'json',
    description: 'Qoder CLI 配置。',
    docsUrl: 'https://docs.qoder.com/'
  },
  {
    provider: 'qoder',
    id: 'credentials',
    label: 'qoder-cli-credentials.json',
    location: { kind: 'provider-root', parts: ['qoder-cli-credentials.json'] },
    format: 'json',
    sensitive: true,
    description: 'Qoder CLI 登录凭据（由 CLI 加密/维护）。',
    docsUrl: 'https://docs.qoder.com/'
  },
  {
    provider: 'qodercn',
    id: 'config',
    label: 'config.json',
    location: { kind: 'provider-root', parts: ['config.json'] },
    format: 'json',
    description: 'Qoder（国内站）CLI 配置。',
    docsUrl: 'https://docs.qoder.com.cn/'
  },
  {
    provider: 'qodercn',
    id: 'credentials',
    label: 'qoder-cli-cn-credentials.json',
    location: { kind: 'provider-root', parts: ['qoder-cli-cn-credentials.json'] },
    format: 'json',
    sensitive: true,
    description: 'Qoder（国内站）CLI 登录凭据。',
    docsUrl: 'https://docs.qoder.com.cn/'
  },

  // ---------------- Kimi ----------------
  {
    provider: 'kimi',
    id: 'config',
    label: 'config.toml',
    location: { kind: 'provider-root', parts: ['config.toml'] },
    format: 'toml',
    description: 'Kimi Code CLI 配置：默认模型、Provider、思考模式与服务端点。',
    docsUrl: 'https://platform.moonshot.cn/docs/'
  },
  {
    provider: 'kimi',
    id: 'credentials',
    label: 'credentials/kimi-code.json',
    location: { kind: 'home', parts: ['.kimi-code', 'credentials', 'kimi-code.json'] },
    format: 'json',
    sensitive: true,
    description: 'Kimi Code OAuth 凭据（refresh_token 轮换）。',
    docsUrl: 'https://platform.moonshot.cn/docs/'
  },

  // ---------------- Kiro ----------------
  {
    provider: 'kiro',
    id: 'config',
    label: 'config.json',
    location: { kind: 'provider-root', parts: ['config.json'] },
    format: 'json',
    description: 'Kiro CLI 配置。',
    docsUrl: 'https://kiro.dev/docs/'
  },
  {
    provider: 'kiro',
    id: 'mcp',
    label: 'settings/mcp.json',
    location: { kind: 'provider-root', parts: ['settings', 'mcp.json'] },
    format: 'json',
    description: 'Kiro MCP 服务器配置。',
    docsUrl: 'https://kiro.dev/docs/mcp/'
  },

  // ---------------- ZCode ----------------
  {
    provider: 'zcode',
    id: 'setting',
    label: 'v2/setting.json',
    location: { kind: 'provider-root', parts: ['v2', 'setting.json'] },
    format: 'json',
    description: 'ZCode 桌面端设置：模型 Provider、区域、窗口与功能开关。',
    docsUrl: 'https://z.ai/docs'
  },
  {
    provider: 'zcode',
    id: 'config',
    label: 'v2/config.json',
    location: { kind: 'provider-root', parts: ['v2', 'config.json'] },
    format: 'json',
    description: 'ZCode 运行时配置（Provider、模型与工作区）。',
    docsUrl: 'https://z.ai/docs'
  },
  {
    provider: 'zcode',
    id: 'credentials',
    label: 'v2/credentials.json',
    location: { kind: 'provider-root', parts: ['v2', 'credentials.json'] },
    format: 'json',
    sensitive: true,
    description: 'ZCode 登录凭据。',
    docsUrl: 'https://z.ai/docs'
  },

  // ---------------- CodeBuddy ----------------
  {
    provider: 'codebuddy',
    id: 'settings',
    label: 'settings.json',
    location: { kind: 'provider-root', parts: ['settings.json'] },
    format: 'json',
    description: 'CodeBuddy CLI 设置：插件、MCP 与运行时开关。',
    docsUrl: 'https://www.codebuddy.ai/docs'
  },
  {
    provider: 'codebuddycn',
    id: 'settings',
    label: 'settings.json',
    location: { kind: 'provider-root', parts: ['settings.json'] },
    format: 'json',
    description: 'CodeBuddy（国内站）CLI 设置。',
    docsUrl: 'https://www.codebuddy.cn/docs'
  },

  // ---------------- WorkBuddy ----------------
  {
    provider: 'workbuddy',
    id: 'settings',
    label: 'settings.json',
    location: { kind: 'provider-root', parts: ['settings.json'] },
    format: 'json',
    description: 'WorkBuddy CLI 设置。',
    docsUrl: 'https://www.workbuddy.ai/docs'
  },
  {
    provider: 'workbuddycn',
    id: 'settings',
    label: 'settings.json',
    location: { kind: 'provider-root', parts: ['settings.json'] },
    format: 'json',
    description: 'WorkBuddy（国内站）CLI 设置。',
    docsUrl: 'https://www.workbuddy.cn/docs'
  },

  // ---------------- Cline ----------------
  {
    provider: 'cline',
    id: 'providers',
    label: 'data/settings/providers.json',
    location: { kind: 'home', parts: ['.cline', 'data', 'settings', 'providers.json'] },
    format: 'json',
    sensitive: true,
    description: 'Cline 账号与 Provider 登录态（CLI 与宿主共享）。',
    docsUrl: 'https://docs.cline.bot/'
  },
  {
    provider: 'cline',
    id: 'secrets',
    label: 'data/secrets.json',
    location: { kind: 'home', parts: ['.cline', 'data', 'secrets.json'] },
    format: 'json',
    sensitive: true,
    description: 'Cline 密钥存储。',
    docsUrl: 'https://docs.cline.bot/'
  }
].map((entry) => (entry.alternatives ? { ...entry, alternatives: entry.alternatives.map(normalizeAlternative) } : entry)));

const DEFINITIONS_BY_KEY = new Map(
  FILE_DEFINITIONS.map((entry) => [`${entry.provider}:${entry.id}`, entry])
);

function fallbackDefinition(provider) {
  const cli = getProviderCLIConfig(provider) || {};
  const configFile = String(cli.configFile || '').trim();
  if (!configFile) return null;
  const parts = splitParts(configFile);
  return {
    provider,
    id: 'config',
    label: parts.slice(-1)[0] || configFile,
    location: { kind: 'provider-root', provider, parts },
    format: formatFromPath(parts),
    description: `${getProviderMenuLabel(provider)} 的主配置文件。`,
    docsUrl: '',
    synthetic: true
  };
}

function listProviderConfigDefinitions(provider) {
  const id = String(provider || '').trim().toLowerCase();
  if (!id) return [];
  const declared = FILE_DEFINITIONS.filter((entry) => entry.provider === id);
  if (declared.length) return declared;
  const fallback = fallbackDefinition(id);
  return fallback ? [fallback] : [];
}

function getProviderConfigDefinition(provider, fileId) {
  const id = String(fileId || '').trim();
  if (!id) return null;
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const declared = DEFINITIONS_BY_KEY.get(`${normalizedProvider}:${id}`);
  if (declared) return declared;
  return listProviderConfigDefinitions(normalizedProvider).find((entry) => entry.id === id) || null;
}

function describeConfigFile(definition, options = {}) {
  const paths = resolveCandidates(definition, options);
  const chosen = chooseCandidate(paths, options);
  const fs = options.fs || require('node:fs');
  let stat = null;
  if (chosen.exists) {
    try {
      stat = fs.statSync(chosen.path);
    } catch (_error) {
      stat = null;
    }
  }
  return {
    provider: definition.provider,
    id: definition.id,
    label: definition.label,
    displayPath: displayPath(chosen.path, options),
    absolutePath: chosen.path,
    exists: chosen.exists,
    size: stat && stat.isFile() ? Number(stat.size) : 0,
    modifiedAt: stat && stat.mtimeMs ? Number(stat.mtimeMs) : 0,
    format: definition.format || formatFromPath([chosen.path]),
    sensitive: definition.sensitive === true,
    editable: definition.editable !== false && Number(stat?.size || 0) <= 2 * 1024 * 1024,
    schemaId: definition.schemaId || '',
    description: definition.description || '',
    docsUrl: definition.docsUrl || '',
    canCreate: !chosen.exists
  };
}

function listProviderConfigFiles(options = {}) {
  return listProviderIds().map((provider) => {
    const definitions = listProviderConfigDefinitions(provider);
    return {
      id: provider,
      label: getProviderMenuLabel(provider),
      files: definitions.map((definition) => describeConfigFile(definition, options))
    };
  }).filter((entry) => entry.files.length);
}

function resolveProviderConfigFile(provider, fileId, options = {}) {
  const definition = getProviderConfigDefinition(provider, fileId);
  if (!definition) return null;
  return { definition, file: describeConfigFile(definition, options) };
}

module.exports = {
  FILE_DEFINITIONS,
  describeConfigFile,
  displayPath,
  getProviderConfigDefinition,
  listProviderConfigDefinitions,
  listProviderConfigFiles,
  resolveProviderConfigFile,
  resolveProviderRoot
};
