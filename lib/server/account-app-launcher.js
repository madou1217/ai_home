'use strict';

// 账号应用启动器：从 WebUI 为指定账号打开 Desktop 应用或新的 CLI 终端窗口。
// Desktop 启动复用 CLI 的按账号沙箱 env 隔离（provider-runtime-env），并为
// Electron 应用绑定独立的 --user-data-dir，保证多账号并行互不串号；
// CLI 启动直接复用 `aih <provider> <cliAccountId>` 完整启动链路（env 隔离、
// tmux 持久会话），不在这里重新实现。
// 参考 zcm.py 的 start_account/bind_electron_profile 启动机制（不含身份伪造部分）。

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const nodeCrypto = require('node:crypto');
const { spawn: nodeSpawn, execFileSync: nodeExecFileSync } = require('node:child_process');
const { getProviderCLIConfig, getProviderDefinition, listProviderDefinitions } = require('../provider-catalog');
const { resolveAccountRef } = require('./account-ref-store');
const { readAccountCredentials } = require('./account-credential-store');
const { resolveAccountRuntimeDir } = require('../runtime/aih-storage-layout');
const {
  buildProviderRuntimeEnv,
  prepareProviderRuntime
} = require('../cli/services/ai-cli/provider-runtime-env');

const APP_KIND_DESKTOP = 'desktop';
const APP_KIND_CLI = 'cli';
const APP_ACTION_OPEN = 'open';
const APP_ACTION_CLOSE = 'close';

// app-entries 检测结果缓存时长，避免 WebUI 每次渲染都扫描全盘。
const APP_ENTRIES_CACHE_MS = 30 * 1000;

function normalizePlatform(platform) {
  if (platform === 'win32') return 'windows';
  if (platform === 'darwin') return 'macos';
  return String(platform || '').trim().toLowerCase();
}

// resolvePlatformPath 让注入的通用 node:path 在跨平台测试和宿主运行时都使用
// 当前目标平台的分隔符；profileDir 的既有拼接保持由调用方控制。
function resolvePlatformPath(pathImpl, platformKey) {
  if (platformKey === 'windows' && pathImpl && pathImpl.win32) return pathImpl.win32;
  return pathImpl;
}

