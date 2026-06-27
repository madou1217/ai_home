'use strict';

const { spawn } = require('node:child_process');
const net = require('node:net');
const { normalizeTransportKind } = require('../../../server/remote/transport-registry');
const {
  getDefaultRepoSubdir,
  normalizeRepoSubdir,
  toWindowsRepoSubdir
} = require('../../../server/remote/repo-paths');
const {
  SUPPORTED_BOOTSTRAP_TARGETS,
  getLoopbackControlUrlWarning
} = require('./bootstrap');

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_TCP_PORTS = Object.freeze([22, 3389, 445, 5985, 5986]);
const DEFAULT_HTTP_HEALTH_PATH = '/healthz';
const MANUAL_BOOTSTRAP_CHANNEL = 'local console';
const EXECUTION_PRIORITIES = Object.freeze({
  sshRemoteRun: 10,
  sshAuthRequired: 15,
  winrm: 20,
  localManual: 30,
  sshPort: 40,
  generatedScript: 50,
  unreachable: 90
});

function nonEmptyString(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function isFlag(value) {
  return String(value || '').startsWith('-');
}

function readOptionValue(args, index, flag) {
  const token = String(args[index] || '');
  const prefix = `${flag}=`;
  if (token.startsWith(prefix)) {
    return { value: token.slice(prefix.length), consumed: 1 };
  }
  const value = args[index + 1];
  if (value === undefined || isFlag(value)) {
    const error = new Error(`missing_value:${flag}`);
    error.code = 'missing_option_value';
    error.flag = flag;
    throw error;
  }
  return { value: String(value), consumed: 2 };
}

function normalizePositiveInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function parsePortList(value) {
  const raw = nonEmptyString(value);
  if (!raw) return DEFAULT_TCP_PORTS.slice();
  const ports = raw.split(',')
    .map((item) => Number(nonEmptyString(item)))
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
  return Array.from(new Set(ports)).sort((left, right) => left - right);
}

function sanitizeFileSegment(value) {
  return nonEmptyString(value)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'host';
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

function normalizeStringList(value) {
  return Array.isArray(value)
    ? value.map(nonEmptyString).filter(Boolean)
    : [];
}

function normalizePortListValue(value) {
  const ports = Array.isArray(value)
    ? value.map((item) => Number(item)).filter((port) => Number.isInteger(port) && port > 0 && port <= 65535)
    : [];
  return Array.from(new Set(ports.length ? ports : DEFAULT_TCP_PORTS)).sort((left, right) => left - right);
}

function buildNodeBootstrapProbeOptionArgs(options = {}) {
  const source = options && typeof options === 'object' ? options : {};
  const sshTargets = normalizeStringList(source.sshTargets);
  const tcpTargets = normalizeStringList(source.tcpTargets);
  const httpTargets = normalizeStringList(source.httpTargets || source.ingressTargets);
  if (sshTargets.length === 0 && tcpTargets.length === 0 && httpTargets.length === 0) {
    sshTargets.push('user@linux-host', 'user@mac-host');
    tcpTargets.push('windows-host');
  }

  const args = [];
  sshTargets.forEach((target) => args.push('--ssh', target));
  tcpTargets.forEach((target) => args.push('--tcp', target));
  httpTargets.forEach((target) => args.push('--http', target));
  args.push('--ports', normalizePortListValue(source.ports).join(','));

  const bootstrapTarget = normalizeProbeBootstrapTarget(source.bootstrapTarget || source.target);
  if (bootstrapTarget) args.push('--target', bootstrapTarget);
  if (source.controlUrl) args.push('--control-url', nonEmptyString(source.controlUrl));
  if (source.inviteUrl) args.push('--invite-url', nonEmptyString(source.inviteUrl));
  if (source.repoUrl) args.push('--repo-url', nonEmptyString(source.repoUrl));
  if (source.repoDir) args.push('--repo-dir', nonEmptyString(source.repoDir));
  if (source.repoSubdir) args.push('--repo-subdir', normalizeRepoSubdir(source.repoSubdir));
  if (source.transportKind) args.push('--transport', normalizeProbeTransport(source.transportKind));
  if (source.endpoint) args.push('--endpoint', nonEmptyString(source.endpoint));

  const concurrency = normalizePositiveInteger(source.concurrency, 3, 1, 32);
  const timeoutMs = normalizePositiveInteger(source.timeoutMs, 3000, 250, 120000);
  args.push('-j', String(concurrency), '--timeout-ms', String(timeoutMs));
  return args;
}

function buildNodeBootstrapProbeArgs(options = {}) {
  return ['aih', 'node', 'bootstrap', 'probe', ...buildNodeBootstrapProbeOptionArgs(options)];
}

function buildNodeBootstrapProbeCommand(options = {}) {
  const args = buildNodeBootstrapProbeArgs(options);
  return formatCliCommand(args);
}

function normalizeProbeTransport(value) {
  const kind = normalizeTransportKind(value || 'relay');
  if (kind) return kind;
  const error = new Error('invalid_transport_kind');
  error.code = 'invalid_transport_kind';
  throw error;
}

function normalizeProbeBootstrapTarget(value) {
  const target = nonEmptyString(value).toLowerCase();
  if (!target) return '';
  if (SUPPORTED_BOOTSTRAP_TARGETS.includes(target)) return target;
  const error = new Error(`unsupported_bootstrap_target:${target || 'unknown'}`);
  error.code = 'unsupported_bootstrap_target';
  error.target = target;
  throw error;
}

function splitHostPort(value) {
  const raw = nonEmptyString(value);
  const match = raw.match(/^(.+):(\d{1,5})$/);
  if (!match) return { host: raw, port: 0 };
  return {
    host: match[1].replace(/^\[|\]$/g, ''),
    port: normalizePositiveInteger(match[2], 0, 1, 65535)
  };
}

function parseSshTarget(value) {
  const raw = nonEmptyString(value);
  const atIndex = raw.lastIndexOf('@');
  const user = atIndex > 0 ? raw.slice(0, atIndex) : '';
  const hostPart = atIndex > 0 ? raw.slice(atIndex + 1) : raw;
  const parsed = splitHostPort(hostPart);
  if (!parsed.host) {
    const error = new Error('invalid_probe_ssh_target');
    error.code = 'invalid_probe_ssh_target';
    throw error;
  }
  return {
    kind: 'ssh',
    raw,
    user,
    host: parsed.host,
    port: parsed.port,
    label: raw
  };
}

function parseTcpTarget(value, ports) {
  const raw = nonEmptyString(value);
  const parsed = splitHostPort(raw);
  if (!parsed.host) {
    const error = new Error('invalid_probe_tcp_target');
    error.code = 'invalid_probe_tcp_target';
    throw error;
  }
  return {
    kind: 'tcp',
    raw,
    host: parsed.host,
    ports: parsed.port ? [parsed.port] : ports.slice(),
    usesDefaultPorts: !parsed.port,
    label: raw
  };
}

function normalizeHttpProbeUrl(value) {
  const raw = nonEmptyString(value);
  if (!raw) {
    const error = new Error('invalid_probe_http_target');
    error.code = 'invalid_probe_http_target';
    throw error;
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let parsed = null;
  try {
    parsed = new URL(withScheme);
  } catch (_error) {
    const error = new Error('invalid_probe_http_target');
    error.code = 'invalid_probe_http_target';
    throw error;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    const error = new Error('unsupported_probe_http_protocol');
    error.code = 'unsupported_probe_http_protocol';
    throw error;
  }
  if (!parsed.hostname) {
    const error = new Error('invalid_probe_http_target');
    error.code = 'invalid_probe_http_target';
    throw error;
  }
  if (!parsed.pathname || parsed.pathname === '/') parsed.pathname = DEFAULT_HTTP_HEALTH_PATH;
  return parsed.toString();
}

function parseHttpTarget(value) {
  const raw = nonEmptyString(value);
  const url = normalizeHttpProbeUrl(raw);
  return {
    kind: 'http',
    raw,
    url,
    label: raw || url
  };
}

function parseNodeBootstrapProbeArgs(rawArgs = []) {
  const args = Array.isArray(rawArgs) ? rawArgs.map((item) => String(item)) : [];
  const options = {
    sshTargets: [],
    tcpTargets: [],
    httpTargets: [],
    ports: DEFAULT_TCP_PORTS.slice(),
    concurrency: DEFAULT_CONCURRENCY,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    repoDir: '',
    repoSubdir: '',
    repoUrl: '',
    controlUrl: '',
    inviteUrl: '',
    endpoint: '',
    transportKind: 'relay',
    bootstrapTarget: '',
    knownHostsFile: '',
    json: false
  };

  for (let index = 0; index < args.length;) {
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
    if (token === '--ssh' || token === '--ssh-target' || token.startsWith('--ssh=') || token.startsWith('--ssh-target=')) {
      const flag = token.startsWith('--ssh-target') ? '--ssh-target' : '--ssh';
      const next = readOptionValue(args, index, flag);
      options.sshTargets.push(parseSshTarget(next.value));
      index += next.consumed;
      continue;
    }
    if (token === '--tcp' || token === '--tcp-target' || token.startsWith('--tcp=') || token.startsWith('--tcp-target=')) {
      const flag = token.startsWith('--tcp-target') ? '--tcp-target' : '--tcp';
      const next = readOptionValue(args, index, flag);
      options.tcpTargets.push(parseTcpTarget(next.value, options.ports));
      index += next.consumed;
      continue;
    }
    if (token === '--http' || token === '--http-target' || token === '--ingress'
      || token.startsWith('--http=') || token.startsWith('--http-target=') || token.startsWith('--ingress=')) {
      const flag = token.startsWith('--http-target')
        ? '--http-target'
        : (token.startsWith('--ingress') ? '--ingress' : '--http');
      const next = readOptionValue(args, index, flag);
      options.httpTargets.push(parseHttpTarget(next.value));
      index += next.consumed;
      continue;
    }
    if (token === '--ports' || token.startsWith('--ports=')) {
      const next = readOptionValue(args, index, '--ports');
      options.ports = parsePortList(next.value);
      options.tcpTargets = options.tcpTargets.map((target) => {
        return target.usesDefaultPorts ? { ...target, ports: options.ports.slice() } : target;
      });
      index += next.consumed;
      continue;
    }
    if (token === '--concurrency' || token === '-j' || token.startsWith('--concurrency=')) {
      const flag = token === '-j' ? '-j' : '--concurrency';
      const next = readOptionValue(args, index, flag);
      options.concurrency = normalizePositiveInteger(next.value, DEFAULT_CONCURRENCY, 1, 32);
      index += next.consumed;
      continue;
    }
    if (token === '--timeout-ms' || token === '--timeout' || token.startsWith('--timeout-ms=') || token.startsWith('--timeout=')) {
      const flag = token.startsWith('--timeout-ms') ? '--timeout-ms' : '--timeout';
      const next = readOptionValue(args, index, flag);
      options.timeoutMs = normalizePositiveInteger(next.value, DEFAULT_TIMEOUT_MS, 250, 120000);
      index += next.consumed;
      continue;
    }
    if (token === '--repo-dir' || token.startsWith('--repo-dir=')) {
      const next = readOptionValue(args, index, '--repo-dir');
      options.repoDir = nonEmptyString(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--repo-subdir' || token.startsWith('--repo-subdir=')) {
      const next = readOptionValue(args, index, '--repo-subdir');
      options.repoSubdir = normalizeRepoSubdir(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--repo-url' || token.startsWith('--repo-url=')) {
      const next = readOptionValue(args, index, '--repo-url');
      options.repoUrl = nonEmptyString(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--control-url' || token.startsWith('--control-url=')) {
      const next = readOptionValue(args, index, '--control-url');
      options.controlUrl = nonEmptyString(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--invite-url' || token.startsWith('--invite-url=')) {
      const next = readOptionValue(args, index, '--invite-url');
      options.inviteUrl = nonEmptyString(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--endpoint' || token.startsWith('--endpoint=')) {
      const next = readOptionValue(args, index, '--endpoint');
      options.endpoint = nonEmptyString(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--transport' || token === '--transport-kind'
      || token.startsWith('--transport=') || token.startsWith('--transport-kind=')) {
      const flag = token.startsWith('--transport-kind') ? '--transport-kind' : '--transport';
      const next = readOptionValue(args, index, flag);
      options.transportKind = normalizeProbeTransport(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--target' || token === '--bootstrap-target'
      || token.startsWith('--target=') || token.startsWith('--bootstrap-target=')) {
      const flag = token.startsWith('--bootstrap-target') ? '--bootstrap-target' : '--target';
      const next = readOptionValue(args, index, flag);
      options.bootstrapTarget = normalizeProbeBootstrapTarget(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--known-hosts' || token.startsWith('--known-hosts=')) {
      const next = readOptionValue(args, index, '--known-hosts');
      options.knownHostsFile = nonEmptyString(next.value);
      index += next.consumed;
      continue;
    }
    if (isFlag(token)) {
      const error = new Error(`unknown_option:${token}`);
      error.code = 'unknown_option';
      error.flag = token;
      throw error;
    }

    if (token.includes('@')) {
      options.sshTargets.push(parseSshTarget(token));
    } else {
      options.tcpTargets.push(parseTcpTarget(token, options.ports));
    }
    index += 1;
  }

  return options;
}

function inferBootstrapTarget(platform) {
  const value = nonEmptyString(platform).toLowerCase();
  if (value.includes('darwin')) return 'darwin';
  if (value.includes('linux')) return 'linux';
  if (value.includes('mingw') || value.includes('msys') || value.includes('cygwin') || value.includes('windows')) return 'win32';
  return '';
}

function buildBootstrapCommandArgs(bootstrapTarget, options) {
  if (!bootstrapTarget) return '';
  const args = ['aih', 'node', 'bootstrap', '--target', bootstrapTarget, '--script-only'];
  if (options.controlUrl) args.push('--control-url', options.controlUrl);
  if (options.inviteUrl) args.push('--invite-url', options.inviteUrl);
  if (options.repoUrl) args.push('--repo-url', options.repoUrl);
  if (options.repoDir) args.push('--repo-dir', options.repoDir);
  if (options.repoSubdir) args.push('--repo-subdir', options.repoSubdir);
  if (options.transportKind) args.push('--transport', options.transportKind);
  if (options.endpoint) args.push('--endpoint', options.endpoint);
  return args;
}

function buildBootstrapCommand(bootstrapTarget, options) {
  const args = buildBootstrapCommandArgs(bootstrapTarget, options);
  if (!args) return '';
  return formatCliCommand(args);
}

function joinNotes(...notes) {
  return notes.map(nonEmptyString).filter(Boolean).join(' ');
}

function withControlUrlWarning(text, options) {
  const warning = getLoopbackControlUrlWarning(options && options.controlUrl);
  const base = nonEmptyString(text);
  return warning ? joinNotes(base, warning) : base;
}

function buildSshRemoteRunCommand(result) {
  if (!result.bootstrapCommand || !['linux', 'darwin', 'win32'].includes(result.bootstrapTarget)) return '';
  const args = ['ssh'];
  if (result.port) args.push('-p', String(result.port));
  args.push(buildSshDestination(result), buildSshRemoteShellCommand(result.bootstrapTarget));
  return `${result.bootstrapCommand} | ${formatCliCommand(args)}`;
}

function buildSshInteractiveRemoteRunCommand(result, bootstrapTarget, options = {}) {
  if (!['linux', 'darwin', 'win32'].includes(bootstrapTarget)) return '';
  const bootstrapCommand = buildBootstrapCommand(bootstrapTarget, options);
  if (!bootstrapCommand) return '';
  const args = ['ssh'];
  if (result.port) args.push('-p', String(result.port));
  args.push(buildSshDestination(result), buildSshRemoteShellCommand(bootstrapTarget));
  return `${bootstrapCommand} | ${formatCliCommand(args)}`;
}

function buildSshAuthManualCommands(result, options = {}) {
  const target = normalizeProbeBootstrapTarget(result.bootstrapTarget || options.bootstrapTarget);
  const entries = [
    {
      target: 'win32',
      key: 'windows-interactive-ssh',
      label: 'Windows interactive SSH',
      command: buildSshInteractiveRemoteRunCommand(result, 'win32', options),
      note: 'Prompts for the SSH password; AI Home does not store it.'
    },
    {
      target: 'linux',
      key: 'linux-interactive-ssh',
      label: 'Linux interactive SSH',
      command: buildSshInteractiveRemoteRunCommand(result, 'linux', options),
      note: 'Use when the SSH target is Linux.'
    },
    {
      target: 'darwin',
      key: 'macos-interactive-ssh',
      label: 'macOS interactive SSH',
      command: buildSshInteractiveRemoteRunCommand(result, 'darwin', options),
      note: 'Use when the SSH target is macOS.'
    }
  ];
  return entries
    .filter((entry) => !target || entry.target === target)
    .map(({ target: _target, ...entry }) => entry)
    .filter((entry) => entry.command);
}

function buildSshDestination(result) {
  const user = nonEmptyString(result && result.user);
  const host = nonEmptyString(result && result.host);
  return user ? `${user}@${host}` : host;
}

function buildSshInteractiveCommand(result) {
  const destination = buildSshDestination(result);
  if (!destination) return '';
  const args = ['ssh'];
  if (result.port) args.push('-p', String(result.port));
  args.push(destination);
  return formatCliCommand(args);
}

function buildSshRemoteShellCommand(bootstrapTarget) {
  return bootstrapTarget === 'win32'
    ? 'powershell -NoProfile -ExecutionPolicy Bypass -Command -'
    : 'sh -s';
}

function buildSshRemoteRunExecution(result, options) {
  const bootstrapArgs = buildBootstrapCommandArgs(result.bootstrapTarget, options);
  if (!bootstrapArgs || !['linux', 'darwin', 'win32'].includes(result.bootstrapTarget)) return null;
  const sshArgs = [];
  if (result.port) sshArgs.push('-p', String(result.port));
  sshArgs.push(buildSshDestination(result), buildSshRemoteShellCommand(result.bootstrapTarget));
  return {
    kind: 'ssh-pipe',
    bootstrapTarget: result.bootstrapTarget,
    arch: result.arch,
    bootstrapCommand: bootstrapArgs[0],
    bootstrapArgs: bootstrapArgs.slice(1),
    sshCommand: 'ssh',
    sshArgs
  };
}

function attachExecutionDescriptor(target, value) {
  Object.defineProperty(target, 'remoteRunExecution', {
    value,
    enumerable: false
  });
  return target;
}

function buildSshBootstrapAction(result, options = {}) {
  if (result.status === 'auth-required') {
    return {
      channel: 'ssh-auth',
      generateScriptCommand: '',
      remoteRunCommand: '',
      targetAction: 'Open an interactive SSH session once, or configure SSH key auth, then run the generated bootstrap from that session.',
      targetCommand: buildSshInteractiveCommand(result),
      manualCommands: buildSshAuthManualCommands(result, options),
      note: withControlUrlWarning('AI Home does not store SSH passwords; password-based SSH is only a manual bootstrap channel.', options)
    };
  }
  if (result.status !== 'reachable') {
    return {
      channel: 'none',
      generateScriptCommand: '',
      remoteRunCommand: '',
      targetAction: 'SSH is not reachable from this machine.',
      targetCommand: '',
      note: ''
    };
  }
  if (!result.bootstrapTarget) {
    return {
      channel: 'ssh',
      generateScriptCommand: '',
      remoteRunCommand: '',
      targetAction: 'SSH is reachable, but the target OS could not be mapped to a supported bootstrap script.',
      targetCommand: '',
      note: ''
    };
  }
  return attachExecutionDescriptor({
    channel: 'ssh',
    generateScriptCommand: result.bootstrapCommand,
    remoteRunCommand: buildSshRemoteRunCommand(result),
    targetAction: result.bootstrapTarget === 'win32'
      ? 'Run the generated PowerShell bootstrap on the SSH target.'
      : 'Run the generated shell bootstrap on the SSH target.',
    targetCommand: result.bootstrapTarget === 'win32'
      ? 'powershell -NoProfile -ExecutionPolicy Bypass -Command -'
      : 'sh ./aih-node-bootstrap.sh',
    note: withControlUrlWarning(
      result.bootstrapTarget === 'win32'
        ? 'If winget or UAC prompts are required, open an interactive SSH session or the target local console and run the generated PowerShell script there.'
        : 'If sudo prompts are required, open an interactive SSH session and run the generated script there.',
      options
    )
  }, buildSshRemoteRunExecution(result, options));
}

function buildSshRecommendation(result, options) {
  if (result.status === 'auth-required') {
    if (result.bootstrapTarget) {
      return withControlUrlWarning('SSH is reachable but requires interactive authentication. Use the generated platform-specific SSH bootstrap command once, or configure key auth and re-run probe/apply.', options);
    }
    return withControlUrlWarning('SSH is reachable but requires interactive authentication. Use the copied ssh command once, run a Windows/Linux/macOS bootstrap there, or configure key auth and re-run probe/apply.', options);
  }
  if (result.status !== 'reachable') {
    return 'SSH is not reachable; enable SSH, use the target local console, or fall back to relay bootstrap.';
  }
  const command = result.bootstrapCommand;
  const missing = ['node', 'npm', 'git', 'aih']
    .filter((name) => result.commands && result.commands[name] === false);
  if (missing.length || result.repo.present === false) {
    const recommendation = result.bootstrapAction && result.bootstrapAction.remoteRunCommand
      ? `Run bootstrap over SSH: ${result.bootstrapAction.remoteRunCommand}`
      : command || 'Run the generated bootstrap script on this target after confirming its OS.';
    return withControlUrlWarning(recommendation, options);
  }
  if (command && options.inviteUrl) {
    return withControlUrlWarning(`AI Home prerequisites look present; generate the final join script with: ${command}`, options);
  }
  return withControlUrlWarning('AI Home prerequisites look present; run aih node doctor, then join with the generated invite.', options);
}

function resolveKnownHostsFile(target, options) {
  if (options.knownHostsFile) return options.knownHostsFile;
  return `/tmp/aih-node-probe-known-hosts-${sanitizeFileSegment(target.host)}`;
}

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function encodePowerShellCommand(script) {
  return Buffer.from(String(script || ''), 'utf16le').toString('base64');
}

function resolveRepoPathLabel(options = {}, bootstrapTarget = '') {
  const repoDir = nonEmptyString(options.repoDir);
  if (repoDir) return repoDir;
  const repoSubdir = normalizeRepoSubdir(options.repoSubdir);
  if (!repoSubdir) return '';
  return bootstrapTarget === 'win32'
    ? `~\\${toWindowsRepoSubdir(repoSubdir)}`
    : `~/${getDefaultRepoSubdir(repoSubdir)}`;
}

function buildRemoteProbeCommand(repoDir, repoSubdir) {
  const subdir = normalizeRepoSubdir(repoSubdir);
  const repo = nonEmptyString(repoDir)
    ? `AIH_PROBE_REPO=${shellQuote(repoDir)}`
    : (subdir ? `AIH_PROBE_REPO="$HOME/${getDefaultRepoSubdir(subdir)}"` : 'AIH_PROBE_REPO=');
  return [
    'printf "platform=%s\\n" "$(uname -s 2>/dev/null || echo unknown)"',
    'printf "arch=%s\\n" "$(uname -m 2>/dev/null || echo unknown)"',
    'for c in node npm git aih; do if command -v "$c" >/dev/null 2>&1; then printf "%s=present\\n" "$c"; else printf "%s=missing\\n" "$c"; fi; done',
    `${repo}; if [ -n "$AIH_PROBE_REPO" ] && [ -d "$AIH_PROBE_REPO" ]; then printf "repo=present\\n"; else printf "repo=missing\\n"; fi`
  ].join('; ');
}

function buildWindowsRemoteProbeCommand(repoDir, repoSubdir) {
  const repo = nonEmptyString(repoDir);
  const subdir = normalizeRepoSubdir(repoSubdir);
  const repoExpression = repo
    ? quotePowerShell(repo)
    : (subdir ? `Join-Path $env:USERPROFILE ${quotePowerShell(toWindowsRepoSubdir(subdir))}` : "''");
  const script = `$ErrorActionPreference = 'SilentlyContinue'
Write-Output 'platform=Windows'
Write-Output ('arch=' + [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITECTURE'))
foreach ($CommandName in @('node', 'npm', 'git', 'aih')) {
  if (Get-Command $CommandName -ErrorAction SilentlyContinue) {
    Write-Output ($CommandName + '=present')
  } else {
    Write-Output ($CommandName + '=missing')
  }
}
$RepoDir = ${repoExpression}
if ($RepoDir -and (Test-Path (Join-Path $RepoDir '.git'))) {
  Write-Output 'repo=present'
} else {
  Write-Output 'repo=missing'
}
`;
  return `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShellCommand(script)}`;
}

function buildSshArgs(target, options, remoteCommand) {
  const timeoutSeconds = Math.max(1, Math.ceil(options.timeoutMs / 1000));
  const destination = target.user ? `${target.user}@${target.host}` : target.host;
  const args = [
    '-o', 'BatchMode=yes',
    '-o', `ConnectTimeout=${timeoutSeconds}`,
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `UserKnownHostsFile=${resolveKnownHostsFile(target, options)}`
  ];
  if (target.port) args.push('-p', String(target.port));
  args.push(destination, remoteCommand || buildRemoteProbeCommand(options.repoDir, options.repoSubdir));
  return args;
}

function detectSshAuthRequired(processResult) {
  const source = processResult && typeof processResult === 'object' ? processResult : {};
  if (source.timedOut) return false;
  const stderr = nonEmptyString(source.stderr).toLowerCase();
  if (!stderr.includes('permission denied')) return false;
  return stderr.includes('password') || stderr.includes('keyboard-interactive') || stderr.includes('publickey');
}

function runProcess(command, args, options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let finished = false;
    const child = spawnImpl(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const done = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        status: Number(result.status || 0),
        signal: result.signal || '',
        stdout,
        stderr,
        timedOut: Boolean(result.timedOut)
      });
    };
    const timer = setTimeout(() => {
      try {
        if (child && typeof child.kill === 'function') child.kill('SIGTERM');
      } catch (_error) {}
      done({ status: 124, timedOut: true });
    }, options.timeoutMs);

    if (child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    }
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    }
    if (typeof child.on === 'function') {
      child.on('error', (error) => {
        stderr += String((error && error.message) || error || '');
        done({ status: 1 });
      });
      child.on('close', (code, signal) => done({ status: code === null ? 1 : Number(code), signal }));
    } else {
      done({ status: 1 });
    }
  });
}

function parseProbeFacts(stdout) {
  const facts = {};
  String(stdout || '').split(/\r?\n/).forEach((line) => {
    const index = line.indexOf('=');
    if (index <= 0) return;
    facts[line.slice(0, index)] = line.slice(index + 1);
  });
  return facts;
}

function normalizeSshProbeResult(target, raw, options) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const commands = source.commands && typeof source.commands === 'object' ? source.commands : {};
  const repo = source.repo && typeof source.repo === 'object' ? source.repo : {};
  const detectedBootstrapTarget = inferBootstrapTarget(nonEmptyString(source.platform));
  const bootstrapTarget = detectedBootstrapTarget || options.bootstrapTarget || '';
  const result = {
    kind: 'ssh',
    target: target.label,
    host: target.host,
    user: target.user,
    port: target.port,
    status: source.status === 'reachable' || source.status === 'auth-required'
      ? source.status
      : 'unreachable',
    platform: nonEmptyString(source.platform),
    arch: nonEmptyString(source.arch),
    commands: {
      node: commands.node === true,
      npm: commands.npm === true,
      git: commands.git === true,
      aih: commands.aih === true
    },
    repo: {
      checked: Boolean(options.repoDir || options.repoSubdir),
      present: options.repoDir || options.repoSubdir ? repo.present === true : null,
      path: resolveRepoPathLabel(options, bootstrapTarget)
    },
    stderr: nonEmptyString(source.stderr).slice(0, 1000),
    timedOut: Boolean(source.timedOut),
    recommendation: ''
  };
  result.bootstrapTarget = bootstrapTarget;
  result.bootstrapCommand = buildBootstrapCommand(result.bootstrapTarget, options);
  result.bootstrapAction = buildSshBootstrapAction(result, options);
  result.recommendation = buildSshRecommendation(result, options);
  return result;
}

async function probeSshTarget(target, options, deps = {}) {
  if (typeof deps.sshProbe === 'function') {
    return normalizeSshProbeResult(target, await deps.sshProbe(target, options), options);
  }
  let processResult = await runProcess('ssh', buildSshArgs(target, options, buildRemoteProbeCommand(options.repoDir, options.repoSubdir)), {
    timeoutMs: options.timeoutMs,
    spawnImpl: deps.spawnImpl || spawn
  });
  let facts = parseProbeFacts(processResult.stdout);
  if (processResult.status !== 0 && !processResult.timedOut) {
    const windowsResult = await runProcess('ssh', buildSshArgs(target, options, buildWindowsRemoteProbeCommand(options.repoDir, options.repoSubdir)), {
      timeoutMs: options.timeoutMs,
      spawnImpl: deps.spawnImpl || spawn
    });
    const windowsFacts = parseProbeFacts(windowsResult.stdout);
    if (windowsResult.status === 0 || windowsFacts.platform) {
      processResult = windowsResult;
      facts = windowsFacts;
    }
  }
  const authRequired = processResult.status !== 0 && detectSshAuthRequired(processResult);
  return normalizeSshProbeResult(target, {
    status: processResult.status === 0 ? 'reachable' : (authRequired ? 'auth-required' : 'unreachable'),
    platform: facts.platform || '',
    arch: facts.arch || '',
    commands: {
      node: facts.node === 'present',
      npm: facts.npm === 'present',
      git: facts.git === 'present',
      aih: facts.aih === 'present'
    },
    repo: { present: facts.repo === 'present' },
    stderr: processResult.stderr,
    timedOut: processResult.timedOut
  }, options);
}

function tcpConnect(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (open, error = '') => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ port, open, error });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false, 'timeout'));
    socket.once('error', (error) => done(false, String((error && error.code) || (error && error.message) || error || 'connect_failed')));
    socket.connect(port, host);
  });
}

