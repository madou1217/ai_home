'use strict';

const { SHUTDOWN_GRACE_MS } = require('../../../server/inference-drain');

const {
  listEffectiveBackgroundComponents,
  readBackgroundSupervisorState,
  removeBackgroundComponent,
  writeBackgroundSupervisorState
} = require('../background/supervisor-state-store');
const { createMacosLaunchAgent } = require('../background/macos-launch-agent');

const LEGACY_AUTOSTART_LABELS = Object.freeze(['com.aih.server', 'aih-server']);
const WINDOWS_AUTOSTART_TASK_MARKER = 'windows-autostart-task.json';

function nonEmptyString(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function escapeSystemdValue(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/%/g, '%%');
}

function quoteSystemdArg(value) {
  return `"${escapeSystemdValue(value)}"`;
}

function quoteWindowsCmdArg(value) {
  return `"${String(value === undefined || value === null ? '' : value).replace(/"/g, '""')}"`;
}

function quoteWindowsVbsString(value) {
  return `"${String(value === undefined || value === null ? '' : value).replace(/"/g, '""')}"`;
}

function isWindowsAbsolutePath(value) {
  return /^[a-zA-Z]:[\\/]/.test(String(value || '')) || /^\\\\/.test(String(value || ''));
}

function firstOutputLine(result) {
  return String(result && result.stdout || '')
    .split(/\r?\n/)
    .map((line) => nonEmptyString(line))
    .find(Boolean) || '';
}

function outputLines(result) {
  return String(result && result.stdout || '')
    .split(/\r?\n/)
    .map((line) => nonEmptyString(line))
    .filter(Boolean);
}

function sanitizeWindowsStartupPath(pathValue) {
  return String(pathValue || '')
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => !/[\\/]\.codex[\\/]tmp[\\/]arg0[\\/]/i.test(entry))
    .join(';');
}

function defaultHostHomeDir(path, processObj, aiHomeDir) {
  const env = processObj && processObj.env ? processObj.env : {};
  const fromEnv = nonEmptyString(env.USERPROFILE || env.HOME);
  if (fromEnv) return fromEnv;
  const root = nonEmptyString(aiHomeDir);
  return root ? path.dirname(root) : '';
}

function buildWindowsStartupScriptPath(path, hostHomeDir, processObj, label) {
  const env = processObj && processObj.env ? processObj.env : {};
  const appData = nonEmptyString(env.APPDATA)
    || path.join(hostHomeDir, 'AppData', 'Roaming');
  return path.join(
    appData,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
    `${label}.vbs`
  );
}

function buildSystemdUnitFilePath(path, hostHomeDir, label) {
  return path.join(hostHomeDir, '.config', 'systemd', 'user', `${label}.service`);
}

