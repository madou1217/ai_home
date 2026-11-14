'use strict';

// 原生 Chat Runs 控制、内部审批长轮询、CLI 安装确认与已退役 legacy /chat 的零回退 Go 代理。
// 全部运行态注册、PTY 输入/尺寸控制、中断、审批流转与确认裁决均已迁至 Go
// (internal/runtime/chatruntime + internal/transport/http/webuichatapi)。

const { proxyWebuiGo, resolveGoHost } = require('./webui-go-proxy');

const GO_RUNS_PATH = '/v1/management/webui/chat/runs';
const GO_INTERNAL_APPROVAL_PATH = '/v1/management/webui/chat/internal/approval-request';
const GO_CLI_CONFIRMATIONS_PATH = '/v1/management/webui/chat/cli-install-confirmations';
const GO_LEGACY_CHAT_PATH = '/v1/management/webui/chat';

const DEFAULT_PASS_STATUSES = Object.freeze([400, 401, 404, 409]);

function readQueryString(ctx) {
  if (ctx && ctx.url && typeof ctx.url.search === 'string') {
    return ctx.url.search.replace(/^\?/, '');
  }
  const rawUrl = String((ctx && ctx.req && ctx.req.url) || '');
  const qIndex = rawUrl.indexOf('?');
  return qIndex >= 0 ? rawUrl.slice(qIndex + 1) : '';
}

function sanitizeRouteSegment(rawSegment) {
  const raw = String(rawSegment || '').trim();
  if (!raw) return '';
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch (_error) {
    decoded = raw;
  }
  const clean = decoded.trim();
  if (!clean || clean === '.' || clean === '..' || clean.includes('/') || clean.includes('\\') || clean.includes('..')) {
    return '';
  }
  return encodeURIComponent(clean);
}

function writeGoUnavailable(ctx, message = 'Go Core 未就绪') {
  ctx.writeJson(ctx.res, 503, {
    ok: false,
    error: 'go_core_unavailable',
    message
  });
  return true;
}

async function readOptionalJsonBody(ctx, maxBytes, invalidErrorCode = 'invalid_json') {
  if (!ctx || typeof ctx.readRequestBody !== 'function') {
    return { ok: true, body: {} };
  }
  let buf;
  try {
    buf = await ctx.readRequestBody(ctx.req, { maxBytes });
  } catch (_error) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: invalidErrorCode });
    return { ok: false, body: undefined };
  }
  const text = Buffer.isBuffer(buf) ? buf.toString('utf8').trim() : '';
  if (!text) {
    return { ok: true, body: {} };
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      ctx.writeJson(ctx.res, 400, { ok: false, error: invalidErrorCode });
      return { ok: false, body: undefined };
    }
    return { ok: true, body: parsed };
  } catch (_error) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: invalidErrorCode });
    return { ok: false, body: undefined };
  }
}

async function handleNativeChatRunListRequest(ctx) {
  return proxyWebuiGo(ctx, {
    method: 'GET',
    path: GO_RUNS_PATH,
    query: readQueryString(ctx),
    passStatuses: DEFAULT_PASS_STATUSES,
    message: 'Go Core 未就绪，无法读取活跃会话运行列表'
  });
}

async function handleNativeChatRunInputRequest(ctx) {
  const matches = String((ctx && ctx.pathname) || '').match(/^\/v0\/webui\/chat\/runs\/([^/]+)\/input$/);
  const runId = sanitizeRouteSegment(matches && matches[1]);
  if (!runId) {
    ctx.writeJson(ctx.res, 404, { ok: false, error: 'native_chat_run_not_found' });
    return true;
  }
  const parsed = await readOptionalJsonBody(ctx, 256 * 1024);
  if (!parsed.ok) return true;
  return proxyWebuiGo(ctx, {
    method: 'POST',
    path: `${GO_RUNS_PATH}/${runId}/input`,
    body: parsed.body,
    passStatuses: DEFAULT_PASS_STATUSES,
    message: 'Go Core 未就绪，无法向运行中会话写入输入'
  });
}

async function handleNativeChatRunResizeRequest(ctx) {
  const matches = String((ctx && ctx.pathname) || '').match(/^\/v0\/webui\/chat\/runs\/([^/]+)\/resize$/);
  const runId = sanitizeRouteSegment(matches && matches[1]);
  if (!runId) {
    ctx.writeJson(ctx.res, 404, { ok: false, error: 'native_chat_run_not_found' });
    return true;
  }
  const parsed = await readOptionalJsonBody(ctx, 64 * 1024, 'native_chat_resize_invalid');
  if (!parsed.ok) return true;
  return proxyWebuiGo(ctx, {
    method: 'POST',
    path: `${GO_RUNS_PATH}/${runId}/resize`,
    body: parsed.body,
    passStatuses: DEFAULT_PASS_STATUSES,
    message: 'Go Core 未就绪，无法调整终端窗口尺寸'
  });
}

async function handleNativeChatRunAbortRequest(ctx) {
  const matches = String((ctx && ctx.pathname) || '').match(/^\/v0\/webui\/chat\/runs\/([^/]+)\/abort$/);
  const runId = sanitizeRouteSegment(matches && matches[1]);
  if (!runId) {
    ctx.writeJson(ctx.res, 404, { ok: false, error: 'native_chat_run_not_found' });
    return true;
  }
  return proxyWebuiGo(ctx, {
    method: 'POST',
    path: `${GO_RUNS_PATH}/${runId}/abort`,
    body: {},
    passStatuses: DEFAULT_PASS_STATUSES,
    message: 'Go Core 未就绪，无法终止运行中会话'
  });
}

