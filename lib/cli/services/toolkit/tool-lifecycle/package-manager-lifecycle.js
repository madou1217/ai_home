'use strict';

const nodeOs = require('node:os');
const nodePath = require('node:path');
const { resolveHostHomeDir } = require('../../../../runtime/host-home');
const { buildWindowsDownloadStatements } = require('../../../../runtime/windows-install-script');
const {
  createPlan,
  normalizeAction,
  renderPlanCommand,
  resolveCommand,
  resolvePlatform
} = require('./shared');

/**
 * 声明式安装 / 更新 / 卸载：插件只描述「在哪個平台用什么装」，这里统一生成
 * **可确认、可执行**的计划（仍然只是一条命令，交给既有 lifecycle-plan-executor 跑并回传输出）。
 *
 * - darwin: Homebrew（brew install / upgrade / uninstall <formula>）
 * - linux : 发行版包管理器（apt-get，进程非 root 时用 `sudo -n`，没有免密 sudo 会当场失败并原样回显）
 * - win32 : 官方压缩包（PowerShell 下载 + 解压到 AIH 自管目录；卸载即删除该目录）
 *
 * 没写方法的平台不假装能装：返回 `managed_tool_lifecycle_unavailable` 与原因，
 * 由界面显示「本机没有可自动执行的安装方式」，而不是给一条没法确认的 shell 命令。
 */

const ACTION_LABELS = Object.freeze({ install: '安装', update: '更新', uninstall: '卸载' });

function resolveManagedToolDir(toolId, options = {}) {
  const id = String(toolId || '').trim().toLowerCase();
  if (!id) return '';
  const processObj = options.processObj || process;
  const env = options.env || processObj.env || process.env;
  if (resolvePlatform(options) === 'win32') {
    const localAppData = String(env.LOCALAPPDATA || '').trim()
      || nodePath.join(String(env.USERPROFILE || nodeOs.homedir()), 'AppData', 'Local');
    return nodePath.join(localAppData, 'AIHome', 'bin', id);
  }
  let home = String(options.hostHomeDir || '').trim();
  if (!home) {
    try {
      home = resolveHostHomeDir({ env, platform: processObj.platform, os: nodeOs });
    } catch (_error) {
      home = nodeOs.homedir();
    }
  }
  return nodePath.join(home, '.ai_home', 'bin', id);
}

function isHomebrewPath(targetPath) {
  const value = String(targetPath || '');
  if (!value) return false;
  return value.includes('/opt/homebrew/') || value.includes('/usr/local/Cellar/') || value.includes('\\homebrew\\');
}

function isUnderDir(targetPath, dir) {
  if (!targetPath || !dir) return false;
  const normalize = (input) => String(input).replace(/[\\/]+$/, '').toLowerCase();
  return normalize(targetPath).startsWith(normalize(dir));
}

function requireNoEmpty(value, field) {
  const list = Array.isArray(value) ? value.map((item) => String(item || '').trim()).filter(Boolean) : [];
  if (!list.length) throw Object.assign(new Error(`edge_lifecycle_missing_${field}`), { code: `edge_lifecycle_missing_${field}` });
  return list;
}

function methodFor(descriptor, platform) {
  if (platform === 'darwin' && descriptor.homebrew) {
    return { kind: 'homebrew', formula: String(descriptor.homebrew) };
  }
  if (platform === 'linux' && descriptor.apt) {
    const packages = requireNoEmpty(descriptor.apt.packages || descriptor.apt, 'apt_packages');
    return { kind: 'apt', packages };
  }
  if (platform === 'win32' && descriptor.windowsArchive) {
    const url = String(descriptor.windowsArchive.url || '').trim();
    if (!url) throw Object.assign(new Error('edge_lifecycle_missing_archive_url'), { code: 'edge_lifecycle_missing_archive_url' });
    return {
      kind: 'archive',
      url,
      binaryRelative: String(descriptor.windowsArchive.binaryRelative || '').trim()
    };
  }
  return null;
}

