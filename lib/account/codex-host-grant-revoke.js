'use strict';

const nodePath = require('node:path');
const {
  AIH_SERVER_PROFILE_ID,
  clearDefaultAccountRef,
  readDefaultAccountRef,
  writeDefaultProviderProfile
} = require('./default-account-store');
const {
  AIH_CODEX_PROVIDER_KEY,
  NATIVE_API_BASE_URL_MARKER
} = require('../cli/services/pty/codex-config-sync');

// 停用 / 清除默认 / 删除账号时回收宿主 Codex 的直连授权。
//
// 背景（2026-10-14 4router 事故）：`aih codex set-default <id>` 会把账号授权
// 写进宿主 ~/.codex/config.toml 的两个受管点——根级带 aih 派发标记的
// openai_base_url（账号自己的上游地址，如 https://4router.net/v1）与受管
// provider 段里的 X-Account-Ref 钉选。这两点都在网关之外：账号停用后如果授权
// 没被回收，裸 codex 与桌面 App 会绕过网关直连该账号，网关侧的 enabled 判定
// 完全失效（取证：15:45:04 停用账号，15:46:48 仍有 4router.net 403 命中）。
//
// 回收只有一种形态：把宿主切回网关档（`syncGlobalConfigToHost('codex', '',
// { gateway: true })`）——它重写受管 provider 段（清掉钉选）并把根级
// openai_base_url 改指本地网关；aih 默认账号记录同步切到 AIH Server 档，使
// `aih codex` 裸启动也走网关，而不是回落到已停用账号。
//
// auth.json 不在这里处理：没有根级 openai_base_url 时它只能指向
// api.openai.com，不构成对第三方上游的直连；改它反而会覆盖用户自己的
// ChatGPT 登录态。

const CODEX_PROVIDER = 'codex';
const PIN_SECTION_HEADER = `[model_providers.${AIH_CODEX_PROVIDER_KEY}]`;
const PIN_HEADER_PATTERN = /"X-Account-Ref"\s*=\s*"(acct_[A-Za-z0-9]+)"/;
const BASE_URL_LINE_PATTERN = /^\s*openai_base_url\s*=\s*"((?:[^"\\]|\\.)*)"/;

function unescapeTomlBasicString(value) {
  return String(value || '').replace(/\\(["\\])/g, '$1');
}

function normalizeEndpoint(value) {
  return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
}

// 受管 provider 段里的账号钉选。段内先于 [model_providers.aih_server.auth] 出现。
function readHostPinnedAccountRef(content) {
  const lines = String(content || '').split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === PIN_SECTION_HEADER);
  if (start < 0) return '';
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\[/.test(line)) break;
    const match = line.match(PIN_HEADER_PATTERN);
    if (match) return match[1];
  }
  return '';
}

// 根级受管直连端点：只有紧邻 aih 派发标记的 openai_base_url 才算 aih 授权
// （与 codex-config-sync 的 syncCodexBuiltinApiBaseUrl 同一判据）。
function readHostDirectBaseUrl(content) {
  const lines = String(content || '').split(/\r?\n/);
  let root = true;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().startsWith('[')) {
      root = false;
    }
    if (!root) break;
    if (line.trim() !== NATIVE_API_BASE_URL_MARKER) continue;
    const match = String(lines[index + 1] || '').match(BASE_URL_LINE_PATTERN);
    return match ? unescapeTomlBasicString(match[1]) : '';
  }
  return '';
}

