'use strict';

// /v0/webui/accounts/codex/:accountRef/reset-*：Codex 额度重置卡薄代理。
// 状态库、幂等互斥、app-server RPC 与核对监听全部在 Go（webuicodexresetcreditapi），Node 零回退。

const { callGoHost, resolveGoHost, writeGoFailure } = require('./webui-go-proxy');

const LIST_PATTERN = /^\/v0\/webui\/accounts\/codex\/([^/]+)\/reset-credits$/;
const CONSUME_PATTERN = /^\/v0\/webui\/accounts\/codex\/([^/]+)\/reset-credits\/consume$/;
const WATCH_PATTERN = /^\/v0\/webui\/accounts\/codex\/([^/]+)\/reset-operations\/([^/]+)\/watch$/;
const OPERATION_PATTERN = /^\/v0\/webui\/accounts\/codex\/([^/]+)\/reset-operations\/([^/]+)$/;
const RECONCILE_PATTERN = /^\/v0\/webui\/accounts\/codex\/([^/]+)\/reset-operations\/([^/]+)\/reconcile$/;
const PASS_STATUSES = [400, 404, 409, 502, 503];

function writeJson(ctx, status, payload) {
  if (typeof ctx.writeJson === 'function') {
    ctx.writeJson(ctx.res, status, payload);
    return;
  }
  ctx.res.writeHead(status, { 'Content-Type': 'application/json' });
  ctx.res.end(JSON.stringify(payload));
}

function withWriteJson(ctx) {
  if (ctx && typeof ctx.writeJson === 'function') return ctx;
  return { ...ctx, writeJson: (res, status, payload) => writeJson({ res }, status, payload) };
}

function writeNoStoreHeaders(res) {
  if (!res || typeof res.setHeader !== 'function') return;
  res.setHeader('cache-control', 'no-store');
  res.setHeader('pragma', 'no-cache');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
}

function decodePathValue(value) {
  try {
    return decodeURIComponent(String(value || '')).trim();
  } catch (_error) {
    return '';
  }
}

async function readJsonBody(ctx) {
  const readRequestBody = ctx.readRequestBody || (ctx.deps && ctx.deps.readRequestBody);
  if (typeof readRequestBody !== 'function') return null;
  try {
    const body = await readRequestBody(ctx.req, { maxBytes: 32 * 1024 });
    return body && body.length > 0 ? JSON.parse(body.toString('utf8')) : {};
  } catch (_error) {
    return null;
  }
}

function resolveRoute(pathname) {
  const patterns = [
    ['watch', WATCH_PATTERN],
    ['reconcile', RECONCILE_PATTERN],
    ['operation', OPERATION_PATTERN],
    ['consume', CONSUME_PATTERN],
    ['list', LIST_PATTERN]
  ];
  for (const [kind, pattern] of patterns) {
    const match = String(pathname || '').match(pattern);
    if (!match) continue;
    const accountRef = decodePathValue(match[1]);
    const operationId = decodePathValue(match[2]);
    return accountRef ? { kind, accountRef, operationId } : { invalid: true };
  }
  return null;
}

function goResetPath(route) {
  const ref = encodeURIComponent(route.accountRef);
  const op = encodeURIComponent(route.operationId || '');
  switch (route.kind) {
    case 'list':
      return `/v1/management/webui/accounts/codex/${ref}/reset-credits`;
    case 'consume':
      return `/v1/management/webui/accounts/codex/${ref}/reset-credits/consume`;
    case 'operation':
      return `/v1/management/webui/accounts/codex/${ref}/reset-operations/${op}`;
    case 'watch':
      return `/v1/management/webui/accounts/codex/${ref}/reset-operations/${op}/watch`;
    case 'reconcile':
      return `/v1/management/webui/accounts/codex/${ref}/reset-operations/${op}/reconcile`;
    default:
      return '';
  }
}

// consume 与 reconcile 可能动态返回 200 或 202，按 Go 的 response.status 原样透传。
async function proxyDynamicWebuiGo(ctx, { method, path, body, message }) {
  const { available, response } = await callGoHost(ctx, 'webuiRequest', [{
    method,
    path,
    body
  }]);
  if (!available) {
    ctx.writeJson(ctx.res, 503, { ok: false, error: 'go_core_unavailable', message });
    return true;
  }
  if (response && response.ok === true && response.data) {
    ctx.writeJson(ctx.res, Number(response.status) || 200, response.data);
    return true;
  }
  return writeGoFailure(ctx, response, {
    message,
    passStatuses: PASS_STATUSES,
    fallbackStatus: 503
  });
}

