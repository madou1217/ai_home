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

async function handleCodexResponsesWebSocket({ req, socket, head, state, options }, deps) {
  const accountRef = String(req.headers['x-account-ref'] || '').trim();
  const allAccounts = Array.isArray(state.accounts.codex) ? state.accounts.codex : [];
  const pool = accountRef
    ? allAccounts.filter(account => account.accountRef === accountRef)
    : allAccounts;
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
    upstream = new WebSocket(target, {
      headers: buildResponsesWebSocketHeaders(req.headers, account),
      handshakeTimeout: deps.handshakeTimeoutMs || 10000
    });
    if (deps.accountActivity) deps.accountActivity.begin('codex', account.accountRef);
    started = true;
    upstream.once('close', finish);
    upstream.on('error', finish);
    const cancel = () => upstream.terminate();
    socket.once('close', cancel);
    try {
      await new Promise((resolve, reject) => {
        upstream.once('open', resolve);
        upstream.once('error', reject);
      });
      if (socket.destroyed) { upstream.terminate(); return; }
      const server = new WebSocket.Server({ noServer: true });
      server.handleUpgrade(req, socket, head, client => {
        socket.removeListener('close', cancel);
        forwardFrames(client, upstream);
        forwardFrames(upstream, client);
        client.once('close', finish);
      });
    } catch (error) {
      socket.removeListener('close', cancel);
      throw error;
    }
  } catch (error) {
    finish();
    if (upstream) upstream.terminate();
    if (deps.onError) deps.onError(error);
    rejectUpgrade(socket, '502 Bad Gateway', 'upstream_failed');
  }
}

module.exports = { buildResponsesWebSocketHeaders, handleCodexResponsesWebSocket };
