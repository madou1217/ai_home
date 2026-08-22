'use strict';

// 账号应用启动器：从 WebUI 为指定账号打开 Desktop 应用或新的 CLI 终端窗口。
// Desktop 启动复用 CLI 的按账号沙箱 env 隔离（provider-runtime-env），并为
// Electron 应用绑定独立的 --user-data-dir，保证多账号并行互不串号；
// CLI 启动直接复用 `aih <provider> <cliAccountId>` 完整启动链路（env 隔离、
// tmux 持久会话），不在这里重新实现。
// 参考 zcm.py 的 start_account/bind_electron_profile 启动机制（不含身份伪造部分）。

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { spawn: nodeSpawn, execFileSync: nodeExecFileSync } = require('node:child_process');
const { getProviderCLIConfig, getProviderDefinition, listProviderDefinitions } = require('../provider-catalog');
const {
  resolveAccountRef,
  resolveCliAccountRef,
  listCliAccountRefRecords
} = require('./account-ref-store');
const { readAccountCredentials } = require('./account-credential-store');
const { resolveAccountRuntimeDir } = require('../runtime/aih-storage-layout');
const {
  buildProviderRuntimeEnv,
  prepareProviderRuntime
} = require('../cli/services/ai-cli/provider-runtime-env');
const { normalizeClientPlatform } = require('../runtime/client-platform');
const { withHostSearchPath } = require('../runtime/host-search-path');
const {
  DEFAULT_TERMINAL_ID,
  resolveClientTerminalLaunch
} = require('../runtime/client-terminal');
const { windowsSpawnOptions } = require('../runtime/windows-cmd-launch');
const {
  ACCOUNT_APP_MARKER_ENV,
  PROVIDER_ACCOUNT_REF_ENV
} = require('../runtime/provider-session-context');
const {
  getDesktopLaunchStrategy,
  parseDesktopInstanceName
} = require('./desktop-launch');

const APP_KIND_DESKTOP = 'desktop';
const APP_KIND_CLI = 'cli';
const APP_ACTION_OPEN = 'open';
const APP_ACTION_CLOSE = 'close';
const CLI_APP_MARKER_ENV = ACCOUNT_APP_MARKER_ENV;

// app-entries 检测结果缓存时长，避免 WebUI 每次渲染都扫描全盘。
const APP_ENTRIES_CACHE_MS = 30 * 1000;
const RUNNING_ENTRIES_CACHE_MS = 1000;

const normalizePlatform = normalizeClientPlatform;

// resolvePlatformPath 让注入的通用 node:path 在跨平台测试和宿主运行时都使用
// 当前目标平台的分隔符；profileDir 的既有拼接保持由调用方控制。
function resolvePlatformPath(pathImpl, platformKey) {
  if (platformKey === 'windows' && pathImpl && pathImpl.win32) return pathImpl.win32;
  return pathImpl;
}

function fail(error, extra = {}) {
  return { ok: false, error, ...extra };
}

// 旧版本可能把 Desktop user-data 当成 provider 共享状态，留下指向
// `.aih-runtime-home` 的符号链接。启动前只拆除账号投影里的链接并创建
// 私有目录；链接目标保持原样，避免清理时误删历史状态。
function ensureAccountPrivateUserDataDir(fsImpl, userDataDir) {
  let existing = null;
  if (typeof fsImpl.lstatSync === 'function') {
    try {
      existing = fsImpl.lstatSync(userDataDir);
    } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
  }
  if (existing && existing.isSymbolicLink()) {
    fsImpl.unlinkSync(userDataDir);
  }
  fsImpl.mkdirSync(userDataDir, { recursive: true });
}

// findOnPath 按 PATH 顺序查找可执行文件，等价于 Windows `where` / POSIX `which`，
// 纯 fs 扫描便于注入测试且不依赖外部进程。
function findOnPath(execNames, env, fsImpl, pathImpl, platformKey) {
  const names = (Array.isArray(execNames) ? execNames : [])
    .map((name) => String(name || '').trim())
    .filter(Boolean);
  if (names.length === 0) return '';
  const delimiter = platformKey === 'windows' ? ';' : (pathImpl.delimiter || ':');
  const rawPath = String(env.PATH || env.Path || env.path || '');
  const dirs = rawPath.split(delimiter).map((dir) => dir.trim()).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidates = [pathImpl.join(dir, name)];
      // 测试可注入与目标平台不同风格的 path/fs；保留宿主 path 作为
      // 兼容候选，不改变真实 Windows/macOS/Linux 的首选解析结果。
      if (pathImpl !== nodePath) candidates.push(nodePath.join(dir, name));
      const existing = candidates.find((candidate) => fsImpl.existsSync(candidate));
      if (existing) return existing;
      if (platformKey === 'windows' && !/\.[a-z0-9]+$/i.test(name)) {
        const exeCandidates = candidates.map((candidate) => `${candidate}.exe`);
        const existingExe = exeCandidates.find((candidate) => fsImpl.existsSync(candidate));
        if (existingExe) return existingExe;
      }
    }
  }
  return '';
}

