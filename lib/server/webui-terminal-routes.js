'use strict';

// VSCode 风格底部终端面板的 Node 边界。
//
// 会话与 PTY 已整体切到 Go Core（internal/transport/http/webuiterminalapi）：
//   * 本文件不再持有 SESSIONS / MUXES / node-pty，只保留浏览器路径 + 管理密钥门；
//   * 每个端点原样反代到 /v1/management/webui/terminal/*，状态码与响应体透传；
//   * mux SSE 直接转发 Go 的字节流，帧形状（connected / output+termId / exit）不变。
//
// 浏览器协议（web/src/services/api.ts 的 terminalAPI）不受影响。

const { maxImageBytes } = require('../../contracts/chat-attachments.json');

const BROWSER_PREFIX = '/v0/webui/terminal/';
const GO_PREFIX = '/v1/management/webui/terminal';
const MAX_JSON_BYTES = 256 * 1024;
// 与 Go handler 的上限一致：base64 反推体积再留 4KB 余量。
const MAX_CLIPBOARD_BYTES = Math.ceil(maxImageBytes / 3) * 4 + 4096;

const GO_UNAVAILABLE = 'go_core_unavailable';

function resolveGoHost(ctx) {
  const deps = (ctx && ctx.deps) || {};
  // 生产接线用 deps.goCoreSync；测试可直接注入 ctx.goCoreSync。
  return (ctx && ctx.goCoreSync) || deps.goCoreSync || null;
}

function writeGoUnavailable(writeJson, res) {
  writeJson(res, 503, {
    ok: false,
    error: GO_UNAVAILABLE,
    message: 'Go Core 未就绪，终端不可用'
  });
}

async function readJsonBody(ctx, maxBytes) {
  try {
    const buffer = await ctx.readRequestBody(ctx.req, { maxBytes });
    return buffer && buffer.length ? JSON.parse(buffer.toString('utf8')) : null;
  } catch (_error) {
    // 与旧实现一致：解析失败当空 body，交给 Go 做参数校验。
    return null;
  }
}

function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

// 单一 JSON 代理：只做传输与状态透传，不重新解释业务字段。
async function proxyJson(ctx, path, body) {
  const { writeJson, res } = ctx;
  const goHost = resolveGoHost(ctx);
  if (!goHost || typeof goHost.terminalRequest !== 'function') {
    writeGoUnavailable(writeJson, res);
    return true;
  }
  let result = null;
  try {
    result = await goHost.terminalRequest({ method: 'POST', path: GO_PREFIX + path, body });
  } catch (_error) {
    result = null;
  }
  const status = Number(result && result.status);
  if (!result || !Number.isFinite(status) || status <= 0) {
    writeGoUnavailable(writeJson, res);
    return true;
  }
  const payload = asObject(result.body);
  writeJson(res, status, Object.keys(payload).length ? payload : {
    ok: false,
    error: result.errorCode || GO_UNAVAILABLE
  });
  return true;
}

// SSE 代理：Go 返回的是 fetch Response，Node 逐块写回浏览器。
async function proxyStream(ctx, path, query) {
  const { writeJson, res, req } = ctx;
  const goHost = resolveGoHost(ctx);
  if (!goHost || typeof goHost.openTerminalStream !== 'function') {
    writeGoUnavailable(writeJson, res);
    return true;
  }
  let upstream = null;
  try {
    upstream = await goHost.openTerminalStream({ path: GO_PREFIX + path, query });
  } catch (_error) {
    upstream = null;
  }
  if (!upstream) {
    writeGoUnavailable(writeJson, res);
    return true;
  }
  if (!upstream.ok || !upstream.body) {
    // Go 的 4xx/5xx 是 JSON 领域错误，按原状态透传，不把错误伪装成空流。
    const text = typeof upstream.text === 'function' ? await upstream.text().catch(() => '') : '';
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch (_error) { payload = null; }
    writeJson(res, Number(upstream.status) || 502, payload || { ok: false, error: GO_UNAVAILABLE });
    return true;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const reader = upstream.body.getReader();
  let closed = false;
  const abort = () => {
    if (closed) return;
    closed = true;
    try { reader.cancel(); } catch (_error) {}
  };
  req.on('close', abort);
  res.on('close', abort);
  res.on('error', abort);

  try {
    while (!closed) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) {
        // 背压：等 drain 再继续，避免把内存当作无限缓冲；客户端断开时也要解除等待，
        // 否则这条协程会一直挂在永远不触发的事件上。
        await new Promise((resolve) => {
          const done = () => {
            res.off('drain', done);
            res.off('close', done);
            resolve();
          };
          res.once('drain', done);
          res.once('close', done);
        });
      }
    }
  } catch (_error) {
    // 客户端断开或 Go 流结束都走这里，不需要额外错误帧。
  }
  try { res.end(); } catch (_error) {}
  return true;
}

// POST /v0/webui/terminal/open  { cols, rows, muxId, cwd, sessionKey }
async function handleTerminalOpen(ctx) {
  const body = asObject(await readJsonBody(ctx, MAX_JSON_BYTES));
  // 浏览器只能请求 shell 与 cwd；任意可执行/argv/env 只走进程内 /launch。
  return proxyJson(ctx, '/open', {
    cols: body.cols,
    rows: body.rows,
    muxId: body.muxId,
    cwd: body.cwd,
    sessionKey: body.sessionKey
  });
}

// POST /v0/webui/terminal/attach { sessionKey, muxId? }
async function handleTerminalAttach(ctx) {
  const body = asObject(await readJsonBody(ctx, MAX_JSON_BYTES));
  return proxyJson(ctx, '/attach', { sessionKey: body.sessionKey, muxId: body.muxId });
}

