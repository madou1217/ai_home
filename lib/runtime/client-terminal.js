'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const nodeSpawn = require('node:child_process').spawn;
const {
  CLIENT_PLATFORMS,
  getClientPlatformAdapter,
  normalizeClientPlatform
} = require('./client-platform');
const { defineInstallLifecycle } = require('./install-lifecycle');

const DEFAULT_TERMINAL_ID = 'system-default';
const TERMINAL_IDS = Object.freeze({
  SYSTEM_DEFAULT: DEFAULT_TERMINAL_ID,
  WEZTERM: 'wezterm',
  ITERM2: 'iterm2',
  WINDOWS_TERMINAL: 'windows-terminal'
});

const TERMINAL_SOURCE_URLS = Object.freeze({
  [TERMINAL_IDS.WEZTERM]: 'https://wezterm.org/install/',
  [TERMINAL_IDS.ITERM2]: 'https://iterm2.com/documentation.html',
  [TERMINAL_IDS.WINDOWS_TERMINAL]: 'https://learn.microsoft.com/en-us/windows/terminal/install'
});

function normalizeEnv(options = {}) {
  const processObj = options.processObj || process;
  const source = options.env || processObj.env || process.env || {};
  return Object.fromEntries(Object.entries(source).map(([key, value]) => [key, String(value)]));
}

function resolveContext(options = {}) {
  const processObj = options.processObj || process;
  const platform = normalizeClientPlatform(options.platform || processObj.platform || process.platform);
  const platformAdapter = getClientPlatformAdapter(platform);
  const pathImpl = options.path || platformAdapter && platformAdapter.path || nodePath;
  return {
    ...options,
    platform,
    processObj,
    path: pathImpl,
    fs: options.fs || nodeFs,
    env: normalizeEnv(options),
    platformAdapter
  };
}

function findOnPath(names, context = {}) {
  const { env, fs, path, platform } = resolveContext(context);
  const candidates = (Array.isArray(names) ? names : [names])
    .map((name) => String(name || '').trim())
    .filter(Boolean);
  const delimiter = platform === CLIENT_PLATFORMS.WINDOWS ? ';' : (path.delimiter || ':');
  const dirs = String(env.PATH || env.Path || env.path || '')
    .split(delimiter)
    .map((dir) => dir.trim())
    .filter(Boolean);
  for (const dir of dirs) {
    for (const name of candidates) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
      if (platform === CLIENT_PLATFORMS.WINDOWS && !/\.[a-z0-9]+$/i.test(name)) {
        const executable = `${candidate}.exe`;
        if (fs.existsSync(executable)) return executable;
      }
    }
  }
  return '';
}

function findFirstExisting(paths, fs) {
  for (const candidate of paths) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return '';
}

function readHostHome(context) {
  const { env, platform } = context;
  return String(context.hostHomeDir || (platform === CLIENT_PLATFORMS.WINDOWS
    ? env.USERPROFILE
    : env.HOME) || '').trim();
}