function createServerAutostartService(deps = {}) {
  const fs = deps.fs;
  const path = deps.path;
  const spawnSync = deps.spawnSync;
  const processObj = deps.processObj || process;
  const ensureDir = deps.ensureDir;
  const aiHomeDir = deps.aiHomeDir;
  const hostHomeDir = nonEmptyString(deps.hostHomeDir) || defaultHostHomeDir(path, processObj, aiHomeDir);
  const label = nonEmptyString(deps.launchdLabel) || 'com.meadeo.ai_home';
  const launchdPlist = deps.launchdPlist;
  const logFile = deps.logFile;
  const resolveStartEntryFilePath = deps.resolveStartEntryFilePath;
  const resolveStartServeArgs = deps.resolveStartServeArgs;
  const systemdUnitFile = nonEmptyString(deps.systemdUnitFile)
    || buildSystemdUnitFilePath(path, hostHomeDir, label);
  const windowsStartupScript = nonEmptyString(deps.windowsStartupScript)
    || buildWindowsStartupScriptPath(path, hostHomeDir, processObj, label);
  // 无空格路径的远程启动器（默认 <aiHomeDir>/run/aih-server-start.cmd）：
  // SSH 远程重启时 schtasks 的 /tr 直接指向它，命令行里不再出现带空格的长路径。
  const windowsLauncherScript = nonEmptyString(deps.windowsLauncherScript)
    || (aiHomeDir ? path.join(aiHomeDir, 'run', 'aih-server-start.cmd') : '');
  // Startup 文件夹里写 .vbs 可能被杀软/受控文件夹拦成 EPERM；计划任务用同目录的
  // .cmd 作为后备，既不依赖脚本宿主，也能在登录时直接常驻 server serve。
  const windowsServeScript = aiHomeDir ? path.join(aiHomeDir, 'run', 'aih-server-serve.cmd') : '';
  const windowsTaskMarker = aiHomeDir ? path.join(aiHomeDir, 'run', WINDOWS_AUTOSTART_TASK_MARKER) : '';
  // Windows 自启必须把 stdout/stderr 落到文件：cscript Exec 的管道在脚本退出后关闭，
  // 服务继续写 stderr 会随控制台一起结束（真机复现：不重定向时 cscript 退出后进程消失）。
  const windowsLogFile = nonEmptyString(deps.logFile)
    || (aiHomeDir ? path.join(aiHomeDir, 'logs', 'services', 'background-supervisor.log') : '');

  function getStartEntryFilePath() {
    if (typeof resolveStartEntryFilePath !== 'function') return '';
    const resolved = resolveStartEntryFilePath();
    return nonEmptyString(resolved && resolved.entryFilePath);
  }

  function getServeArgs() {
    if (typeof resolveStartServeArgs !== 'function') return [];
    const args = resolveStartServeArgs([]);
    return Array.isArray(args) ? args.map((item) => String(item)) : [];
  }

  function normalizeCommandPath(commandPath) {
    const value = nonEmptyString(commandPath);
    if (!value) return '';
    if (processObj.platform === 'win32' && isWindowsAbsolutePath(value)) return value;
    if (path.isAbsolute(value)) return value;
    const cwd = processObj && typeof processObj.cwd === 'function' ? processObj.cwd() : process.cwd();
    return path.resolve(cwd, value);
  }

  function resolveAihCommandPath() {
    const envPath = nonEmptyString(processObj.env && processObj.env.AIH_EXECUTABLE);
    if (envPath) return normalizeCommandPath(envPath);

    if (processObj.platform === 'win32') {
      const candidates = outputLines(run('where', ['aih'], { encoding: 'utf8' }))
        .map(normalizeCommandPath)
        .filter((candidate) => candidate && fs.existsSync(candidate));
      return candidates.find((candidate) => /\.(?:cmd|exe)$/i.test(candidate))
        || candidates[0]
        || '';
    }

    const found = firstOutputLine(run('sh', ['-lc', 'command -v aih'], {
      encoding: 'utf8',
      env: processObj.env
    }));
    return normalizeCommandPath(found);
  }

  function resolveRequiredAihCommandPath() {
    const aihCommandPath = resolveAihCommandPath();
    if (aihCommandPath) return aihCommandPath;
    throw new Error('aih command is required for autostart; set AIH_EXECUTABLE or install the aih CLI first');
  }

  // 自启命令统一指向 Go Server：它是服务主体，Node 由 Go supervisor 按需拉起。
  function resolveGoServerBinaryPath() {
    const explicit = nonEmptyString(processObj.env && processObj.env.AIH_GO_SERVER_BINARY);
    if (explicit) return normalizeCommandPath(explicit);
    const entry = getStartEntryFilePath();
    const repositoryRoot = entry
      ? path.dirname(path.dirname(entry))
      : path.resolve(__dirname, '..', '..', '..', '..');
    const platform = nonEmptyString(processObj.platform || process.platform);
    const arch = nonEmptyString(processObj.arch || process.arch);
    return path.join(repositoryRoot, 'bin', 'native', `${platform}-${arch}`, platform === 'win32' ? 'aih-server.exe' : 'aih-server');
  }

  function getServeCommandArgs() {
    const goBinary = resolveGoServerBinaryPath();
    if (!fs.existsSync(goBinary)) {
      const error = new Error(`Go server binary is required for autostart: ${goBinary}`);
      error.code = 'go_server_binary_required';
      throw error;
    }
    return [goBinary, '--front-door', '--supervise-node'];
  }

  function getStartCommandArgs() {
    return getServeCommandArgs();
  }

  function run(command, args, options = {}) {
    if (typeof spawnSync !== 'function') {
      return { status: 1, stdout: '', stderr: 'spawnSync is not available' };
    }
    try {
      return spawnSync(command, args, options);
    } catch (error) {
      return { status: 1, stdout: '', stderr: error.message || String(error) };
    }
  }

  function legacyLabels() {
    return LEGACY_AUTOSTART_LABELS.filter((item) => item !== label);
  }

  function backgroundStateDeps() {
    return { fs, path, aiHomeDir };
  }

  function createBackgroundLaunchAgent(additionalLegacyServices = []) {
    const plistFile = nonEmptyString(launchdPlist)
      || path.join(hostHomeDir, 'Library', 'LaunchAgents', `${label}.plist`);
    const launchdDir = path.dirname(plistFile);
    return createMacosLaunchAgent({
      aiHomeDir,
      hostHomeDir,
      label,
      launchdPlist: plistFile,
      resolveAihCommandPath: resolveRequiredAihCommandPath,
      legacyServices: legacyLabels().map((legacyLabel) => ({
        label: legacyLabel,
        file: path.join(launchdDir, `${legacyLabel}.plist`)
      })).concat(additionalLegacyServices)
    }, {
      fs,
      path,
      spawnSync,
      processObj,
      ensureDir
    });
  }

  function getMacStatus() {
    return createBackgroundLaunchAgent().getStatus();
  }

  function installMac() {
    const stateDeps = backgroundStateDeps();
    const previousState = readBackgroundSupervisorState(stateDeps);
    const plistFile = nonEmptyString(launchdPlist)
      || path.join(hostHomeDir, 'Library', 'LaunchAgents', `${label}.plist`);
    const nextState = {
      schemaVersion: previousState.schemaVersion,
      components: {}
    };
    nextState.components.server = {
      id: 'server',
      args: ['server', 'serve']
    };
    writeBackgroundSupervisorState(nextState, stateDeps);
    createBackgroundLaunchAgent([]).install({
      restoreState: () => writeBackgroundSupervisorState(previousState, stateDeps)
    });
    return getMacStatus();
  }

  function uninstallMac() {
    const stateDeps = backgroundStateDeps();
    const previousState = readBackgroundSupervisorState(stateDeps);
    const nextState = removeBackgroundComponent('server', stateDeps);
    const launchAgent = createBackgroundLaunchAgent();
    const transactionOptions = {
      restoreState: () => writeBackgroundSupervisorState(previousState, stateDeps)
    };
    if (listEffectiveBackgroundComponents(nextState).length > 0) launchAgent.install(transactionOptions);
    else launchAgent.uninstall(transactionOptions);
    return getMacStatus();
  }

  function stopMacLoaded() {
    return createBackgroundLaunchAgent().stopLoaded();
  }

  function getLinuxStatus() {
    const installed = fs.existsSync(systemdUnitFile);
    const enabled = run('systemctl', ['--user', 'is-enabled', `${label}.service`], { encoding: 'utf8' });
    const active = run('systemctl', ['--user', 'is-active', `${label}.service`], { encoding: 'utf8' });
    const version = run('systemctl', ['--version'], { encoding: 'utf8' });
    return {
      supported: true,
      type: 'systemd-user',
      installed,
      loaded: enabled.status === 0,
      enabled: enabled.status === 0,
      active: active.status === 0,
      available: version.status === 0,
      file: systemdUnitFile,
      unit: `${label}.service`,
      label
    };
  }

  function buildLinuxUnit() {
    const commandArgs = getServeCommandArgs();
    const workingDirectory = path.dirname(getStartEntryFilePath()) || hostHomeDir;
    // systemd user unit 不继承安装者的 shell 环境：AIH_HOME_DIR 必须显式写入，
    // 否则自定义 home 会被静默忽略，服务去读 ~/.ai_home（真机验证时暴露）。
    const homeEnv = aiHomeDir ? `Environment="AIH_HOME_DIR=${escapeSystemdValue(aiHomeDir)}"\n` : '';
    return `[Unit]
Description=AI Home local server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${commandArgs.map(quoteSystemdArg).join(' ')}
WorkingDirectory=${escapeSystemdValue(workingDirectory)}
Restart=always
RestartSec=5
TimeoutStopSec=${Math.ceil(SHUTDOWN_GRACE_MS / 1000)}
Environment="PATH=${escapeSystemdValue(processObj.env && processObj.env.PATH || '')}"
${homeEnv}StandardOutput=append:${escapeSystemdValue(logFile)}
StandardError=append:${escapeSystemdValue(logFile)}

[Install]
WantedBy=default.target
`;
  }

  function installLinux() {
    const version = run('systemctl', ['--version'], { encoding: 'utf8' });
    if (version.status !== 0) {
      throw new Error(nonEmptyString(version.stderr || version.stdout) || 'systemctl is required for Linux autostart');
    }
    cleanupLegacyLinuxAutostart();
    ensureDir(path.dirname(systemdUnitFile));
    fs.writeFileSync(systemdUnitFile, buildLinuxUnit());
    const reload = run('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8' });
    if (reload.status !== 0) {
      throw new Error(nonEmptyString(reload.stderr || reload.stdout) || 'systemctl --user daemon-reload failed');
    }
    const enable = run('systemctl', ['--user', 'enable', '--now', `${label}.service`], { encoding: 'utf8' });
    if (enable.status !== 0) {
      throw new Error(nonEmptyString(enable.stderr || enable.stdout) || 'systemctl --user enable --now failed');
    }
    return getLinuxStatus();
  }

  function uninstallLinux() {
    run('systemctl', ['--user', 'disable', '--now', `${label}.service`], { stdio: 'ignore' });
    if (fs.existsSync(systemdUnitFile)) {
      fs.unlinkSync(systemdUnitFile);
    }
    cleanupLegacyLinuxAutostart();
    run('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    return getLinuxStatus();
  }

  function stopLinuxLoaded() {
    run('systemctl', ['--user', 'stop', `${label}.service`], { stdio: 'ignore' });
    return getLinuxStatus();
  }

  function cleanupLegacyLinuxAutostart() {
    const systemdDir = path.dirname(systemdUnitFile);
    legacyLabels().forEach((legacyLabel) => {
      const legacyUnit = `${legacyLabel}.service`;
      run('systemctl', ['--user', 'disable', '--now', legacyUnit], { stdio: 'ignore' });
      const legacyUnitFile = path.join(systemdDir, legacyUnit);
      if (fs.existsSync(legacyUnitFile)) {
        fs.unlinkSync(legacyUnitFile);
      }
    });
  }

  function getWindowsStatus() {
    const startupInstalled = fs.existsSync(windowsStartupScript);
    const taskInstalled = Boolean(windowsTaskMarker && fs.existsSync(windowsTaskMarker));
    const installed = startupInstalled || taskInstalled;
    return {
      supported: true,
      type: taskInstalled ? 'windows-scheduled-task' : 'windows-startup',
      installed,
      loaded: installed,
      file: taskInstalled ? windowsServeScript : windowsStartupScript,
      script: taskInstalled ? windowsServeScript : windowsStartupScript,
      // 无空格路径的启动器：远程（SSH/计划任务）拉起时用它，命令行里不必再出现带空格的长路径。
      launcher: taskInstalled ? windowsServeScript : windowsLauncherScript,
      label
    };
  }

  function buildWindowsLauncherScript() {
    // 由 cscript 承载（wscript 在无桌面的非交互上下文里起不来），路径无空格 → 计划任务 /tr 不必加引号。
    return `@echo off\r\ncscript //nologo "${windowsStartupScript}"\r\n`;
  }

  // 计划任务后备：直接常驻 `aih.exe server serve`，由 cmd.exe 承载。
  // 不使用 `server start`，因为后者会再派生子进程，任务结束时可能被一并回收。
  function buildWindowsServeScript() {
    const commandArgs = getServeCommandArgs().map(quoteWindowsCmdArg).join(' ');
    const redirect = windowsLogFile ? ` >> ${quoteWindowsCmdArg(windowsLogFile)} 2>&1` : '';
    // 计划任务/Startup 都不继承安装者的 shell 环境，home 必须写死在启动器里。
    const homeLine = aiHomeDir ? `set "AIH_HOME_DIR=${aiHomeDir}"\r\n` : '';
    return `@echo off\r\n${homeLine}${commandArgs}${redirect}\r\n`;
  }

  function installWindowsScheduledTask() {
    if (!windowsServeScript || !windowsTaskMarker) {
      throw new Error('aiHomeDir is required for Windows scheduled-task autostart');
    }
    ensureDir(path.dirname(windowsServeScript));
    if (windowsLogFile) ensureDir(path.dirname(windowsLogFile));
    fs.writeFileSync(windowsServeScript, buildWindowsServeScript());
    const user = nonEmptyString(processObj.env && (processObj.env.USERNAME || processObj.env.USER));
    const args = ['/Create', '/SC', 'ONLOGON', '/TN', label, '/TR', `"${windowsServeScript}"`, '/F'];
    if (user) args.push('/RU', user, '/IT');
    const created = run('schtasks', args, { encoding: 'utf8' });
    if (created.status !== 0) {
      throw new Error(nonEmptyString(created.stderr || created.stdout) || 'schtasks create failed');
    }
    fs.writeFileSync(windowsTaskMarker, `${JSON.stringify({ task: label, script: windowsServeScript })}\n`);
    return getWindowsStatus();
  }

  function buildWindowsScript() {
    const commandArgs = getStartCommandArgs().map(quoteWindowsCmdArg).join(' ');
    const pathValue = sanitizeWindowsStartupPath(processObj.env && processObj.env.PATH || '');
    // 必须用 Exec：承载它的宿主是 cscript（远程重启的正确做法，见 AGENTS.md）。
    // 注意根因不在 Run/Exec，而在宿主——**wscript 在没有桌面的非交互上下文里根本起不来**
    // （连"写个文件"的 trivial VBS 都不执行，静默退出），所以 SSH / 计划任务 / WMI 里必须用 cscript。
    // Exec 形式已在真机端到端验证（cscript 承载 → 服务器起来并脱离 SSH 会话存活）。
    const redirect = windowsLogFile ? ` >> ${quoteWindowsCmdArg(windowsLogFile)} 2>&1` : '';
    const execCommand = `%ComSpec% /c "${commandArgs}${redirect}"`;
    const homeLine = aiHomeDir
      ? `shell.Environment("PROCESS")("AIH_HOME_DIR") = ${quoteWindowsVbsString(aiHomeDir)}\r\n`
      : '';
    return `Option Explicit\r
Dim shell, execObj\r
Set shell = CreateObject("WScript.Shell")\r
shell.Environment("PROCESS")("PATH") = ${quoteWindowsVbsString(pathValue)}\r
${homeLine}Set execObj = shell.Exec(${quoteWindowsVbsString(execCommand)})\r
`;
  }

  function installWindows() {
    cleanupLegacyWindowsAutostart();
    ensureDir(path.dirname(windowsStartupScript));
    if (windowsLogFile) ensureDir(path.dirname(windowsLogFile));
    // 计划任务优先：Task Scheduler 拉起的进程有自己的会话，不会随 cscript / SSH
    // 控制台关闭；真机复现 Startup VBS 的 Exec 子进程会在 cscript 退出后一起结束。
    try {
      return installWindowsScheduledTask();
    } catch (taskError) {
      // 计划任务被策略拒绝时退回 Startup VBS（至少部分环境可用）。
      try {
        fs.writeFileSync(windowsStartupScript, buildWindowsScript());
        if (windowsLauncherScript) {
          ensureDir(path.dirname(windowsLauncherScript));
          fs.writeFileSync(windowsLauncherScript, buildWindowsLauncherScript());
        }
      } catch (error) {
        throw taskError;
      }
      return getWindowsStatus();
    }
  }

  function uninstallWindows() {
    for (const file of [windowsStartupScript, windowsLauncherScript, windowsServeScript, windowsTaskMarker]) {
      if (file && fs.existsSync(file)) fs.unlinkSync(file);
    }
    run('schtasks', ['/Delete', '/TN', label, '/F'], { stdio: 'ignore' });
    cleanupLegacyWindowsAutostart();
    return getWindowsStatus();
  }

  function stopWindowsLoaded() {
    return getWindowsStatus();
  }

  function cleanupLegacyWindowsAutostart() {
    const startupDir = path.dirname(windowsStartupScript);
    // 只清理 legacy label；当前 label 的计划任务可能正在托管运行中的服务，
    // 在这里 /Delete /F 会把服务一起带走。当前 label 由 installWindows 自己管理。
    const labels = new Set(legacyLabels());
    labels.forEach((legacyLabel) => {
      // 旧 label 也可能以计划任务形式存在；一起清掉，避免和新 label 抢端口。
      run('schtasks', ['/Delete', '/TN', legacyLabel, '/F'], { stdio: 'ignore' });
      for (const extension of ['cmd', 'vbs']) {
        const legacyScript = path.join(startupDir, `${legacyLabel}.${extension}`);
        if (legacyScript !== windowsStartupScript && fs.existsSync(legacyScript)) {
          fs.unlinkSync(legacyScript);
        }
      }
    });
  }

  function getStatus() {
    if (processObj.platform === 'darwin') return getMacStatus();
    if (processObj.platform === 'linux') return getLinuxStatus();
    if (processObj.platform === 'win32') return getWindowsStatus();
    return { supported: false, installed: false, loaded: false, type: processObj.platform || 'unknown' };
  }

  function install() {
    if (logFile && typeof ensureDir === 'function') ensureDir(path.dirname(logFile));
    if (processObj.platform === 'darwin') return installMac();
    if (processObj.platform === 'linux') return installLinux();
    if (processObj.platform === 'win32') return installWindows();
    throw new Error(`autostart is not supported on ${processObj.platform || 'this platform'}`);
  }

  function uninstall() {
    if (processObj.platform === 'darwin') return uninstallMac();
    if (processObj.platform === 'linux') return uninstallLinux();
    if (processObj.platform === 'win32') return uninstallWindows();
    throw new Error(`autostart is not supported on ${processObj.platform || 'this platform'}`);
  }

  function stopLoaded() {
    if (processObj.platform === 'darwin') return stopMacLoaded();
    if (processObj.platform === 'linux') return stopLinuxLoaded();
    if (processObj.platform === 'win32') return stopWindowsLoaded();
    return getStatus();
  }

  return {
    getStatus,
    install,
    uninstall,
    stopLoaded
  };
}

module.exports = {
  createServerAutostartService
};