// POST /v0/webui/terminal/input { termId, data }
async function handleTerminalInput(ctx) {
  const body = asObject(await readJsonBody(ctx, MAX_JSON_BYTES));
  return proxyJson(ctx, '/input', { termId: body.termId, data: body.data });
}

// POST /v0/webui/terminal/resize { termId, cols, rows }
async function handleTerminalResize(ctx) {
  const body = asObject(await readJsonBody(ctx, MAX_JSON_BYTES));
  return proxyJson(ctx, '/resize', { termId: body.termId, cols: body.cols, rows: body.rows });
}

// POST /v0/webui/terminal/close { termId?, sessionKey? }
async function handleTerminalClose(ctx) {
  const body = asObject(await readJsonBody(ctx, MAX_JSON_BYTES));
  return proxyJson(ctx, '/close', { termId: body.termId, sessionKey: body.sessionKey });
}

// POST /v0/webui/terminal/clipboard-image { sessionKey, cwd, dataUrl }
async function handleTerminalClipboardImage(ctx) {
  const body = asObject(await readJsonBody(ctx, MAX_CLIPBOARD_BYTES));
  return proxyJson(ctx, '/clipboard-image', {
    sessionKey: body.sessionKey,
    cwd: body.cwd,
    dataUrl: body.dataUrl
  });
}

// GET /v0/webui/terminal/mux?muxId=...
async function handleTerminalMux(ctx) {
  const muxId = ctx.url && ctx.url.searchParams ? String(ctx.url.searchParams.get('muxId') || '') : '';
  return proxyStream(ctx, '/mux', `muxId=${encodeURIComponent(muxId)}`);
}

// GET /v0/webui/terminal/stream?termId=...（历史端点，保留协议兼容）
async function handleTerminalStream(ctx) {
  const termId = ctx.url && ctx.url.searchParams ? String(ctx.url.searchParams.get('termId') || '') : '';
  return proxyStream(ctx, '/stream', `termId=${encodeURIComponent(termId)}`);
}

// 主分发：命中任意 /v0/webui/terminal/* 返回 true，否则 false（交回上层路由）。
async function handleWebUiTerminalRequest(ctx) {
  const { method, pathname } = ctx;
  if (!pathname || !pathname.startsWith(BROWSER_PREFIX)) return false;
  const action = pathname.slice(BROWSER_PREFIX.length);

  if (method === 'GET' && action === 'mux') return handleTerminalMux(ctx);
  if (method === 'GET' && action === 'stream') return handleTerminalStream(ctx);
  if (method !== 'POST') return false;
  switch (action) {
    case 'open': return handleTerminalOpen(ctx);
    case 'attach': return handleTerminalAttach(ctx);
    case 'input': return handleTerminalInput(ctx);
    case 'resize': return handleTerminalResize(ctx);
    case 'close': return handleTerminalClose(ctx);
    case 'clipboard-image': return handleTerminalClipboardImage(ctx);
    default: return false;
  }
}

// env 对象 → KEY=VALUE 数组（Go 侧按环境变量覆盖处理）。
function envPairs(env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return [];
  return Object.entries(env)
    .filter(([key, value]) => key && value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${String(value)}`);
}

// 进程内启动器入口：账号 CLI / 远程工作区 / SSH 守护用同一个 Go 会话服务。
//
// 与浏览器 /open 的边界：这里允许 file/args/env，但只存在于 Node 进程内调用，
// 永远不经过 /v0/webui/terminal/* 的代理（见 handleTerminalOpen 的字段收口）。
async function openWebUiTerminalSession(input = {}, goHost = null) {
  if (!goHost || typeof goHost.terminalRequest !== 'function') {
    return { ok: false, error: 'web_terminal_unavailable', message: 'Go Core 未就绪' };
  }
  const body = {
    sessionKey: input.sessionKey,
    cwd: input.cwd,
    file: input.file,
    args: Array.isArray(input.args) ? input.args.map((item) => String(item)) : [],
    env: envPairs(input.env),
    cols: input.cols,
    rows: input.rows,
    muxId: input.muxId,
    persistent: input.persistent === true
  };
  let result = null;
  try {
    result = await goHost.terminalRequest({ method: 'POST', path: GO_PREFIX + '/launch', body });
  } catch (error) {
    return { ok: false, error: 'web_terminal_unavailable', message: String((error && error.message) || error) };
  }
  if (!result || !result.body || typeof result.body !== 'object') {
    return { ok: false, error: 'web_terminal_unavailable' };
  }
  return result.body;
}

// 查询 sessionKey 对应的 tmux 外层是否还活着（SSH 工作区状态用）。
async function probeTerminalSession(sessionKey, goHost = null) {
  if (!goHost || typeof goHost.terminalRequest !== 'function') {
    return { state: 'unavailable', message: 'go_core_unavailable' };
  }
  const key = String(sessionKey || '').trim();
  if (!key) return { state: 'missing' };
  let result = null;
  try {
    result = await goHost.terminalRequest({
      method: 'GET',
      path: GO_PREFIX + '/probe?sessionKey=' + encodeURIComponent(key)
    });
  } catch (_error) {
    result = null;
  }
  const body = asObject(result && result.body);
  return {
    state: String(body.state || 'unavailable'),
    message: String(body.message || '')
  };
}

module.exports = {
  handleWebUiTerminalRequest,
  openWebUiTerminalSession,
  probeTerminalSession
};