function resolveTcpAccessMode(openPorts) {
  if (openPorts.includes(5985) || openPorts.includes(5986)) return 'winrm';
  if (openPorts.includes(3389) || openPorts.includes(445)) return 'local-manual';
  if (openPorts.includes(22)) return 'ssh';
  return 'unreachable';
}

function buildTcpBootstrapTarget(result) {
  return result.accessMode === 'winrm' || result.accessMode === 'local-manual' ? 'win32' : '';
}

function buildTcpBootstrapAction(result, options = {}) {
  if (result.accessMode === 'ssh') {
    return {
      channel: 'ssh',
      generateScriptCommand: '',
      targetAction: 'Re-run this probe with --ssh user@host for OS/package diagnostics before bootstrap.',
      targetCommand: '',
      note: ''
    };
  }
  if (result.accessMode === 'winrm') {
    return {
      channel: 'winrm',
      generateScriptCommand: result.bootstrapCommand,
      targetAction: 'Run the generated PowerShell script on the Windows target through your WinRM automation.',
      targetCommand: 'powershell -ExecutionPolicy Bypass -File .\\aih-node-bootstrap.ps1',
      note: withControlUrlWarning('AI Home only reports WinRM reachability here; it does not execute WinRM commands from the WebUI.', options)
    };
  }
  if (result.accessMode === 'local-manual') {
    return {
      channel: 'local-manual',
      generateScriptCommand: result.bootstrapCommand,
      targetAction: `Copy and run the generated PowerShell script on the Windows target through ${MANUAL_BOOTSTRAP_CHANNEL}.`,
      targetCommand: 'powershell -ExecutionPolicy Bypass -File .\\aih-node-bootstrap.ps1',
      note: withControlUrlWarning('Local manual bootstrap only; AIH Relay remains the managed data-plane.', options)
    };
  }
  return {
    channel: 'none',
    generateScriptCommand: '',
    targetAction: 'No supported bootstrap access was detected from this machine.',
    targetCommand: '',
    note: ''
  };
}

