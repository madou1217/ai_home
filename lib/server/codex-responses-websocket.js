'use strict';

const WebSocket = require('ws');

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

function closePeer(peer, code = 1011, reason = '') {
  if (peer.readyState === WebSocket.CONNECTING) return peer.terminate();
  if (peer.readyState !== WebSocket.OPEN) return;
  const validCode = code === 1000 || (code >= 1001 && code <= 1014 && ![1004, 1005, 1006].includes(code))
    || (code >= 3000 && code <= 4999);
  peer.close(validCode ? code : 1011, reason);
}

function forwardFrames(source, target) {
  source.on('message', (data, isBinary) => {
    if (target.readyState !== WebSocket.OPEN) return;
    // ws reports text payloads as Buffer too; preserve the original frame type.
    source.pause();
    target.send(data, { binary: isBinary }, error => {
      if (error) {
        closePeer(source);
        closePeer(target);
      } else if (source.readyState === WebSocket.OPEN) {
        source.resume();
      }
    });
  });
  source.on('close', (code, reason) => closePeer(target, code, reason));
  source.on('error', () => closePeer(target));
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
  // 钉选是亲和偏好,不是死刑:钉的账号不在可调度池(停用/失效)就回落全池——
  // 与 v1-router HTTP 路径同一条策略;只有全池皆空才报 no_available_account。
  // chooseAccount 经持久化生命周期同步,死账号在池里也不会被选中。
  const pinnedPool = accountRef
    ? allAccounts.filter(account => account.accountRef === accountRef)
    : [];
  const pool = pinnedPool.length > 0 ? pinnedPool : allAccounts;
  const account = deps.chooseAccount(pool, state.cursors, 'codex', {
    provider: 'codex', sessionKey: '', excludeAccountRefs: []
  });
  if (!account || !account.accessToken) {
    rejectUpgrade(socket, '503 Service Unavailable', 'no_available_account');
    return;
  }
  const baseUrl = String(account.openaiBaseUrl || options.codexBaseUrl || '').trim().replace(/\/+$/, '');
  if (deps.isLoopbackUrl(baseUrl, options.port)) {
    rejectUpgrade(socket, '503 Service Unavailable', 'infinite_loop_detected');
    return;
  }

  let upstream;
  let started = false;
  const finish = () => {
    if (!started) return;
    started = false;
    if (deps.accountActivity) deps.accountActivity.end('codex', account.accountRef);
  };
  try {
    const target = new URL(`${baseUrl}/responses`);
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    if (deps.accountActivity) deps.accountActivity.begin('codex', account.accountRef);
    started = true;
    upstream = await connectUpstreamWebSocket(
      target, buildResponsesWebSocketHeaders(req.headers, account), socket,
      deps.handshakeTimeoutMs || 10000
    );
    upstream.once('close', finish);
    upstream.on('error', finish);
    if (socket.destroyed) { upstream.terminate(); return; }
    const server = new WebSocket.Server({ noServer: true });
    server.handleUpgrade(req, socket, head, client => {
      forwardFrames(client, upstream);
      forwardFrames(upstream, client);
      client.once('close', finish);
    });
  } catch (error) {
    finish();
    if (upstream) upstream.terminate();
    if (deps.onError) deps.onError(error);
    rejectUpgrade(socket, '502 Bad Gateway', 'upstream_failed');
  }
}

module.exports = { buildResponsesWebSocketHeaders, handleCodexResponsesWebSocket };
