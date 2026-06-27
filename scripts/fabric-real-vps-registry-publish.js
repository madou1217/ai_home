#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const {
  createControlPlaneDeviceInvite,
  consumeControlPlaneDeviceInvite
} = require('../lib/server/control-plane-device-pairing');
const {
  closeTcpEchoServer,
  startFabricTransportTcpEchoServer
} = require('../lib/cli/services/fabric/transport-tcp-echo');

function showHelp() {
  console.log(`AIH Fabric real VPS registry publish

Usage:
  node scripts/fabric-real-vps-registry-publish.js --port 18482 --node-id vps-152-jp-v4 --name "VPS 152 Japan" --bandwidth-kbps 3072

Options:
  --port <n>              Required local AIH server port.
  --node-id <id>          Required Fabric node id.
  --name <name>           Node display name, defaults to node id.
  --project <path>        Project path to publish, defaults to cwd.
  --bandwidth-kbps <n>    Relay node bandwidth limit, default 0.
  --agent-count <n>       Run foreground registry agent for n heartbeats, default 2.
  --agent-interval-ms <n> Agent heartbeat interval for this smoke, default 1000.
  --agent-probe-transport <kind=url>
                           Probe target for agent transport health. When omitted, this script starts a temporary local tcp-echo server.
  -h, --help              Show this help.

The script creates a short-lived local device invite, consumes it in-process,
runs "aih fabric registry publish --from-server --relay-node", sends heartbeat,
runs a finite foreground registry agent smoke, reads registry and legacy node
views back, and prints a sanitized JSON report. It never prints the device token.
`);
}

function readOptionValue(args, index, flag) {
  const token = String(args[index] || '');
  const prefix = `${flag}=`;
  if (token.startsWith(prefix)) return { value: token.slice(prefix.length), consumed: 1 };
  const value = args[index + 1];
  if (value === undefined || String(value).startsWith('-')) {
    throw new Error(`${flag} requires a value`);
  }
  return { value: String(value), consumed: 2 };
}

function parseArgs(argv) {
  const options = {
    help: false,
    port: 0,
    nodeId: '',
    name: '',
    project: process.cwd(),
    bandwidthKbps: 0,
    agentCount: 2,
    agentIntervalMs: 1000,
    agentProbeTransports: []
  };

  for (let index = 0; index < argv.length;) {
    const token = String(argv[index] || '').trim();
    if (!token) {
      index += 1;
      continue;
    }
    if (token === '-h' || token === '--help') {
      options.help = true;
      index += 1;
      continue;
    }
    if (token === '--port' || token.startsWith('--port=')) {
      const next = readOptionValue(argv, index, '--port');
      options.port = Number(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--node-id' || token.startsWith('--node-id=')) {
      const next = readOptionValue(argv, index, '--node-id');
      options.nodeId = next.value.trim();
      index += next.consumed;
      continue;
    }
    if (token === '--name' || token.startsWith('--name=')) {
      const next = readOptionValue(argv, index, '--name');
      options.name = next.value.trim();
      index += next.consumed;
      continue;
    }
    if (token === '--project' || token.startsWith('--project=')) {
      const next = readOptionValue(argv, index, '--project');
      options.project = path.resolve(process.cwd(), next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--bandwidth-kbps' || token.startsWith('--bandwidth-kbps=')) {
      const next = readOptionValue(argv, index, '--bandwidth-kbps');
      options.bandwidthKbps = Math.max(0, Math.floor(Number(next.value) || 0));
      index += next.consumed;
      continue;
    }
    if (token === '--agent-count' || token.startsWith('--agent-count=')) {
      const next = readOptionValue(argv, index, '--agent-count');
      options.agentCount = Math.max(0, Math.floor(Number(next.value) || 0));
      index += next.consumed;
      continue;
    }
    if (token === '--agent-interval-ms' || token.startsWith('--agent-interval-ms=')) {
      const next = readOptionValue(argv, index, '--agent-interval-ms');
      options.agentIntervalMs = Math.max(1000, Math.floor(Number(next.value) || 1000));
      index += next.consumed;
      continue;
    }
    if (token === '--agent-probe-transport' || token.startsWith('--agent-probe-transport=')) {
      const next = readOptionValue(argv, index, '--agent-probe-transport');
      options.agentProbeTransports.push(next.value.trim());
      index += next.consumed;
      continue;
    }
    throw new Error(`unknown option: ${token}`);
  }

  if (options.help) return options;
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new Error('--port must be a valid TCP port');
  }
  if (!options.nodeId) throw new Error('--node-id is required');
  options.name = options.name || options.nodeId;
  return options;
}

function resolveAiHomeDir(env = process.env) {
  const hostHome = String(env.AIH_HOST_HOME || '').trim();
  if (hostHome) return path.join(hostHome, '.ai_home');
  return path.join(os.homedir(), '.ai_home');
}

function parseJson(text) {
  try {
    return JSON.parse(String(text || '').trim());
  } catch (_error) {
    return null;
  }
}

function runCommandAsync(command, args, options = {}, deps = {}) {
  if (typeof deps.runCommandAsync === 'function') {
    return deps.runCommandAsync(command, args, options);
  }
  const spawnImpl = deps.spawn || spawn;
  return new Promise((resolve) => {
    const child = spawnImpl(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];
    const timeoutMs = Math.max(1000, Number(options.timeoutMs || 30000));
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch (_error) {}
    }, timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({
        status: null,
        signal: '',
        error,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      });
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({
        status,
        signal: signal || '',
        error: null,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      });
    });
  });
}