function buildTcpRecommendation(result, options = {}) {
  if (result.accessMode === 'ssh') return 'SSH is open; use --ssh for full readonly bootstrap diagnostics.';
  if (result.accessMode === 'winrm') {
    const recommendation = result.bootstrapCommand
      ? `WinRM is open; generate the PowerShell bootstrap with: ${result.bootstrapCommand}, then run it through your WinRM automation.`
      : 'WinRM is open; run the PowerShell bootstrap through WinRM or enable OpenSSH for SSH bootstrap.';
    return withControlUrlWarning(recommendation, options);
  }
  if (result.accessMode === 'local-manual') {
    const recommendation = result.bootstrapCommand
      ? `Generate the PowerShell bootstrap with: ${result.bootstrapCommand}; then run the generated script on the Windows target through ${MANUAL_BOOTSTRAP_CHANNEL}.`
      : `Use ${MANUAL_BOOTSTRAP_CHANNEL} to run a script-only Windows bootstrap.`;
    return withControlUrlWarning(recommendation, options);
  }
  return 'No bootstrap access port is reachable from this machine.';
}

function normalizeTcpProbeResult(target, raw, options = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const ports = Array.isArray(source.ports) ? source.ports : [];
  const normalizedPorts = ports.map((item) => ({
    port: Number(item && item.port) || 0,
    open: Boolean(item && item.open),
    error: nonEmptyString(item && item.error)
  })).filter((item) => item.port > 0);
  const openPorts = normalizedPorts.filter((item) => item.open).map((item) => item.port);
  const result = {
    kind: 'tcp',
    target: target.label,
    host: target.host,
    ports: normalizedPorts,
    openPorts,
    accessMode: resolveTcpAccessMode(openPorts),
    recommendation: ''
  };
  result.bootstrapTarget = buildTcpBootstrapTarget(result);
  result.bootstrapCommand = buildBootstrapCommand(result.bootstrapTarget, options);
  result.bootstrapAction = buildTcpBootstrapAction(result, options);
  result.recommendation = buildTcpRecommendation(result, options);
  return result;
}

