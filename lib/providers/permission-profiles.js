'use strict';

// Provider 权限能力与宿主配置写入声明（声明式注册表）。
//
// 启动参数只从合同 `nativeBoundary.permissions` 推导，不按 provider 名分支：
// 合同声明了哪些 flags / modes，这里按一组稳定的「能力签名」选出最大权限参数。
// 新增 provider 只需在 Go 合同里声明 flags/modes，不必改派发代码。
//
// 宿主配置写入是另一件事：只有「字段位置已被真机/官方 schema 验证」的 provider 才登记。
// 未登记 = WebUI 明确显示不可写入宿主，绝不猜测字段名。

const {
  getProviderNativeBoundary,
  isKnownProvider,
  normalizeProviderId
} = require('../provider-catalog');
const { listPermissionIntentFlagForms } = require('./permission-flag-catalog');

const HOST_PERMISSION_PROFILES = Object.freeze({
  claude: Object.freeze({
    fileId: 'settings',
    patch: Object.freeze({ 'permissions.defaultMode': 'bypassPermissions' })
  }),
  codex: Object.freeze({
    fileId: 'config',
    patch: Object.freeze({
      approval_policy: 'never',
      sandbox_mode: 'danger-full-access'
    })
  }),
  opencode: Object.freeze({
    fileId: 'config',
    patch: Object.freeze({ permission: 'allow' })
  }),
  agy: Object.freeze({
    fileId: 'settings',
    patch: Object.freeze({ toolPermission: 'always-proceed' })
  })
});

const EXTRA_EXPLICIT_FLAGS = Object.freeze([
  '--dangerously-bypass-approvals-and-sandbox'
]);

// 主动注入时也要避开的短旗标：只对合同里确实存在的长旗标做别名映射。
const FLAG_ALIASES = Object.freeze({
  '--sandbox': Object.freeze(['-s']),
  '--ask-for-approval': Object.freeze(['-a'])
});

function listPermissionFlags(nativeBoundary, providerRaw) {
  const permissions = nativeBoundary && nativeBoundary.permissions;
  const flags = Array.isArray(permissions && permissions.flags) ? permissions.flags : [];
  const modes = Array.isArray(permissions && permissions.modes) ? permissions.modes : [];
  // 用户显式传入的判定必须覆盖**合同之外**的等价旗标（--dangerously-skip-permissions /
  // --yolo / --always-approve …）：这些旗标同样表达了权限意图，漏判就会把它们
  // 和默认最大权限叠加成冲突组合。目录是这些旗标的唯一声明处。
  const catalogFlags = listPermissionIntentFlagForms(providerRaw);
  return { flags, modes, catalogFlags };
}

// 合同声明的「最大权限参数之外」的进程环境开关（例如 codebuddy 的
// CODEBUDDY_IS_SANDBOX=1：bypassPermissions 仍会逐次询问 HIGH/CRITICAL，
// 只有进程环境变量能真正 full pass）。只接受非空字符串值。
function listPermissionEnv(nativeBoundary) {
  const env = nativeBoundary && nativeBoundary.permissions && nativeBoundary.permissions.env;
  if (!env || typeof env !== 'object') return {};
  const result = {};
  for (const [key, value] of Object.entries(env)) {
    const name = String(key || '').trim();
    const text = String(value === undefined || value === null ? '' : value).trim();
    if (name && text) result[name] = text;
  }
  return result;
}

function deriveMaxPermissionArgs(flags, modes) {
  if (modes.includes('danger-full-access') && flags.includes('--sandbox')) {
    const args = ['--sandbox', 'danger-full-access'];
    if (flags.includes('--ask-for-approval')) args.push('--ask-for-approval', 'never');
    return args;
  }
  if (modes.includes('bypassPermissions') && flags.includes('--permission-mode')) {
    return ['--permission-mode', 'bypassPermissions'];
  }
  if (modes.includes('bypass_permissions') && flags.includes('--permission-mode')) {
    return ['--permission-mode', 'bypass_permissions'];
  }
  // kimi：`--auto`（Never Ask）才是不再询问的那个；`--yolo`（Ask When Needed）按官方说明
  // 仍会为有风险的操作提问。先判 `--auto`，否则最大权限会注入成一个还会询问的旗标。
  if (modes.includes('auto') && flags.includes('--auto')) {
    return ['--auto'];
  }
  if (modes.includes('yolo') && flags.includes('--yolo')) {
    return ['--yolo'];
  }
  if (modes.includes('yolo') && flags.includes('--approval-mode')) {
    return ['--approval-mode', 'yolo'];
  }
  if (flags.includes('--dangerously-skip-permissions')) {
    return ['--dangerously-skip-permissions'];
  }
  // kiro：没有模式枚举，「不再询问」就是一个布尔旗标。`--trust-tools` 是它的部分信任
  // 版本（收一个名单），不作为最大权限。落点见 runtime/kiro-permission-args。
  if (flags.includes('--trust-all-tools')) {
    return ['--trust-all-tools'];
  }
  return [];
}

function resolvePermissionProfile(providerRaw) {
  const provider = normalizeProviderId(providerRaw);
  const known = Boolean(provider) && isKnownProvider(provider);
  const nativeBoundary = known ? getProviderNativeBoundary(provider) : null;
  const { flags, modes, catalogFlags } = listPermissionFlags(nativeBoundary, provider);
  const maxArgs = deriveMaxPermissionArgs(flags, modes);
  // 没有最大权限参数时不注入环境：那等于给一个没打算放开权限的 Provider 开后门。
  const maxEnv = maxArgs.length > 0 ? listPermissionEnv(nativeBoundary) : {};
  const host = HOST_PERMISSION_PROFILES[provider] || null;
  const explicitFlags = Array.from(new Set([
    ...flags,
    ...EXTRA_EXPLICIT_FLAGS,
    ...catalogFlags,
    ...Object.entries(FLAG_ALIASES)
      .filter(([flag]) => flags.includes(flag))
      .flatMap(([, aliases]) => aliases)
  ]));
  return {
    provider,
    known,
    maxSupported: maxArgs.length > 0,
    maxArgs,
    maxEnv,
    explicitFlags,
    hostSupported: Boolean(host),
    hostFileId: host ? host.fileId : '',
    hostPatch: host ? host.patch : null
  };
}

function hasExplicitPermissionFlag(profile, argv = []) {
  const flags = profile && Array.isArray(profile.explicitFlags) ? profile.explicitFlags : [];
  if (!flags.length) return false;
  return (Array.isArray(argv) ? argv : []).some((arg) => {
    const value = String(arg || '');
    return flags.some((flag) => value === flag || value.startsWith(`${flag}=`));
  });
}

module.exports = {
  HOST_PERMISSION_PROFILES,
  deriveMaxPermissionArgs,
  hasExplicitPermissionFlag,
  resolvePermissionProfile
};
