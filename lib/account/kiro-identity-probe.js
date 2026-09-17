'use strict';

const { createKiroIdentityEvidence, kiroEndpoint, kiroTokenBinding } = require('./kiro-identity');
const { parseIdentityObject } = require('./identity-subject');

const MAX_RESPONSE_BYTES = 1024 * 1024;
const TIMEOUT_MS = 10000;

function identityError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function readBoundedResponse(response) {
  const announced = Number(response.headers?.get('content-length'));
  if (announced > MAX_RESPONSE_BYTES) throw identityError('kiro_identity_response_too_large');
  if (!response.body || typeof response.body.getReader !== 'function') {
    throw identityError('kiro_identity_response_unreadable');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.length;
      if (length > MAX_RESPONSE_BYTES) throw identityError('kiro_identity_response_too_large');
      chunks.push(Buffer.from(item.value));
    }
  } finally {
    try { await reader.cancel(); } catch (_) { /* Stream may already be closed. */ }
    reader.releaseLock();
  }
  return parseIdentityObject(Buffer.concat(chunks).toString('utf8'), MAX_RESPONSE_BYTES);
}

/**
 * Authentication enrichment is asynchronous and outside the identity value
 * functions. No arbitrary endpoint, redirect, retry loop, or token-bearing error
 * is allowed here. The injected request/clock ports make the exact wire contract
 * executable in tests without contacting a live account.
 *
 * AWS source @15cc8f3 get_usage_limits.rs specifies POST /, Bearer authentication,
 * JSON 1.0 and AmazonCodeWhispererService.GetUsageLimits. This deliberately does
 * not assert compatibility with an unverified alternate Kiro REST endpoint.
 */
async function resolveKiroIdentityEvidence(nativeAuth, options = {}) {
  if (options.signal?.aborted) throw identityError('kiro_identity_cancelled');
  const auth = nativeAuth?.auth;
  const tokenBinding = kiroTokenBinding(auth);
  if (!tokenBinding) throw identityError('kiro_identity_missing_access_token');
  const request = options.request || globalThis.fetch;
  if (typeof request !== 'function') throw identityError('kiro_identity_transport_unavailable');
  const endpoint = kiroEndpoint(auth);
  const input = { origin: 'CLI', resourceType: 'AGENTIC_REQUEST', isEmailRequired: true };
  const url = new URL('/', endpoint);
  for (const [key, value] of Object.entries(input)) url.searchParams.set(key, String(value));
  const controller = new AbortController();
  const externalAbort = () => controller.abort();
  options.signal?.addEventListener('abort', externalAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await request(url.toString(), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${auth.access_token || auth.accessToken}`,
        'content-type': 'application/x-amz-json-1.0',
        'x-amz-target': 'AmazonCodeWhispererService.GetUsageLimits'
      },
      body: JSON.stringify(input),
      redirect: 'error',
      signal: controller.signal
    });
    if (!response || response.status !== 200) {
      throw identityError(response?.status === 401 ? 'kiro_identity_authentication_failed'
        : response?.status === 403 ? 'kiro_identity_access_denied'
        : 'kiro_identity_request_failed');
    }
    const document = await readBoundedResponse(response);
    const evidence = createKiroIdentityEvidence(auth, document, (options.now || Date.now)());
    if (!evidence) throw identityError('kiro_identity_unverifiable');
    if (kiroTokenBinding(nativeAuth.auth) !== tokenBinding) throw identityError('kiro_identity_credential_changed');
    return evidence;
  } catch (error) {
    if (typeof error?.code === 'string' && error.code.startsWith('kiro_identity_')) throw error;
    throw identityError(controller.signal.aborted ? 'kiro_identity_cancelled' : 'kiro_identity_transport_failed');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', externalAbort);
  }
}

module.exports = { resolveKiroIdentityEvidence };
