'use strict';

// Claude Code adapter：NDJSON 事件流（--output-format stream-json）+ 官方权限提示工具。
//
// 为什么走 MCP 权限工具而不是读屏：claude 把「需要人确认的工具调用」统一交给
// --permission-prompt-tool 指定的工具（lib/server/claude-permission-mcp-tool.js），
// 该工具把 {tool_name, input, tool_use_id} POST 到本机审批桥并长挂等决策。于是
// approval / AskUserQuestion / ExitPlanMode 三种交互都能拿到结构化输入，不用解析屏幕。
//
// 桥的三条硬约束：
//   1. 只监听 127.0.0.1，端口交给内核分配（listen 0），不对外暴露；
//   2. 每个会话一份随机 token，写在 URL 路径里 —— MCP 工具只会 POST 到 launch context
//      里给它的地址，别的本机进程猜不到 token，也无法替用户放行；
//   3. 拿不到决策就 deny。桥超时、会话 dispose、handler 抛错，一律回 deny，绝不自动放行。
//
// 注入点（context.spawn / createHttpServer / writeLaunchContext ...）让测试不碰真子进程；
// 生产路径全部用真实实现。

const crypto = require('node:crypto');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn: spawnProcess } = require('node:child_process');

const { AgentSessionError, isPlainObject, nonEmptyString } = require('../contracts');
const {
  buildClaudeApprovalMcpConfig,
  claudeApprovalArgs
} = require('../../server/native-approval-modes');
const { removeLaunchContext, writeLaunchContext } = require('../../runtime/launch-context');

const ADAPTER_ID = 'claude-stream-mcp';
const DEFAULT_PERMISSION_TOOL_PATH = path.join(
  __dirname, '..', '..', 'server', 'claude-permission-mcp-tool.js'
);
const BRIDGE_PATH_PREFIX = '/approve/';
const BRIDGE_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 1024 * 1024;
// 与 claude-permission-mcp-tool.js 的 DECISION_TIMEOUT_MS 对齐：桥比工具先超时，
// 这样 deny 由我们自己发，而不是让工具端默默断线。
const DEFAULT_APPROVAL_TIMEOUT_MS = 600_000;
const DEFAULT_INIT_TIMEOUT_MS = 30_000;

// print 模式 + NDJSON 双向流：stdin 持续喂 user 消息才能多轮，stdout 每行一个事件。
const BASE_ARGS = Object.freeze([
  '--print',
  '--input-format', 'stream-json',
  '--output-format', 'stream-json',
  '--verbose'
]);

// 会话模式 → claude 审批模式。差异是数据不是 if/else，加模式只加一行。
const SESSION_MODES = Object.freeze([
  Object.freeze({ id: 'confirm', label: 'Confirm', approvalMode: 'confirm' }),
  Object.freeze({ id: 'plan', label: 'Plan', approvalMode: 'plan' }),
  Object.freeze({ id: 'bypass', label: 'Bypass', approvalMode: 'bypass' })
]);
const MODE_BY_ID = new Map(SESSION_MODES.map((mode) => [mode.id, mode]));
// 默认 confirm：这个 adapter 的存在意义就是结构化交互；bypass 会让桥永远收不到请求。
const DEFAULT_MODE_ID = 'confirm';
const MODE_ALIASES = Object.freeze({ default: 'confirm' });

// 工具名 → 交互 kind。未登记的工具一律走 approval（权限确认是默认语义）。
const TOOL_ROUTES = Object.freeze([
  Object.freeze({ toolName: 'ExitPlanMode', kind: 'plan_confirmation' }),
  Object.freeze({ toolName: 'AskUserQuestion', kind: 'question' })
]);
const TOOL_ROUTE_BY_NAME = new Map(TOOL_ROUTES.map((route) => [route.toolName, route]));
const DEFAULT_TOOL_ROUTE = Object.freeze({ kind: 'approval' });

// approval 的 choiceId → 回给 MCP 工具的 {behavior, message}。
const APPROVAL_RESPONSES = Object.freeze({
  allow: Object.freeze({ behavior: 'allow' }),
  deny: Object.freeze({ behavior: 'deny', message: '用户在终端拒绝了此操作' })
});

// 审批卡上给人看的关键字段，按优先级取第一个非空值。
const DETAIL_KEYS = Object.freeze([
  'command', 'file_path', 'path', 'notebook_path', 'url', 'pattern', 'description'
]);

