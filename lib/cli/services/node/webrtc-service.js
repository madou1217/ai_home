'use strict';

const { normalizeId } = require('../../../server/remote/node-registry');

const DEFAULT_WEBRTC_SERVICE_LABEL_PREFIX = 'com.clawdcodex.ai_home.node-webrtc';

function nonEmptyString(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function isFlag(value) {
  return String(value || '').startsWith('-');
}

function readOptionValue(args, index, flag) {
  const token = String(args[index] || '');
  const prefix = `${flag}=`;
  if (token.startsWith(prefix)) return { value: token.slice(prefix.length), consumed: 1 };
  const value = args[index + 1];
  if (value === undefined || isFlag(value)) {
    const error = new Error(`missing_value:${flag}`);
    error.code = 'missing_option_value';
    error.flag = flag;
    throw error;
  }
  return { value: String(value), consumed: 2 };
}

function parsePositiveInteger(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function parseNodeWebrtcServiceArgs(rawArgs = []) {
  const args = Array.isArray(rawArgs) ? rawArgs.map((item) => String(item)) : [];
  const options = {
    action: nonEmptyString(args[0]),
    controlUrl: '',
    nodeId: '',
    connectTimeoutMs: 0,
    reconnectDelayMs: 0,
    json: false
  };
  if (!options.action) {
    const error = new Error('missing_webrtc_service_action');
    error.code = 'missing_webrtc_service_action';
    throw error;
  }
  if (!['install', 'status', 'uninstall'].includes(options.action)) {
    const error = new Error(`unknown_webrtc_service_action:${options.action}`);
    error.code = 'unknown_webrtc_service_action';
    error.action = options.action;
    throw error;
  }

  for (let index = 1; index < args.length;) {
    const token = nonEmptyString(args[index]);
    if (!token) {
      index += 1;
      continue;
    }
    if (token === '--json') {
      options.json = true;
      index += 1;
      continue;
    }
    if (token === '--node-id' || token.startsWith('--node-id=')
      || token === '--id' || token.startsWith('--id=')) {
      const flag = token.startsWith('--id') ? '--id' : '--node-id';
      const next = readOptionValue(args, index, flag);
      options.nodeId = next.value;
      index += next.consumed;
      continue;
    }
    if (token === '--connect-timeout-ms' || token.startsWith('--connect-timeout-ms=')) {
      const next = readOptionValue(args, index, '--connect-timeout-ms');
      options.connectTimeoutMs = parsePositiveInteger(next.value, 0, 1000, 120000);
      index += next.consumed;
      continue;
    }
    if (token === '--reconnect-delay-ms' || token.startsWith('--reconnect-delay-ms=')) {
      const next = readOptionValue(args, index, '--reconnect-delay-ms');
      options.reconnectDelayMs = parsePositiveInteger(next.value, 0, 250, 120000);
      index += next.consumed;
      continue;
    }
    if (token === '--management-key' || token.startsWith('--management-key=')) {
      const error = new Error('webrtc_service_management_key_not_allowed');
      error.code = 'webrtc_service_management_key_not_allowed';
      throw error;
    }
    if (token === '--once' || token === '--max-attempts' || token.startsWith('--max-attempts=')) {
      const error = new Error(`webrtc_service_option_not_allowed:${token}`);
      error.code = 'webrtc_service_option_not_allowed';
      error.flag = token.split('=')[0];
      throw error;
    }
    if (isFlag(token)) {
      const error = new Error(`unknown_option:${token}`);
      error.code = 'unknown_option';
      error.flag = token;
      throw error;
    }
    if (options.controlUrl) {
      const error = new Error('too_many_webrtc_service_urls');
      error.code = 'too_many_webrtc_service_urls';
      throw error;
    }
    options.controlUrl = token;
    index += 1;
  }

  return options;
}

function readServerConfigSafe(readServerConfig) {
  if (typeof readServerConfig !== 'function') return {};
  try {
    return readServerConfig() || {};
  } catch (_error) {
    return {};
  }
}

function escapeXml(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
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

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\"'\"'")}'`;
}