async function probeTcpTarget(target, options, deps = {}) {
  if (typeof deps.tcpProbe === 'function') {
    return normalizeTcpProbeResult(target, await deps.tcpProbe(target, options), options);
  }
  const ports = await Promise.all(target.ports.map((port) => tcpConnect(target.host, port, options.timeoutMs)));
  return normalizeTcpProbeResult(target, { ports }, options);
}

function classifyHttpProbeStatus(httpStatus, error, timedOut) {
  if (timedOut) return 'timeout';
  if (error) return 'error';
  if (httpStatus >= 200 && httpStatus < 300) return 'reachable';
  if (httpStatus > 0) return 'http-error';
  return 'unreachable';
}

function buildHttpRecommendation(result) {
  if (result.status === 'reachable') return 'HTTP ingress is client-ready for this health endpoint.';
  if (result.status === 'timeout') {
    return 'HTTP timed out. If localhost health passes, check cloud security group, host firewall, reverse proxy, or use relay/overlay.';
  }
  if (result.status === 'http-error') {
    return `HTTP connected but returned ${result.httpStatus}. Check path, auth, reverse proxy, or server route.`;
  }
  return 'HTTP ingress is not reachable from this machine; use relay/overlay or expose a reachable endpoint before selecting direct transport.';
}

function normalizeHttpProbeResult(target, raw, options = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const httpStatus = Number(source.httpStatus || source.statusCode || source.status || 0) || 0;
  const timedOut = Boolean(source.timedOut);
  const error = nonEmptyString(source.error);
  const result = {
    kind: 'http',
    target: target.label,
    url: target.url,
    status: classifyHttpProbeStatus(httpStatus, error, timedOut),
    httpStatus,
    ok: httpStatus >= 200 && httpStatus < 300 && !timedOut && !error,
    latencyMs: Number.isFinite(Number(source.latencyMs)) ? Math.max(0, Math.round(Number(source.latencyMs))) : null,
    error,
    timedOut,
    recommendation: ''
  };
  result.recommendation = nonEmptyString(source.recommendation) || buildHttpRecommendation(result, options);
  return result;
}

