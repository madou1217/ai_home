'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  HEADER_OVERRIDES_ENV_KEY,
  WIRE_API_CHAT,
  WIRE_API_ENV_KEY,
  WIRE_API_RESPONSES,
  applyAccountUpstreamHeaders,
  buildUpstreamProfileEnv,
  normalizeHeaderOverrides,
  normalizeWireApi,
  resolveAccountUpstreamHeaders,
  resolveAccountUpstreamWireApi,
  resolveUpstreamProfileFromEnv,
  usesChatCompletionsWireApi
} = require('../lib/server/upstream-account-profile');

test('normalizeWireApi accepts the documented chat/completions spellings', () => {
  ['chat', 'chat/completions', 'chat_completions', 'openai', ' CHAT/Completions '].forEach((value) => {
    assert.equal(normalizeWireApi(value), WIRE_API_CHAT, `expected ${value} to normalize to chat`);
  });
});

test('normalizeWireApi accepts the documented responses spellings', () => {
  ['responses', 'openai_responses', 'openai-responses', 'RESPONSES'].forEach((value) => {
    assert.equal(normalizeWireApi(value), WIRE_API_RESPONSES, `expected ${value} to normalize to responses`);
  });
});

test('normalizeWireApi returns empty for unknown or missing values', () => {
  [undefined, null, '', '   ', 'grpc', 'anthropic', 42, {}].forEach((value) => {
    assert.equal(normalizeWireApi(value), '');
  });
});

test('resolveAccountUpstreamWireApi defaults to responses so codex behaviour is unchanged', () => {
  assert.equal(resolveAccountUpstreamWireApi(null), WIRE_API_RESPONSES);
  assert.equal(resolveAccountUpstreamWireApi({}), WIRE_API_RESPONSES);
  assert.equal(resolveAccountUpstreamWireApi({ upstreamWireApi: 'nonsense' }), WIRE_API_RESPONSES);
  assert.equal(usesChatCompletionsWireApi({}), false);
  assert.equal(usesChatCompletionsWireApi({ upstreamWireApi: 'chat/completions' }), true);
});

test('normalizeHeaderOverrides keeps well-formed vendor headers and lowercases names', () => {
  const overrides = normalizeHeaderOverrides({ 'X-Client-Type': ' cline-cli ' });
  assert.deepEqual(overrides, { 'x-client-type': 'cline-cli' });
});

test('normalizeHeaderOverrides parses a JSON string payload', () => {
  const overrides = normalizeHeaderOverrides('{"x-client-type":"cline-cli"}');
  assert.deepEqual(overrides, { 'x-client-type': 'cline-cli' });
});

test('normalizeHeaderOverrides rejects malformed JSON, arrays and scalars', () => {
  [null, undefined, '', 'not json', '[1,2]', '"text"', '42', 7].forEach((value) => {
    assert.deepEqual(normalizeHeaderOverrides(value), {});
  });
});

test('normalizeHeaderOverrides drops CR/LF injection attempts', () => {
  const overrides = normalizeHeaderOverrides({
    'x-safe': 'ok',
    'x-evil': 'a\r\nx-injected: 1',
    'x-newline': 'a\nb',
    'x-null': 'a\u0000b',
    'x-del': 'a\u007fb'
  });
  assert.deepEqual(overrides, { 'x-safe': 'ok' });
});

test('normalizeHeaderOverrides drops hop-by-hop headers owned by the transport', () => {
  const overrides = normalizeHeaderOverrides({
    connection: 'close',
    'Content-Length': '10',
    host: 'evil.example',
    'transfer-encoding': 'chunked',
    upgrade: 'websocket',
    'x-keep': 'kept'
  });
  assert.deepEqual(overrides, { 'x-keep': 'kept' });
});

test('normalizeHeaderOverrides refuses to let configuration forge internal x-aih-* markers', () => {
  const overrides = normalizeHeaderOverrides({
    'x-aih-account-ref': 'acct_ffffffffffffffffffff',
    'x-aih-account-email': 'spoof@example.com',
    'x-ok': 'ok'
  });
  assert.deepEqual(overrides, { 'x-ok': 'ok' });
});

