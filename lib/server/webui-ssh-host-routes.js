'use strict';

// WebUI SSH 开发机与远程工作区的 Node 边界。
//
// 所有连接/工作区读写、连通性探测、远端目录浏览、反向隧道管理及工作区终端启动均已迁入 Go Core
// （/v1/management/webui/ssh-*），本文件只保留浏览器前门鉴权后的反代与 SSE 透传；
// Go Core 不可用时显式返回 503，绝不在 Node 回退执行 SSH / SQLite / 远程工作区逻辑。

const { proxyWebuiGo, resolveGoHost } = require('./webui-go-proxy');

const MAX_BODY_BYTES = 1024 * 1024;
const PASS_STATUSES = Object.freeze([400, 404, 405, 409, 500, 501]);

function extractClientPeer(req) {
  const headers = (req && req.headers) || {};
  return {
    remoteAddr: String((req && req.socket && req.socket.remoteAddress) || ''),
    forwardedFor: String(headers['x-forwarded-for'] || ''),
    realIp: String(headers['x-real-ip'] || ''),
    cfConnectingIp: String(headers['cf-connecting-ip'] || ''),
    forwarded: String(headers['forwarded'] || ''),
    aihServerId: String(headers['x-aih-server-id'] || '')
  };
}

function decodePathParam(raw) {
  try {
    return decodeURIComponent(String(raw || ''));
  } catch (_error) {
    return null;
  }
}

