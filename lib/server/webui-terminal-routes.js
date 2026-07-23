'use strict';

// VSCode 风格底部终端面板的后端：为 WebUI 提供一个真实交互式 shell PTY。
// 传输采用「POST 写入 + fetch SSE 读取」桥接，Management Key 只走 Authorization header。
//
// 本文件完全自包含：直接 require node-pty-loader 与 sse-broadcaster，
// 不改动 native-session-chat.js / webui-chat-routes.js，最小化与其它线程的冲突面。

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadNodePty, withPlatformPtyOptions } = require('../runtime/node-pty-loader');
const {
  openSseStream,
  writeSseJson,
  writeSseComment
} = require('./webui-sse-broadcaster');

// termId -> session
const SESSIONS = new Map();
// muxId -> { watchers:Set<res>, lastActivity } —— 一个面板一条 SSE，承载其全部 tab 的输出。
// 多 tab 若各开一条 EventSource 会撞浏览器每域 ~6 连接上限（第 6+ 个永远卡在“连接中”），
// 故所有 tab 的输出复用同一条 mux 流，按 termId 打标分发到各自 xterm。
const MUXES = new Map();

const MAX_BUFFER_BYTES = 256 * 1024; // 挂载前回放缓冲上限
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 分钟无活动自动回收
const MAX_SESSIONS = 12;

function now() {
  return Date.now();
}

function pickShell() {
  if (process.platform === 'win32') {
    return { file: process.env.COMSPEC || 'powershell.exe', args: [] };
  }
  const shell = process.env.SHELL || '/bin/bash';
  // 登录 shell 以获得用户完整环境（别名/PATH）。
  return { file: shell, args: ['-l'] };
}

// 仓库根：本文件在 <root>/lib/server/ 下。
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// 保证「aih」命令在终端里可用——本地是 homebrew/npm symlink，但远端（如 AWS）
// 部署包通常没做过 npm link，login shell 里 `aih` command not found。
// 这里在 <root>/.runtime-bin 生成一个自包含 shim（exec node bin/ai-home.js），
// 并把该目录前置到 PTY 的 PATH，无需依赖部署脚本手动 symlink。返回要注入 PATH 的目录（失败则 null）。
let cachedShimDir;
function ensureAihShimDir() {
  if (cachedShimDir !== undefined) return cachedShimDir;
  try {
    const entry = path.join(REPO_ROOT, 'bin', 'ai-home.js');
    if (!fs.existsSync(entry)) {
      cachedShimDir = null;
      return cachedShimDir;
    }
    const shimDir = path.join(REPO_ROOT, '.runtime-bin');
    fs.mkdirSync(shimDir, { recursive: true });
    if (process.platform !== 'win32') {
      const shim = path.join(shimDir, 'aih');
      const body = `#!/bin/sh\nexec "${process.execPath}" "${entry}" "$@"\n`;
      // 幂等：仅在缺失/内容变化时写，避免每次 open 都 churn 磁盘。
      let existing = '';
      try { existing = fs.readFileSync(shim, 'utf8'); } catch (_e) { existing = ''; }
      if (existing !== body) fs.writeFileSync(shim, body, { mode: 0o755 });
      fs.chmodSync(shim, 0o755);
    }
    cachedShimDir = shimDir;
  } catch (_error) {
    cachedShimDir = null;
  }
  return cachedShimDir;
}

// 组装 PTY 环境：把 aih shim 目录前置进 PATH。
function buildTerminalEnv() {
  const env = { ...process.env, TERM: 'xterm-256color', AIH_WEBUI_TERMINAL: '1' };
  const shimDir = ensureAihShimDir();
  if (shimDir) {
    const sep = process.platform === 'win32' ? ';' : ':';
    env.PATH = `${shimDir}${sep}${env.PATH || ''}`;
  }
  return env;
}