function fail(error, extra = {}) {
  return { ok: false, error, ...extra };
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
      const candidate = pathImpl.join(dir, name);
      if (fsImpl.existsSync(candidate)) return candidate;
      if (platformKey === 'windows' && !/\.[a-z0-9]+$/i.test(name)) {
        const exeCandidate = `${candidate}.exe`;
        if (fsImpl.existsSync(exeCandidate)) return exeCandidate;
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

// escapeAppleScriptString 转义嵌入 AppleScript 字符串字面量的命令。
function escapeAppleScriptString(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// buildCliTerminalSpawn 构造各平台打开新终端窗口运行 aih CLI 的 spawn 参数。
function buildCliTerminalSpawn(platformKey, command, title, context) {
  const { fs: fsImpl, path: pathImpl, env } = context;
  if (platformKey === 'windows') {
    return {
      file: 'cmd.exe',
      args: ['/c', `start "${title}" cmd /k ${command}`]
    };
  }
  if (platformKey === 'macos') {
    const script = [
      'tell application "Terminal"',
      'activate',
      `do script "${escapeAppleScriptString(command)}"`,
      'end tell'
    ];
    return {
      file: 'osascript',
      args: script.flatMap((line) => ['-e', line])
    };
  }
  if (platformKey === 'linux') {
    const terminals = [
      ['x-terminal-emulator', '-e'],
      ['gnome-terminal', '--'],
      ['konsole', '-e']
    ];
    for (const [terminal, prefixArg] of terminals) {
      const resolved = findOnPath([terminal], env, fsImpl, pathImpl, platformKey);
      if (resolved) {
        return { file: resolved, args: [prefixArg, 'bash', '-lc', command] };
      }
    }
    return null;
  }
  return null;
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

// listRunningDesktopInstances 一次进程扫描列出所有带 --user-data-dir 的桌面主进程，
// 供 app-entries 批量匹配账号运行态，避免逐账号各扫一次。
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
      .map((proc) => ({ pid: proc.pid, userDataDir: parseDesktopUserDataDir(proc.commandLine) }))
      .filter((instance) => instance.userDataDir);
  } catch (_error) {
    return [];
  }
}

// findRunningDesktopPids 找到本账号桌面实例的主进程：
// 命令行带该账号专属 --user-data-dir，且排除 --type= 的 renderer/utility 子进程。
function findRunningDesktopPids(userDataDir, platformConfig, platformKey, deps = {}) {
  const execFileSyncImpl = deps.execFileSync;
  const target = String(userDataDir || '').trim();
  if (typeof execFileSyncImpl !== 'function' || !target) return [];
  let processes;
  try {
    processes = platformKey === 'windows'
      ? listWindowsDesktopProcesses(platformConfig, execFileSyncImpl)
      : listPosixProcesses(execFileSyncImpl);
  } catch (_error) {
    return [];
  }
  const needle = platformKey === 'windows' ? target.toLowerCase() : target;
  const execNames = (Array.isArray(platformConfig && platformConfig.execNames)
    ? platformConfig.execNames : [])
    .map((name) => String(name || '').trim().toLowerCase())
    .filter(Boolean);
  return processes
    .filter((proc) => {
      const commandLine = String(proc.commandLine || '');
      if (!isDesktopMainCommandLine(commandLine)) return false;
      const found = parseDesktopUserDataDir(commandLine);
      if (!found) return false;
      const normalized = platformKey === 'windows' ? found.toLowerCase() : found;
      if (normalized !== needle) return false;
      // Windows 已在进程名单维度过滤；posix 再要求命令行出现可执行名，避免误伤。
      if (platformKey === 'windows') return true;
      const haystack = commandLine.toLowerCase();
      return execNames.some((name) => haystack.includes(name));
    })
    .map((proc) => proc.pid);
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
    return resolveAccountRef(fsImpl, aiHomeDir, accountRef, { bestEffort: true });
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
      installSkill: false
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

  function launchDesktop(provider, account, profileDir, cliConfig) {
    const desktopClient = cliConfig.desktopClient;
    const platformKey = normalizePlatform(processObj.platform);
    const platformConfig = desktopClient && desktopClient[platformKey];
    if (!platformConfig) return fail('desktop_not_supported');
    const platformPath = resolvePlatformPath(pathImpl, platformKey);

    // Electron 标准隔离参数：按账号绑定独立 user-data 目录。
    const userDataDir = pathImpl.join(profileDir, 'electron-user-data');

    // 单实例语义：同一账号的 Desktop 已在运行时直接回报，不再拉起第二个实例。
    const runningPids = findRunningDesktopPids(userDataDir, platformConfig, platformKey, {
      execFileSync: execFileSyncImpl
    });
    if (runningPids.length > 0) {
      return { ok: true, status: 'already_running', pids: runningPids };
    }

    const env = buildAccountLaunchEnv(provider, profileDir, account);
    const userDataEnvKey = String(desktopClient.userDataEnvKey || '').trim();
    if (userDataEnvKey) env[userDataEnvKey] = userDataDir;
    // ZCode Desktop 与 CLI 对 ZCODE_DATA_BASE_DIR 的语义不同：CLI 把它当作
    // .zcode 根目录本身，Desktop 宿主则在其下再拼一层 .zcode（getZCodeDataRootDir）。
    // 沿用 CLI env 会让 Desktop 去找 <sandbox>/.zcode/.zcode/v2/credentials.json，
    // 凭据找不到而落到 Welcome 登录页；桌面启动必须回指到沙箱父目录，
    // 并用 ZCODE_HOME 照顾 CUA helper 等按 ZCODE_HOME 取根的子系统。
    if (provider === 'zcode') {
      env.ZCODE_DATA_BASE_DIR = profileDir;
      env.ZCODE_HOME = pathImpl.join(profileDir, '.zcode');
      // 多实例：ZCode 的单实例锁按 application name 判重而非 --user-data-dir
      // （实测验证），因此按 accountRef 派生稳定的应用名，同账号恒定、跨账号互异。
      // 不设 ZCODE_DESKTOP_SESSION_DATA_DIR——它会搬移 session 存储导致登出。
      // --user-data-dir 保持不变：单实例检测（findRunningDesktopPids）与
      // app-entries 的 runningAccounts 角标都靠扫描命令行里的该参数匹配。
      // 注意：多个实例都注册 zcode:// deep-link，多账号同时开着时 OAuth 回调
      // 可能落到错误的实例，建议只开当前要登录的那一个账号的 Desktop。
      const appSuffix = nodeCrypto.createHash('sha256')
        .update(String(account.accountRef || ''))
        .digest('hex')
        .slice(0, 8);
      env.ZCODE_DESKTOP_APPLICATION_NAME = `ZCode-${appSuffix}`;
    }
    // 可执行文件解析用宿主 env：沙箱 env 会按账号隔离裁剪掉 ProgramFiles
    // 等机器级变量，而安装目录检测属于宿主机事实，不应被沙箱化。
    const resolved = resolveDesktopExecutable(platformKey, platformConfig, {
      fs: fsImpl,
      path: platformPath,
      env: getBaseEnv(),
      hostHomeDir
    });
    if (!resolved || !resolved.executablePath) return fail('desktop_not_installed');

    fsImpl.mkdirSync(userDataDir, { recursive: true });

    const child = spawnDetached(resolved.executablePath, [`--user-data-dir=${userDataDir}`], {
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

  function closeDesktop(provider, profileDir, cliConfig) {
    const desktopClient = cliConfig.desktopClient;
    const platformKey = normalizePlatform(processObj.platform);
    const platformConfig = desktopClient && desktopClient[platformKey];
    if (!platformConfig) return fail('desktop_not_supported');

    const userDataDir = pathImpl.join(profileDir, 'electron-user-data');
    const runningPids = findRunningDesktopPids(userDataDir, platformConfig, platformKey, {
      execFileSync: execFileSyncImpl
    });
    if (runningPids.length === 0) return { ok: true, status: 'not_running' };
    const killed = [];
    for (const pid of runningPids) {
      try {
        if (killDesktopPid(pid, platformKey)) killed.push(pid);
      } catch (_error) {}
    }
    return { ok: true, status: 'closed', pids: killed };
  }

  function launchCliTerminal(provider, account) {
    const cliAccountId = String(account && account.cliAccountId || '').trim();
    if (!/^\d+$/.test(cliAccountId)) return fail('account_not_found');

    // WebUI 入口开启该检查后，先确认 Provider 原生 CLI 存在，再创建终端。
    // 测试和旧的直接调用未注入该策略时保持原有启动器行为。
    if (deps.enforceCliInstallation) {
      let cliPath = '';
      try {
        cliPath = typeof deps.resolveCliPath === 'function'
          ? String(deps.resolveCliPath(provider, account) || '').trim()
          : '';
      } catch (_error) {
        cliPath = '';
      }
      if (!cliPath) return fail('cli_not_installed', { provider, kind: APP_KIND_CLI });
    }

    const platformKey = normalizePlatform(processObj.platform);
    const platformPath = resolvePlatformPath(pathImpl, platformKey);
    const nodeExe = String(processObj.execPath || 'node').trim() || 'node';
    const cliEntry = platformPath.join(repoRoot, 'bin', 'ai-home.js');
    const command = `"${nodeExe}" "${cliEntry}" ${provider} ${cliAccountId}`;
    const title = `aih ${provider} ${cliAccountId}`;

    const terminal = buildCliTerminalSpawn(platformKey, command, title, {
      fs: fsImpl,
      path: pathImpl,
      env: getBaseEnv()
    });
    if (!terminal) return fail('terminal_not_found');

    const child = spawnDetached(terminal.file, terminal.args, {});
    return { ok: true, pid: child && child.pid };
  }

  function launchAccountApp(input = {}) {
    const provider = String(input.provider || '').trim().toLowerCase();
    const accountRef = String(input.accountRef || '').trim();
    const kind = String(input.kind || '').trim().toLowerCase();
    const action = String(input.action || APP_ACTION_OPEN).trim().toLowerCase() || APP_ACTION_OPEN;
    if (kind !== APP_KIND_DESKTOP && kind !== APP_KIND_CLI) return fail('unsupported_kind');
    if (action !== APP_ACTION_OPEN && action !== APP_ACTION_CLOSE) return fail('unsupported_action');
    // close 只对 desktop 有意义：CLI 终端由用户自行关闭。
    if (action === APP_ACTION_CLOSE && kind !== APP_KIND_DESKTOP) return fail('unsupported_action');

    const cliConfig = provider ? getProviderCLIConfig(provider) : null;
    if (!cliConfig) return fail('unsupported_provider');
    const definition = provider ? getProviderDefinition(provider) : null;
    if (kind === APP_KIND_DESKTOP && (!definition || !definition.clients.desktop)) {
      return fail('desktop_not_supported');
    }

    const account = accountRef ? resolveAccount(accountRef) : null;
    if (!account || String(account.provider || '').trim().toLowerCase() !== provider) {
      return fail('account_not_found');
    }

    // 资格判断必须在所有进程启动和安装提示之前完成，避免未配置或认证失效
    // 的账号借助 Desktop/CLI 入口绕过账号状态边界。
    if (action === APP_ACTION_OPEN) {
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
      if (kind === APP_KIND_CLI) return launchCliTerminal(provider, account);
      const profileDir = resolveProfileDir(provider, accountRef);
      if (!profileDir) return fail('account_profile_unavailable');
      return action === APP_ACTION_CLOSE
        ? closeDesktop(provider, profileDir, cliConfig)
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

  function detect() {
    if (cache && now() - cache.at < APP_ENTRIES_CACHE_MS) return cache.entries;
    const env = deps.env && typeof deps.env === 'object' ? deps.env : (processObj.env || {});
    const platformKey = normalizePlatform(processObj.platform);
    const platformPath = resolvePlatformPath(pathImpl, platformKey);
    const entries = {};
    for (const definition of listProviderDefinitions()) {
      const cliConfig = definition.cli;
      if (!cliConfig) continue;
      const clients = definition.clients || { cli: false, desktop: false };
      const platformConfig = cliConfig.desktopClient && cliConfig.desktopClient[platformKey];
      const desktop = Boolean(clients.desktop && platformConfig && resolveDesktopExecutable(platformKey, platformConfig, {
        fs: fsImpl,
        path: platformPath,
        env,
        hostHomeDir: hostHomeDirValue
      }));
      const binaryName = String(cliConfig.binaryName || definition.id).trim();
      const cli = Boolean(clients.cli && binaryName && findOnPath([binaryName], env, fsImpl, platformPath, platformKey));
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
    if (runningCache && now() - runningCache.at < APP_ENTRIES_CACHE_MS) return runningCache.instances;
    const instances = listRunningDesktopInstances(normalizePlatform(processObj.platform), {
      execFileSync: execFileSyncImpl
    });
    runningCache = { at: now(), instances };
    return instances;
  }

  return { detect, detectCapabilities, scanRunning };
}

module.exports = {
  APP_KIND_DESKTOP,
  APP_KIND_CLI,
  createAccountAppLauncher,
  createAppEntryDetector,
  findOnPath,
  findRunningDesktopPids,
  listRunningDesktopInstances,
  normalizePlatform,
  resolveDesktopExecutable,
  buildCliTerminalSpawn
};
