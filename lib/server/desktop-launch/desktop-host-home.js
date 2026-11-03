'use strict';

const nodeOs = require('node:os');

// 桌面端装在**真实宿主家目录**下（~/Applications）。
// aih 自己的 CLI 可能跑在账号投影里（HOME 被改写），此时 deps.hostHomeDir 是投影路径，
// 直接拿它拼 ~/Applications 会找不到应用。os.userInfo().homedir 读 passwd，不受 HOME 影响。
const PROJECTED_HOME_PATTERN = /\/run\/(login|auth-projections)\//;

function looksProjectedHome(dir) {
  return PROJECTED_HOME_PATTERN.test(String(dir || '').replace(/\\/g, '/'));
}

function resolveAppHomeDir(options = {}) {
  const candidate = String(options.hostHomeDir || '').trim();
  if (candidate && !looksProjectedHome(candidate)) return candidate;
  const osImpl = options.osImpl || nodeOs;
  try {
    const info = osImpl.userInfo();
    if (info && info.homedir) return String(info.homedir);
  } catch (_error) { /* 回落 homedir() */ }
  try {
    return String(osImpl.homedir() || candidate);
  } catch (_error) {
    return candidate;
  }
}

module.exports = { looksProjectedHome, resolveAppHomeDir };