async function readJson(url, token, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch_unavailable');
  }
  const response = await fetchImpl(url, {
    headers: {
      authorization: `Bearer ${token}`
    }
  });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

function createLocalFabricToken(options, deps = {}) {
  const aiHomeDir = deps.aiHomeDir || resolveAiHomeDir(deps.env || process.env);
  const endpoint = `http://127.0.0.1:${options.port}`;
  const invite = createControlPlaneDeviceInvite({
    name: `Registry publish ${options.nodeId}`,
    controlEndpoint: endpoint,
    scopes: ['control-plane:read', 'nodes:read', 'nodes:write', 'accounts:read']
  }, { fs: deps.fs || fs, aiHomeDir });
  const paired = consumeControlPlaneDeviceInvite({
    code: invite.code,
    device: {
      id: `device-registry-${options.nodeId}`,
      name: `Registry Publisher ${options.name}`,
      platform: process.platform
    }
  }, { fs: deps.fs || fs, aiHomeDir });
  return { endpoint, aiHomeDir, device: paired.device, token: paired.token };
}

async function startDefaultAgentProbeServer(deps = {}) {
  const start = deps.startTcpEchoServer || startFabricTransportTcpEchoServer;
  const handle = await start({ host: '127.0.0.1', port: 0 }, deps);
  return {
    probe: `relay=${handle.url}`,
    evidence: {
      protocol: handle.protocol || 'tcp',
      host: handle.host || '127.0.0.1',
      port: Number(handle.port || 0),
      kind: 'tcp-echo'
    },
    handle
  };
}

async function closeDefaultAgentProbeServer(server, deps = {}) {
  if (!server || !server.handle) return;
  const close = deps.closeTcpEchoServer || closeTcpEchoServer;
  await close(server.handle);
}

