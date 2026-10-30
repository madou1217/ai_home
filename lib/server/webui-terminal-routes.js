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
const { createTerminalOutputBatcher } = require('./terminal-output-batcher');
const persistentTerminal = require('./webui-terminal-persistence');
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
const MAX_SESSIONS = 24;
const SESSION_KEY_MAX_LENGTH = 192;

function now() {
  return Date.now();
}

function normalizeSessionKey(value) {
  const text = String(value || '').trim();
  if (!text || text.length > SESSION_KEY_MAX_LENGTH || /[\0\r\n]/.test(text)) return '';
  return text;
}

function findSessionByKey(sessionKey) {
  const key = normalizeSessionKey(sessionKey);
  if (!key) return null;
  for (const session of SESSIONS.values()) {
    if (session.sessionKey === key) return session;
  }
  return null;
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
  const env = { ...process.env, TERM: 'xterm-256color' };
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
    // 持久 WebUI 终端的生命周期由用户显式关闭；浏览器刷新只会断开观察者，
    // 不能因为没有 SSE 观察者而误杀正在 prompt 等待的 Server CLI。
    if (!session.persistent && session.lastActivity < cutoff && !watched) {
      destroySession(termId, 'idle_timeout');
    }
  }
}

function destroySession(termId, reason) {
  const session = SESSIONS.get(termId);
  if (!session) return;
  session.outputBatcher.flush();
  SESSIONS.delete(termId);
  if (reason === 'client_close' && session.sessionKey) persistentTerminal.close(session.sessionKey);
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

function replaySessionToMux(session, muxId) {
  const mux = MUXES.get(String(muxId || ''));
  if (!mux) return;
  if (!mux.replayedTermIds) mux.replayedTermIds = new Set();
  if (mux.replayedTermIds.has(session.termId)) return;
  mux.replayedTermIds.add(session.termId);
  if (session.buffer.length) {
    const joined = session.buffer.join('');
    const base64 = Buffer.from(joined, 'utf8').toString('base64');
    for (const res of [...mux.watchers]) {
      if (!writeSseJson(res, { type: 'output', termId: session.termId, data: base64 })) mux.watchers.delete(res);
    }
  }
  if (session.exited) {
    for (const res of [...mux.watchers]) {
      if (!writeSseJson(res, { type: 'exit', termId: session.termId, exitCode: 0 })) mux.watchers.delete(res);
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

function openTerminalSession(input = {}) {
  reapIdleSessions();
  const sessionKey = normalizeSessionKey(input.sessionKey);
  const existing = findSessionByKey(sessionKey);
  if (existing && !existing.exited) {
    existing.outputBatcher.flush();
    if (input.muxId) {
      existing.muxId = String(input.muxId);
      replaySessionToMux(existing, existing.muxId);
    }
    existing.lastActivity = now();
    return { ok: true, termId: existing.termId, sessionKey: existing.sessionKey, muxId: existing.muxId, cols: existing.cols, rows: existing.rows, shell: existing.file, durable: existing.durable, reused: true };
  }
  if (SESSIONS.size >= MAX_SESSIONS) return { ok: false, error: 'too_many_terminals' };
  let nodePty;
  try { nodePty = loadNodePty(); } catch (error) {
    return { ok: false, error: 'node_pty_unavailable', message: String((error && error.message) || error) };
  }
  const cols = Math.max(2, Math.min(500, Number(input.cols) || 80));
  const rows = Math.max(1, Math.min(200, Number(input.rows) || 24));
  const cwd = resolveTerminalCwd(input.cwd);
  const file = String(input.file || '').trim() || pickShell().file;
  const args = Array.isArray(input.args) ? input.args.map((arg) => String(arg)) : pickShell().args;
  const env = { ...buildTerminalEnv(), ...(input.env && typeof input.env === 'object' ? input.env : {}) };
  let command = { file, args };
  let createdPersistent = false;
  let adoptedPersistent = false;
  let durable = false;
  if (sessionKey) {
    const probe = persistentTerminal.probe(sessionKey);
    if (probe.state === 'unavailable' && (input.attachOnly || !probe.missingBinary)) {
      return { ok: false, error: 'persistent_terminal_unavailable', message: probe.message };
    }
    adoptedPersistent = probe.state === 'alive';
    if (!adoptedPersistent) {
      if (input.attachOnly) return { ok: false, error: 'terminal_not_found' };
      const created = persistentTerminal.create(sessionKey, { file, args, cwd, env, cols, rows });
      if (!created.ok) return created;
      createdPersistent = created.durable;
      durable = created.durable;
    } else {
      durable = true;
    }
    if (durable) command = persistentTerminal.attachCommand(sessionKey);
  }
  let pty;
  try {
    // The server itself may run inside tmux. Its TMUX marker must not make
    // this independent client refuse to attach as a nested session.
    const clientEnv = { ...env };
    if (durable) delete clientEnv.TMUX;
    pty = nodePty.spawn(command.file, command.args, withPlatformPtyOptions({ name: 'xterm-256color', cols, rows, cwd, env: clientEnv }));
  } catch (error) {
    if (createdPersistent) persistentTerminal.close(sessionKey);
    return { ok: false, error: 'pty_spawn_failed', message: String((error && error.message) || error) };
  }
  const termId = crypto.randomBytes(12).toString('hex');
  const session = {
    termId,
    sessionKey,
    muxId: String(input.muxId || ''),
    pty,
    file,
    args,
    cwd,
    cols,
    rows,
    persistent: input.persistent === true || Boolean(sessionKey),
    durable,
    watchers: new Set(),
    buffer: [],
    bufferBytes: 0,
    lastActivity: now(),
    exited: false
  };
  session.outputBatcher = createTerminalOutputBatcher((chunk) => {
    const base64 = Buffer.from(chunk, 'utf8').toString('base64');
    broadcastOutput(session, base64);
    broadcastMux(session, { type: 'output', data: base64 });
  });
  SESSIONS.set(termId, session);
  pty.onData((data) => {
    session.lastActivity = now();
    const chunk = typeof data === 'string' ? data : String(data);
    appendBuffer(session, chunk);
    session.outputBatcher.push(chunk);
  });
  pty.onExit(({ exitCode, signal } = {}) => {
    session.outputBatcher.flush();
    session.exited = true;
    session.lastActivity = now();
    for (const w of [...session.watchers]) writeSseJson(w, { type: 'exit', exitCode: exitCode ?? 0, signal: signal ?? null });
    broadcastMux(session, { type: 'exit', exitCode: exitCode ?? 0, signal: signal ?? null });
    setTimeout(() => destroySession(termId, 'shell_exit'), 250);
  });
  return { ok: true, termId, sessionKey, muxId: session.muxId, cols, rows, shell: file, cwd, durable, reused: adoptedPersistent };
}

// 内部启动器使用：账号 CLI 在 Server 侧直接进入同一 PTY 生命周期，凭据只存在 Server 进程 env。
function openWebUiTerminalSession(input = {}) {
  return openTerminalSession({ ...input, persistent: true });
}

// POST /v0/webui/terminal/open  { cols?, rows?, cwd?, sessionKey? } -> { ok, termId }
async function handleTerminalOpen(ctx) {
  const { writeJson, res } = ctx;
  const body = await readJsonBody(ctx);
  // Browser callers may request a shell/cwd only. Arbitrary executable, argv,
  // and environment injection is reserved for the in-process account launcher.
  const input = body && typeof body === 'object' ? {
    cols: body.cols,
    rows: body.rows,
    muxId: body.muxId,
    cwd: body.cwd,
    sessionKey: body.sessionKey
  } : {};
  const result = openTerminalSession(input);
  writeJson(res, result.ok ? 200 : (result.error === 'too_many_terminals' ? 429 : 500), result);
  return true;
}

// POST /v0/webui/terminal/attach { sessionKey, muxId? } -> existing persistent terminal.
async function handleTerminalAttach(ctx) {
  const { writeJson, res } = ctx;
  const body = await readJsonBody(ctx);
  let session = findSessionByKey(body && body.sessionKey);
  if (!session && normalizeSessionKey(body && body.sessionKey)) {
    const restored = openTerminalSession({ sessionKey: body.sessionKey, muxId: body.muxId, attachOnly: true });
    if (restored.ok) session = SESSIONS.get(restored.termId);
    else if (restored.error !== 'terminal_not_found') {
      writeJson(res, restored.error === 'too_many_terminals' ? 429 : 503, restored);
      return true;
    }
  }
  if (!session || session.exited) {
    writeJson(res, 404, { ok: false, error: 'terminal_not_found' });
    return true;
  }
  session.outputBatcher.flush();
  if (body && body.muxId) {
    session.muxId = String(body.muxId);
    replaySessionToMux(session, session.muxId);
  }
  session.lastActivity = now();
  writeJson(res, 200, { ok: true, termId: session.termId, sessionKey: session.sessionKey, muxId: session.muxId, cols: session.cols, rows: session.rows, shell: session.file, cwd: session.cwd, durable: session.durable });
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

  session.outputBatcher.flush();

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
    mux = { watchers: new Set(), lastActivity: now(), replayedTermIds: new Set() };
    MUXES.set(muxId, mux);
  }

  openSseStream(res);
  writeSseJson(res, { type: 'connected', muxId });

  // 回放该 mux 下每个 session 的挂载前缓冲（例如各 tab 的首个 prompt），逐帧带 termId。
  for (const session of SESSIONS.values()) {
    if (session.muxId !== muxId) continue;
    session.outputBatcher.flush();
    if (session.buffer.length) {
      const joined = session.buffer.join('');
      const base64 = Buffer.from(joined, 'utf8').toString('base64');
      writeSseJson(res, { type: 'output', termId: session.termId, data: base64 });
    }
    if (!mux.replayedTermIds) mux.replayedTermIds = new Set();
    mux.replayedTermIds.add(session.termId);
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
  if (method === 'POST' && pathname === '/v0/webui/terminal/attach') {
    return handleTerminalAttach(ctx);
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
  handleWebUiTerminalRequest,
  openWebUiTerminalSession,
  findSessionByKey
};