async function handleNativeApprovalInboundRequest(ctx) {
  const { req, res, writeJson } = ctx;
  let rawBuf = Buffer.alloc(0);
  if (typeof ctx.readRequestBody === 'function') {
    try {
      const read = await ctx.readRequestBody(req, { maxBytes: 512 * 1024 });
      rawBuf = Buffer.isBuffer(read) ? read : Buffer.alloc(0);
    } catch (_error) {
      writeJson(res, 400, { ok: false, error: 'invalid_json' });
      return true;
    }
  }

  const goHost = resolveGoHost(ctx);
  if (!goHost || typeof goHost.openWebuiStream !== 'function') {
    return writeGoUnavailable(ctx, 'Go Core 未就绪，无法处理原生审批请求');
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
  const onResClose = () => {
    if (!res.writableEnded) abort();
  };
  if (req && typeof req.on === 'function') req.on('aborted', abort);
  if (res && typeof res.on === 'function') {
    res.on('close', onResClose);
    res.on('error', abort);
  }

  let upstream = null;
  try {
    upstream = await goHost.openWebuiStream({
      method: 'POST',
      path: GO_INTERNAL_APPROVAL_PATH,
      body: rawBuf.length > 0 ? rawBuf : Buffer.from('{}'),
      accept: 'application/json',
      headers: { 'content-type': 'application/json' }
    });
  } catch (_error) {
    upstream = null;
  }

  if (closed || (req && req.aborted) || res.destroyed || res.writableEnded) {
    if (upstream && upstream.body && typeof upstream.body.cancel === 'function') {
      try { await upstream.body.cancel(); } catch (_error) {}
    }
    if (req && typeof req.off === 'function') req.off('aborted', abort);
    if (res && typeof res.off === 'function') {
      res.off('close', onResClose);
      res.off('error', abort);
    }
    return true;
  }

  if (!upstream) {
    if (req && typeof req.off === 'function') req.off('aborted', abort);
    if (res && typeof res.off === 'function') {
      res.off('close', onResClose);
      res.off('error', abort);
    }
    return writeGoUnavailable(ctx, 'Go Core 未就绪，无法处理原生审批请求');
  }

  if (!upstream.ok || !upstream.body) {
    const text = typeof upstream.text === 'function' ? await upstream.text().catch(() => '') : '';
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch (_error) { payload = null; }
    if (req && typeof req.off === 'function') req.off('aborted', abort);
    if (res && typeof res.off === 'function') {
      res.off('close', onResClose);
      res.off('error', abort);
    }
    const status = Number(upstream.status) || 0;
    if (status >= 400 && status < 600 && payload) {
      writeJson(res, status, payload);
      return true;
    }
    return writeGoUnavailable(ctx, 'Go Core 未就绪，无法处理原生审批请求');
  }

  res.writeHead(Number(upstream.status) || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform'
  });
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
    // 审批工具或 Go 上游断开后直接清理并退出。
  } finally {
    abort();
    if (req && typeof req.off === 'function') req.off('aborted', abort);
    if (res && typeof res.off === 'function') {
      res.off('close', onResClose);
      res.off('error', abort);
    }
    if (!res.destroyed && !res.writableEnded) {
      try { res.end(); } catch (_error) {}
    }
  }
  return true;
}

async function handleNativeApprovalDecisionRequest(ctx) {
  const matches = String((ctx && ctx.pathname) || '')
    .match(/^\/v0\/webui\/chat\/runs\/([^/]+)\/approvals\/([^/]+)$/);
  const runId = sanitizeRouteSegment(matches && matches[1]);
  const approvalId = sanitizeRouteSegment(matches && matches[2]);
  if (!runId || !approvalId) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_approval_request' });
    return true;
  }
  const parsed = await readOptionalJsonBody(ctx, 64 * 1024);
  if (!parsed.ok) return true;
  return proxyWebuiGo(ctx, {
    method: 'POST',
    path: `${GO_RUNS_PATH}/${runId}/approvals/${approvalId}`,
    body: parsed.body,
    passStatuses: DEFAULT_PASS_STATUSES,
    message: 'Go Core 未就绪，无法提交审批决策'
  });
}

async function handleCliInstallConfirmationDecisionRequest(ctx) {
  const matches = String((ctx && ctx.pathname) || '')
    .match(/^\/v0\/webui\/chat\/cli-install-confirmations\/([^/]+)$/);
  const confirmationId = sanitizeRouteSegment(matches && matches[1]);
  if (!confirmationId) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_cli_install_confirmation' });
    return true;
  }
  const parsed = await readOptionalJsonBody(ctx, 64 * 1024, 'invalid_cli_install_confirmation');
  if (!parsed.ok) return true;
  return proxyWebuiGo(ctx, {
    method: 'POST',
    path: `${GO_CLI_CONFIRMATIONS_PATH}/${confirmationId}`,
    body: parsed.body,
    passStatuses: DEFAULT_PASS_STATUSES,
    message: 'Go Core 未就绪，无法提交 CLI 安装确认'
  });
}

async function handleChatRequest(ctx) {
  const parsed = await readOptionalJsonBody(ctx, 192 * 1024 * 1024, 'invalid_payload');
  if (!parsed.ok) return true;
  return proxyWebuiGo(ctx, {
    method: 'POST',
    path: GO_LEGACY_CHAT_PATH,
    body: parsed.body,
    passStatuses: DEFAULT_PASS_STATUSES,
    message: 'Go Core 未就绪，聊天入口暂不可用'
  });
}

module.exports = {
  handleNativeChatRunListRequest,
  handleNativeChatRunInputRequest,
  handleNativeChatRunResizeRequest,
  handleNativeChatRunAbortRequest,
  handleNativeApprovalInboundRequest,
  handleNativeApprovalDecisionRequest,
  handleCliInstallConfirmationDecisionRequest,
  handleChatRequest
};