function quoteCliArg(value) {
  const text = String(value || '');
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(text) ? text : shellQuote(text);
}

function formatCliCommand(args) {
  return args.map(quoteCliArg).join(' ');
}

function firstOutputLine(result) {
  return String(result && result.stdout || '')
    .split(/\r?\n/)
    .map((line) => nonEmptyString(line))
    .find(Boolean) || '';
}

function isWindowsAbsolutePath(value) {
  return /^[a-zA-Z]:[\\/]/.test(String(value || '')) || /^\\\\/.test(String(value || ''));
}

function defaultHostHomeDir(pathImpl, processObj, aiHomeDir) {
  const env = processObj && processObj.env ? processObj.env : {};
  const fromEnv = nonEmptyString(env.USERPROFILE || env.HOME);
  if (fromEnv) return fromEnv;
  const root = nonEmptyString(aiHomeDir);
  return root ? pathImpl.dirname(root) : '';
}

function normalizeCommandPath(pathImpl, processObj, commandPath) {
  const value = nonEmptyString(commandPath);
  if (!value) return '';
  if (processObj.platform === 'win32' && isWindowsAbsolutePath(value)) return value;
  if (pathImpl.isAbsolute(value)) return value;
  const cwd = processObj && typeof processObj.cwd === 'function' ? processObj.cwd() : process.cwd();
  return pathImpl.resolve(cwd, value);
}

function normalizeServiceSuffix(nodeId) {
  return normalizeId(nodeId).replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '');
}

function resolveSystemdUserDir(pathImpl, processObj, fallbackHomeDir) {
  const home = nonEmptyString(processObj.env && processObj.env.HOME)
    || nonEmptyString(processObj.env && processObj.env.USERPROFILE)
    || nonEmptyString(fallbackHomeDir);
  return pathImpl.join(home, '.config', 'systemd', 'user');
}

function buildWindowsStartupScriptPath(pathImpl, hostHomeDir, processObj, label) {
  const env = processObj && processObj.env ? processObj.env : {};
  const appData = nonEmptyString(env.APPDATA) || pathImpl.join(hostHomeDir, 'AppData', 'Roaming');
  return pathImpl.join(
    appData,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
    `${label}.cmd`
  );
}

function isWebrtcServiceRunning(status) {
  if (!status || !status.supported) return false;
  if (status.type === 'systemd-user') return Boolean(status.active);
  if (status.type === 'launchd') return Boolean(status.loaded);
  return false;
}

function deriveWebrtcServiceState(status) {
  if (!status || !status.supported) return 'unsupported';
  if (!status.installed) return 'missing';
  if (isWebrtcServiceRunning(status)) return 'running';
  return 'installed';
}

function buildWebrtcServiceCliCommand(action, options = {}, nodeId = options.nodeId) {
  const args = ['aih', 'node', 'webrtc', 'service', action];
  if (action === 'install') args.push(options.controlUrl || '<control-url>');
  if (nodeId) args.push('--node-id', nodeId);
  return formatCliCommand(args);
}

function buildWebrtcServicePlatformCommands(status = {}, options = {}) {
  const commands = {
    status: buildWebrtcServiceCliCommand('status', options, status.nodeId),
    install: buildWebrtcServiceCliCommand('install', options, status.nodeId),
    uninstall: buildWebrtcServiceCliCommand('uninstall', options, status.nodeId)
  };
  if (status.type === 'systemd-user' && status.unit) {
    commands.start = `systemctl --user enable --now ${quoteCliArg(status.unit)}`;
    commands.restart = `systemctl --user restart ${quoteCliArg(status.unit)}`;
    commands.logs = `journalctl --user -u ${quoteCliArg(status.unit)} -n 80 --no-pager`;
  }
  if (status.type === 'launchd' && status.file) {
    commands.start = `launchctl load ${quoteCliArg(status.file)}`;
    commands.restart = `launchctl unload ${quoteCliArg(status.file)} && launchctl load ${quoteCliArg(status.file)}`;
    if (status.logFile) commands.logs = `tail -n 80 ${quoteCliArg(status.logFile)}`;
  }
  if (status.type === 'windows-startup' && status.file) {
    commands.start = quoteWindowsCmdArg(status.file);
    commands.restart = quoteWindowsCmdArg(status.file);
  }
  return commands;
}

