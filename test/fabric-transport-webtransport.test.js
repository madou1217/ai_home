'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  runFabricCommandRouter
} = require('../lib/cli/commands/fabric-router');
const {
  formatFabricTransportWebTransportReport,
  normalizeConfigArgAliases,
  parseWebTransportCommandArgs,
  runFabricTransportWebTransportCommand
} = require('../lib/cli/services/fabric/transport-webtransport');

function createProbeReport(overrides = {}) {
  return {
    ok: false,
    mode: 'webtransport-smoke',
    endpoint: 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527',
    pageUrl: 'https://example.com',
    webTransportUrl: 'https://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/v0/fabric/webtransport/echo',
    timeoutMs: 15000,
    browser: {
      engine: 'chromium',
      channel: 'chrome',
      headed: false
    },
    probe: {
      ok: false,
      isSecureContext: true,
      webTransportType: 'function',
      failureReason: 'webtransport_connect_failed',
      connectMs: 0,
      streamRttMs: 0
    },
    console: {
      errors: 0,
      warnings: 0,
      pageErrors: []
    },
    ...overrides
  };
}

test('webtransport command parser defaults to HTTPS/H3 target on AWS current', () => {
  const options = parseWebTransportCommandArgs([]);

  assert.equal(options.endpoint, 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527');
  assert.equal(options.webTransportPageUrl, 'https://example.com/');
  assert.equal(options.webTransportUrl, 'https://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/v0/fabric/webtransport/echo');
  assert.equal(options.json, false);
  assert.equal(options.failOnBlocked, false);
  assert.equal(options.browserChannel, 'auto');
});

test('webtransport command parser supports product flags and legacy aliases', () => {
  const options = parseWebTransportCommandArgs([
    '--endpoint',
    'http://127.0.0.1:9527/',
    '--url',
    'https://wt.example.com/wt',
    '--page-url',
    'https://page.example.com/',
    '--timeout-ms',
    '12000',
    '--browser-channel',
    'bundled',
    '--fail-on-blocked',
    '--json'
  ]);

  assert.equal(options.endpoint, 'http://127.0.0.1:9527');
  assert.equal(options.webTransportUrl, 'https://wt.example.com/wt');
  assert.equal(options.webTransportPageUrl, 'https://page.example.com');
  assert.equal(options.timeoutMs, 12000);
  assert.equal(options.browserChannel, '');
  assert.equal(options.failOnBlocked, true);
  assert.equal(options.json, true);
  assert.deepEqual(normalizeConfigArgAliases(['--url', 'https://wt.example.com/wt', '--page-url=https://page.example.com/']), [
    '--webtransport-url',
    'https://wt.example.com/wt',
    '--webtransport-page-url=https://page.example.com/'
  ]);
});

test('webtransport command reports blockers without failing by default', async () => {
  const report = await runFabricTransportWebTransportCommand([
    '--endpoint',
    'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527'
  ], {
    runWebTransportSmoke: async (options) => {
      assert.equal(options.webTransportUrl, 'https://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/v0/fabric/webtransport/echo');
      assert.equal(options.pageUrl, 'https://example.com/');
      return createProbeReport();
    }
  });

  assert.equal(report.ok, true);
  assert.equal(report.exitOk, true);
  assert.equal(report.summary.candidateReady, false);
  assert.equal(report.summary.promotionReady, false);
  assert.deepEqual(report.summary.blockers, ['webtransport_connect_failed', 'webtransport_h3_endpoint_missing']);
  assert.match(formatFabricTransportWebTransportReport(report), /^AIH Fabric WebTransport diagnostics/);
});

test('webtransport command auto browser falls back from bundled to chrome when bundled is missing', async () => {
  const attempts = [];
  const report = await runFabricTransportWebTransportCommand([], {
    runWebTransportSmoke: async (options) => {
      attempts.push(options.browserChannel || 'bundled');
      if (!options.browserChannel) {
        throw new Error('Executable doesn\'t exist at /tmp/chromium_headless_shell');
      }
      return createProbeReport({
        browser: {
          engine: 'chromium',
          channel: options.browserChannel,
          headed: false
        }
      });
    }
  });

  assert.deepEqual(attempts, ['bundled', 'chrome']);
  assert.equal(report.browserChannel, 'chrome');
  assert.equal(report.summary.blockers.includes('webtransport_connect_failed'), true);
  assert.equal(report.summary.blockers.includes('webtransport_h3_endpoint_missing'), true);
});

test('webtransport command honors fail-on-blocked', async () => {
  const report = await runFabricTransportWebTransportCommand([
    '--fail-on-blocked'
  ], {
    runWebTransportSmoke: async () => createProbeReport()
  });

  assert.equal(report.ok, true);
  assert.equal(report.exitOk, false);
  assert.equal(report.summary.promotionReady, false);
});

test('fabric command router routes transport webtransport JSON', async () => {
  const writes = [];
  const exits = [];

  await runFabricCommandRouter([
    'fabric',
    'transport',
    'webtransport',
    '--endpoint',
    'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527',
    '--json'
  ], {
    processObj: {
      stdout: { write: (value) => writes.push(String(value)) },
      exit: (code) => exits.push(code)
    },
    consoleImpl: {
      log: () => {},
      error: () => {}
    },
    runFabricTransportWebTransportCommand: async (args) => {
      assert.equal(args.includes('--json'), true);
      return {
        ok: true,
        mode: 'fabric-webtransport-diagnostics',
        summary: {
          candidateReady: false,
          promotionReady: false,
          blockers: ['webtransport_connect_failed', 'webtransport_h3_endpoint_missing']
        },
        json: true,
        exitOk: true
      };
    }
  });

  assert.deepEqual(exits, [0]);
  const payload = JSON.parse(writes.join(''));
  assert.equal(payload.ok, true);
  assert.equal(payload.summary.promotionReady, false);
  assert.deepEqual(payload.summary.blockers, ['webtransport_connect_failed', 'webtransport_h3_endpoint_missing']);
});

test('fabric command router exits non-zero for webtransport fail-on-blocked', async () => {
  const writes = [];
  const exits = [];

  await runFabricCommandRouter([
    'fabric',
    'transport',
    'webtransport',
    '--fail-on-blocked',
    '--json'
  ], {
    processObj: {
      stdout: { write: (value) => writes.push(String(value)) },
      exit: (code) => exits.push(code)
    },
    consoleImpl: {
      log: () => {},
      error: () => {}
    },
    runFabricTransportWebTransportCommand: async () => ({
      ok: true,
      mode: 'fabric-webtransport-diagnostics',
      summary: {
        candidateReady: false,
        promotionReady: false,
        blockers: ['webtransport_connect_failed']
      },
      json: true,
      exitOk: false
    })
  });

  assert.deepEqual(exits, [1]);
  assert.equal(JSON.parse(writes.join('')).summary.promotionReady, false);
});
