#!/usr/bin/env node
'use strict';

const path = require('node:path');

const {
  DEFAULT_ENDPOINT,
  createBrowserLaunchOptions,
  loadPlaywright,
  writeDiagnosticsFile
} = require('./fabric-real-webrtc-datachannel-smoke');

const DEFAULT_PAGE_PATH = '/ui/';
const DEFAULT_WEBTRANSPORT_PATH = '/v0/fabric/webtransport/echo';
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_BROWSER_CHANNEL = 'chrome';

function showHelp() {
  console.log(`AIH Fabric real WebTransport smoke

Usage:
  npx --yes --package playwright node scripts/fabric-real-webtransport-smoke.js [options]

Options:
  --endpoint <url>        AWS/current endpoint, default ${DEFAULT_ENDPOINT}.
  --page-url <url>        Browser page URL, default <endpoint>${DEFAULT_PAGE_PATH}.
  --url <url>             WebTransport URL, default <endpoint>${DEFAULT_WEBTRANSPORT_PATH}.
  --timeout-ms <n>        Connection/stream timeout, default ${DEFAULT_TIMEOUT_MS}.
  --diagnostics-file <p>  Optional sanitized JSON export path.
  --browser-channel <c>   Playwright browser channel, default ${DEFAULT_BROWSER_CHANNEL}; use bundled for Playwright Chromium.
  --headed                Show the browser window.
  -h, --help              Show this help.

This smoke uses a real browser WebTransport object when available. It does not
start a QUIC server, open a new product port, or fake a stream echo. If the
current endpoint lacks HTTPS/HTTP3/WebTransport support, the report records the
browser-visible fallback reason.
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
  if (value === undefined || isFlag(value)) throw new Error(`${flag} requires a value`);
  return { value: String(value), consumed: 2 };
}

function normalizeEndpoint(value, flag) {
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
  if (['bundled', 'chromium', 'playwright'].includes(normalized.toLowerCase())) return '';
  return normalized;
}

function parsePositiveInteger(value, flag, fallback, min = 1000, max = 240000) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${flag} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function buildDefaultUrl(endpoint, suffix) {
  return `${String(endpoint || '').replace(/\/+$/, '')}${suffix}`;
}

function parseArgs(argv = []) {
  const options = {
    help: false,
    endpoint: DEFAULT_ENDPOINT,
    pageUrl: '',
    webTransportUrl: '',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    diagnosticsFile: '',
    browserChannel: DEFAULT_BROWSER_CHANNEL,
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
    if (token === '--headed') {
      options.headed = true;
      index += 1;
      continue;
    }
    if (token === '--endpoint' || token.startsWith('--endpoint=')) {
      const next = readOptionValue(argv, index, '--endpoint');
      options.endpoint = normalizeEndpoint(next.value, '--endpoint');
      index += next.consumed;
      continue;
    }
    if (token === '--page-url' || token.startsWith('--page-url=')) {
      const next = readOptionValue(argv, index, '--page-url');
      options.pageUrl = normalizeEndpoint(next.value, '--page-url');
      index += next.consumed;
      continue;
    }
    if (token === '--url' || token.startsWith('--url=')) {
      const next = readOptionValue(argv, index, '--url');
      options.webTransportUrl = normalizeEndpoint(next.value, '--url');
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
      options.diagnosticsFile = path.resolve(String(next.value || '').trim());
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

  if (!options.pageUrl) options.pageUrl = buildDefaultUrl(options.endpoint, DEFAULT_PAGE_PATH);
  if (!options.webTransportUrl) options.webTransportUrl = buildDefaultUrl(options.endpoint, DEFAULT_WEBTRANSPORT_PATH);
  return options;
}

async function webTransportEvaluate(input) {
  const url = String(input.url || '');
  const timeoutMs = Math.max(1000, Number(input.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const startedAt = performance.now();
  const events = [];

  const record = (event) => {
    events.push({
      t: Math.round((performance.now() - startedAt) * 100) / 100,
      ...event
    });
  };

  const serializeError = (error) => ({
    name: String(error && error.name || ''),
    message: String(error && error.message || error || '')
  });

  const timeout = (stage) => new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`${stage}_timeout_${timeoutMs}`)), timeoutMs);
  });

  const result = {
    ok: false,
    url,
    isSecureContext: Boolean(globalThis.isSecureContext),
    webTransportType: typeof WebTransport,
    connectMs: 0,
    streamRttMs: 0,
    bytesRead: 0,
    events
  };

  if (typeof WebTransport !== 'function') {
    result.failureReason = result.isSecureContext ? 'webtransport_api_unavailable' : 'insecure_context';
    record({ type: 'preflight_failed', reason: result.failureReason });
    return result;
  }

  let transport;
  try {
    transport = new WebTransport(url);
    record({ type: 'created' });
    await Promise.race([transport.ready, timeout('ready')]);
    result.connectMs = Math.round((performance.now() - startedAt) * 100) / 100;
    record({ type: 'ready', connectMs: result.connectMs });

    const streamStartedAt = performance.now();
    const stream = await Promise.race([transport.createBidirectionalStream(), timeout('create_stream')]);
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    const payload = new TextEncoder().encode(`aih-webtransport-${Date.now()}`);
    await writer.write(payload);
    await writer.close();
    const read = await Promise.race([reader.read(), timeout('read_stream')]);
    const value = read && read.value ? read.value : new Uint8Array();
    result.bytesRead = value.byteLength || 0;
    result.streamRttMs = Math.round((performance.now() - streamStartedAt) * 100) / 100;
    result.ok = result.bytesRead > 0;
    record({ type: 'stream_result', bytesRead: result.bytesRead, streamRttMs: result.streamRttMs });
    return result;
  } catch (error) {
    result.failureReason = 'webtransport_connect_failed';
    result.error = serializeError(error);
    record({ type: 'error', error: result.error });
    return result;
  } finally {
    if (transport && typeof transport.close === 'function') {
      try {
        transport.close();
      } catch (_error) {
        // Ignore close errors; the connection attempt result above is the signal.
      }
    }
  }
}

function buildReport(options, details) {
  const probe = details.probe || {};
  return {
    ok: Boolean(probe.ok),
    mode: 'webtransport-smoke',
    endpoint: options.endpoint,
    pageUrl: options.pageUrl,
    webTransportUrl: options.webTransportUrl,
    timeoutMs: options.timeoutMs,
    browser: details.browser || {},
    probe,
    console: details.console || {}
  };
}

async function runWebTransportSmoke(options = {}, deps = {}) {
  const playwright = deps.playwright || loadPlaywright();
  const browser = await playwright.chromium.launch(createBrowserLaunchOptions(options));
  const consoleMessages = [];
  const pageErrors = [];
  const startedAt = Date.now();
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 }
    });
    const page = await context.newPage();
    page.on('console', (message) => {
      consoleMessages.push({ type: message.type(), text: message.text() });
    });
    page.on('pageerror', (error) => {
      pageErrors.push({ message: String(error && error.message || error) });
    });
    await page.goto(options.pageUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(options.timeoutMs, 30000) });
    const probe = await page.evaluate(webTransportEvaluate, {
      url: options.webTransportUrl,
      timeoutMs: options.timeoutMs
    });
    await context.close();
    const report = buildReport(options, {
      probe,
      browser: {
        engine: 'chromium',
        channel: options.browserChannel || 'bundled',
        headed: options.headed === true,
        durationMs: Date.now() - startedAt
      },
      console: {
        errors: consoleMessages.filter((item) => item.type === 'error').length,
        warnings: consoleMessages.filter((item) => item.type === 'warning').length,
        pageErrors
      }
    });
    await writeDiagnosticsFile(options.diagnosticsFile, report);
    return report;
  } finally {
    await browser.close();
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      showHelp();
      return;
    }
    const result = await runWebTransportSmoke(options);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(`\x1b[31m[aih] fabric real webtransport smoke failed: ${String(error && error.message || error)}\x1b[0m`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_BROWSER_CHANNEL,
  DEFAULT_ENDPOINT,
  DEFAULT_PAGE_PATH,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_WEBTRANSPORT_PATH,
  buildReport,
  parseArgs,
  runWebTransportSmoke,
  webTransportEvaluate
};
