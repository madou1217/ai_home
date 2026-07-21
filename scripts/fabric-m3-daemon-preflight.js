#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  buildSshArgs,
  shQuote
} = require('./fabric-real-vps-deploy');

const DEFAULT_SSH_TARGET = 'ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com';
const DEFAULT_SSH_KEY = '~/.ssh/aws.pem';
const DEFAULT_REMOTE_DIR = '/home/ubuntu/aih-fabric-current';
const DEFAULT_NODE_ID = 'aws-current-node';
const DEFAULT_PORT = 9527;

function showHelp() {
  console.log(`AIH Fabric M3 daemon preflight

Usage:
  node scripts/fabric-m3-daemon-preflight.js [options]

Options:
  --ssh <user@host>      SSH target, default ${DEFAULT_SSH_TARGET}.
  --ssh-key <pem>        SSH key, default ${DEFAULT_SSH_KEY}.
  --remote-dir <path>    AWS current dir, default ${DEFAULT_REMOTE_DIR}.
  --node-id <id>         Fabric node id, default ${DEFAULT_NODE_ID}.
  --port <n>             AIH server port, default ${DEFAULT_PORT}.
  --json                 Print JSON only.
  -h, --help             Show this help.

This preflight is read-only. It runs service status, service install --dry-run,
DB token presence, readyz, server process, remote code readiness, and residue
checks. It never installs systemd units, never writes server config, and never
prints Management Key contents.
`);
}

function nonEmptyString(value) {
  return String(value === undefined || value === null ? '' : value).trim();
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

function resolveLocalPath(value) {
  return path.resolve(String(value || '').replace(/^~(?=\/|$)/, process.env.HOME || ''));
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('--port must be a TCP port');
  }
  return port;
}

