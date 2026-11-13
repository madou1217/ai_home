'use strict';

// Canonical Chat Runtime 浏览器路由的零回退 Go 代理。
// 全部会话状态、SQLite 持久化、时间线/快照投影、附件预处理、指令派发、SSE 事件流、
// 工作区 Git 检查点与产物读取均已迁至 Go (internal/runtime/chatruntime + webuichatapi)。

const { callGoHost, resolveGoHost } = require('./webui-go-proxy');

const SESSIONS_PATH = '/v0/webui/chat/sessions';
const ARTIFACTS_PATH = '/v0/webui/chat/artifacts';
const GO_SESSIONS_PATH = '/v1/management/webui/chat/sessions';
const GO_ARTIFACTS_PATH = '/v1/management/webui/chat/artifacts';
const ATTACHMENT_BODY_LIMIT = 192 * 1024 * 1024;
const DEFAULT_JSON_BODY_LIMIT = 1024 * 1024;

function readQueryString(ctx) {
  if (ctx && ctx.url && typeof ctx.url.search === 'string') {
    return ctx.url.search.replace(/^\?/, '');
  }
  const rawUrl = String((ctx && ctx.req && ctx.req.url) || '');
  const qIndex = rawUrl.indexOf('?');
  return qIndex >= 0 ? rawUrl.slice(qIndex + 1) : '';
}

function toGoChatPath(pathname) {
  if (pathname === SESSIONS_PATH || pathname.startsWith(`${SESSIONS_PATH}/`)) {
    return `${GO_SESSIONS_PATH}${pathname.slice(SESSIONS_PATH.length)}`;
  }
  if (pathname.startsWith(`${ARTIFACTS_PATH}/`)) {
    return `${GO_ARTIFACTS_PATH}${pathname.slice(ARTIFACTS_PATH.length)}`;
  }
  return '';
}

function writeGoUnavailable(ctx, message = 'Go Core 未就绪，聊天运行时暂不可用') {
  ctx.writeJson(ctx.res, 503, {
    ok: false,
    error: 'go_core_unavailable',
    message
  });
  return true;
}

async function readRawRequestBody(ctx, maxBytes) {
  try {
    const buf = await ctx.readRequestBody(ctx.req, { maxBytes });
    return Buffer.isBuffer(buf) ? buf : Buffer.alloc(0);
  } catch (_error) {
    return null;
  }
}

async function pipeWebuiStream(ctx, options, onOpenHeaders) {
  const { req, res, writeJson } = ctx;
  const goHost = resolveGoHost(ctx);
  if (!goHost || typeof goHost.openWebuiStream !== 'function') {
    return writeGoUnavailable(ctx);
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
  if (req && typeof req.on === 'function') req.on('close', abort);
  if (res && typeof res.on === 'function') {
    res.on('close', abort);
    res.on('error', abort);
  }

  let upstream = null;
  try {
    upstream = await goHost.openWebuiStream(options);
  } catch (_error) {
    upstream = null;
  }

  if (closed || (req && req.destroyed) || res.destroyed || res.writableEnded) {
    if (upstream && upstream.body && typeof upstream.body.cancel === 'function') {
      try { await upstream.body.cancel(); } catch (_error) {}
    }
    return true;
  }

  if (!upstream) {
    return writeGoUnavailable(ctx);
  }

  if (!upstream.ok || !upstream.body) {
    const text = typeof upstream.text === 'function' ? await upstream.text().catch(() => '') : '';
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch (_error) { payload = null; }
    const status = Number(upstream.status) || 0;
    if (status >= 400 && status < 600 && payload) {
      writeJson(res, status, payload);
      return true;
    }
    return writeGoUnavailable(ctx);
  }

  const headers = onOpenHeaders(upstream);
  res.writeHead(Number(upstream.status) || 200, headers);
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  reader = upstream.body.getReader();
  try {
    while (!closed) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      if (!res.write(Buffer.from(value))) {
        await new Promise((resolve) => {
          const doneWait = () => {
            res.off('drain', doneWait);
            res.off('close', doneWait);
            res.off('error', doneWait);
            resolve();
          };
          res.once('drain', doneWait);
          res.once('close', doneWait);
          res.once('error', doneWait);
        });
      }
    }
  } catch (_error) {
    // 客户端或 Go 上游断开后收尾退出。
  } finally {
    abort();
    if (req && typeof req.off === 'function') req.off('close', abort);
    if (res && typeof res.off === 'function') {
      res.off('close', abort);
      res.off('error', abort);
    }
    if (!res.destroyed && !res.writableEnded) {
      try { res.end(); } catch (_error) {}
    }
  }
  return true;
}

