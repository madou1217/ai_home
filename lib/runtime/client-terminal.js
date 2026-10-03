'use strict';

const { spawn: nodeSpawn } = require('node:child_process');
const { CLIENT_PLATFORMS } = require('./client-platform');
const { windowsSpawnOptions } = require('./windows-cmd-launch');
const { defineInstallLifecycle } = require('./install-lifecycle');
const { buildClientTerminalLifecyclePlans } = require('./client-terminal-lifecycle');
const {
  DEFAULT_TERMINAL_ID,
  buildInteractiveShellCommand,
  findOnPath,
  resolveContext,
  resolveLifecycleExecutable,
  shellQuote
} = require('./client-terminal-support');
const { TERMINAL_PLUGINS } = require('./client-terminals');

const TERMINAL_IDS = Object.freeze({
  SYSTEM_DEFAULT: DEFAULT_TERMINAL_ID,
  WEZTERM: 'wezterm',
  WARP: 'warp',
  ITERM2: 'iterm2',
  WINDOWS_TERMINAL: 'windows-terminal',
  CMD: 'cmd'
});

function pickLifecyclePlan(buildPlans, action, context) {
  const plan = (buildPlans(context) || []).find((item) => item && item.action === action);
  return plan || null;
}

/**
 * @typedef {Object} ClientTerminalAdapterContract
 * @property {string} id 稳定的公共终端 ID。
 * @property {string} name 用户可见名称。
 * @property {string} description 用户可见说明。
 * @property {string} sourceUrl 官方安装/文档地址。
 * @property {string[]} platforms 支持的公共平台（数据）。
 * @property {(context: Object) => Object} detect 探测安装状态。
 * @property {(command: string, title: string, context: Object) => Object|null} buildLaunch 构造启动规格。
 * @property {Object<string, Function>} [lifecycle] 按平台构造安装管理计划。
 */

// defineClientTerminalAdapter 把终端插件描述符收敛为统一适配器；平台差异只能留在插件内部。
function defineClientTerminalAdapter(definition) {
  if (!definition || typeof definition !== 'object') throw new TypeError('client terminal adapter must be an object');
  const id = String(definition.id || '').trim();
  if (!id || !Array.isArray(definition.platforms) || typeof definition.detect !== 'function'
    || typeof definition.buildLaunch !== 'function') {
    throw new TypeError(`invalid client terminal adapter: ${id || '(empty)'}`);
  }
  const platforms = Object.freeze([...definition.platforms]);
  const buildPlans = typeof definition.buildPlans === 'function'
    ? definition.buildPlans
    : (context) => buildClientTerminalLifecyclePlans(definition, context, { resolveExecutable: resolveLifecycleExecutable });
  const lifecycle = defineInstallLifecycle({
    install: definition.install || ((context) => pickLifecyclePlan(buildPlans, 'install', context)),
    update: definition.update || ((context) => pickLifecyclePlan(buildPlans, 'update', context)),
    uninstall: definition.uninstall || ((context) => pickLifecyclePlan(buildPlans, 'uninstall', context))
  }, `client terminal adapter ${id}`);
  return Object.freeze({
    id,
    capability: String(definition.capability || 'toolkit.terminal'),
    name: String(definition.name || id),
    description: String(definition.description || ''),
    sourceUrl: String(definition.sourceUrl || ''),
    platforms,
    hiddenOnPlatforms: Object.freeze([...(definition.hiddenOnPlatforms || [])]),
    windowsOrder: Number.isInteger(definition.windowsOrder) ? definition.windowsOrder : null,
    windowsDefaultWhenInstalled: Boolean(definition.windowsDefaultWhenInstalled),
    windowsFallbackDefault: Boolean(definition.windowsFallbackDefault),
    supports: (platform) => platforms.includes(platform),
    detect: definition.detect,
    buildLaunch: definition.buildLaunch,
    buildPlans,
    ...lifecycle,
    default: Boolean(definition.default)
  });
}

const TERMINAL_DEFINITIONS = Object.freeze(Object.fromEntries(
  TERMINAL_PLUGINS.map((plugin) => [plugin.id, defineClientTerminalAdapter(plugin)])
));

