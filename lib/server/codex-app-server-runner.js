'use strict';

// codex confirm 审批模式的执行层(P3b)：走 app-server JSON-RPC(ws),替代 exec spawn。
//
// 结构：
//   ensureCodexAppServerEndpoint  每账号一个 tmux 常驻 `codex app-server --listen ws://…`
//                                 (socket=aih-codexapp-<账号>,端口清单落盘,readyz 复用)
//   getAppServerClient            每账号一个 ws 客户端(断线重连+thread/resume+
//                                 pending 审批同 request id 原样重发的去重,S3 实证)
//   startCodexAppServerTurn       与 spawnNativeSessionStream 返回同构 handle：
//                                 {runId,done,getActivePrompt,writeInput,writeSteer,resize,abort}
//
// 审批往返：server→client JSON-RPC request(item/*/requestApproval)
//   → registerApprovalRequest(审批桥) + publish session:approval-request(会话事件通道)
//   → 用户在 webUI 决策 → POST /runs/:id/approvals/:approvalId → decideApproval
//   → 本模块的 respond 回调 → JSON-RPC response {"decision":"accept"|"decline"} 写回 ws。
// 协议编解码是纯函数,在 codex-app-server-protocol.js(单测友好)。

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const {
  registerApprovalRequest,
  decideApproval,
  toApprovalPrompt
} = require('./native-approval-bridge');
const { defaultSessionEventBus } = require('./session-event-bus');
const {
  isTmuxRunSupported,
  spawnDetachedTmuxRun,
  cleanupRunSocket
} = require('./native-run-tmux');
const protocol = require('./codex-app-server-protocol');
const { resolveAihLogPath, resolveAihRunPath } = require('../runtime/aih-storage-layout');
const { resolveRuntimeTarget } = require('../account/runtime-target');
const { buildCodexProviderArgs } = require('../cli/services/ai-cli/codex-provider-args');

const READY_TIMEOUT_MS = 20000;
const READY_POLL_INTERVAL_MS = 250;
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_ATTEMPTS = 8;
const ABORT_SETTLE_TIMEOUT_MS = 8000;

// runtimeScope -> Promise<client>：账号按 accountRef 隔离，gateway 使用独立显式 scope。
const CLIENTS = new Map();

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function codedError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function appServerSocketName(accountRef) {
  const compact = String(accountRef || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 24) || 'unknown';
  return `aih-codexapp-${compact}`;
}

function appServerStateDir(aiHomeDir) {
  const base = normalizeString(aiHomeDir)
    || path.join(normalizeString(process.env.AIH_HOST_HOME) || os.homedir(), '.ai_home');
  return resolveAihRunPath(base, 'codex-app-server');
}

function appServerStatePath(aiHomeDir, accountRef) {
  return path.join(appServerStateDir(aiHomeDir), `${String(accountRef || 'unknown')}.json`);
}

