#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const {
  connectFabricBroker
} = require('../lib/cli/services/fabric/broker-connect');
const {
  normalizeFabricServerId
} = require('../lib/server/fabric-broker-session-registry');
const {
  brokerProxyBase
} = require('./fabric-real-broker-smoke');
const {
  runExistingEndpointRelaySmoke
} = require('./fabric-real-outbound-relay-smoke');
const { isAccountRef } = require('../lib/account/public-account-ref');

const DEFAULT_ENDPOINT = 'http://127.0.0.1:9527';
const DEFAULT_SERVER_ID = 'broker-relay-smoke-server';
const DEFAULT_NODE_ID = 'broker-relay-smoke-node';
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_SESSION_TIMEOUT_MS = 90000;

function showHelp() {
  console.log(`AIH Fabric real broker relay smoke

Usage:
  node scripts/fabric-real-broker-relay-smoke.js [options]

Options:
  --endpoint <url>      Running AIH server/broker endpoint, default ${DEFAULT_ENDPOINT}.
  --local-url <url>     Local AIH server URL reached by broker connector, default endpoint.
  --client-endpoint <url>
                         Override device/client API endpoint. Defaults to broker proxy base.
  --server-id <id>      Broker server id, default ${DEFAULT_SERVER_ID}.
  --node-id <id>        Remote node id, default ${DEFAULT_NODE_ID}.
  --host-home <dir>     Host home used by the running endpoint, default AIH_HOST_HOME/HOME.
  --token <token>       Broker token. Prefer AIH_FABRIC_BROKER_TOKEN or --token-file.
  --token-file <path>   File containing broker token; token is never printed.
  --timeout-ms <n>      End-to-end wait timeout, default ${DEFAULT_TIMEOUT_MS}.
  --session-provider <p>
  --session-account-ref <ref>
  --session-model <m>
  --session-project <p>
  --session-prompt <p>
  --expect-output <txt>
  --session-timeout-ms <n>
  -h, --help            Show this help.

This script does not start a server, allocate a product port, install services,
or modify firewall/systemd. It keeps one outbound broker link open, then verifies
Management Key APIs through the broker proxy while the relay node dials the
existing Server endpoint.
`);
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
    throw new Error(`${flag} requires a value`);
  }
  return { value: String(value), consumed: 2 };
}

function normalizeHttpEndpoint(value, flag) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('bad_protocol');
    }
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch (_error) {
    throw new Error(`${flag} must be a valid http(s) URL`);
  }
}