async function handleEventStreamProxy(ctx, goPath) {
  const rawLastEventId = ctx && ctx.req && ctx.req.headers && ctx.req.headers['last-event-id'];
  const lastEventId = rawLastEventId === undefined ? '' : String(rawLastEventId).trim();
  return pipeWebuiStream(
    ctx,
    {
      method: 'GET',
      path: goPath,
      query: readQueryString(ctx),
      accept: 'text/event-stream',
      ...(lastEventId ? { headers: { 'last-event-id': lastEventId } } : {})
    },
    () => ({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
  );
}

async function handleArtifactProxy(ctx, goPath) {
  return pipeWebuiStream(
    ctx,
    {
      method: 'GET',
      path: goPath,
      query: readQueryString(ctx),
      accept: '*/*'
    },
    (upstream) => {
      const headers = {
        'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream'
      };
      const contentLength = upstream.headers.get('content-length');
      if (contentLength) headers['Content-Length'] = contentLength;
      return headers;
    }
  );
}

async function handleAttachmentsProxy(ctx, goPath) {
  const goHost = resolveGoHost(ctx);
  if (!goHost || typeof goHost.openWebuiStream !== 'function') {
    return writeGoUnavailable(ctx);
  }
  const rawBody = await readRawRequestBody(ctx, ATTACHMENT_BODY_LIMIT);
  if (rawBody === null) {
    ctx.writeJson(ctx.res, 400, {
      ok: false,
      error: 'invalid_chat_runtime_payload',
      message: 'invalid_chat_runtime_payload'
    });
    return true;
  }
  let upstream = null;
  try {
    upstream = await goHost.openWebuiStream({
      method: 'POST',
      path: goPath,
      query: readQueryString(ctx),
      body: rawBody.length > 0 ? rawBody : '{}',
      accept: 'application/json',
      headers: { 'content-type': 'application/json' }
    });
  } catch (_error) {
    upstream = null;
  }
  if (!upstream) {
    return writeGoUnavailable(ctx);
  }
  const text = typeof upstream.text === 'function' ? await upstream.text().catch(() => '') : '';
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch (_error) { payload = null; }
  const status = Number(upstream.status) || 0;
  if (status >= 200 && status < 600 && payload) {
    ctx.writeJson(ctx.res, status, payload);
    return true;
  }
  return writeGoUnavailable(ctx);
}

async function handleJsonProxy(ctx, goPath) {
  const method = String((ctx && ctx.method) || (ctx && ctx.req && ctx.req.method) || 'GET').toUpperCase();
  const query = readQueryString(ctx);
  const fullPath = query ? `${goPath}?${query}` : goPath;

  let body;
  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    const rawBody = await readRawRequestBody(ctx, DEFAULT_JSON_BODY_LIMIT);
    if (rawBody === null) {
      ctx.writeJson(ctx.res, 400, {
        ok: false,
        error: 'invalid_chat_runtime_payload',
        message: 'invalid_chat_runtime_payload'
      });
      return true;
    }
    const text = rawBody.toString('utf8').trim();
    body = text || '{}';
  }

  const { available, response } = await callGoHost(ctx, 'webuiRequest', [{
    method,
    path: fullPath,
    ...(body === undefined ? {} : { body })
  }]);
  if (!available) {
    return writeGoUnavailable(ctx);
  }
  if (response && response.ok === true) {
    const payload = response.body !== undefined ? response.body : (response.data || { ok: true });
    ctx.writeJson(ctx.res, Number(response.status) || 200, payload);
    return true;
  }
  const status = Number(response && response.status) || 0;
  const payload = response && (response.body !== undefined ? response.body : response.data);
  if (status >= 400 && status < 500 && payload) {
    ctx.writeJson(ctx.res, status, payload);
    return true;
  }
  if (status >= 500 && payload && payload.error) {
    ctx.writeJson(ctx.res, status, payload);
    return true;
  }
  return writeGoUnavailable(ctx);
}

async function handleWebUiChatRuntimeRequest(ctx) {
  const pathname = String((ctx && ctx.pathname) || '');
  const goPath = toGoChatPath(pathname);
  if (!goPath) return false;

  const method = String((ctx && ctx.method) || (ctx && ctx.req && ctx.req.method) || 'GET').toUpperCase();
  if (method === 'GET' && /^\/v0\/webui\/chat\/sessions\/[^/]+\/events$/.test(pathname)) {
    return handleEventStreamProxy(ctx, goPath);
  }
  if (method === 'GET' && pathname.startsWith(`${ARTIFACTS_PATH}/`)) {
    return handleArtifactProxy(ctx, goPath);
  }
  if (method === 'POST' && /^\/v0\/webui\/chat\/sessions\/[^/]+\/attachments$/.test(pathname)) {
    return handleAttachmentsProxy(ctx, goPath);
  }
  return handleJsonProxy(ctx, goPath);
}

module.exports = {
  handleWebUiChatRuntimeRequest
};
