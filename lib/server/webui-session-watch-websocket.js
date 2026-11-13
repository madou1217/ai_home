'use strict';

// 后台原生会话 WebSocket 边界：
//   1. 保留同源与首帧 Bearer 管理密钥鉴权（浏览器 WS 无法带 Authorization 头）。
//   2. 鉴权通过后直接订阅 Go SSE（/v1/management/webui/sessions/watch），把每个 JSON
//      SSE 帧（含首帧 {"type":"connected"} 与后续 {"type":"update",...}）桥接为 WS 文本帧。
//   3. 不再持有或订阅 Node sessionEventBus；Go 不可用时以 4503 关闭连接交由前端重连。

const WebSocket = require('ws');
const { authorizeWebUiRequest } = require('./webui-auth-gate');

const SESSION_WATCH_WEBSOCKET_PATH = '/v0/webui/sessions/watch/ws';
const GO_WATCH_PATH = '/v1/management/webui/sessions/watch';
const AUTH_TIMEOUT_MS = 5000;

function hasSameOrigin(req) {
  if (!req.headers.origin) return true; // 原生客户端仍需通过 Management Key 校验。
  try {
    const origin = new URL(req.headers.origin);
    return ['http:', 'https:'].includes(origin.protocol) && origin.host === req.headers.host;
  } catch (_error) {
    return false;
  }
}

function readSession(input) {
  if (!input || typeof input !== 'object') return null;
  const { provider, sessionId, projectDirName = '' } = input;
  if (typeof provider !== 'string' || !provider.trim() || provider.length > 64
    || typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 1024
    || typeof projectDirName !== 'string' || projectDirName.length > 4096) return null;
  return {
    provider: provider.trim(),
    sessionId: sessionId.trim(),
    projectDirName: projectDirName.trim()
  };
}

function resolveGoHost(ctx) {
  if (!ctx) return null;
  if (typeof ctx.getGoCoreSync === 'function') return ctx.getGoCoreSync();
  return ctx.goCoreSync || (ctx.deps && ctx.deps.goCoreSync) || null;
}

function extractSseDataPayload(block) {
  const lines = String(block || '').split('\n');
  const dataLines = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('data:')) {
      const value = line.slice(5);
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value);
    }
  }
  return dataLines.join('\n').trim();
}

function handleSessionWatchWebSocketUpgrade(ctx, server) {
  const { req, socket, head } = ctx;
  if (!hasSameOrigin(req)) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  server.handleUpgrade(req, socket, head, (client) => {
    let closed = false;
    let reader = null;
    let heartbeat = null;
    const deadline = setTimeout(() => client.terminate(), ctx.authTimeoutMs || AUTH_TIMEOUT_MS);
    deadline.unref();

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearTimeout(deadline);
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
      if (reader) {
        try { reader.cancel(); } catch (_error) {}
        reader = null;
      }
    };
    client.on('close', cleanup);
    client.on('error', cleanup);

    client.once('message', async (bytes, isBinary) => {
      clearTimeout(deadline);
      let input;
      try { if (!isBinary) input = JSON.parse(bytes.toString()); } catch (_error) {}
      // 浏览器 WebSocket 不能设置 Authorization header。仅此专用端点在首帧
      // 接收同一 Bearer 凭据，校验通过前不订阅、不发送任何会话数据；密钥不进 URL。
      const gate = authorizeWebUiRequest({
        req: { method: 'GET', headers: { authorization: typeof input?.authorization === 'string' ? input.authorization : '' } },
        requiredManagementKey: typeof ctx.getRequiredManagementKey === 'function'
          ? ctx.getRequiredManagementKey()
          : ctx.requiredManagementKey
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

      const goHost = resolveGoHost(ctx);
      if (!goHost || typeof goHost.openWebuiStream !== 'function') {
        client.close(4503, 'go_core_unavailable');
        return;
      }

      const params = new URLSearchParams({
        provider: session.provider,
        sessionId: session.sessionId
      });
      if (session.projectDirName) {
        params.set('projectDirName', session.projectDirName);
      }

      let upstream = null;
      try {
        upstream = await goHost.openWebuiStream({
          path: GO_WATCH_PATH,
          query: params.toString()
        });
      } catch (_error) {
        upstream = null;
      }

      if (closed || client.readyState !== WebSocket.OPEN) {
        if (upstream && upstream.body && typeof upstream.body.cancel === 'function') {
          try { await upstream.body.cancel(); } catch (_error) {}
        }
        return;
      }

      if (!upstream) {
        client.close(4503, 'go_core_unavailable');
        return;
      }
      if (!upstream.ok || !upstream.body) {
        client.close(Number(upstream.status) === 400 ? 4400 : 4503, 'go_stream_failed');
        return;
      }

      heartbeat = setInterval(() => {
        if (client.readyState === WebSocket.OPEN) client.ping();
      }, 15000);
      heartbeat.unref();

      reader = upstream.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      const dispatchBlocks = (text) => {
        buffer += text.replace(/\r\n/g, '\n');
        let boundaryIndex = buffer.indexOf('\n\n');
        while (boundaryIndex >= 0) {
          const block = buffer.slice(0, boundaryIndex);
          buffer = buffer.slice(boundaryIndex + 2);
          const payload = extractSseDataPayload(block);
          if (payload && client.readyState === WebSocket.OPEN) {
            try {
              JSON.parse(payload);
              client.send(payload);
            } catch (_error) {
              // 忽略非 JSON SSE 片段。
            }
          }
          boundaryIndex = buffer.indexOf('\n\n');
        }
      };

      try {
        while (!closed && client.readyState === WebSocket.OPEN) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.length === 0) continue;
          dispatchBlocks(decoder.decode(value, { stream: true }));
        }
        const tail = decoder.decode();
        if (tail) dispatchBlocks(tail);
      } catch (_error) {
        // Go 上游断开后在下方统一收尾关闭 WS。
      } finally {
        if (!closed && client.readyState === WebSocket.OPEN) {
          client.close(1011, 'upstream_closed');
        }
        cleanup();
      }
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
