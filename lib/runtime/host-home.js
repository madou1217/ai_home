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

module.exports = {
  resolveHostHomeDir
};