// cwd 落地校验：前端传来的项目路径可能在目标 server 上不存在
// （如把 Mac 路径发到 Linux server），此时回退 home 目录，避免 pty spawn 直接失败。
function resolveTerminalCwd(requested) {
  const candidate = (typeof requested === 'string' && requested.trim()) ? requested.trim() : '';
  if (candidate) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch (_error) { /* 不存在/无权限 → 回退 */ }
  }
  return os.homedir();
}

function reapIdleSessions() {
  const cutoff = now() - IDLE_TIMEOUT_MS;
  for (const [termId, session] of SESSIONS) {
    // mux 架构下没人连 /stream（session.watchers 恒为空），必须把「所属 mux 仍有面板订阅」
    // 也算作被观察，否则一个安静挂在 prompt 的终端会在 30 分钟后被误杀（用户面板还开着）。
    const mux = session.muxId ? MUXES.get(session.muxId) : null;
    const watched = session.watchers.size > 0 || (mux && mux.watchers.size > 0);
    if (session.lastActivity < cutoff && !watched) {
      destroySession(termId, 'idle_timeout');
    }
  }
}

function destroySession(termId, reason) {
  const session = SESSIONS.get(termId);
  if (!session) return;
  SESSIONS.delete(termId);
  for (const res of session.watchers) {
    try {
      writeSseJson(res, { type: 'exit', reason: reason || 'closed' });
    } catch (_error) {}
    try {
      res.end();
    } catch (_error) {}
  }
  session.watchers.clear();
  try {
    if (session.pty && typeof session.pty.kill === 'function') session.pty.kill();
  } catch (_error) {}
}

function appendBuffer(session, chunk) {
  session.buffer.push(chunk);
  session.bufferBytes += Buffer.byteLength(chunk, 'utf8');
  while (session.bufferBytes > MAX_BUFFER_BYTES && session.buffer.length > 1) {
    const dropped = session.buffer.shift();
    session.bufferBytes -= Buffer.byteLength(dropped, 'utf8');
  }
}

function broadcastOutput(session, base64) {
  for (const res of [...session.watchers]) {
    if (!writeSseJson(res, { type: 'output', data: base64 })) {
      session.watchers.delete(res);
    }
  }
}

// 把某个 session 的一帧输出（或 exit）广播到它所属 mux 的所有面板订阅者，携带 termId 以便前端分发。
function broadcastMux(session, frame) {
  if (!session.muxId) return;
  const mux = MUXES.get(session.muxId);
  if (!mux) return;
  mux.lastActivity = now();
  for (const res of [...mux.watchers]) {
    if (!writeSseJson(res, { ...frame, termId: session.termId })) {
      mux.watchers.delete(res);
    }
  }
}

async function readJsonBody(ctx) {
  const readRequestBody = ctx.readRequestBody;
  try {
    const buf = await readRequestBody(ctx.req, { maxBytes: 256 * 1024 });
    return buf ? JSON.parse(buf.toString('utf8')) : null;
  } catch (_error) {
    return null;
  }
}