const STOP_REASON_MAP = Object.freeze({
  end_turn: 'end_turn',
  max_tokens: 'max_tokens',
  stop_sequence: 'stop_sequence',
  tool_use: 'tool_use',
  pause_turn: 'pause_turn',
  refusal: 'refusal'
});

function sessionError(code, details) {
  return Object.assign(new Error(code), { code, details });
}

function positiveInt(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.floor(number);
}

function resolveModeId(value) {
  const raw = nonEmptyString(value).toLowerCase();
  if (!raw) return DEFAULT_MODE_ID;
  const id = MODE_ALIASES[raw] || raw;
  if (!MODE_BY_ID.has(id)) throw sessionError('claude_mode_unknown', { mode: raw });
  return id;
}

function summarizeToolInput(input) {
  for (const key of DETAIL_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 600);
  }
  try {
    const text = JSON.stringify(input);
    return text && text !== '{}' ? text.slice(0, 600) : '';
  } catch (_error) {
    return '';
  }
}

// approval：至少 allow/deny，intent 分别 accept/deny；detail 放命令/路径等关键参数。
function buildApprovalPayload(toolName, input) {
  const presentation = { title: `允许执行 ${toolName} 吗？` };
  const detail = summarizeToolInput(input);
  if (detail) presentation.detail = detail;
  return {
    presentation,
    choices: [
      { id: 'allow', label: '允许', intent: 'accept' },
      { id: 'deny', label: '拒绝', intent: 'deny' }
    ]
  };
}

function uniqueFieldId(base, seen, index) {
  let id = base || `question_${index + 1}`;
  let suffix = 2;
  while (seen.has(id)) {
    id = `${base} (${suffix})`;
    suffix += 1;
  }
  seen.add(id);
  return id;
}

// AskUserQuestion 的 questions → canonical fields。
// field id 直接用问题原文：claude 的答案按问题文本回写，id 与文本不一致就写不回去。
function buildQuestionPayload(input) {
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const fields = [];
  const seen = new Set();
  questions.forEach((question, index) => {
    const source = isPlainObject(question) ? question : {};
    const label = nonEmptyString(source.question) || `问题 ${index + 1}`;
    const id = uniqueFieldId(label, seen, index);
    const multiSelect = Boolean(source.multiSelect);
    const options = Array.isArray(source.options) ? source.options : [];
    const field = {
      id,
      label,
      type: multiSelect ? 'multi_select' : 'single_select',
      required: true,
      // canonical 只允许 single_select 开 allowOther；claude 的「Other」正好是单选补充。
      allowOther: !multiSelect,
      secret: false
    };
    const header = nonEmptyString(source.header);
    if (header) field.header = header;
    if (options.length > 0) {
      const seenValues = new Set();
      field.options = [];
      options.forEach((option, optionIndex) => {
        const entry = isPlainObject(option) ? option : {};
        const labelText = nonEmptyString(entry.label) || `选项 ${optionIndex + 1}`;
        let value = nonEmptyString(entry.value) || labelText;
        while (seenValues.has(value)) value = `${value}_${optionIndex + 1}`;
        seenValues.add(value);
        const normalized = { value, label: labelText };
        const description = nonEmptyString(entry.description);
        if (description) normalized.description = description;
        field.options.push(normalized);
      });
    } else {
      // 没有选项就没法做选择，退化成文本输入；否则 canonical 会因 options 为空拒绝。
      field.type = 'text';
      field.allowOther = false;
    }
    fields.push(field);
  });
  if (fields.length === 0) {
    throw sessionError('claude_question_payload_invalid', { reason: 'questions_empty' });
  }
  return {
    presentation: { title: 'Claude 需要你的回答' },
    fields,
    actions: ['submit', 'cancel'],
    answerShape: 'answers',
    confirmUnanswered: false
  };
}

// ExitPlanMode → plan_confirmation。
// canonical 里 question/plan_confirmation 的 presentation 只允许 title/message/link
// （detail 是 approval 专属），所以计划正文放 message；answerShape 用 none，
// 因为计划确认只有「执行/取消」两态，编造一个必答字段只会让 UI 多问一句废话。
function buildPlanPayload(input) {
  const plan = nonEmptyString(input.plan);
  const presentation = { title: '计划已就绪，是否执行？' };
  if (plan) presentation.message = plan.slice(0, 8000);
  return {
    presentation,
    fields: [],
    actions: ['submit', 'cancel'],
    answerShape: 'none',
    confirmUnanswered: false
  };
}

