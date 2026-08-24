'use strict';

const nodePath = require('node:path');
const { resolvePlatformPath } = require('../../../../../runtime/platform-path');
const {
  buildCleanupPlan,
  buildCommandPlan,
  createLifecyclePlan,
  shellQuote
} = require('../plan-builders');

function resolveHome(options = {}) {
  return String(options.hostHomeDir || '').trim();
}

function resolvePath(options = {}, platform = '') {
  return resolvePlatformPath(platform || options.platform, options.path || nodePath);
}

function homePaths(relativePaths, options = {}, platform = '') {
  const home = resolveHome(options);
  if (!home) return [];
  const pathImpl = resolvePath(options, platform);
  return (Array.isArray(relativePaths) ? relativePaths : [relativePaths])
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .map((value) => pathImpl.join(home, value));
}

function buildHomeCleanupPlan(toolId, name, options = {}, cleanup = {}) {
  return buildCleanupPlan(toolId, {
    name,
    files: homePaths(cleanup.files || [], options),
    trees: homePaths(cleanup.trees || [], options),
    runtimeOptions: options,
    effect: `移除 ${name} 的程序文件；项目和包缓存不在声明范围内时会保留`
  });
}

function buildProfileAwareCleanupPlan(toolId, name, patterns, cleanup, options = {}) {
  const home = resolveHome(options);
  const files = homePaths(cleanup.files || [], options);
  const trees = homePaths(cleanup.trees || [], options);
  const safePatterns = (Array.isArray(patterns) ? patterns : [patterns])
    .map((pattern) => String(pattern || '').trim())
    .filter(Boolean);
  const script = [
    'set -e',
    ...safePatterns.map((pattern, index) => `pattern_${index}=${shellQuote(pattern)}`),
    'for profile in "$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do',
    '  [ -f "$profile" ] || continue',
    '  tmp="${profile}.aih-cleanup.$$"',
    '  cp "$profile" "$tmp"',
    ...safePatterns.map((_pattern, index) => `  grep -v -E "$pattern_${index}" "$tmp" > "${'${tmp}'}.next" || true; mv "${'${tmp}'}.next" "$tmp"`),
    '  if cmp -s "$profile" "$tmp"; then rm -f "$tmp"; else mv "$tmp" "$profile"; fi',
    'done',
    ...files.map((target) => `rm -f -- ${shellQuote(target)}`),
    ...trees.map((target) => `rm -rf -- ${shellQuote(target)}`)
  ].join('\n');
  return createLifecyclePlan(toolId, 'uninstall', 'bash', ['-c', script], {
    id: `${toolId}_uninstall_profile_cleanup`,
    label: `卸载 ${name}`,
    method: 'AIH 清理器',
    effect: `移除 ${name} 程序文件，并从 Shell 配置中删除该工具的初始化行`
  });
}

function buildWindowsCleanupPlan(toolId, name, options = {}, cleanup = {}) {
  return buildHomeCleanupPlan(toolId, name, { ...options, platform: 'windows' }, cleanup);
}

function buildSelfUpdatePlan(toolId, name, command, args = []) {
  return buildCommandPlan(toolId, 'update', command, args, {
    id: `${toolId}_self_update`,
    label: `${name} 自更新`,
    method: '内置更新器',
    effect: `更新 ${name}`
  });
}

module.exports = {
  buildHomeCleanupPlan,
  buildProfileAwareCleanupPlan,
  buildSelfUpdatePlan,
  buildWindowsCleanupPlan,
  homePaths,
  resolveHome,
  resolvePath
};
