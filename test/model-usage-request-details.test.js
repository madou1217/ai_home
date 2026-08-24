'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createModelUsageService } = require('../lib/usage/model-usage-service');
const {
  buildRequestDetails,
  projectRequestLogText
} = require('../lib/usage/model-usage-request-details');

function requireDatabaseSync(t) {
  try {
    return require('node:sqlite').DatabaseSync;
  } catch (_error) {
    t.skip('node:sqlite unavailable');
    return null;
  }
}

function writeServerLog(aiHomeDir, entries) {
  const logsDir = path.join(aiHomeDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(
    path.join(logsDir, 'server.log'),
    `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`,
    'utf8'
  );
}

test('request details merge request usage with safe gateway telemetry and omit unsupported dimensions', (t) => {
  const DatabaseSync = requireDatabaseSync(t);
  if (!DatabaseSync) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-request-details-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const aiHomeDir = path.join(root, '.ai_home');
  const service = createModelUsageService({
    aiHomeDir,
    hostHomeDir: root,
    DatabaseSync,
    enableAsyncQueries: false
  });
  t.after(() => service.close());

  const successAt = Date.parse('2026-08-23T08:00:00.000Z');
  const errorAt = Date.parse('2026-08-23T08:01:00.000Z');
  service.recordUsage({
    eventKey: 'api:codex:req-success',
    provider: 'codex',
    accountRef: 'acct_aaaaaaaaaaaaaaaaaaaa',
    requestId: 'req-success',
    sourceKind: 'server_codex_proxy',
    model: 'gpt-5.6-sol',
    inputTokens: 2000,
    outputTokens: 350,
    cacheReadInputTokens: 100,
    reasoningOutputTokens: 40,
    totalTokens: 2490,
    costUsd: 0.012345,
    timestampMs: successAt
  });
  service.recordUsage({
    eventKey: 'session:codex:ignored',
    provider: 'codex',
    sessionId: 'session-1',
    sourceKind: 'session_jsonl',
    model: 'gpt-5.6-sol',
    totalTokens: 99,
    timestampMs: successAt
  });

  writeServerLog(aiHomeDir, [
    {
      at: '2026-08-23T08:00:00.000Z',
      kind: 'model_usage_request_context',
      requestId: 'req-success',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'xhigh',
      endpoint: '/v1/responses',
      clientIp: '10.0.0.8',
      requestType: 'stream'
    },
    {
      at: '2026-08-23T08:00:01.271Z',
      requestId: 'req-success',
      provider: 'codex',
      status: 200,
      durationMs: 1271
    },
    {
      at: '2026-08-23T08:00:01.271Z',
      kind: 'access',
      requestId: 'req-success',
      method: 'POST',
      path: '/v1/responses',
      clientIp: '10.0.0.8',
      status: 200,
      durationMs: 1271
    },
    {
      at: '2026-08-23T08:01:00.000Z',
      kind: 'model_usage_request_context',
      requestId: 'req-error',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'high',
      endpoint: '/v1/models',
      clientIp: '10.0.0.9',
      requestType: 'sync'
    },
    {
      at: '2026-08-23T08:01:00.031Z',
      kind: 'account_retry_failure',
      requestId: 'req-error',
      provider: 'codex',
      status: 502,
      error: 'upstream_failed',
      upstreamBody: 'Authorization: Bearer secret-token upstream unavailable',
      durationMs: 30
    },
    {
      at: '2026-08-23T08:01:00.031Z',
      kind: 'access',
      requestId: 'req-error',
      method: 'GET',
      path: '/v1/models',
      clientIp: '10.0.0.9',
      status: 502,
      durationMs: 31
    },
    {
      at: '2026-08-23T08:02:00.000Z',
      kind: 'access',
      requestId: 'req-management',
      method: 'GET',
      path: '/v0/webui/management/usage/requests',
      clientIp: '127.0.0.1',
      status: 500,
      durationMs: 2
    }
  ]);

  const result = service.getRequestDetails({
    fromMs: Date.parse('2026-08-23T00:00:00.000Z'),
    toMs: Date.parse('2026-08-23T23:59:59.999Z'),
    provider: '',
    limit: 50
  });

  assert.equal(result.usage.length, 1);
  assert.deepEqual(result.usage[0], {
    requestId: 'req-success',
    provider: 'codex',
    model: 'gpt-5.6-sol',
    reasoningEffort: 'xhigh',
    endpoint: '/v1/responses',
    clientIp: '10.0.0.8',
    requestType: 'stream',
    billingMode: 'token',
    inputTokens: 2000,
    outputTokens: 350,
    cacheReadInputTokens: 100,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 40,
    totalTokens: 2490,
    costUsd: 0.012345,
    durationMs: 1271,
    timestampMs: successAt,
    statusCode: 200,
    errorCode: '',
    errorMessage: ''
  });

  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].requestId, 'req-error');
  assert.equal(result.errors[0].provider, 'gateway');
  assert.equal(result.errors[0].model, 'model-catalog');
  assert.equal(result.errors[0].reasoningEffort, 'not_applicable');
  assert.equal(result.errors[0].endpoint, '/v1/models');
  assert.equal(result.errors[0].clientIp, '10.0.0.9');
  assert.equal(result.errors[0].requestType, 'sync');
  assert.equal(result.errors[0].statusCode, 502);
  assert.equal(result.errors[0].errorCode, 'upstream_failed');
  assert.match(result.errors[0].errorMessage, /Bearer \[redacted\]/);
  assert.doesNotMatch(result.errors[0].errorMessage, /secret-token/);
  assert.equal(result.errors[0].durationMs, 31);
  assert.equal(result.errors[0].timestampMs, errorAt + 31);

  [...result.usage, ...result.errors].forEach((row) => {
    assert.equal(Object.hasOwn(row, 'key'), false);
    assert.equal(Object.hasOwn(row, 'apiKey'), false);
    assert.equal(Object.hasOwn(row, 'group'), false);
    assert.equal(Object.hasOwn(row, 'accountRef'), false);
  });
});