function buildPayload(kind, toolName, input) {
  if (kind === 'question') return buildQuestionPayload(input);
  if (kind === 'plan_confirmation') return buildPlanPayload(input);
  return buildApprovalPayload(toolName, input);
}

// 归一化后的 decision → MCP 工具期望的 JSON 结果。
function decisionToResponse(entry, decision) {
  if (entry.kind === 'approval') {
    const choiceId = nonEmptyString(decision && decision.choiceId);
    const mapped = APPROVAL_RESPONSES[choiceId];
    if (!mapped) throw sessionError('claude_decision_choice_unknown', { choiceId });
    return mapped.behavior === 'allow'
      ? { behavior: 'allow', updatedInput: entry.input }
      : { behavior: 'deny', message: mapped.message };
  }
  const action = nonEmptyString(decision && decision.action) || 'submit';
  if (action === 'submit') {
    // 提问的答案要回写到工具输入：claude 读 updatedInput.answers 才认为问题已被回答。
    if (entry.kind === 'question') {
      return { behavior: 'allow', updatedInput: { answers: (decision && decision.answers) || {} } };
    }
    return { behavior: 'allow', updatedInput: entry.input };
  }
  return {
    behavior: 'deny',
    message: action === 'cancel' ? '用户取消了此交互' : '用户拒绝了此操作'
  };
}

function tokenMatches(url, token) {
  if (!token) return false;
  if (!url.startsWith(BRIDGE_PATH_PREFIX)) return false;
  const provided = Buffer.from(url.slice(BRIDGE_PATH_PREFIX.length), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

function respondJson(res, statusCode, body) {
  if (!res || res.writableEnded || res.destroyed) return;
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function denyBody(message) {
  return { behavior: 'deny', message };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(sessionError('claude_bridge_body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (_error) {
        reject(sessionError('claude_bridge_body_invalid'));
      }
    });
    req.on('error', reject);
  });
}

