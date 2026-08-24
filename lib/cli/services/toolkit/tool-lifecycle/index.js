'use strict';

const { normalizeClientPlatform } = require('../../../../runtime/client-platform');
const { resolveLinuxToolPlans } = require('./platforms/linux');
const { resolveMacosToolPlans } = require('./platforms/macos');
const { resolveWindowsToolPlans } = require('./platforms/windows');
const {
  inspectFrpcOwnership,
  normalizeAction,
  normalizeArch,
  resolveManagedFrpcPath,
  resolvePlatform
} = require('./shared');

function lifecycleForTool(tool, options = {}) {
  if (!tool || tool.id !== 'frpc' || !tool.supported) {
    return {
      executablePath: String(tool && tool.executablePath || ''),
      managedBy: '',
      canInstall: false,
      canUpdate: false,
      canUninstall: false,
      lifecycle: { install: false, update: false, uninstall: false }
    };
  }
  const executablePath = String(tool.executablePath || '');
  const installed = Boolean(tool.installed);
  const releaseSupported = Boolean(normalizeArch(options));
  const ownership = installed
    ? inspectFrpcOwnership(executablePath, options)
    : { managed: false, homebrew: false, external: false };
  const owned = ownership.managed || ownership.homebrew || ownership.external;
  const canInstall = !installed && releaseSupported;
  const canUpdate = installed && owned && releaseSupported;
  const canUninstall = installed && owned;
  return {
    executablePath,
    managedPath: resolveManagedFrpcPath(options),
    managedBy: ownership.homebrew ? 'homebrew' : ownership.managed ? 'aih' : ownership.external ? 'external' : '',
    canInstall,
    canUpdate,
    canUninstall,
    lifecycle: { install: canInstall, update: canUpdate, uninstall: canUninstall }
  };
}

function resolveManagedToolPlans(tool, action, options = {}) {
  const normalizedAction = normalizeAction(action);
  if (!tool) return { ok: false, error: 'managed_tool_not_found', message: '工具不存在。' };
  if (!normalizedAction) return { ok: false, error: 'unsupported_managed_tool_action', message: '仅支持安装、更新和卸载。' };
  if (!tool.supported) return { ok: false, error: 'unsupported_platform', message: `${tool.name} 不支持当前系统。` };
  if (normalizedAction !== 'uninstall' && !normalizeArch(options)) {
    return { ok: false, error: 'unsupported_architecture', message: '当前 CPU 架构没有可用的 frpc 官方发布包。' };
  }

  const lifecycle = lifecycleForTool(tool, options);
  if (!lifecycle.lifecycle[normalizedAction]) {
    if (normalizedAction === 'install' && tool.installed) {
      return { ok: false, error: 'managed_tool_already_installed', message: `${tool.name} 已安装。` };
    }
    if (normalizedAction !== 'install' && !tool.installed) {
      return { ok: false, error: 'managed_tool_not_installed', message: `${tool.name} 尚未安装。` };
    }
    return {
      ok: false,
      error: 'managed_tool_lifecycle_contract_violation',
      message: '工具状态与生命周期计划不一致，请重新探测后重试。'
    };
  }

  const platform = resolvePlatform(options);
  const ownership = inspectFrpcOwnership(tool.executablePath, options);
  const plans = platform === 'darwin'
    ? resolveMacosToolPlans(tool.id, normalizedAction, ownership, options)
    : platform === 'win32'
      ? resolveWindowsToolPlans(tool.id, normalizedAction, ownership, options)
      : resolveLinuxToolPlans(tool.id, normalizedAction, ownership, options);
  if (!plans.length) {
    return { ok: false, error: 'managed_tool_lifecycle_contract_violation', message: '工具生命周期配置异常，请刷新后重试。' };
  }
  return {
    ok: true,
    platform: normalizeClientPlatform(platform),
    tool: { id: tool.id, name: tool.name, category: tool.category },
    action: normalizedAction,
    label: `${normalizedAction === 'install' ? '安装' : normalizedAction === 'update' ? '更新' : '卸载'} ${tool.name}`,
    plans,
    current: tool
  };
}

module.exports = {
  lifecycleForTool,
  resolveManagedToolPlans
};
