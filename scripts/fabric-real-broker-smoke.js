#!/usr/bin/env node
'use strict';

const WebSocket = require('ws');

const {
  connectFabricBroker
} = require('../lib/cli/services/fabric/broker-connect');
const { normalizeFabricServerId } = require('../lib/server/fabric-broker-session-registry');

const DEFAULT_ENDPOINT = 'http://127.0.0.1:9527';
const DEFAULT_SERVER_ID = 'broker-smoke-server';
const DEFAULT_TIMEOUT_MS = 10000;

function showHelp() {
  console.log(`AIH Fabric real broker smoke

Usage:
  AIH_FABRIC_BROKER_TOKEN=<token> AIH_MANAGEMENT_KEY=<key> node scripts/fabric-real-broker-smoke.js [options]

Options:
  --endpoint <url>      Running AIH server/broker endpoint, default ${DEFAULT_ENDPOINT}.
  --server-id <id>      Broker server id, default ${DEFAULT_SERVER_ID}.
  --local-url <url>     Local AIH server URL reached by broker connector, default endpoint.
  --token <token>       Broker token. Prefer AIH_FABRIC_BROKER_TOKEN to avoid argv leaks.
  --management-key <key>
                        Server Management Key. Prefer AIH_MANAGEMENT_KEY to avoid argv leaks.
  --timeout-ms <n>      Request/connect timeout, default ${DEFAULT_TIMEOUT_MS}.
  -h, --help            Show this help.

This script does not start a server, allocate a product port, install services,
or modify firewall/systemd. It connects an outbound broker link to an already
running endpoint and calls that same endpoint through the broker proxy.
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
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad_protocol');
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch (_error) {
    throw new Error(`${flag} must be a valid http(s) URL`);
  }
}

function parsePositiveInteger(value, flag, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1000 || number > 180000) {
    if (fallback !== undefined) return fallback;
    throw new Error(`${flag} must be an integer between 1000 and 180000`);
  }
  return number;
}

function parseArgs(argv = [], env = process.env) {
  const options = {
    help: false,
    endpoint: DEFAULT_ENDPOINT,
    localUrl: '',
    serverId: DEFAULT_SERVER_ID,
    token: String(env.AIH_FABRIC_BROKER_TOKEN || '').trim(),
    managementKey: String(env.AIH_MANAGEMENT_KEY || '').trim(),
    timeoutMs: DEFAULT_TIMEOUT_MS
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
    if (token === '--server-id' || token.startsWith('--server-id=')) {
      const next = readOptionValue(argv, index, '--server-id');
      options.serverId = normalizeFabricServerId(next.value);
      index += next.consumed;
      continue;
    }
    if (token === '--token' || token.startsWith('--token=')) {
      const next = readOptionValue(argv, index, '--token');
      options.token = String(next.value || '').trim();
      index += next.consumed;
      continue;
    }
    if (token === '--management-key' || token.startsWith('--management-key=')) {
      const next = readOptionValue(argv, index, '--management-key');
      options.managementKey = String(next.value || '').trim();
      index += next.consumed;
      continue;
    }
    if (token === '--timeout-ms' || token.startsWith('--timeout-ms=')) {
      const next = readOptionValue(argv, index, '--timeout-ms');
      options.timeoutMs = parsePositiveInteger(next.value, '--timeout-ms');
      index += next.consumed;
      continue;
    }
    throw new Error(`unknown option: ${token}`);
  }

  if (options.help) return options;
  options.endpoint = normalizeHttpEndpoint(options.endpoint, '--endpoint');
  options.localUrl = options.localUrl ? normalizeHttpEndpoint(options.localUrl, '--local-url') : options.endpoint;
  options.serverId = normalizeFabricServerId(options.serverId);
  if (!options.serverId) throw new Error('--server-id must match Fabric server id rules');
  if (!options.token) throw new Error('missing broker token: set AIH_FABRIC_BROKER_TOKEN or pass --token');
  if (!options.managementKey) {
    throw new Error('missing Management Key: set AIH_MANAGEMENT_KEY or pass --management-key');
  }
  return options;
}

function brokerProxyBase(endpoint, serverId) {
  return `${endpoint.replace(/\/+$/, '')}/v0/fabric/broker/servers/${encodeURIComponent(serverId)}/proxy`;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch (_error) {
    body = { raw: text };
  }
  return {
    status: response.status,
    ok: response.ok,
    body
  };
}

async function runBrokerSmoke(options = {}) {
  const startedAt = Date.now();
  let brokerHandle = null;
  const endpoint = options.endpoint.replace(/\/+$/, '');
  const proxyBase = brokerProxyBase(endpoint, options.serverId);

  try {
    try {
      brokerHandle = await connectFabricBroker({
        brokerUrl: endpoint,
        serverId: options.serverId,
        token: options.token,
        localUrl: options.localUrl,
        connectTimeoutMs: options.timeoutMs,
        requestTimeoutMs: options.timeoutMs,
        heartbeatMs: 1000
      }, { WebSocket });
    } catch (error) {
      error.phase = 'broker_connect';
      throw error;
    }

    const readyz = await fetchJson(`${proxyBase}/readyz`);
    if (readyz.status !== 200 || !readyz.body || readyz.body.ok !== true) {
      throw Object.assign(new Error('broker_readyz_failed'), { phase: 'readyz', readyz });
    }

    const descriptor = await fetchJson(`${proxyBase}/v0/fabric/descriptor`);
    if (descriptor.status !== 200 || !descriptor.body || descriptor.body.ok !== true) {
      throw Object.assign(new Error('broker_descriptor_failed'), { phase: 'descriptor', descriptor });
    }

    const clientProfile = await fetchJson(`${proxyBase}/v0/node-rpc/device-profile`, {
      headers: {
        authorization: `Bearer ${options.managementKey}`
      }
    });
    if (clientProfile.status !== 200 || !clientProfile.body || clientProfile.body.ok !== true) {
      throw Object.assign(new Error('broker_management_auth_failed'), {
        phase: 'management_auth',
        clientProfile
      });
    }

    return {
      ok: true,
      mode: 'existing-endpoint-broker',
      endpoint,
      proxyBase,
      serverId: options.serverId,
      localUrl: options.localUrl,
      sessionId: brokerHandle.sessionId,
      durationMs: Date.now() - startedAt,
      checks: {
        readyz: { status: readyz.status, ready: Boolean(readyz.body && readyz.body.ready) },
        descriptor: {
          status: descriptor.status,
          service: descriptor.body && descriptor.body.result ? descriptor.body.result.service : ''
        },
        managementAuth: {
          status: clientProfile.status,
          via: 'management_key'
        }
      }
    };
  } finally {
    if (brokerHandle && typeof brokerHandle.close === 'function') brokerHandle.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2), process.env);
  if (options.help) {
    showHelp();
    return;
  }
  try {
    const result = await runBrokerSmoke(options);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    const payload = {
      ok: false,
      error: String((error && error.message) || error || 'fabric_broker_smoke_failed'),
      phase: String((error && error.phase) || 'unknown')
    };
    console.log(JSON.stringify(payload, null, 2));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  brokerProxyBase,
  parseArgs,
  runBrokerSmoke
};
