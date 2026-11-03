'use strict';

// ACP（Agent Client Protocol）会话 runner：stdio 上的 JSON-RPC/NDJSON，无 TTY。
//
// 为什么存在（2026-10-16 真机取证，cline 3.0.71）：
//   cline 的续聊（`cline --id <id>`）只能进 TUI，而 TUI **在进程启动期会吞掉敲入的输入**
//   （spawn 后立即写 prompt + 回车 → 输入框停在空占位、整轮消失；同一会话延迟 8s 再敲完全
//   成功）——「等就绪再敲」是时序启发式，服务端不可靠。ACP 用协议把同一会话续起来：
//   initialize → authenticate → session/load（回放历史）→ session/prompt
//   （流式 agent_message_chunk delta；结束有确定性 stopReason；工具走 tool_call /
//   tool_call_update；权限请求 agent→client 经 session/request_permission 往返）。
//
// 边界（有意为之，见 docs/architecture/design-patterns.md 的 acp-session-runner 行）：
//   - 本模块不感知 provider：入口参数来自 acp-layouts（buildAcpEntryArgs），认证方法由
//     provider 启动策略的 resolveAcpAuthMethod 派生，引擎只做接线。
//   - 完成判定**不在这里**：ACP 不流错误文案（实测 Insufficient balance 只落会话库、
//     不发通知），权威正文在 transcript —— 由引擎既有的 completeFromOfficialTranscript
//     收尾；本 runner 只负责把轮次跑起来与把 delta/工具事件送出去。引擎把收尾的**开跑
//     时机**挂在本次 prompt 的结算上（native-session-chat.js 的 kickTranscriptCompletion）：
//     cline 的 transcript 是增量追加的，拿「首次追加」当完成会把工具轮截断成 :::tool 块。
//   - 权限请求：bypass → 自动允许（优先 allow_always；这是真机验证过的往返形状）；
//     confirm/plan + 注入了审批面（canonical NativeApprovalSurface）→ 逐项交给用户决定，
//     选项原样来自 agent（allow_once / allow_always / reject_*），决策回传对应 optionId；
//     confirm/plan 但未注入审批面 → fail closed（native_session_approval_bridge_unavailable）。
//   - 新会话：传 newSession=true 时走 session/new（而不是 session/load），拿到的 sessionId
//     经 emitEvent({type:'session-created'}) 交给引擎（confirm/plan 的新会话必须走协议才有审批回路）。
//     plan 模式：agent 在 session/new 响应里声明了 `plan` 模式（gemini 实测）→ session/set_mode。
//   - 2026-10-31 真机（gemini 0.66 --acp）：tool_call(kind=execute) → request_permission
//     options=[proceed_always/allow_always, proceed_once/allow_once, cancel/reject_once]；
//     回 reject 后工具未执行（目标文件未创建）。
//
// 形状证据（2026-10-16 capture，cline 3.0.71）：
//   session/update 信封：{sessionId, update:{sessionUpdate, ...}}，其中
//     · agent_message_chunk / user_message_chunk / agent_thought_chunk：content{type:'text',text}
//     · tool_call：{toolCallId, title, kind, status, rawInput}
//     · tool_call_update：{toolCallId, status, rawOutput}
//     · session_info_update：忽略
//   session/load 回放：整段历史（user/agent/tool）在 load 响应【之前】到达 —— 据此丢弃：
//   通知处理器在 load 完成后再注册。
//   session/prompt 响应：{stopReason:'end_turn'|…}。
//   session/request_permission（agent→client，请求 id 实测为 0，必须原样回传）：
//     {sessionId, toolCall, options:[{optionId, name, kind}]}
//     响应 {outcome:{outcome:'selected', optionId}} 或 {outcome:{outcome:'cancelled'}}。

const { spawn: defaultSpawn } = require('node:child_process');

// 握手单步超时（initialize/authenticate/session-load）；**prompt 轮次不设客户端超时** ——
// 模型思考时长不可预估，由引擎的 transcript 超时与看门狗兜底。
const ACP_HANDSHAKE_TIMEOUT_MS = 30000;

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function codedError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

/**
 * 起一个 ACP 子进程并返回 { child, client }：
 *   child  —— 引擎的 child 形状（onData/onErrorData/onExit/kill/resize）。stdout 是协议帧，
 *             **不向引擎透传**（否则会被结构化流按 JSONL 误解析）；stderr 原样透传
 *             （认证/错误扫描用）。
 *   client —— 协议端：request/notify/onNotification/onRequest。
 *
 * @param {{command:string,args?:string[],cwd?:string,env?:object,spawnImpl?:Function}} options
 */
