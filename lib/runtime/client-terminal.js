'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const nodeSpawn = require('node:child_process').spawn;
const {
  CLIENT_PLATFORMS,
  getClientPlatformAdapter,
  normalizeClientPlatform
} = require('./client-platform');
const { buildWindowsCmdLaunch, windowsSpawnOptions } = require('./windows-cmd-launch');
const { defineInstallLifecycle } = require('./install-lifecycle');
const { buildClientTerminalLifecyclePlans } = require('./client-terminal-lifecycle');

const DEFAULT_TERMINAL_ID = 'system-default';
const TERMINAL_IDS = Object.freeze({
  SYSTEM_DEFAULT: DEFAULT_TERMINAL_ID,
  WEZTERM: 'wezterm',
  WARP: 'warp',
  ITERM2: 'iterm2',
  WINDOWS_TERMINAL: 'windows-terminal',
  CMD: 'cmd'
});

const TERMINAL_SOURCE_URLS = Object.freeze({
  [TERMINAL_IDS.WEZTERM]: 'https://wezterm.org/install/',
  [TERMINAL_IDS.WARP]: 'https://www.warp.dev/terminal',
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

// pathEntryExists 兼容 Store 应用的 AppExecutionAlias：这类别名是 0 字节
// reparse point，stat 跟随解析点会 EACCES、existsSync 返回 false，而
// accessSync/lstat 只看目录项本身（2026-08-22 Windows Terminal 探测漏报：
// wt.exe 明明存在却被判定未安装）。
function pathEntryExists(fs, candidate) {
  try {
    if (fs.existsSync(candidate)) return true;
  } catch (_error) {}
  try {
    if (typeof fs.accessSync === 'function') {
      fs.accessSync(candidate);
      return true;
    }
  } catch (_error) {}
  try {
    if (typeof fs.lstatSync === 'function') {
      return Boolean(fs.lstatSync(candidate, { throwIfNoEntry: false }));
    }
  } catch (_error) {}
  return false;
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
      if (pathEntryExists(fs, candidate)) return candidate;
      if (platform === CLIENT_PLATFORMS.WINDOWS && !/\.[a-z0-9]+$/i.test(name)) {
        const executable = `${candidate}.exe`;
        if (pathEntryExists(fs, executable)) return executable;
      }
    }
  }
  return '';
}

