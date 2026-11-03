'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { resolvePlatformPath } = require('../../../../runtime/platform-path');
const { packageManagerLifecycle } = require('./package-manager-lifecycle');
const { buildCleanupPlan } = require('../environment/plan-builders');
const { createPlan, normalizeAction, resolveEnv, resolveHostHome, resolvePlatform, samePath } = require('./shared');

const brew = packageManagerLifecycle({ homebrew: 'herdr' });

function resolveHerdrPath(options = {}) {
  const env = resolveEnv(options);
  const platform = resolvePlatform(options);
  const p = resolvePlatformPath(platform, options.path || path);
  const home = resolveHostHome(options);
  if (!home) return '';
  return platform === 'win32'
    ? p.join(env.LOCALAPPDATA || p.join(home, 'AppData', 'Local'), 'Programs', 'Herdr', 'bin', 'herdr.exe')
    : p.join(home, '.local', 'bin', 'herdr');
}

function preferredExecutable(options = {}) {
  const candidate = resolveHerdrPath(options);
  return candidate && (options.fs || fs).existsSync(candidate) ? candidate : '';
}

function describe(tool, options = {}) {
  const fromBrew = brew.describe(tool, options);
  if (fromBrew.managedBy === 'homebrew') return fromBrew;
  const installed = Boolean(tool.installed);
  const supported = ['darwin', 'linux', 'win32'].includes(resolvePlatform(options))
    && ['x64', 'arm64'].includes(options.arch || (options.processObj || process).arch)
    && Boolean(resolveHerdrPath(options));
  const owned = samePath(tool.executablePath, resolveHerdrPath(options), options);
  const canInstall = !installed && supported;
  const canUpdate = installed && owned && supported;
  const canUninstall = installed && owned;
  return {
    executablePath: tool.executablePath,
    managedBy: installed ? (owned ? 'aih' : 'external') : '',
    canInstall, canUpdate, canUninstall,
    lifecycle: { install: canInstall, update: canUpdate, uninstall: canUninstall }
  };
}

function resolvePlans(tool, action, options = {}) {
  const verb = normalizeAction(action);
  const state = describe(tool, options);
  if (state.managedBy === 'homebrew') return brew.resolvePlans(tool, action, options);
  if (!verb || !state.lifecycle[verb]) return {
    ok: false, error: 'managed_tool_action_unavailable', message: '当前安装来源不支持此操作，请使用原安装方式管理。'
  };
  const target = resolveHerdrPath(options);
  const p = resolvePlatformPath(resolvePlatform(options), options.path || path);
  const plan = verb === 'uninstall'
    ? buildCleanupPlan('herdr', {
      files: [target],
      trees: resolvePlatform(options) === 'win32' ? [p.dirname(target)] : [],
      runtimeOptions: { ...options, path: p },
      effect: '移除 Herdr 程序与 Windows 运行时 sidecar，保留配置与会话数据'
    })
    : createPlan('herdr', verb, (options.processObj || process).execPath || process.execPath,
      [path.join(__dirname, 'herdr-release.js'), target], {
        method: 'official-release', label: `${verb === 'install' ? '安装' : '更新'} Herdr`,
        effect: '下载 Herdr 官方稳定版并核验 SHA256，原子替换程序文件', runtimeOptions: options
      });
  return { ok: true, tool: { id: tool.id, name: tool.name, category: tool.category }, action: verb, current: tool, plans: [plan] };
}

module.exports = { preferredExecutable, lifecycle: Object.freeze({ describe, resolvePlans }) };