function createAcpSessionChild(options = {}) {
  const spawnImpl = typeof options.spawnImpl === 'function' ? options.spawnImpl : defaultSpawn;
  const command = String(options.command || '');
  const args = Array.isArray(options.args) ? options.args.map((item) => String(item)) : [];
  const cwd = String(options.cwd || process.cwd());
  const env = options.env && typeof options.env === 'object' ? options.env : process.env;

  const proc = spawnImpl(command, args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    // 服务端场景不弹控制台（Windows）；posix 无影响。
    windowsHide: true
  });

  let stdoutBuffer = '';
  let nextRequestId = 1;
  let exited = false;
  let exitInfo = null;
  let killEscalationTimer = null;
  const pendingRequests = new Map(); // id -> {resolve, reject}
  const errorHandlers = [];
  const exitHandlers = [];
  let notificationHandler = null;
  let requestHandler = null;

  const rejectAllPending = (error) => {
    for (const waiter of [...pendingRequests.values()]) {
      try {
        waiter.reject(error);
      } catch (_error) { /* ignore */ }
    }
    pendingRequests.clear();
  };

  const markExited = () => {
    if (exited) return;
    exited = true;
    exitInfo = { exitCode: typeof proc.exitCode === 'number' ? proc.exitCode : -1 };
    rejectAllPending(codedError('acp_session_process_exited', 'ACP 进程已退出'));
    for (const handler of [...exitHandlers]) {
      try {
        handler(exitInfo);
      } catch (_error) { /* ignore */ }
    }
  };

  const writeLine = (payload) => {
    if (exited) return false;
    try {
      proc.stdin.write(`${JSON.stringify(payload)}\n`);
      return true;
    } catch (_error) {
      return false;
    }
  };

  const respondResult = (id, result) => writeLine({ jsonrpc: '2.0', id, result });
  const respondError = (id, code, message) => writeLine({ jsonrpc: '2.0', id, error: { code, message } });

  const handleMessage = (message) => {
    if (!message || typeof message !== 'object') return;
    if (typeof message.method === 'string') {
      const hasId = message.id !== undefined && message.id !== null;
      if (hasId) {
        // agent → client 请求（请求 id 不受 JSON-RPC 的「非零」约束，必须原样回传）。
        if (typeof requestHandler !== 'function') {
          respondError(message.id, -32601, `method not supported: ${message.method}`);
          return;
        }
        Promise.resolve()
          .then(() => requestHandler({ id: message.id, method: message.method, params: message.params || {} }))
          .then((result) => {
            if (result === undefined) {
              respondError(message.id, -32601, `method not supported: ${message.method}`);
              return;
            }
            respondResult(message.id, result);
          })
          .catch((error) => {
            respondError(message.id, -32000, String((error && error.message) || error));
          });
        return;
      }
      if (typeof notificationHandler === 'function') {
        try {
          notificationHandler({ method: message.method, params: message.params || {} });
        } catch (_error) { /* ignore */ }
      }
      return;
    }
    // 我方请求的响应。
    if (message.id === undefined || message.id === null) return;
    const waiter = pendingRequests.get(message.id);
    if (!waiter) return;
    pendingRequests.delete(message.id);
    if (message.error) {
      const error = codedError('acp_request_failed', String(message.error.message || 'acp_request_failed'));
      error.acpError = message.error;
      waiter.reject(error);
      return;
    }
    waiter.resolve(message.result);
  };

  proc.stdout.on('data', (chunk) => {
    stdoutBuffer += String(chunk);
    let index;
    while ((index = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, index).trim();
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      if (!line) continue;
      let message = null;
      try {
        message = JSON.parse(line);
      } catch (_error) {
        continue;
      }
      handleMessage(message);
    }
  });
  proc.stderr.on('data', (chunk) => {
    const text = String(chunk);
    for (const handler of [...errorHandlers]) {
      try {
        handler(text);
      } catch (_error) { /* ignore */ }
    }
  });
  // stdin 在对端退出后写入会异步抛 EPIPE：吞掉，避免打崩宿主进程。
  proc.stdin.on('error', () => {});
  proc.on('exit', markExited);
  proc.on('error', (error) => {
    rejectAllPending(error);
    markExited();
  });

  const request = (method, params, requestOptions = {}) => new Promise((resolve, reject) => {
    if (exited) {
      reject(codedError('acp_session_process_exited', 'ACP 进程已退出'));
      return;
    }
    const id = nextRequestId;
    nextRequestId += 1;
    const timeoutMs = Number(requestOptions.timeoutMs) || 0;
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        pendingRequests.delete(id);
        reject(codedError('acp_request_timeout', `acp 请求超时: ${method}`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }
    pendingRequests.set(id, {
      resolve: (value) => {
        if (timer) clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        if (timer) clearTimeout(timer);
        reject(error);
      }
    });
    if (!writeLine({ jsonrpc: '2.0', id, method, params })) {
      pendingRequests.delete(id);
      if (timer) clearTimeout(timer);
      reject(codedError('acp_session_stdin_unavailable', 'ACP 进程 stdin 不可写'));
    }
  });

  const child = {
    onData(handler) {
      // 协议帧不透传给引擎（见模块头注释）：保留 API 形状，但从不回调。
      void handler;
    },
    onErrorData(handler) {
      if (typeof handler === 'function') errorHandlers.push(handler);
    },
    onExit(handler) {
      if (typeof handler !== 'function') return;
      if (exited && exitInfo) {
        handler(exitInfo);
        return;
      }
      exitHandlers.push(handler);
    },
    kill() {
      if (exited) return;
      // 先温和结束 stdin（让对端有机会收尾），再 SIGTERM；若对端不响应（bun 编译体），
      // 5s 后升级 SIGKILL，避免收尾悬挂。
      try {
        proc.stdin.end();
      } catch (_error) { /* ignore */ }
      try {
        proc.kill();
      } catch (_error) { /* ignore */ }
      if (!killEscalationTimer) {
        killEscalationTimer = setTimeout(() => {
          killEscalationTimer = null;
          if (!exited) {
            try {
              proc.kill('SIGKILL');
            } catch (_error) { /* ignore */ }
          }
        }, 5000);
        if (typeof killEscalationTimer.unref === 'function') killEscalationTimer.unref();
      }
    },
    resize() {}
  };

  const client = {
    request,
    notify(method, params) {
      writeLine({ jsonrpc: '2.0', method, params });
    },
    onNotification(handler) {
      notificationHandler = typeof handler === 'function' ? handler : null;
    },
    onRequest(handler) {
      requestHandler = typeof handler === 'function' ? handler : null;
    }
  };

  return { child, client };
}