function createAdapter(options) {
  const config = isPlainObject(options) ? options : {};
  const sessionId = nonEmptyString(config.sessionId);
  if (!sessionId) throw new AgentSessionError('agent_session_id_required');
  const context = isPlainObject(config.context) ? config.context : {};

  const spawn = typeof context.spawn === 'function' ? context.spawn : spawnProcess;
  const createHttpServer = typeof context.createHttpServer === 'function'
    ? context.createHttpServer
    : http.createServer;
  const writeContextFile = typeof context.writeLaunchContext === 'function'
    ? context.writeLaunchContext
    : writeLaunchContext;
  const removeContextFile = typeof context.removeLaunchContext === 'function'
    ? context.removeLaunchContext
    : removeLaunchContext;

  const claudePath = nonEmptyString(context.claudePath) || 'claude';
  const nodePath = nonEmptyString(context.nodePath) || process.execPath;
  const permissionToolPath = nonEmptyString(context.permissionToolPath) || DEFAULT_PERMISSION_TOOL_PATH;
  const launchContextRoot = nonEmptyString(context.launchContextRoot) || os.tmpdir();
  const approvalTimeoutMs = positiveInt(context.approvalTimeoutMs, DEFAULT_APPROVAL_TIMEOUT_MS);
  const initTimeoutMs = positiveInt(context.initTimeoutMs, DEFAULT_INIT_TIMEOUT_MS);

  const listeners = new Set();
  const requestHandlers = new Set();
  const pending = new Map(); // interactionId -> { res, timer, settled, kind, input, toolName }

  let bridge = null; // { server, token, port, url }
  let reader = null;
  let launchContextPath = '';
  let child = null;
  let activeTurn = null;
  let initWaiter = null;
  let modeId = DEFAULT_MODE_ID;
  let modelId = '';
  let interactionSeq = 0;
  let disposed = false;

  function emit(event) {
    if (disposed) return;
    for (const listener of Array.from(listeners)) {
      try {
        listener(event);
      } catch (_error) {
        // 单个 listener 出错不能打断事件流解析；bus 自己也会记账。
      }
    }
  }

  function startBridge() {
    const token = crypto.randomBytes(24).toString('hex');
    const server = createHttpServer((req, res) => {
      handleBridgeRequest(token, req, res).catch(() => {
        respondJson(res, 500, denyBody('审批桥内部错误，已默认拒绝'));
      });
    });
    return new Promise((resolve, reject) => {
      const onError = (error) => {
        server.removeListener('listening', onListening);
        reject(sessionError('claude_bridge_listen_failed', {
          message: String(error && error.message ? error.message : error)
        }));
      };
      const onListening = () => {
        server.removeListener('error', onError);
        const address = server.address();
        const port = address && typeof address === 'object' ? address.port : 0;
        resolve({ server, token, port, url: `http://${BRIDGE_HOST}:${port}${BRIDGE_PATH_PREFIX}${token}` });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(0, BRIDGE_HOST);
    });
  }

  function settleEntry(entry, payload) {
    if (!entry || entry.settled) return false;
    entry.settled = true;
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    if (pending.get(entry.interactionId) === entry) pending.delete(entry.interactionId);
    respondJson(entry.res, 200, payload);
    return true;
  }

  function denyAllPending(message) {
    let count = 0;
    for (const entry of Array.from(pending.values())) {
      if (settleEntry(entry, denyBody(message))) count += 1;
    }
    return count;
  }

  async function handleBridgeRequest(token, req, res) {
    if (disposed) {
      respondJson(res, 503, denyBody('会话已关闭，自动拒绝'));
      return;
    }
    if (req.method !== 'POST') {
      respondJson(res, 405, denyBody('审批桥只接受 POST'));
      return;
    }
    if (!tokenMatches(String(req.url || ''), token)) {
      // token 不对一律 403，且不碰任何 pending 状态：不能让本机别的进程替用户放行。
      respondJson(res, 403, denyBody('审批桥 token 无效'));
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      respondJson(res, 400, denyBody('审批桥请求体无效，已默认拒绝'));
      return;
    }
    dispatchBridgeRequest(body, res);
  }

  function dispatchBridgeRequest(body, res) {
    const toolName = nonEmptyString(body.toolName);
    if (!toolName) {
      respondJson(res, 400, denyBody('缺少 tool_name，已默认拒绝'));
      return;
    }
    const input = isPlainObject(body.input) ? body.input : {};
    const toolUseId = nonEmptyString(body.toolUseId);
    const route = TOOL_ROUTE_BY_NAME.get(toolName) || DEFAULT_TOOL_ROUTE;
    interactionSeq += 1;
    const interactionId = `cri_${toolUseId || `${sessionId}_${interactionSeq}`}`;

    let payload;
    try {
      payload = buildPayload(route.kind, toolName, input);
    } catch (error) {
      respondJson(res, 400, denyBody('无法把该工具调用转成交互，已默认拒绝'));
      return;
    }

    const entry = {
      interactionId,
      kind: route.kind,
      toolName,
      input,
      res,
      settled: false,
      timer: null
    };
    pending.set(interactionId, entry);
    // 与 router 用同一个超时：到点桥回 deny，router 侧同时把交互标 expired。
    entry.timer = setTimeout(() => {
      settleEntry(entry, denyBody('审批等待超时，已默认拒绝'));
    }, approvalTimeoutMs);
    if (typeof entry.timer.unref === 'function') entry.timer.unref();
    res.on('close', () => {
      // 客户端断开（claude 被杀/工具端放弃）就不再保留挂起项，后续 respond 会报 unknown。
      if (entry.settled) return;
      entry.settled = true;
      if (entry.timer) clearTimeout(entry.timer);
      if (pending.get(interactionId) === entry) pending.delete(interactionId);
    });

    if (requestHandlers.size === 0) {
      settleEntry(entry, denyBody('没有交互接收方，已默认拒绝'));
      return;
    }

    const request = {
      interactionId,
      kind: route.kind,
      payload,
      itemId: toolUseId || interactionId,
      timeoutMs: approvalTimeoutMs
    };
    if (activeTurn && activeTurn.turnId) request.turnId = activeTurn.turnId;

    for (const handler of Array.from(requestHandlers)) {
      try {
        handler(request);
      } catch (_error) {
        // 路由拒绝（重复 id、payload 非法）→ 立刻 deny，绝不让 claude 悬着。
        settleEntry(entry, denyBody('交互请求未被接受，已默认拒绝'));
        return;
      }
    }
  }

  function finishTurn(turn, outcome, value) {
    if (!turn || turn.settled) return;
    turn.settled = true;
    if (activeTurn === turn) activeTurn = null;
    if (outcome === 'resolve') turn.resolve(value);
    else turn.reject(value);
  }

  function normalizeStopReason(result) {
    const raw = nonEmptyString(result && result.stop_reason);
    return STOP_REASON_MAP[raw] || raw || 'end_turn';
  }

  function handleLine(line) {
    const text = String(line || '').trim();
    if (!text) return;
    let event;
    try {
      event = JSON.parse(text);
    } catch (_error) {
      return; // 非 JSON 行（claude 偶尔写调试信息）直接跳过，不能让流断掉
    }
    if (!isPlainObject(event)) return;

    if (event.type === 'system' && event.subtype === 'init') {
      if (initWaiter) {
        const waiter = initWaiter;
        initWaiter = null;
        waiter.resolve({
          sessionId: nonEmptyString(event.session_id),
          model: nonEmptyString(event.model)
        });
      }
      return;
    }

    if (event.type === 'assistant') {
      const content = isPlainObject(event.message) && Array.isArray(event.message.content)
        ? event.message.content
        : [];
      for (const block of content) {
        if (!isPlainObject(block)) continue;
        const itemId = nonEmptyString(block.id) || undefined;
        if (block.type === 'text' && nonEmptyString(block.text)) {
          emit({
            type: 'timeline.item.completed',
            itemId,
            turnId: activeTurn ? activeTurn.turnId || undefined : undefined,
            payload: { kind: 'message', role: 'assistant', text: block.text }
          });
        } else if (block.type === 'tool_use') {
          emit({
            type: 'timeline.item.started',
            itemId,
            turnId: activeTurn ? activeTurn.turnId || undefined : undefined,
            payload: { kind: 'tool', toolName: nonEmptyString(block.name) || 'tool', toolUseId: itemId }
          });
        }
      }
      return;
    }

    if (event.type === 'user') {
      const content = isPlainObject(event.message) && Array.isArray(event.message.content)
        ? event.message.content
        : [];
      for (const block of content) {
        if (!isPlainObject(block) || block.type !== 'tool_result') continue;
        emit({
          type: 'timeline.item.completed',
          itemId: nonEmptyString(block.tool_use_id) || undefined,
          turnId: activeTurn ? activeTurn.turnId || undefined : undefined,
          payload: {
            kind: 'tool',
            toolUseId: nonEmptyString(block.tool_use_id) || undefined,
            status: block.is_error ? 'failed' : 'completed'
          }
        });
      }
      return;
    }

    if (event.type === 'result') {
      const turn = activeTurn;
      if (!turn) return;
      if (event.is_error || (event.subtype && event.subtype !== 'success')) {
        finishTurn(turn, 'reject', sessionError('claude_turn_failed', {
          subtype: nonEmptyString(event.subtype) || 'error'
        }));
        return;
      }
      finishTurn(turn, 'resolve', { stopReason: normalizeStopReason(event) });
    }
  }

  function attachChild(process) {
    if (process.stdout) {
      reader = readline.createInterface({ input: process.stdout });
      reader.on('line', handleLine);
    }
    if (process.stderr) {
      // 只排空不打印：stderr 可能带用户 prompt 片段，日志里不许出现内容。
      process.stderr.on('data', () => {});
    }
    process.on('exit', (code, signal) => {
      if (initWaiter) {
        const waiter = initWaiter;
        initWaiter = null;
        waiter.reject(sessionError('claude_process_exited', { exitCode: code, signal }));
      }
      denyAllPending('claude 进程已退出，已默认拒绝');
      const turn = activeTurn;
      if (turn) {
        finishTurn(turn, 'reject', sessionError('claude_process_exited', {
          exitCode: code,
          signal
        }));
      }
    });
    process.on('error', (error) => {
      if (initWaiter) {
        const waiter = initWaiter;
        initWaiter = null;
        waiter.reject(sessionError('claude_spawn_failed', {
          message: String(error && error.message ? error.message : error)
        }));
      }
      const turn = activeTurn;
      if (turn) {
        finishTurn(turn, 'reject', sessionError('claude_spawn_failed', {
          message: String(error && error.message ? error.message : error)
        }));
      }
    });
  }

  function waitForInit() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (initWaiter && initWaiter.timer === timer) initWaiter = null;
        reject(sessionError('claude_init_timeout', { timeoutMs: initTimeoutMs }));
      }, initTimeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      initWaiter = {
        timer,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      };
    });
  }

  function killChild(signal) {
    if (!child) return;
    const target = child;
    child = null;
    try {
      target.kill(signal || 'SIGTERM');
    } catch (_error) {
      // 进程可能已经退出，杀不掉不是错误
    }
  }

  function closeReader() {
    if (!reader) return;
    const current = reader;
    reader = null;
    try {
      current.close();
    } catch (_error) {
      // 流已断开时 close 可能抛，忽略
    }
  }

  function closeBridge() {
    if (!bridge) return;
    const current = bridge;
    bridge = null;
    try {
      current.server.close();
    } catch (_error) {
      // 已经关掉就算了
    }
  }

  function dropLaunchContext() {
    if (!launchContextPath) return;
    const target = launchContextPath;
    launchContextPath = '';
    try {
      removeContextFile(target);
    } catch (_error) {
      // 临时文件删不掉不影响会话正确性，只是多留一个 0600 文件
    }
  }

  function buildArgs(mode, mcpConfigJson, model) {
    const args = BASE_ARGS.slice();
    if (model) args.push('--model', model);
    // 参数表只在 native-approval-modes.js 里维护一份，这里绝不手抄。
    for (const arg of claudeApprovalArgs(mode.approvalMode, mcpConfigJson)) args.push(arg);
    return args;
  }

  async function open(openOptions) {
    const options = isPlainObject(openOptions) ? openOptions : {};
    if (disposed) throw sessionError('claude_session_disposed');
    if (child) throw sessionError('claude_session_already_open');

    const requestedMode = options.mode === undefined ? modeId : resolveModeId(options.mode);
    const requestedModel = options.model === undefined ? modelId : nonEmptyString(options.model);
    const mode = MODE_BY_ID.get(requestedMode);
    if (!mode) throw sessionError('claude_mode_unknown', { mode: requestedMode });

    if (mode.approvalMode !== 'bypass') {
      bridge = await startBridge();
      try {
        // launch context 是 MCP 工具拿到桥地址（含 token）的唯一途径；文件 0600，dispose 时删掉。
        launchContextPath = writeContextFile(
          { approvalUrl: bridge.url, runId: sessionId },
          { root: launchContextRoot }
        );
      } catch (error) {
        // 拿不到 launch context 就等于拿不到审批通道：先收桥再报错，别留一个空监听的端口。
        closeBridge();
        throw sessionError('claude_launch_context_failed', {
          message: String(error && error.message ? error.message : error)
        });
      }
    }
    const mcpConfigJson = mode.approvalMode === 'bypass'
      ? ''
      : buildClaudeApprovalMcpConfig({
        toolPath: permissionToolPath,
        nodePath,
        launchContextPath
      });

    child = spawn(claudePath, buildArgs(mode, mcpConfigJson, requestedModel), {
      cwd: nonEmptyString(options.cwd) || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    attachChild(child);

    let init;
    try {
      init = await waitForInit();
    } catch (error) {
      killChild('SIGKILL');
      denyAllPending('会话启动失败，已默认拒绝');
      closeReader();
      closeBridge();
      dropLaunchContext();
      throw error;
    }

    modeId = requestedMode;
    modelId = requestedModel;
    const models = [];
    for (const id of [requestedModel, init.model]) {
      const normalized = nonEmptyString(id);
      if (normalized && !models.some((entry) => entry.id === normalized)) {
        models.push({ id: normalized, label: normalized });
      }
    }
    return {
      sessionId: init.sessionId || sessionId,
      models,
      modes: SESSION_MODES.map((entry) => ({ id: entry.id, label: entry.label }))
    };
  }

  function prompt(promptOptions) {
    const options = isPlainObject(promptOptions) ? promptOptions : {};
    if (disposed) return Promise.reject(sessionError('claude_session_disposed'));
    if (!child) return Promise.reject(sessionError('claude_session_not_open'));
    if (activeTurn) return Promise.reject(sessionError('claude_turn_in_progress'));

    const content = [];
    const text = typeof options.text === 'string' ? options.text : '';
    if (text.trim()) content.push({ type: 'text', text });
    const images = Array.isArray(options.images) ? options.images : [];
    for (const image of images) {
      const source = isPlainObject(image) ? image : {};
      const data = nonEmptyString(source.data);
      const mediaType = nonEmptyString(source.mediaType) || nonEmptyString(source.media_type);
      if (!data || !mediaType) {
        return Promise.reject(sessionError('claude_prompt_image_invalid'));
      }
      content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
    }
    if (content.length === 0) return Promise.reject(sessionError('claude_prompt_empty'));

    const turn = {
      turnId: nonEmptyString(options.turnId) || null,
      settled: false,
      resolve: null,
      reject: null
    };
    const promise = new Promise((resolve, reject) => {
      turn.resolve = resolve;
      turn.reject = reject;
    });
    activeTurn = turn;

    const line = `${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`;
    try {
      child.stdin.write(line, (error) => {
        if (error) finishTurn(turn, 'reject', sessionError('claude_prompt_write_failed'));
      });
    } catch (_error) {
      finishTurn(turn, 'reject', sessionError('claude_prompt_write_failed'));
    }
    return promise;
  }

  function cancel(reason) {
    if (disposed) throw sessionError('claude_session_disposed');
    const message = `会话已中断(${nonEmptyString(reason) || 'cancelled'})，自动拒绝`;
    denyAllPending(message);
    // 同步 reject 在飞 turn：prompt 的 catch 会先于 cancel 的 await 恢复执行，
    // 那时外壳还是 running，transition('idle') 才合法（晚一步就会撞状态机）。
    const turn = activeTurn;
    if (turn) finishTurn(turn, 'reject', sessionError('claude_turn_cancelled'));
    killChild();
    return Promise.resolve({ cancelled: true });
  }

  function respond(interactionId, decision) {
    const id = nonEmptyString(interactionId);
    const entry = pending.get(id);
    if (!entry) throw sessionError('claude_interaction_unknown', { interactionId: id });
    settleEntry(entry, decisionToResponse(entry, decision));
    return { interactionId: id, kind: entry.kind };
  }

  // router 侧超时/收尾：桥上的长轮询必须有个结果，否则 claude 会一直等
  // （MCP 工具自己的 600s 超时是最后一道，但那是十分钟的空转）。
  function expire(interactionId, reason) {
    const id = nonEmptyString(interactionId);
    const entry = pending.get(id);
    if (!entry || entry.settled) return { interactionId: id, expired: false };
    settleEntry(entry, denyBody(nonEmptyString(reason) || '交互已过期，默认拒绝'));
    return { interactionId: id, expired: true };
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') {
      throw new AgentSessionError('agent_session_listener_invalid');
    }
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function onInteractionRequest(handler) {
    if (typeof handler !== 'function') {
      throw new AgentSessionError('agent_session_interaction_handler_invalid');
    }
    requestHandlers.add(handler);
    return () => requestHandlers.delete(handler);
  }

  function setMode(nextMode) {
    if (child) throw sessionError('claude_session_mode_locked');
    modeId = resolveModeId(nextMode);
    return { mode: modeId };
  }

  function setModel(nextModel) {
    if (child) throw sessionError('claude_session_model_locked');
    modelId = nonEmptyString(nextModel);
    return { model: modelId };
  }

  function dispose(reason) {
    if (disposed) return;
    disposed = true;
    denyAllPending(`会话已结束(${nonEmptyString(reason) || 'disposed'})，自动拒绝`);
    closeReader();
    closeBridge();
    dropLaunchContext();
    const turn = activeTurn;
    if (turn) finishTurn(turn, 'reject', sessionError('claude_session_disposed'));
    killChild();
    listeners.clear();
    requestHandlers.clear();
  }

  return {
    id: ADAPTER_ID,
    provider: nonEmptyString(config.provider) || 'claude',
    transport: nonEmptyString(config.transport) || ADAPTER_ID,
    open,
    prompt,
    cancel,
    respond,
    expire,
    subscribe,
    onInteractionRequest,
    dispose,
    setMode,
    setModel
  };
}

module.exports = {
  ADAPTER_ID,
  SESSION_MODES,
  createAdapter
};
