'use strict';

// P3c:opencode 的 confirm 审批模式 runner。
//
// headless run 路径(`opencode run --dangerously-skip-permissions`)没有权限回路;confirm/plan
// 需要真实的权限挂起→webUI 审批→回填。1.4.7 唯一可用路线(S4 spike 实证)是常驻
// `opencode serve` HTTP API:
//   ensureOpenCodeServe(账号级 tmux 常驻,socket=aih-ocserve-<accountRef>,端口按账号确定性派生)
//   → startOpenCodeServeTurn:POST /session(?directory=projectPath) → PATCH 会话级 ask 权限规则
//   → SSE /event 订阅 → POST prompt_async → 事件映射为既有 native 流事件
//     (session-created/delta/assistant_tool_call/assistant_tool_result/result/error)
//   → permission.asked → 审批桥登记 + session:approval-request 事件 → 用户决策
//   → respond({behavior}) → POST /permission/:id/reply(allow→once,deny→reject) → 继续/拒绝。
//
// ⚠️ 死路(别回头踩):插件 permission.ask hook(1.4.7 不触发);run 模式 + ask 配置(2ms auto-reject)。
// sessionId 对齐:serve 的 session id 就是 ses_*,直接写共享 opencode.db(directory=projectPath),
// 会话列表/历史 reader 天然可见,resume 就是对同 id 再 prompt_async。
//
// handle 与 spawnNativeSessionStream 同构:{runId,done,getActivePrompt,writeInput,resize,abort}。

const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createOpenCodeServeClient,
  parseOpenCodeModelRef
} = require('./opencode-serve-client');
const {
  socketForRun,
  spawnDetachedTmuxRun,
  hasRunSession,
  cleanupRunSocket,
  buildInnerCommandFromArgv
} = require('./native-run-tmux');
const {
  registerApprovalRequest,
  decideApproval,
  cancelApprovalsForRun,
  getPendingApprovalPromptForRun,
  toApprovalPrompt
} = require('./native-approval-bridge');
const { defaultSessionEventBus } = require('./session-event-bus');
const { resolveRuntimeTarget } = require('../account/runtime-target');
const { resolveAihLogPath } = require('../runtime/aih-storage-layout');
const { mapOpenCodeSessionRetry } = require('./native-retry-status');

const DEFAULT_SERVE_READY_TIMEOUT_MS = 25000;
const DEFAULT_SERVE_POLL_INTERVAL_MS = 300;
const SSE_CONNECT_WAIT_MS = 5000;

// confirm 模式的会话级权限规则:一切需要权限的操作都 ask(实证:read/text 等非权限操作不受影响,
// bash/edit/webfetch/external_directory 等权限点会挂起)。只 PATCH 本会话,不碰全局配置。
const CONFIRM_PERMISSION_RULES = Object.freeze([
  Object.freeze({ permission: '*', pattern: '*', action: 'ask' })
]);

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function shellQuote(value) {
  return `'${String(value == null ? '' : value).replace(/'/g, "'\\''")}'`;
}

// 端口按账号确定性派生(46300-46999):同账号复用同实例;readiness 校验 /global/health
// 兜住「端口被别的进程占用」的误判(健康检查不过就当没起)。
function servePortForAccount(accountRef) {
  const digest = crypto.createHash('sha256').update(`aih-opencode-serve:${normalizeString(accountRef)}`).digest();
  return 46300 + (digest.readUInt16BE(0) % 700);
}

function serveSocketForAccount(accountRef) {
  return socketForRun(`ocserve-${normalizeString(accountRef) || 'default'}`);
}

function resolveServeAiHomeDir(options = {}) {
  const injected = normalizeString(options.aiHomeDir);
  if (injected) return injected;
  const hostHome = normalizeString(process.env.AIH_HOST_HOME) || os.homedir();
  return path.join(hostHome, '.ai_home');
}

