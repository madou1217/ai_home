#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

const { startFabricSmokeServer } = require('./fabric-smoke-support');

const fetchImpl = globalThis.fetch || require('undici').fetch;
const FETCH_TIMEOUT_MS = 5000;
const CLI_TIMEOUT_MS = 10000;

function timeoutSignal() {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(FETCH_TIMEOUT_MS);
  }
  return undefined;
}

function logStage(stage) {
  process.stderr.write(`[fabric-registry-publish-smoke] ${stage}\n`);
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch (_error) {
    return { parseError: true, text };
  }
}

async function postJson(url, payload, options = {}) {
  const response = await fetchImpl(url, {
    method: 'POST',
    signal: timeoutSignal(),
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {})
    },
    body: JSON.stringify(payload)
  });
  return {
    status: response.status,
    body: await readJson(response)
  };
}

async function getJson(url, options = {}) {
  const response = await fetchImpl(url, {
    signal: timeoutSignal(),
    headers: options.headers || {}
  });
  return {
    status: response.status,
    body: await readJson(response)
  };
}

function parseCliJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

function runCli(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
    }, CLI_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
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
        signal,
        error: null,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8')
      });
    });
  });
}

async function main() {
  const smoke = await startFabricSmokeServer({
    name: 'Registry Publish Smoke',
    dirPrefix: 'aih-fabric-registry-publish-smoke-',
    argv: ['node', 'scripts/fabric-registry-publish-smoke.js'],
    scopes: ['control-plane:read', 'nodes:read', 'nodes:write']
  });

  try {
    logStage('pair');
    const pair = await postJson(`${smoke.controlEndpoint}/v0/fabric/device-pair?code=${encodeURIComponent(smoke.invite.code)}`, {
      device: {
        id: 'device-registry-smoke',
        name: 'Registry Smoke',
        platform: process.platform
      }
    });

    const token = pair.body && pair.body.result ? pair.body.result.token : '';
    if (!token) {
      console.log(JSON.stringify({
        ok: false,
        stage: 'pair',
        endpoint: smoke.controlEndpoint,
        pairStatus: pair.status,
        pairBody: pair.body
      }, null, 2));
      process.exitCode = 1;
      return;
    }

    const repoRoot = path.resolve(__dirname, '..');
    logStage('publish');
    const cli = await runCli(process.execPath, [
      path.join(repoRoot, 'bin', 'ai-home.js'),
      'fabric',
      'registry',
      'publish',
      smoke.controlEndpoint,
      '--node-id',
      'local-dev-smoke',
      '--name',
      'Local Dev Smoke',
      '--relay-node',
      '--bandwidth-kbps',
      '2048',
      '--project',
      repoRoot,
      '--runtime',
      'codex:tui:smoke',
      '--runtime',
      'claude:tui:smoke',
      '--json'
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        AIH_FABRIC_TOKEN: token
      }
    });

    const authHeaders = { authorization: `Bearer ${token}` };
    logStage('read registry');
    const registry = await getJson(`${smoke.controlEndpoint}/v0/fabric/registry`, { headers: authHeaders });
    logStage('read legacy nodes');
    const legacyNodes = await getJson(`${smoke.controlEndpoint}/v0/node-rpc/device-nodes`, { headers: authHeaders });
    const cliJson = parseCliJson(cli.stdout);

    const counts = registry.body && registry.body.result ? registry.body.result.counts : {};
    const report = {
      ok: cli.status === 0
        && pair.status === 200
        && registry.status === 200
        && legacyNodes.status === 200
        && counts.nodes === 1
        && counts.projects === 1
        && counts.runtimes === 2
        && counts.relayNodes === 1,
      endpoint: smoke.controlEndpoint,
      aiHomeDir: smoke.aiHomeDir,
      pairStatus: pair.status,
      cliStatus: cli.status,
      cliNodeId: cliJson && cliJson.nodeId,
      cliRoles: cliJson && cliJson.roles,
      cliCounts: cliJson ? {
        projects: cliJson.projects,
        runtimes: cliJson.runtimes,
        transports: cliJson.transports
      } : {},
      registryStatus: registry.status,
      registryCounts: counts,
      registryNodeIds: registry.body && registry.body.result
        ? registry.body.result.nodes.map((node) => node.id)
        : [],
      runtimeProviders: registry.body && registry.body.result
        ? registry.body.result.runtimes.map((runtime) => `${runtime.provider}:${runtime.mode}`)
        : [],
      legacyNodeIds: legacyNodes.body && legacyNodes.body.result
        ? legacyNodes.body.result.nodes.map((node) => node.id)
        : [],
      cliSignal: cli.signal || '',
      cliError: cli.error ? String(cli.error.message || cli.error) : '',
      stdoutBytes: Buffer.byteLength(String(cli.stdout || ''), 'utf8'),
      stderr: String(cli.stderr || '').trim()
    };

    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  } finally {
    await smoke.cleanup();
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
