'use strict';

const crypto = require('node:crypto');

const {
  DEFAULT_SERVER_CONFIG,
  mergeServerConfigPatch
} = require('./server-config-store');
const { buildServerBaseUrl } = require('./server-defaults');

function isFlag(value) {
  return String(value || '').startsWith('-');
}

function splitInlineOption(value) {
  const text = String(value || '').trim();
  const index = text.indexOf('=');
  if (index <= 0) return null;
  return {
    key: text.slice(0, index),
    value: text.slice(index + 1)
  };
}

function readOptionValue(args, index, flag) {
  const inline = splitInlineOption(args[index]);
  if (inline) return { value: inline.value, consumed: 1 };
  const value = args[index + 1];
  if (value === undefined || isFlag(value)) {
    throw new Error(`Invalid ${flag} value`);
  }
  return { value: String(value), consumed: 2 };
}

function parsePort(value, flag) {
  const text = String(value || '').trim();
  if (!/^\d+$/.test(text)) throw new Error(`Invalid ${flag} value`);
  const port = Number(text);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid ${flag} value`);
  }
  return port;
}

function parseModelsProbeAccounts(value, flag) {
  const text = String(value || '').trim();
  if (!/^\d+$/.test(text)) throw new Error(`Invalid ${flag} value`);
  const count = Number(text);
  if (!Number.isInteger(count) || count < 1 || count > 8) {
    throw new Error(`Invalid ${flag} value`);
  }
  return count;
}

function generateManagementKey() {
  return crypto.randomBytes(32).toString('base64url');
}

function setPatchValue(patch, key, value, touched) {
  patch[key] = value;
  touched.add(key);
}

function parseServerConfigArgs(rawArgs = [], deps = {}) {
  const args = Array.isArray(rawArgs) ? rawArgs.map((item) => String(item)) : [];
  const patch = {};
  const touched = new Set();
  const options = {
    json: false,
    patch,
    hasPatch: false
  };

  let index = 0;
  const subcommand = String(args[0] || '').trim().toLowerCase();
  if (subcommand === 'show' || subcommand === 'get' || subcommand === 'set') {
    index = 1;
  }

  while (index < args.length) {
    const token = String(args[index] || '').trim();
    const inline = splitInlineOption(token);
    const flag = inline ? inline.key : token;
    if (!flag) {
      index += 1;
      continue;
    }
    if (flag === '--json') {
      options.json = true;
      index += 1;
      continue;
    }
    if (flag === '--open-network') {
      setPatchValue(patch, 'openNetwork', true, touched);
      index += 1;
      continue;
    }
    if (flag === '--local-only') {
      setPatchValue(patch, 'openNetwork', false, touched);
      index += 1;
      continue;
    }
    if (flag === '--clear-api-key' || flag === '--clear-client-key') {
      setPatchValue(patch, 'apiKey', '', touched);
      index += 1;
      continue;
    }
    if (flag === '--clear-management-key') {
      setPatchValue(patch, 'managementKey', '', touched);
      index += 1;
      continue;
    }
    if (flag === '--generate-management-key') {
      const generator = typeof deps.generateManagementKey === 'function'
        ? deps.generateManagementKey
        : generateManagementKey;
      const key = String(generator() || '').trim();
      if (!key) throw new Error('Generated management key is empty');
      setPatchValue(patch, 'managementKey', key, touched);
      index += 1;
      continue;
    }
    if (flag === '--clear-proxy-url' || flag === '--clear-proxy') {
      setPatchValue(patch, 'proxyUrl', '', touched);
      index += 1;
      continue;
    }
    if (flag === '--clear-no-proxy') {
      setPatchValue(patch, 'noProxy', '', touched);
      index += 1;
      continue;
    }
    if (flag === '--host') {
      const next = readOptionValue(args, index, '--host');
      setPatchValue(patch, 'host', String(next.value).trim(), touched);
      index += next.consumed;
      continue;
    }
    if (flag === '--port') {
      const next = readOptionValue(args, index, '--port');
      setPatchValue(patch, 'port', parsePort(next.value, '--port'), touched);
      index += next.consumed;
      continue;
    }
    if (flag === '--api-key' || flag === '--client-key') {
      const next = readOptionValue(args, index, flag);
      setPatchValue(patch, 'apiKey', String(next.value).trim(), touched);
      index += next.consumed;
      continue;
    }
    if (flag === '--management-key') {
      const next = readOptionValue(args, index, '--management-key');
      setPatchValue(patch, 'managementKey', String(next.value).trim(), touched);
      index += next.consumed;
      continue;
    }
    if (flag === '--proxy-url') {
      const next = readOptionValue(args, index, '--proxy-url');
      setPatchValue(patch, 'proxyUrl', String(next.value).trim(), touched);
      index += next.consumed;
      continue;
    }
    if (flag === '--no-proxy') {
      const next = readOptionValue(args, index, '--no-proxy');
      setPatchValue(patch, 'noProxy', String(next.value).trim(), touched);
      index += next.consumed;
      continue;
    }
    if (flag === '--models-probe-accounts') {
      const next = readOptionValue(args, index, '--models-probe-accounts');
      setPatchValue(
        patch,
        'modelsProbeAccounts',
        parseModelsProbeAccounts(next.value, '--models-probe-accounts'),
        touched
      );
      index += next.consumed;
      continue;
    }
    throw new Error(`Unknown server config option: ${flag}`);
  }

  options.hasPatch = touched.size > 0 || subcommand === 'set';
  return options;
}

function toPublicServerConfig(config = {}) {
  const merged = mergeServerConfigPatch(DEFAULT_SERVER_CONFIG, config);
  return {
    host: merged.host,
    port: merged.port,
    openNetwork: merged.openNetwork,
    baseUrl: buildServerBaseUrl(merged),
    apiKeyConfigured: Boolean(merged.apiKey),
    managementKeyConfigured: Boolean(merged.managementKey),
    proxyUrl: merged.proxyUrl,
    noProxy: merged.noProxy,
    modelsProbeAccounts: merged.modelsProbeAccounts
  };
}

function printServerConfig(config, options = {}) {
  const out = toPublicServerConfig(config);
  if (options.json) {
    console.log(JSON.stringify({ config: out }, null, 2));
    return;
  }
  console.log('\x1b[36m[aih]\x1b[0m server config');
  console.log(`  host: ${out.host}`);
  console.log(`  port: ${out.port}`);
  console.log(`  open_network: ${out.openNetwork}`);
  console.log(`  base_url: ${out.baseUrl}`);
  console.log(`  api_key: ${out.apiKeyConfigured ? 'configured' : 'missing'}`);
  console.log(`  management_key: ${out.managementKeyConfigured ? 'configured' : 'missing'}`);
  if (out.proxyUrl) console.log(`  proxy_url: ${out.proxyUrl}`);
  if (out.noProxy) console.log(`  no_proxy: ${out.noProxy}`);
  console.log(`  models_probe_accounts: ${out.modelsProbeAccounts}`);
}

function printConfigUsage() {
  console.log('\x1b[90mUsage:\x1b[0m aih server config [set] [--host <ip>] [--port <n>] [--client-key <key>] [--management-key <key>|--generate-management-key] [--open-network|--local-only]');
}

async function runServerConfigCommand(args, deps = {}) {
  let parsed;
  try {
    parsed = parseServerConfigArgs(args, deps);
  } catch (e) {
    console.error(`\x1b[31m[aih] ${e.message}\x1b[0m`);
    printConfigUsage();
    return 1;
  }

  if (typeof deps.readServerConfig !== 'function') {
    console.error('\x1b[31m[aih] server config reader is not wired\x1b[0m');
    return 1;
  }

  if (!parsed.hasPatch) {
    printServerConfig(deps.readServerConfig(), parsed);
    return 0;
  }

  if (typeof deps.writeServerConfig !== 'function') {
    console.error('\x1b[31m[aih] server config writer is not wired\x1b[0m');
    return 1;
  }

  const saved = deps.writeServerConfig(parsed.patch);
  if (parsed.json) {
    console.log(JSON.stringify({
      saved: true,
      restartRequired: true,
      config: toPublicServerConfig(saved)
    }, null, 2));
    return 0;
  }

  printServerConfig(saved);
  console.log('\x1b[33m[aih]\x1b[0m server config saved; run `aih server restart` to apply it.');
  if (saved.openNetwork && !saved.apiKey) {
    console.log('\x1b[33m[aih]\x1b[0m open network without --client-key exposes the API to reachable peers.');
  }
  if (saved.openNetwork && !saved.managementKey) {
    console.log('\x1b[33m[aih]\x1b[0m set --management-key before relay or remote management.');
  }
  return 0;
}

module.exports = {
  parseServerConfigArgs,
  runServerConfigCommand,
  toPublicServerConfig
};
