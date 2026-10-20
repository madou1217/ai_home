'use strict';

// CLI 启动权限装配：只在「用户没有显式传入权限参数」时补默认最大权限。
//
// 事实来源：
//   - 合同 `nativeBoundary.permissions`（provider 声明有哪些权限旗标/模式）
//   - `tool-app-settings`（用户在 WebUI 里的逐 provider 开关，默认开启）
//
// 这里不做 provider 名判断；无免确认能力的 CLI 返回 unsupported，调用方保持原生行为。

const {
  hasExplicitPermissionFlag,
  resolvePermissionProfile
} = require('../../../providers/permission-profiles');
const { getToolPermissionSettings } = require('./tool-app-settings');

// `aih <cli> --version` / `--help` 是查询命令，不是会话；注入权限旗标只会让
// 输出变形或触发无关的参数校验。
const INFORMATIONAL_ARGV = new Set(['--version', '-V', '--help', '-h']);

function isInformationalInvocation(argv) {
  return argv.some((arg) => INFORMATIONAL_ARGV.has(String(arg || '').trim()));
}

function buildToolPermissionLaunchArgs(options = {}) {
  const provider = String(options.provider || '').trim().toLowerCase();
  const argv = Array.isArray(options.argv) ? options.argv : [];
  if (options.isLogin === true) {
    return { args: [], applied: false, reason: 'login' };
  }
  if (isInformationalInvocation(argv)) {
    return { args: [], applied: false, reason: 'informational' };
  }
  const profile = resolvePermissionProfile(provider);
  if (!profile.maxSupported) {
    return { args: [], applied: false, reason: 'unsupported', profile };
  }
  if (hasExplicitPermissionFlag(profile, argv)) {
    return { args: [], applied: false, reason: 'explicit', profile };
  }
  let settings = null;
  try {
    settings = typeof options.readSettings === 'function'
      ? options.readSettings(provider)
      : getToolPermissionSettings(provider, options.fs, options.aiHomeDir, options.deps);
  } catch (_error) {
    settings = null;
  }
  if (settings && settings.maxPermission === false) {
    return { args: [], applied: false, reason: 'disabled', profile };
  }
  return {
    args: profile.maxArgs.slice(),
    applied: profile.maxArgs.length > 0,
    reason: 'applied',
    profile
  };
}

function describeToolPermission(options = {}) {
  const provider = String(options.provider || '').trim().toLowerCase();
  const profile = resolvePermissionProfile(provider);
  let settings = null;
  try {
    settings = getToolPermissionSettings(provider, options.fs, options.aiHomeDir, options.deps);
  } catch (_error) {
    settings = null;
  }
  return {
    settings: settings || { maxPermission: true, applyToHost: false, updatedAt: 0 },
    profile
  };
}

module.exports = {
  buildToolPermissionLaunchArgs,
  describeToolPermission
};