function describeLifecycle(tool, descriptor = {}, options = {}) {
  const installed = Boolean(tool && tool.installed);
  const executablePath = String(tool && tool.executablePath || '');
  const platform = resolvePlatform(options);
  let method = null;
  try {
    method = methodFor(descriptor, platform);
  } catch (_error) {
    method = null;
  }
  const managedDir = resolveManagedToolDir(tool && tool.id, options);
  const managedBy = !installed
    ? ''
    : isHomebrewPath(executablePath)
      ? 'homebrew'
      : isUnderDir(executablePath, managedDir)
        ? 'aih'
        // Linux 上系统包管理器装的：dpkg 拥有它，而 apt 就是我们能驱动的那个（可更新可卸载）。
        : method && method.kind === 'apt'
          ? 'apt'
          : 'external';
  const canInstall = !installed && Boolean(method);
  // 只更新/卸载「确实是 AIH 或包管理器装的」：外部自装的动它等于替用户装第二份/删他的东西。
  const owned = managedBy === 'aih' || managedBy === 'homebrew' || managedBy === 'apt';
  const canUpdate = installed && Boolean(method) && owned;
  const canUninstall = installed && Boolean(method) && owned;
  return {
    executablePath,
    managedDir,
    managedBy,
    method: method ? method.kind : '',
    canInstall,
    canUpdate,
    canUninstall,
    lifecycle: { install: canInstall, update: canUpdate, uninstall: canUninstall }
  };
}

function buildHomebrewPlans(tool, action, method, options) {
  const dir = resolveManagedToolDir(tool.id, options);
  const zip = nodePath.join(nodeOs.tmpdir(), `${tool.id}-aih-install.zip`);
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  // 一条命令完成：建目录 → 下载官方包 → 解压 → 清理。失败即整条失败（$ErrorActionPreference=Stop）。
  return [
    "$ErrorActionPreference='Stop'",
    `$dir=${quote(dir)}`,
    'New-Item -ItemType Directory -Force -Path $dir | Out-Null',
    `$zip=${quote(zip)}`,
    buildWindowsDownloadStatements({ url: method.url, dest: '$zip', label: `${tool.name} 安装包` }),
    'Expand-Archive -Force $zip $dir',
    'Remove-Item $zip -Force'
  ].join('; ');
}

function archiveInstallScript(tool, method, options) {
  const dir = resolveManagedToolDir(tool.id, options);
  const zip = nodePath.join(nodeOs.tmpdir(), `${tool.id}-aih-install.zip`);
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  // 一条命令完成：建目录 → 下载官方包 → 解压 → 清理。失败即整条失败（$ErrorActionPreference=Stop）。
  return [
    "$ErrorActionPreference='Stop'",
    `$dir=${quote(dir)}`,
    'New-Item -ItemType Directory -Force -Path $dir | Out-Null',
    `$zip=${quote(zip)}`,
    buildWindowsDownloadStatements({ url: method.url, dest: '$zip', label: `${tool.name} 安装包` }),
    'Expand-Archive -Force $zip $dir',
    'Remove-Item $zip -Force'
  ].join('; ');
}

function buildArchivePlans(tool, action, method, options) {
  const dir = resolveManagedToolDir(tool.id, options);
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  if (action === 'uninstall') {
    return [createPlan(tool.id, action, 'powershell', ['-NoProfile', '-Command', `Remove-Item -Recurse -Force ${quote(dir)} -ErrorAction SilentlyContinue`], {
      id: `${tool.id}_uninstall_archive`,
      label: `卸载 ${tool.name}（删除 AIH 自管目录）`,
      method: 'archive',
      effect: `删除 ${dir}（只删 AIH 自己装的那份）`,
      runtimeOptions: options
    })];
  }
  return [createPlan(tool.id, action, 'powershell', ['-NoProfile', '-Command', archiveInstallScript(tool, method, options)], {
    id: `${tool.id}_${action}_archive`,
    label: `${ACTION_LABELS[action]} ${tool.name}（官方压缩包）`,
    method: 'archive',
    effect: `下载官方包并解压到 ${dir}`,
    runtimeOptions: options
  })];
}

function describePlatformName(options = {}) {
  const platform = resolvePlatform(options);
  if (platform === 'darwin') return 'macOS';
  if (platform === 'win32') return 'Windows';
  return 'Linux';
}