function extractContentText(content) {
  if (!content) return '';
  if (typeof content.text === 'string') return content.text;
  if (Array.isArray(content)) {
    let out = '';
    for (const part of content) {
      if (part && typeof part.text === 'string') out += part.text;
    }
    return out;
  }
  return '';
}

/** session/update → 引擎事件（只保留对 UI/看门狗有意义的部分；回放由调用时机排除）。 */
function mapSessionUpdate(update, emitEvent) {
  if (!update || typeof update !== 'object') return;
  const kind = normalizeText(update.sessionUpdate);
  if (kind === 'agent_message_chunk') {
    const text = extractContentText(update.content);
    if (text) emitEvent({ type: 'delta', delta: text });
    return;
  }
  if (kind === 'agent_thought_chunk') {
    const text = extractContentText(update.content);
    if (text) emitEvent({ type: 'thinking', thinking: text });
    return;
  }
  if (kind === 'tool_call') {
    const label = normalizeText(update.title) || normalizeText(update.kind) || 'tool';
    emitEvent({ type: 'assistant_tool_call', content: label });
  }
  // tool_call_update / session_info_update / user_message_chunk：不产生独立事件
  // （工具结果在本轮 transcript 收尾里完整落库）。
}

// ACP 选项 kind → canonical 审批选项 intent。未知 kind 按拒绝处理（绝不把未知选项当允许）。
const ACP_OPTION_LABELS = Object.freeze({
  allow_once: '允许一次',
  allow_always: '本会话内总是允许',
  reject_once: '拒绝',
  reject_always: '总是拒绝'
});

