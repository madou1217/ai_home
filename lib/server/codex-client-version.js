'use strict';

const { resolveWindowsUpstreamSpawn } = require('../runtime/pty-launch');
const { execFileSync } = require('node:child_process');

function parseCodexClientVersion(value) {
  const match = String(value || '').match(/(\d+\.\d+\.\d+)/);
  return match ? match[1] : '';
}

function resolveCodexCommand(options = {}) {
  const explicit = String(options.codexCommand || '').trim();
  if (explicit) return explicit;

  const processObj = options.processObj || process;
  const env = processObj.env || {};
  const fromEnv = String(env.AIH_CODEX_BIN || '').trim();
  if (fromEnv) return fromEnv;

  if (typeof options.resolveCliPath === 'function') {
    try {
      const resolved = String(options.resolveCliPath('codex') || '').trim();
      if (resolved) return resolved;
    } catch (_error) {}
  }

  return 'codex';
}

function detectCodexClientVersion(options = {}) {
  const processObj = options.processObj || process;
  const env = processObj.env || {};
  const configured = parseCodexClientVersion(
    options.codexClientVersion
    || env.AIH_SERVER_CODEX_CLIENT_VERSION
    || env.AIH_CODEX_CLIENT_VERSION
    || ''
  );
  if (configured) return configured;

  const command = resolveCodexCommand(options);
  const platform = String(options.platform || processObj.platform || process.platform);
  // Windows 上 codex 是 .cmd 垫片（含 aih 包装器），execFileSync 直接执行会 EINVAL，版本探测
  // 永远失败 → 网关自报最低版本 0.158，按版本下发的新模型（gpt-6.1-sol）被上游拒成
  // 「ChatGPT 账号不支持该模型」。先解析成 node + 脚本；冷启动实测约 1.8s，超时放宽。
  const target = platform === 'win32'
    ? resolveWindowsUpstreamSpawn(command, ['--version'], { platform, env })
    : { command, args: ['--version'], envPatch: {}, windowsVerbatimArguments: false };
  try {
    const exec = options.execFileSync || execFileSync;
    const raw = exec(target.command, target.args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: Math.max(250, Number(options.timeoutMs) || (platform === 'win32' ? 5000 : 1000)),
      env: { ...env, ...(target.envPatch || {}) },
      windowsHide: true,
      windowsVerbatimArguments: target.windowsVerbatimArguments === true
    });
    return parseCodexClientVersion(raw);
  } catch (_error) {
    return '';
  }
}

// 与 Go 侧 codexidentity.Floor 一致：编码器已按 Codex CLI 0.158.0-alpha.2.1 真实请求验证，
// OAuth 目录/额度按 client_version 判定兼容性，写死旧版本会过时（此前这里硬编码 0.101.0）。
const CODEX_CLIENT_VERSION_FLOOR = '0.158.0';
const CACHE_TTL_MS = 60 * 60 * 1000;
let cached = { version: '', at: 0 };

function compareCodexClientVersions(left, right) {
  const a = String(left || '').split('.').map((part) => Number(part) || 0);
  const b = String(right || '').split('.').map((part) => Number(part) || 0);
  for (let index = 0; index < 3; index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) < (b[index] || 0) ? -1 : 1;
  }
  return 0;
}

// atLeastCodexClientVersionFloor 取探测值与最低版本中较大者：PATH 上的独立 CLI 可能比
// 编码器已验证的协议代更旧（本机实测 0.154 < 0.158），自报旧版本会让 OAuth 目录缺新模型。
function atLeastCodexClientVersionFloor(version) {
  const parsed = parseCodexClientVersion(version);
  if (!parsed || compareCodexClientVersions(parsed, CODEX_CLIENT_VERSION_FLOOR) < 0) return CODEX_CLIENT_VERSION_FLOOR;
  return parsed;
}

// getCodexClientVersion 返回本机 CLI 版本（按小时重新探测：CLI 会自动更新），不低于最低版本。
function getCodexClientVersion(options = {}) {
  const now = typeof options.now === 'function' ? options.now() : Date.now();
  if (!cached.version || now - cached.at >= CACHE_TTL_MS) {
    cached = { version: atLeastCodexClientVersionFloor(detectCodexClientVersion(options)), at: now };
  }
  return cached.version;
}

function resetCodexClientVersionCacheForTest() {
  cached = { version: '', at: 0 };
}

module.exports = {
  CODEX_CLIENT_VERSION_FLOOR,
  atLeastCodexClientVersionFloor,
  compareCodexClientVersions,
  getCodexClientVersion,
  resetCodexClientVersionCacheForTest,
  detectCodexClientVersion,
  parseCodexClientVersion,
  resolveCodexCommand
};