test('normalizeHeaderOverrides drops invalid header names and empty values', () => {
  const overrides = normalizeHeaderOverrides({
    'bad name': 'v',
    'bad:name': 'v',
    '': 'v',
    'x-empty': '   ',
    'x-nullish': null,
    'x-good': 'v'
  });
  assert.deepEqual(overrides, { 'x-good': 'v' });
});

test('resolveUpstreamProfileFromEnv reads the persisted credential env', () => {
  const profile = resolveUpstreamProfileFromEnv({
    OPENAI_API_KEY: 'sk-test',
    OPENAI_BASE_URL: 'https://api.example.com/api/v1',
    [WIRE_API_ENV_KEY]: 'chat',
    [HEADER_OVERRIDES_ENV_KEY]: '{"x-client-type":"cline-cli"}'
  });
  assert.deepEqual(profile, {
    upstreamWireApi: WIRE_API_CHAT,
    upstreamHeaders: { 'x-client-type': 'cline-cli' }
  });
});

test('resolveUpstreamProfileFromEnv yields an inert profile for ordinary accounts', () => {
  [undefined, null, {}, { OPENAI_API_KEY: 'sk-test' }].forEach((env) => {
    assert.deepEqual(resolveUpstreamProfileFromEnv(env), {
      upstreamWireApi: '',
      upstreamHeaders: {}
    });
  });
});

test('buildUpstreamProfileEnv round-trips through resolveUpstreamProfileFromEnv', () => {
  const env = buildUpstreamProfileEnv({
    wireApi: 'chat/completions',
    headerOverrides: { 'X-Client-Type': ' cline-cli ' }
  });
  assert.deepEqual(env, {
    [WIRE_API_ENV_KEY]: WIRE_API_CHAT,
    [HEADER_OVERRIDES_ENV_KEY]: '{"x-client-type":"cline-cli"}'
  });
  assert.deepEqual(resolveUpstreamProfileFromEnv(env), {
    upstreamWireApi: WIRE_API_CHAT,
    upstreamHeaders: { 'x-client-type': 'cline-cli' }
  });
});

test('buildUpstreamProfileEnv omits keys nothing declared and rejects unsafe overrides', () => {
  [undefined, null, {}, { wireApi: 'grpc' }, { headerOverrides: 'not json' }].forEach((profile) => {
    assert.deepEqual(buildUpstreamProfileEnv(profile), {});
  });
  // A relay that only diverges on the wire API carries no header key at all.
  assert.deepEqual(buildUpstreamProfileEnv({ wireApi: 'chat' }), { [WIRE_API_ENV_KEY]: WIRE_API_CHAT });
  // Unsafe entries are dropped by the same normalizer used at request time.
  assert.deepEqual(buildUpstreamProfileEnv({ headerOverrides: { connection: 'close' } }), {});
});

test('buildUpstreamProfileEnv also accepts an already-resolved account profile', () => {
  assert.deepEqual(buildUpstreamProfileEnv({
    upstreamWireApi: 'responses',
    upstreamHeaders: { 'x-tenant': 'acme' }
  }), {
    [WIRE_API_ENV_KEY]: WIRE_API_RESPONSES,
    [HEADER_OVERRIDES_ENV_KEY]: '{"x-tenant":"acme"}'
  });
});

test('resolveAccountUpstreamHeaders re-validates whatever the runtime account carries', () => {
  const headers = resolveAccountUpstreamHeaders({
    upstreamHeaders: { 'x-client-type': 'cline-cli', connection: 'close' }
  });
  assert.deepEqual(headers, { 'x-client-type': 'cline-cli' });
  assert.deepEqual(resolveAccountUpstreamHeaders(null), {});
});

test('applyAccountUpstreamHeaders overrides inherited client headers in place', () => {
  const headers = { authorization: 'Bearer x', 'x-client-type': 'inherited-from-client' };
  const result = applyAccountUpstreamHeaders(headers, {
    upstreamHeaders: { 'x-client-type': 'cline-cli' }
  });
  assert.equal(result, headers);
  assert.equal(headers['x-client-type'], 'cline-cli');
  assert.equal(headers.authorization, 'Bearer x');
});

test('applyAccountUpstreamHeaders leaves headers untouched for accounts without overrides', () => {
  const headers = { authorization: 'Bearer x' };
  applyAccountUpstreamHeaders(headers, {});
  applyAccountUpstreamHeaders(headers, null);
  assert.deepEqual(headers, { authorization: 'Bearer x' });
});
