'use strict';

// 聊天附件下载路由的零回退 Go 代理。
// 路径校验、符号链接约束、私密产物拦截与 MIME 判定全量托管于 Go
// (GET /v1/management/webui/chat/attachments)。

function readQueryString(ctx) {
  const search = ctx && ctx.url && typeof ctx.url.search === 'string' ? ctx.url.search : '';
  return search.replace(/^\?/, '');
}

async function handleGetChatAttachmentRequest(ctx) {
  const { req, res, writeJson } = ctx;
  const method = String((ctx && ctx.method) || (req && req.method) || 'GET').toUpperCase();
  if (method !== 'GET') {
    writeJson(res, 405, { ok: false, error: 'method_not_allowed', message: '只支持读取聊天附件' });
    return true;
  }

  const goHost = ctx && ctx.deps && ctx.deps.goCoreSync;
  if (!goHost || typeof goHost.openWebuiStream !== 'function') {
    writeJson(res, 503, {
      ok: false,
      error: 'go_core_unavailable',
      message: 'Go Core 未就绪，聊天附件服务不可用'
    });
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
  if (req && typeof req.on === 'function') req.on('close', abort);
  if (res && typeof res.on === 'function') {
    res.on('close', abort);
    res.on('error', abort);
  }

  let upstream = null;
  try {
    upstream = await goHost.openWebuiStream({
      method: 'GET',
      path: '/v1/management/webui/chat/attachments',
      query: readQueryString(ctx),
      accept: '*/*'
    });
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
    writeJson(res, 503, {
      ok: false,
      error: 'go_core_unavailable',
      message: 'Go Core 未就绪，聊天附件服务不可用'
    });
    return true;
  }

  if (!upstream.ok || !upstream.body) {
    const text = typeof upstream.text === 'function' ? await upstream.text().catch(() => '') : '';
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch (_error) { payload = null; }
    writeJson(res, Number(upstream.status) || 502, payload || {
      ok: false,
      error: 'chat_attachment_not_found'
    });
    return true;
  }

  const headers = {
    'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
    'Cache-Control': upstream.headers.get('cache-control') || 'private, max-age=300'
  };
  const contentLength = upstream.headers.get('content-length');
  if (contentLength) {
    headers['Content-Length'] = contentLength;
  }
  res.writeHead(Number(upstream.status) || 200, headers);

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
    // 客户端或 Go 上游断开后结束响应。
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

module.exports = {
  handleGetChatAttachmentRequest
};
