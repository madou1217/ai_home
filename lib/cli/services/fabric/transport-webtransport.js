'use strict';

const {
  DEFAULT_ENDPOINT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_WEBTRANSPORT_PATH,
  runWebTransportSmoke
} = require('../../../../scripts/fabric-real-webtransport-smoke');
const {
  buildHttpsUrlFromEndpoint
} = require('../../../../scripts/fabric-m6-promotion-gate');
const {
  classifyWebTransportPrerequisite
} = require('../../../../scripts/fabric-m6-prerequisite-audit');
const {
  applyTransportConfigDefaults
} = require('./transport-config');

const DEFAULT_SECURE_PROBE_PAGE_URL = 'https://example.com/';

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

function parsePositiveInteger(value, flag, fallback, min = 1000, max = 240000) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${flag} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function normalizeBrowserChannel(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  if (normalized.toLowerCase() === 'auto') return 'auto';
  if (['bundled', 'chromium', 'playwright'].includes(normalized.toLowerCase())) return '';
  return normalized;
}

function envValue(env = {}, names = []) {
  for (const name of names) {
    const value = String(env[name] == null ? '' : env[name]).trim();
    if (value) return value;
  }
  return '';
}

function normalizeConfigArgAliases(args = []) {
  return (Array.isArray(args) ? args : []).map((arg) => {
    const value = String(arg || '');
    if (value === '--url') return '--webtransport-url';
    if (value.startsWith('--url=')) return `--webtransport-url=${value.slice('--url='.length)}`;
    if (value === '--page-url') return '--webtransport-page-url';
    if (value.startsWith('--page-url=')) return `--webtransport-page-url=${value.slice('--page-url='.length)}`;
    return value;
  });
}

function parseWebTransportCommandArgs(argv = [], env = process.env) {
  const options = {
    help: false,
    json: false,
    failOnBlocked: false,
    endpoint: DEFAULT_ENDPOINT,
    webTransportUrl: envValue(env, ['AIH_WEBTRANSPORT_URL', 'AIH_M6_WEBTRANSPORT_URL']),
    webTransportPageUrl: envValue(env, ['AIH_WEBTRANSPORT_PAGE_URL', 'AIH_M6_WEBTRANSPORT_PAGE_URL']) || DEFAULT_SECURE_PROBE_PAGE_URL,
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
    if (token === '--webtransport-url' || token.startsWith('--webtransport-url=') || token === '--url' || token.startsWith('--url=')) {
      const flag = token === '--url' || token.startsWith('--url=') ? '--url' : '--webtransport-url';
      const next = readOptionValue(argv, index, flag);
      options.webTransportUrl = normalizeHttpUrl(next.value, flag);
      index += next.consumed;
      continue;
    }
    if (token === '--webtransport-page-url' || token.startsWith('--webtransport-page-url=') || token === '--page-url' || token.startsWith('--page-url=')) {
      const flag = token === '--page-url' || token.startsWith('--page-url=') ? '--page-url' : '--webtransport-page-url';
      const next = readOptionValue(argv, index, flag);
      options.webTransportPageUrl = normalizeHttpUrl(next.value, flag);
      index += next.consumed;
      continue;
    }
    if (token === '--timeout-ms' || token.startsWith('--timeout-ms=')) {
      const next = readOptionValue(argv, index, '--timeout-ms');
      options.timeoutMs = parsePositiveInteger(next.value, '--timeout-ms', DEFAULT_TIMEOUT_MS);
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

  if (!options.webTransportUrl) {
    options.webTransportUrl = buildHttpsUrlFromEndpoint(options.endpoint, DEFAULT_WEBTRANSPORT_PATH);
  }
  return options;
}

function isBrowserUnavailableError(error) {
  const message = String(error && error.message || error || '').toLowerCase();
  return message.includes('executable doesn\'t exist')
    || message.includes('chromium distribution')
    || message.includes('is not found')
    || message.includes('playwright install');
}

async function runWebTransportSmokeAuto(options = {}, deps = {}) {
  const runner = deps.runWebTransportSmoke || runWebTransportSmoke;
  const channels = options.browserChannel === 'auto' ? ['', 'chrome'] : [options.browserChannel];
  let lastError = null;

  for (let index = 0; index < channels.length; index += 1) {
    const channel = channels[index];
    try {
      return await runner({
        endpoint: options.endpoint,
        pageUrl: options.webTransportPageUrl,
        webTransportUrl: options.webTransportUrl,
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
  throw lastError || new Error('webtransport_probe_failed');
}

function buildSummary(gate = {}) {
  return {
    candidateReady: Boolean(gate.candidateReady),
    promotionReady: Boolean(gate.promotionReady),
    blockers: Array.isArray(gate.blockers) ? gate.blockers : []
  };
}

async function runFabricTransportWebTransportCommand(args = [], deps = {}) {
  const commandArgs = Array.isArray(args) ? args : [];
  const parsedOptions = parseWebTransportCommandArgs(commandArgs, deps.env || process.env);
  const merged = (deps.applyTransportConfigDefaults || applyTransportConfigDefaults)(
    parsedOptions,
    normalizeConfigArgAliases(commandArgs),
    deps
  );
  const options = merged.options;

  let probe = null;
  let probeError = null;
  try {
    probe = await (deps.runWebTransportSmokeAuto || runWebTransportSmokeAuto)(options, deps);
  } catch (error) {
    probeError = error;
  }

  const gate = classifyWebTransportPrerequisite(probe, probeError, options);
  const report = {
    ok: true,
    mode: 'fabric-webtransport-diagnostics',
    endpoint: options.endpoint,
    webTransportUrl: options.webTransportUrl,
    pageUrl: options.webTransportPageUrl,
    timeoutMs: options.timeoutMs,
    browserChannel: probe && probe.browser && probe.browser.channel ? probe.browser.channel : (options.browserChannel || 'bundled'),
    probe,
    gate,
    summary: buildSummary(gate),
    transportConfig: merged.source,
    json: options.json === true,
    exitOk: options.failOnBlocked === true ? Boolean(gate.promotionReady) : true
  };

  if (probeError) {
    report.probeError = { message: String(probeError && probeError.message || probeError) };
  }
  return report;
}

function formatFabricTransportWebTransportReport(report = {}) {
  const gate = report.gate || {};
  const probe = report.probe && report.probe.probe ? report.probe.probe : {};
  const summary = report.summary || {};
  const lines = [
    'AIH Fabric WebTransport diagnostics',
    `  endpoint: ${report.endpoint || ''}`,
    `  page_url: ${report.pageUrl || ''}`,
    `  webtransport_url: ${report.webTransportUrl || ''}`,
    `  candidate_ready: ${summary.candidateReady ? 'yes' : 'no'}`,
    `  promotion_ready: ${summary.promotionReady ? 'yes' : 'no'}`,
    `  secure_context: ${probe.isSecureContext ? 'yes' : 'no'}`,
    `  webtransport_api: ${probe.webTransportType || 'unknown'}`,
    `  connect_ms: ${Number(gate.connectMs || 0)}`,
    `  stream_rtt_ms: ${Number(gate.streamRttMs || 0)}`
  ];
  if (gate.failureReason) lines.push(`  failure_reason: ${gate.failureReason}`);
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
  DEFAULT_SECURE_PROBE_PAGE_URL,
  formatFabricTransportWebTransportReport,
  isBrowserUnavailableError,
  normalizeConfigArgAliases,
  parseWebTransportCommandArgs,
  runWebTransportSmokeAuto,
  runFabricTransportWebTransportCommand
};
