#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const {
  buildSshArgs
} = require('./fabric-real-vps-deploy');

const DEFAULT_ENDPOINT = 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527';
const DEFAULT_SSH_TARGET = 'ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com';
const DEFAULT_SSH_KEY = '~/.ssh/aws.pem';

function showHelp() {
  console.log(`AIH Fabric multipath diagnosis

Usage:
  node scripts/fabric-multipath-diagnosis.js [options]

Options:
  --endpoint <url>   AIH endpoint, default ${DEFAULT_ENDPOINT}.
  --ssh <user@host>  SSH target, default ${DEFAULT_SSH_TARGET}.
  --ssh-key <pem>    SSH key, default ${DEFAULT_SSH_KEY}.
  --json             Print JSON only.
  -h, --help         Show this help.

This diagnostic is read-only. It checks local/AWS MPTCP capability,
OpenMPTCPRouter markers, and the current default-port AIH listener. It does
not install packages, change kernel settings, open ports, or start servers.
`);
}

function normalizeText(value, maxLength = 4096) {
  const text = String(value == null ? '' : value).trim();
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function resolveLocalPath(value) {
  return path.resolve(String(value || '').replace(/^~(?=\/|$)/, process.env.HOME || ''));
}

function parseArgs(argv = []) {
  const options = {
    endpoint: DEFAULT_ENDPOINT,
    sshTarget: DEFAULT_SSH_TARGET,
    sshKey: resolveLocalPath(DEFAULT_SSH_KEY),
    json: false,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || '');
    const next = argv[index + 1];
    if (arg === '-h' || arg === '--help') {
      options.help = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--endpoint') {
      if (!next) throw new Error('--endpoint requires a value');
      options.endpoint = normalizeEndpoint(next);
      index += 1;
      continue;
    }
    if (arg === '--ssh') {
      if (!next) throw new Error('--ssh requires a value');
      options.sshTarget = normalizeText(next, 512);
      index += 1;
      continue;
    }
    if (arg === '--ssh-key') {
      if (!next) throw new Error('--ssh-key requires a value');
      options.sshKey = resolveLocalPath(next);
      index += 1;
      continue;
    }
    throw new Error(`unknown option: ${arg}`);
  }

  options.endpoint = normalizeEndpoint(options.endpoint);
  if (!options.endpoint) throw new Error('--endpoint must be http(s) URL');
  if (!options.sshTarget) throw new Error('--ssh is required');
  return options;
}

function normalizeEndpoint(value) {
  const raw = normalizeText(value, 2048).replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch (_error) {
    return '';
  }
}

function safeCommandResult(result, startedAt) {
  const status = typeof result.status === 'number' ? result.status : 1;
  const stdout = normalizeText(result.stdout, 12000);
  const stderr = normalizeText(result.stderr, 12000);
  return {
    status,
    ok: status === 0,
    durationMs: Math.max(0, Date.now() - startedAt),
    stdout,
    stderr
  };
}

function runShell(command, options = {}) {
  const startedAt = Date.now();
  const result = spawnSync('sh', ['-lc', command], {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    encoding: 'utf8',
    timeout: options.timeoutMs || 15000,
    maxBuffer: 1024 * 1024
  });
  return {
    command,
    ...safeCommandResult(result, startedAt)
  };
}

function runSsh(options, command) {
  const startedAt = Date.now();
  const result = spawnSync('ssh', [
    ...buildSshArgs(options),
    options.sshTarget,
    command
  ], {
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 1024 * 1024
  });
  return {
    command,
    ...safeCommandResult(result, startedAt)
  };
}

function parseKeyValueLines(stdout) {
  return String(stdout || '').split(/\r?\n/).reduce((items, line) => {
    const match = String(line || '').trim().match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
    if (!match) return items;
    items[match[1]] = match[2];
    return items;
  }, {});
}