async function handleCodexResetWatch(ctx, goPath) {
  const { req, res, writeJson } = ctx;
  const goHost = resolveGoHost(ctx);
  if (!goHost || typeof goHost.openWebuiStream !== 'function') {
    writeJson(res, 503, {
      ok: false,
      error: 'codex_reset_service_unavailable',
      message: 'Go Core 未就绪，Codex 重置进度监听不可用'
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
      path: goPath,
      accept: 'text/event-stream'
    });
  } catch (_error) {
    upstream = null;
  }

  if (closed || (req && req.destroyed) || (res && (res.destroyed || res.writableEnded))) {
    if (upstream && upstream.body && typeof upstream.body.cancel === 'function') {
      try { await upstream.body.cancel(); } catch (_error) {}
    }
    return true;
  }

  if (!upstream) {
    writeJson(res, 503, {
      ok: false,
      error: 'codex_reset_service_unavailable',
      message: 'Go Core 未就绪，Codex 重置进度监听不可用'
    });
    return true;
  }

  if (!upstream.ok || !upstream.body) {
    const text = typeof upstream.text === 'function' ? await upstream.text().catch(() => '') : '';
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch (_error) { payload = null; }
    writeJson(res, Number(upstream.status) || 502, payload || { ok: false, error: 'codex_reset_service_unavailable' });
    return true;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  reader = upstream.body.getReader();
  try {
    while (!closed) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        await new Promise((resolve) => {
          const finish = () => {
            res.off('drain', finish);
            res.off('close', finish);
            resolve();
          };
          res.once('drain', finish);
          res.once('close', finish);
        });
      }
    }
  } catch (_error) {
    // 客户端断开或 Go 流结束。
  }
  try { res.end(); } catch (_error) {}
  return true;
}

async function handleWebUiCodexResetCreditRoutes(rawCtx = {}) {
  const ctx = withWriteJson(rawCtx);
  const route = resolveRoute(ctx.pathname);
  if (!route) return false;
  writeNoStoreHeaders(ctx.res);
  if (route.invalid) {
    ctx.writeJson(ctx.res, 400, {
      ok: false,
      error: 'invalid_codex_reset_credit_path',
      message: 'Codex 重置卡路径无效'
    });
    return true;
  }

  const goPath = goResetPath(route);
  if (route.kind === 'list' && ctx.method === 'GET') {
    return proxyDynamicWebuiGo(ctx, {
      method: 'GET',
      path: goPath,
      message: 'Go Core 未就绪，Codex 重置服务不可用'
    });
  }
  if (route.kind === 'consume' && ctx.method === 'POST') {
    const body = await readJsonBody(ctx);
    if (!body || !body.operationId || !body.inventoryVersion) {
      ctx.writeJson(ctx.res, 400, {
        ok: false,
        error: 'invalid_codex_reset_consume_payload',
        message: '重置操作 ID 或库存版本缺失'
      });
      return true;
    }
    return proxyDynamicWebuiGo(ctx, {
      method: 'POST',
      path: goPath,
      body: {
        operationId: String(body.operationId).trim(),
        inventoryVersion: String(body.inventoryVersion).trim()
      },
      message: 'Go Core 未就绪，Codex 重置服务不可用'
    });
  }
  if (route.kind === 'watch' && ctx.method === 'GET') {
    return handleCodexResetWatch(ctx, goPath);
  }
  if (route.kind === 'operation' && ctx.method === 'GET') {
    return proxyDynamicWebuiGo(ctx, {
      method: 'GET',
      path: goPath,
      message: 'Go Core 未就绪，Codex 重置服务不可用'
    });
  }
  if (route.kind === 'reconcile' && ctx.method === 'POST') {
    return proxyDynamicWebuiGo(ctx, {
      method: 'POST',
      path: goPath,
      message: 'Go Core 未就绪，Codex 重置服务不可用'
    });
  }

  ctx.writeJson(ctx.res, 405, {
    ok: false,
    error: 'method_not_allowed',
    message: '不支持的 Codex 重置卡操作'
  });
  return true;
}

module.exports = {
  handleWebUiCodexResetCreditRoutes
};