function acpChoices(optionList) {
  const options = Array.isArray(optionList) ? optionList : [];
  return options
    .filter((option) => option && normalizeText(option.optionId))
    .map((option) => {
      const kind = normalizeText(option.kind);
      // 「总是允许」有两种语义：gemini/codebuddy 的 proceed_always 只在本会话生效；qoder 的
      // proceed_always_and_save 会把规则写进 CLI 配置（以后所有会话都放行，2026-11-01 实测 optionId）。
      // 持久化的那种不能标成「本会话内」，否则用户以为一次性的放行会被永久保存。
      const persistent = kind === 'allow_always' && /save|persist|permanent/i.test(normalizeText(option.optionId));
      return {
        id: normalizeText(option.optionId),
        label: persistent
          ? `总是允许（保存到 CLI 配置）${normalizeText(option.name) ? `：${normalizeText(option.name)}` : ''}`
          : ACP_OPTION_LABELS[kind] || normalizeText(option.name) || normalizeText(option.optionId),
        intent: kind.startsWith('allow') ? 'accept' : 'deny'
      };
    });
}

function describeToolCall(toolCall) {
  const call = toolCall && typeof toolCall === 'object' ? toolCall : {};
  const parts = [];
  for (const entry of Array.isArray(call.content) ? call.content : []) {
    const textPart = entry && entry.content && typeof entry.content.text === 'string' ? entry.content.text : '';
    if (textPart) parts.push(textPart);
  }
  for (const location of Array.isArray(call.locations) ? call.locations : []) {
    if (location && normalizeText(location.path)) parts.push(normalizeText(location.path));
  }
  if (parts.length === 0 && call.rawInput !== undefined) {
    try { parts.push(JSON.stringify(call.rawInput)); } catch (_error) { /* ignore */ }
  }
  const detail = parts.join('\n');
  return detail.length > 600 ? `${detail.slice(0, 600)}…` : detail;
}

/** 把一次 session/request_permission 交给审批面，等用户决定后回 ACP outcome。 */
function requestPermissionFromSurface(approvalSurface, params) {
  const choices = acpChoices(params.options);
  if (choices.length === 0) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
  const toolCall = params.toolCall || {};
  const rawInput = toolCall.rawInput && typeof toolCall.rawInput === 'object' ? toolCall.rawInput : {};
  // 标题优先 agent 给的 title（gemini），其次工具入参里的说明/命令（codebuddy 只给 rawInput）。
  const headline = normalizeText(toolCall.title) || normalizeText(rawInput.description)
    || normalizeText(rawInput.command) || normalizeText(rawInput.file_path || rawInput.path);
  return new Promise((resolve) => {
    approvalSurface.request({
      toolName: normalizeText(toolCall.kind) || 'tool',
      title: headline ? `允许执行「${headline.length > 80 ? `${headline.slice(0, 80)}…` : headline}」吗？` : '',
      detail: describeToolCall(toolCall),
      choices,
      resolve: (decision) => {
        const picked = decision && normalizeText(decision.choiceId)
          ? choices.find((choice) => choice.id === normalizeText(decision.choiceId))
          : null;
        // 审批面关闭/运行结束（无 choiceId）→ 选 agent 给的拒绝项；没有拒绝项就 cancelled。
        const fallbackDeny = choices.find((choice) => choice.intent === 'deny');
        const chosen = picked || (decision && decision.behavior === 'allow' ? null : fallbackDeny);
        resolve(chosen
          ? { outcome: { outcome: 'selected', optionId: chosen.id } }
          : { outcome: { outcome: 'cancelled' } });
      }
    });
  });
}

function selectAllowOption(optionList) {
  const options = Array.isArray(optionList) ? optionList : [];
  return options.find((item) => item && item.kind === 'allow_always')
    || options.find((item) => item && item.kind === 'allow_once')
    || options.find((item) => item && typeof item.kind === 'string' && item.kind.startsWith('allow'))
    || null;
}

/**
 * 跑一轮 ACP 会话（把已有会话以协议方式续起来）。
 *
 * @param {{request:Function,onNotification:Function,onRequest:Function}} client createAcpSessionChild 的 client
 * @param {{sessionId:string,cwd?:string,prompt:string,authMethod?:string,approvalMode?:string,
 *          emitEvent?:Function,onFatal?:Function}} options
 * @returns {Promise<void>} 轮次协议生命周期（不等于本轮完成：完成由引擎 transcript 收尾判定）
 */
