'use strict';

// CLI 启动权限装配：只在「用户没有显式传入权限参数」时补默认最大权限。
//
// 事实来源：
//   - 合同 `nativeBoundary.permissions`（provider 声明有哪些权限旗标/模式）
//   - `tool-app-settings`（用户在 WebUI 里的逐 provider 开关，默认开启）
//   - `docs/providers/cli-version-restrictions.md`（版本相关限制，实测结论）
//
// 这里不做 provider 名判断；无免确认能力的 CLI 返回 unsupported，调用方保持原生行为。

const {
  hasExplicitPermissionFlag,
  resolvePermissionProfile
} = require('../../../providers/permission-profiles');
const {
  findPermissionConflicts,
  getPermissionFlagCatalog
} = require('../../../providers/permission-flag-catalog');
const { getToolPermissionSettings } = require('./tool-app-settings');

// `aih <cli> --version` / `--help` 是查询命令，不是会话；注入权限旗标只会让
// 输出变形或触发无关的参数校验。
const INFORMATIONAL_ARGV = new Set(['--version', '-V', '--help', '-h']);

// 版本相关限制（实测，见 docs/providers/cli-version-restrictions.md）：
//   codex-cli 0.163.0 —— "Permission overrides are not supported when resuming a
//   remote task."（fork 同族文案）。判据是「这一次启动会走远程 app-server」，而不是
//   CLI 版本号：没有该能力的旧版本永远不会命中这条限制，因此判断天然版本安全。
// 受限子命令声明在权限目录里（`subcommandsBlockingPermissionOverrides`），这里不写
// provider 名 —— 新增 provider 只在它自己的目录声明里加一行。
const CODEX_FLAGS_WITH_VALUE = new Set([
  '-c', '--config', '--enable', '--disable', '--remote', '--remote-auth-token-env',
  '-i', '--image', '-m', '--model', '--local-provider', '-p', '--profile',
  '-s', '--sandbox', '-C', '--cd', '--add-dir', '-a', '--ask-for-approval'
]);

function isInformationalInvocation(argv) {
  return argv.some((arg) => INFORMATIONAL_ARGV.has(String(arg || '').trim()));
}

/** 第一个非旗标 token（跳过带值旗标的值），没有子命令时返回空串。 */
function findPositionalCommand(argv, flagsWithValue) {
  const skipValue = flagsWithValue instanceof Set ? flagsWithValue : CODEX_FLAGS_WITH_VALUE;
  const list = Array.isArray(argv) ? argv : [];
  for (let index = 0; index < list.length; index += 1) {
    const token = String(list[index] || '');
    if (!token) continue;
    if (token === '--') return '';
    if (skipValue.has(token)) {
      index += 1;
      continue;
    }
    if (token.startsWith('-')) continue;
    return token;
  }
  return '';
}

function isRemotePermissionBlocked(provider, argv) {
  const catalog = getPermissionFlagCatalog(provider);
  const blocked = catalog.subcommandsBlockingPermissionOverrides || [];
  if (!blocked.length) return false;
  const command = findPositionalCommand(argv, catalog.subcommandFlagsWithValue);
  return blocked.includes(command);
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
  // 远程 resume/fork 拒绝权限覆盖：跳过注入，并让调用方把原因说出来（不静默）。
  if (isRemotePermissionBlocked(provider, argv)) {
    return {
      args: [],
      applied: false,
      reason: 'remote_resume_permissions_unsupported',
      profile,
      notice: '恢复远程任务时上游拒绝权限覆盖，本次启动沿用会话已保存的权限'
    };
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
  // 用户显式挑的权限参数（WebUI 逐旗标选择）优先于默认最大权限。
  const selectedArgs = Array.isArray(settings && settings.permissionArgs)
    ? settings.permissionArgs.map((value) => String(value === undefined || value === null ? '' : value)).filter(Boolean)
    : [];
  if (selectedArgs.length) {
    const conflicts = findPermissionConflicts(provider, [...selectedArgs, ...argv]);
    if (conflicts.length) {
      return {
        args: [],
        applied: false,
        reason: 'conflict',
        conflicts,
        profile,
        notice: `启动权限参数互斥：${conflicts.map((item) => item.message).join('；')}`
      };
    }
    return { args: selectedArgs, applied: true, reason: 'applied', profile };
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
    settings: settings || { maxPermission: true, applyToHost: false, permissionArgs: [], updatedAt: 0 },
    profile
  };
}

module.exports = {
  buildToolPermissionLaunchArgs,
  describeToolPermission,
  findPositionalCommand,
  isRemotePermissionBlocked
};