function timeoutSignal(timeoutMs) {
  if (typeof AbortController !== 'function') return { signal: undefined, cancel: () => {} };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer)
  };
}

async function probeHttpTarget(target, options, deps = {}) {
  if (typeof deps.httpProbe === 'function') {
    return normalizeHttpProbeResult(target, await deps.httpProbe(target, options), options);
  }
  const fetchImpl = deps.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (typeof fetchImpl !== 'function') {
    return normalizeHttpProbeResult(target, { error: 'fetch_unavailable' }, options);
  }
  const startedAt = Date.now();
  const timeout = timeoutSignal(options.timeoutMs);
  try {
    const response = await fetchImpl(target.url, {
      method: 'GET',
      signal: timeout.signal,
      headers: { accept: 'application/json,text/plain,*/*' }
    });
    return normalizeHttpProbeResult(target, {
      httpStatus: Number(response && response.status) || 0,
      latencyMs: Date.now() - startedAt
    }, options);
  } catch (error) {
    const timedOut = error && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
    return normalizeHttpProbeResult(target, {
      error: timedOut ? 'timeout' : nonEmptyString((error && (error.code || error.message)) || error || 'fetch_failed'),
      timedOut,
      latencyMs: Date.now() - startedAt
    }, options);
  } finally {
    timeout.cancel();
  }
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(items.length, Math.max(1, concurrency));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }));
  return results;
}

