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

function listPermissionFlags(nativeBoundary) {
  const permissions = nativeBoundary && nativeBoundary.permissions;
  const flags = Array.isArray(permissions && permissions.flags) ? permissions.flags : [];
  const modes = Array.isArray(permissions && permissions.modes) ? permissions.modes : [];
  return { flags, modes };
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
  if (modes.includes('yolo') && flags.includes('--yolo')) {
    return ['--yolo'];
  }
  if (modes.includes('yolo') && flags.includes('--approval-mode')) {
    return ['--approval-mode', 'yolo'];
  }
  if (flags.includes('--dangerously-skip-permissions')) {
    return ['--dangerously-skip-permissions'];
  }
  if (modes.includes('auto') && flags.includes('--auto')) {
    return ['--auto'];
  }
  return [];
}

function resolvePermissionProfile(providerRaw) {
  const provider = normalizeProviderId(providerRaw);
  const known = Boolean(provider) && isKnownProvider(provider);
  const nativeBoundary = known ? getProviderNativeBoundary(provider) : null;
  const { flags, modes } = listPermissionFlags(nativeBoundary);
  const maxArgs = deriveMaxPermissionArgs(flags, modes);
  const host = HOST_PERMISSION_PROFILES[provider] || null;
  const explicitFlags = Array.from(new Set([
    ...flags,
    ...EXTRA_EXPLICIT_FLAGS,
    ...Object.entries(FLAG_ALIASES)
      .filter(([flag]) => flags.includes(flag))
      .flatMap(([, aliases]) => aliases)
  ]));
  return {
    provider,
    known,
    maxSupported: maxArgs.length > 0,
    maxArgs,
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
