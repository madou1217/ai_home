'use strict';

const WebSocket = require('ws');
const { authorizeWebUiRequest } = require('./webui-auth-gate');
const { defaultSessionEventBus } = require('./session-event-bus');
const { buildSessionWatchPayload } = require('./webui-session-watch');

const SESSION_WATCH_WEBSOCKET_PATH = '/v0/webui/sessions/watch/ws';
const AUTH_TIMEOUT_MS = 5000;

function hasSameOrigin(req) {
  if (!req.headers.origin) return true; // 原生客户端仍需通过 Management Key 校验。
  try {
    const origin = new URL(req.headers.origin);
    return ['http:', 'https:'].includes(origin.protocol) && origin.host === req.headers.host;
  } catch (_) {
    return false;
  }
}

function readSession(input) {
  if (!input || typeof input !== 'object') return null;
  const { provider, sessionId, projectDirName = '' } = input;
  if (typeof provider !== 'string' || !provider.trim() || provider.length > 64
    || typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 1024
    || typeof projectDirName !== 'string' || projectDirName.length > 4096) return null;
  return { provider: provider.trim(), sessionId: sessionId.trim(), projectDirName: projectDirName.trim() };
}

function handleSessionWatchWebSocketUpgrade(ctx, server) {
  const { req, socket, head, sessionEventBus = defaultSessionEventBus } = ctx;
  if (!hasSameOrigin(req)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  server.handleUpgrade(req, socket, head, (client) => {
    let unsubscribe = () => {};
    let heartbeat;
    const deadline = setTimeout(() => client.terminate(), ctx.authTimeoutMs || AUTH_TIMEOUT_MS);
    deadline.unref();
    const cleanup = () => {
      clearTimeout(deadline);
      clearInterval(heartbeat);
      unsubscribe();
      unsubscribe = () => {};
    };
    client.on('close', cleanup);
    client.on('error', cleanup);
    client.once('message', (bytes, isBinary) => {
      clearTimeout(deadline);
      let input;
      try { if (!isBinary) input = JSON.parse(bytes.toString()); } catch (_) {}
      // 浏览器 WebSocket 不能设置 Authorization header。仅此专用端点在首帧
      // 接收同一 Bearer 凭据，校验通过前不订阅、不发送任何会话数据；密钥不进 URL。
      const gate = authorizeWebUiRequest({
        req: { method: 'GET', headers: { authorization: typeof input?.authorization === 'string' ? input.authorization : '' } },
        requiredManagementKey: typeof ctx.getRequiredManagementKey === 'function'
          ? ctx.getRequiredManagementKey() : ctx.requiredManagementKey
      });
      if (!gate.ok) {
        client.close(gate.statusCode === 503 ? 4503 : 4401, 'webui_unauthorized');
        return;
      }
      const session = readSession(input);
      if (!session) {
        client.close(4400, 'missing_params');
        return;
      }
      const send = (payload) => {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(payload));
      };
      unsubscribe = sessionEventBus.subscribe(session, (event) => {
        send(buildSessionWatchPayload(ctx, session, event));
      });
      send({ type: 'connected' });
      heartbeat = setInterval(() => {
        if (client.readyState === WebSocket.OPEN) client.ping();
      }, 15000);
      heartbeat.unref();
    });
  });
}

function createSessionWatchWebSocketServer(ctx = {}) {
  const server = new WebSocket.Server({ noServer: true, maxPayload: 16 * 1024, perMessageDeflate: false });
  return {
    handleUpgrade(req, socket, head) {
      handleSessionWatchWebSocketUpgrade({ ...ctx, req, socket, head }, server);
    },
    close() {
      // HTTP server.closeAllConnections() 不会关闭已升级的连接。
      for (const client of server.clients) client.terminate();
      server.close();
    }
  };
}

module.exports = { SESSION_WATCH_WEBSOCKET_PATH, createSessionWatchWebSocketServer };