function summarizeProbe(results) {
  const reachableSsh = results.filter((item) => item.kind === 'ssh' && item.status === 'reachable').length;
  const authRequiredSsh = results.filter((item) => item.kind === 'ssh' && item.status === 'auth-required').length;
  const localManual = results.filter((item) => item.kind === 'tcp' && item.accessMode === 'local-manual').length;
  const winrm = results.filter((item) => item.kind === 'tcp' && item.accessMode === 'winrm').length;
  const sshPort = results.filter((item) => item.kind === 'tcp' && item.accessMode === 'ssh').length;
  const unreachableSsh = results.filter((item) => item.kind === 'ssh' && item.status !== 'reachable' && item.status !== 'auth-required').length;
  const unreachableTcp = results.filter((item) => item.kind === 'tcp' && item.accessMode === 'unreachable').length;
  const httpReady = results.filter((item) => item.kind === 'http' && item.ok).length;
  const httpFailed = results.filter((item) => item.kind === 'http' && !item.ok).length;
  return {
    total: results.length,
    reachableSsh,
    authRequiredSsh,
    sshPort,
    winrm,
    localManual,
    httpReady,
    httpFailed,
    unreachable: unreachableSsh + unreachableTcp
  };
}

function getProbeResultKey(result) {
  return `${result && result.kind || 'unknown'}:${result && result.target || ''}`;
}