function getClientTerminalAdapter(id) {
  return TERMINAL_DEFINITIONS[String(id || DEFAULT_TERMINAL_ID).trim().toLowerCase()] || null;
}

// applyWindowsTerminalPresentation 落实「Windows 没有系统默认终端概念」：
// 默认就是 Windows Terminal，其次是 CMD。system-default 条目不进列表，
// default 标记跟随实际探测结果（wt 可用标 WT，否则标 CMD），供 WebUI 选择器
// 展示「默认」徽标；单击链路仍以 system-default 请求，由
// buildSystemDefaultLaunch 按同样优先级解析。
function applyWindowsTerminalPresentation(entries) {
  const adapters = entries.map((entry) => TERMINAL_DEFINITIONS[entry.id]);
  const ordered = entries
    .map((entry, index) => ({ entry, adapter: adapters[index], index }))
    .filter(({ adapter }) => adapter && !adapter.hiddenOnPlatforms.includes(CLIENT_PLATFORMS.WINDOWS))
    .sort((left, right) => {
      const leftOrder = left.adapter.windowsOrder ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = right.adapter.windowsOrder ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || left.index - right.index;
    });
  const merged = ordered.map(({ entry }) => ({ ...entry, default: false }));
  const defaultEntry = merged.find((entry) => TERMINAL_DEFINITIONS[entry.id].windowsDefaultWhenInstalled && entry.installed)
    || merged.find((entry) => TERMINAL_DEFINITIONS[entry.id].windowsFallbackDefault)
    || null;
  if (defaultEntry) defaultEntry.default = true;
  return merged;
}

function listClientTerminals(options = {}) {
  const context = resolveContext(options);
  const entries = Object.values(TERMINAL_DEFINITIONS)
    .filter((adapter) => adapter.supports(context.platform))
    .map((adapter) => {
      const detection = adapter.detect(context) || {};
      const lifecycleContext = {
        ...context,
        installedPath: String(detection.executablePath || '')
      };
      const plans = ['install', 'update', 'uninstall']
        .map((action) => adapter[action](lifecycleContext))
        .filter(Boolean);
      const launch = adapter.buildLaunch(
        buildInteractiveShellCommand(context),
        'AI Home 终端',
        context
      );
      const actionSet = new Set(plans.map((plan) => String(plan.action || '').trim()));
      const installed = Boolean(detection.installed);
      return {
        id: adapter.id,
        name: adapter.name,
        description: adapter.description,
        sourceUrl: String(adapter.sourceUrl || ''),
        platform: context.platform,
        installed,
        default: adapter.default,
        executablePath: String(detection.executablePath || ''),
        canInstall: !installed && actionSet.has('install'),
        canUpdate: installed && actionSet.has('update'),
        canUninstall: installed && actionSet.has('uninstall'),
        canLaunch: Boolean(launch),
        packageManager: plans[0] ? String(plans[0].packageManager || '') : '',
        plans: plans.map((plan) => ({
          action: String(plan.action || ''),
          label: String(plan.label || ''),
          command: [plan.file, ...(plan.args || [])].map((part) => shellQuote(part, context.platform)).join(' ')
        }))
      };
    });
  if (context.platform === CLIENT_PLATFORMS.WINDOWS) {
    return applyWindowsTerminalPresentation(entries);
  }
  return entries;
}

function resolveClientTerminalLaunch(terminalId, command, title, options = {}) {
  const normalizedId = String(terminalId || DEFAULT_TERMINAL_ID).trim().toLowerCase() || DEFAULT_TERMINAL_ID;
  const adapter = getClientTerminalAdapter(normalizedId);
  const context = resolveContext(options);
  if (!adapter || !adapter.supports(context.platform)) return null;
  return adapter.buildLaunch(command, title, context);
}