function readAppServerState(aiHomeDir, accountRef) {
  try {
    const parsed = JSON.parse(fs.readFileSync(appServerStatePath(aiHomeDir, accountRef), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function writeAppServerState(aiHomeDir, accountRef, state) {
  try {
    fs.mkdirSync(appServerStateDir(aiHomeDir), { recursive: true });
    fs.writeFileSync(appServerStatePath(aiHomeDir, accountRef), JSON.stringify(state, null, 2), 'utf8');
  } catch (_error) { /* best-effort：状态文件仅用于重启后复用端口 */ }
}

function checkReadyz(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const request = http.get({
      host: '127.0.0.1',
      port,
      path: '/readyz',
      timeout: timeoutMs
    }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    request.on('error', () => resolve(false));
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
  });
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function shellQuote(value) {
  return `'${String(value == null ? '' : value).replace(/'/g, "'\\''")}'`;
}

async function waitForReadyz(port, timeoutMs = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkReadyz(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_INTERVAL_MS));
  }
  return false;
}

// 每账号 tmux 常驻 app-server：已就绪则复用,否则分配端口、注入账号 env(HOME/CODEX_HOME)
// 后台拉起,等 /readyz。进程生命周期与 aih-server 脱钩(重启不腰斩,pending 审批可续)。
async function ensureCodexAppServerEndpoint(options = {}) {
  const target = resolveRuntimeTarget(options);
  const getProfileDir = options.getProfileDir;
  if (!target || typeof getProfileDir !== 'function') {
    throw codedError('native_session_invalid_context', 'codex app-server 需要账号或 gateway runtime target 与 getProfileDir');
  }
  const { accountRef, gateway, runtimeScope } = target;
  const aiHomeDir = options.aiHomeDir;
  const existing = readAppServerState(aiHomeDir, runtimeScope);
  if (existing && Number(existing.port) > 0 && await checkReadyz(Number(existing.port))) {
    return { port: Number(existing.port), reused: true };
  }

  if (!isTmuxRunSupported({ spawnSyncImpl: options.spawnSyncImpl })) {
    throw codedError('codex_app_server_tmux_unavailable', 'tmux 不可用,无法常驻 codex app-server');
  }

  // buildProviderEnv/resolveNativeCliLaunch 与 native spawn 同源：env-auth 使用
  // 宿主 CODEX_HOME，OAuth 才使用账号认证投影。延迟 require 避免模块环。
  const {
    buildProviderEnv,
    resolveNativeCliLaunch
  } = require('./native-session-chat');
  const runtimeDir = getProfileDir('codex', accountRef, { gateway });
  const env = buildProviderEnv('codex', runtimeDir, options.env || process.env, {
    accountRef,
    aiHomeDir,
    gateway
  });
  const launch = resolveNativeCliLaunch('codex', { env });

  const socket = appServerSocketName(runtimeScope);
  // 老 socket 可能残留(app-server 已死但 tmux /tmp socket 还在)：先清一次再拉。
  cleanupRunSocket(socket, { spawnSyncImpl: options.spawnSyncImpl });

  const port = await pickFreePort();
  const logPath = resolveAihLogPath(aiHomeDir, 'codex', 'app-server', `${runtimeScope}.log`);
  try {
    fs.mkdirSync(appServerStateDir(aiHomeDir), { recursive: true });
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
  } catch (_error) { /* 下方写日志时自然报错 */ }
  const providerArgs = buildCodexProviderArgs(env, { force: gateway });
  const commandLine = [
    launch.command,
    ...launch.prefixArgs,
    ...providerArgs,
    'app-server',
    '--listen',
    `ws://127.0.0.1:${port}`
  ]
    .map(shellQuote)
    .join(' ');
  const spawned = spawnDetachedTmuxRun({
    socket,
    shellCommand: `exec ${commandLine} >> ${shellQuote(logPath)} 2>&1`,
    cwd: os.homedir(),
    env,
    spawnSyncImpl: options.spawnSyncImpl
  });
  if (!spawned.ok) {
    throw codedError('codex_app_server_spawn_failed', `codex app-server 启动失败(${spawned.error})`);
  }
  if (!await waitForReadyz(port)) {
    cleanupRunSocket(socket, { spawnSyncImpl: options.spawnSyncImpl });
    throw codedError('codex_app_server_not_ready', `codex app-server ${READY_TIMEOUT_MS}ms 内未就绪(port ${port})`);
  }
  writeAppServerState(aiHomeDir, runtimeScope, {
    ...(gateway ? { gateway: true } : { accountRef }),
    runtimeScope,
    port,
    socket,
    startedAt: Date.now()
  });
  return { port, reused: false };
}

// ── ws 客户端(每账号一条,多 turn 复用,按 threadId 路由) ────────────────────────────

function createAppServerClient(options = {}) {
  const WebSocketImpl = options.wsImpl || require('ws');
  const resolveEndpoint = options.resolveEndpoint; // async () => 'ws://…'
  const client = {
    ws: null,
    nextId: 1,
    pending: new Map(), // requestId -> {resolve,reject}
    turns: new Map(), // threadId -> turnBinding {onNotification,onServerRequest,resumeParams}
    connecting: null,
    closedForever: false
  };

  async function dial() {
    const endpoint = await resolveEndpoint();
    const ws = new WebSocketImpl(endpoint);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    ws.on('message', (data) => handleMessage(ws, data));
    ws.on('close', () => handleClose(ws));
    ws.on('error', () => { /* close 事件统一处理 */ });
    client.ws = ws;
    await requestOn(ws, 'initialize', {
      clientInfo: { name: 'aih-webui', title: 'AI Home WebUI', version: '1.0.0' }
    });
    notifyOn(ws, 'initialized', {});
    return ws;
  }

  function requestOn(ws, method, params) {
    const id = client.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      client.pending.set(id, { resolve, reject });
      try {
        ws.send(payload);
      } catch (error) {
        client.pending.delete(id);
        reject(error);
      }
    });
  }

  function notifyOn(ws, method, params) {
    try {
      ws.send(JSON.stringify({ jsonrpc: '2.0', method, params }));
    } catch (_error) { /* 断线由 close 流程处理 */ }
  }

  function handleMessage(ws, data) {
    let message = null;
    try {
      message = JSON.parse(String(data));
    } catch (_error) {
      return;
    }
    if (!message || typeof message !== 'object') return;
    // 对我们请求的响应。
    if (message.id !== undefined && !message.method) {
      const waiter = client.pending.get(message.id);
      if (!waiter) return;
      client.pending.delete(message.id);
      if (message.error) {
        waiter.reject(codedError(
          'codex_app_server_rpc_error',
          normalizeString(message.error.message) || JSON.stringify(message.error)
        ));
      } else {
        waiter.resolve(message.result);
      }
      return;
    }
    const params = (message.params && typeof message.params === 'object') ? message.params : {};
    const binding = client.turns.get(normalizeString(params.threadId));
    // server→client request(审批等,带 id)。
    if (message.method && message.id !== undefined) {
      if (binding && typeof binding.onServerRequest === 'function') {
        binding.onServerRequest(message);
        return;
      }
      // 无归属的 server request：按协议回 method-not-found,避免 app-server 长等。
      try {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `unhandled server request: ${message.method}` }
        }));
      } catch (_error) { /* ignore */ }
      return;
    }
    // notification。
    if (binding && typeof binding.onNotification === 'function') {
      binding.onNotification(message);
    }
  }

  function handleClose(ws) {
    if (client.ws !== ws) return;
    client.ws = null;
    const disconnectError = codedError('codex_app_server_disconnected', 'codex app-server 连接断开');
    for (const [, waiter] of client.pending) waiter.reject(disconnectError);
    client.pending.clear();
    if (client.turns.size === 0 || client.closedForever) return;
    // 有活跃 turn:后台重连+thread/resume。app-server 会把 pending 审批同 request id 重发
    // (S3 实证),审批桥挂账不动、respond 走新 ws。
    reconnectLoop().catch((error) => {
      for (const [, binding] of client.turns) {
        if (typeof binding.onDisconnected === 'function') binding.onDisconnected(error);
      }
      client.turns.clear();
    });
  }

  async function reconnectLoop() {
    let lastError = null;
    for (let attempt = 1; attempt <= RECONNECT_MAX_ATTEMPTS; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, RECONNECT_BASE_DELAY_MS * attempt));
      if (client.turns.size === 0) return;
      try {
        const ws = await dial();
        for (const [threadId, binding] of client.turns) {
          await requestOn(ws, 'thread/resume', binding.resumeParams || protocol.buildThreadResumeParams({
            threadId,
            approvalMode: 'confirm'
          }));
        }
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || codedError('codex_app_server_reconnect_failed', 'codex app-server 重连失败');
  }

  async function ensureConnected() {
    if (client.ws) return client.ws;
    if (!client.connecting) {
      client.connecting = dial().finally(() => {
        client.connecting = null;
      });
    }
    return client.connecting;
  }

  return {
    async request(method, params) {
      const ws = await ensureConnected();
      return requestOn(ws, method, params);
    },
    respond(id, result) {
      if (!client.ws) return false;
      try {
        client.ws.send(JSON.stringify({ jsonrpc: '2.0', id, result }));
        return true;
      } catch (_error) {
        return false;
      }
    },
    respondError(id, code, message) {
      if (!client.ws) return false;
      try {
        client.ws.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
        return true;
      } catch (_error) {
        return false;
      }
    },
    bindTurn(threadId, binding) {
      client.turns.set(normalizeString(threadId), binding);
    },
    unbindTurn(threadId) {
      client.turns.delete(normalizeString(threadId));
    },
    ensureConnected,
    destroy() {
      client.closedForever = true;
      client.turns.clear();
      if (client.ws) {
        try { client.ws.terminate ? client.ws.terminate() : client.ws.close(); } catch (_error) { /* ignore */ }
        client.ws = null;
      }
    }
  };
}