function parseArgs(argv = []) {
  const options = {
    help: false,
    json: false,
    sshTarget: DEFAULT_SSH_TARGET,
    sshKey: resolveLocalPath(DEFAULT_SSH_KEY),
    remoteDir: DEFAULT_REMOTE_DIR,
    nodeId: DEFAULT_NODE_ID,
    port: DEFAULT_PORT
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
    if (token === '--json') {
      options.json = true;
      index += 1;
      continue;
    }
    if (token === '--ssh' || token.startsWith('--ssh=')) {
      const next = readOptionValue(argv, index, '--ssh');
      options.sshTarget = nonEmptyString(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--ssh-key' || token.startsWith('--ssh-key=')) {
      const next = readOptionValue(argv, index, '--ssh-key');
      options.sshKey = resolveLocalPath(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--remote-dir' || token.startsWith('--remote-dir=')) {
      const next = readOptionValue(argv, index, '--remote-dir');
      options.remoteDir = nonEmptyString(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--node-id' || token.startsWith('--node-id=')) {
      const next = readOptionValue(argv, index, '--node-id');
      options.nodeId = nonEmptyString(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--port' || token.startsWith('--port=')) {
      const next = readOptionValue(argv, index, '--port');
      options.port = parsePort(next.value);
      index += next.consumed;
      continue;
    }
    throw new Error(`unknown option: ${token}`);
  }

  if (!options.sshTarget) throw new Error('--ssh is required');
  if (!path.posix.isAbsolute(options.remoteDir)) throw new Error('--remote-dir must be absolute');
  if (!options.nodeId) throw new Error('--node-id is required');
  return options;
}

function getExpectedHostHome(options) {
  return path.posix.join(options.remoteDir, '.aih-host-home');
}

function buildRemoteEnvPrefix(options) {
  const nodeBin = path.posix.join(options.remoteDir, '.node-runtime', 'node-v22.16.0-linux-x64', 'bin');
  const hostHome = getExpectedHostHome(options);
  const cliPath = path.posix.join(options.remoteDir, 'bin', 'ai-home.js');
  return [
    `cd ${shQuote(options.remoteDir)}`,
    `export PATH=${shQuote(nodeBin)}:$PATH`,
    `export AIH_HOST_HOME=${shQuote(hostHome)}`,
    `export AIH_CLI_PATH=${shQuote(cliPath)}`
  ].join(' && ');
}

function buildNodeCommand(options, innerCommand) {
  return `${buildRemoteEnvPrefix(options)} && ${innerCommand}`;
}

function buildServiceStatusCommand(options) {
  return buildNodeCommand(
    options,
    [
      'node bin/ai-home.js node service status',
      '--control-url', shQuote(`http://127.0.0.1:${options.port}`),
      '--node-id', shQuote(options.nodeId),
      '--json'
    ].join(' ')
  );
}

function buildInstallDryRunCommand(options) {
  return buildNodeCommand(
    options,
    [
      'node bin/ai-home.js node service install',
      shQuote(`http://127.0.0.1:${options.port}`),
      '--node-id', shQuote(options.nodeId),
      '--status online',
      '--relay-status online',
      '--transport relay=online',
      '--probe-transport', shQuote(`relay=ws://127.0.0.1:${options.port}/v0/fabric/transport/echo`),
      '--probe-count 20',
      '--probe-payload-size 64',
      '--probe-timeout-ms 10000',
      '--interval-ms 30000',
      '--dry-run',
      '--json'
    ].join(' ')
  );
}

function buildManagementKeyStateCommand(options) {
  const script = [
    "const fs=require('node:fs')",
    "const path=require('node:path')",
    "const {readRegistryAgentManagementKey}=require('./lib/cli/services/fabric/registry-agent-management-key-store')",
    "const root=String(process.env.AIH_HOST_HOME||process.env.HOME||'')",
    "const aiHomeDir=path.join(root,'.ai_home')",
    "const present=Boolean(readRegistryAgentManagementKey(process.argv[1],{fs,aiHomeDir}))",
    "console.log('management_key_source=app-state.db present='+(present?'yes':'no'))"
  ].join('; ');
  return buildNodeCommand(
    options,
    ['node -e', shQuote(script), shQuote(options.nodeId)].join(' ')
  );
}

function buildReadyzCommand(options) {
  return `curl --noproxy '*' -s -o /tmp/aih-m3-daemon-preflight-readyz.json -w '%{http_code}' ${shQuote(`http://127.0.0.1:${options.port}/readyz`)}`;
}

function buildRegistryReadbackCommand(options) {
  const script = [
    "const fs=require('node:fs')",
    "const path=require('node:path')",
    "const {readRegistryAgentManagementKey}=require('./lib/cli/services/fabric/registry-agent-management-key-store')",
    "const root=String(process.env.AIH_HOST_HOME||process.env.HOME||'')",
    "const aiHomeDir=path.join(root,'.ai_home')",
    "const url=process.argv[1]",
    "const nodeId=process.argv[2]",
    "const managementKey=readRegistryAgentManagementKey(nodeId,{fs,aiHomeDir})",
    "if(!managementKey){console.log(JSON.stringify({ok:false,http:0,error:'management_key_missing'}));process.exit(2)}",
    "fetch(url,{headers:{authorization:'Bearer '+managementKey}}).then(async (response)=>{",
    "const payload=await response.json().catch(()=>({}))",
    "const registry=(payload&&payload.result)||payload||{}",
    "const count=(name)=>Array.isArray(registry[name])?registry[name].length:0",
    "const counts=registry.counts&&typeof registry.counts==='object'?registry.counts:{}",
    "const inventory=Array.isArray(registry.nodeInventory)?registry.nodeInventory:[]",
    "const node=inventory.find((item)=>item&&item.id===nodeId)||null",
    "const capabilities=(node&&node.capabilities)||{}",
    "const gaps=Array.isArray(node&&node.runtimeGaps)?node.runtimeGaps:[]",
    "console.log(JSON.stringify({ok:Boolean(response.ok&&payload&&payload.ok!==false),http:response.status,counts:{nodes:Number(counts.nodes)||count('nodes'),relayNodes:Number(counts.relayNodes)||count('relayNodes'),projects:Number(counts.projects)||count('projects'),runtimes:Number(counts.runtimes)||count('runtimes'),transports:Number(counts.transports)||count('transports'),nodeInventory:inventory.length},targetNode:node?{id:String(node.id||''),runtimeHost:Boolean(capabilities.runtimeHost),runtimeProviders:Array.isArray(capabilities.runtimeProviders)?capabilities.runtimeProviders:[],runtimeGaps:gaps.map((gap)=>String((gap&&gap.provider)||'')+':'+String((gap&&gap.blocker)||''))}:null}))",
    "}).catch((error)=>{console.log(JSON.stringify({ok:false,http:0,error:String(error&&error.message||error)}));process.exitCode=1})"
  ].join('; ');
  return buildNodeCommand(
    options,
    [
      'node -e',
      shQuote(script),
      shQuote(`http://127.0.0.1:${options.port}/v0/fabric/registry`),
      shQuote(options.nodeId)
    ].join(' ')
  );
}

function buildServerProcessCommand() {
  return "ps -axo pid,command | grep 'bin/ai-home.js server serve' | grep -v grep || true";
}

function buildServerHostHomeCommand() {
  return [
    "for pid in $(ps -axo pid=,args= | awk '/[b]in\\/ai-home.js server serve/ {print $1}'); do",
    "host_home=$(tr '\\0' '\\n' < /proc/$pid/environ 2>/dev/null | awk -F= '$1==\"AIH_HOST_HOME\" {print substr($0, index($0, \"=\")+1)}' | tail -n 1);",
    "printf 'pid=%s AIH_HOST_HOME=%s\\n' \"$pid\" \"$host_home\";",
    'done'
  ].join(' ');
}

function buildResidueCommand() {
  return "ps -axo pid,command | grep -E 'fabric registry agent|node relay connect|node webrtc connect|fabric transport echo|browser-smoke|fabric-real|fabric broker connect' | grep -v grep || true";
}

function buildRemoteCodeReadinessCommand(options) {
  return buildNodeCommand(
    options,
    [
      "generate_management_key=no",
      "grep -q -- '--generate-management-key' lib/server/server-config-command.js && generate_management_key=yes",
      "runbook=no",
      "test -f docs/fabric/13-m3-supervised-daemon-runbook.md && runbook=yes",
      'printf "generate_management_key=%s runbook=%s\\n" "$generate_management_key" "$runbook"'
    ].join('; ')
  );
}

function run(command, args, runOptions = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: runOptions.cwd,
      env: runOptions.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += Buffer.from(chunk).toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += Buffer.from(chunk).toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (status, signal) => {
      resolve({ status, signal, stdout, stderr });
    });
  });
}

async function runSsh(options, remoteCommand, deps = {}) {
  const runner = deps.run || run;
  return runner('ssh', [
    ...buildSshArgs(options),
    options.sshTarget,
    remoteCommand
  ]);
}

function parseJsonOutput(result, label) {
  const text = String(result && result.stdout || '').trim();
  if (!text) throw new Error(`${label} returned empty stdout`);
  try {
    return JSON.parse(text);
  } catch (error) {
    const wrapped = new Error(`${label} returned invalid JSON`);
    wrapped.cause = error;
    throw wrapped;
  }
}

function parseManagementKeyState(stdout) {
  const text = String(stdout || '').trim();
  const match = text.match(/^management_key_source=app-state\.db present=(yes|no)$/);
  const present = Boolean(match && match[1] === 'yes');
  return {
    ok: present,
    source: match ? 'app-state.db' : '',
    present
  };
}

function lines(stdout) {
  return String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function collectIssueCodes(statusPayload) {
  const status = statusPayload && statusPayload.status || {};
  const issues = Array.isArray(status.issues) ? status.issues : [];
  return issues.map((issue) => String(issue && issue.code || '').trim()).filter(Boolean);
}

function parseRemoteCodeReadiness(stdout) {
  const text = String(stdout || '').trim();
  const match = text.match(/(?:^|\s)generate_management_key=(yes|no)\s+runbook=(yes|no)(?:\s|$)/);
  const generateManagementKey = Boolean(match && match[1] === 'yes');
  const supervisedDaemonRunbook = Boolean(match && match[2] === 'yes');
  return {
    ready: generateManagementKey && supervisedDaemonRunbook,
    generateManagementKey,
    supervisedDaemonRunbook
  };
}

function parseServerHostHomes(stdout, expectedHostHome) {
  const expected = nonEmptyString(expectedHostHome);
  return lines(stdout).map((line) => {
    const match = line.match(/^pid=(\d+)\s+AIH_HOST_HOME=(.*)$/);
    const pid = match ? Number(match[1]) || 0 : 0;
    const hostHome = match ? nonEmptyString(match[2]) : '';
    return {
      pid,
      hostHome,
      ok: Boolean(pid && expected && hostHome === expected)
    };
  });
}

function normalizeRegistryReadback(payload = {}, nodeId = '') {
  const source = payload && typeof payload === 'object' ? payload : {};
  const counts = source.counts && typeof source.counts === 'object' ? source.counts : {};
  const targetNode = source.targetNode && typeof source.targetNode === 'object' ? source.targetNode : null;
  const runtimeProviders = Array.isArray(targetNode && targetNode.runtimeProviders)
    ? targetNode.runtimeProviders.map((item) => nonEmptyString(item)).filter(Boolean)
    : [];
  const runtimeGaps = Array.isArray(targetNode && targetNode.runtimeGaps)
    ? targetNode.runtimeGaps.map((item) => nonEmptyString(item)).filter(Boolean)
    : [];
  const expectedNodeId = nonEmptyString(nodeId);
  const targetNodeId = nonEmptyString(targetNode && targetNode.id);
  return {
    ok: Boolean(source.ok),
    http: Number(source.http) || 0,
    counts: {
      nodes: Number(counts.nodes) || 0,
      relayNodes: Number(counts.relayNodes) || 0,
      projects: Number(counts.projects) || 0,
      runtimes: Number(counts.runtimes) || 0,
      transports: Number(counts.transports) || 0,
      nodeInventory: Number(counts.nodeInventory) || 0
    },
    targetNode: targetNode ? {
      id: targetNodeId,
      present: Boolean(targetNodeId && (!expectedNodeId || targetNodeId === expectedNodeId)),
      runtimeHost: Boolean(targetNode.runtimeHost),
      runtimeProviders,
      runtimeGaps
    } : null,
    error: nonEmptyString(source.error, 256)
  };
}

function classifyExpectedSupervisedProcess(line, options, services) {
  const text = nonEmptyString(line);
  const nodeId = nonEmptyString(options && options.nodeId);
  const relay = services && services.relay || {};
  const registryAgent = services && services.registryAgent || {};
  const webrtc = services && services.webrtc || {};
  if (relay.running && text.includes('node relay connect') && text.includes(`--node-id ${nodeId}`)) {
    return 'relay';
  }
  if (registryAgent.running && text.includes('fabric registry agent') && text.includes(`--node-id ${nodeId}`)) {
    return 'registryAgent';
  }
  if (webrtc.running && text.includes('node webrtc connect') && text.includes(`--node-id ${nodeId}`)) {
    return 'webrtc';
  }
  return '';
}

function isExpectedSupervisedProcess(line, options, services) {
  return Boolean(classifyExpectedSupervisedProcess(line, options, services));
}

function splitResidueProcesses(processes, options, services) {
  const supervised = [];
  const unexpected = [];
  const supervisedByKey = new Map();
  lines(processes).forEach((line) => {
    const key = classifyExpectedSupervisedProcess(line, options, services);
    if (key) {
      supervised.push(line);
      const group = supervisedByKey.get(key) || [];
      group.push(line);
      supervisedByKey.set(key, group);
    } else {
      unexpected.push(line);
    }
  });
  const duplicateSupervised = Array.from(supervisedByKey.entries())
    .filter((entry) => entry[1].length > 1)
    .map(([key, group]) => ({
      key,
      count: group.length,
      processes: group
    }));
  return { supervised, unexpected, duplicateSupervised };
}

function summarizePreflight(options, raw = {}) {
  const statusPayload = raw.statusPayload || {};
  const dryRunPayload = raw.dryRunPayload || {};
  const serviceStatus = statusPayload.status || {};
  const services = serviceStatus.services || {};
  const managementKeyStore = parseManagementKeyState(raw.managementKeyState && raw.managementKeyState.stdout);
  const readyzHttp = Number(String(raw.readyz && raw.readyz.stdout || '').trim()) || 0;
  const serverProcesses = lines(raw.serverProcesses && raw.serverProcesses.stdout);
  const expectedHostHome = getExpectedHostHome(options);
  const serverHostHomes = parseServerHostHomes(raw.serverHostHome && raw.serverHostHome.stdout, expectedHostHome);
  const serverHostHomeReady = serverProcesses.length === 1
    && serverHostHomes.length === 1
    && serverHostHomes[0].ok === true;
  const remoteCode = parseRemoteCodeReadiness(raw.remoteCode && raw.remoteCode.stdout);
  const issueCodes = collectIssueCodes(statusPayload);
  const plan = dryRunPayload.plan || {};
  const relay = services.relay || {};
  const registryAgent = services.registryAgent || {};
  const webrtc = services.webrtc || {};
  const registryReadback = normalizeRegistryReadback(raw.registryPayload || {}, options.nodeId);
  const residueSplit = splitResidueProcesses(raw.residue && raw.residue.stdout, options, { relay, registryAgent, webrtc });
  const residue = residueSplit.unexpected;
  const duplicateSupervised = residueSplit.duplicateSupervised || [];
  const remainingGate = [];

  if (!remoteCode.generateManagementKey) remainingGate.push('remote_code_missing_generate_management_key');
  if (!remoteCode.supervisedDaemonRunbook) remainingGate.push('remote_runbook_missing');
  if (!serviceStatus.server || !serviceStatus.server.managementKeyConfigured) {
    remainingGate.push('management_key_missing');
  }
  if (!serverHostHomeReady) remainingGate.push('server_host_home_mismatch');
  if (!relay.running) remainingGate.push('relay_service_not_running');
  if (!registryAgent.running) remainingGate.push('registry_agent_service_not_running');
  if (!webrtc.running) remainingGate.push('webrtc_service_not_running');
  if (!registryReadback.ok || registryReadback.http !== 200) remainingGate.push('registry_readback_failed');
  if (!registryReadback.targetNode || !registryReadback.targetNode.present) remainingGate.push('registry_target_node_missing');
  if (!managementKeyStore.present) remainingGate.push('management_key_missing');
  if (residue.length > 0) remainingGate.push('unexpected_residue_processes');
  if (duplicateSupervised.length > 0) remainingGate.push('duplicate_supervised_processes');

  const preflightOk = Boolean(
    managementKeyStore.ok
    && readyzHttp === 200
    && serverProcesses.length === 1
    && serverHostHomeReady
    && residue.length === 0
    && duplicateSupervised.length === 0
    && remoteCode.ready
    && relay.running
    && registryAgent.running
    && webrtc.running
    && registryReadback.ok
    && registryReadback.http === 200
    && registryReadback.targetNode
    && registryReadback.targetNode.present
    && plan.writes === false
  );

  return {
    ok: preflightOk,
    verdict: preflightOk ? 'ready_for_confirmed_7_3_execution' : 'preflight_failed',
    generatedAt: new Date().toISOString(),
    target: {
      ssh: options.sshTarget,
      remoteDir: options.remoteDir,
      nodeId: options.nodeId,
      port: options.port
    },
    managementKeyStore,
    server: {
      readyzHttp,
      processCount: serverProcesses.length,
      processes: serverProcesses,
      expectedHostHome,
      hostHomes: serverHostHomes
    },
    serviceStatus: {
      ok: Boolean(statusPayload.ok),
      managementKeyConfigured: Boolean(serviceStatus.server && serviceStatus.server.managementKeyConfigured),
      supervisorReady: Boolean(serviceStatus.supervisor && serviceStatus.supervisor.ready),
      relay: {
        state: relay.state || '',
        running: Boolean(relay.running),
        unit: relay.unit || ''
      },
      registryAgent: {
        state: registryAgent.state || '',
        running: Boolean(registryAgent.running),
        unit: registryAgent.unit || ''
      },
      webrtc: {
        state: webrtc.state || '',
        running: Boolean(webrtc.running),
        unit: webrtc.unit || ''
      },
      issues: issueCodes
    },
    registry: registryReadback,
    installDryRun: {
      ok: Boolean(dryRunPayload.ok),
      writes: Boolean(plan.writes),
      services: Array.isArray(plan.services)
        ? plan.services.map((service) => service.key).filter(Boolean)
        : []
    },
    remoteCode,
    supervisedProcesses: residueSplit.supervised,
    duplicateSupervisedProcesses: duplicateSupervised,
    residue,
    remainingGate: Array.from(new Set(remainingGate))
  };
}

async function runPreflight(options, deps = {}) {
  const managementKeyState = await runSsh(options, buildManagementKeyStateCommand(options), deps);
  const status = await runSsh(options, buildServiceStatusCommand(options), deps);
  const dryRun = await runSsh(options, buildInstallDryRunCommand(options), deps);
  const serverProcesses = await runSsh(options, buildServerProcessCommand(), deps);
  const serverHostHome = await runSsh(options, buildServerHostHomeCommand(), deps);
  const readyz = await runSsh(options, buildReadyzCommand(options), deps);
  const remoteCode = await runSsh(options, buildRemoteCodeReadinessCommand(options), deps);
  const residue = await runSsh(options, buildResidueCommand(), deps);
  const registry = await runSsh(options, buildRegistryReadbackCommand(options), deps);

  return summarizePreflight(options, {
    managementKeyState,
    statusPayload: parseJsonOutput(status, 'node service status'),
    dryRunPayload: parseJsonOutput(dryRun, 'node service install dry-run'),
    serverProcesses,
    serverHostHome,
    readyz,
    remoteCode,
    residue,
    registryPayload: parseJsonOutput(registry, 'fabric registry readback')
  });
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    showHelp();
    return;
  }
  const report = await runPreflight(options);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[fabric-m3-daemon-preflight] ${String(error && error.message || error)}`);
    process.exit(1);
  });
}

module.exports = {
  buildInstallDryRunCommand,
  buildRegistryReadbackCommand,
  buildReadyzCommand,
  buildRemoteCodeReadinessCommand,
  buildResidueCommand,
  buildServerHostHomeCommand,
  buildServerProcessCommand,
  buildServiceStatusCommand,
  buildManagementKeyStateCommand,
  parseArgs,
  parseRemoteCodeReadiness,
  normalizeRegistryReadback,
  parseServerHostHomes,
  splitResidueProcesses,
  parseManagementKeyState,
  runPreflight,
  summarizePreflight
};