function serveLogPath(aiHomeDir, accountRef, fsImpl = nodeFs) {
  const dir = resolveAihLogPath(aiHomeDir, 'opencode', 'serve');
  if (!dir) return '';
  try { fsImpl.mkdirSync(dir, { recursive: true }); } catch (_error) { /* best-effort */ }
  return path.join(dir, `serve-${normalizeString(accountRef) || 'default'}.log`);
}

// serve 用的 provider env:与 CLI 同源(buildProviderEnv → auth 桥接/共享 db/XDG 注入),
// 但剔除 proxy env——serve 只服务 localhost,而 bun 对 proxy env 敏感(spike:偶发启动挂死)。
function buildServeEnv(runtimeDir, baseEnv, options = {}) {
  const { buildProviderEnv } = require('./native-session-chat');
  const env = buildProviderEnv('opencode', runtimeDir, baseEnv || process.env, options);
  for (const key of ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY']) {
    delete env[key];
  }
  return env;
}

async function healthOk(client) {
  try {
    return Boolean(await client.health());
  } catch (_error) {
    return false;
  }
}

function readLogTail(logPath, fsImpl = nodeFs) {
  try {
    const text = fsImpl.readFileSync(logPath, 'utf8');
    return text.slice(-800).trim();
  } catch (_error) {
    return '';
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 同账号并发 ensure 串行化:两轮同时到达只拉一次 serve。
const ensureInFlight = new Map();

async function ensureOpenCodeServe(options = {}) {
  const target = resolveRuntimeTarget(options);
  if (!target || typeof options.getProfileDir !== 'function') {
    const error = new Error('opencode_serve_invalid_context');
    error.code = 'opencode_serve_invalid_context';
    throw error;
  }
  if (ensureInFlight.has(target.runtimeScope)) return ensureInFlight.get(target.runtimeScope);
  const pending = ensureServeNow(options, target)
    .finally(() => ensureInFlight.delete(target.runtimeScope));
  ensureInFlight.set(target.runtimeScope, pending);
  return pending;
}

async function ensureServeNow(options, target) {
  const clientFactory = options.clientFactory || createOpenCodeServeClient;
  const fsImpl = options.fs || nodeFs;
  const { accountRef, gateway, runtimeScope } = target;
  const port = servePortForAccount(runtimeScope);
  const socket = serveSocketForAccount(runtimeScope);
  const baseUrl = `http://127.0.0.1:${port}`;
  const probe = clientFactory({ baseUrl, timeoutMs: 3000 });

  if (await healthOk(probe)) {
    return { baseUrl, port, socket, reused: true };
  }

  // tmux 会话活着但 health 不通 → 挂死/僵尸实例,清掉重拉。
  if (hasRunSession(socket, options)) {
    cleanupRunSocket(socket, options);
  }

  const runtimeDir = options.getProfileDir('opencode', accountRef, { gateway });
  const env = buildServeEnv(runtimeDir, options.env, {
    accountRef,
    aiHomeDir: options.aiHomeDir,
    gateway
  });
  const { resolveNativeCliLaunch } = require('./native-session-chat');
  const launch = resolveNativeCliLaunch('opencode', { env });
  const logPath = serveLogPath(resolveServeAiHomeDir(options), runtimeScope, fsImpl);
  const inner = buildInnerCommandFromArgv(launch.command, [
    ...launch.prefixArgs, 'serve', '--port', String(port), '--hostname', '127.0.0.1'
  ]);
  const spawned = spawnDetachedTmuxRun({
    socket,
    shellCommand: `exec ${inner} >> ${shellQuote(logPath)} 2>&1`,
    cwd: normalizeString(env.HOME) || os.homedir(),
    env,
    spawnSyncImpl: options.spawnSyncImpl
  });
  if (!spawned.ok) {
    const error = new Error(`opencode serve 启动失败(${spawned.error})`);
    error.code = 'opencode_serve_start_failed';
    throw error;
  }

  const readyTimeoutMs = Number(options.readyTimeoutMs) > 0 ? Number(options.readyTimeoutMs) : DEFAULT_SERVE_READY_TIMEOUT_MS;
  const pollIntervalMs = Number(options.pollIntervalMs) > 0 ? Number(options.pollIntervalMs) : DEFAULT_SERVE_POLL_INTERVAL_MS;
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    if (await healthOk(probe)) {
      return { baseUrl, port, socket, reused: false };
    }
    await sleep(pollIntervalMs);
  }

  cleanupRunSocket(socket, options);
  const tail = readLogTail(logPath, fsImpl);
  const error = new Error(`opencode serve 就绪超时(${readyTimeoutMs}ms)${tail ? `:${tail}` : ''}`);
  error.code = 'opencode_serve_start_failed';
  throw error;
}

// 与 native-session-chat 的 renderNativeToolCallTag/renderNativeToolResultTag 同格式
// (:::tool 标签,前端 parseMessageBlocks 直接解析成工具卡片;那边未导出,这里等价实现)。
function renderToolCallTag(name, input) {
  const toolName = String(name || 'Tool').replace(/["\\\r\n]/g, '').trim() || 'Tool';
  let body = '';
  try {
    body = typeof input === 'string' ? input : JSON.stringify(input, null, 2);
  } catch (_error) {
    body = String(input == null ? '' : input);
  }
  return `:::tool{name="${toolName}"}\n${String(body || '').trim()}\n:::`;
}

function renderToolResultTag(output) {
  const text = String(output == null ? '' : output).trim();
  return text ? `:::tool-result\n${text}\n:::` : '';
}

function eventSessionId(event) {
  const props = event && event.properties && typeof event.properties === 'object' ? event.properties : {};
  return normalizeString(
    props.sessionID
    || (props.info && props.info.sessionID)
    || (props.part && props.part.sessionID)
  );
}

// serve SSE 事件 → 既有 native 流事件的映射器(纯状态机,单测友好)。
// emit 收 {type:'delta'|'assistant_tool_call'|'assistant_tool_result'} 事件;
// permission.asked / permission.replied / session.idle / session.error 经专用回调交给 runner。
function createServeEventMapper({ sessionId, emit, onPermissionAsked, onPermissionReplied, onIdle, onError }) {
  const messageRoles = new Map(); // messageID → role
  const partTypes = new Map(); // partID → part.type
  const textByPart = new Map(); // partID → 已见全文(去重/补尾)
  const toolParts = new Map(); // partID → {callEmitted, resultEmitted}
  const state = { content: '' };
  const mapper = { sessionId: normalizeString(sessionId), state };

  const appendAssistantText = (partId, nextText) => {
    const previous = textByPart.get(partId) || '';
    const full = String(nextText || '');
    if (!full || full.length <= previous.length || !full.startsWith(previous)) return;
    const delta = full.slice(previous.length);
    textByPart.set(partId, full);
    state.content += delta;
    emit({ type: 'delta', delta });
  };

  const handleToolPart = (part) => {
    const partId = normalizeString(part.id) || `tool:${normalizeString(part.callID)}`;
    const st = part.state && typeof part.state === 'object' ? part.state : {};
    const status = normalizeString(st.status);
    if (status === 'pending') return; // input 未就绪
    let entry = toolParts.get(partId);
    if (!entry) {
      entry = { callEmitted: false, resultEmitted: false };
      toolParts.set(partId, entry);
    }
    if (!entry.callEmitted) {
      entry.callEmitted = true;
      emit({ type: 'assistant_tool_call', content: renderToolCallTag(part.tool || part.name || 'Tool', st.input || {}) });
    }
    if (entry.resultEmitted) return;
    if (status === 'completed') {
      entry.resultEmitted = true;
      const tag = renderToolResultTag(st.output || (st.metadata && st.metadata.output) || '');
      if (tag) emit({ type: 'assistant_tool_result', content: tag });
    } else if (status === 'error') {
      entry.resultEmitted = true;
      const tag = renderToolResultTag(st.error || 'tool error');
      if (tag) emit({ type: 'assistant_tool_result', content: tag });
    }
  };

  mapper.handle = (event) => {
    const type = normalizeString(event && event.type);
    if (!type) return;
    const props = event.properties && typeof event.properties === 'object' ? event.properties : {};
    // 全事件流严格按会话过滤:同一 serve 实例可能并发多个会话(甚至 TUI),
    // 无 sessionID 或不匹配的事件一律不进本 run。
    const sid = eventSessionId(event);
    if (!mapper.sessionId || !sid || sid !== mapper.sessionId) return;

    const retryStatus = mapOpenCodeSessionRetry(event);
    if (retryStatus) {
      emit(retryStatus);
      return;
    }

      if (type === 'message.updated' && props.info && props.info.id) {
        messageRoles.set(String(props.info.id), normalizeString(props.info.role));
        return;
      }
      if (type === 'message.part.updated' && props.part && typeof props.part === 'object') {
        const part = props.part;
        const partId = normalizeString(part.id);
        if (partId) partTypes.set(partId, normalizeString(part.type));
        const role = messageRoles.get(normalizeString(part.messageID)) || '';
        if (role !== 'assistant') return; // 用户自己的 prompt 回显不算回复
        if (part.type === 'text') {
          appendAssistantText(partId, part.text);
        } else if (part.type === 'tool') {
          handleToolPart(part);
        }
        return;
      }
      if (type === 'message.part.delta') {
        // {messageID,partID,field:'text',delta}:reasoning part 的思考流不进正文,text part 才是回复。
        if (normalizeString(props.field) !== 'text') return;
        const partId = normalizeString(props.partID);
        if (partTypes.get(partId) !== 'text') return;
        if (messageRoles.get(normalizeString(props.messageID)) !== 'assistant') return;
        const previous = textByPart.get(partId) || '';
        appendAssistantText(partId, previous + String(props.delta || ''));
        return;
      }
      if (type === 'permission.asked') {
        if (typeof onPermissionAsked === 'function') onPermissionAsked(props);
        return;
      }
      if (type === 'permission.replied') {
        if (typeof onPermissionReplied === 'function') onPermissionReplied(props);
        return;
      }
      if (type === 'session.idle') {
        if (typeof onIdle === 'function') onIdle();
        return;
      }
      if (type === 'session.error') {
        const message = normalizeString(
          (props.error && (props.error.message || props.error.data && props.error.data.message))
          || props.message
        ) || 'opencode_serve_session_error';
        if (typeof onError === 'function') onError(message);
      }
  };
  return mapper;
}

function startOpenCodeServeTurn(options = {}) {
  const runId = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `ocserve-run-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const bus = options.sessionEventBus || defaultSessionEventBus;
  const ensureServe = options.ensureServeImpl || ensureOpenCodeServe;
  const clientFactory = options.clientFactory || createOpenCodeServeClient;
  const prompt = String(options.prompt || '');
  const requestedSessionId = normalizeString(options.sessionId);
  const projectPath = normalizeString(options.projectPath);
  const projectDirName = normalizeString(options.projectDirName);

  let settled = false;
  let aborted = false;
  let client = null;
  let eventStream = null;
  let sessionId = requestedSessionId;
  // directory 作用域(1.17.13):/event、permission reply 等都只作用于该 directory 的 app 实例,
  // 必须与会话的 directory 一致,否则事件流空转、reply 找不到挂起项。
  let scopeDirectory = projectPath;
  // permissionId → {approvalId, settled}:webUI 决策(bridge respond)与外部决议(TUI 等)双向去重。
  const pendingPermissions = new Map();

  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const emitEvent = (event) => {
    if (!event || typeof options.onEvent !== 'function') return;
    try {
      options.onEvent({ ...event, runId });
    } catch (_error) { /* 订阅方异常不拖垮 run */ }
  };

  const publishSessionEvent = (event) => {
    if (!sessionId || !bus || typeof bus.publish !== 'function') return;
    try {
      bus.publish({
        provider: 'opencode',
        sessionId,
        projectDirName,
        projectPath
      }, { source: 'opencode-serve-runner', ...event });
    } catch (_error) { /* best-effort */ }
  };

  const closeStream = () => {
    if (eventStream) {
      try { eventStream.close(); } catch (_error) { /* 已关 */ }
      eventStream = null;
    }
  };

  const finalizePermission = (permissionId, behavior, { reply = true, message } = {}) => {
    const entry = pendingPermissions.get(permissionId);
    if (!entry || entry.settled) return;
    entry.settled = true;
    pendingPermissions.delete(permissionId);
    if (reply && client) {
      client.replyPermission(
        permissionId,
        behavior === 'allow' ? 'once' : 'reject',
        behavior === 'allow' ? '' : (message || '用户在 webUI 拒绝了此操作'),
        { directory: scopeDirectory }
      ).catch(() => { /* 会话可能已结束:回填失败不阻塞 */ });
    }
    publishSessionEvent({
      type: 'session:approval-resolved',
      phase: 'interactive-prompt',
      at: Date.now(),
      runId,
      promptId: entry.approvalId,
      reason: behavior === 'allow' ? 'allow' : 'deny'
    });
  };

  const fail = (error) => {
    if (settled) return;
    settled = true;
    closeStream();
    cancelApprovalsForRun(runId, 'run_finished');
    rejectDone(error);
  };

  const finish = (content) => {
    if (settled) return;
    settled = true;
    closeStream();
    cancelApprovalsForRun(runId, 'run_finished');
    resolveDone({ content, sessionId, afterMessages: [] });
  };

  const mapper = createServeEventMapper({
    // 新建会话时 sessionId 在 createSession 后回填(mapper.sessionId 可变);之前严格过滤一切事件。
    sessionId: requestedSessionId,
    emit: emitEvent,
    onPermissionAsked(props) {
      const permissionId = normalizeString(props.id);
      if (!permissionId || pendingPermissions.has(permissionId)) return;
      const entry = registerApprovalRequest({
        runId,
        toolName: normalizeString(props.permission) || 'tool',
        input: {
          patterns: Array.isArray(props.patterns) ? props.patterns : [],
          ...(props.metadata && typeof props.metadata === 'object' ? props.metadata : {})
        },
        toolUseId: normalizeString(props.tool && props.tool.callID)
      }, (decision) => {
        finalizePermission(permissionId, decision && decision.behavior === 'allow' ? 'allow' : 'deny', {
          reply: true,
          message: decision && decision.message
        });
      });
      pendingPermissions.set(permissionId, { approvalId: entry.approvalId, settled: false });
      publishSessionEvent({
        type: 'session:approval-request',
        phase: 'interactive-prompt',
        at: Date.now(),
        runId,
        promptId: entry.approvalId,
        prompt: toApprovalPrompt(entry)
      });
    },
    onPermissionReplied(props) {
      // 外部决议(TUI/别的客户端已回复):收起审批卡,不再重复 reply。
      const permissionId = normalizeString(props.requestID || props.id);
      const entry = pendingPermissions.get(permissionId);
      if (!entry || entry.settled) return;
      const behavior = normalizeString(props.reply) === 'reject' ? 'deny' : 'allow';
      finalizePermission(permissionId, behavior, { reply: false });
      decideApproval(entry.approvalId, behavior, '已在其他客户端决议');
    },
    onIdle() {
      emitEvent({ type: 'result', content: mapper.state.content });
      finish(mapper.state.content);
    },
    onError(message) {
      emitEvent({ type: 'error', message });
      const error = new Error(message);
      error.code = 'opencode_serve_session_error';
      fail(error);
    }
  });

  (async () => {
    const { baseUrl } = await ensureServe({
      accountRef: options.accountRef,
      gateway: Boolean(options.gateway),
      getProfileDir: options.getProfileDir,
      env: options.env,
      aiHomeDir: options.aiHomeDir,
      spawnSyncImpl: options.spawnSyncImpl,
      clientFactory: options.clientFactory,
      readyTimeoutMs: options.readyTimeoutMs,
      pollIntervalMs: options.pollIntervalMs,
      fs: options.fs
    });
    client = clientFactory({ baseUrl });

    // resume 且缺 projectPath:反查会话 directory,事件流/权限回填必须落在同一作用域。
    if (sessionId && !scopeDirectory) {
      try {
        const info = await client.getSession(sessionId);
        scopeDirectory = normalizeString(info && info.directory);
      } catch (_error) { /* 反查失败按无作用域(serve cwd 实例)走 */ }
    }

    // 先订阅事件流(等 server.connected),再建会话/发 prompt,避免早期事件漏读。
    let markConnected = null;
    const connected = new Promise((resolve) => { markConnected = resolve; });
    eventStream = client.openEventStream({
      directory: scopeDirectory,
      onEvent(event) {
        if (event && event.type === 'server.connected' && markConnected) {
          const mark = markConnected;
          markConnected = null;
          mark();
          return;
        }
        mapper.handle(event);
      },
      onClose(error) {
        if (settled) return;
        const failure = error || new Error('opencode serve 事件流意外断开');
        if (!failure.code) failure.code = 'opencode_serve_stream_closed';
        fail(failure);
      }
    });
    await Promise.race([connected, sleep(SSE_CONNECT_WAIT_MS)]);
    if (settled) return;

    if (!sessionId) {
      const created = await client.createSession({ directory: scopeDirectory });
      sessionId = normalizeString(created && created.id);
      if (!sessionId) {
        const error = new Error('opencode serve 建会话失败(无 id)');
        error.code = 'opencode_serve_session_create_failed';
        throw error;
      }
      emitEvent({ type: 'session-created', sessionId });
    }
    mapper.sessionId = sessionId;
    if (aborted || settled) return;

    // 会话级注入 ask 规则(幂等,resume 轮同样注入,保证 confirm 语义不随会话历史漂移)。
    await client.updateSessionPermissions(
      sessionId,
      options.permissionRules || CONFIRM_PERMISSION_RULES,
      { directory: scopeDirectory }
    );
    await client.promptAsync(sessionId, {
      model: parseOpenCodeModelRef(options.model),
      text: prompt,
      directory: scopeDirectory
    });
  })().catch((error) => {
    const failure = error instanceof Error ? error : new Error(String(error || 'opencode_serve_turn_failed'));
    if (!failure.code) failure.code = 'opencode_serve_turn_failed';
    fail(failure);
  });

  return {
    runId,
    done,
    getActivePrompt() {
      return getPendingApprovalPromptForRun(runId);
    },
    writeInput() {
      const error = new Error('opencode serve 会话不支持终端输入(审批走 approvals 通道)');
      error.code = 'native_input_unsupported';
      throw error;
    },
    resize() {
      return false;
    },
    abort() {
      if (settled) return;
      aborted = true;
      if (client && sessionId) {
        client.abortSession(sessionId).catch(() => { /* best-effort */ });
      }
      const error = new Error('native_session_aborted');
      error.code = 'native_session_aborted';
      fail(error);
    }
  };
}

module.exports = {
  CONFIRM_PERMISSION_RULES,
  createServeEventMapper,
  ensureOpenCodeServe,
  servePortForAccount,
  serveSocketForAccount,
  startOpenCodeServeTurn
};