function normalizeProbeHostKey(value) {
  return nonEmptyString(value).toLowerCase();
}

function buildSshProbeHostSet(results = []) {
  return (Array.isArray(results) ? results : []).reduce((hosts, result) => {
    if (result && result.kind === 'ssh') {
      const host = normalizeProbeHostKey(result.host);
      if (host) hosts.add(host);
    }
    return hosts;
  }, new Set());
}

function isRedundantTcpSshPortStep(result, sshProbeHosts) {
  if (!result || result.kind !== 'tcp' || result.accessMode !== 'ssh') return false;
  const host = normalizeProbeHostKey(result.host);
  return Boolean(host && sshProbeHosts && sshProbeHosts.has(host));
}

function buildExecutionStep(result, priority, status, title, summary, command = '') {
  const action = result && result.bootstrapAction && typeof result.bootstrapAction === 'object'
    ? result.bootstrapAction
    : {};
  const step = {
    order: 0,
    priority,
    status,
    resultKey: getProbeResultKey(result),
    kind: result && result.kind || '',
    target: result && result.target || '',
    channel: action.channel || 'none',
    title,
    summary,
    command,
    manualCommands: normalizeManualCommands(action.manualCommands),
    note: action.note || ''
  };
  Object.defineProperty(step, 'execution', {
    value: action.remoteRunExecution || null,
    enumerable: false
  });
  return step;
}

function cloneExecutionStep(step, order) {
  const cloned = { ...step, order };
  cloned.manualCommands = normalizeManualCommands(step && step.manualCommands);
  Object.defineProperty(cloned, 'execution', {
    value: step && step.execution && typeof step.execution === 'object' ? step.execution : null,
    enumerable: false
  });
  return cloned;
}

function buildSshExecutionStep(result) {
  const action = result.bootstrapAction || {};
  if (result.status === 'auth-required') {
    return buildExecutionStep(
      result,
      EXECUTION_PRIORITIES.sshAuthRequired,
      'needs-input',
      'SSH authentication required',
      'Use interactive SSH once or configure key auth; AI Home will not store SSH passwords.',
      action.targetCommand || ''
    );
  }
  if (result.status !== 'reachable') {
    return buildExecutionStep(
      result,
      EXECUTION_PRIORITIES.unreachable,
      'blocked',
      'SSH unreachable',
      'Enable SSH, use TCP probing, or fall back to relay bootstrap.'
    );
  }
  if (action.remoteRunCommand) {
    return buildExecutionStep(
      result,
      EXECUTION_PRIORITIES.sshRemoteRun,
      'ready',
      'SSH remote bootstrap',
      'Run the bootstrap from this machine through SSH.',
      action.remoteRunCommand
    );
  }
  return buildExecutionStep(
    result,
    EXECUTION_PRIORITIES.generatedScript,
    result.bootstrapCommand ? 'manual' : 'blocked',
    result.bootstrapTarget === 'win32' ? 'Windows PowerShell bootstrap' : 'Generate bootstrap script',
    action.targetAction || result.recommendation || 'Generate the target bootstrap script.',
    action.generateScriptCommand || result.bootstrapCommand || ''
  );
}

function buildTcpExecutionStep(result) {
  const action = result.bootstrapAction || {};
  if (result.accessMode === 'winrm') {
    return buildExecutionStep(
      result,
      EXECUTION_PRIORITIES.winrm,
      'manual',
      'WinRM PowerShell bootstrap',
      'Generate the PowerShell bootstrap, then run it through your WinRM automation.',
      action.generateScriptCommand || result.bootstrapCommand || ''
    );
  }
  if (result.accessMode === 'local-manual') {
    return buildExecutionStep(
      result,
      EXECUTION_PRIORITIES.localManual,
      'manual',
      'Manual PowerShell bootstrap',
      `Run the generated PowerShell bootstrap through ${MANUAL_BOOTSTRAP_CHANNEL}.`,
      action.generateScriptCommand || result.bootstrapCommand || ''
    );
  }
  if (result.accessMode === 'ssh') {
    return buildExecutionStep(
      result,
      EXECUTION_PRIORITIES.sshPort,
      'needs-input',
      'SSH port detected',
      'Re-run the probe with --ssh user@host for OS and package diagnostics before bootstrap.'
    );
  }
  return buildExecutionStep(
    result,
    EXECUTION_PRIORITIES.unreachable,
    'blocked',
    'No bootstrap access detected',
    'No SSH, WinRM, or Windows local-console bootstrap signal was detected from this machine.'
  );
}

function buildProbeExecutionPlan(results = []) {
  const source = Array.isArray(results) ? results : [];
  const sshProbeHosts = buildSshProbeHostSet(source);
  return source
    .filter((result) => result && (result.kind === 'ssh' || result.kind === 'tcp'))
    .filter((result) => !isRedundantTcpSshPortStep(result, sshProbeHosts))
    .map((result) => (result && result.kind === 'ssh' ? buildSshExecutionStep(result) : buildTcpExecutionStep(result)))
    .sort((left, right) => (
      left.priority - right.priority
      || String(left.target).localeCompare(String(right.target))
      || String(left.resultKey).localeCompare(String(right.resultKey))
    ))
    .map((step, index) => cloneExecutionStep(step, index + 1));
}

function buildProbeWarnings(options, tasks) {
  const warnings = [];
  if (!tasks.length) warnings.push('pass --ssh user@host, --tcp host, or --http URL to probe remote access');
  const controlUrlWarning = getLoopbackControlUrlWarning(options && options.controlUrl);
  if (controlUrlWarning) warnings.push(controlUrlWarning);
  return warnings;
}

async function runNodeBootstrapProbe(rawArgs = [], deps = {}) {
  const options = parseNodeBootstrapProbeArgs(rawArgs);
  const tasks = options.sshTargets
    .map((target) => ({ type: 'ssh', target }))
    .concat(options.tcpTargets.map((target) => ({ type: 'tcp', target })))
    .concat(options.httpTargets.map((target) => ({ type: 'http', target })));
  const results = await mapWithConcurrency(tasks, options.concurrency, (task) => {
    if (task.type === 'ssh') return probeSshTarget(task.target, options, deps);
    if (task.type === 'tcp') return probeTcpTarget(task.target, options, deps);
    return probeHttpTarget(task.target, options, deps);
  });
  return {
    ok: true,
    json: Boolean(options.json),
    report: {
      ok: true,
      concurrency: options.concurrency,
      timeoutMs: options.timeoutMs,
      repoDir: options.repoDir,
      results,
      summary: summarizeProbe(results),
      executionPlan: buildProbeExecutionPlan(results),
      warnings: buildProbeWarnings(options, tasks)
    }
  };
}

