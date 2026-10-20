'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  QODER_CLIENT_LAYOUTS,
  QODER_IDENTITY_HEADERS,
  QODER_IDENTITY_HEADER_ORDER,
  QODER_INFERENCE_WIRE,
  QODER_MODEL_SERVER_HEADERS,
  buildQoderIdentityHeaders,
  buildQoderModelServerHeaders,
  resolveQoderClientLayout,
  sanitizeQoderHeaderValue
} = require('../lib/runtime/qoder-client-layouts');

test('qoder client layout pins the verified 1.1.73 binary and endpoints', () => {
  const layout = resolveQoderClientLayout({ provider: 'qoder', version: '1.1.73' });
  assert.equal(layout.id, 'qoder-cli-1.1.73');
  assert.equal(layout.status, 'verified');
  assert.equal(layout.resolution, 'version');
  assert.equal(layout.binary.sha256, 'ec2180c0d8425d882acb991d756e6617a0343546574792836a1286164ccb3327');
  assert.equal(layout.binary.sizeBytes, 162892288);
  assert.equal(layout.endpoints.inference, 'https://api3.qoder.sh');
  assert.equal(layout.endpoints.openapi, 'https://openapi.qoder.sh');
  assert.equal(layout.inference.operation, 'inference.remoteChat.stream');
  assert.equal(layout.inference.wasmSigning.wasmCall, 'prepareInferRequest');
  assert.equal(layout.inference.wasmSigning.wireBodyIsClientJson, false);
  assert.equal(layout.inference.sessionType, 'qodercli');
  assert.equal(layout.inference.wire.path, '/algo/api/v2/service/pro/sse/agent_chat_generation');
  assert.equal(layout.inference.wire.requestContentEncoding, 'zstd');
  assert.equal(layout.inference.wire.responseContentType, 'text/event-stream;charset=UTF-8');
  assert.equal(QODER_INFERENCE_WIRE.doneFrame, 'body: "[DONE]"');
});

test('qoder identity header names match the client constants exactly', () => {
  assert.deepEqual(QODER_IDENTITY_HEADER_ORDER, [
    'X-Qoder-Model',
    'X-Qoder-Model-Safety-Tag',
    'X-Qoder-Session-Id',
    'x-internal-session-id',
    'x-internal-model-key',
    'x-internal-business-id',
    'X-Session-ID',
    'X-RequestSet-ID'
  ]);
  assert.equal(QODER_IDENTITY_HEADERS.model, 'X-Qoder-Model');
  assert.equal(QODER_IDENTITY_HEADERS.requestSetId, 'X-RequestSet-ID');
  assert.equal(QODER_MODEL_SERVER_HEADERS.requestId, 'X-Request-ID');
  assert.equal(QODER_MODEL_SERVER_HEADERS.sessionId, 'X-Session-ID');
});

test('identity headers follow the client fallback and all-or-none rules', () => {
  assert.deepEqual(buildQoderIdentityHeaders({ displayName: 'Qwen3.8-Flash', modelKey: 'qfmodel' }), {
    'X-Qoder-Model': 'Qwen3.8-Flash'
  });
  assert.deepEqual(buildQoderIdentityHeaders({ displayName: '', modelKey: 'qfmodel' }), {
    'X-Qoder-Model': 'qfmodel'
  });
  assert.deepEqual(buildQoderIdentityHeaders({
    modelKey: 'qfmodel',
    sessionId: 'session-1',
    requestSetId: 'request-set-1',
    safetyTag: 'safe',
    internalSessionId: 'session-1',
    internalModelKey: 'qfmodel',
    internalBusinessId: 'business-1'
  }), {
    'X-Qoder-Model': 'qfmodel',
    'X-Qoder-Session-Id': 'session-1',
    'X-Session-ID': 'session-1',
    'X-RequestSet-ID': 'request-set-1',
    'X-Qoder-Model-Safety-Tag': 'safe',
    'x-internal-session-id': 'session-1',
    'x-internal-model-key': 'qfmodel',
    'x-internal-business-id': 'business-1'
  });
});

test('internal context headers are omitted unless all three values exist', () => {
  const headers = buildQoderIdentityHeaders({
    modelKey: 'qfmodel',
    internalSessionId: 'session-1',
    internalModelKey: 'qfmodel'
  });
  assert.equal(headers['x-internal-session-id'], undefined);
  assert.equal(headers['x-internal-model-key'], undefined);
  assert.equal(headers['x-internal-business-id'], undefined);
});

test('header value sanitizer strips non-printable ASCII and trims', () => {
  assert.equal(sanitizeQoderHeaderValue('  model\u0000-name\u001f  '), 'model-name');
  assert.equal(sanitizeQoderHeaderValue('模型'), '');
  assert.equal(sanitizeQoderHeaderValue(null), '');
});

test('model server headers include the fixed client headers without leaking empty auth', () => {
  assert.deepEqual(buildQoderModelServerHeaders({
    token: 'token-1',
    requestId: 'request-1',
    sessionId: 'session-1'
  }), {
    Accept: 'text/event-stream',
    'Content-Type': 'application/json',
    Authorization: 'Bearer token-1',
    'X-Request-ID': 'request-1',
    'X-Session-ID': 'session-1'
  });
  const withoutAuth = buildQoderModelServerHeaders({ requestId: 'request-1' });
  assert.equal(withoutAuth.Authorization, undefined);
});

test('layout resolution pins the verified qodercn 1.1.72 binary and wire facts', () => {
  const mismatch = resolveQoderClientLayout({ provider: 'qoder', version: '9.9.9' });
  assert.equal(mismatch.id, 'qoder-cli-1.1.73');
  assert.equal(mismatch.resolution, 'version_mismatch');

  const cn = resolveQoderClientLayout({ provider: 'qodercn' });
  assert.equal(cn.id, 'qodercn-cli-1.1.72');
  assert.equal(cn.status, 'verified');
  assert.equal(cn.cliVersion, '1.1.72');
  assert.equal(cn.resolution, 'latest');
  assert.equal(cn.homeDir, '.qoder-cn');
  assert.equal(cn.binary.sha256, '2e55dab3998c6a8f3b6f8c74993cb9a2132889f1bdac6f8c79a0982ccdc65cb6');
  assert.equal(cn.endpoints.inference, 'https://gateway.qoder.com.cn');
  assert.equal(cn.inference.sessionType, 'qoderclicn');
  assert.equal(cn.inference.wasmSigning.wasmCall, 'prepareInferRequest');
  assert.equal(cn.inference.wasmSigning.wireBodyIsClientJson, false);
  assert.equal(cn.inference.wire.requestBodyEncoding.includes('WASM prepareInferRequest'), true);
  assert.equal(cn.inference.wire.query.includes('AgentId=agent_common'), true);
  assert.equal(resolveQoderClientLayout({ provider: 'unknown' }), null);
});

test('layout table contains no credential-shaped values', () => {
  const serialized = JSON.stringify(QODER_CLIENT_LAYOUTS);
  assert.equal(/Bearer\s+(?!<token>)[A-Za-z0-9._~+/=-]{8,}/.test(serialized), false);
  assert.equal(/eyJ[A-Za-z0-9_-]{10,}/.test(serialized), false);
});
