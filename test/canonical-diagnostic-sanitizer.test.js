'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  sanitizeCanonicalDiagnostic,
  sanitizeDiagnosticDetails,
  sanitizeDiagnosticText
} = require('../lib/server/chat-runtime/canonical-diagnostic-sanitizer');

test('canonical diagnostic text redacts credential forms while retaining useful context', () => {
  const secrets = [
    'bearer-secret-value',
    'basic-secret-value',
    'api-secret-value',
    'cookie-secret-value',
    'access-secret-value',
    'header.payload.signature',
    'sk-proj-provider-secret'
  ];
  const diagnostic = sanitizeDiagnosticText([
    'Provider rejected the request.',
    `Authorization: Bearer ${secrets[0]}`,
    `Proxy-Authorization: Basic ${secrets[1]}`,
    `X-API-Key=${secrets[2]}`,
    `Cookie: session=${secrets[3]}; theme=dark`,
    `{"access_token":"${secrets[4]}"}`,
    `JWT ${secrets[5]}`,
    `API ${secrets[6]}`
  ].join('\n'));

  assert.match(diagnostic, /Provider rejected the request/);
  assert.match(diagnostic, /Bearer \[redacted\]/);
  assert.match(diagnostic, /Basic \[redacted\]/);
  assert.equal(secrets.some((secret) => diagnostic.includes(secret)), false);
});

test('canonical diagnostic details use a bounded redacted projection', () => {
  const details = sanitizeDiagnosticDetails({
    sessionId: 'session-1',
    authorization: 'Bearer nested-secret',
    nested: {
      apiKey: 'api-key-secret',
      reason: 'upstream failed with token=opaque-token',
      attempts: 2
    },
    cookies: ['session=cookie-secret']
  });

  assert.deepEqual(details, {
    sessionId: 'session-1',
    authorization: '[redacted]',
    nested: {
      apiKey: '[redacted]',
      reason: 'upstream failed with token=[redacted]',
      attempts: 2
    },
    cookies: '[redacted]'
  });
  assert.doesNotMatch(JSON.stringify(details), /nested-secret|api-key-secret|opaque-token|cookie-secret/);
});

test('canonical diagnostic preserves a safe code and status without retaining raw details', () => {
  const diagnostic = sanitizeCanonicalDiagnostic(Object.assign(
    new Error('request failed Authorization: Bearer response-secret'),
    {
      code: 'codex_app_server_disconnected',
      statusCode: 503,
      details: { requestId: 'request-1', refreshToken: 'refresh-secret' }
    }
  ), {
    fallbackCode: 'chat_runtime_failed',
    includeDetails: true,
    includeStatusCode: true
  });

  assert.deepEqual(diagnostic, {
    code: 'codex_app_server_disconnected',
    message: 'request failed Authorization: Bearer [redacted]',
    statusCode: 503,
    details: { requestId: 'request-1', refreshToken: '[redacted]' }
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /response-secret|refresh-secret/);
});

test('canonical diagnostic replaces unsafe provider codes with the stable fallback', () => {
  const diagnostic = sanitizeCanonicalDiagnostic(Object.assign(
    new Error('api_key=message-secret'),
    { code: 'unsafe code Authorization: Bearer code-secret' }
  ), { fallbackCode: 'chat_provider_failed' });

  assert.deepEqual(diagnostic, {
    code: 'chat_provider_failed',
    message: 'api_key=[redacted]'
  });
});