test('request details never expose credential-shaped error codes', () => {
  const secret = 'sk-proj-this-credential-must-not-leak';
  const logRecords = projectRequestLogText([
    JSON.stringify({
      at: '2026-08-23T09:00:00.000Z',
      kind: 'model_usage_request_context',
      requestId: 'req-secret-code',
      model: 'gpt-5.6-sol',
      endpoint: '/v1/responses',
      clientIp: '10.0.0.10',
      requestType: 'sync'
    }),
    JSON.stringify({
      at: '2026-08-23T09:00:00.010Z',
      kind: 'account_retry_failure',
      requestId: 'req-secret-code',
      provider: 'codex',
      status: 502,
      error: secret,
      durationMs: 10
    })
  ].join('\n'));

  const result = buildRequestDetails([], logRecords, {
    fromMs: Date.parse('2026-08-23T00:00:00.000Z'),
    toMs: Date.parse('2026-08-23T23:59:59.999Z'),
    provider: 'codex',
    model: '',
    limit: 50
  });

  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].errorCode, 'http_502');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
});

test('request details infer synchronous type for access-only GET errors', () => {
  const logRecords = projectRequestLogText(JSON.stringify({
    at: '2026-08-23T10:00:00.000Z',
    kind: 'access',
    requestId: 'req-models-unauthorized',
    method: 'GET',
    path: '/v1/models',
    clientIp: '10.0.0.11',
    status: 401,
    durationMs: 2
  }));

  const result = buildRequestDetails([], logRecords, {
    fromMs: Date.parse('2026-08-23T00:00:00.000Z'),
    toMs: Date.parse('2026-08-23T23:59:59.999Z'),
    provider: '',
    model: '',
    limit: 50
  });

  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].provider, 'gateway');
  assert.equal(result.errors[0].model, 'model-catalog');
  assert.equal(result.errors[0].reasoningEffort, 'not_applicable');
  assert.equal(result.errors[0].endpoint, '/v1/models');
  assert.equal(result.errors[0].requestType, 'sync');
});

test('request details distinguish provider defaults from dimensions absent in historical logs', () => {
  const logRecords = projectRequestLogText([
    JSON.stringify({
      at: '2026-08-23T10:10:00.000Z',
      kind: 'model_usage_request_context',
      requestId: 'req-context-default',
      provider: 'codex',
      model: 'gpt-5.6-sol',
      endpoint: '/v1/responses',
      clientIp: '10.0.0.12',
      requestType: 'stream'
    }),
    JSON.stringify({
      at: '2026-08-23T10:10:00.050Z',
      kind: 'access',
      requestId: 'req-context-default',
      method: 'POST',
      path: '/v1/responses',
      clientIp: '10.0.0.12',
      status: 502,
      durationMs: 50
    }),
    JSON.stringify({
      at: '2026-08-23T10:11:00.000Z',
      kind: 'access',
      requestId: 'req-history-only',
      method: 'POST',
      path: '/v1/responses',
      clientIp: '10.0.0.13',
      status: 502,
      durationMs: 12
    })
  ].join('\n'));

  const result = buildRequestDetails([], logRecords, {
    fromMs: Date.parse('2026-08-23T00:00:00.000Z'),
    toMs: Date.parse('2026-08-23T23:59:59.999Z'),
    provider: '',
    model: '',
    limit: 50
  });

  const defaulted = result.errors.find((row) => row.requestId === 'req-context-default');
  const historical = result.errors.find((row) => row.requestId === 'req-history-only');
  assert.equal(defaulted.reasoningEffort, 'provider_default');
  assert.equal(historical.reasoningEffort, '');
});

test('request details keep one latest usage row per request id', (t) => {
  const DatabaseSync = requireDatabaseSync(t);
  if (!DatabaseSync) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aih-request-details-dedupe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const service = createModelUsageService({
    aiHomeDir: path.join(root, '.ai_home'),
    hostHomeDir: root,
    DatabaseSync,
    enableAsyncQueries: false
  });
  t.after(() => service.close());

  const timestampMs = Date.parse('2026-08-23T11:00:00.000Z');
  service.recordUsage({
    eventKey: 'api:codex:req-duplicate:first',
    provider: 'codex',
    requestId: 'req-duplicate',
    sourceKind: 'server_codex_proxy',
    model: 'gpt-5.6-sol',
    inputTokens: 100,
    totalTokens: 100,
    timestampMs
  });
  service.recordUsage({
    eventKey: 'api:codex:req-duplicate:latest',
    provider: 'codex',
    requestId: 'req-duplicate',
    sourceKind: 'server_codex_proxy',
    model: 'gpt-5.6-sol',
    inputTokens: 125,
    totalTokens: 125,
    timestampMs: timestampMs + 1
  });

  const result = service.getRequestDetails({
    fromMs: timestampMs - 1,
    toMs: timestampMs + 2,
    limit: 50
  });

  assert.equal(result.usage.length, 1);
  assert.equal(result.usage[0].requestId, 'req-duplicate');
  assert.equal(result.usage[0].inputTokens, 125);
});