function startAcpSessionTurn(client, options = {}) {
  const emitEvent = typeof options.emitEvent === 'function' ? options.emitEvent : () => {};
  const onFatal = typeof options.onFatal === 'function' ? options.onFatal : () => {};
  const sessionId = normalizeText(options.sessionId);
  const cwd = normalizeText(options.cwd);
  const promptText = String(options.prompt || '');
  const authMethod = normalizeText(options.authMethod);
  const approvalMode = normalizeText(options.approvalMode) || 'bypass';
  const approvalNeedsBridge = approvalMode !== 'bypass';
  const approvalSurface = options.approvalSurface && typeof options.approvalSurface.request === 'function'
    ? options.approvalSurface
    : null;
  const newSession = options.newSession === true;
  const model = normalizeText(options.model);

  return Promise.resolve()
    .then(async () => {
      await client.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }
      }, { timeoutMs: ACP_HANDSHAKE_TIMEOUT_MS });
      if (authMethod) {
        await client.request('authenticate', { methodId: authMethod }, {
          timeoutMs: ACP_HANDSHAKE_TIMEOUT_MS
        });
      }
      let activeSessionId = sessionId;
      let availableModels = [];
      if (newSession) {
        const created = await client.request('session/new', {
          cwd: cwd || process.cwd(),
          mcpServers: []
        }, { timeoutMs: ACP_HANDSHAKE_TIMEOUT_MS });
        activeSessionId = normalizeText(created && created.sessionId);
        if (!activeSessionId) throw codedError('acp_session_new_missing_id', 'ACP session/new 未返回 sessionId');
        emitEvent({ type: 'session-created', sessionId: activeSessionId });
        availableModels = created && created.models && Array.isArray(created.models.availableModels)
          ? created.models.availableModels : [];
        const modes = created && created.modes && Array.isArray(created.modes.availableModes)
          ? created.modes.availableModes : [];
        if (approvalMode === 'plan' && modes.some((mode) => mode && mode.id === 'plan')) {
          await client.request('session/set_mode', { sessionId: activeSessionId, modeId: 'plan' }, {
            timeoutMs: ACP_HANDSHAKE_TIMEOUT_MS
          });
        }
      } else {
        const loaded = await client.request('session/load', {
          sessionId,
          ...(cwd ? { cwd } : {}),
          mcpServers: []
        }, { timeoutMs: ACP_HANDSHAKE_TIMEOUT_MS });
        availableModels = loaded && loaded.models && Array.isArray(loaded.models.availableModels)
          ? loaded.models.availableModels : [];
      }
      // 本轮模型：ACP 不认 argv 的 --model，用 session/set_model（不稳定扩展，gemini/codebuddy 实测
      // 在 session/new 响应里给 models.availableModels）。agent 不支持就保留其默认模型——
      // 宿主（如 AIH 网关）可能接受目录外的模型 id，所以不按目录过滤，只在 agent 拒绝时忽略。
      if (model) {
        try {
          await client.request('session/set_model', { sessionId: activeSessionId, modelId: model }, {
            timeoutMs: ACP_HANDSHAKE_TIMEOUT_MS
          });
        } catch (_error) { /* agent 不支持切模型：沿用默认 */ }
      }

      // load 完成后才注册处理器：load 响应前到达的 session/update 是整段历史回放（取证见头注释）。
      client.onNotification((notification) => {
        if (normalizeText(notification.method) !== 'session/update') return;
        mapSessionUpdate((notification.params || {}).update, emitEvent);
      });
      client.onRequest((request) => {
        if (normalizeText(request.method) !== 'session/request_permission') return undefined;
        const optionList = (request.params || {}).options;
        if (approvalNeedsBridge && approvalSurface) {
          return requestPermissionFromSurface(approvalSurface, request.params || {});
        }
        if (approvalNeedsBridge) {
          // fail closed：本通道暂无审批桥，绝不静默放行工具。
          const error = codedError(
            'native_session_approval_bridge_unavailable',
            `approval mode ${approvalMode} 需要审批桥，ACP 通道未接线`
          );
          // 先让 cancelled 响应走完（fatal 会杀进程），再上报失败。
          setImmediate(() => onFatal(error));
          return { outcome: { outcome: 'cancelled' } };
        }
        const picked = selectAllowOption(optionList);
        if (!picked) return { outcome: { outcome: 'cancelled' } };
        return { outcome: { outcome: 'selected', optionId: picked.optionId } };
      });

      const result = await client.request('session/prompt', {
        sessionId: activeSessionId,
        prompt: [{ type: 'text', text: promptText }]
      });
      return result;
    })
    .catch((error) => {
      const failure = error instanceof Error
        ? error
        : codedError('acp_session_turn_failed', String(error || 'acp_session_turn_failed'));
      if (!failure.code) failure.code = 'acp_session_turn_failed';
      onFatal(failure);
    });
}

module.exports = {
  ACP_HANDSHAKE_TIMEOUT_MS,
  acpChoices,
  createAcpSessionChild,
  startAcpSessionTurn
};