// POST /v0/webui/terminal/open  { cols?, rows?, cwd? } -> { ok, termId }
async function handleTerminalOpen(ctx) {
  const { writeJson, res } = ctx;
  reapIdleSessions();

  if (SESSIONS.size >= MAX_SESSIONS) {
    writeJson(res, 429, { ok: false, error: 'too_many_terminals' });
    return true;
  }

  let nodePty;
  try {
    nodePty = loadNodePty();
  } catch (error) {
    writeJson(res, 500, {
      ok: false,
      error: 'node_pty_unavailable',
      message: String((error && error.message) || error)
    });
    return true;
  }

  const body = await readJsonBody(ctx);
  const cols = Math.max(2, Math.min(500, Number(body && body.cols) || 80));
  const rows = Math.max(1, Math.min(200, Number(body && body.rows) || 24));
  const cwd = resolveTerminalCwd(body && body.cwd);
  const muxId = (body && typeof body.muxId === 'string' && body.muxId) ? body.muxId : '';

  const { file, args } = pickShell();
  let pty;
  try {
    pty = nodePty.spawn(file, args, withPlatformPtyOptions({
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: buildTerminalEnv()
    }));
  } catch (error) {
    writeJson(res, 500, {
      ok: false,
      error: 'pty_spawn_failed',
      message: String((error && error.message) || error)
    });
    return true;
  }

  const termId = crypto.randomBytes(12).toString('hex');
  const session = {
    termId,
    muxId,
    pty,
    watchers: new Set(),
    buffer: [],
    bufferBytes: 0,
    lastActivity: now(),
    exited: false
  };
  SESSIONS.set(termId, session);

  pty.onData((data) => {
    session.lastActivity = now();
    const chunk = typeof data === 'string' ? data : String(data);
    appendBuffer(session, chunk);
    const base64 = Buffer.from(chunk, 'utf8').toString('base64');
    broadcastOutput(session, base64);
    broadcastMux(session, { type: 'output', data: base64 });
  });

  pty.onExit(({ exitCode, signal } = {}) => {
    session.exited = true;
    session.lastActivity = now();
    for (const w of [...session.watchers]) {
      writeSseJson(w, { type: 'exit', exitCode: exitCode ?? 0, signal: signal ?? null });
    }
    broadcastMux(session, { type: 'exit', exitCode: exitCode ?? 0, signal: signal ?? null });
    // 短暂延迟后回收，让 SSE 帧有机会写出。
    setTimeout(() => destroySession(termId, 'shell_exit'), 250);
  });

  writeJson(res, 200, { ok: true, termId, muxId, cols, rows, shell: file });
  return true;
}