function parsePositiveInteger(value, flag, fallback, min = 1000, max = 180000) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${flag} must be an integer between ${min} and ${max}`);
  }
  return number;
}

function parseArgs(argv = [], env = process.env) {
  const options = {
    help: false,
    endpoint: DEFAULT_ENDPOINT,
    localUrl: '',
    clientEndpoint: '',
    serverId: DEFAULT_SERVER_ID,
    nodeId: DEFAULT_NODE_ID,
    hostHome: String(env.AIH_HOST_HOME || env.HOME || os.homedir() || '').trim(),
    token: String(env.AIH_FABRIC_BROKER_TOKEN || '').trim(),
    tokenFile: '',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    sessionProvider: '',
    sessionAccountRef: '',
    sessionModel: '',
    sessionProjectPath: '',
    sessionPrompt: '',
    expectOutput: '',
    sessionTimeoutMs: DEFAULT_SESSION_TIMEOUT_MS
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
    if (token === '--endpoint' || token.startsWith('--endpoint=')) {
      const next = readOptionValue(argv, index, '--endpoint');
      options.endpoint = normalizeHttpEndpoint(next.value, '--endpoint');
      index += next.consumed;
      continue;
    }
    if (token === '--local-url' || token.startsWith('--local-url=')) {
      const next = readOptionValue(argv, index, '--local-url');
      options.localUrl = normalizeHttpEndpoint(next.value, '--local-url');
      index += next.consumed;
      continue;
    }
    if (token === '--client-endpoint' || token.startsWith('--client-endpoint=')) {
      const next = readOptionValue(argv, index, '--client-endpoint');
      options.clientEndpoint = normalizeHttpEndpoint(next.value, '--client-endpoint');
      index += next.consumed;
      continue;
    }
    if (token === '--server-id' || token.startsWith('--server-id=')) {
      const next = readOptionValue(argv, index, '--server-id');
      options.serverId = normalizeFabricServerId(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--node-id' || token.startsWith('--node-id=')) {
      const next = readOptionValue(argv, index, '--node-id');
      options.nodeId = String(next.value || '').trim();
      index += next.consumed;
      continue;
    }
    if (token === '--host-home' || token.startsWith('--host-home=')) {
      const next = readOptionValue(argv, index, '--host-home');
      options.hostHome = path.resolve(String(next.value || '').trim());
      index += next.consumed;
      continue;
    }
    if (token === '--token' || token.startsWith('--token=')) {
      const next = readOptionValue(argv, index, '--token');
      options.token = String(next.value || '').trim();
      index += next.consumed;
      continue;
    }
    if (token === '--token-file' || token.startsWith('--token-file=')) {
      const next = readOptionValue(argv, index, '--token-file');
      options.tokenFile = path.resolve(String(next.value || '').trim());
      index += next.consumed;
      continue;
    }
    if (token === '--timeout-ms' || token.startsWith('--timeout-ms=')) {
      const next = readOptionValue(argv, index, '--timeout-ms');
      options.timeoutMs = parsePositiveInteger(next.value, '--timeout-ms', undefined, 1000, 120000);
      index += next.consumed;
      continue;
    }
    if (token === '--session-provider' || token.startsWith('--session-provider=')) {
      const next = readOptionValue(argv, index, '--session-provider');
      options.sessionProvider = String(next.value || '').trim().toLowerCase();
      index += next.consumed;
      continue;
    }
    if (token === '--session-account-ref' || token.startsWith('--session-account-ref=')) {
      const next = readOptionValue(argv, index, '--session-account-ref');
      options.sessionAccountRef = String(next.value || '').trim();
      index += next.consumed;
      continue;
    }
    if (token === '--session-model' || token.startsWith('--session-model=')) {
      const next = readOptionValue(argv, index, '--session-model');
      options.sessionModel = String(next.value || '').trim();
      index += next.consumed;
      continue;
    }
    if (token === '--session-project' || token.startsWith('--session-project=')) {
      const next = readOptionValue(argv, index, '--session-project');
      options.sessionProjectPath = String(next.value || '').trim();
      index += next.consumed;
      continue;
    }
    if (token === '--session-prompt' || token.startsWith('--session-prompt=')) {
      const next = readOptionValue(argv, index, '--session-prompt');
      options.sessionPrompt = String(next.value || '');
      index += next.consumed;
      continue;
    }
    if (token === '--expect-output' || token.startsWith('--expect-output=')) {
      const next = readOptionValue(argv, index, '--expect-output');
      options.expectOutput = String(next.value || '').trim();
      index += next.consumed;
      continue;
    }
    if (token === '--session-timeout-ms' || token.startsWith('--session-timeout-ms=')) {
      const next = readOptionValue(argv, index, '--session-timeout-ms');
      options.sessionTimeoutMs = parsePositiveInteger(next.value, '--session-timeout-ms');
      index += next.consumed;
      continue;
    }
    throw new Error(`unknown option: ${token}`);
  }

  if (options.help) return options;
  options.endpoint = normalizeHttpEndpoint(options.endpoint, '--endpoint');
  options.localUrl = options.localUrl ? normalizeHttpEndpoint(options.localUrl, '--local-url') : options.endpoint;
  options.clientEndpoint = options.clientEndpoint
    ? normalizeHttpEndpoint(options.clientEndpoint, '--client-endpoint')
    : brokerProxyBase(options.endpoint, options.serverId);
  options.serverId = normalizeFabricServerId(options.serverId);
  if (!options.serverId) throw new Error('--server-id must match Fabric server id rules');
  if (!/^[a-z0-9][a-z0-9_.-]{1,63}$/.test(options.nodeId)) {
    throw new Error('--node-id must match AIH remote node id rules');
  }
  if (!options.token && !options.tokenFile) {
    throw new Error('missing broker token: set AIH_FABRIC_BROKER_TOKEN, --token, or --token-file');
  }
  if (!options.hostHome) throw new Error('--host-home is required');
  if (options.sessionAccountRef && !isAccountRef(options.sessionAccountRef)) {
    throw new Error('--session-account-ref must be a valid accountRef');
  }
  return options;
}

function readBrokerToken(options = {}, deps = {}) {
  if (options.token) return String(options.token).trim();
  if (!options.tokenFile) return '';
  const fsImpl = deps.fs || fs;
  return String(fsImpl.readFileSync(options.tokenFile, 'utf8') || '').trim();
}

async function runBrokerRelaySmoke(rawOptions = {}, deps = {}) {
  const options = {
    endpoint: DEFAULT_ENDPOINT,
    localUrl: '',
    clientEndpoint: '',
    serverId: DEFAULT_SERVER_ID,
    nodeId: DEFAULT_NODE_ID,
    hostHome: '',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    sessionTimeoutMs: DEFAULT_SESSION_TIMEOUT_MS,
    ...rawOptions
  };
  const endpoint = normalizeHttpEndpoint(options.endpoint, '--endpoint');
  const serverId = normalizeFabricServerId(options.serverId);
  const localUrl = options.localUrl ? normalizeHttpEndpoint(options.localUrl, '--local-url') : endpoint;
  const clientEndpoint = options.clientEndpoint
    ? normalizeHttpEndpoint(options.clientEndpoint, '--client-endpoint')
    : brokerProxyBase(endpoint, serverId);
  const brokerToken = readBrokerToken(options, deps);
  if (!brokerToken) throw new Error('missing broker token');

  const startedAt = Date.now();
  const connect = deps.connectFabricBroker || connectFabricBroker;
  const runRelay = deps.runExistingEndpointRelaySmoke || runExistingEndpointRelaySmoke;
  const wsImpl = deps.WebSocket || WebSocket;
  let brokerHandle = null;

  try {
    brokerHandle = await connect({
      brokerUrl: endpoint,
      serverId,
      token: brokerToken,
      localUrl,
      connectTimeoutMs: options.timeoutMs,
      requestTimeoutMs: options.timeoutMs,
      heartbeatMs: 1000
    }, { WebSocket: wsImpl });

    const relay = await runRelay({
      ...options,
      endpoint,
      localUrl,
      clientEndpoint,
      serverId,
      nodeId: options.nodeId,
      timeoutMs: options.timeoutMs
    }, deps.relayDeps || deps);

    return {
      ok: Boolean(relay && relay.ok),
      mode: 'existing-endpoint-broker-relay',
      endpoint,
      proxyBase: clientEndpoint,
      serverId,
      localUrl,
      nodeId: options.nodeId,
      broker: {
        connected: Boolean(brokerHandle),
        sessionId: String(brokerHandle && brokerHandle.sessionId || '')
      },
      relay,
      durationMs: Date.now() - startedAt
    };
  } finally {
    if (brokerHandle && typeof brokerHandle.close === 'function') brokerHandle.close();
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(`[aih] ${String((error && error.message) || error)}`);
    console.error('Usage: node scripts/fabric-real-broker-relay-smoke.js [--endpoint URL] [--server-id ID] [--token-file PATH]');
    process.exitCode = 1;
    return;
  }
  if (options.help) {
    showHelp();
    return;
  }
  try {
    const result = await runBrokerRelaySmoke(options);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.log(JSON.stringify({
      ok: false,
      error: String((error && error.message) || error || 'fabric_broker_relay_smoke_failed')
    }, null, 2));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  readBrokerToken,
  runBrokerRelaySmoke
};