// readEnvVar 按大小写不敏感读取环境变量。Windows 上 process.env 的查询不敏感，
// 但 Object.keys 枚举保留存储大小写（如 PROGRAMFILES），直接 env.ProgramFiles
// 会漏读，安装目录检测因此失败。
function readEnvVar(env, key) {
  if (!env) return '';
  if (env[key]) return env[key];
  const lower = key.toLowerCase();
  for (const name of Object.keys(env)) {
    if (name.toLowerCase() === lower) return env[name];
  }
  return '';
}

// buildWindowsDesktopCandidates 组合 manifest installPaths 与常见安装目录。
function buildWindowsDesktopCandidates(platformConfig, env, pathImpl) {
  const clientName = String(platformConfig && platformConfig.clientName || '').trim();
  const execNames = (Array.isArray(platformConfig && platformConfig.execNames)
    ? platformConfig.execNames : [])
    .map((name) => String(name || '').trim())
    .filter(Boolean);
  const installPaths = (Array.isArray(platformConfig && platformConfig.installPaths)
    ? platformConfig.installPaths : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  const localAppData = readEnvVar(env, 'LOCALAPPDATA');
  const programFiles = readEnvVar(env, 'ProgramFiles');
  const programFilesX86 = readEnvVar(env, 'ProgramFiles(x86)');
  const roots = [
    localAppData && pathImpl.join(localAppData, 'Programs', clientName),
    programFiles && pathImpl.join(programFiles, clientName),
    programFilesX86 && pathImpl.join(programFilesX86, clientName)
  ].filter(Boolean);
  const candidates = installPaths.slice();
  for (const root of roots) {
    for (const execName of execNames) {
      candidates.push(pathImpl.join(root, execName));
    }
  }
  return candidates;
}

// resolveDesktopExecutable 按平台从 manifest 的 desktopClient 声明解析可执行文件。
function resolveDesktopExecutable(platformKey, platformConfig, context) {
  const { fs: fsImpl, path: pathImpl, env, hostHomeDir } = context;
  const execNames = (Array.isArray(platformConfig && platformConfig.execNames)
    ? platformConfig.execNames : [])
    .map((name) => String(name || '').trim())
    .filter(Boolean);

  if (platformKey === 'macos') {
    const installPaths = (Array.isArray(platformConfig && platformConfig.installPaths)
      ? platformConfig.installPaths : [])
      .map((value) => String(value || '').replace('{hostHomeDir}', hostHomeDir || '').trim())
      .filter(Boolean);
    for (const bundlePath of installPaths) {
      if (!fsImpl.existsSync(bundlePath)) continue;
      const execName = execNames.find((name) => (
        fsImpl.existsSync(pathImpl.join(bundlePath, 'Contents', 'MacOS', name))
      )) || execNames[0] || '';
      return {
        executablePath: execName ? pathImpl.join(bundlePath, 'Contents', 'MacOS', execName) : '',
        bundlePath
      };
    }
    return null;
  }

  if (platformKey === 'windows') {
    for (const candidate of buildWindowsDesktopCandidates(platformConfig, env, pathImpl)) {
      if (fsImpl.existsSync(candidate)) return { executablePath: candidate, bundlePath: '' };
    }
  }

  const onPath = findOnPath(execNames, env, fsImpl, pathImpl, platformKey);
  return onPath ? { executablePath: onPath, bundlePath: '' } : null;
}

// buildCliTerminalSpawn 构造各平台打开新终端窗口运行 aih CLI 的 spawn 参数。
function buildCliTerminalSpawn(platformKey, command, title, context) {
  const launch = resolveClientTerminalLaunch(DEFAULT_TERMINAL_ID, command, title, {
    ...context,
    platform: platformKey
  });
  if (!launch) return null;
  const { terminalId: _terminalId, title: _title, ...spawn } = launch;
  return spawn;
}

// sleepMs 同步等待，用于 posix 关闭时的 SIGTERM 宽限期。
function sleepMs(durationMs) {
  const timeout = Math.max(0, Number(durationMs) || 0);
  if (timeout <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, timeout);
}

// parseWindowsProcessJson 解析 Get-CimInstance Win32_Process 的 JSON 输出。
function parseWindowsProcessJson(output) {
  const raw = String(output || '').trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return (Array.isArray(parsed) ? parsed : [parsed])
    .filter(Boolean)
    .map((item) => ({
      pid: Number(item.ProcessId),
      ppid: Number(item.ParentProcessId),
      name: String(item.Name || ''),
      commandLine: String(item.CommandLine || '')
    }))
    .filter((item) => Number.isFinite(item.pid) && item.pid > 0);
}

// listWindowsDesktopProcesses 按 manifest 声明的进程名过滤出候选桌面进程。
function listWindowsDesktopProcesses(platformConfig, execFileSyncImpl) {
  const names = (Array.isArray(platformConfig && platformConfig.processNames)
    ? platformConfig.processNames : [])
    .concat(Array.isArray(platformConfig && platformConfig.execNames) ? platformConfig.execNames : [])
    .map((name) => String(name || '').trim())
    .filter(Boolean);
  if (names.length === 0) return [];
  const filter = [...new Set(names)]
    .map((name) => `Name='${name.replace(/'/g, "''")}'`)
    .join(' OR ');
  const output = execFileSyncImpl('powershell.exe', [
    '-NoProfile',
    '-Command',
    `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`
  ], { encoding: 'utf8', windowsHide: true });
  return parseWindowsProcessJson(output);
}

// listPosixProcesses 读取 pid + 完整命令行，供 user-data-dir 匹配。
function listPosixProcesses(execFileSyncImpl) {
  const output = execFileSyncImpl('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' });
  return String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/);
      return match ? { pid: Number(match[1]), commandLine: match[2] } : null;
    })
    .filter((item) => item && Number.isFinite(item.pid) && item.pid > 0);
}