// GET /v0/webui/terminal/stream?termId=... -> SSE
function handleTerminalStream(ctx) {
  const { writeJson, url, req, res } = ctx;
  const termId = url.searchParams ? String(url.searchParams.get('termId') || '') : '';
  const session = SESSIONS.get(termId);
  if (!session) {
    writeJson(res, 404, { ok: false, error: 'terminal_not_found' });
    return true;
  }

  openSseStream(res);
  writeSseJson(res, { type: 'connected', termId });

  // 回放挂载前缓冲的输出（例如 shell 首个 prompt）。
  if (session.buffer.length) {
    const joined = session.buffer.join('');
    const base64 = Buffer.from(joined, 'utf8').toString('base64');
    writeSseJson(res, { type: 'output', data: base64 });
  }
  if (session.exited) {
    writeSseJson(res, { type: 'exit', exitCode: 0 });
    return true;
  }

  session.watchers.add(res);
  session.lastActivity = now();

  const heartbeat = setInterval(() => {
    // 定时器回调里的异常不会被任何请求级 try/catch 兜住,会直接崩掉整个 server 进程
    // （曾因 writeSseComment 漏导出引发 33s 崩溃循环）——心跳必须自带防御。
    try {
      if (!writeSseComment(res, 'heartbeat')) {
        cleanup();
      }
    } catch (_error) {
      cleanup();
    }
  }, 30000);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  const cleanup = () => {
    clearInterval(heartbeat);
    session.watchers.delete(res);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
  return true;
}

// GET /v0/webui/terminal/mux?muxId=... -> SSE
// 一个面板一条流：承载该 mux 下所有 termId 的输出（帧带 termId），回放各 tab 的挂载前缓冲。
function handleTerminalMux(ctx) {
  const { writeJson, url, req, res } = ctx;
  const muxId = url.searchParams ? String(url.searchParams.get('muxId') || '') : '';
  if (!muxId) {
    writeJson(res, 400, { ok: false, error: 'mux_id_required' });
    return true;
  }
  reapIdleSessions();

  let mux = MUXES.get(muxId);
  if (!mux) {
    mux = { watchers: new Set(), lastActivity: now() };
    MUXES.set(muxId, mux);
  }

  openSseStream(res);
  writeSseJson(res, { type: 'connected', muxId });

  // 回放该 mux 下每个 session 的挂载前缓冲（例如各 tab 的首个 prompt），逐帧带 termId。
  for (const session of SESSIONS.values()) {
    if (session.muxId !== muxId) continue;
    if (session.buffer.length) {
      const joined = session.buffer.join('');
      const base64 = Buffer.from(joined, 'utf8').toString('base64');
      writeSseJson(res, { type: 'output', termId: session.termId, data: base64 });
    }
    if (session.exited) {
      writeSseJson(res, { type: 'exit', termId: session.termId, exitCode: 0 });
    }
  }

  mux.watchers.add(res);
  mux.lastActivity = now();

  const heartbeat = setInterval(() => {
    // 同上:定时器异常=全服崩溃,必须自带防御。
    try {
      if (!writeSseComment(res, 'heartbeat')) cleanup();
    } catch (_error) {
      cleanup();
    }
  }, 30000);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  const cleanup = () => {
    clearInterval(heartbeat);
    mux.watchers.delete(res);
    if (mux.watchers.size === 0) MUXES.delete(muxId);
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
  return true;
}

// POST /v0/webui/terminal/input  { termId, data }
async function handleTerminalInput(ctx) {
  const { writeJson, res } = ctx;
  const body = await readJsonBody(ctx);
  const termId = String(body && body.termId || '');
  const data = body && typeof body.data === 'string' ? body.data : '';
  const session = SESSIONS.get(termId);
  if (!session) {
    writeJson(res, 404, { ok: false, error: 'terminal_not_found' });
    return true;
  }
  try {
    session.pty.write(data);
    session.lastActivity = now();
    writeJson(res, 200, { ok: true });
  } catch (error) {
    writeJson(res, 400, { ok: false, error: 'terminal_write_failed', message: String((error && error.message) || error) });
  }
  return true;
}

// POST /v0/webui/terminal/resize  { termId, cols, rows }
async function handleTerminalResize(ctx) {
  const { writeJson, res } = ctx;
  const body = await readJsonBody(ctx);
  const termId = String(body && body.termId || '');
  const cols = Math.max(2, Math.min(500, Number(body && body.cols)));
  const rows = Math.max(1, Math.min(200, Number(body && body.rows)));
  const session = SESSIONS.get(termId);
  if (!session) {
    writeJson(res, 404, { ok: false, error: 'terminal_not_found' });
    return true;
  }
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
    writeJson(res, 400, { ok: false, error: 'terminal_resize_invalid' });
    return true;
  }
  try {
    session.pty.resize(cols, rows);
    session.lastActivity = now();
    writeJson(res, 200, { ok: true, cols, rows });
  } catch (error) {
    writeJson(res, 400, { ok: false, error: 'terminal_resize_failed', message: String((error && error.message) || error) });
  }
  return true;
}

// POST /v0/webui/terminal/close  { termId }
async function handleTerminalClose(ctx) {
  const { writeJson, res } = ctx;
  const body = await readJsonBody(ctx);
  const termId = String(body && body.termId || '');
  destroySession(termId, 'client_close');
  writeJson(res, 200, { ok: true });
  return true;
}

// 主分发：命中任意 /v0/webui/terminal/* 返回 true，否则 false（交回上层路由）。
async function handleWebUiTerminalRequest(ctx) {
  const { method, pathname } = ctx;
  if (!pathname || !pathname.startsWith('/v0/webui/terminal/')) return false;

  if (method === 'POST' && pathname === '/v0/webui/terminal/open') {
    return handleTerminalOpen(ctx);
  }
  if (method === 'GET' && pathname === '/v0/webui/terminal/stream') {
    return handleTerminalStream(ctx);
  }
  if (method === 'GET' && pathname === '/v0/webui/terminal/mux') {
    return handleTerminalMux(ctx);
  }
  if (method === 'POST' && pathname === '/v0/webui/terminal/input') {
    return handleTerminalInput(ctx);
  }
  if (method === 'POST' && pathname === '/v0/webui/terminal/resize') {
    return handleTerminalResize(ctx);
  }
  if (method === 'POST' && pathname === '/v0/webui/terminal/close') {
    return handleTerminalClose(ctx);
  }
  return false;
}

module.exports = {
  handleWebUiTerminalRequest
};