function buildLocalMptcpCommand() {
  return [
    'set +e',
    'printf "uname=%s\\n" "$(uname -a 2>/dev/null)"',
    'printf "platform=%s\\n" "$(uname -s 2>/dev/null)"',
    'printf "arch=%s\\n" "$(uname -m 2>/dev/null)"',
    'for key in net.mptcp.enabled net.mptcp.mptcp_enabled net.inet.mptcp.enabled; do sysctl "$key" 2>/dev/null; done',
    "python3 - <<'PY' 2>/dev/null",
    'import socket',
    'print("python_has_IPPROTO_MPTCP=%s" % hasattr(socket, "IPPROTO_MPTCP"))',
    'print("python_IPPROTO_MPTCP=%s" % getattr(socket, "IPPROTO_MPTCP", ""))',
    'PY',
    'command -v omr-tracker >/dev/null 2>&1 && echo openmptcprouter_marker=omr-tracker || true',
    'test -d /etc/openmptcprouter && echo openmptcprouter_marker=/etc/openmptcprouter || true'
  ].join('\n');
}

function buildRemoteMptcpCommand() {
  return [
    'set +e',
    'printf "uname=%s\\n" "$(uname -a 2>/dev/null)"',
    'printf "platform=%s\\n" "$(uname -s 2>/dev/null)"',
    'printf "arch=%s\\n" "$(uname -m 2>/dev/null)"',
    'test -r /proc/sys/net/mptcp/enabled && printf "proc_net_mptcp_enabled=%s\\n" "$(cat /proc/sys/net/mptcp/enabled)"',
    'sysctl net.mptcp.enabled 2>/dev/null',
    'ip mptcp endpoint show 2>/dev/null | sed "s/^/ip_mptcp_endpoint=/"',
    'ip mptcp limits show 2>/dev/null | sed "s/^/ip_mptcp_limits=/"',
    'ss -Mai state established 2>/dev/null | sed "s/^/ss_mptcp=/" | head -20',
    "python3 - <<'PY' 2>/dev/null",
    'import socket',
    'print("python_has_IPPROTO_MPTCP=%s" % hasattr(socket, "IPPROTO_MPTCP"))',
    'print("python_IPPROTO_MPTCP=%s" % getattr(socket, "IPPROTO_MPTCP", ""))',
    'PY',
    'command -v omr-tracker >/dev/null 2>&1 && echo openmptcprouter_marker=omr-tracker || true',
    'test -d /etc/openmptcprouter && echo openmptcprouter_marker=/etc/openmptcprouter || true',
    'ss -lntup 2>/dev/null | grep ":9527" | sed "s/^/listener_9527=/" || true'
  ].join('\n');
}

function buildTcpProbeCommand(endpoint) {
  const parsed = new URL(endpoint);
  const host = parsed.hostname;
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80));
  return [
    "node - <<'NODE'",
    'const net = require("node:net");',
    `const host = ${JSON.stringify(host)};`,
    `const port = ${JSON.stringify(port)};`,
    'const startedAt = Date.now();',
    'const socket = net.createConnection({ host, port });',
    'socket.setTimeout(5000);',
    'socket.on("connect", () => {',
    '  console.log(JSON.stringify({ ok: true, host, port, durationMs: Date.now() - startedAt }));',
    '  socket.destroy();',
    '});',
    'socket.on("timeout", () => {',
    '  console.log(JSON.stringify({ ok: false, host, port, error: "timeout", durationMs: Date.now() - startedAt }));',
    '  socket.destroy();',
    '});',
    'socket.on("error", (error) => {',
    '  console.log(JSON.stringify({ ok: false, host, port, error: error.code || error.message, durationMs: Date.now() - startedAt }));',
    '});',
    'NODE'
  ].join('\n');
}

function parseJsonMaybe(text) {
  try {
    return JSON.parse(String(text || '').trim());
  } catch (_error) {
    return null;
  }
}

function commandHasTruthyMarker(parsed, keys) {
  return keys.some((key) => {
    const value = normalizeText(parsed[key], 256).toLowerCase();
    return value === '1' || value === 'true' || value === 'enabled';
  });
}

function collectOpenMptcpMarkers(parsed) {
  return Object.entries(parsed)
    .filter(([key]) => key === 'openmptcprouter_marker')
    .map(([, value]) => value)
    .filter(Boolean);
}

