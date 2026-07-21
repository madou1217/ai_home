'use strict';

const WebSocket = require('ws');
const { rewriteCodexAppServerClientMessage } = require('./codex-app-server-proxy');
const {
  rememberThreadResumeRequestMessage,
  patchThreadResumeResponse,
  patchThreadResumeResponseMessage
} = require('./codex-thread-resume-response-patch');

function closeSocket(socket) {
  if (!socket) return;
  try {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
      return;
    }
    if (socket.readyState !== WebSocket.CLOSED) {
      socket.terminate();
    }
  } catch (_error) {}
}

function sendWhenOpen(socket, payload, options) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(payload, options);
  return true;
}

function patchCodexCliResumeServerMessage(raw, responseContexts) {
  return patchThreadResumeResponseMessage(raw, responseContexts);
}

function buildUpstreamOptions(authToken) {
  const token = String(authToken || '').trim();
  if (!token) return {};
  return {
    headers: {
      Authorization: `Bearer ${token}`
    }
  };
}

function wireClientToUpstream({ client, upstream, cwd }) {
  const pending = [];
  const responseContexts = new Map();
  let upstreamOpen = false;
  let closed = false;

  const closeBoth = () => {
    if (closed) return;
    closed = true;
    closeSocket(client);
    closeSocket(upstream);
  };

  upstream.on('open', () => {
    upstreamOpen = true;
    while (pending.length > 0) {
      const item = pending.shift();
      sendWhenOpen(upstream, item.payload, item.options);
    }
  });

  client.on('message', (data, isBinary) => {
    const rewritten = rewriteCodexAppServerClientMessage(data, { cwd });
    rememberThreadResumeRequestMessage(rewritten, responseContexts);
    const item = {
      payload: rewritten,
      options: { binary: false }
    };
    if (upstreamOpen) {
      sendWhenOpen(upstream, item.payload, item.options);
      return;
    }
    pending.push(item);
  });

  upstream.on('message', (data, isBinary) => {
    const payload = isBinary
      ? data
      : patchCodexCliResumeServerMessage(data, responseContexts);
    sendWhenOpen(client, payload, { binary: isBinary });
  });

  client.on('close', closeBoth);
  client.on('error', closeBoth);
  upstream.on('close', closeBoth);
  upstream.on('error', closeBoth);
}

function startCodexCliResumeCwdProxy(remoteConfig, options = {}) {
  const remoteUrl = String(remoteConfig && remoteConfig.remoteUrl || '').trim();
  const cwd = String(options.cwd || '').trim();
  if (!remoteUrl) {
    return Promise.reject(new Error('missing_remote_url'));
  }
  if (!cwd) {
    return Promise.reject(new Error('missing_resume_cwd'));
  }

  const WebSocketImpl = options.WebSocket || WebSocket;
  const host = String(options.host || '').trim() || '127.0.0.1';
  const server = new WebSocketImpl.Server({ host, port: 0 });
  const clients = new Set();

  server.on('connection', (client) => {
    clients.add(client);
    const upstream = new WebSocketImpl(remoteUrl, buildUpstreamOptions(remoteConfig && remoteConfig.authToken));
    wireClientToUpstream({ client, upstream, cwd });
    const cleanup = () => clients.delete(client);
    client.on('close', cleanup);
    client.on('error', cleanup);
  });

  function close() {
    for (const client of clients) {
      closeSocket(client);
    }
    clients.clear();
    try { server.close(); } catch (_error) {}
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      server.off('listening', onListening);
      server.off('error', onError);
      fn(value);
    };
    const onListening = () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? Number(address.port) : 0;
      if (!Number.isFinite(port) || port <= 0) {
        close();
        done(reject, new Error('resume_proxy_listen_failed'));
        return;
      }
      done(resolve, {
        remoteUrl: `ws://${host}:${port}`,
        close
      });
    };
    const onError = (error) => {
      close();
      done(reject, error);
    };
    server.once('listening', onListening);
    server.once('error', onError);
  });
}

module.exports = {
  patchCodexCliResumeServerMessage,
  patchThreadResumeResponse,
  startCodexCliResumeCwdProxy
};
