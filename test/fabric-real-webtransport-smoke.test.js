'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildReport,
  parseArgs
} = require('../scripts/fabric-real-webtransport-smoke');

test('webtransport smoke parser defaults to AWS current endpoint paths', () => {
  const options = parseArgs([
    '--timeout-ms',
    '12000',
    '--diagnostics-file',
    '/tmp/aih-webtransport.json'
  ]);

  assert.equal(options.endpoint, 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527');
  assert.equal(options.pageUrl, 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/ui/');
  assert.equal(options.webTransportUrl, 'http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/v0/fabric/webtransport/echo');
  assert.equal(options.timeoutMs, 12000);
  assert.equal(options.diagnosticsFile, '/tmp/aih-webtransport.json');
  assert.equal(options.browserChannel, 'chrome');
});

test('webtransport smoke parser supports explicit secure page and WebTransport URLs', () => {
  const options = parseArgs([
    '--endpoint',
    'http://127.0.0.1:9527/',
    '--page-url',
    'https://example.com/',
    '--url',
    'https://example.com:443/wt',
    '--browser-channel',
    'bundled',
    '--headed'
  ]);

  assert.equal(options.endpoint, 'http://127.0.0.1:9527');
  assert.equal(options.pageUrl, 'https://example.com');
  assert.equal(options.webTransportUrl, 'https://example.com/wt');
  assert.equal(options.browserChannel, '');
  assert.equal(options.headed, true);
});

test('webtransport smoke parser validates URL and timeout inputs', () => {
  assert.throws(() => parseArgs(['--url', 'ftp://example.com/wt']), /--url must be a valid http\(s\) URL/);
  assert.throws(() => parseArgs(['--timeout-ms', '10']), /--timeout-ms must be an integer/);
});

test('webtransport smoke report preserves fallback reason and browser metadata', () => {
  const options = {
    endpoint: 'http://control.example.com:9527',
    pageUrl: 'http://control.example.com:9527/ui/',
    webTransportUrl: 'http://control.example.com:9527/v0/fabric/webtransport/echo',
    timeoutMs: 15000
  };
  const report = buildReport(options, {
    browser: {
      engine: 'chromium',
      channel: 'chrome',
      headed: false
    },
    probe: {
      ok: false,
      isSecureContext: false,
      webTransportType: 'undefined',
      failureReason: 'insecure_context'
    },
    console: {
      errors: 0,
      warnings: 0,
      pageErrors: []
    }
  });

  assert.equal(report.ok, false);
  assert.equal(report.mode, 'webtransport-smoke');
  assert.equal(report.probe.failureReason, 'insecure_context');
  assert.equal(report.console.errors, 0);
});
