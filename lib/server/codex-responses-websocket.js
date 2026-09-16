'use strict';

const WebSocket = require('ws');
const { bridgeResponsesSession } = require('./codex-responses-session');
const { getCodexQuotaFailure } = require('./codex-response-recovery');
const { classifyUpstreamFailure } = require('./upstream-failure-policy');
const { applyAccountFailurePolicy } = require('./account-runtime-state');
const { selectPoolAccountsForModel } = require('./model-account-pool-selector');

const PROTOCOL_HEADERS = [
  'user-agent', 'openai-beta', 'originator', 'version', 'session_id',
  'x-codex-turn-state', 'x-codex-turn-metadata', 'x-client-request-id',
  'x-agent-context-session-id'
];

function buildResponsesWebSocketHeaders(headers, account) {
  const result = {};
  for (const name of PROTOCOL_HEADERS) {
    const value = headers[name];
    if (typeof value === 'string' && value && !/[\r\n]/.test(value)) result[name] = value;
  }
  result.authorization = `Bearer ${account.accessToken}`;
  result['user-agent'] ||= 'aih-proxy';
  if (account.upstreamAccountId) result['chatgpt-account-id'] = account.upstreamAccountId;
  return result;
}

function rejectUpgrade(socket, status, error) {
  if (socket.destroyed) return;
  const body = JSON.stringify({ ok: false, error });
  socket.end(`HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

function openUpstreamWebSocket(target, headers, socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (socket.destroyed) return reject(new Error('client_disconnected'));
    const upstream = new WebSocket(target, {
      headers, handshakeTimeout: timeoutMs, followRedirects: false
    });
    // Failed attempts are terminated after rejection; consume their final error.
    upstream.on('error', () => {});
    const cleanup = () => {
      socket.removeListener('close', cancel);
      socket.removeListener('end', cancel);
      upstream.removeListener('error', fail);
      upstream.removeListener('open', opened);
      upstream.removeListener('unexpected-response', unexpected);
    };
    const fail = error => {
      cleanup();
      reject(error);
      upstream.terminate();
    };
    const cancel = () => {
      fail(new Error('client_disconnected'));
      socket.destroy();
    };
    const opened = () => { cleanup(); resolve(upstream); };
    const unexpected = (_request, response) => {
      const error = new Error(`upstream_handshake_status_${response.statusCode}`);
      error.statusCode = response.statusCode;
      fail(error);
      response.destroy();
    };
    socket.once('close', cancel);
    socket.once('end', cancel);
    upstream.once('open', opened);
    upstream.once('error', fail);
    upstream.once('unexpected-response', unexpected);
  });
}

async function connectUpstreamWebSocket(target, headers, socket, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  try {
    return await openUpstreamWebSocket(target, headers, socket, timeoutMs);
  } catch (error) {
    // Only a missing handshake route permits one same-origin alias attempt.
    // No client frames have been accepted, so no inference request is replayed.
    if (error.statusCode !== 404 || socket.destroyed) throw error;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw error;
    const alias = new URL(target);
    alias.pathname += '/ws';
    return openUpstreamWebSocket(alias, headers, socket, remainingMs);
  }
}

async function handleCodexResponsesWebSocket({ req, socket, head, state, options }, deps) {
  const accountRef = String(req.headers['x-account-ref'] || '').trim();
  const allAccounts = Array.isArray(state.accounts.codex) ? state.accounts.codex : [];
  const pinnedPool = accountRef
    ? allAccounts.filter(account => account.accountRef === accountRef)
    : [];
  const selection = { provider: 'codex', sessionKey: '', excludeAccountRefs: [] };
  // Match the existing preferred-pin contract, including a present but blocked
  // account: no matching object and no schedulable match are both fallbacks.
  const account = (pinnedPool.length && deps.chooseAccount(pinnedPool, state.cursors, 'codex', selection))
    || deps.chooseAccount(allAccounts, state.cursors, 'codex', selection);
  if (!account || !account.accessToken) {
    rejectUpgrade(socket, '503 Service Unavailable', 'no_available_account');
    return;
  }

  async function connectAccount(next, budgetMs, replacement = false) {
    const baseUrl = String(next.openaiBaseUrl || options.codexBaseUrl || '').trim().replace(/\/+$/, '');
    if (deps.isLoopbackUrl(baseUrl, options.port)) {
      const error = new Error('infinite_loop_detected');
      error.loopback = true;
      throw error;
    }
    const target = new URL(`${baseUrl}/responses`);
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    const headers = buildResponsesWebSocketHeaders(req.headers, next);
    // The previous account's opaque turn-state is not a cross-account resume
    // token. Full public context is reconstructed by the connection ledger.
    if (replacement) delete headers['x-codex-turn-state'];
    let started = true;
    const finish = () => {
      if (!started) return;
      started = false;
      deps.accountActivity?.end('codex', next.accountRef);
    };
    deps.accountActivity?.begin('codex', next.accountRef);
    try {
      const upstream = await connectUpstreamWebSocket(target, headers, socket,
        Math.min(budgetMs, deps.handshakeTimeoutMs || 10000));
      upstream.once('close', finish);
      upstream.on('error', finish);
      return { ws: upstream, account: next, finish };
    } catch (error) { finish(); throw error; }
  }

  let initial;
  try {
    initial = await connectAccount(account, deps.handshakeTimeoutMs || 10000);
    if (socket.destroyed) { initial.finish(); initial.ws.terminate(); return; }
    const server = new WebSocket.Server({ noServer: true });
    server.handleUpgrade(req, socket, head, client => {
      bridgeResponsesSession(client, initial, {
        connect: (next, budgetMs) => connectAccount(next, budgetMs, true),
        chooseNext: (excluded, model) => {
          // Re-read the live pool: deletions, disablement, model policy and
          // persisted cooldowns must remain effective during a long session.
          const live = Array.isArray(state.accounts.codex) ? state.accounts.codex : [];
          const candidates = selectPoolAccountsForModel({
            pool: live.filter(item => item.accessToken && !excluded.has(item.accountRef)),
            provider: 'codex', model, state, options
          }).pool;
          return deps.chooseAccount(candidates, state.cursors, 'codex', {
            provider: 'codex', sessionKey: '', model, excludeAccountRefs: excluded
          });
        },
        onQuota: (failedAccount, event, model) => {
          const failure = getCodexQuotaFailure(event);
          const policy = classifyUpstreamFailure({
            provider: 'codex', body: event, detail: failure.code
          });
          applyAccountFailurePolicy(failedAccount, policy, {
            model, markProxyAccountFailure: deps.markProxyAccountFailure, defaultThreshold: 1
          });
        },
        onSuccess: (successfulAccount, model) => deps.markProxyAccountSuccess?.(successfulAccount, { model }),
        onRetry: deps.onRetry,
        onRetryUnavailable: deps.onRetryUnavailable
      }, { maxAttempts: options.maxAttempts, maxReplayBytes: options.maxRequestBodyBytes });
    });
  } catch (error) {
    if (initial) { initial.finish(); initial.ws.terminate(); }
    if (deps.onError) deps.onError(error);
    rejectUpgrade(socket, error.loopback ? '503 Service Unavailable' : '502 Bad Gateway',
      error.loopback ? 'infinite_loop_detected' : 'upstream_failed');
  }
}

module.exports = { buildResponsesWebSocketHeaders, handleCodexResponsesWebSocket };