function listPosixProcessTree(execFileSyncImpl) {
  const output = execFileSyncImpl('ps', ['-ax', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' });
  return String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(.+)$/);
      return match
        ? { pid: Number(match[1]), ppid: Number(match[2]), commandLine: match[3] }
        : null;
    })
    .filter((item) => item && Number.isFinite(item.pid) && item.pid > 0);
}

function listAllProcesses(platformKey, execFileSyncImpl) {
  if (platformKey === 'windows') {
    return parseWindowsProcessJson(execFileSyncImpl('powershell.exe', [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress'
    ], { encoding: 'utf8', windowsHide: true }));
  }
  return listPosixProcessTree(execFileSyncImpl);
}

function listDesktopProcessesForConfig(platformKey, platformConfig, execFileSyncImpl) {
  if (typeof execFileSyncImpl !== 'function') return [];
  const processes = platformKey === 'windows'
    ? listWindowsDesktopProcesses(platformConfig, execFileSyncImpl)
    : listPosixProcesses(execFileSyncImpl);
  const execNames = (Array.isArray(platformConfig && platformConfig.execNames)
    ? platformConfig.execNames : [])
    .map((name) => String(name || '').trim().toLowerCase())
    .filter(Boolean);
  return processes
    .filter((proc) => isDesktopMainCommandLine(proc.commandLine))
    .filter((proc) => {
      if (platformKey === 'windows') return true;
      const commandLine = String(proc.commandLine || '').toLowerCase();
      return execNames.some((name) => commandLine.includes(name));
    });
}

function matchDesktopProcessPids(processes, userDataDir, platformKey, applicationName = '') {
  const target = String(userDataDir || '').trim();
  const targetApplicationName = String(applicationName || '').trim().toLowerCase();
  if (!target && !targetApplicationName) return [];
  const needle = platformKey === 'windows' ? target.toLowerCase() : target;
  return (Array.isArray(processes) ? processes : [])
    .filter((proc) => {
      const commandLine = String(proc && proc.commandLine || '');
      if (!isDesktopMainCommandLine(commandLine)) return false;
      const found = parseDesktopUserDataDir(commandLine);
      if (found && target) {
        const normalized = platformKey === 'windows' ? found.toLowerCase() : found;
        if (normalized === needle) return true;
      }
      return Boolean(targetApplicationName)
        && parseDesktopInstanceName(commandLine).toLowerCase() === targetApplicationName;
    })
    .map((proc) => proc.pid)
    .filter((pid) => Number.isFinite(pid) && pid > 0);
}

// parseDesktopUserDataDir 从命令行提取 --user-data-dir 的值（兼容引号包裹）。
function parseDesktopUserDataDir(commandLine) {
  const text = String(commandLine || '');
  // Node spawn 对含空格参数会整段加引号（"--user-data-dir=C:\a b\..."），优先按整段引号匹配。
  const match = text.match(/"--user-data-dir=([^"]+)"/) || text.match(/--user-data-dir=("[^"]*"|\S+)/);
  if (!match) return '';
  return match[1].replace(/^"|"$/g, '');
}

// isDesktopMainCommandLine 排除 --type= 的 renderer/utility 子进程，只认主进程。
function isDesktopMainCommandLine(commandLine) {
  return !String(commandLine || '').includes('--type=');
}

// listRunningDesktopInstances 一次进程扫描列出带 --user-data-dir 的桌面主进程，
// 并兼容会改写命令行的 provider（其身份由 desktop-launch 策略反解 application
// name），供 app-entries 批量匹配账号运行态。
function listRunningDesktopInstances(platformKey, deps = {}) {
  const execFileSyncImpl = deps.execFileSync;
  if (typeof execFileSyncImpl !== 'function') return [];
  try {
    const processes = platformKey === 'windows'
      ? parseWindowsProcessJson(execFileSyncImpl('powershell.exe', [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress'
      ], { encoding: 'utf8', windowsHide: true }))
      : listPosixProcesses(execFileSyncImpl);
    return processes
      .filter((proc) => isDesktopMainCommandLine(proc.commandLine))
      .map((proc) => {
        const userDataDir = parseDesktopUserDataDir(proc.commandLine);
        const applicationName = parseDesktopInstanceName(proc.commandLine);
        return {
          pid: proc.pid,
          ...(userDataDir ? { userDataDir } : {}),
          ...(applicationName ? { applicationName } : {})
        };
      })
      .filter((instance) => instance.userDataDir || instance.applicationName);
  } catch (_error) {
    return [];
  }
}