function summarizeMultipathReport(report) {
  const localParsed = parseKeyValueLines(report.local && report.local.mptcp && report.local.mptcp.stdout);
  const remoteParsed = parseKeyValueLines(report.remote && report.remote.mptcp && report.remote.mptcp.stdout);
  const tcp = parseJsonMaybe(report.defaultPort && report.defaultPort.tcp && report.defaultPort.tcp.stdout) || {};
  const readyz = parseJsonMaybe(report.defaultPort && report.defaultPort.readyz && report.defaultPort.readyz.stdout) || {};
  const localPythonMptcp = normalizeText(localParsed.python_has_IPPROTO_MPTCP).toLowerCase() === 'true';
  const remotePythonMptcp = normalizeText(remoteParsed.python_has_IPPROTO_MPTCP).toLowerCase() === 'true';
  const remoteKernelMptcp = commandHasTruthyMarker(remoteParsed, ['proc_net_mptcp_enabled', 'net.mptcp.enabled']);
  const localKernelMptcp = commandHasTruthyMarker(localParsed, ['net.mptcp.enabled', 'net.mptcp.mptcp_enabled', 'net.inet.mptcp.enabled']);
  const openMptcpRouterMarkers = collectOpenMptcpMarkers(localParsed).concat(collectOpenMptcpMarkers(remoteParsed));
  const listenerText = normalizeText(remoteParsed.listener_9527, 4096);
  const nodeHttpListener = /node|nodejs|bin\/ai-home\.js/.test(listenerText);

  const blockers = [];
  if (!tcp.ok) blockers.push('default_port_tcp_unreachable');
  if (!readyz.ok || readyz.service !== 'aih-server') blockers.push('default_port_not_aih_readyz');
  if (!remoteKernelMptcp) blockers.push('aws_kernel_mptcp_not_enabled');
  if (!remotePythonMptcp) blockers.push('aws_runtime_mptcp_socket_unavailable');
  if (!localKernelMptcp && !localPythonMptcp) blockers.push('local_mptcp_unavailable');
  if (openMptcpRouterMarkers.length === 0) blockers.push('openmptcprouter_not_detected');
  if (nodeHttpListener) blockers.push('default_listener_is_plain_http_not_multipath_transport');

  return {
    defaultPortReachable: Boolean(tcp.ok && readyz.ok && readyz.service === 'aih-server'),
    local: {
      platform: localParsed.platform || '',
      arch: localParsed.arch || '',
      kernelMptcp: localKernelMptcp,
      pythonMptcpSocket: localPythonMptcp
    },
    remote: {
      platform: remoteParsed.platform || '',
      arch: remoteParsed.arch || '',
      kernelMptcp: remoteKernelMptcp,
      pythonMptcpSocket: remotePythonMptcp,
      listener9527: listenerText
    },
    openMptcpRouterDetected: openMptcpRouterMarkers.length > 0,
    blockers: Array.from(new Set(blockers)),
    promotionReady: blockers.length === 0,
    verdict: blockers.length === 0 ? 'promotion_ready' : 'diagnostic_pass_promotion_blocked'
  };
}

async function runDiagnosis(options) {
  const endpoint = options.endpoint;
  const report = {
    generatedAt: new Date().toISOString(),
    target: {
      endpoint,
      ssh: options.sshTarget
    },
    local: {
      mptcp: runShell(buildLocalMptcpCommand())
    },
    remote: {
      mptcp: runSsh(options, buildRemoteMptcpCommand())
    },
    defaultPort: {
      tcp: runShell(buildTcpProbeCommand(endpoint)),
      readyz: runShell(`curl --noproxy '*' -s -S --max-time 8 ${JSON.stringify(`${endpoint}/readyz`)}`)
    }
  };
  report.summary = summarizeMultipathReport(report);
  return report;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    showHelp();
    return;
  }
  const report = await runDiagnosis(options);
  console.log(JSON.stringify(report, null, 2));
  if (!report.summary.defaultPortReachable) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[fabric-multipath-diagnosis] ${String(error && error.message || error)}`);
    process.exit(1);
  });
}

module.exports = {
  buildLocalMptcpCommand,
  buildRemoteMptcpCommand,
  parseArgs,
  parseKeyValueLines,
  runDiagnosis,
  summarizeMultipathReport
};