function buildWebrtcServiceIssues(status = {}, state) {
  if (state === 'unsupported') {
    return [{
      severity: 'error',
      code: 'webrtc_service_unsupported',
      message: `Persistent WebRTC connector service is not supported on ${status.type || 'this platform'}.`
    }];
  }
  if (state === 'missing') {
    return [{
      severity: 'warning',
      code: 'webrtc_service_missing',
      message: 'Persistent WebRTC connector service is not installed for this node.'
    }];
  }
  if (state === 'installed') {
    const message = status.type === 'windows-startup'
      ? 'Windows startup script is installed; run it now or sign in again to start WebRTC connector immediately.'
      : 'Persistent WebRTC connector service is installed but not currently running.';
    return [{
      severity: status.type === 'windows-startup' ? 'info' : 'warning',
      code: 'webrtc_service_not_running',
      message
    }];
  }
  return [];
}

function buildWebrtcServiceNextActions(state, status = {}, commands = {}) {
  if (state === 'unsupported') return [];
  if (state === 'missing') {
    return [
      { label: 'Install WebRTC connector service', command: commands.install },
      { label: 'Verify WebRTC connector once', command: `aih node webrtc connect <control-url> --node-id ${quoteCliArg(status.nodeId)} --once` }
    ];
  }
  if (state === 'installed') {
    return [
      { label: 'Start WebRTC connector service', command: commands.start || commands.install },
      { label: 'Inspect WebRTC connector logs', command: commands.logs || '' }
    ].filter((action) => action.command);
  }
  return [
    { label: 'Check WebRTC connector service status', command: commands.status },
    { label: 'Inspect WebRTC connector logs', command: commands.logs || '' }
  ].filter((action) => action.command);
}

function enrichWebrtcServiceStatus(status, options = {}) {
  const base = status || {};
  const state = deriveWebrtcServiceState(base);
  const commands = buildWebrtcServicePlatformCommands(base, options);
  return {
    ...base,
    state,
    running: isWebrtcServiceRunning(base),
    commands,
    issues: buildWebrtcServiceIssues(base, state),
    nextActions: buildWebrtcServiceNextActions(state, base, commands)
  };
}

