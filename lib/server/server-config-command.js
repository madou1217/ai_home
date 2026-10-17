'use strict';

const crypto = require('node:crypto');

const {
  DEFAULT_SERVER_CONFIG,
  mergeServerConfigPatch,
  normalizeUpstreamErrorRuleProviders
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

// 窗口激活的间隔（毫秒）：下限 1 分钟（与调度器一致），上限一年（防手滑写成天文数字）。
function parseIntervalMs(value, flag) {
  const text = String(value || '').trim();
  if (!/^\d+$/.test(text)) throw new Error(`Invalid ${flag} value`);
  const ms = Number(text);
  if (!Number.isFinite(ms) || ms < 60 * 1000 || ms > 365 * 24 * 60 * 60 * 1000) {
    throw new Error(`Invalid ${flag} value`);
  }
  return Math.floor(ms);
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
    showSecrets: false,
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
    if (flag === '--help' || flag === '-h') {
      options.help = true;
      index += 1;
      continue;
    }
    if (flag === '--json') {
      options.json = true;
      index += 1;
      continue;
    }
    if (flag === '--show-secrets') {
      options.showSecrets = true;
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
    if (flag === '--go-core') {
      setPatchValue(patch, 'goCoreEnabled', true, touched);
      index += 1;
      continue;
    }
    if (flag === '--no-go-core') {
      setPatchValue(patch, 'goCoreEnabled', false, touched);
      index += 1;
      continue;
    }
    if (flag === '--clear-go-core-routes') {
      setPatchValue(patch, 'goCoreRoutes', [], touched);
      index += 1;
      continue;
    }
    if (flag === '--go-core-routes') {
      const next = readOptionValue(args, index, '--go-core-routes');
      setPatchValue(patch, 'goCoreRoutes', String(next.value).split(',').map((item) => item.trim()).filter(Boolean), touched);
      index += next.consumed;
      continue;
    }
    // 声明 Go 承接哪些 Provider 的账号自定义错误规则（同 AIH_SERVER_UPSTREAM_ERROR_RULES 语义）。
    if (flag === '--clear-upstream-error-rules') {
      setPatchValue(patch, 'upstreamErrorRuleProviders', [], touched);
      index += 1;
      continue;
    }
    // 窗口激活的全局 opt-in（同 AIH_SERVER_WINDOW_ACTIVATION 语义）。逐账号开关是第二道
    // 闸门；这一道关着时，账号页打开「窗口激活」也不会发任何探测。
    if (flag === '--window-activation') {
      setPatchValue(patch, 'windowActivation', true, touched);
      index += 1;
      continue;
    }
    if (flag === '--no-window-activation') {
      setPatchValue(patch, 'windowActivation', false, touched);
      index += 1;
      continue;
    }
    // 全局默认间隔 / 间隔下限（毫秒）。下限不得小于 1 分钟，默认间隔自动抬到下限之上。
    if (flag === '--window-activation-default-interval-ms') {
      const next = readOptionValue(args, index, '--window-activation-default-interval-ms');
      setPatchValue(patch, 'windowActivationDefaultIntervalMs', parseIntervalMs(next.value, flag), touched);
      index += next.consumed;
      continue;
    }
    if (flag === '--window-activation-min-interval-ms') {
      const next = readOptionValue(args, index, '--window-activation-min-interval-ms');
      setPatchValue(patch, 'windowActivationMinIntervalMs', parseIntervalMs(next.value, flag), touched);
      index += next.consumed;
      continue;
    }
    if (flag === '--upstream-error-rules') {
      const next = readOptionValue(args, index, '--upstream-error-rules');
      setPatchValue(
        patch,
        'upstreamErrorRuleProviders',
        normalizeUpstreamErrorRuleProviders(next.value),
        touched
      );
      index += next.consumed;
      continue;
    }
    if (flag === '--relay-udp') {
      const next = readOptionValue(args, index, '--relay-udp');
      const value = String(next.value || '').trim().toLowerCase();
      if (!['on', 'off', 'default'].includes(value)) {
        throw new Error('--relay-udp 只接受 on / off / default');
      }
      setPatchValue(patch, 'relayUdp', value, touched);
      index += next.consumed;
      continue;
    }
    if (flag === '--relay-udp-advertise-host') {
      const next = readOptionValue(args, index, '--relay-udp-advertise-host');
      setPatchValue(patch, 'relayUdpAdvertiseHost', String(next.value || '').trim(), touched);
      index += next.consumed;
      continue;
    }
    if (flag === '--clear-relay-udp-advertise-host') {
      setPatchValue(patch, 'relayUdpAdvertiseHost', '', touched);
      index += 1;
      continue;
    }
    if (flag === '--relay-udp-advertise-port') {
      const next = readOptionValue(args, index, '--relay-udp-advertise-port');
      setPatchValue(patch, 'relayUdpAdvertisePort', parsePort(next.value, '--relay-udp-advertise-port'), touched);
      index += next.consumed;
      continue;
    }
    if (flag === '--clear-relay-udp-advertise-port') {
      setPatchValue(patch, 'relayUdpAdvertisePort', 0, touched);
      index += 1;
      continue;
    }
    if (flag === '--relay-port-mode') {
      const next = readOptionValue(args, index, '--relay-port-mode');
      const value = String(next.value || '').trim().toLowerCase();
      if (!['server', 'dedicated', 'default'].includes(value)) {
        throw new Error('--relay-port-mode 只接受 server / dedicated / default');
      }
      setPatchValue(patch, 'relayPortMode', value, touched);
      index += next.consumed;
      continue;
    }
    if (flag === '--relay-listen-host') {
      const next = readOptionValue(args, index, '--relay-listen-host');
      setPatchValue(patch, 'relayListenHost', String(next.value || '').trim(), touched);
      index += next.consumed;
      continue;
    }
    if (flag === '--clear-relay-listen-host') {
      setPatchValue(patch, 'relayListenHost', '', touched);
      index += 1;
      continue;
    }
    if (flag === '--max-attempts') {
      const next = readOptionValue(args, index, '--max-attempts');
      const value = Number(String(next.value || '').trim());
      if (!Number.isInteger(value) || value < 1 || value > 32) {
        throw new Error('--max-attempts 只接受 1..32 的整数');
      }
      setPatchValue(patch, 'maxAttempts', value, touched);
      index += next.consumed;
      continue;
    }
    if (flag === '--clear-max-attempts') {
      setPatchValue(patch, 'maxAttempts', 0, touched);
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
    modelsProbeAccounts: merged.modelsProbeAccounts,
    windowActivation: merged.windowActivation === true,
    windowActivationDefaultIntervalMs: merged.windowActivationDefaultIntervalMs,
    windowActivationMinIntervalMs: merged.windowActivationMinIntervalMs,
    goCoreEnabled: merged.goCoreEnabled,
    goCoreRoutes: merged.goCoreRoutes,
    upstreamErrorRuleProviders: merged.upstreamErrorRuleProviders,
    relayUdp: merged.relayUdp,
    relayUdpAdvertiseHost: merged.relayUdpAdvertiseHost,
    relayUdpAdvertisePort: merged.relayUdpAdvertisePort,
    relayPortMode: merged.relayPortMode,
    relayListenHost: merged.relayListenHost,
    maxAttempts: merged.maxAttempts
  };
}

function printServerConfig(config, options = {}) {
  const out = toPublicServerConfig(config);
  const secrets = options.showSecrets ? mergeServerConfigPatch(DEFAULT_SERVER_CONFIG, config) : null;
  if (options.json) {
    console.log(JSON.stringify({
      config: secrets ? { ...out, apiKey: secrets.apiKey, managementKey: secrets.managementKey } : out
    }, null, 2));
    return;
  }
  console.log('\x1b[36m[aih]\x1b[0m server config');
  console.log(`  host: ${out.host}`);
  console.log(`  port: ${out.port}`);
  console.log(`  open_network: ${out.openNetwork}`);
  console.log(`  base_url: ${out.baseUrl}`);
  console.log(`  api_key: ${secrets ? (secrets.apiKey || 'missing') : (out.apiKeyConfigured ? 'configured' : 'missing')}`);
  console.log(`  management_key: ${secrets ? (secrets.managementKey || 'missing') : (out.managementKeyConfigured ? 'configured' : 'missing')}`);
  if (out.proxyUrl) console.log(`  proxy_url: ${out.proxyUrl}`);
  if (out.noProxy) console.log(`  no_proxy: ${out.noProxy}`);
  console.log(`  models_probe_accounts: ${out.modelsProbeAccounts}`);
  console.log(`  window_activation: ${out.windowActivation ? 'enabled' : 'disabled'}`);
  if (out.windowActivation) {
    console.log(`  window_activation_default_interval_ms: ${out.windowActivationDefaultIntervalMs}`);
    console.log(`  window_activation_min_interval_ms: ${out.windowActivationMinIntervalMs}`);
  }
  console.log(`  go_core: ${out.goCoreEnabled ? 'enabled' : 'disabled'}`);
  if (out.goCoreRoutes.length > 0) console.log(`  go_core_routes: ${out.goCoreRoutes.join(',')}`);
  console.log(`  relay_udp: ${out.relayUdp === 'default' ? 'default (env / on)' : out.relayUdp}`);
  if (out.relayUdpAdvertiseHost) console.log(`  relay_udp_advertise_host: ${out.relayUdpAdvertiseHost}`);
  if (out.relayUdpAdvertisePort) console.log(`  relay_udp_advertise_port: ${out.relayUdpAdvertisePort}`);
  console.log(`  relay_port_mode: ${out.relayPortMode === 'default' ? 'default (server)' : out.relayPortMode}`);
  if (out.relayListenHost) console.log(`  relay_listen_host: ${out.relayListenHost}`);
  console.log(`  max_attempts: ${out.maxAttempts || '3 (default)'}`);
  console.log(
    `  upstream_error_rules: ${out.upstreamErrorRuleProviders.length > 0
      ? out.upstreamErrorRuleProviders.join(',')
      : 'disabled (Node executes every account rule)'}`
  );
}

function printConfigUsage() {
  console.log('\x1b[90mUsage:\x1b[0m aih server config [show|get|set] [--show-secrets] [--json] [--host <ip>] [--port <n>] [--client-key <key>] [--management-key <key>|--generate-management-key] [--open-network|--local-only] [--window-activation|--no-window-activation] [--window-activation-default-interval-ms <ms>] [--window-activation-min-interval-ms <ms>] [--go-core|--no-go-core] [--go-core-routes <entry-ids>|--clear-go-core-routes] [--upstream-error-rules <providers>|--clear-upstream-error-rules] [--relay-udp on|off|default] [--relay-udp-advertise-host <host>|--clear-relay-udp-advertise-host] [--relay-udp-advertise-port <port>|--clear-relay-udp-advertise-port] [--max-attempts <1..32>|--clear-max-attempts] [--relay-port-mode server|dedicated|default] [--relay-listen-host <host>|--clear-relay-listen-host]');
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

  if (parsed.help) {
    printConfigUsage();
    return 0;
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
      config: parsed.showSecrets
        ? { ...toPublicServerConfig(saved), apiKey: saved.apiKey, managementKey: saved.managementKey }
        : toPublicServerConfig(saved)
    }, null, 2));
    return 0;
  }

  printServerConfig(saved, parsed);
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
