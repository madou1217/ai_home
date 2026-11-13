'use strict';

// WebUI 文件访问/读取/信任/媒体预览路由统一反代至 Go Core workspace/fs（零 Node 回落）：
//   GET  /v0/webui/fs/access → GET  /v1/management/webui/workspace/fs/access
//   GET  /v0/webui/fs/read   → GET  /v1/management/webui/workspace/fs/read
//   GET  /v0/webui/fs/media  → GET  /v1/management/webui/workspace/fs/media
//   POST /v0/webui/fs/trust  → POST /v1/management/webui/workspace/fs/trust

const { proxyWebuiGo, resolveGoHost } = require('./webui-go-proxy');

const FS_PASS_STATUSES = Object.freeze([400, 403, 404, 409, 413, 415, 500]);
const MAX_TRUST_BODY_BYTES = 64 * 1024;

function readQueryString(ctx) {
  if (ctx && ctx.url && ctx.url.searchParams) {
    return ctx.url.searchParams.toString();
  }
  const rawUrl = String((ctx && ctx.req && ctx.req.url) || '');
  const qIndex = rawUrl.indexOf('?');
  return qIndex >= 0 ? rawUrl.slice(qIndex + 1) : '';
}

function disableFilePreviewCaching(res) {
  if (!res || typeof res.setHeader !== 'function') return;
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
}

async function handleCheckFileAccessRequest(ctx) {
  disableFilePreviewCaching(ctx.res);
  return proxyWebuiGo(ctx, {
    method: 'GET',
    path: '/v1/management/webui/workspace/fs/access',
    query: readQueryString(ctx),
    passStatuses: FS_PASS_STATUSES,
    message: 'Go Core 未就绪，检查文件权限不可用'
  });
}

async function handleReadFileRequest(ctx) {
  disableFilePreviewCaching(ctx.res);
  return proxyWebuiGo(ctx, {
    method: 'GET',
    path: '/v1/management/webui/workspace/fs/read',
    query: readQueryString(ctx),
    passStatuses: FS_PASS_STATUSES,
    message: 'Go Core 未就绪，读取文件不可用'
  });
}

async function handleTrustFilePathRequest(ctx) {
  let payload = {};
  try {
    const rawBuffer = await ctx.readRequestBody(ctx.req, { maxBytes: MAX_TRUST_BODY_BYTES });
    const rawText = rawBuffer ? rawBuffer.toString('utf8').trim() : '';
    payload = rawText ? JSON.parse(rawText) : {};
  } catch (error) {
    const syntaxError = error instanceof SyntaxError;
    ctx.writeJson(ctx.res, syntaxError ? 400 : 500, {
      ok: false,
      error: syntaxError ? 'invalid_json' : 'trust_file_path_failed',
      message: syntaxError ? '请求内容不是有效 JSON' : String((error && error.message) || error || '保存文件信任失败')
    });
    return true;
  }

  return proxyWebuiGo(ctx, {
    method: 'POST',
    path: '/v1/management/webui/workspace/fs/trust',
    body: payload,
    passStatuses: FS_PASS_STATUSES,
    message: 'Go Core 未就绪，无法保存文件信任'
  });
}

async function handleReadFileMediaRequest(ctx) {
  const { req, res, writeJson } = ctx;
  disableFilePreviewCaching(res);
  const goHost = resolveGoHost(ctx);
  if (!goHost || typeof goHost.openWebuiStream !== 'function') {
    writeJson(res, 503, {
      ok: false,
      error: 'go_core_unavailable',
      message: 'Go Core 未就绪，媒体预览不可用'
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
  req.on('close', abort);
  res.on('close', abort);
  res.on('error', abort);

  let upstream = null;
  try {
    upstream = await goHost.openWebuiStream({
      method: 'GET',
      path: '/v1/management/webui/workspace/fs/media',
      query: readQueryString(ctx),
      accept: '*/*'
    });
  } catch (_error) {
    upstream = null;
  }

  if (closed || req.destroyed || res.destroyed || res.writableEnded) {
    if (upstream && upstream.body && typeof upstream.body.cancel === 'function') {
      try { await upstream.body.cancel(); } catch (_error) {}
    }
    return true;
  }

  if (!upstream) {
    writeJson(res, 503, {
      ok: false,
      error: 'go_core_unavailable',
      message: 'Go Core 未就绪，媒体预览不可用'
    });
    return true;
  }

  if (!upstream.ok || !upstream.body) {
    const text = typeof upstream.text === 'function' ? await upstream.text().catch(() => '') : '';
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch (_error) { payload = null; }
    writeJson(res, Number(upstream.status) || 502, payload || {
      ok: false,
      error: 'read_media_failed',
      message: '读取媒体文件失败'
    });
    return true;
  }

  const headers = {
    'Content-Type': upstream.headers.get('content-type') || 'application/octet-stream',
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache'
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
    req.off('close', abort);
    res.off('close', abort);
    res.off('error', abort);
    if (!res.destroyed && !res.writableEnded) {
      try { res.end(); } catch (_error) {}
    }
  }
  return true;
}

module.exports = {
  handleCheckFileAccessRequest,
  handleReadFileMediaRequest,
  handleReadFileRequest,
  handleTrustFilePathRequest
};
