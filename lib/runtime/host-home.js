'use strict';

const os = require('node:os');
const path = require('node:path');
const { decodeEncodedWindowsPath } = require('./windows-path-encoding');

function readNonEmpty(value) {
  const text = String(value || '').trim();
  return text ? text : '';
}

function stripNestedCodexHome(homeDir) {
  const input = readNonEmpty(homeDir);
  if (!input) return '';
  const normalized = input.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized.toLowerCase().endsWith('/.codex')) return input;
  const root = normalized.slice(0, -'/.codex'.length);
  return root || input;
}

function normalizeHostHomeCandidate(homeDir) {
  const decoded = decodeEncodedWindowsPath(homeDir);
  return stripNestedCodexHome(decoded);
}

function resolveHostHomeDir(options = {}) {
  // 调用方注入的 hostHomeDir 优先于环境派生。此前 codex-project-registry 等
  // 传入该字段却被静默忽略、回退到 process.env 的真实 USERPROFILE，导致测试
  // 与运行时把 projects 信任条目写进真实宿主 ~/.codex/config.toml（2026-08-22
  // aih-remove-project-* 垃圾条目取证结论）。
  const injected = readNonEmpty(options.hostHomeDir);
  if (injected) return normalizeHostHomeCandidate(injected);

  const env = options.env || process.env;
  const platform = String(options.platform || process.platform);
  const osImpl = options.os || os;

  const explicit = readNonEmpty(env.AIH_HOST_HOME);
  if (explicit) return normalizeHostHomeCandidate(explicit);

  if (platform === 'win32') {
    const userProfile = readNonEmpty(env.USERPROFILE);
    if (userProfile) return normalizeHostHomeCandidate(userProfile);

    const homeDrive = readNonEmpty(env.HOMEDRIVE);
    const homePath = readNonEmpty(env.HOMEPATH);
    if (homeDrive && homePath) return normalizeHostHomeCandidate(path.join(homeDrive, homePath));
  }

  const home = readNonEmpty(env.HOME);
  if (home) return normalizeHostHomeCandidate(home);

  try {
    const userInfo = osImpl.userInfo();
    if (userInfo && userInfo.homedir) return normalizeHostHomeCandidate(String(userInfo.homedir));
  } catch (_error) {
    // fallback below
  }
  return normalizeHostHomeCandidate(osImpl.homedir());
}

/**
 * HOME 是不是**账号投影**：aih 启动的 harness 跑在
 * `<aiHome>/run/auth-projections/<provider>/<ref>`（登录期是 `run/login/…`）里，
 * 那个目录下的 `~/.ai_home` 是空壳——会话、账号库、claude 登记都在宿主家目录。
 *
 * 判定只看路径，不存在的路径返回 false。
 */
const PROJECTED_HOME_PATTERN = /[\\/]run[\\/](login|auth-projections)[\\/]/;

function looksProjectedHome(dir) {
  return PROJECTED_HOME_PATTERN.test(String(dir || ''));
}

/**
 * 宿主家目录，且**保证不是投影**：AIH_HOST_HOME → 非投影 HOME → passwd 家目录。
 * 用于「必须看到整台机器」的命令（aih ss / aih peer / TAB 补全），
 * 普通的配置路径解析仍走 resolveHostHomeDir（那里 HOME 优先，保持沙箱语义）。
 */
function resolveUnprojectedHostHomeDir(options = {}) {
  const env = options.env || process.env;
  const osImpl = options.os || os;
  const explicit = readNonEmpty(env.AIH_HOST_HOME);
  if (explicit) return normalizeHostHomeCandidate(explicit);
  const home = readNonEmpty(env.HOME || env.USERPROFILE);
  if (home && !looksProjectedHome(home)) return normalizeHostHomeCandidate(home);
  try {
    const info = osImpl.userInfo();
    if (info && info.homedir) return normalizeHostHomeCandidate(String(info.homedir));
  } catch (_error) { /* 回落 homedir() */ }
  try {
    return normalizeHostHomeCandidate(String(osImpl.homedir() || home));
  } catch (_error) {
    return normalizeHostHomeCandidate(home);
  }
}

module.exports = {
  looksProjectedHome,
  resolveHostHomeDir,
  resolveUnprojectedHostHomeDir
};