function getAppServerClient(options = {}) {
  const runtimeScope = normalizeString(options.runtimeScope);
  let clientEntry = CLIENTS.get(runtimeScope);
  if (clientEntry) return clientEntry;
  clientEntry = createAppServerClient({
    wsImpl: options.wsImpl,
    resolveEndpoint: async () => {
      // 测试注入端点直连;生产每次拨号前确保 tmux app-server 存活(readyz 复用/自动拉起)。
      if (normalizeString(options.endpoint)) return normalizeString(options.endpoint);
      const { port } = await ensureCodexAppServerEndpoint(options);
      return `ws://127.0.0.1:${port}`;
    }
  });
  CLIENTS.set(runtimeScope, clientEntry);
  return clientEntry;
}

// ── turn 执行(handle 与 spawnNativeSessionStream 同构) ────────────────────────────

function publishApprovalEvent(bus, session, event) {
  try {
    if (bus && typeof bus.publish === 'function' && normalizeString(session.sessionId)) {
      bus.publish(session, { source: 'native-session-chat', ...event });
    }
  } catch (_error) { /* 事件发布失败不阻塞审批往返 */ }
}

function startCodexAppServerTurn(options = {}) {
  const target = resolveRuntimeTarget(options);
  const getProfileDir = options.getProfileDir;
  if (!target || typeof getProfileDir !== 'function') {
    throw codedError('native_session_invalid_context', 'codex app-server turn 需要账号或 gateway runtime target 与 getProfileDir');
  }
  const { accountRef, gateway, runtimeScope } = target;
  const prompt = String(options.prompt || '');
  if (!prompt.trim()) throw codedError('empty_prompt', 'empty_prompt');

  const runId = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `codexapp-run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const requestedSessionId = normalizeString(options.sessionId);
  const projectPath = normalizeString(options.projectPath) || process.cwd();
  const projectDirName = normalizeString(options.projectDirName);
  const approvalMode = normalizeString(options.approvalMode) || 'confirm';
  const sessionEventBus = options.sessionEventBus || defaultSessionEventBus;
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : () => {};

  const client = getAppServerClient({
    runtimeScope,
    accountRef,
    gateway,
    getProfileDir,
    env: options.env,
    aiHomeDir: options.aiHomeDir,
    spawnSyncImpl: options.spawnSyncImpl,
    endpoint: options.endpoint,
    wsImpl: options.wsImpl
  });

  const state = protocol.createTurnObserverState('');
  // requestKey(threadId:requestId) -> {approvalId,answered}：重连后 app-server 原样重发
  // pending 审批(同 request id)的去重依据;respond 恒走当前 ws。
  const approvalRecords = new Map();
  let settled = false;
  let aborted = false;
  let abortTimer = null;
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const emit = (event) => {
    if (!event) return;
    onEvent({ ...event, runId });
  };

  const cleanup = () => {
    if (abortTimer) clearTimeout(abortTimer);
    abortTimer = null;
    if (state.threadId) client.unbindTurn(state.threadId);
  };

  const settleResolve = (value) => {
    if (settled) return;
    settled = true;
    cleanup();
    resolveDone(value);
  };

  const settleReject = (error) => {
    if (settled) return;
    settled = true;
    cleanup();
    rejectDone(error);
  };

  const sessionForEvents = () => ({
    provider: 'codex',
    sessionId: state.threadId,
    projectDirName,
    projectPath
  });

  const handleServerRequest = (message) => {
    if (!protocol.isApprovalServerRequest(message)) {
      // 非审批类 server request：回 method-not-found,不让 app-server 干等。
      client.respondError(message.id, -32601, `unhandled server request: ${message.method}`);
      return;
    }
    const requestKey = `${state.threadId}:${message.id}`;
    if (approvalRecords.has(requestKey)) return; // 重连重发的同一请求:挂账已在,忽略
    const mapped = protocol.mapApprovalServerRequest(message, state);
    const record = { approvalId: '', answered: false, requestId: message.id };
    const entry = registerApprovalRequest({
      runId,
      toolName: mapped.toolName,
      input: mapped.input,
      toolUseId: mapped.toolUseId
    }, (decision) => {
      if (record.answered) return;
      record.answered = true;
      client.respond(record.requestId, protocol.approvalDecisionToResult(decision && decision.behavior));
    });
    record.approvalId = entry.approvalId;
    approvalRecords.set(requestKey, record);
    publishApprovalEvent(sessionEventBus, sessionForEvents(), {
      type: 'session:approval-request',
      phase: 'interactive-prompt',
      at: Date.now(),
      runId,
      promptId: entry.approvalId,
      prompt: toApprovalPrompt(entry)
    });
  };

  const handleNotification = (message) => {
    // 别的客户端/超时把审批解决掉了：收起本地审批卡,respond 已被 answered 守卫拦住。
    if (message.method === 'serverRequest/resolved') {
      const requestId = message.params && message.params.requestId;
      const requestKey = `${state.threadId}:${requestId}`;
      const record = approvalRecords.get(requestKey);
      if (record && !record.answered) {
        record.answered = true;
        decideApproval(record.approvalId, 'deny', 'approval_resolved_elsewhere');
        publishApprovalEvent(sessionEventBus, sessionForEvents(), {
          type: 'session:approval-resolved',
          phase: 'interactive-prompt',
          at: Date.now(),
          runId,
          promptId: record.approvalId,
          reason: 'resolved-elsewhere'
        });
      }
      return;
    }
    const events = protocol.mapServerNotification(message, state);
    for (const event of events) {
      if (event.type === 'result') {
        emit({ type: 'result', content: event.content });
        settleResolve({
          content: event.content,
          sessionId: state.threadId,
          afterMessages: []
        });
        continue;
      }
      if (event.type === 'error') {
        emit(event);
        settleReject(codedError('codex_app_server_turn_failed', event.message));
        continue;
      }
      emit(event);
    }
  };

  (async () => {
    let threadId = requestedSessionId;
    if (threadId) {
      // 先绑定再 resume：resume 响应前就可能开始下发通知/审批。
      state.threadId = threadId;
      bindTurn(threadId);
      await client.request('thread/resume', protocol.buildThreadResumeParams({ threadId, approvalMode }));
    } else {
      const started = await client.request('thread/start', protocol.buildThreadStartParams({
        cwd: projectPath,
        approvalMode
      }));
      threadId = normalizeString(started && started.thread && started.thread.id);
      if (!threadId) throw codedError('codex_app_server_thread_missing', 'thread/start 未返回 thread.id');
      state.threadId = threadId;
      bindTurn(threadId);
      emit({ type: 'session-created', sessionId: threadId });
    }
    if (aborted) {
      settleResolve({ content: state.content, sessionId: state.threadId, afterMessages: [] });
      return;
    }
    const turnResult = await client.request('turn/start', protocol.buildTurnStartParams({
      threadId,
      prompt,
      model: options.model,
      imagePaths: options.imagePaths
    }));
    const turnId = normalizeString(turnResult && turnResult.turn && turnResult.turn.id);
    if (turnId) state.turnId = turnId;
  })().catch((error) => {
    settleReject(error && error.code ? error : codedError('codex_app_server_turn_failed', String(error && error.message || error)));
  });

  function bindTurn(threadId) {
    client.bindTurn(threadId, {
      resumeParams: protocol.buildThreadResumeParams({ threadId, approvalMode }),
      onNotification: handleNotification,
      onServerRequest: handleServerRequest,
      onDisconnected: (error) => {
        settleReject(error && error.code ? error : codedError('codex_app_server_disconnected', 'codex app-server 连接断开'));
      }
    });
  }

  return {
    runId,
    done,
    // 审批卡的 detached 恢复走审批桥的 getPendingApprovalPromptForRun(/chat/runs 已合并),
    // 本 runner 无 PTY 交互 prompt。
    getActivePrompt() {
      return null;
    },
    writeInput() {
      throw codedError('native_interactive_prompt_not_active', 'codex app-server run 不接受交互输入,审批请走 approvals 通道');
    },
    // codex 真 steer(S3 实证):turn/steer 在当前 turn 内注入后续输入。
    writeSteer(text) {
      if (settled) throw codedError('native_session_run_not_active', 'native_session_run_not_active');
      const value = String(text || '').trim();
      if (!value) throw codedError('native_session_input_empty', 'native_session_input_empty');
      if (!state.threadId || !state.turnId) {
        throw codedError('native_session_run_not_active', '本轮尚未开始,无法 steer');
      }
      client.request('turn/steer', protocol.buildTurnSteerParams({
        threadId: state.threadId,
        turnId: state.turnId,
        text: value
      })).catch(() => { /* steer 失败不致命:turn 继续,前端可重试 */ });
    },
    resize() { /* 无 PTY,尺寸无意义 */ },
    abort() {
      aborted = true;
      if (settled) return;
      if (state.threadId && state.turnId) {
        client.request('turn/interrupt', protocol.buildTurnInterruptParams({
          threadId: state.threadId,
          turnId: state.turnId
        })).catch(() => { /* interrupt 失败走兜底定时器 */ });
      }
      // 兜底：interrupt 后 app-server 应发 turn/completed(interrupted);超时则本地收尾,
      // 防 done 悬挂(abort 语义必须终结本 run)。
      abortTimer = setTimeout(() => {
        settleResolve({ content: state.content, sessionId: state.threadId, afterMessages: [] });
      }, ABORT_SETTLE_TIMEOUT_MS);
      if (typeof abortTimer.unref === 'function') abortTimer.unref();
    }
  };
}

// 测试钩子：销毁并清空账号级 ws 客户端缓存(每个测试用独立 mock server;
// 不销毁的话残留 ws 连接会让 node --test 的 event loop 永不退出)。
function __resetClientsForTest() {
  for (const [, clientEntry] of CLIENTS) {
    try {
      if (typeof clientEntry.destroy === 'function') clientEntry.destroy();
    } catch (_error) { /* ignore */ }
  }
  CLIENTS.clear();
}

module.exports = {
  appServerSocketName,
  ensureCodexAppServerEndpoint,
  startCodexAppServerTurn,
  __resetClientsForTest
};
