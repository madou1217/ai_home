#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const {
  createControlPlaneDeviceInvite,
  revokeControlPlaneDevice
} = require('../lib/server/control-plane-device-pairing');
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
  AIH_FABRIC_BROKER_TOKEN=<token> node scripts/fabric-real-broker-smoke.js [options]

Options:
  --endpoint <url>      Running AIH server/broker endpoint, default ${DEFAULT_ENDPOINT}.
  --server-id <id>      Broker server id, default ${DEFAULT_SERVER_ID}.
  --local-url <url>     Local AIH server URL reached by broker connector, default endpoint.
  --host-home <dir>     Host home for the running server, default AIH_HOST_HOME/HOME.
  --token <token>       Broker token. Prefer AIH_FABRIC_BROKER_TOKEN to avoid argv leaks.
  --timeout-ms <n>      Request/connect timeout, default ${DEFAULT_TIMEOUT_MS}.
  --skip-pair           Only verify broker readyz/descriptor, do not create a device invite.
  --keep-device         Keep the paired smoke device instead of revoking it after success.
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
    hostHome: String(env.AIH_HOST_HOME || env.HOME || os.homedir() || '').trim(),
    serverId: DEFAULT_SERVER_ID,
    token: String(env.AIH_FABRIC_BROKER_TOKEN || '').trim(),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    skipPair: false,
    keepDevice: false
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
    if (token === '--skip-pair') {
      options.skipPair = true;
      index += 1;
      continue;
    }
    if (token === '--keep-device') {
      options.keepDevice = true;
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
    if (token === '--host-home' || token.startsWith('--host-home=')) {
      const next = readOptionValue(argv, index, '--host-home');
      options.hostHome = path.resolve(String(next.value || '').trim());
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
  if (!options.skipPair && !options.hostHome) throw new Error('--host-home is required unless --skip-pair is set');
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

function createSmokeInvite(options) {
  const aiHomeDir = path.join(options.hostHome, '.ai_home');
  const suffix = Date.now().toString(36);
  const invite = createControlPlaneDeviceInvite({
    id: `broker-smoke-${suffix}`,
    name: 'Broker Smoke Device',
    controlEndpoint: options.endpoint,
    expiresInMs: 5 * 60 * 1000
  }, { fs, aiHomeDir });
  return {
    aiHomeDir,
    invite
  };
}

async function runBrokerSmoke(options = {}) {
  const startedAt = Date.now();
  let brokerHandle = null;
  let inviteInfo = null;
  let pairedDeviceId = '';
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

    let pair = null;
    if (!options.skipPair) {
      inviteInfo = createSmokeInvite(options);
      pair = await fetchJson(`${proxyBase}/v0/fabric/device-pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: inviteInfo.invite.code,
          device: {
            id: `broker-smoke-device-${Date.now().toString(36)}`,
            name: 'Broker Smoke Device',
            platform: `${process.platform}/${process.arch}`
          }
        })
      });
      if (pair.status !== 200 || !pair.body || pair.body.ok !== true) {
        throw Object.assign(new Error('broker_device_pair_failed'), { phase: 'device_pair', pair });
      }
      pairedDeviceId = pair.body.result && pair.body.result.device ? pair.body.result.device.id : '';
      if (pairedDeviceId && !options.keepDevice) {
        try {
          revokeControlPlaneDevice(pairedDeviceId, { fs, aiHomeDir: inviteInfo.aiHomeDir });
        } catch (_error) {}
      }
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
        devicePair: pair ? {
          status: pair.status,
          deviceId: pairedDeviceId,
          cleanup: options.keepDevice ? 'kept' : 'revoked'
        } : { skipped: true }
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
