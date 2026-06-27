'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  isFlag,
  nonEmptyString,
  normalizePositiveInteger,
  readOptionValue
} = require('./option-parser');
const {
  normalizeEndpoint,
  normalizeNodeId,
  parseTransportHeartbeat
} = require('./registry-heartbeat');
const {
  DEFAULT_AGENT_INTERVAL_MS,
  DEFAULT_AGENT_PROBE_COUNT,
  DEFAULT_AGENT_PROBE_PAYLOAD_SIZE,
  parseProbeTransport
} = require('./registry-agent');

const DEFAULT_FABRIC_AGENT_SERVICE_LABEL_PREFIX = 'com.clawdcodex.ai_home.fabric-registry-agent';

function resolveHomePath(value, env = process.env) {
  const text = nonEmptyString(value);
  if (!text) return '';
  if (text === '~') return nonEmptyString(env.HOME || env.USERPROFILE) || text;
  if (text.startsWith('~/') || text.startsWith('~\\')) {
    const home = nonEmptyString(env.HOME || env.USERPROFILE);
    return home ? path.join(home, text.slice(2)) : text;
  }
  return text;
}

function resolveSystemdUserDir(pathImpl, processObj, fallbackHomeDir) {
  const home = nonEmptyString(processObj.env && processObj.env.HOME)
    || nonEmptyString(processObj.env && processObj.env.USERPROFILE)
    || nonEmptyString(fallbackHomeDir);
  return pathImpl.join(home, '.config', 'systemd', 'user');
}

