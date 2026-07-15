'use strict';

const {
  DEFAULT_ENDPOINT,
  DEFAULT_RPC_SAMPLE_COUNT,
  runWebrtcDatachannelSmoke
} = require('../../../../scripts/fabric-real-webrtc-datachannel-smoke');
const {
  classifyTurnRelay
} = require('../../../../scripts/fabric-m6-promotion-gate');
const {
  applyTransportConfigDefaults
} = require('./transport-config');
const {
  isBrowserUnavailableError
} = require('./transport-webtransport');

const DEFAULT_PAGE_PATH = '/ui/';
const DEFAULT_SAMPLE_COUNT = 5;
const DEFAULT_TIMEOUT_MS = 30000;

function isFlag(value) {
  return String(value || '').startsWith('-');
}

function readOptionValue(args, index, flag) {
  const token = String(args[index] || '');
  const prefix = `${flag}=`;
  if (token.startsWith(prefix)) return { value: token.slice(prefix.length), consumed: 1 };
  const value = args[index + 1];
  if (value === undefined || isFlag(value)) throw new Error(`${flag} requires a value`);
  return { value: String(value), consumed: 2 };
}

function normalizeHttpUrl(value, flag) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('invalid_protocol');
    parsed.hash = '';
    return parsed.toString().replace(/\/+$/, '');
  } catch (_error) {
    throw new Error(`${flag} must be a valid http(s) URL`);
  }
}

function normalizeBrowserChannel(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  if (normalized.toLowerCase() === 'auto') return 'auto';
  if (['bundled', 'chromium', 'playwright'].includes(normalized.toLowerCase())) return '';
  return normalized;
}

