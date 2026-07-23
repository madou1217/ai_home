'use strict';

const {
  listEffectiveBackgroundComponents,
  readBackgroundSupervisorState,
  removeBackgroundComponent,
  writeBackgroundSupervisorState
} = require('../background/supervisor-state-store');
const {
  scanLegacyMacosServices
} = require('../background/legacy-macos-service-migration');
const { createMacosLaunchAgent } = require('../background/macos-launch-agent');

const LEGACY_AUTOSTART_LABELS = Object.freeze(['com.aih.server', 'aih-server']);

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
  const label = nonEmptyString(deps.launchdLabel) || 'com.clawdcodex.ai_home';
  const launchdPlist = deps.launchdPlist;
  const logFile = deps.logFile;
  const resolveStartEntryFilePath = deps.resolveStartEntryFilePath;
  const resolveStartServeArgs = deps.resolveStartServeArgs;
  const systemdUnitFile = nonEmptyString(deps.systemdUnitFile)
    || buildSystemdUnitFilePath(path, hostHomeDir, label);
  const windowsStartupScript = nonEmptyString(deps.windowsStartupScript)
    || buildWindowsStartupScriptPath(path, hostHomeDir, processObj, label);

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
    const envPath = nonEmptyString(processObj.env && processObj.env.AIH_CLI_PATH);
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
    throw new Error('aih command is required for autostart; set AIH_CLI_PATH or install the aih CLI first');
  }

  function getServeCommandArgs() {
    return [
      resolveRequiredAihCommandPath(),
      'server',
      'serve',
      ...getServeArgs()
    ];
  }

  function getStartCommandArgs() {
    return [
      resolveRequiredAihCommandPath(),
      'server',
      'start'
    ];
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
    const migration = scanLegacyMacosServices({
      launchAgentsDir: path.dirname(plistFile)
    }, { fs, path });
    const nextState = {
      schemaVersion: previousState.schemaVersion,
      components: { ...previousState.components }
    };
    migration.components.forEach((component) => {
      if (!Object.hasOwn(nextState.components, component.id)) {
        nextState.components[component.id] = component;
      }
    });
    nextState.components.server = {
      id: 'server',
      args: ['server', 'serve']
    };
    writeBackgroundSupervisorState(nextState, stateDeps);
    createBackgroundLaunchAgent(migration.legacyServices).install({
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
    return `[Unit]
Description=AI Home local server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${commandArgs.map(quoteSystemdArg).join(' ')}
WorkingDirectory=${quoteSystemdArg(workingDirectory)}
Restart=always
RestartSec=5
Environment="PATH=${escapeSystemdValue(processObj.env && processObj.env.PATH || '')}"
StandardOutput=append:${escapeSystemdValue(logFile)}
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
    const installed = fs.existsSync(windowsStartupScript);
    return {
      supported: true,
      type: 'windows-startup',
      installed,
      loaded: installed,
      file: windowsStartupScript,
      script: windowsStartupScript,
      label
    };
  }

  function buildWindowsScript() {
    const commandArgs = getStartCommandArgs().map(quoteWindowsCmdArg).join(' ');
    const pathValue = sanitizeWindowsStartupPath(processObj.env && processObj.env.PATH || '');
    return `Option Explicit\r
Dim shell\r
Set shell = CreateObject("WScript.Shell")\r
shell.Environment("PROCESS")("PATH") = ${quoteWindowsVbsString(pathValue)}\r
shell.Run ${quoteWindowsVbsString(commandArgs)}, 0, False\r
`;
  }

  function installWindows() {
    cleanupLegacyWindowsAutostart();
    ensureDir(path.dirname(windowsStartupScript));
    fs.writeFileSync(windowsStartupScript, buildWindowsScript());
    return getWindowsStatus();
  }

  function uninstallWindows() {
    if (fs.existsSync(windowsStartupScript)) {
      fs.unlinkSync(windowsStartupScript);
    }
    cleanupLegacyWindowsAutostart();
    return getWindowsStatus();
  }

  function stopWindowsLoaded() {
    return getWindowsStatus();
  }

  function cleanupLegacyWindowsAutostart() {
    const startupDir = path.dirname(windowsStartupScript);
    const labels = new Set([...legacyLabels(), label]);
    labels.forEach((legacyLabel) => {
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