function parseFabricRegistryAgentServiceArgs(rawArgs = [], deps = {}) {
  const args = Array.isArray(rawArgs) ? rawArgs.map((item) => String(item)) : [];
  const env = deps.env || process.env || {};
  const options = {
    action: nonEmptyString(args[0]),
    endpoint: '',
    nodeId: '',
    tokenFile: '',
    status: 'online',
    relayStatus: '',
    transports: [],
    probeTransports: [],
    probeTimeoutMs: 5000,
    probeMethod: 'HEAD',
    probeCount: DEFAULT_AGENT_PROBE_COUNT,
    probePayloadSize: DEFAULT_AGENT_PROBE_PAYLOAD_SIZE,
    intervalMs: DEFAULT_AGENT_INTERVAL_MS,
    json: false
  };

  if (!options.action) {
    const error = new Error('missing_fabric_agent_service_action');
    error.code = 'missing_fabric_agent_service_action';
    throw error;
  }
  if (!['install', 'status', 'uninstall'].includes(options.action)) {
    const error = new Error(`unknown_fabric_agent_service_action:${options.action}`);
    error.code = 'unknown_fabric_agent_service_action';
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
    if (token === '--token' || token.startsWith('--token=')) {
      const error = new Error('fabric_agent_service_token_not_allowed');
      error.code = 'fabric_agent_service_token_not_allowed';
      throw error;
    }
    if (token === '--token-file' || token.startsWith('--token-file=')) {
      const next = readOptionValue(args, index, '--token-file');
      options.tokenFile = path.resolve(resolveHomePath(next.value, env));
      index += next.consumed;
      continue;
    }
    if (token === '--node-id' || token.startsWith('--node-id=')) {
      const next = readOptionValue(args, index, '--node-id');
      options.nodeId = normalizeNodeId(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--status' || token.startsWith('--status=')) {
      const next = readOptionValue(args, index, '--status');
      options.status = nonEmptyString(next.value) || 'online';
      index += next.consumed;
      continue;
    }
    if (token === '--relay-status' || token.startsWith('--relay-status=')) {
      const next = readOptionValue(args, index, '--relay-status');
      options.relayStatus = nonEmptyString(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--transport' || token.startsWith('--transport=')) {
      const next = readOptionValue(args, index, '--transport');
      options.transports.push(parseTransportHeartbeat(next.value));
      index += next.consumed;
      continue;
    }
    if (token === '--probe-transport' || token.startsWith('--probe-transport=')) {
      const next = readOptionValue(args, index, '--probe-transport');
      const parsed = parseProbeTransport(next.value);
      options.probeTransports.push(`${parsed.kind}=${parsed.target}`);
      index += next.consumed;
      continue;
    }
    if (token === '--probe-timeout-ms' || token.startsWith('--probe-timeout-ms=')) {
      const next = readOptionValue(args, index, '--probe-timeout-ms');
      options.probeTimeoutMs = normalizePositiveInteger(next.value, 5000, 250, 120000);
      index += next.consumed;
      continue;
    }
    if (token === '--probe-method' || token.startsWith('--probe-method=')) {
      const next = readOptionValue(args, index, '--probe-method');
      const method = nonEmptyString(next.value).toUpperCase();
      if (method !== 'HEAD' && method !== 'GET') {
        const error = new Error('unsupported_http_method');
        error.code = 'unsupported_http_method';
        throw error;
      }
      options.probeMethod = method;
      index += next.consumed;
      continue;
    }
    if (token === '--probe-count' || token.startsWith('--probe-count=')) {
      const next = readOptionValue(args, index, '--probe-count');
      options.probeCount = normalizePositiveInteger(next.value, DEFAULT_AGENT_PROBE_COUNT, 1, 100);
      index += next.consumed;
      continue;
    }
    if (token === '--probe-payload-size' || token.startsWith('--probe-payload-size=')) {
      const next = readOptionValue(args, index, '--probe-payload-size');
      options.probePayloadSize = normalizePositiveInteger(next.value, DEFAULT_AGENT_PROBE_PAYLOAD_SIZE, 0, 64 * 1024);
      index += next.consumed;
      continue;
    }
    if (token === '--interval-ms' || token.startsWith('--interval-ms=')) {
      const next = readOptionValue(args, index, '--interval-ms');
      options.intervalMs = normalizePositiveInteger(next.value, DEFAULT_AGENT_INTERVAL_MS, 1000, 24 * 60 * 60 * 1000);
      index += next.consumed;
      continue;
    }
    if (token === '--count' || token.startsWith('--count=') || token === '--once') {
      const error = new Error('fabric_agent_service_count_not_allowed');
      error.code = 'fabric_agent_service_count_not_allowed';
      error.flag = token.split('=')[0];
      throw error;
    }
    if (isFlag(token)) {
      const error = new Error(`unknown_option:${token}`);
      error.code = 'unknown_option';
      error.flag = token;
      throw error;
    }
    if (options.endpoint) {
      const error = new Error('too_many_fabric_registry_endpoints');
      error.code = 'too_many_fabric_registry_endpoints';
      throw error;
    }
    options.endpoint = normalizeEndpoint(token);
    index += 1;
  }

  if (!options.nodeId) {
    const error = new Error('invalid_fabric_node_id');
    error.code = 'invalid_fabric_node_id';
    throw error;
  }
  if (options.action === 'install') {
    if (!options.endpoint) {
      const error = new Error('missing_fabric_registry_endpoint');
      error.code = 'missing_fabric_registry_endpoint';
      throw error;
    }
    if (!options.tokenFile) {
      const error = new Error('missing_fabric_token_file');
      error.code = 'missing_fabric_token_file';
      throw error;
    }
  }
  return options;
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

function normalizeServiceSuffix(nodeId) {
  return normalizeNodeId(nodeId).replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '');
}

function defaultHostHomeDir(pathImpl, processObj, aiHomeDir) {
  const env = processObj && processObj.env ? processObj.env : {};
  const fromEnv = nonEmptyString(env.USERPROFILE || env.HOME);
  if (fromEnv) return fromEnv;
  const root = nonEmptyString(aiHomeDir);
  return root ? pathImpl.dirname(root) : '';
}

function isWindowsAbsolutePath(value) {
  return /^[a-zA-Z]:[\\/]/.test(String(value || '')) || /^\\\\/.test(String(value || ''));
}

function normalizeCommandPath(pathImpl, processObj, commandPath) {
  const value = nonEmptyString(commandPath);
  if (!value) return '';
  if (processObj.platform === 'win32' && isWindowsAbsolutePath(value)) return value;
  if (pathImpl.isAbsolute(value)) return value;
  const cwd = processObj && typeof processObj.cwd === 'function' ? processObj.cwd() : process.cwd();
  return pathImpl.resolve(cwd, value);
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

function buildAgentServiceCliCommand(action, options = {}, nodeId = options.nodeId) {
  const args = ['aih', 'fabric', 'registry', 'agent', 'service', action];
  if (action === 'install') args.push(options.endpoint || '<server-url>');
  if (nodeId) args.push('--node-id', nodeId);
  if (action === 'install') args.push('--token-file', options.tokenFile || '<token-file>');
  return formatCliCommand(args);
}

function isAgentServiceRunning(status) {
  if (!status || !status.supported) return false;
  if (status.type === 'systemd-user') return Boolean(status.active);
  if (status.type === 'launchd') return Boolean(status.loaded);
  return false;
}

function deriveAgentServiceState(status) {
  if (!status || !status.supported) return 'unsupported';
  if (!status.installed) return 'missing';
  if (isAgentServiceRunning(status)) return 'running';
  return 'installed';
}

function buildAgentServicePlatformCommands(status = {}, options = {}) {
  const commands = {
    status: buildAgentServiceCliCommand('status', options, status.nodeId),
    install: buildAgentServiceCliCommand('install', options, status.nodeId),
    uninstall: buildAgentServiceCliCommand('uninstall', options, status.nodeId)
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

function buildAgentServiceIssues(status = {}, state) {
  if (state === 'unsupported') {
    return [{
      severity: 'error',
      code: 'fabric_agent_service_unsupported',
      message: `Fabric registry agent service is not supported on ${status.type || 'this platform'}.`
    }];
  }
  if (state === 'missing') {
    return [{
      severity: 'warning',
      code: 'fabric_agent_service_missing',
      message: 'Fabric registry agent service is not installed for this node.'
    }];
  }
  if (state === 'installed') {
    return [{
      severity: status.type === 'windows-startup' ? 'info' : 'warning',
      code: 'fabric_agent_service_not_running',
      message: status.type === 'windows-startup'
        ? 'Windows startup script is installed; run it now or sign in again to start the Fabric agent.'
        : 'Fabric registry agent service is installed but not currently running.'
    }];
  }
  return [];
}

function buildAgentServiceNextActions(state, status = {}, commands = {}) {
  if (state === 'unsupported') return [];
  if (state === 'missing') {
    return [
      { label: 'Install Fabric agent service', command: commands.install },
      { label: 'Run Fabric agent once in foreground', command: `aih fabric registry agent <server-url> --node-id ${quoteCliArg(status.nodeId)} --token-file <token-file> --once` }
    ];
  }
  if (state === 'installed') {
    return [
      { label: 'Start Fabric agent service', command: commands.start || commands.install },
      { label: 'Inspect Fabric agent logs', command: commands.logs || '' }
    ].filter((action) => action.command);
  }
  return [
    { label: 'Check Fabric agent service status', command: commands.status },
    { label: 'Inspect Fabric agent logs', command: commands.logs || '' }
  ].filter((action) => action.command);
}

function enrichAgentServiceStatus(status, options = {}) {
  const base = status || {};
  const state = deriveAgentServiceState(base);
  const commands = buildAgentServicePlatformCommands(base, options);
  return {
    ...base,
    state,
    running: isAgentServiceRunning(base),
    commands,
    issues: buildAgentServiceIssues(base, state),
    nextActions: buildAgentServiceNextActions(state, base, commands)
  };
}

function createFabricRegistryAgentServiceManager(input = {}, deps = {}) {
  const fsImpl = deps.fs || fs;
  const pathImpl = deps.path || path;
  const spawnSync = deps.spawnSync;
  const processObj = deps.processObj || process;
  const ensureDir = typeof deps.ensureDir === 'function'
    ? deps.ensureDir
    : (dir) => fsImpl.mkdirSync(dir, { recursive: true });
  const aiHomeDir = nonEmptyString(deps.aiHomeDir);
  const hostHomeDir = nonEmptyString(deps.hostHomeDir) || defaultHostHomeDir(pathImpl, processObj, aiHomeDir);
  const nodeId = normalizeNodeId(input.nodeId);
  const suffix = normalizeServiceSuffix(nodeId);
  if (!suffix) {
    const error = new Error('invalid_fabric_node_id');
    error.code = 'invalid_fabric_node_id';
    throw error;
  }

  const label = nonEmptyString(input.label || deps.label)
    || `${DEFAULT_FABRIC_AGENT_SERVICE_LABEL_PREFIX}.${suffix}`;
  const logFile = nonEmptyString(input.logFile || deps.logFile)
    || pathImpl.join(aiHomeDir || hostHomeDir, `fabric-registry-agent-${suffix}.log`);
  const launchdPlist = nonEmptyString(input.launchdPlist || deps.launchdPlist)
    || pathImpl.join(hostHomeDir, 'Library', 'LaunchAgents', `${label}.plist`);
  const systemdUnitFile = nonEmptyString(input.systemdUnitFile || deps.systemdUnitFile)
    || pathImpl.join(resolveSystemdUserDir(pathImpl, processObj, hostHomeDir), `${label}.service`);
  const windowsStartupScript = nonEmptyString(input.windowsStartupScript || deps.windowsStartupScript)
    || buildWindowsStartupScriptPath(pathImpl, hostHomeDir, processObj, label);

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
    if (envPath) return normalizeCommandPath(pathImpl, processObj, envPath);
    if (processObj.platform === 'win32') {
      return normalizeCommandPath(pathImpl, processObj, firstOutputLine(run('where', ['aih'], { encoding: 'utf8' })));
    }
    return normalizeCommandPath(pathImpl, processObj, firstOutputLine(run('sh', ['-lc', 'command -v aih'], {
      encoding: 'utf8',
      env: processObj.env
    })));
  }

  function resolveRequiredAihCommandPath() {
    const aihCommandPath = resolveAihCommandPath();
    if (aihCommandPath) return aihCommandPath;
    const error = new Error('aih command is required for Fabric registry agent service; set AIH_CLI_PATH or install the aih CLI first');
    error.code = 'aih_command_required';
    throw error;
  }

  function buildAgentCommandArgs() {
    const args = [
      resolveRequiredAihCommandPath(),
      'fabric',
      'registry',
      'agent',
      nonEmptyString(input.endpoint),
      '--node-id',
      nodeId,
      '--token-file',
      nonEmptyString(input.tokenFile),
      '--status',
      nonEmptyString(input.status || 'online')
    ];
    if (input.relayStatus) args.push('--relay-status', input.relayStatus);
    const transports = Array.isArray(input.transports) ? input.transports : [];
    const probeTransports = Array.isArray(input.probeTransports) ? input.probeTransports : [];
    transports.forEach((transport) => {
      args.push('--transport', `${transport.kind}=${transport.health}${transport.lastError ? `,${transport.lastError}` : ''}`);
    });
    probeTransports.forEach((transport) => {
      args.push('--probe-transport', transport);
    });
    if (input.probeTimeoutMs) args.push('--probe-timeout-ms', String(input.probeTimeoutMs));
    if (input.probeMethod) args.push('--probe-method', String(input.probeMethod));
    if (input.probeCount) args.push('--probe-count', String(input.probeCount));
    if (Number.isFinite(Number(input.probePayloadSize))) args.push('--probe-payload-size', String(input.probePayloadSize));
    if (input.intervalMs) args.push('--interval-ms', String(input.intervalMs));
    return args;
  }

  function getMacStatus() {
    const installed = fsImpl.existsSync(launchdPlist);
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
    const programArguments = buildAgentCommandArgs()
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
    ensureDir(pathImpl.dirname(launchdPlist));
    fsImpl.writeFileSync(launchdPlist, buildMacPlist());
    run('launchctl', ['unload', launchdPlist], { stdio: 'ignore' });
    const load = run('launchctl', ['load', launchdPlist], { encoding: 'utf8' });
    if (load.status !== 0) {
      throw new Error(nonEmptyString(load.stderr || load.stdout) || 'launchctl load failed');
    }
    return getMacStatus();
  }

  function uninstallMac() {
    if (fsImpl.existsSync(launchdPlist)) {
      run('launchctl', ['unload', launchdPlist], { stdio: 'ignore' });
      fsImpl.unlinkSync(launchdPlist);
    }
    return getMacStatus();
  }

  function getLinuxStatus() {
    const installed = fsImpl.existsSync(systemdUnitFile);
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
Description=AIH Fabric registry agent (${nodeId})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${buildAgentCommandArgs().map(quoteSystemdArg).join(' ')}
WorkingDirectory=${escapeSystemdValue(workingDirectory)}
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
      throw new Error(nonEmptyString(version.stderr || version.stdout) || 'systemctl is required for Fabric registry agent service');
    }
    ensureDir(pathImpl.dirname(systemdUnitFile));
    fsImpl.writeFileSync(systemdUnitFile, buildLinuxUnit());
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
    if (fsImpl.existsSync(systemdUnitFile)) {
      fsImpl.unlinkSync(systemdUnitFile);
    }
    run('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    return getLinuxStatus();
  }

  function getWindowsStatus() {
    const installed = fsImpl.existsSync(windowsStartupScript);
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
    const commandArgs = buildAgentCommandArgs().map(quoteWindowsCmdArg).join(' ');
    const pathValue = processObj.env && processObj.env.PATH || '';
    return `@echo off\r
set "PATH=${String(pathValue).replace(/"/g, '""')}"\r
${commandArgs}\r
exit /b %ERRORLEVEL%\r
`;
  }

  function installWindows() {
    ensureDir(pathImpl.dirname(windowsStartupScript));
    fsImpl.writeFileSync(windowsStartupScript, buildWindowsScript());
    return getWindowsStatus();
  }

  function uninstallWindows() {
    if (fsImpl.existsSync(windowsStartupScript)) {
      fsImpl.unlinkSync(windowsStartupScript);
    }
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
    if (!nonEmptyString(input.endpoint)) {
      const error = new Error('missing_fabric_registry_endpoint');
      error.code = 'missing_fabric_registry_endpoint';
      throw error;
    }
    if (!nonEmptyString(input.tokenFile)) {
      const error = new Error('missing_fabric_token_file');
      error.code = 'missing_fabric_token_file';
      throw error;
    }
    if (processObj.platform === 'darwin') return installMac();
    if (processObj.platform === 'linux') return installLinux();
    if (processObj.platform === 'win32') return installWindows();
    throw new Error(`Fabric registry agent service is not supported on ${processObj.platform || 'this platform'}`);
  }

  function uninstall() {
    if (processObj.platform === 'darwin') return uninstallMac();
    if (processObj.platform === 'linux') return uninstallLinux();
    if (processObj.platform === 'win32') return uninstallWindows();
    throw new Error(`Fabric registry agent service is not supported on ${processObj.platform || 'this platform'}`);
  }

  return {
    getStatus,
    install,
    uninstall
  };
}

function runFabricRegistryAgentService(rawArgs = [], deps = {}) {
  const options = parseFabricRegistryAgentServiceArgs(rawArgs, deps);
  const manager = createFabricRegistryAgentServiceManager(options, deps);
  const status = options.action === 'install'
    ? manager.install()
    : (options.action === 'uninstall' ? manager.uninstall() : manager.getStatus());
  return {
    ok: true,
    action: options.action,
    nodeId: normalizeNodeId(options.nodeId),
    status: enrichAgentServiceStatus(status, options),
    json: Boolean(options.json)
  };
}

module.exports = {
  DEFAULT_FABRIC_AGENT_SERVICE_LABEL_PREFIX,
  createFabricRegistryAgentServiceManager,
  enrichAgentServiceStatus,
  parseFabricRegistryAgentServiceArgs,
  runFabricRegistryAgentService
};