function parsePositiveInteger(value, flag, fallback, min = 1, max = 240000) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${flag} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function splitList(value) {
  return String(value || '')
    .split(/[\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function envValue(env = {}, names = []) {
  for (const name of names) {
    const value = String(env[name] == null ? '' : env[name]).trim();
    if (value) return value;
  }
  return '';
}

function buildPageUrl(endpoint) {
  return `${String(endpoint || '').replace(/\/+$/, '')}${DEFAULT_PAGE_PATH}`;
}

function normalizeConfigArgAliases(args = []) {
  return (Array.isArray(args) ? args : []).map((arg) => {
    const value = String(arg || '');
    if (value === '--ice-server') return '--turn-ice-server';
    if (value.startsWith('--ice-server=')) return `--turn-ice-server=${value.slice('--ice-server='.length)}`;
    if (value === '--ice-username') return '--turn-username';
    if (value.startsWith('--ice-username=')) return `--turn-username=${value.slice('--ice-username='.length)}`;
    if (value === '--ice-credential') return '--turn-credential';
    if (value.startsWith('--ice-credential=')) return `--turn-credential=${value.slice('--ice-credential='.length)}`;
    return value;
  });
}

function parseTurnRelayCommandArgs(argv = [], env = process.env) {
  const options = {
    help: false,
    json: false,
    failOnBlocked: false,
    endpoint: DEFAULT_ENDPOINT,
    pageUrl: '',
    turnIceServers: splitList(envValue(env, ['AIH_TURN_ICE_SERVERS', 'AIH_TURN_ICE_SERVER'])),
    turnUsername: envValue(env, ['AIH_TURN_USERNAME']),
    turnCredential: envValue(env, ['AIH_TURN_CREDENTIAL']),
    sampleCount: DEFAULT_SAMPLE_COUNT,
    rpcSampleCount: DEFAULT_RPC_SAMPLE_COUNT,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    diagnosticsFile: '',
    browserChannel: 'auto',
    headed: false
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
    if (token === '--fail-on-blocked') {
      options.failOnBlocked = true;
      index += 1;
      continue;
    }
    if (token === '--headed') {
      options.headed = true;
      index += 1;
      continue;
    }
    if (token === '--endpoint' || token.startsWith('--endpoint=')) {
      const next = readOptionValue(argv, index, '--endpoint');
      options.endpoint = normalizeHttpUrl(next.value, '--endpoint');
      index += next.consumed;
      continue;
    }
    if (token === '--page-url' || token.startsWith('--page-url=')) {
      const next = readOptionValue(argv, index, '--page-url');
      options.pageUrl = normalizeHttpUrl(next.value, '--page-url');
      index += next.consumed;
      continue;
    }
    if (token === '--turn-ice-server' || token.startsWith('--turn-ice-server=') || token === '--ice-server' || token.startsWith('--ice-server=')) {
      const flag = token === '--ice-server' || token.startsWith('--ice-server=') ? '--ice-server' : '--turn-ice-server';
      const next = readOptionValue(argv, index, flag);
      options.turnIceServers.push(String(next.value || '').trim());
      index += next.consumed;
      continue;
    }
    if (token === '--turn-username' || token.startsWith('--turn-username=') || token === '--ice-username' || token.startsWith('--ice-username=')) {
      const flag = token === '--ice-username' || token.startsWith('--ice-username=') ? '--ice-username' : '--turn-username';
      const next = readOptionValue(argv, index, flag);
      options.turnUsername = String(next.value || '').trim();
      index += next.consumed;
      continue;
    }
    if (token === '--turn-credential' || token.startsWith('--turn-credential=') || token === '--ice-credential' || token.startsWith('--ice-credential=')) {
      const flag = token === '--ice-credential' || token.startsWith('--ice-credential=') ? '--ice-credential' : '--turn-credential';
      const next = readOptionValue(argv, index, flag);
      options.turnCredential = String(next.value || '');
      index += next.consumed;
      continue;
    }
    if (token === '--sample-count' || token.startsWith('--sample-count=')) {
      const next = readOptionValue(argv, index, '--sample-count');
      options.sampleCount = parsePositiveInteger(next.value, '--sample-count', DEFAULT_SAMPLE_COUNT, 1, 100);
      index += next.consumed;
      continue;
    }
    if (token === '--rpc-sample-count' || token.startsWith('--rpc-sample-count=')) {
      const next = readOptionValue(argv, index, '--rpc-sample-count');
      options.rpcSampleCount = parsePositiveInteger(next.value, '--rpc-sample-count', DEFAULT_RPC_SAMPLE_COUNT, 1, 100);
      index += next.consumed;
      continue;
    }
    if (token === '--timeout-ms' || token.startsWith('--timeout-ms=')) {
      const next = readOptionValue(argv, index, '--timeout-ms');
      options.timeoutMs = parsePositiveInteger(next.value, '--timeout-ms', DEFAULT_TIMEOUT_MS, 1000, 240000);
      index += next.consumed;
      continue;
    }
    if (token === '--diagnostics-file' || token.startsWith('--diagnostics-file=')) {
      const next = readOptionValue(argv, index, '--diagnostics-file');
      options.diagnosticsFile = String(next.value || '').trim();
      index += next.consumed;
      continue;
    }
    if (token === '--browser-channel' || token.startsWith('--browser-channel=')) {
      const next = readOptionValue(argv, index, '--browser-channel');
      options.browserChannel = normalizeBrowserChannel(next.value);
      index += next.consumed;
      continue;
    }
    throw new Error(`unknown option: ${token}`);
  }

  options.turnIceServers = Array.from(new Set(options.turnIceServers.map((item) => item.trim()).filter(Boolean)));
  if (!options.pageUrl) options.pageUrl = buildPageUrl(options.endpoint);
  return options;
}

function buildTurnConfiguration(options = {}) {
  const allUrls = Array.isArray(options.turnIceServers) ? options.turnIceServers : [];
  const turnUrls = allUrls.filter((url) => /^turns?:/i.test(String(url || '')));
  const blockers = [];
  if (allUrls.length === 0) blockers.push('turn_ice_server_not_configured');
  if (allUrls.length > 0 && turnUrls.length === 0) blockers.push('turn_ice_server_not_turn_url');
  if (turnUrls.length > 0 && !options.turnUsername) blockers.push('turn_username_missing');
  if (turnUrls.length > 0 && !options.turnCredential) blockers.push('turn_credential_missing');
  return {
    allUrls,
    turnUrls,
    usernamePresent: Boolean(options.turnUsername),
    credentialPresent: Boolean(options.turnCredential),
    configured: blockers.length === 0,
    blockers
  };
}

async function runWebrtcTurnRelaySmokeAuto(options = {}, deps = {}) {
  const runner = deps.runWebrtcDatachannelSmoke || runWebrtcDatachannelSmoke;
  const channels = options.browserChannel === 'auto' ? ['', 'chrome'] : [options.browserChannel];
  let lastError = null;

  for (let index = 0; index < channels.length; index += 1) {
    const channel = channels[index];
    try {
      return await runner({
        endpoint: options.endpoint,
        pageUrl: options.pageUrl,
        iceServerUrls: options.turnIceServers,
        iceUsername: options.turnUsername,
        iceCredential: options.turnCredential,
        iceTransportPolicy: 'relay',
        useDefaultStun: false,
        sampleCount: options.sampleCount,
        rpcSampleCount: options.rpcSampleCount,
        timeoutMs: options.timeoutMs,
        diagnosticsFile: options.diagnosticsFile,
        browserChannel: channel,
        headed: options.headed === true
      }, deps);
    } catch (error) {
      lastError = error;
      if (options.browserChannel !== 'auto' || index === channels.length - 1 || !isBrowserUnavailableError(error)) {
        throw error;
      }
    }
  }
  throw lastError || new Error('turn_relay_probe_failed');
}

function buildGate(configuration, probe = null, error = null) {
  if (!configuration.configured) {
    return {
      ran: false,
      candidateReady: false,
      promotionReady: false,
      configuration,
      blockers: configuration.blockers.slice()
    };
  }
  if (error) {
    return {
      ran: true,
      candidateReady: false,
      promotionReady: false,
      configuration,
      error: { message: String(error && error.message || error || 'turn_relay_probe_failed') },
      blockers: ['turn_relay_probe_failed']
    };
  }
  return {
    ...classifyTurnRelay(probe || {}, true),
    configuration
  };
}

async function runFabricTransportTurnRelayCommand(args = [], deps = {}) {
  const commandArgs = Array.isArray(args) ? args : [];
  const parsedOptions = parseTurnRelayCommandArgs(commandArgs, deps.env || process.env);
  const merged = (deps.applyTransportConfigDefaults || applyTransportConfigDefaults)(
    parsedOptions,
    normalizeConfigArgAliases(commandArgs),
    deps
  );
  const options = merged.options;
  const configuration = buildTurnConfiguration(options);

  let probe = null;
  let probeError = null;
  if (configuration.configured) {
    try {
      probe = await (deps.runWebrtcTurnRelaySmokeAuto || runWebrtcTurnRelaySmokeAuto)(options, deps);
    } catch (error) {
      probeError = error;
    }
  }

  const gate = buildGate(configuration, probe, probeError);
  return {
    ok: true,
    mode: 'fabric-turn-relay-diagnostics',
    endpoint: options.endpoint,
    pageUrl: options.pageUrl,
    timeoutMs: options.timeoutMs,
    browserChannel: probe && probe.browser && probe.browser.channel ? probe.browser.channel : (options.browserChannel || 'bundled'),
    probe,
    gate,
    summary: {
      candidateReady: Boolean(gate.candidateReady),
      promotionReady: Boolean(gate.promotionReady),
      blockers: Array.isArray(gate.blockers) ? gate.blockers : []
    },
    transportConfig: merged.source,
    json: options.json === true,
    exitOk: options.failOnBlocked === true ? Boolean(gate.promotionReady) : true
  };
}

function formatFabricTransportTurnRelayReport(report = {}) {
  const gate = report.gate || {};
  const config = gate.configuration || {};
  const summary = report.summary || {};
  const lines = [
    'AIH Fabric TURN relay diagnostics',
    `  endpoint: ${report.endpoint || ''}`,
    `  page_url: ${report.pageUrl || ''}`,
    `  candidate_ready: ${summary.candidateReady ? 'yes' : 'no'}`,
    `  promotion_ready: ${summary.promotionReady ? 'yes' : 'no'}`,
    `  configured: ${config.configured ? 'yes' : 'no'}`,
    `  turn_urls: ${(config.turnUrls || []).join(',') || 'none'}`,
    `  username: ${config.usernamePresent ? '<set>' : '<empty>'}`,
    `  credential: ${config.credentialPresent ? '<redacted>' : '<empty>'}`
  ];
  const blockers = Array.isArray(summary.blockers) ? summary.blockers : [];
  if (blockers.length > 0) {
    lines.push('  blockers:');
    blockers.forEach((blocker) => lines.push(`    - ${blocker}`));
  }
  if (report.transportConfig) {
    lines.push(`  transport_config: present=${report.transportConfig.present ? 'yes' : 'no'} applied=${(report.transportConfig.applied || []).join(',') || 'none'}`);
  }
  return lines.join('\n');
}

module.exports = {
  buildTurnConfiguration,
  formatFabricTransportTurnRelayReport,
  normalizeConfigArgAliases,
  parseTurnRelayCommandArgs,
  runFabricTransportTurnRelayCommand,
  runWebrtcTurnRelaySmokeAuto
};