function readCommandAssignment(commandLine, key) {
  const name = String(key || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const text = String(commandLine || '');
  const match = text.match(new RegExp(`(?:^|[;&\\s])(?:set\\s+)?["']?${name}=(?:"([^"]+)"|'([^']+)'|([^;&\\s"']+))["']?`, 'i'));
  return String(match && (match[1] || match[2] || match[3]) || '').trim();
}

function parseCliInvocation(commandLine) {
  const text = String(commandLine || '');
  const match = text.match(/(?:^|[\s"'])((?:[^\s"']*[\\/])?ai-home\.js|aih(?:\.cmd)?)(?:["']?)(?:\s+)([a-z0-9_-]+)\s+(\d+)(?=\s|$)/i);
  if (!match) return null;
  return {
    provider: String(match[2] || '').trim().toLowerCase(),
    cliAccountId: String(match[3] || '').trim()
  };
}

function isCliAppMarker(commandLine) {
  return readCommandAssignment(commandLine, CLI_APP_MARKER_ENV) === '1';
}

function listRunningCliInstances(platformKey, deps = {}) {
  const execFileSyncImpl = deps.execFileSync;
  if (typeof execFileSyncImpl !== 'function') return [];
  try {
    const processes = listAllProcesses(platformKey, execFileSyncImpl);
    const markedProcesses = processes.filter((processInfo) => isCliAppMarker(processInfo.commandLine));
    const findRootPid = (processInfo, rootPids) => {
      let current = processInfo;
      const visited = new Set();
      while (current && Number.isFinite(current.pid) && !visited.has(current.pid)) {
        visited.add(current.pid);
        if (rootPids.has(current.pid)) return current.pid;
        current = processes.find((candidate) => candidate.pid === current.ppid);
      }
      return null;
    };
    const output = [];
    const seen = new Set();
    for (const marked of markedProcesses) {
      const rootPids = new Set([marked.pid]);
      const related = processes.filter((processInfo) => findRootPid(processInfo, rootPids) === marked.pid);
      const invocation = [marked, ...related].map((processInfo) => parseCliInvocation(processInfo.commandLine)).find(Boolean);
      if (!invocation) continue;
      const accountRef = [marked, ...related]
        .map((processInfo) => readCommandAssignment(processInfo.commandLine, PROVIDER_ACCOUNT_REF_ENV))
        .find(Boolean) || '';
      for (const processInfo of related.length > 0 ? related : [marked]) {
        const key = `${marked.pid}:${processInfo.pid}`;
        if (seen.has(key)) continue;
        seen.add(key);
        output.push({
          pid: processInfo.pid,
          ppid: processInfo.ppid,
          provider: invocation.provider,
          cliAccountId: invocation.cliAccountId,
          accountRef,
          rootPid: marked.pid
        });
      }
    }
    return output;
  } catch (_error) {
    return [];
  }
}

// findRunningDesktopPids 找到本账号桌面实例的主进程：
// 命令行带该账号专属 --user-data-dir，且排除 --type= 的 renderer/utility 子进程。
function findRunningDesktopPids(userDataDir, platformConfig, platformKey, deps = {}) {
  const execFileSyncImpl = deps.execFileSync;
  const target = String(userDataDir || '').trim();
  const applicationName = String(deps.applicationName || '').trim();
  if (typeof execFileSyncImpl !== 'function' || (!target && !applicationName)) return [];
  let processes;
  try {
    processes = listDesktopProcessesForConfig(platformKey, platformConfig, execFileSyncImpl);
  } catch (_error) {
    return [];
  }
  return matchDesktopProcessPids(processes, target, platformKey, applicationName);
}

function createAccountAppLauncher(deps = {}) {
  const fsImpl = deps.fs || nodeFs;
  const pathImpl = deps.path || nodePath;
  const spawnImpl = deps.spawn || nodeSpawn;
  const execFileSyncImpl = deps.execFileSync || nodeExecFileSync;
  const processObj = deps.processObj || process;
  const aiHomeDir = String(deps.aiHomeDir || '').trim();
  const hostHomeDir = String(deps.hostHomeDir || '').trim();
  const repoRoot = String(deps.repoRoot || pathImpl.join(__dirname, '..', '..')).trim();
  const stopGraceMs = Math.max(0, Number(deps.stopGraceMs) || 800);

  function getBaseEnv() {
    const env = deps.env && typeof deps.env === 'object' ? deps.env : processObj.env;
    const out = {};
    Object.keys(env || {}).forEach((key) => {
      const value = env[key];
      if (value !== undefined && value !== null) out[key] = String(value);
    });
    return out;
  }

  function resolveAccount(accountRef) {
    if (typeof deps.resolveAccount === 'function') return deps.resolveAccount(accountRef);
    // CLI 启动必须联结 account_cli_aliases 才能拿到稳定的 cliAccountId；
    // 对历史上只有 account_refs 的 Desktop 数据保留安全回退。
    return resolveCliAccountRef(fsImpl, aiHomeDir, accountRef, { bestEffort: true })
      || resolveAccountRef(fsImpl, aiHomeDir, accountRef, { bestEffort: true });
  }

  function resolveProfileDir(provider, accountRef) {
    if (typeof deps.getProfileDir === 'function') {
      return String(deps.getProfileDir(provider, accountRef) || '').trim();
    }
    return resolveAccountRuntimeDir(aiHomeDir, provider, accountRef);
  }

  function readAccountEnv(accountRef) {
    if (typeof deps.readAccountEnv === 'function') return deps.readAccountEnv(accountRef) || {};
    return readAccountCredentials(fsImpl, aiHomeDir, accountRef);
  }

  // buildAccountLaunchEnv 复用 CLI 启动链路的沙箱 env 构造，
  // zcode 即通过该链路得到 ZCODE_DATA_BASE_DIR=<sandbox>/.zcode。
  function buildAccountLaunchEnv(provider, profileDir, account) {
    const baseEnv = getBaseEnv();
    const options = {
      accountEnv: readAccountEnv(account.accountRef),
      accountRef: account.accountRef,
      aiHomeDir,
      hostHomeDir,
      fs: fsImpl,
      path: pathImpl,
      platform: processObj.platform,
      execFileSync: deps.execFileSync,
      installSkill: false,
      launchKind: APP_KIND_DESKTOP
    };
    // 投影原生凭据到沙箱并确保 provider 策略目录（如 .zcode）存在；
    // 桌面应用与 CLI 共用同一份沙箱，登录态因此一致。
    prepareProviderRuntime(provider, profileDir, baseEnv, options);
    return buildProviderRuntimeEnv(provider, profileDir, baseEnv, options);
  }

  function spawnDetached(file, args, options) {
    const child = spawnImpl(file, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      ...options
    });
    if (child && typeof child.unref === 'function') child.unref();
    return child;
  }

  // buildDesktopLaunchContext 组装 provider 策略所需的全部上下文。启动器只负责
  // 提供通用事实（账号、沙箱、平台、可注入依赖），不理解任何 provider 语义。
  function buildDesktopLaunchContext(provider, account, profileDir, userDataDir, platformKey) {
    return {
      provider,
      account,
      accountRef: String((account && account.accountRef) || ''),
      profileDir,
      userDataDir,
      applicationName: '',
      platformKey,
      fs: fsImpl,
      // 与启动器其余路径拼接保持同一实现（沙箱目录本就由 pathImpl 拼出），
      // 策略不自行选择 path 实现。
      path: pathImpl,
      aiHomeDir,
      getBaseEnv,
      deps
    };
  }

  function launchDesktop(provider, account, profileDir, cliConfig) {
    const desktopClient = cliConfig.desktopClient;
    const platformKey = normalizePlatform(processObj.platform);
    const platformConfig = desktopClient && desktopClient[platformKey];
    if (!platformConfig) return fail('desktop_not_supported');
    const platformPath = resolvePlatformPath(pathImpl, platformKey);

    // Electron 标准隔离参数：按账号绑定独立 user-data 目录。
    const userDataDir = pathImpl.join(profileDir, 'electron-user-data');
    const strategy = getDesktopLaunchStrategy(provider);
    const ctx = buildDesktopLaunchContext(provider, account, profileDir, userDataDir, platformKey);
    // 单实例身份默认就是 --user-data-dir；会改写命令行的 provider 由自己的策略
    // 追加稳定 application name（同账号恒定、跨账号互异）。
    ctx.applicationName = String(strategy.resolveInstanceName(ctx) || '');

    const runningPids = findRunningDesktopPids(userDataDir, platformConfig, platformKey, {
      execFileSync: execFileSyncImpl,
      applicationName: ctx.applicationName
    });
    // 托管登录类 provider 不能在此早退：新种入的凭据仓只有重启后才会被读取，
    // 是否复用已有实例交给策略声明。
    if (runningPids.length > 0 && strategy.reuseRunningInstance) {
      return { ok: true, status: 'already_running', pids: runningPids };
    }

    const env = buildAccountLaunchEnv(provider, profileDir, account);
    const userDataEnvKey = String(desktopClient.userDataEnvKey || '').trim();
    if (userDataEnvKey) env[userDataEnvKey] = userDataDir;
    // provider 私有的桌面 env 语义（数据根、凭据密钥、实例名等）全部由策略叠加。
    strategy.decorateLaunchEnv(env, ctx);

    // 可执行文件解析用宿主 env：沙箱 env 会按账号隔离裁剪掉 ProgramFiles
    // 等机器级变量，而安装目录检测属于宿主机事实，不应被沙箱化。
    const resolved = resolveDesktopExecutable(platformKey, platformConfig, {
      fs: fsImpl,
      path: platformPath,
      env: getBaseEnv(),
      hostHomeDir
    });
    if (!resolved || !resolved.executablePath) return fail('desktop_not_installed');

    ensureAccountPrivateUserDataDir(fsImpl, userDataDir);

    const spawnPlan = strategy.resolveSpawnPlan(resolved, ctx);
    // 托管登录准备（默认放行）：失败即关闭启动，由 WebUI 引导重新登录，
    // 不允许先起一个未登录的空实例。
    const session = strategy.prepareLaunchSession(ctx) || { ready: true };
    if (!session.ready) {
      return fail(session.error, {
        ...(session.reason ? { reason: session.reason } : {}),
        ...(runningPids.length > 0 ? { pids: runningPids } : {})
      });
    }
    if (runningPids.length > 0) {
      // 准备阶段未要求重启时保持同账号单实例，不做无意义重启。
      if (!session.requiresRestart) {
        return { ok: true, status: 'already_running', pids: runningPids };
      }
      const killed = closeDesktopPids(runningPids, platformKey);
      if (killed.length !== runningPids.length) {
        return fail(strategy.restartFailedError, { pids: runningPids });
      }
    }
    const child = spawnDetached(spawnPlan.file, spawnPlan.args, {
      env,
      cwd: profileDir
    });
    return { ok: true, status: 'launched', pid: child && child.pid, executable: resolved.executablePath };
  }

  // killDesktopPid 关闭单个桌面主进程：Windows 用 taskkill 杀整棵进程树，
  // posix 先 SIGTERM 给宽限期，存活再 SIGKILL。
  function killDesktopPid(pid, platformKey) {
    if (platformKey === 'windows') {
      execFileSyncImpl('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      });
      return true;
    }
    try {
      processObj.kill(pid, 'SIGTERM');
    } catch (_error) {
      return false;
    }
    sleepMs(stopGraceMs);
    let alive = true;
    try {
      processObj.kill(pid, 0);
    } catch (_error) {
      alive = false;
    }
    if (alive) {
      try {
        processObj.kill(pid, 'SIGKILL');
      } catch (_error) {}
    }
    return true;
  }

  function closeDesktopPids(pids, platformKey) {
    const killed = [];
    for (const pid of [...new Set(Array.isArray(pids) ? pids : [])]) {
      try {
        if (killDesktopPid(pid, platformKey)) killed.push(pid);
      } catch (_error) {}
    }
    return killed;
  }

  function closeDesktop(provider, account, profileDir, cliConfig) {
    const desktopClient = cliConfig.desktopClient;
    const platformKey = normalizePlatform(processObj.platform);
    const platformConfig = desktopClient && desktopClient[platformKey];
    if (!platformConfig) return fail('desktop_not_supported');

    const userDataDir = pathImpl.join(profileDir, 'electron-user-data');
    // 关闭走与启动完全相同的身份派生，避免只按 user-data-dir 判重时漏杀
    // 会改写命令行的 provider 实例。
    const ctx = buildDesktopLaunchContext(provider, account, profileDir, userDataDir, platformKey);
    const runningPids = findRunningDesktopPids(userDataDir, platformConfig, platformKey, {
      execFileSync: execFileSyncImpl,
      applicationName: getDesktopLaunchStrategy(provider).resolveInstanceName(ctx)
    });
    if (runningPids.length === 0) return { ok: true, status: 'not_running' };
    const killed = closeDesktopPids(runningPids, platformKey);
    return { ok: true, status: 'closed', pids: killed };
  }

  function closeCliTerminals(provider, account) {
    if (!account || !account.accountRef) return fail('account_required');
    const platformKey = normalizePlatform(processObj.platform);
    const instances = listRunningCliInstances(platformKey, { execFileSync: execFileSyncImpl })
      .filter((instance) => instance.provider === provider
        && instance.accountRef === account.accountRef);
    if (instances.length === 0) return { ok: true, status: 'not_running', pids: [] };

    const pids = platformKey === 'windows'
      ? [...new Set(instances.map((instance) => instance.rootPid))]
      : [...new Set(instances.map((instance) => instance.pid))].reverse();
    const killed = [];
    for (const pid of pids) {
      try {
        if (killDesktopPid(pid, platformKey)) killed.push(pid);
      } catch (_error) {}
    }
    return { ok: true, status: 'closed', pids: killed };
  }

  function quoteShellToken(value, platformKey) {
    const text = String(value || '');
    if (platformKey === 'windows') return `"${text.replace(/"/g, '\\"')}"`;
    return `'${text.replace(/'/g, "'\\''")}'`;
  }

  function addCliProcessMarker(command, accountRef, platformKey) {
    const normalizedRef = String(accountRef || '').trim();
    if (platformKey === 'windows') {
      const assignments = [`set "${CLI_APP_MARKER_ENV}=1"`];
      if (normalizedRef) assignments.push(`set "${PROVIDER_ACCOUNT_REF_ENV}=${normalizedRef}"`);
      return `${assignments.join(' && ')} && ${command}`;
    }
    const assignments = [`${CLI_APP_MARKER_ENV}=1`];
    if (normalizedRef) assignments.push(`${PROVIDER_ACCOUNT_REF_ENV}=${quoteShellToken(normalizedRef, platformKey)}`);
    return `${assignments.join(' ')} ${command}`;
  }

  function resolveUnscopedCliPath(provider, cliConfig, platformKey, platformPath) {
    try {
      const fromDependency = typeof deps.resolveCliPath === 'function'
        ? String(deps.resolveCliPath(provider, null) || '').trim()
        : '';
      if (fromDependency) return fromDependency;
    } catch (_error) {}
    const binaryName = String(cliConfig && cliConfig.binaryName || provider).trim();
    // 与 app-entries 检测共用宿主搜索路径，避免显示已安装却启动失败的反向漂移。
    const hostEnv = withHostSearchPath({
      env: getBaseEnv(),
      platform: platformKey,
      path: platformPath,
      hostHomeDir,
      execFileSync: execFileSyncImpl
    });
    return findOnPath([binaryName], hostEnv, fsImpl, platformPath, platformKey);
  }

  function launchCliTerminal(provider, account, terminalId = DEFAULT_TERMINAL_ID) {
    const cliAccountId = String(account && account.cliAccountId || '').trim();
    if (account && !/^\d+$/.test(cliAccountId)) return fail('account_not_found');

    const platformKey = normalizePlatform(processObj.platform);
    const platformPath = resolvePlatformPath(pathImpl, platformKey);
    let cliPath = '';
    if (!account || deps.enforceCliInstallation) {
      try {
        cliPath = typeof deps.resolveCliPath === 'function'
          ? String(deps.resolveCliPath(provider, account) || '').trim()
          : '';
      } catch (_error) {
        cliPath = '';
      }
      if (!cliPath && !account) {
        cliPath = resolveUnscopedCliPath(provider, getProviderCLIConfig(provider), platformKey, platformPath);
      }
      if (!cliPath && (deps.enforceCliInstallation || !account)) {
        return fail('cli_not_installed', { provider, kind: APP_KIND_CLI });
      }
    }

    let command;
    if (account) {
      const nodeExe = String(processObj.execPath || 'node').trim() || 'node';
      const cliEntry = platformPath.join(repoRoot, 'bin', 'ai-home.js');
      command = `"${nodeExe}" "${cliEntry}" ${provider} ${cliAccountId}`;
    } else {
      command = quoteShellToken(cliPath, platformKey);
    }
    command = addCliProcessMarker(command, account && account.accountRef, platformKey);
    const title = account ? `aih ${provider} ${cliAccountId}` : `${provider} CLI`;

    const terminal = resolveClientTerminalLaunch(terminalId, command, title, {
      fs: fsImpl,
      path: platformPath,
      env: getBaseEnv(),
      platform: platformKey
    });
    if (!terminal) return fail('terminal_not_found');

    const terminalEnv = getBaseEnv();
    terminalEnv[CLI_APP_MARKER_ENV] = '1';
    if (account && account.accountRef) terminalEnv[PROVIDER_ACCOUNT_REF_ENV] = String(account.accountRef);
    // Windows 系统默认终端的 spec 声明 windowsVerbatimArguments（转义知识
    // 统一封装在 windows-cmd-launch），缺失它 cmd start 会挂起；GUI 宿主终端
    // （wt）还会声明 windowsHide:false，否则 CREATE_NO_WINDOW 会把新窗口
    // 创建成隐藏窗口。
    const child = spawnDetached(terminal.file, terminal.args, {
      env: terminalEnv,
      windowsHide: terminal.windowsHide !== false,
      ...windowsSpawnOptions(terminal)
    });
    return {
      ok: true,
      pid: child && child.pid,
      terminalId: terminal.terminalId || terminalId || DEFAULT_TERMINAL_ID,
      accountRef: String(account && account.accountRef || '')
    };
  }

  function launchAccountApp(input = {}) {
    const provider = String(input.provider || '').trim().toLowerCase();
    const accountRef = String(input.accountRef || '').trim();
    const kind = String(input.kind || '').trim().toLowerCase();
    const action = String(input.action || APP_ACTION_OPEN).trim().toLowerCase() || APP_ACTION_OPEN;
    const terminalId = String(input.terminalId || '').trim().toLowerCase() || DEFAULT_TERMINAL_ID;
    if (kind !== APP_KIND_DESKTOP && kind !== APP_KIND_CLI) return fail('unsupported_kind');
    if (action !== APP_ACTION_OPEN && action !== APP_ACTION_CLOSE) return fail('unsupported_action');

    const cliConfig = provider ? getProviderCLIConfig(provider) : null;
    if (!cliConfig) return fail('unsupported_provider');
    const definition = provider ? getProviderDefinition(provider) : null;
    if (kind === APP_KIND_CLI && (!definition || !definition.clients || !definition.clients.cli)) {
      return fail('cli_not_supported');
    }
    if (kind === APP_KIND_DESKTOP && (!definition || !definition.clients.desktop)) {
      return fail('desktop_not_supported');
    }

    const account = accountRef ? resolveAccount(accountRef) : null;
    if (accountRef && (!account || String(account.provider || '').trim().toLowerCase() !== provider)) {
      return fail('account_not_found');
    }
    if (!account && kind === APP_KIND_DESKTOP) return fail('account_required');

    // 资格判断必须在所有进程启动和安装提示之前完成，避免未配置或认证失效
    // 的账号借助 Desktop/CLI 入口绕过账号状态边界。
    if (account && action === APP_ACTION_OPEN) {
      const eligibility = typeof deps.resolveAccountEligibility === 'function'
        ? (deps.resolveAccountEligibility(account, { provider, accountRef }) || {})
        : account;
      if (Object.prototype.hasOwnProperty.call(eligibility, 'configured')
        && eligibility.configured === false) {
        return fail('account_unconfigured', { provider, accountRef });
      }
      const runtimeStatus = String(
        eligibility.runtimeStatus || eligibility.authStatus || ''
      ).trim().toLowerCase();
      if (runtimeStatus === 'auth_invalid' || eligibility.authInvalid === true) {
        return fail('account_auth_invalid', { provider, accountRef });
      }
    }

    try {
      if (kind === APP_KIND_CLI) {
        return action === APP_ACTION_CLOSE
          ? closeCliTerminals(provider, account)
          : launchCliTerminal(provider, account, terminalId);
      }
      const profileDir = resolveProfileDir(provider, accountRef);
      if (!profileDir) return fail('account_profile_unavailable');
      return action === APP_ACTION_CLOSE
        ? closeDesktop(provider, account, profileDir, cliConfig)
        : launchDesktop(provider, account, profileDir, cliConfig);
    } catch (error) {
      return fail('launch_failed', {
        message: String((error && error.message) || error || 'unknown')
      });
    }
  }

  return {
    launchAccountApp
  };
}

// createAppEntryDetector 基于真实宿主机检测每个 Provider 的一键入口可用性：
// desktop / cli 的产品入口能力来自 manifest.clients；desktopClient 和 CLI
// 仅用于发现与启动细节，不能反向推断用户可安装的客户端形态。
// 结果缓存 30s，避免 WebUI 频繁渲染时重复扫描。
function createAppEntryDetector(deps = {}) {
  const fsImpl = deps.fs || nodeFs;
  const pathImpl = deps.path || nodePath;
  const processObj = deps.processObj || process;
  const execFileSyncImpl = deps.execFileSync || nodeExecFileSync;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const hostHomeDirValue = String(deps.hostHomeDir || '').trim();
  let cache = null;
  let runningCache = null;
  let runningCliCache = null;

  function detect() {
    if (cache && now() - cache.at < APP_ENTRIES_CACHE_MS) return cache.entries;
    const env = deps.env && typeof deps.env === 'object' ? deps.env : (processObj.env || {});
    const platformKey = normalizePlatform(processObj.platform);
    const platformPath = resolvePlatformPath(pathImpl, platformKey);
    // 后台 Server 继承的 PATH 常常缺少 ~/.local/bin 等 profile 追加目录，
    // 裸 PATH 扫描会把已安装的 CLI 判成未安装，而启动链路（command-path 的
    // 登录 shell 回落）却能找到同一个二进制。这里按 detect 的缓存周期解析一次
    // 宿主搜索路径，两侧结论保持一致，也不会每个 provider 都拉起一次登录 shell。
    const hostEnv = withHostSearchPath({
      env,
      platform: platformKey,
      path: platformPath,
      hostHomeDir: hostHomeDirValue,
      execFileSync: execFileSyncImpl
    });
    const entries = {};
    for (const definition of listProviderDefinitions()) {
      const cliConfig = definition.cli;
      if (!cliConfig) continue;
      const clients = definition.clients || { cli: false, desktop: false };
      const platformConfig = cliConfig.desktopClient && cliConfig.desktopClient[platformKey];
      const desktop = Boolean(clients.desktop && platformConfig && resolveDesktopExecutable(platformKey, platformConfig, {
        fs: fsImpl,
        path: platformPath,
        // 桌面可执行文件解析保持宿主 env：launchDesktop 同样用 getBaseEnv()，
        // 两侧必须同一份 PATH，否则会出现"显示已安装但启动即 not_installed"。
        env,
        hostHomeDir: hostHomeDirValue
      }));
      const binaryName = String(cliConfig.binaryName || definition.id).trim();
      const cli = Boolean(clients.cli && binaryName && findOnPath([binaryName], hostEnv, fsImpl, platformPath, platformKey));
      entries[definition.id] = { desktop, cli };
    }
    cache = { at: now(), entries };
    return entries;
  }

  function detectCapabilities() {
    const platformKey = normalizePlatform(processObj.platform);
    const capabilities = {};
    for (const definition of listProviderDefinitions()) {
      const cliConfig = definition.cli;
      if (!cliConfig) continue;
      const clients = definition.clients || { cli: false, desktop: false };
      const platformConfig = cliConfig.desktopClient && cliConfig.desktopClient[platformKey];
      capabilities[definition.id] = {
        desktop: Boolean(clients.desktop && platformConfig),
        cli: Boolean(clients.cli && (cliConfig.binaryName || definition.id))
      };
    }
    return capabilities;
  }

  // scanRunning 一次进程扫描返回所有带 --user-data-dir 的桌面主进程实例，同样缓存。
  function scanRunning() {
    if (runningCache && now() - runningCache.at < RUNNING_ENTRIES_CACHE_MS) return runningCache.instances;
    const instances = listRunningDesktopInstances(normalizePlatform(processObj.platform), {
      execFileSync: execFileSyncImpl
    });
    runningCache = { at: now(), instances };
    return instances;
  }

  function scanRunningCli() {
    if (runningCliCache && now() - runningCliCache.at < RUNNING_ENTRIES_CACHE_MS) return runningCliCache.instances;
    const instances = listRunningCliInstances(normalizePlatform(processObj.platform), {
      execFileSync: execFileSyncImpl
    });
    runningCliCache = { at: now(), instances };
    return instances;
  }

  function invalidate() {
    cache = null;
    runningCache = null;
    runningCliCache = null;
  }

  return { detect, detectCapabilities, scanRunning, scanRunningCli, invalidate };
}

module.exports = {
  APP_KIND_DESKTOP,
  APP_KIND_CLI,
  createAccountAppLauncher,
  createAppEntryDetector,
  findOnPath,
  findRunningDesktopPids,
  listRunningDesktopInstances,
  listRunningCliInstances,
  normalizePlatform,
  resolveDesktopExecutable,
  buildCliTerminalSpawn
};
