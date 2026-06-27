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
token file stat, readyz, server process, and residue checks. It never installs
systemd units, never writes server config, and never prints token contents.
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

function getTokenFile(options) {
  return path.posix.join(
    options.remoteDir,
    '.aih-host-home',
    '.ai_home',
    'fabric',
    `${options.nodeId}.token`
  );
}

function buildRemoteEnvPrefix(options) {
  const nodeBin = path.posix.join(options.remoteDir, '.node-runtime', 'node-v22.16.0-linux-x64', 'bin');
  const hostHome = path.posix.join(options.remoteDir, '.aih-host-home');
  const cliPath = path.posix.join(options.remoteDir, 'bin', 'ai-home.js');
  return [
    `cd ${shQuote(options.remoteDir)}`,
    `export PATH=${shQuote(`${nodeBin}:$PATH`)}`,
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
      '--token-file', shQuote(getTokenFile(options)),
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

function buildTokenStatCommand(options) {
  return `stat -c 'token_path=%n mode=%a bytes=%s' ${shQuote(getTokenFile(options))}`;
}

function buildReadyzCommand(options) {
  return `curl --noproxy '*' -s -o /tmp/aih-m3-daemon-preflight-readyz.json -w '%{http_code}' ${shQuote(`http://127.0.0.1:${options.port}/readyz`)}`;
}

function buildServerProcessCommand() {
  return "ps -axo pid,command | grep 'bin/ai-home.js server serve' | grep -v grep || true";
}

function buildResidueCommand() {
  return "ps -axo pid,command | grep -E 'fabric registry agent|node relay connect|fabric transport echo|browser-smoke|fabric-real|fabric broker connect' | grep -v grep || true";
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

function parseTokenStat(stdout) {
  const text = String(stdout || '').trim();
  const match = text.match(/^token_path=(.+?) mode=(\d+) bytes=(\d+)$/);
  if (!match) {
    return {
      ok: false,
      path: '',
      mode: '',
      bytes: 0
    };
  }
  return {
    ok: true,
    path: match[1],
    mode: match[2],
    bytes: Number(match[3]) || 0
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

function summarizePreflight(options, raw = {}) {
  const statusPayload = raw.statusPayload || {};
  const dryRunPayload = raw.dryRunPayload || {};
  const serviceStatus = statusPayload.status || {};
  const services = serviceStatus.services || {};
  const token = parseTokenStat(raw.tokenStat && raw.tokenStat.stdout);
  const readyzHttp = Number(String(raw.readyz && raw.readyz.stdout || '').trim()) || 0;
  const serverProcesses = lines(raw.serverProcesses && raw.serverProcesses.stdout);
  const residue = lines(raw.residue && raw.residue.stdout);
  const issueCodes = collectIssueCodes(statusPayload);
  const plan = dryRunPayload.plan || {};
  const relay = services.relay || {};
  const registryAgent = services.registryAgent || {};
  const remainingGate = [];

  if (!serviceStatus.server || !serviceStatus.server.managementKeyConfigured) {
    remainingGate.push('management_key_missing');
  }
  if (!relay.running) remainingGate.push('relay_service_not_running');
  if (!registryAgent.running) remainingGate.push('registry_agent_service_not_running');

  const preflightOk = Boolean(
    token.ok
    && token.mode === '600'
    && token.bytes > 0
    && readyzHttp === 200
    && serverProcesses.length === 1
    && residue.length === 0
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
    token,
    server: {
      readyzHttp,
      processCount: serverProcesses.length,
      processes: serverProcesses
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
      issues: issueCodes
    },
    installDryRun: {
      ok: Boolean(dryRunPayload.ok),
      writes: Boolean(plan.writes),
      services: Array.isArray(plan.services)
        ? plan.services.map((service) => service.key).filter(Boolean)
        : []
    },
    residue,
    remainingGate: Array.from(new Set(remainingGate))
  };
}

async function runPreflight(options, deps = {}) {
  const tokenStat = await runSsh(options, buildTokenStatCommand(options), deps);
  const status = await runSsh(options, buildServiceStatusCommand(options), deps);
  const dryRun = await runSsh(options, buildInstallDryRunCommand(options), deps);
  const serverProcesses = await runSsh(options, buildServerProcessCommand(), deps);
  const readyz = await runSsh(options, buildReadyzCommand(options), deps);
  const residue = await runSsh(options, buildResidueCommand(), deps);

  return summarizePreflight(options, {
    tokenStat,
    statusPayload: parseJsonOutput(status, 'node service status'),
    dryRunPayload: parseJsonOutput(dryRun, 'node service install dry-run'),
    serverProcesses,
    readyz,
    residue
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
  buildReadyzCommand,
  buildResidueCommand,
  buildServerProcessCommand,
  buildServiceStatusCommand,
  buildTokenStatCommand,
  getTokenFile,
  parseArgs,
  parseTokenStat,
  runPreflight,
  summarizePreflight
};
