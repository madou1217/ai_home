'use strict';

const nodeSpawn = require('node:child_process').spawn;
const { CLIENT_PLATFORMS } = require('./client-platform');
const { windowsSpawnOptions } = require('./windows-cmd-launch');
const {
  DEFAULT_TERMINAL_ID,
  TERMINAL_IDS,
  TERMINAL_DEFINITIONS,
  defineClientTerminalAdapter,
  getClientTerminalAdapter,
  listClientTerminalAdapters
} = require('./client-terminals');
const {
  buildInteractiveShellCommand,
  findOnPath,
  resolveContext,
  shellQuote
} = require('./client-terminals/shared');

function applyWindowsTerminalPresentation(entries) {
  const preferredOrder = [
    TERMINAL_IDS.WINDOWS_TERMINAL,
    TERMINAL_IDS.CMD,
    TERMINAL_IDS.WEZTERM,
    TERMINAL_IDS.WARP
  ];
  const filtered = entries.filter((entry) => entry.id !== DEFAULT_TERMINAL_ID);
  const ordered = preferredOrder
    .map((id) => filtered.find((entry) => entry.id === id))
    .filter(Boolean);
  const rest = filtered.filter((entry) => !preferredOrder.includes(entry.id));
  const merged = [...ordered, ...rest].map((entry) => ({ ...entry, default: false }));
  const defaultEntry = merged.find((entry) => (
    entry.id === TERMINAL_IDS.WINDOWS_TERMINAL && entry.installed
  )) || merged.find((entry) => entry.id === TERMINAL_IDS.CMD) || null;
  if (defaultEntry) defaultEntry.default = true;
  return merged;
}

function listClientTerminals(options = {}) {
  const context = resolveContext(options);
  const entries = listClientTerminalAdapters()
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
          command: [plan.file, ...(plan.args || [])]
            .map((part) => shellQuote(part, context.platform))
            .join(' ')
        }))
      };
    });
  return context.platform === CLIENT_PLATFORMS.WINDOWS
    ? applyWindowsTerminalPresentation(entries)
    : entries;
}

function resolveClientTerminalLaunch(terminalId, command, title, options = {}) {
  const normalizedId = String(terminalId || DEFAULT_TERMINAL_ID).trim().toLowerCase()
    || DEFAULT_TERMINAL_ID;
  const adapter = getClientTerminalAdapter(normalizedId);
  const context = resolveContext(options);
  if (!adapter || !adapter.supports(context.platform)) return null;
  return adapter.buildLaunch(command, title, context);
}

function launchClientTerminal(terminalId = DEFAULT_TERMINAL_ID, options = {}) {
  const context = resolveContext(options);
  const normalizedId = String(terminalId || DEFAULT_TERMINAL_ID).trim().toLowerCase()
    || DEFAULT_TERMINAL_ID;
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
  if (!adapter || !adapter.supports(context.platform)
    || !['install', 'update', 'uninstall'].includes(action)) {
    return { ok: false, error: 'unsupported_terminal_action' };
  }
  const detection = adapter.detect(context) || {};
  const plan = adapter[action]({
    ...context,
    installedPath: String(detection.executablePath || '')
  });
  if (!plan) return { ok: false, error: 'terminal_action_unavailable' };
  if (action === 'install' && detection.installed) {
    return { ok: false, error: 'terminal_already_installed' };
  }
  if (action !== 'install' && !detection.installed) {
    return { ok: false, error: 'terminal_not_installed' };
  }
  return {
    ok: true,
    terminalId: adapter.id,
    action,
    label: plan.label,
    file: plan.file,
    args: plan.args,
    packageManager: String(plan.packageManager || ''),
    command: [plan.file, ...(plan.args || [])]
      .map((part) => shellQuote(part, context.platform))
      .join(' ')
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
    child.once('error', (error) => {
      resolve({ ok: false, error: String(error && error.message || error || 'terminal_action_failed') });
    });
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
  applyWindowsTerminalPresentation,
  buildInteractiveShellCommand,
  defineClientTerminalAdapter,
  executeClientTerminalAction,
  executeTerminalPlan,
  findOnPath,
  getClientTerminalAdapter,
  launchClientTerminal,
  listClientTerminals,
  resolveClientTerminalLaunch,
  resolveTerminalActionPlan,
  shellQuote
};