function launchClientTerminal(terminalId = DEFAULT_TERMINAL_ID, options = {}) {
  const context = resolveContext(options);
  const normalizedId = String(terminalId || DEFAULT_TERMINAL_ID).trim().toLowerCase() || DEFAULT_TERMINAL_ID;
  const title = String(options.title || 'AI Home 终端').trim() || 'AI Home 终端';
  const launch = resolveClientTerminalLaunch(
    normalizedId,
    buildInteractiveShellCommand(context),
    title,
    context
  );
  if (!launch) return { ok: false, error: 'terminal_not_available' };

  const spawnImpl = options.spawn || nodeSpawn;
  let child;
  try {
    child = spawnImpl(launch.file, launch.args || [], {
      detached: true,
      stdio: 'ignore',
      windowsHide: launch.windowsHide !== false,
      ...windowsSpawnOptions(launch),
      ...options.spawnOptions
    });
  } catch (error) {
    return { ok: false, error: String(error && error.message || error || 'terminal_launch_failed') };
  }
  if (!child || typeof child.unref !== 'function') {
    return { ok: false, error: 'terminal_launch_failed' };
  }
  child.unref();
  return {
    ok: true,
    status: 'launched',
    terminalId: launch.terminalId || normalizedId,
    executable: launch.file,
    pid: Number.isFinite(child.pid) ? child.pid : null
  };
}

function resolveTerminalActionPlan(input = {}, options = {}) {
  const terminalId = String(input.terminalId || '').trim().toLowerCase();
  const action = String(input.action || '').trim().toLowerCase();
  const adapter = getClientTerminalAdapter(terminalId);
  const context = resolveContext(options);
  if (!adapter || !adapter.supports(context.platform) || !['install', 'update', 'uninstall'].includes(action)) {
    return { ok: false, error: 'unsupported_terminal_action' };
  }
  const detection = adapter.detect(context) || {};
  const plan = adapter[action]({
    ...context,
    installedPath: String(detection.executablePath || '')
  });
  if (!plan) return { ok: false, error: 'terminal_action_unavailable' };
  if (action === 'install' && detection.installed) return { ok: false, error: 'terminal_already_installed' };
  if (action !== 'install' && !detection.installed) return { ok: false, error: 'terminal_not_installed' };
  return {
    ok: true,
    terminalId: adapter.id,
    action,
    label: plan.label,
    file: plan.file,
    args: plan.args,
    packageManager: String(plan.packageManager || ''),
    command: [plan.file, ...(plan.args || [])].map((part) => shellQuote(part, context.platform)).join(' ')
  };
}

function executeTerminalPlan(plan, options = {}) {
  if (typeof options.runPlan === 'function') return Promise.resolve(options.runPlan(plan, options));
  const spawnImpl = options.spawn || nodeSpawn;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(plan.file, plan.args || [], {
        stdio: 'ignore',
        windowsHide: true,
        ...options.spawnOptions
      });
    } catch (error) {
      resolve({ ok: false, error: String(error && error.message || error || 'terminal_action_failed') });
      return;
    }
    if (!child || typeof child.once !== 'function') {
      resolve({ ok: false, error: 'terminal_action_failed' });
      return;
    }
    child.once('error', (error) => resolve({ ok: false, error: String(error && error.message || error || 'terminal_action_failed') }));
    child.once('close', (code) => resolve(code === 0
      ? { ok: true, status: 'succeeded' }
      : { ok: false, error: `terminal_action_exit_${Number(code)}` }));
  });
}

async function executeClientTerminalAction(input = {}, options = {}) {
  if (input.confirmed !== true) return { ok: false, error: 'confirmation_required' };
  const plan = resolveTerminalActionPlan(input, options);
  if (!plan.ok) return plan;
  const result = await executeTerminalPlan(plan, options);
  if (!result.ok) return result;
  const terminal = listClientTerminals(options).find((item) => item.id === plan.terminalId) || null;
  return { ok: true, status: 'succeeded', action: plan.action, terminal };
}

module.exports = {
  DEFAULT_TERMINAL_ID,
  TERMINAL_IDS,
  TERMINAL_DEFINITIONS,
  defineClientTerminalAdapter,
  findOnPath,
  getClientTerminalAdapter,
  listClientTerminals,
  resolveClientTerminalLaunch,
  buildInteractiveShellCommand,
  launchClientTerminal,
  resolveTerminalActionPlan,
  executeClientTerminalAction,
  executeTerminalPlan,
  shellQuote
};