function findFirstExisting(paths, fs) {
  for (const candidate of paths) {
    if (candidate && pathEntryExists(fs, candidate)) return candidate;
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

function shellQuote(value, platform) {
  const text = String(value == null ? '' : value);
  if (platform === CLIENT_PLATFORMS.WINDOWS) return `"${text.replace(/"/g, '\\"')}"`;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

// Windows Terminal 的 new-tab positional parser 会把含空格的每个参数再次
// 包进双引号。不能把整条 `cmd /k ...` 作为一个参数传入，否则 Terminal
// 会把它重组为 `"cmd.exe /k set" ...`，再由 CreateProcess 报 0x80070002。
// 这里仅拆解 aih 自己生成的 cmd 命令：去掉语法性外层双引号，保留参数值，
// 并把 && 作为独立 token；Terminal 随后会按参数边界重新生成合法命令行。
function tokenizeWindowsTerminalCommand(command) {
  const tokens = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|(\S+)/g;
  let match;
  while ((match = pattern.exec(String(command || '')))) {
    const token = String(match[1] ?? match[2] ?? '').trim();
    if (token) tokens.push(token);
  }
  return tokens;
}

function quoteWindowsStartToken(value) {
  const text = String(value == null ? '' : value);
  if (!text) return '""';
  if (/^[&|<>]+$/.test(text)) {
    return text.replace(/[&|<>]/g, (character) => `^${character}`);
  }
  if (/^[A-Za-z0-9_.:=/+\\-]+$/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function buildWindowsTerminalStartLine(executable, title, command) {
  const executableText = String(executable || '');
  const startExecutable = /[\\/]WindowsApps[\\/]wt\.exe$/i.test(executableText)
    ? 'wt.exe'
    : executableText;
  const childArgs = [
    '-w', 'new', 'new-tab', '--title', title,
    'cmd.exe', '/d', '/s', '/k',
    ...tokenizeWindowsTerminalCommand(command)
  ];
  const renderedArgs = childArgs.map((arg) => quoteWindowsStartToken(arg));
  return `start "" ${quoteWindowsStartToken(startExecutable)} ${renderedArgs.join(' ')}`;
}

function buildSystemDefaultLaunch(command, title, context = {}) {
  const resolved = resolveContext(context);
  const { env, fs, path, platform } = resolved;
  if (platform === CLIENT_PLATFORMS.WINDOWS) {
    // Win10/11 的「默认终端应用」deflection 从隐藏/无控制台的父进程启动时不生效
    // （实测 detached+windowsHide 启动链里 start 只能拿到 conhost 窗口），因此
    // system-default 在探测到 wt.exe 时直接委托 Windows Terminal 适配器；
    // 未安装 WT 的机器保持 cmd start 兜底。命令整链由内层 cmd /k 承载。
    const wtLaunch = buildWindowsTerminalLaunch(command, title, context);
    if (wtLaunch) return wtLaunch;
    return {
      terminalId: DEFAULT_TERMINAL_ID,
      ...buildWindowsCmdLaunch(command, { newConsole: true, title })
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
  const { env, fs, path, platform } = resolved;
  const platformConfig = definition.platforms && definition.platforms[platform];
  if (!platformConfig) return '';
  const hostHomeDir = readHostHome(resolved);
  const localAppData = String(env.LOCALAPPDATA || (hostHomeDir
    ? path.join(hostHomeDir, 'AppData', 'Local')
    : '')).trim();
  const expandPaths = (paths) => (paths || []).map((candidate) => {
    const expanded = String(candidate || '')
      .replaceAll('{hostHomeDir}', hostHomeDir)
      .replaceAll('{localAppData}', localAppData);
    return expanded ? path.normalize(expanded) : '';
  });
  const managedCandidate = findFirstExisting(expandPaths(platformConfig.managedPaths), fs);
  if (managedCandidate) return managedCandidate;
  const pathCandidate = findOnPath(platformConfig.binaryNames || [], resolved);
  if (pathCandidate) return pathCandidate;
  return findFirstExisting(expandPaths(platformConfig.paths), fs);
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

function buildWarpLaunch(_command, title, context = {}) {
  const resolved = resolveContext(context);
  const executable = resolveTerminalExecutable(TERMINAL_DEFINITIONS[TERMINAL_IDS.WARP], resolved);
  if (!executable) return null;
  if (resolved.platform === CLIENT_PLATFORMS.MACOS) {
    return {
      terminalId: TERMINAL_IDS.WARP,
      file: '/usr/bin/open',
      args: ['-n', '-a', 'Warp'],
      title
    };
  }
  return {
    terminalId: TERMINAL_IDS.WARP,
    file: executable,
    args: [],
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
  // `-w new` 强制弹独立新窗口；裸 new-tab 会把标签塞进最近使用的既有窗口，
  // 目标窗口在别的虚拟桌面/最小化时用户表现为「点了没反应」。注意 1.24 实测
  // 不认 new-window 子命令（会被当成待运行程序名打开失败窗口）。
  // 外层 cmd 只负责执行 start，必须保持隐藏；start 创建的 WT 窗口不受
  // 外层 CREATE_NO_WINDOW 影响。直接 spawn AppExecutionAlias 在 Node 的
  // detached 链路中可能只激活 WT 宿主而不传递 new-tab 命令，因此这里保留
  // windowsVerbatimArguments，让 cmd 收到完整的 start 命令字符串。
  return {
    terminalId: TERMINAL_IDS.WINDOWS_TERMINAL,
    file: 'cmd.exe',
    args: ['/d', '/s', '/c', buildWindowsTerminalStartLine(executable, title, command)],
    windowsHide: true,
    windowsVerbatimArguments: true,
    terminalExecutable: executable
  };
}

// buildCmdTerminalLaunch 打开经典 conhost 控制台窗口跑整条命令链；引号转义
// 知识统一封装在 windows-cmd-launch。
function buildCmdTerminalLaunch(command, title) {
  return {
    terminalId: TERMINAL_IDS.CMD,
    ...buildWindowsCmdLaunch(command, { newConsole: true, title })
  };
}

function buildInteractiveShellCommand(context = {}) {
  const resolved = resolveContext(context);
  if (resolved.platform === CLIENT_PLATFORMS.WINDOWS) return 'echo AI Home terminal';
  const shell = String(
    resolved.env.SHELL
      || resolved.platformAdapter && resolved.platformAdapter.commands && resolved.platformAdapter.commands.shell
      || (resolved.platform === CLIENT_PLATFORMS.MACOS ? '/bin/zsh' : '/bin/bash')
  ).trim();
  return `exec ${shellQuote(shell, resolved.platform)} -l`;
}

function resolveLifecycleExecutable(names, fallbackPaths, context = {}) {
  const resolved = resolveContext(context);
  return findOnPath(names, resolved) || findFirstExisting(fallbackPaths, resolved.fs);
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
        managedPaths: ['{hostHomeDir}/Applications/WezTerm.app/Contents/MacOS/wezterm'],
        paths: ['/Applications/WezTerm.app/Contents/MacOS/wezterm']
      },
      windows: {
        binaryNames: ['wezterm.exe', 'wezterm-gui.exe'],
        managedPaths: ['{localAppData}/Programs/WezTerm/wezterm.exe'],
        paths: ['{hostHomeDir}/scoop/apps/wezterm/current/wezterm.exe']
      },
      linux: {
        binaryNames: ['wezterm', 'wezterm-gui'],
        managedPaths: ['{hostHomeDir}/.local/bin/wezterm'],
        paths: ['/usr/bin/wezterm', '/usr/local/bin/wezterm']
      }
    },
    supports: () => true,
    detect: (context) => {
      const executablePath = resolveTerminalExecutable(TERMINAL_DEFINITIONS[TERMINAL_IDS.WEZTERM], context);
      return { installed: Boolean(executablePath), executablePath };
    },
    buildLaunch: buildWezTermLaunch,
    buildPlans: (context) => buildClientTerminalLifecyclePlans(
      TERMINAL_IDS.WEZTERM,
      context,
      { resolveExecutable: resolveLifecycleExecutable }
    )
  }),
  [TERMINAL_IDS.WARP]: defineClientTerminalAdapter({
    id: TERMINAL_IDS.WARP,
    name: 'Warp',
    description: '跨平台现代终端，支持 macOS、Windows 与 Linux。',
    sourceUrl: TERMINAL_SOURCE_URLS[TERMINAL_IDS.WARP],
    platforms: {
      macos: {
        binaryNames: [],
        managedPaths: ['{hostHomeDir}/Applications/Warp.app/Contents/MacOS/stable'],
        paths: ['/Applications/Warp.app/Contents/MacOS/stable']
      },
      windows: {
        binaryNames: ['warp.exe', 'Warp.exe'],
        managedPaths: ['{localAppData}/Programs/Warp/Warp.exe'],
        paths: ['{hostHomeDir}/AppData/Local/Programs/Warp/Warp.exe']
      },
      linux: {
        binaryNames: ['warp-terminal'],
        managedPaths: ['{hostHomeDir}/.local/bin/warp-terminal'],
        paths: ['/usr/bin/warp-terminal', '/usr/local/bin/warp-terminal']
      }
    },
    supports: () => true,
    detect: (context) => {
      const executablePath = resolveTerminalExecutable(TERMINAL_DEFINITIONS[TERMINAL_IDS.WARP], context);
      return { installed: Boolean(executablePath), executablePath };
    },
    buildLaunch: buildWarpLaunch,
    buildPlans: (context) => buildClientTerminalLifecyclePlans(
      TERMINAL_IDS.WARP,
      context,
      { resolveExecutable: resolveLifecycleExecutable }
    )
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
        `${readHostHome(resolved)}/Applications/iTerm.app`,
        '/Applications/iTerm.app'
      ], resolved.fs);
      return { installed: Boolean(appPath), executablePath: appPath };
    },
    buildLaunch: buildITermLaunch,
    buildPlans: (context) => buildClientTerminalLifecyclePlans(
      TERMINAL_IDS.ITERM2,
      context,
      { resolveExecutable: resolveLifecycleExecutable }
    )
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
    buildPlans: (context) => buildClientTerminalLifecyclePlans(
      TERMINAL_IDS.WINDOWS_TERMINAL,
      context,
      { resolveExecutable: resolveLifecycleExecutable }
    )
  }),
  [TERMINAL_IDS.CMD]: defineClientTerminalAdapter({
    id: TERMINAL_IDS.CMD,
    name: 'CMD',
    description: 'Windows 经典控制台（conhost）窗口，无需安装。',
    sourceUrl: '',
    platforms: {
      windows: {
        binaryNames: [],
        paths: []
      }
    },
    supports: (platform) => platform === CLIENT_PLATFORMS.WINDOWS,
    detect: () => ({ installed: true, executablePath: 'cmd.exe' }),
    buildLaunch: buildCmdTerminalLaunch,
    buildPlans: () => []
  })
});

function getClientTerminalAdapter(id) {
  return TERMINAL_DEFINITIONS[String(id || DEFAULT_TERMINAL_ID).trim().toLowerCase()] || null;
}

// applyWindowsTerminalPresentation 落实「Windows 没有系统默认终端概念」：
// 默认就是 Windows Terminal，其次是 CMD。system-default 条目不进列表，
// default 标记跟随实际探测结果（wt 可用标 WT，否则标 CMD），供 WebUI 选择器
// 展示「默认」徽标；单击链路仍以 system-default 请求，由
// buildSystemDefaultLaunch 按同样优先级解析。
function applyWindowsTerminalPresentation(entries) {
  const preferredOrder = [TERMINAL_IDS.WINDOWS_TERMINAL, TERMINAL_IDS.CMD, TERMINAL_IDS.WEZTERM, TERMINAL_IDS.WARP];
  const filtered = entries.filter((entry) => entry.id !== DEFAULT_TERMINAL_ID);
  const ordered = preferredOrder
    .map((id) => filtered.find((entry) => entry.id === id))
    .filter(Boolean);
  const rest = filtered.filter((entry) => !preferredOrder.includes(entry.id));
  const merged = [...ordered, ...rest].map((entry) => ({ ...entry, default: false }));
  const defaultEntry = merged.find((entry) => entry.id === TERMINAL_IDS.WINDOWS_TERMINAL && entry.installed)
    || merged.find((entry) => entry.id === TERMINAL_IDS.CMD)
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