function escapeAppleScriptString(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeWindowsTitle(value) {
  return String(value || '').replace(/"/g, "'");
}

function shellQuote(value, platform) {
  const text = String(value == null ? '' : value);
  if (platform === CLIENT_PLATFORMS.WINDOWS) return `"${text.replace(/"/g, '\\"')}"`;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function buildSystemDefaultLaunch(command, title, context = {}) {
  const resolved = resolveContext(context);
  const { env, fs, path, platform } = resolved;
  if (platform === CLIENT_PLATFORMS.WINDOWS) {
    return {
      terminalId: DEFAULT_TERMINAL_ID,
      file: 'cmd.exe',
      args: ['/c', `start "${escapeWindowsTitle(title)}" cmd /k ${command}`]
    };
  }
  if (platform === CLIENT_PLATFORMS.MACOS) {
    const script = [
      'tell application "Terminal"',
      'activate',
      `do script "${escapeAppleScriptString(command)}"`,
      'end tell'
    ];
    return {
      terminalId: DEFAULT_TERMINAL_ID,
      file: 'osascript',
      args: script.flatMap((line) => ['-e', line])
    };
  }
  if (platform === CLIENT_PLATFORMS.LINUX) {
    const candidates = [];
    const requested = String(env.TERMINAL || '').trim();
    if (requested) candidates.push([requested, '-e']);
    candidates.push(
      ['x-terminal-emulator', '-e'],
      ['gnome-terminal', '--'],
      ['konsole', '-e'],
      ['xfce4-terminal', '-e'],
      ['alacritty', '-e']
    );
    for (const [name, prefix] of candidates) {
      const executable = path.isAbsolute(name) && fs.existsSync(name)
        ? name
        : findOnPath([name], resolved);
      if (executable) {
        return {
          terminalId: DEFAULT_TERMINAL_ID,
          file: executable,
          args: [prefix, 'bash', '-lc', command]
        };
      }
    }
  }
  return null;
}

function resolveTerminalExecutable(definition, context = {}) {
  const resolved = resolveContext(context);
  const { fs, path, platform } = resolved;
  const platformConfig = definition.platforms && definition.platforms[platform];
  if (!platformConfig) return '';
  const pathCandidate = findOnPath(platformConfig.binaryNames || [], resolved);
  if (pathCandidate) return pathCandidate;
  return findFirstExisting((platformConfig.paths || []).map((candidate) => String(candidate || '')
    .replace('{hostHomeDir}', readHostHome(resolved))), fs);
}

function buildWezTermLaunch(command, title, context = {}) {
  const resolved = resolveContext(context);
  const executable = resolveTerminalExecutable(TERMINAL_DEFINITIONS[TERMINAL_IDS.WEZTERM], resolved);
  if (!executable) return null;
  if (resolved.platform === CLIENT_PLATFORMS.WINDOWS) {
    return {
      terminalId: TERMINAL_IDS.WEZTERM,
      file: executable,
      args: ['start', '--always-new-process', '--', 'cmd.exe', '/k', command]
    };
  }
  return {
    terminalId: TERMINAL_IDS.WEZTERM,
    file: executable,
    args: ['start', '--always-new-process', '--', 'bash', '-lc', command],
    title
  };
}

function buildITermLaunch(command, title, context = {}) {
  const resolved = resolveContext(context);
  const detection = TERMINAL_DEFINITIONS[TERMINAL_IDS.ITERM2].detect(resolved);
  if (!detection || !detection.installed) return null;
  const script = [
    'tell application "iTerm2"',
    'activate',
    'tell current window',
    'create tab with default profile',
    `tell current session to write text "${escapeAppleScriptString(command)}"`,
    'end tell',
    'end tell'
  ];
  return {
    terminalId: TERMINAL_IDS.ITERM2,
    file: 'osascript',
    args: script.flatMap((line) => ['-e', line]),
    title
  };
}

function buildWindowsTerminalLaunch(command, title, context = {}) {
  const resolved = resolveContext(context);
  const executable = resolveTerminalExecutable(TERMINAL_DEFINITIONS[TERMINAL_IDS.WINDOWS_TERMINAL], resolved);
  if (!executable) return null;
  return {
    terminalId: TERMINAL_IDS.WINDOWS_TERMINAL,
    file: executable,
    args: ['new-tab', '--title', title, 'cmd.exe', '/k', command]
  };
}

function resolvePackageManager(platform, context = {}) {
  const resolved = resolveContext({ ...context, platform });
  const candidates = platform === CLIENT_PLATFORMS.MACOS
    ? [{ id: 'homebrew', names: ['brew'] }]
    : platform === CLIENT_PLATFORMS.WINDOWS
      ? [{ id: 'winget', names: ['winget'] }]
      : [{ id: 'flatpak', names: ['flatpak'] }];
  for (const candidate of candidates) {
    const executable = findOnPath(candidate.names, resolved);
    if (executable) return { ...candidate, executable };
  }
  return null;
}

function buildPackagePlans(packageManager, packageId, label) {
  if (!packageManager) return [];
  const { id, executable } = packageManager;
  if (id === 'homebrew') {
    return [
      { action: 'install', label: `安装 ${label}`, packageManager: id, file: executable, args: ['install', '--cask', packageId] },
      { action: 'update', label: `更新 ${label}`, packageManager: id, file: executable, args: ['upgrade', '--cask', packageId] },
      { action: 'uninstall', label: `卸载 ${label}`, packageManager: id, file: executable, args: ['uninstall', '--cask', packageId] }
    ];
  }
  if (id === 'winget') {
    return [
      { action: 'install', label: `安装 ${label}`, packageManager: id, file: executable, args: ['install', '--id', packageId, '--exact', '--source', 'winget'] },
      { action: 'update', label: `更新 ${label}`, packageManager: id, file: executable, args: ['upgrade', '--id', packageId, '--exact', '--source', 'winget'] },
      { action: 'uninstall', label: `卸载 ${label}`, packageManager: id, file: executable, args: ['uninstall', '--id', packageId, '--exact'] }
    ];
  }
  return [
    { action: 'install', label: `安装 ${label}`, packageManager: id, file: executable, args: ['install', '--user', '-y', 'flathub', packageId] },
    { action: 'update', label: `更新 ${label}`, packageManager: id, file: executable, args: ['update', '--user', '-y', packageId] },
    { action: 'uninstall', label: `卸载 ${label}`, packageManager: id, file: executable, args: ['uninstall', '--user', '-y', packageId] }
  ];
}

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
 * @property {(platform: string) => boolean} supports 是否支持公共平台。
 * @property {(context: Object) => Object} detect 探测安装状态。
 * @property {(command: string, title: string, context: Object) => Object|null} buildLaunch 构造启动规格。
 * @property {(context: Object) => Object[]} buildPlans 构造安装管理计划。
 * @property {(context: Object) => Object|null} install 安装动作。
 * @property {(context: Object) => Object|null} update 更新动作。
 * @property {(context: Object) => Object|null} uninstall 卸载动作。
 */

// defineClientTerminalAdapter 是终端实现的抽象接口边界；平台差异只能留在适配器内部。
function defineClientTerminalAdapter(definition) {
  if (!definition || typeof definition !== 'object') throw new TypeError('client terminal adapter must be an object');
  const id = String(definition.id || '').trim();
  if (!id || typeof definition.supports !== 'function' || typeof definition.detect !== 'function'
    || typeof definition.buildLaunch !== 'function' || typeof definition.buildPlans !== 'function') {
    throw new TypeError(`invalid client terminal adapter: ${id || '(empty)'}`);
  }
  const lifecycle = defineInstallLifecycle({
    install: definition.install || ((context) => pickLifecyclePlan(definition.buildPlans, 'install', context)),
    update: definition.update || ((context) => pickLifecyclePlan(definition.buildPlans, 'update', context)),
    uninstall: definition.uninstall || ((context) => pickLifecyclePlan(definition.buildPlans, 'uninstall', context))
  }, `client terminal adapter ${id}`);
  return Object.freeze({
    id,
    name: String(definition.name || id),
    description: String(definition.description || ''),
    sourceUrl: String(definition.sourceUrl || ''),
    platforms: definition.platforms || {},
    supports: definition.supports,
    detect: definition.detect,
    buildLaunch: definition.buildLaunch,
    buildPlans: definition.buildPlans,
    ...lifecycle,
    default: Boolean(definition.default)
  });
}

const TERMINAL_DEFINITIONS = Object.freeze({
  [TERMINAL_IDS.SYSTEM_DEFAULT]: defineClientTerminalAdapter({
    id: DEFAULT_TERMINAL_ID,
    name: '系统默认终端',
    description: '使用当前操作系统配置的默认终端。',
    sourceUrl: '',
    default: true,
    supports: () => true,
    detect: () => ({ installed: true, executablePath: '' }),
    buildLaunch: buildSystemDefaultLaunch,
    buildPlans: () => []
  }),
  [TERMINAL_IDS.WEZTERM]: defineClientTerminalAdapter({
    id: TERMINAL_IDS.WEZTERM,
    name: 'WezTerm',
    description: '跨平台 GPU 终端，支持 macOS、Windows 与 Linux。',
    sourceUrl: TERMINAL_SOURCE_URLS[TERMINAL_IDS.WEZTERM],
    platforms: {
      macos: {
        binaryNames: ['wezterm', 'wezterm-gui'],
        paths: ['/Applications/WezTerm.app/Contents/MacOS/wezterm', '{hostHomeDir}/Applications/WezTerm.app/Contents/MacOS/wezterm']
      },
      windows: {
        binaryNames: ['wezterm.exe', 'wezterm-gui.exe'],
        paths: ['{hostHomeDir}/scoop/apps/wezterm/current/wezterm.exe']
      },
      linux: {
        binaryNames: ['wezterm', 'wezterm-gui'],
        paths: ['/usr/bin/wezterm', '/usr/local/bin/wezterm', '{hostHomeDir}/.local/bin/wezterm']
      }
    },
    supports: () => true,
    detect: (context) => {
      const executablePath = resolveTerminalExecutable(TERMINAL_DEFINITIONS[TERMINAL_IDS.WEZTERM], context);
      return { installed: Boolean(executablePath), executablePath };
    },
    buildLaunch: buildWezTermLaunch,
    buildPlans: (context) => {
      const packageManager = resolvePackageManager(context.platform, context);
      const packageId = packageManager && packageManager.id === 'flatpak'
        ? 'org.wezfurlong.wezterm'
        : context.platform === CLIENT_PLATFORMS.WINDOWS ? 'wez.wezterm' : 'wezterm';
      return buildPackagePlans(packageManager, packageId, 'WezTerm');
    }
  }),
  [TERMINAL_IDS.ITERM2]: defineClientTerminalAdapter({
    id: TERMINAL_IDS.ITERM2,
    name: 'iTerm2',
    description: 'macOS 常用终端，适合多窗口和多会话开发。',
    sourceUrl: TERMINAL_SOURCE_URLS[TERMINAL_IDS.ITERM2],
    supports: (platform) => platform === CLIENT_PLATFORMS.MACOS,
    detect: (context) => {
      const resolved = resolveContext(context);
      const appPath = findFirstExisting([
        '/Applications/iTerm.app',
        `${readHostHome(resolved)}/Applications/iTerm.app`
      ], resolved.fs);
      return { installed: Boolean(appPath), executablePath: appPath };
    },
    buildLaunch: buildITermLaunch,
    buildPlans: (context) => buildPackagePlans(resolvePackageManager(context.platform, context), 'iterm2', 'iTerm2')
  }),
  [TERMINAL_IDS.WINDOWS_TERMINAL]: defineClientTerminalAdapter({
    id: TERMINAL_IDS.WINDOWS_TERMINAL,
    name: 'Windows Terminal',
    description: 'Windows 官方终端宿主，支持 PowerShell、CMD 与 WSL。',
    sourceUrl: TERMINAL_SOURCE_URLS[TERMINAL_IDS.WINDOWS_TERMINAL],
    platforms: {
      windows: {
        binaryNames: ['wt.exe', 'wt'],
        paths: ['{hostHomeDir}/AppData/Local/Microsoft/WindowsApps/wt.exe']
      }
    },
    supports: (platform) => platform === CLIENT_PLATFORMS.WINDOWS,
    detect: (context) => {
      const executablePath = resolveTerminalExecutable(TERMINAL_DEFINITIONS[TERMINAL_IDS.WINDOWS_TERMINAL], context);
      return { installed: Boolean(executablePath), executablePath };
    },
    buildLaunch: buildWindowsTerminalLaunch,
    buildPlans: (context) => buildPackagePlans(resolvePackageManager(context.platform, context), 'Microsoft.WindowsTerminal', 'Windows Terminal')
  })
});

function getClientTerminalAdapter(id) {
  return TERMINAL_DEFINITIONS[String(id || DEFAULT_TERMINAL_ID).trim().toLowerCase()] || null;
}

function listClientTerminals(options = {}) {
  const context = resolveContext(options);
  return Object.values(TERMINAL_DEFINITIONS)
    .filter((adapter) => adapter.supports(context.platform))
    .map((adapter) => {
      const detection = adapter.detect(context) || {};
      const plans = ['install', 'update', 'uninstall']
        .map((action) => adapter[action](context))
        .filter(Boolean);
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
        packageManager: plans[0] ? String(plans[0].packageManager || '') : '',
        plans: plans.map((plan) => ({
          action: String(plan.action || ''),
          label: String(plan.label || ''),
          command: [plan.file, ...(plan.args || [])].map((part) => shellQuote(part, context.platform)).join(' ')
        }))
      };
    });
}

function resolveClientTerminalLaunch(terminalId, command, title, options = {}) {
  const normalizedId = String(terminalId || DEFAULT_TERMINAL_ID).trim().toLowerCase() || DEFAULT_TERMINAL_ID;
  const adapter = getClientTerminalAdapter(normalizedId);
  const context = resolveContext(options);
  if (!adapter || !adapter.supports(context.platform)) return null;
  return adapter.buildLaunch(command, title, context);
}

function resolveTerminalActionPlan(input = {}, options = {}) {
  const terminalId = String(input.terminalId || '').trim().toLowerCase();
  const action = String(input.action || '').trim().toLowerCase();
  const adapter = getClientTerminalAdapter(terminalId);
  const context = resolveContext(options);
  if (!adapter || !adapter.supports(context.platform) || !['install', 'update', 'uninstall'].includes(action)) {
    return { ok: false, error: 'unsupported_terminal_action' };
  }
  const plan = adapter[action](context);
  if (!plan) return { ok: false, error: 'terminal_action_unavailable' };
  const detection = adapter.detect(context) || {};
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
  resolveTerminalActionPlan,
  executeClientTerminalAction,
  executeTerminalPlan,
  shellQuote
};
