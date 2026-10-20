'use strict';

// 宿主 **API Key 环境变量**的扫描入库 —— 宿主文件扫描之外的另一个真实来源。
//
// 为什么需要它：grok / kimi / zcode 等 CLI 的 API Key 只从进程环境读（XAI_API_KEY /
// MOONSHOT_API_KEY / ZCODE_API_KEY …），不写任何宿主文件，所以 hostApiKeySlots 那条文件扫描
// 天然覆盖不到。用户在 shell 里 export 了 key，CLI 能用，账号池却永远看不到它。
//
// 覆盖面不维护 provider 名单：取 `CLI_SPEC`（lib/profile/credential-config.js 从合同派生——
// 声明了 api-key 认证方式、且 CLI 读 `*_API_KEY` 变量的 provider），与 WebUI「添加 API Key 账号」
// （configureApiKeyAccount）同一张表，所以账号凭据的变量名、身份都与手工添加完全一致：
// 同一把 key 先手工加、后被扫到，不会出第二个账号。
//
// 读哪个环境：
//   * 进程环境（终端里跑 `aih <cli> detect` 时就是用户 shell 的环境）；
//   * **登录 shell 的环境**：后台 Server 由 launchd / systemd 拉起时继承的是最小环境，
//     看不到用户 profile 里 export 的 key（与 host-search-path.js 补 PATH 同一个原因）。
//     只取声明里的变量名，不执行任何 provider 命令；shell 缺失/超时一律降级为空。
//
// 写入语义与其它宿主扫描一致（复用 host-api-key-scan.js 的 registerHostApiKey）：
// 自写守卫（aih 的 client key / 指向本机网关的基础地址）→ 同 key 去重 → 删除墓碑 → 只新增。

const { execFileSync: nodeExecFileSync } = require('node:child_process');

const LOGIN_SHELL_TIMEOUT_MS = 3000;
// 登录 shell 输出里的分隔符：变量值本身不会含 NUL（环境变量不允许），用它切分最稳。
const SEPARATOR = '\u0000';

function isWindows(platform) {
  const key = String(platform || process.platform).trim().toLowerCase();
  return key === 'win32' || key === 'windows';
}

/** 声明了 api-key 认证方式的 provider 及其密钥 / 基础地址变量（与手工添加同源）。 */
function listEnvApiKeySpecs() {
  const { CLI_SPEC } = require('../profile/credential-config');
  return Object.entries(CLI_SPEC)
    .filter(([, spec]) => spec && Array.isArray(spec.apiKeys) && spec.apiKeys.length > 0)
    .map(([provider, spec]) => ({ provider, apiKeys: [...spec.apiKeys], baseUrlKey: spec.baseUrlKey || '' }));
}

function listEnvApiKeyProviders() {
  return listEnvApiKeySpecs().map((spec) => spec.provider);
}

function listEnvVariableNames(specs) {
  const names = new Set();
  for (const spec of specs) {
    for (const name of spec.apiKeys) names.add(name);
    if (spec.baseUrlKey) names.add(spec.baseUrlKey);
  }
  return [...names].filter((name) => /^[A-Z_][A-Z0-9_]*$/.test(name)).sort();
}

/**
 * 登录 shell 里这些变量的值（只读声明里的变量名）。
 * 用 `-l -i`：zsh/bash 的交互配置（.zshrc / .bashrc）里 export 的 key 也要看得到。
 */
function readLoginShellEnv(names, options = {}) {
  if (names.length === 0 || isWindows(options.platform)) return {};
  const execFileSyncImpl = options.execFileSync || nodeExecFileSync;
  const shell = String(options.shell || (options.env && options.env.SHELL) || process.env.SHELL || '/bin/sh').trim();
  const script = names.map((name) => `printf '%s=%s\\0' '${name}' "\${${name}}"`).join('; ');
  let output = '';
  try {
    output = String(execFileSyncImpl(shell, ['-l', '-i', '-c', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: LOGIN_SHELL_TIMEOUT_MS,
      env: options.env && typeof options.env === 'object' ? options.env : undefined,
      windowsHide: true
    }) || '');
  } catch (_error) {
    return {};
  }
  const allowed = new Set(names);
  const out = {};
  for (const entry of output.split(SEPARATOR)) {
    const index = entry.indexOf('=');
    if (index <= 0) continue;
    const name = entry.slice(0, index).trim();
    const value = entry.slice(index + 1).trim();
    if (allowed.has(name) && value) out[name] = value;
  }
  return out;
}

/** 进程环境优先（用户当下 shell 的真实值），登录 shell 只补齐缺失的变量。 */
function collectEnvValues(names, options = {}) {
  const processEnv = options.processEnv || process.env;
  const values = {};
  for (const name of names) {
    const value = String(processEnv[name] || '').trim();
    if (value) values[name] = value;
  }
  const missing = names.filter((name) => !values[name]);
  if (missing.length > 0 && options.loginShell !== false) {
    Object.assign(values, readLoginShellEnv(missing, options));
  }
  return values;
}

/** 一个 provider 声明的密钥变量 → 一次入库尝试（每把不同的 key 一次）。 */
function scanEnvApiKeysForSpec(spec, values, deps = {}) {
  const { registerHostApiKey } = require('./host-api-key-scan');
  const baseUrl = spec.baseUrlKey ? String(values[spec.baseUrlKey] || '').trim() : '';
  const keys = [...new Set(spec.apiKeys.map((name) => String(values[name] || '').trim()).filter(Boolean))];
  if (keys.length === 0) return [{ status: 'absent', reason: 'host_env_api_key_missing', provider: spec.provider }];
  return keys.map((apiKey) => {
    const guardReason = deps.guard ? deps.guard.rejectsApiKey({ apiKey, baseUrl }) : '';
    if (guardReason) return { status: 'skipped', reason: guardReason, provider: spec.provider };
    return registerHostApiKey(spec.provider, { apiKey, baseUrl, credentialType: 'api-key' }, () => {
      // 与 configureApiKeyAccount 写出同一份凭据：声明里的每个密钥变量都写同一把 key。
      const env = {};
      for (const name of spec.apiKeys) env[name] = apiKey;
      if (baseUrl && spec.baseUrlKey) env[spec.baseUrlKey] = baseUrl;
      return env;
    }, deps);
  });
}

/** 全部 provider 的环境变量 API Key 扫描。返回形状与其它宿主扫描一致。 */
function scanHostEnvApiKeys(deps = {}) {
  const specs = listEnvApiKeySpecs();
  const values = collectEnvValues(listEnvVariableNames(specs), deps);
  const outcomes = [];
  for (const spec of specs) {
    try {
      outcomes.push(...scanEnvApiKeysForSpec(spec, values, deps));
    } catch (_error) {
      outcomes.push({ status: 'skipped', reason: 'host_env_api_key_scan_failed', provider: spec.provider });
    }
  }
  return outcomes;
}

/** 变更门（后台观察用）：只对变量值做不可逆摘要，不留明文。 */
function envApiKeyStamp(deps = {}) {
  const crypto = require('node:crypto');
  const values = collectEnvValues(listEnvVariableNames(listEnvApiKeySpecs()), deps);
  const text = Object.keys(values).sort().map((name) => `${name}=${values[name]}`).join('\n');
  return crypto.createHash('sha256').update(text).digest('hex');
}

module.exports = {
  collectEnvValues,
  envApiKeyStamp,
  listEnvApiKeyProviders,
  listEnvApiKeySpecs,
  readLoginShellEnv,
  scanHostEnvApiKeys
};