function createNodeWebrtcServiceManager(input = {}, deps = {}) {
  const fs = deps.fs || require('node:fs');
  const path = deps.path || require('node:path');
  const spawnSync = deps.spawnSync;
  const processObj = deps.processObj || process;
  const ensureDir = typeof deps.ensureDir === 'function'
    ? deps.ensureDir
    : (dir) => fs.mkdirSync(dir, { recursive: true });
  const aiHomeDir = nonEmptyString(deps.aiHomeDir);
  const hostHomeDir = nonEmptyString(deps.hostHomeDir) || defaultHostHomeDir(path, processObj, aiHomeDir);
  const nodeId = normalizeId(input.nodeId);
  const suffix = normalizeServiceSuffix(nodeId);
  if (!suffix) {
    const error = new Error('missing_webrtc_node_id');
    error.code = 'missing_webrtc_node_id';
    throw error;
  }

  const label = nonEmptyString(input.label || deps.label)
    || `${DEFAULT_WEBRTC_SERVICE_LABEL_PREFIX}.${suffix}`;
  const logFile = nonEmptyString(input.logFile || deps.logFile)
    || path.join(aiHomeDir || hostHomeDir, `node-webrtc-${suffix}.log`);
  const launchdPlist = nonEmptyString(input.launchdPlist || deps.launchdPlist)
    || path.join(hostHomeDir, 'Library', 'LaunchAgents', `${label}.plist`);
  const systemdUnitFile = nonEmptyString(input.systemdUnitFile || deps.systemdUnitFile)
    || path.join(resolveSystemdUserDir(path, processObj, hostHomeDir), `${label}.service`);
  const windowsStartupScript = nonEmptyString(input.windowsStartupScript || deps.windowsStartupScript)
    || buildWindowsStartupScriptPath(path, hostHomeDir, processObj, label);

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

  function resolveAihCommandPath() {
    const envPath = nonEmptyString(processObj.env && processObj.env.AIH_CLI_PATH);
    if (envPath) return normalizeCommandPath(path, processObj, envPath);

    if (processObj.platform === 'win32') {
      return normalizeCommandPath(path, processObj, firstOutputLine(run('where', ['aih'], { encoding: 'utf8' })));
    }

    return normalizeCommandPath(path, processObj, firstOutputLine(run('sh', ['-lc', 'command -v aih'], {
      encoding: 'utf8',
      env: processObj.env
    })));
  }

  function resolveRequiredAihCommandPath() {
    const aihCommandPath = resolveAihCommandPath();
    if (aihCommandPath) return aihCommandPath;
    const error = new Error('aih command is required for WebRTC connector service; set AIH_CLI_PATH or install the aih CLI first');
    error.code = 'aih_command_required';
    throw error;
  }

  function buildConnectCommandArgs() {
    const args = [
      resolveRequiredAihCommandPath(),
      'node',
      'webrtc',
      'connect',
      nonEmptyString(input.controlUrl),
      '--node-id',
      nodeId
    ];
    if (input.connectTimeoutMs) args.push('--connect-timeout-ms', String(input.connectTimeoutMs));
    if (input.reconnectDelayMs) args.push('--reconnect-delay-ms', String(input.reconnectDelayMs));
    return args;
  }

  function getMacStatus() {
    const installed = fs.existsSync(launchdPlist);
    const out = run('launchctl', ['list', label], { encoding: 'utf8' });
    return {
      supported: true,
      type: 'launchd',
      installed,
      loaded: out.status === 0,
      file: launchdPlist,
      plist: launchdPlist,
      logFile,
      label,
      nodeId
    };
  }

  function buildMacPlist() {
    const programArguments = buildConnectCommandArgs()
      .map((arg) => `      <string>${escapeXml(arg)}</string>`)
      .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapeXml(label)}</string>
    <key>ProgramArguments</key>
    <array>
${programArguments}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${escapeXml(logFile)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(logFile)}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>${escapeXml(processObj.env && processObj.env.PATH || '')}</string>
    </dict>
  </dict>
</plist>
`;
  }

  function installMac() {
    ensureDir(path.dirname(launchdPlist));
    fs.writeFileSync(launchdPlist, buildMacPlist());
    run('launchctl', ['unload', launchdPlist], { stdio: 'ignore' });
    const load = run('launchctl', ['load', launchdPlist], { encoding: 'utf8' });
    if (load.status !== 0) {
      throw new Error(nonEmptyString(load.stderr || load.stdout) || 'launchctl load failed');
    }
    return getMacStatus();
  }

  function uninstallMac() {
    if (fs.existsSync(launchdPlist)) {
      run('launchctl', ['unload', launchdPlist], { stdio: 'ignore' });
      fs.unlinkSync(launchdPlist);
    }
    return getMacStatus();
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
      logFile,
      label,
      nodeId
    };
  }

  function buildLinuxUnit() {
    const workingDirectory = aiHomeDir || hostHomeDir;
    return `[Unit]
Description=AI Home WebRTC node connector (${nodeId})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${buildConnectCommandArgs().map(quoteSystemdArg).join(' ')}
WorkingDirectory=${escapeSystemdValue(workingDirectory)}
Restart=always
RestartSec=5
Environment="PATH=${escapeSystemdValue(processObj.env && processObj.env.PATH || '')}"
Environment="AIH_HOST_HOME=${escapeSystemdValue(hostHomeDir)}"
StandardOutput=append:${escapeSystemdValue(logFile)}
StandardError=append:${escapeSystemdValue(logFile)}

[Install]
WantedBy=default.target
`;
  }

  function installLinux() {
    const version = run('systemctl', ['--version'], { encoding: 'utf8' });
    if (version.status !== 0) {
      throw new Error(nonEmptyString(version.stderr || version.stdout) || 'systemctl is required for Linux WebRTC connector service');
    }
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
    if (fs.existsSync(systemdUnitFile)) fs.unlinkSync(systemdUnitFile);
    run('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    return getLinuxStatus();
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
      label,
      nodeId
    };
  }

  function buildWindowsScript() {
    const commandArgs = buildConnectCommandArgs().map(quoteWindowsCmdArg).join(' ');
    const pathValue = processObj.env && processObj.env.PATH || '';
    return `@echo off\r
set "PATH=${String(pathValue).replace(/"/g, '""')}"\r
${commandArgs}\r
exit /b %ERRORLEVEL%\r
`;
  }

  function installWindows() {
    ensureDir(path.dirname(windowsStartupScript));
    fs.writeFileSync(windowsStartupScript, buildWindowsScript());
    return getWindowsStatus();
  }

  function uninstallWindows() {
    if (fs.existsSync(windowsStartupScript)) fs.unlinkSync(windowsStartupScript);
    return getWindowsStatus();
  }

  function getStatus() {
    if (processObj.platform === 'darwin') return getMacStatus();
    if (processObj.platform === 'linux') return getLinuxStatus();
    if (processObj.platform === 'win32') return getWindowsStatus();
    return {
      supported: false,
      installed: false,
      loaded: false,
      type: processObj.platform || 'unknown',
      label,
      nodeId
    };
  }

  function install() {
    if (!nonEmptyString(input.controlUrl)) {
      const error = new Error('missing_webrtc_url');
      error.code = 'missing_webrtc_url';
      throw error;
    }
    if (processObj.platform === 'darwin') return installMac();
    if (processObj.platform === 'linux') return installLinux();
    if (processObj.platform === 'win32') return installWindows();
    throw new Error(`WebRTC connector service is not supported on ${processObj.platform || 'this platform'}`);
  }

  function uninstall() {
    if (processObj.platform === 'darwin') return uninstallMac();
    if (processObj.platform === 'linux') return uninstallLinux();
    if (processObj.platform === 'win32') return uninstallWindows();
    throw new Error(`WebRTC connector service is not supported on ${processObj.platform || 'this platform'}`);
  }

  return {
    getStatus,
    install,
    uninstall
  };
}

function assertServiceCanReadManagementKey(deps = {}) {
  const serverConfig = readServerConfigSafe(deps.readServerConfig);
  if (nonEmptyString(serverConfig.managementKey)) return;
  const error = new Error('management_key_required');
  error.code = 'management_key_required';
  error.command = 'webrtc-service';
  throw error;
}

function runNodeWebrtcService(rawArgs = [], deps = {}) {
  const options = parseNodeWebrtcServiceArgs(rawArgs);
  if (options.action === 'install') {
    assertServiceCanReadManagementKey(deps);
  }
  const manager = createNodeWebrtcServiceManager(options, deps);
  const status = options.action === 'install'
    ? manager.install()
    : (options.action === 'uninstall' ? manager.uninstall() : manager.getStatus());
  return {
    ok: true,
    action: options.action,
    nodeId: normalizeId(options.nodeId),
    status: enrichWebrtcServiceStatus(status, options),
    json: Boolean(options.json)
  };
}

module.exports = {
  DEFAULT_WEBRTC_SERVICE_LABEL_PREFIX,
  parseNodeWebrtcServiceArgs,
  createNodeWebrtcServiceManager,
  enrichWebrtcServiceStatus,
  runNodeWebrtcService
};