async function readJsonObjectBody(ctx) {
  const buf = await ctx.readRequestBody(ctx.req, { maxBytes: MAX_BODY_BYTES });
  if (!buf || buf.length === 0) return { ok: true, value: {} };
  let parsed;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch (_error) {
    return { ok: false, error: 'invalid_json_body', message: '请求体不是合法 JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'invalid_request_body', message: '请求体必须是 JSON 对象' };
  }
  return { ok: true, value: parsed };
}

async function proxyReverseTunnelsWatch(ctx) {
  const { req, res } = ctx;
  const goHost = resolveGoHost(ctx);
  if (!goHost || typeof goHost.openWebuiStream !== 'function') {
    res.writeHead(503, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write('event: unavailable\ndata: {}\n\n');
    res.end();
    return true;
  }

  let closed = false;
  let reader = null;
  const abort = () => {
    if (closed) return;
    closed = true;
    if (reader) {
      try { reader.cancel(); } catch (_error) {}
    }
  };
  req.on('close', abort);
  res.on('close', abort);
  res.on('error', abort);

  let stream = null;
  try {
    stream = await goHost.openWebuiStream({
      method: 'GET',
      path: '/v1/management/webui/ssh/reverse-tunnels/watch',
      accept: 'text/event-stream'
    });
  } catch (_error) {
    stream = null;
  }

  if (closed || req.destroyed || res.destroyed || res.writableEnded) {
    if (stream && stream.body && typeof stream.body.cancel === 'function') {
      try { await stream.body.cancel(); } catch (_error) {}
    }
    return true;
  }

  if (!stream || !stream.ok || !stream.body) {
    if (stream && stream.body && typeof stream.body.cancel === 'function') {
      try { await stream.body.cancel(); } catch (_error) {}
    }
    res.writeHead(503, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write('event: unavailable\ndata: {}\n\n');
    res.end();
    return true;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders?.();
  reader = stream.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (!closed) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0 && !res.destroyed && !res.writableEnded) {
        res.write(decoder.decode(value, { stream: true }));
      }
    }
  } catch (_error) {
    // 浏览器或 Go Core 断开时清掉读取流，EventSource 会自动重连。
  } finally {
    abort();
    if (!res.writableEnded) res.end();
  }
  return true;
}

async function handleWebUiSshHostRoutes(ctx) {
  const { method, pathname, res } = ctx;
  const writeJson = ctx.writeJson;

  let body = {};
  if (method === 'POST' || method === 'PUT') {
    const parsed = await readJsonObjectBody(ctx);
    if (!parsed.ok) {
      writeJson(res, 400, { ok: false, error: parsed.error, message: parsed.message });
      return true;
    }
    body = parsed.value;
  }

  if (method === 'GET' && pathname === '/v0/webui/ssh-connections') {
    return proxyWebuiGo(ctx, {
      method: 'GET',
      path: '/v1/management/webui/ssh-connections',
      passStatuses: PASS_STATUSES,
      message: 'Go Core 未就绪，SSH 连接不可读'
    });
  }

  if (method === 'GET' && pathname === '/v0/webui/ssh-connections/tunnels') {
    return proxyWebuiGo(ctx, {
      method: 'GET',
      path: '/v1/management/webui/ssh/reverse-tunnels',
      passStatuses: PASS_STATUSES,
      message: 'Go Core 未就绪，反向隧道状态不可读'
    });
  }

  if (method === 'GET' && pathname === '/v0/webui/ssh-connections/tunnels/watch') {
    return proxyReverseTunnelsWatch(ctx);
  }

  if (method === 'POST' && pathname === '/v0/webui/ssh-connections') {
    return proxyWebuiGo(ctx, {
      method: 'POST',
      path: '/v1/management/webui/ssh-connections',
      body,
      passStatuses: PASS_STATUSES,
      message: 'Go Core 未就绪，SSH 连接不可写'
    });
  }

  if (method === 'POST' && pathname === '/v0/webui/ssh-connections/test') {
    return proxyWebuiGo(ctx, {
      method: 'POST',
      path: '/v1/management/webui/ssh/probe',
      body,
      passStatuses: PASS_STATUSES,
      message: 'Go Core 未就绪，SSH 连通性探测不可用'
    });
  }

  const connMatch = (method === 'PUT' || method === 'DELETE')
    ? /^\/v0\/webui\/ssh-connections\/([^/]+)$/.exec(pathname)
    : null;
  if (connMatch) {
    const id = decodePathParam(connMatch[1]);
    if (!id) {
      writeJson(res, 400, { ok: false, error: 'invalid_connection_id' });
      return true;
    }
    return proxyWebuiGo(ctx, {
      method,
      path: `/v1/management/webui/ssh-connections/${encodeURIComponent(id)}`,
      body: method === 'PUT' ? body : undefined,
      passStatuses: PASS_STATUSES,
      message: method === 'PUT' ? 'Go Core 未就绪，SSH 连接不可写' : 'Go Core 未就绪，SSH 连接不可删'
    });
  }

  if (method === 'GET' && pathname === '/v0/webui/ssh-workspaces') {
    return proxyWebuiGo(ctx, {
      method: 'GET',
      path: '/v1/management/webui/ssh-workspaces',
      passStatuses: PASS_STATUSES,
      message: 'Go Core 未就绪，SSH 工作区不可读'
    });
  }

  if (method === 'GET' && pathname === '/v0/webui/ssh-workspaces/sessions') {
    return proxyWebuiGo(ctx, {
      method: 'GET',
      path: '/v1/management/webui/ssh-workspaces/sessions',
      passStatuses: PASS_STATUSES,
      message: 'Go Core 未就绪，SSH 工作区终端状态不可读'
    });
  }

  if (method === 'POST' && pathname === '/v0/webui/ssh-workspaces') {
    return proxyWebuiGo(ctx, {
      method: 'POST',
      path: '/v1/management/webui/ssh-workspaces',
      body,
      passStatuses: PASS_STATUSES,
      message: 'Go Core 未就绪，SSH 工作区不可写'
    });
  }

  const terminalMatch = method === 'POST'
    ? /^\/v0\/webui\/ssh-workspaces\/([^/]+)\/terminal$/.exec(pathname)
    : null;
  if (terminalMatch) {
    const id = decodePathParam(terminalMatch[1]);
    if (!id) {
      writeJson(res, 400, { ok: false, error: 'invalid_workspace_id' });
      return true;
    }
    return proxyWebuiGo(ctx, {
      method: 'POST',
      path: `/v1/management/webui/ssh-workspaces/${encodeURIComponent(id)}/terminal`,
      body: { ...body, clientPeer: extractClientPeer(ctx.req) },
      passStatuses: PASS_STATUSES,
      message: 'Go Core 未就绪，远程工作区终端不可用'
    });
  }

  const wsMatch = (method === 'PUT' || method === 'DELETE')
    ? /^\/v0\/webui\/ssh-workspaces\/([^/]+)$/.exec(pathname)
    : null;
  if (wsMatch) {
    const id = decodePathParam(wsMatch[1]);
    if (!id) {
      writeJson(res, 400, { ok: false, error: 'invalid_workspace_id' });
      return true;
    }
    return proxyWebuiGo(ctx, {
      method,
      path: `/v1/management/webui/ssh-workspaces/${encodeURIComponent(id)}`,
      body: method === 'PUT' ? body : undefined,
      passStatuses: PASS_STATUSES,
      message: method === 'PUT' ? 'Go Core 未就绪，SSH 工作区不可写' : 'Go Core 未就绪，SSH 工作区不可删'
    });
  }

  if (method === 'POST' && pathname === '/v0/webui/ssh-hosts/browse') {
    return proxyWebuiGo(ctx, {
      method: 'POST',
      path: '/v1/management/webui/ssh-hosts/browse',
      body,
      passStatuses: PASS_STATUSES,
      message: 'Go Core 未就绪，远端目录浏览不可用'
    });
  }

  return false;
}

module.exports = {
  handleWebUiSshHostRoutes
};