function resolveLifecyclePlans(tool, action, descriptor = {}, options = {}) {
  const normalizedAction = normalizeAction(action);
  if (!tool) return { ok: false, error: 'managed_tool_not_found', message: '工具不存在。' };
  if (!normalizedAction) return { ok: false, error: 'unsupported_managed_tool_action', message: '仅支持安装、更新和卸载。' };
  if (!tool.supported) return { ok: false, error: 'unsupported_platform', message: `${tool.name} 不支持当前系统。` };

  const described = describeLifecycle(tool, descriptor, options);
  if (!described.lifecycle[normalizedAction]) {
    if (normalizedAction === 'install' && tool.installed) {
      return { ok: false, error: 'managed_tool_already_installed', message: `${tool.name} 已安装。` };
    }
    if (normalizedAction !== 'install' && !tool.installed) {
      return { ok: false, error: 'managed_tool_not_installed', message: `${tool.name} 尚未安装。` };
    }
    if (!described.method) {
      return {
        ok: false,
        error: 'managed_tool_lifecycle_unavailable',
        message: `${describePlatformName(options)} 上没有可自动执行的${ACTION_LABELS[normalizedAction]}方式，请手动安装后再回来管理配置与服务。`
      };
    }
    return {
      ok: false,
      error: 'managed_tool_lifecycle_contract_violation',
      message: `${tool.name} 不是 AIH 或包管理器安装的，AIH 不动它；需要时请用原安装方式处理。`
    };
  }

  let method = null;
  try {
    method = methodFor(descriptor, resolvePlatform(options));
  } catch (error) {
    return { ok: false, error: String(error.code || 'managed_tool_lifecycle_unavailable'), message: String(error.message || '') };
  }
  const plans = method.kind === 'homebrew'
    ? buildHomebrewPlans(tool, normalizedAction, method, options)
    : method.kind === 'apt'
      ? buildAptPlans(tool, normalizedAction, method, options)
      : buildArchivePlans(tool, normalizedAction, method, options);
  if (!plans.length) return { ok: false, error: 'managed_tool_lifecycle_contract_violation', message: '工具生命周期配置异常，请刷新后重试。' };
  return {
    ok: true,
    platform: resolvePlatform(options),
    tool: { id: tool.id, name: tool.name, category: tool.category },
    action: normalizedAction,
    label: `${ACTION_LABELS[normalizedAction]} ${tool.name}`,
    plans,
    current: tool
  };
}

/** 插件用一行声明接入本模块：`lifecycle: packageManagerLifecycle({ homebrew, apt, windowsArchive })`。 */
function packageManagerLifecycle(descriptor = {}) {
  return Object.freeze({
    describe: (tool, options) => describeLifecycle(tool, descriptor, options),
    resolvePlans: (tool, action, options) => resolveLifecyclePlans(tool, action, descriptor, options)
  });
}

module.exports = {
  describeLifecycle,
  packageManagerLifecycle,
  renderPlanCommand,
  resolveLifecyclePlans,
  resolveManagedToolDir
};

function buildHomebrewPlans(tool, action, method, options) {
  const brewPath = resolveCommand('brew', options) || 'brew';
  const verb = action === 'install' ? 'install' : action === 'update' ? 'upgrade' : 'uninstall';
  return [createPlan(tool.id, action, brewPath, [verb, method.formula], {
    id: `${tool.id}_${action}_homebrew`,
    label: `${ACTION_LABELS[action]} ${tool.name}（Homebrew）`,
    method: 'homebrew',
    effect: action === 'uninstall'
      ? `卸载 Homebrew 管理的 ${method.formula}`
      : `${ACTION_LABELS[action]} Homebrew formula ${method.formula}`,
    runtimeOptions: options
  })];
}

function buildAptPlans(tool, action, method, options) {
  const processObj = options.processObj || process;
  const packages = method.packages;
  const asRoot = typeof processObj.getuid === 'function' && processObj.getuid() === 0;
  // 非 root 时用 `sudo -n`：没有免密 sudo 会在执行阶段立刻失败并把原话回显，不会卡住等密码。
  const command = asRoot ? 'apt-get' : 'sudo';
  const args = action === 'uninstall'
    ? ['remove', '-y', ...packages]
    : action === 'update'
      ? ['install', '--only-upgrade', '-y', ...packages]
      : ['install', '-y', ...packages];
  return [createPlan(tool.id, action, command, asRoot ? args : ['-n', 'apt-get', ...args], {
    id: `${tool.id}_${action}_apt`,
    label: `${ACTION_LABELS[action]} ${tool.name}（${asRoot ? 'apt' : 'sudo -n apt'}）`,
    method: 'apt',
    effect: action === 'uninstall'
      ? `卸载系统包 ${method.packages.join('、')}`
      : `${ACTION_LABELS[action]}系统包 ${method.packages.join('、')}${asRoot ? '' : '（需要免密 sudo，否则会失败并回显原因）'}`,
    runtimeOptions: options
  })];
}