function formatPorts(ports, open) {
  const values = ports.filter((item) => item.open === open).map((item) => item.port);
  return values.length ? values.join(', ') : 'none';
}

function formatCommandMap(commands) {
  return ['node', 'npm', 'git', 'aih']
    .map((name) => `${name}:${commands && commands[name] ? 'ok' : 'missing'}`)
    .join(', ');
}

function formatProbeSummary(summary) {
  if (!summary || typeof summary !== 'object') return '';
  return [
    `ssh:${Number(summary.reachableSsh || 0)}`,
    `ssh-auth:${Number(summary.authRequiredSsh || 0)}`,
    `ssh-port:${Number(summary.sshPort || 0)}`,
    `winrm:${Number(summary.winrm || 0)}`,
    `local-manual:${Number(summary.localManual || 0)}`,
    `http-ready:${Number(summary.httpReady || 0)}`,
    `http-failed:${Number(summary.httpFailed || 0)}`,
    `unreachable:${Number(summary.unreachable || 0)}`
  ].join(', ');
}

function appendExecutionPlan(lines, executionPlan) {
  if (!Array.isArray(executionPlan) || executionPlan.length === 0) return;
  lines.push('[aih] execution plan:');
  executionPlan.forEach((step) => {
    lines.push(`  ${step.order}. ${step.title}: ${step.target}`);
    lines.push(`     status: ${step.status}, channel: ${step.channel}`);
    if (step.summary) lines.push(`     next: ${step.summary}`);
    if (step.command) lines.push(`     command: ${step.command}`);
    appendManualCommands(lines, step.manualCommands, '     ');
    if (step.note) lines.push(`     note: ${step.note}`);
  });
}

function normalizeManualCommands(manualCommands) {
  return (Array.isArray(manualCommands) ? manualCommands : [])
    .map((item) => ({
      key: nonEmptyString(item && item.key),
      label: nonEmptyString(item && item.label),
      command: nonEmptyString(item && item.command),
      note: nonEmptyString(item && item.note)
    }))
    .filter((item) => item.command);
}

function appendManualCommands(lines, manualCommands, indent) {
  const commands = normalizeManualCommands(manualCommands);
  if (!commands.length) return;
  lines.push(`${indent}manual commands:`);
  commands.forEach((item) => {
    lines.push(`${indent}  - ${item.label || item.key || 'command'}: ${item.command}`);
    if (item.note) lines.push(`${indent}    note: ${item.note}`);
  });
}

function appendBootstrapAction(lines, action) {
  if (!action || typeof action !== 'object') return;
  if (action.channel) lines.push(`    channel: ${action.channel}`);
  if (action.generateScriptCommand) lines.push(`    generate script: ${action.generateScriptCommand}`);
  if (action.remoteRunCommand) lines.push(`    run over ssh: ${action.remoteRunCommand}`);
  if (action.targetAction) lines.push(`    run on target: ${action.targetAction}`);
  if (action.targetCommand) lines.push(`    target command: ${action.targetCommand}`);
  appendManualCommands(lines, action.manualCommands, '    ');
  if (action.note) lines.push(`    note: ${action.note}`);
}

function formatNodeBootstrapProbeReport(report) {
  const source = report && typeof report === 'object' ? report : {};
  const results = Array.isArray(source.results) ? source.results : [];
  const summary = formatProbeSummary(source.summary);
  const lines = [
    '[aih] node bootstrap probe',
    `[aih] targets: ${results.length}`,
    `[aih] concurrency: ${Number(source.concurrency || 0) || DEFAULT_CONCURRENCY}`,
    `[aih] timeout: ${Number(source.timeoutMs || 0) || DEFAULT_TIMEOUT_MS}ms`
  ];
  if (summary) lines.push(`[aih] summary: ${summary}`);
  if (source.repoDir) lines.push(`[aih] repo dir check: ${source.repoDir}`);
  appendExecutionPlan(lines, source.executionPlan);

  if (Array.isArray(source.warnings) && source.warnings.length) {
    lines.push('[aih] warnings:');
    source.warnings.forEach((warning) => lines.push(`  - ${warning}`));
  }

  results.forEach((result) => {
    if (result.kind === 'ssh') {
      const label = result.target;
      lines.push(`  - ssh ${label}: ${result.status}`);
      if (result.platform || result.arch) lines.push(`    os: ${result.platform || 'unknown'} ${result.arch || ''}`.trimEnd());
      if (result.status === 'reachable') lines.push(`    commands: ${formatCommandMap(result.commands)}`);
      if (result.repo && result.repo.checked) lines.push(`    repo: ${result.repo.present ? 'present' : 'missing'} (${result.repo.path})`);
      if (result.bootstrapCommand) lines.push(`    bootstrap: ${result.bootstrapCommand}`);
      appendBootstrapAction(lines, result.bootstrapAction);
      if (result.stderr && result.status !== 'reachable') lines.push(`    error: ${result.stderr}`);
      lines.push(`    next: ${result.recommendation}`);
      return;
    }
    if (result.kind === 'http') {
      lines.push(`  - http ${result.target}: ${result.status}`);
      lines.push(`    url: ${result.url}`);
      lines.push(`    http status: ${result.httpStatus || 0}`);
      if (result.latencyMs !== null && result.latencyMs !== undefined) lines.push(`    latency: ${result.latencyMs}ms`);
      if (result.error) lines.push(`    error: ${result.error}`);
      lines.push(`    next: ${result.recommendation}`);
      return;
    }
    lines.push(`  - tcp ${result.target}: ${result.accessMode}`);
    lines.push(`    open ports: ${formatPorts(result.ports, true)}`);
    lines.push(`    closed ports: ${formatPorts(result.ports, false)}`);
    if (result.bootstrapCommand) lines.push(`    bootstrap: ${result.bootstrapCommand}`);
    appendBootstrapAction(lines, result.bootstrapAction);
    lines.push(`    next: ${result.recommendation}`);
  });
  return lines.join('\n');
}

module.exports = {
  DEFAULT_TCP_PORTS,
  buildNodeBootstrapProbeArgs,
  buildNodeBootstrapProbeOptionArgs,
  buildNodeBootstrapProbeCommand,
  parseNodeBootstrapProbeArgs,
  inferBootstrapTarget,
  buildBootstrapCommandArgs,
  buildRemoteProbeCommand,
  buildWindowsRemoteProbeCommand,
  buildProbeExecutionPlan,
  formatNodeBootstrapProbeReport,
  runNodeBootstrapProbe,
  parseSshTarget,
  probeSshTarget,
  probeHttpTarget
};