async function runRealVpsRegistryPublish(options, deps = {}) {
  const agentCount = Math.max(0, Math.floor(Number(options.agentCount == null ? 2 : options.agentCount) || 0));
  const agentIntervalMs = Math.max(1000, Math.floor(Number(options.agentIntervalMs == null ? 1000 : options.agentIntervalMs) || 1000));
  let defaultProbeServer = null;
  let agentProbeServerEvidence = null;
  let agentProbeTransports = Array.isArray(options.agentProbeTransports) && options.agentProbeTransports.length > 0
    ? options.agentProbeTransports
    : [];
  const tokenContext = createLocalFabricToken(options, deps);
  const endpoint = tokenContext.endpoint;
  const execPath = deps.execPath || process.execPath;
  const cliPath = deps.cliPath || path.join(process.cwd(), 'bin', 'ai-home.js');
  const spawn = deps.spawnSync || spawnSync;
  const cli = spawn(execPath, [
    cliPath,
    'fabric',
    'registry',
    'publish',
    endpoint,
    '--node-id',
    options.nodeId,
    '--name',
    options.name,
    '--relay-node',
    '--bandwidth-kbps',
    String(options.bandwidthKbps),
    '--project',
    options.project,
    '--from-server',
    '--json'
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AIH_FABRIC_TOKEN: tokenContext.token
    },
    encoding: 'utf8'
  });

  const publish = parseJson(cli.stdout) || {};
  const heartbeat = spawn(execPath, [
    cliPath,
    'fabric',
    'registry',
    'heartbeat',
    endpoint,
    '--node-id',
    options.nodeId,
    '--status',
    'online',
    '--relay-status',
    'online',
    '--transport',
    'relay=online',
    '--json'
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AIH_FABRIC_TOKEN: tokenContext.token
    },
    encoding: 'utf8'
  });
  const heartbeatJson = parseJson(heartbeat.stdout) || {};
  if (agentCount > 0 && agentProbeTransports.length === 0) {
    defaultProbeServer = await startDefaultAgentProbeServer(deps);
    agentProbeServerEvidence = defaultProbeServer.evidence;
    agentProbeTransports = [defaultProbeServer.probe];
  }
  let agent = { status: 0, signal: '', stdout: '', stderr: '' };
  try {
    agent = agentCount > 0
      ? await runCommandAsync(execPath, [
        cliPath,
        'fabric',
        'registry',
        'agent',
        endpoint,
        '--node-id',
        options.nodeId,
        '--status',
        'online',
        '--relay-status',
        'online',
        '--transport',
        'relay=online',
        ...agentProbeTransports.flatMap((probe) => ['--probe-transport', probe]),
        '--count',
        String(agentCount),
        '--interval-ms',
        String(agentIntervalMs),
        '--json'
      ], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AIH_FABRIC_TOKEN: tokenContext.token
        },
        encoding: 'utf8',
        timeoutMs: Math.max(30000, agentCount * agentIntervalMs + 30000)
      }, deps)
      : agent;
  } finally {
    await closeDefaultAgentProbeServer(defaultProbeServer, deps);
  }
  const agentJson = parseJson(agent.stdout) || {};
  const registry = await readJson(`${endpoint}/v0/fabric/registry`, tokenContext.token, deps.fetchImpl);
  const legacy = await readJson(`${endpoint}/v0/node-rpc/device-nodes`, tokenContext.token, deps.fetchImpl);
  const registryResult = registry.body && registry.body.result ? registry.body.result : {};
  const legacyResult = legacy.body && legacy.body.result ? legacy.body.result : {};

  return {
    ok: cli.status === 0 && heartbeat.status === 0 && agent.status === 0 && registry.status === 200 && legacy.status === 200,
    endpoint,
    nodeId: options.nodeId,
    name: options.name,
    deviceId: tokenContext.device.id,
    aiHomeDir: tokenContext.aiHomeDir,
    cliStatus: cli.status,
    cliSignal: cli.signal || '',
    publish: {
      ok: Boolean(publish.ok),
      nodeId: publish.nodeId,
      roles: publish.roles,
      projects: publish.projects,
      runtimes: publish.runtimes,
      transports: publish.transports,
      fromServer: publish.fromServer
    },
    heartbeat: {
      ok: Boolean(heartbeatJson.ok),
      nodeId: heartbeatJson.nodeId,
      status: heartbeatJson.status,
      relayStatus: heartbeatJson.relayStatus,
      transports: heartbeatJson.transports,
      counts: heartbeatJson.result && heartbeatJson.result.registry
        ? heartbeatJson.result.registry.counts
        : {}
    },
    heartbeatStatus: heartbeat.status,
    heartbeatSignal: heartbeat.signal || '',
    agent: {
      ok: Boolean(agentJson.ok),
      nodeId: agentJson.nodeId,
      attempts: agentJson.attempts || 0,
      failures: agentJson.failures || 0,
      intervalMs: agentJson.intervalMs || agentIntervalMs,
      count: agentJson.count || agentCount,
      lastCounts: agentJson.lastResult && agentJson.lastResult.result && agentJson.lastResult.result.registry
        ? agentJson.lastResult.result.registry.counts
        : {},
      probes: Array.isArray(agentJson.probes) ? agentJson.probes : [],
      probeServer: agentProbeServerEvidence
    },
    agentStatus: agent.status,
    agentSignal: agent.signal || '',
    registryStatus: registry.status,
    registryCounts: registryResult.counts || {},
    registryNodeIds: Array.isArray(registryResult.nodes) ? registryResult.nodes.map((node) => node.id) : [],
    relayNodeIds: Array.isArray(registryResult.relayNodes) ? registryResult.relayNodes.map((node) => node.id) : [],
    runtimeProviders: Array.isArray(registryResult.runtimes)
      ? registryResult.runtimes.map((runtime) => `${runtime.provider}:${runtime.mode}:${runtime.status}`)
      : [],
    transportKinds: Array.isArray(registryResult.transports)
      ? registryResult.transports.map((transport) => `${transport.kind}:${transport.health}`)
      : [],
    legacyStatus: legacy.status,
    legacyNodeIds: Array.isArray(legacyResult.nodes) ? legacyResult.nodes.map((node) => node.id) : [],
    stderrTail: [
      ...String(cli.stderr || '').trim().split('\n').filter(Boolean).slice(-3),
      ...String(heartbeat.stderr || '').trim().split('\n').filter(Boolean).slice(-3),
      ...String(agent.stderr || '').trim().split('\n').filter(Boolean).slice(-3)
    ].slice(-5),
    hostname: os.hostname()
  };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    showHelp();
    return;
  }
  const report = await runRealVpsRegistryPublish(options);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.stack ? error.stack : error);
    process.exit(1);
  });
}

module.exports = {
  createLocalFabricToken,
  closeDefaultAgentProbeServer,
  parseArgs,
  runCommandAsync,
  runRealVpsRegistryPublish,
  startDefaultAgentProbeServer
};