function readHostConfigContent(fs, configPath) {
  try {
    // 未安装 codex / 宿主目录不存在时不创建任何东西。
    if (!fs.existsSync(configPath)) return null;
    return String(fs.readFileSync(configPath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

// 账号当前是否握有宿主直连授权（而不是"宿主是否配置过 aih"）。
// 三条判据都指向同一个账号：aih 默认账号记录、受管钉选、根级直连端点。
function detectCodexHostGrant(options = {}) {
  const fs = options.fs || require('node:fs');
  const path = options.path || nodePath;
  const hostHomeDir = String(options.hostHomeDir || '').trim();
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const accountRef = String(options.accountRef || '').trim();
  const reasons = [];
  if (!hostHomeDir || !accountRef) {
    return { granted: false, reasons, configPath: '', scope: 'host_scope_unavailable' };
  }
  const configPath = path.join(hostHomeDir, '.codex', 'config.toml');
  const content = readHostConfigContent(fs, configPath);
  if (content === null) {
    return { granted: false, reasons, configPath, scope: 'host_config_absent' };
  }

  // 默认账号记录读失败（库不可用等）只让这条判据失效，钉选与直连端点仍能定位账号。
  let defaultRef = '';
  if (aiHomeDir) {
    try {
      defaultRef = readDefaultAccountRef(fs, aiHomeDir, CODEX_PROVIDER);
    } catch (_error) {
      defaultRef = '';
    }
  }
  if (defaultRef && defaultRef === accountRef) reasons.push('default_account');
  if (readHostPinnedAccountRef(content) === accountRef) reasons.push('pinned_account_ref');
  const directBaseUrl = readHostDirectBaseUrl(content);
  const accountBaseUrl = String(options.accountBaseUrl || '').trim();
  if (directBaseUrl && accountBaseUrl
    && normalizeEndpoint(directBaseUrl) === normalizeEndpoint(accountBaseUrl)) {
    reasons.push('native_base_url');
  }
  return {
    granted: reasons.length > 0,
    reasons,
    configPath,
    directBaseUrl,
    scope: 'host_config'
  };
}

// 命中授权时把宿主切回网关档并同步 aih 默认账号记录。没有授权就什么都不做
// （正常网关档账号停用不应改写宿主文件）。
function revokeCodexHostGrant(options = {}) {
  const fs = options.fs || require('node:fs');
  const aiHomeDir = String(options.aiHomeDir || '').trim();
  const accountRef = String(options.accountRef || '').trim();
  const syncGlobalConfigToHost = options.syncGlobalConfigToHost;
  const detection = detectCodexHostGrant(options);
  if (!detection.granted) {
    return { ok: true, revoked: false, reasons: [], detection };
  }
  if (typeof syncGlobalConfigToHost !== 'function') {
    return { ok: false, revoked: false, reason: 'host_sync_unavailable', detection };
  }
  let sync;
  try {
    sync = syncGlobalConfigToHost(CODEX_PROVIDER, '', { gateway: true });
  } catch (error) {
    return {
      ok: false,
      revoked: false,
      reason: 'host_sync_failed',
      error: String((error && error.message) || error || 'unknown'),
      detection
    };
  }
  if (!sync || !sync.ok) {
    return {
      ok: false,
      revoked: false,
      reason: (sync && sync.reason) || 'host_sync_failed',
      detection
    };
  }

  let defaultProfileUpdated = false;
  try {
    if (aiHomeDir) {
      clearDefaultAccountRef(fs, aiHomeDir, CODEX_PROVIDER, accountRef);
      writeDefaultProviderProfile(fs, aiHomeDir, CODEX_PROVIDER, AIH_SERVER_PROFILE_ID);
      defaultProfileUpdated = true;
    }
  } catch (_error) {
    // 宿主已回收（真正的泄漏面），默认账号记录写失败只降级报告。
    return {
      ok: true,
      revoked: true,
      defaultProfileUpdated: false,
      reason: 'default_profile_update_failed',
      reasons: detection.reasons,
      detection
    };
  }
  return {
    ok: true,
    revoked: true,
    defaultProfileUpdated,
    reasons: detection.reasons,
    hostGlobalDir: sync.hostGlobalDir || '',
    detection
  };
}

module.exports = {
  detectCodexHostGrant,
  revokeCodexHostGrant,
  __private: {
    readHostPinnedAccountRef,
    readHostDirectBaseUrl,
    normalizeEndpoint
  }
};
