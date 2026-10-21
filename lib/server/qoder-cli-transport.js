'use strict';

// Qoder / Qoder CN 的 OpenAI chat 兼容推理 transport：Qoder 没有可直放的 HTTP API
// （凭证是 WASM 用 machineId 加密的本地 blob，请求还要过 Cosy/sgsdk 签名），唯一
// 正规通道是原生 CLI。本模块把 `qodercli(cn) --print --output-format stream-json`
// 的 headless 会话桥接成 OpenAI Chat Completions 语义：
//   - prompt 经 stdin 传入（整条对话记录扁平化，规避 Windows argv 32K 上限）；
//   - 认证完全交给 CLI（materializeProviderAuth + --config-dir <账号 runtimeDir>，
//     PAT 账号走 QODER_PERSONAL_ACCESS_TOKEN env 注入）；
//   - --tools "" 关闭 CLI 全部内置工具（2026-10-16 事故第二坑：模型对「生成一个页面」这类
//     请求会尝试 Write，撞 --max-turns 1 直接变成 qoder_cli_upstream_error）+ --max-turns 1：
//     模型只作答，工具面由 chat harness 层负责；
//   - stream-json 逐行解析成 OpenAI delta/usage；上游错误（如配额墙 error_code 118
//     的 pricingUrl）原样透出，不做掩盖。

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const nodePath = require('node:path');
const { PassThrough } = require('node:stream');

const { materializeProviderAuth } = require('../account/native-auth-projection');
const { resolveAccountRuntimeDir } = require('../runtime/aih-storage-layout');
const { normalizePathString } = require('../runtime/platform-path');
const { resolveProviderCliPath } = require('../cli/services/ai-cli/ensure-native-cli');
const { buildSharedCacheEnv } = require('../cli/services/ai-cli/launch-profile/home-redirect-strategy');
const { isQoderProvider } = require('../account/qoder-auth-metadata');
const { parseNativeStreamEvent } = require('./native-session-chat-stream');
const { createNativeRunWatchdog } = require('./native-run-watchdog');
const { createQoderCliWarmPool } = require('./qoder-cli-warm-pool');
const {
  mergeQoderUsageDetails,
  readQoderUsageDetails,
  resolveQoderUsage,
  toOpenAiUsage: toOpenAiUsageFields
} = require('../usage/qoder-usage');
const { readQoderModelCatalog, findQoderCatalogModel } = require('../account/qoder-model-catalog');
const { resolveQoderClientLayout } = require('../runtime/qoder-client-layouts');

const QODER_CLI_TRANSPORT_ID = 'qoder_cli_headless';
// CLI 冷启动（安全初始化 hook 实测 ~1.5s）+ 模型首包，短超时对 CLI 通道没有意义。
// 注意这是 **idle** 预算而不是墙钟：长回答只要持续有 delta 就不会被它杀。
const MIN_CLI_IDLE_TIMEOUT_MS = 120000;
// 单轮硬上限：防止 CLI 卡在「一直有字节、但永远不结束」的状态。
const DEFAULT_CLI_MAX_TURN_MS = 30 * 60 * 1000;
const STDERR_TAIL_MAX = 2000;

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function supportsQoderCliTransport(provider) {
  return isQoderProvider(provider);
}

function extractMessageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push(part.text);
    } else if (part.type === 'image_url' || part.type === 'input_image') {
      // CLI 通道暂无图像输入：显式占位，不让内容静默丢失。
      parts.push('[图片附件暂不支持经 Qoder CLI 通道发送]');
    } else if (part.type === 'input_text' && typeof part.text === 'string') {
      parts.push(part.text);
    }
  }
  return parts.filter(Boolean).join('\n');
}

const ROLE_LABELS = { system: 'System', developer: 'Developer', user: 'User', assistant: 'Assistant', tool: 'Tool' };

// 开头点名最后一条 User 消息时的截断上限：超长正文只截取开头，完整正文仍在记录末尾。
const LAST_USER_CALLOUT_MAX = 2000;

function clipLastUserCallout(text) {
  if (text.length <= LAST_USER_CALLOUT_MAX) return text;
  return `${text.slice(0, LAST_USER_CALLOUT_MAX)}\n……（本条消息较长，完整正文见下方【对话记录】末尾）`;
}

// OpenAI messages → 单条 transcript prompt（CLI 每次调用都是全新会话，上下文由调用方带全）。
// 真机事故（2026-10-16）：聊天模式首条消息经本通道时，上游模型（Qwen3.8-Flash @ qoder agent）
// 在「多个 User: 块 + 问题埋在末尾」的扁平记录上会把末尾带指令味的一条当成背景不再作答，
// 只回一句「已就绪，请给出任务」（驴头不对马嘴）。修法是把最后一条 User 消息在提示开头显式
// 点名、记录末尾再补一句锚定指令：实测点名后的 prompt 上游必答正文，不再只看到 setup 块。
// 同一事故的第二个坑：模型看到「生成一个页面」会想调 Write 工具 ⇒ 撞 --max-turns 1 直接报错，
// 因此 argv 关闭内置工具（--tools ""）、提示里另行声明不要输出工具调用语法、内容直接写正文。
function buildQoderCliPrompt(requestJson = {}) {
  const messages = Array.isArray(requestJson.messages) ? requestJson.messages : [];
  const lines = [];
  let lastUserText = '';
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = String(message.role || '').toLowerCase();
    const label = ROLE_LABELS[role] || 'User';
    const text = extractMessageText(message.content);
    if (!text) continue;
    lines.push(`${label}:\n${text}`);
    if (role === 'user') lastUserText = text;
  }
  const transcript = lines.join('\n\n');
  if (!transcript) return '';
  const callout = lastUserText
    ? `【最后一条 User 消息（需要你直接回复的内容）】\n${clipLastUserCallout(lastUserText)}\n\n【对话记录开始】\n`
    : '';
  const anchor = lastUserText ? '\n\n【对话记录结束】\n\n请作为 Assistant 直接回复【最后一条 User 消息】。' : '';
  const lead = '以下是完整的对话记录，请作为 Assistant 回复最后一条 User 消息。本环境没有文件/命令工具：请不要调用工具或输出工具调用语法；需要给出文件内容时，直接在回复正文中完整给出。';
  return `${lead}\n\n${callout}${transcript}${anchor}\n\nAssistant:`;
}

function isQoderQuotaFailure(parsed) {
  const errors = Array.isArray(parsed && parsed.errors) ? parsed.errors : [];
  return /pricingUrl|error_code.?118/i.test(JSON.stringify(errors))
    || /pricingUrl|error_code.?118/i.test(String((parsed && parsed.result) || ''));
}

function readResultErrorMessage(parsed) {
  const errors = Array.isArray(parsed && parsed.errors) ? parsed.errors : [];
  const first = normalizeString(errors[0]) || normalizeString(parsed && parsed.result) || 'qoder_cli_upstream_error';
  // 配额/套餐墙：上游 errors 里是 {"pricingUrl": "..."} JSON（error_code 118）。
  if (isQoderQuotaFailure(parsed)) {
    return 'qoder 账号套餐/额度不足，上游拒绝推理（error_code 118），请前往 qoder pricing 页升级或等待额度重置';
  }
  return first;
}

function readResultFailure(parsed) {
  return {
    message: readResultErrorMessage(parsed),
    code: isQoderQuotaFailure(parsed) ? 'qoder_cli_quota_exceeded' : 'qoder_cli_upstream_error'
  };
}

function buildChatCompletionPayload(result, requestedModel) {
  const payload = {
    id: `chatcmpl-qoder-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel || result.model || 'unknown',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: result.content || '' },
      finish_reason: 'stop'
    }],
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.sessionId ? { session_id: result.sessionId, sessionId: result.sessionId } : {})
  };
  // 不把估算标记写进 OpenAI 响应体（客户端不认识）；只用不可枚举属性把事实交给
  // 记账层，sourceKind 会带 `_estimated` 后缀，绝不伪装成上游实测值。
  if (result.usageEstimated) {
    Object.defineProperty(payload, 'usageEstimated', { value: true, enumerable: false });
  }
  // 上游 message.id：会话 JSONL 扫描器用 `<provider>:message:<id>` 作为幂等键，
  // 这里把同一个 id 交给记账层，两条通道（代理实时 + 会话扫描）写同一条记录，
  // 否则同一轮会被两个通道各记一次（2026-10-20 实测 qodercn 一轮翻倍）。
  if (result.messageId) {
    Object.defineProperty(payload, 'usageMessageId', { value: result.messageId, enumerable: false });
  }
  return payload;
}

function writeSseChunk(stream, payload) {
  stream.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// 共享核心：冷启动与 warm 复用同一条 stream-json 解析，usage / 失败判定只在这里
// 发生一次，避免两套代码对同一个 result 得出不同结论。
function createQoderTurnState() {
  return {
    content: '',
    thinkingContent: '',
    qoderUsageDetails: null,
    sessionId: '',
    resultUsageRaw: undefined,
    resultModel: '',
    // 上游 assistant message.id（JSONL 里同一条消息的 id）：用量记账的幂等键，
    // 与 lib/usage/model-usage-scanner.js 的 `<provider>:message:<id>` 对齐。
    messageId: '',
    failureMessage: '',
    failureCode: ''
  };
}

function captureQoderUsageDetails(state, usage) {
  const details = readQoderUsageDetails(usage);
  if (details) state.qoderUsageDetails = mergeQoderUsageDetails(state.qoderUsageDetails, details);
}

function handleQoderStreamLine(line, state, provider, onDelta, watchdog) {
  if (!line.trim()) return null;
  let parsed = null;
  try { parsed = JSON.parse(line); } catch (_error) { return null; }
  if (parsed && parsed.type === 'system' && parsed.subtype === 'init') {
    state.resultModel = normalizeString(parsed.model) || state.resultModel;
  }
  if (parsed && parsed.type === 'assistant' && parsed.message) {
    // 会话 JSONL 也会写这条 message（同 id）；捕获 id 让实时通道与扫描通道共用
    // 一个幂等键。synthetic 是 CLI 的错误占位消息，不是上游模型回复。
    if (normalizeString(parsed.message.model) !== '<synthetic>') {
      state.messageId = normalizeString(parsed.message.id) || state.messageId;
    }
    if (parsed.message.usage) captureQoderUsageDetails(state, parsed.message.usage);
  }
  if (parsed && parsed.type === 'stream_event') {
    const streamEvent = parsed.event && typeof parsed.event === 'object' ? parsed.event : null;
    if (streamEvent && streamEvent.message && streamEvent.message.usage) {
      captureQoderUsageDetails(state, streamEvent.message.usage);
    }
    if (streamEvent && streamEvent.usage) captureQoderUsageDetails(state, streamEvent.usage);
  }
  if (parsed && parsed.type === 'result') {
    state.resultUsageRaw = parsed.usage;
    captureQoderUsageDetails(state, parsed.usage);
    if (parsed.is_error) {
      const failure = readResultFailure(parsed);
      state.failureMessage = failure.message;
      state.failureCode = failure.code;
    }
  }
  // CLI 合成的错误占位消息（model 为 <synthetic>，如配额墙的 pricingUrl JSON）不是
  // 模型回复：不透出为 delta，仅留作失败兜底文案，由错误通道透出可读信息。
  if (parsed && parsed.type === 'assistant'
      && parsed.message && parsed.message.model === '<synthetic>') {
    const syntheticText = extractMessageText(parsed.message.content);
    if (syntheticText && !state.failureMessage) {
      const failure = readResultFailure({ errors: [syntheticText] });
      state.failureMessage = failure.message;
      state.failureCode = failure.code;
    }
    return parsed;
  }
  const events = parseNativeStreamEvent(provider, line, state);
  for (const event of Array.isArray(events) ? events : events ? [events] : []) {
    if (watchdog) watchdog.observe(event);
    if (event && event.type === 'delta' && event.delta && typeof onDelta === 'function') {
      onDelta(event.delta);
    }
    if (event && event.type === 'session-created' && event.sessionId) state.sessionId = event.sessionId;
    if (event && event.type === 'error' && event.message && !state.failureMessage) {
      state.failureMessage = event.message;
      state.failureCode = 'qoder_cli_upstream_error';
    }
  }
  return parsed;
}

function buildQoderTurnResult(state, prompt, contextWindowTokens) {
  const resolvedUsage = resolveQoderUsage({
    usage: state.resultUsageRaw,
    details: state.qoderUsageDetails,
    promptText: prompt,
    outputText: `${state.content}${state.thinkingContent}`,
    // CLI 的 `context_usage_ratio` 同样是相对**该模型**窗口的占比；
    // 传目录里的 max_input_tokens 才是正确基数（拿不到时沿用 200k 兜底）。
    contextWindowTokens
  });
  return {
    content: state.content,
    usage: toOpenAiUsageFields(resolvedUsage),
    usageEstimated: Boolean(resolvedUsage && resolvedUsage.estimated),
    usageEvidence: resolvedUsage ? {
      credits: resolvedUsage.credits,
      originalCredits: resolvedUsage.originalCredits,
      billable: resolvedUsage.billable,
      contextUsageRatio: resolvedUsage.contextUsageRatio,
      requestId: resolvedUsage.requestId
    } : null,
    sessionId: state.sessionId,
    model: state.resultModel,
    messageId: state.messageId
  };
}

// 账号校验 / 鉴权投影 / CLI 路径 / env / 参数只推导一次，冷启动与 warm 共用。
function buildQoderCliInvocation(options, account, requestJson, timeoutMs, deps = {}) {
  const provider = String(account && account.provider || '').trim().toLowerCase();
  if (!supportsQoderCliTransport(provider)) {
    const error = new Error('qoder_cli_transport_unsupported_provider');
    error.code = 'qoder_cli_transport_unsupported_provider';
    throw error;
  }
  const accountRef = normalizeString(account && account.accountRef);
  if (!accountRef) {
    const error = new Error('qoder_cli_transport_missing_account_ref');
    error.code = 'qoder_cli_transport_missing_account_ref';
    throw error;
  }
  const prompt = buildQoderCliPrompt(requestJson);
  if (!prompt) {
    const error = new Error('qoder_cli_prompt_required');
    error.code = 'qoder_cli_prompt_required';
    throw error;
  }

  const fs = deps.fs || nodeFs;
  const path = deps.path || nodePath;
  const os = deps.os || nodeOs;
  const aiHomeDir = normalizePathString(deps.aiHomeDir || (options && options.aiHomeDir))
    || path.join(os.homedir(), '.ai_home');
  const runtimeDir = resolveAccountRuntimeDir(aiHomeDir, provider, accountRef);
  const materialize = typeof deps.materializeProviderAuth === 'function'
    ? deps.materializeProviderAuth
    : materializeProviderAuth;
  const materialized = materialize(fs, runtimeDir, provider, { path, aiHomeDir, accountRef });
  if (materialized && materialized.missing) {
    const error = new Error('qoder_cli_auth_missing');
    error.code = 'qoder_cli_auth_missing';
    throw error;
  }

  const cliPath = normalizeString(
    (typeof deps.resolveProviderCliPath === 'function' ? deps.resolveProviderCliPath(provider) : resolveProviderCliPath(provider))
  );
  if (!cliPath) {
    const error = new Error('qoder_cli_not_installed');
    error.code = 'qoder_cli_not_installed';
    throw error;
  }

  const hostHomeDir = normalizePathString(deps.hostHomeDir || (options && options.hostHomeDir))
    || path.dirname(aiHomeDir);
  const env = {
    ...(deps.env || process.env),
    HOME: hostHomeDir,
    USERPROFILE: hostHomeDir,
    ...buildSharedCacheEnv(hostHomeDir, path),
  };
  // 不给 CLI 注入 server/账号代理：gateway.qoder.com.cn 实测直连可达，而经本地代理
  // （如 127.0.0.1:6152）转发会在 init 后无超时挂死（2026-09-14 实测）；用户的系统级
  // 代理配置仍随 process.env 自然继承，不由这里强加。
  if (account.apiKeyMode && account.accessToken) {
    env.QODER_PERSONAL_ACCESS_TOKEN = account.accessToken;
  } else {
    delete env.QODER_PERSONAL_ACCESS_TOKEN;
  }

  // --tools "" 关闭全部内置工具（见文件头注释第二坑）：模型只作答，绝不触发工具尝试。
  // --include-partial-messages 不在 1.1.73 的 --help 里，但实测接受并输出 stream_event
  // （content_block_delta / message_delta），这是「长回答不被误判静默」的前提。
  const args = [
    '--print', '--output-format', 'stream-json', '--include-partial-messages',
    '--max-turns', '1', '--tools', ''
  ];
  const model = normalizeString(requestJson && requestJson.model);
  if (model) args.push('--model', model);
  args.push('--config-dir', runtimeDir);

  // 用量估算的上下文窗口必须按**本次模型**取（目录里的 max_input_tokens）：
  // CLI 的 context_usage_ratio 是相对该模型窗口的占比，拿 200k 当所有模型的基数
  // 会把 180k / 96k / 1M 模型的 token 数算错。目录不可用时回退 0（
  // lib/usage/qoder-usage.js 内部仍有 200k 兜底），不阻断推理。
  const layout = resolveQoderClientLayout({ provider });
  const catalog = readQoderModelCatalog({
    fs,
    path,
    provider,
    version: layout && layout.cliVersion,
    runtimeDir,
    hostHomeDir,
    cliPath
  });
  const catalogEntry = findQoderCatalogModel(catalog, model);
  const contextWindowTokens = catalogEntry ? catalogEntry.maxInputTokens : 0;

  const spawnImpl = typeof deps.spawn === 'function' ? deps.spawn : childProcess.spawn;
  const overrideIdleMs = Number(deps.cliIdleTimeoutMs);
  const idleTimeoutMs = Number.isFinite(overrideIdleMs) && overrideIdleMs > 0
    ? Math.max(20, overrideIdleMs)
    : Math.max(MIN_CLI_IDLE_TIMEOUT_MS, Number(timeoutMs) || 0);
  const overrideMaxTurnMs = Number(deps.cliMaxTurnTimeoutMs);
  const maxTurnTimeoutMs = Number.isFinite(overrideMaxTurnMs) && overrideMaxTurnMs > 0
    ? Math.max(20, overrideMaxTurnMs)
    : DEFAULT_CLI_MAX_TURN_MS;

  return {
    provider,
    accountRef,
    runtimeDir,
    cliPath,
    env,
    cwd: hostHomeDir,
    model,
    contextWindowTokens,
    args,
    prompt,
    idleTimeoutMs,
    maxTurnTimeoutMs,
    spawnImpl
  };
}

async function runQoderCliTurn(options, account, requestJson, timeoutMs, deps = {}, onDelta) {
  const invocation = buildQoderCliInvocation(options, account, requestJson, timeoutMs, deps);
  return await new Promise((resolve, reject) => {
    const state = createQoderTurnState();
    let stderrTail = '';
    let settled = false;
    let child;
    let watchdog = null;
    let detachAbort = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (watchdog) watchdog.stop();
      if (detachAbort) detachAbort();
      fn(value);
    };
    const failWith = (message, code) => {
      const error = new Error(message);
      error.code = code || 'qoder_cli_turn_failed';
      finish(reject, error);
    };
    const killChild = () => {
      try { if (child && child.kill) child.kill(); } catch (_error) { /* best effort */ }
    };
    try {
      child = invocation.spawnImpl(invocation.cliPath, invocation.args, {
        env: invocation.env,
        cwd: invocation.cwd,
        windowsHide: true,
        shell: String(process.platform) === 'win32' && /\.(?:cmd|bat)$/i.test(invocation.cliPath),
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (spawnError) {
      reject(spawnError);
      return;
    }

    // 与原生会话共用同一个看门狗（native-run-watchdog）：
    //   * 第一次上游进展前 120s 静默 → no_first_progress；
    //   * 之后任意 120s 没有新 delta/thinking → stalled（持续输出的长回答不会被误杀）；
    //   * 单轮 30min 硬上限 → turn_limit。
    // Qoder CLI 不会吐重连行，所以 upstreamErrorTimeoutMs=0（关闭重试风暴分级）。
    watchdog = createNativeRunWatchdog({
      env: {},
      firstProgressTimeoutMs: invocation.idleTimeoutMs,
      stallTimeoutMs: invocation.idleTimeoutMs,
      upstreamErrorTimeoutMs: 0,
      maxTurnTimeoutMs: invocation.maxTurnTimeoutMs,
      killGraceMs: 0,
      onTimeout: (info) => {
        killChild();
        if (info.reason === 'turn_limit') {
          failWith(`qoder_cli_turn_limit_${info.limitMs}ms`, 'qoder_cli_turn_limit');
          return;
        }
        if (info.reason === 'stalled') {
          failWith(`qoder_cli_idle_${info.limitMs}ms`, 'qoder_cli_stalled');
          return;
        }
        failWith(`qoder_cli_no_output_${info.limitMs}ms`, 'qoder_cli_timeout');
      }
    });
    watchdog.start();
    const signal = deps.signal || (options && options.signal);
    if (signal && typeof signal.addEventListener === 'function') {
      if (signal.aborted) {
        killChild();
        failWith('qoder_cli_aborted', 'qoder_cli_aborted');
        return;
      }
      const onAbort = () => {
        killChild();
        failWith('qoder_cli_aborted', 'qoder_cli_aborted');
      };
      signal.addEventListener('abort', onAbort, { once: true });
      detachAbort = () => {
        if (typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', onAbort);
      };
    }

    let lineBuffer = '';
    child.stdout.on('data', (chunk) => {
      lineBuffer += chunk.toString('utf8');
      let index;
      while ((index = lineBuffer.indexOf('\n')) !== -1) {
        handleQoderStreamLine(lineBuffer.slice(0, index), state, invocation.provider, onDelta, watchdog);
        lineBuffer = lineBuffer.slice(index + 1);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_MAX);
    });
    child.on('error', (spawnError) => {
      failWith(`qoder_cli_spawn_failed:${spawnError.message}`, 'qoder_cli_spawn_failed');
    });
    child.on('close', (code) => {
      if (lineBuffer.trim()) {
        handleQoderStreamLine(lineBuffer, state, invocation.provider, onDelta, watchdog);
      }
      if (state.failureMessage) {
        failWith(state.failureMessage, state.failureCode || 'qoder_cli_upstream_error');
        return;
      }
      if (code !== 0 && !state.content) {
        failWith(`qoder_cli_exit_${code}:${stderrTail.trim().slice(-300) || 'no_stderr'}`, 'qoder_cli_exit_nonzero');
        return;
      }
      finish(resolve, buildQoderTurnResult(state, invocation.prompt, invocation.contextWindowTokens));
    });

    try {
      child.stdin.write(invocation.prompt);
      child.stdin.end();
    } catch (writeError) {
      killChild();
      failWith(`qoder_cli_stdin_failed:${writeError.message}`, 'qoder_cli_stdin_failed');
    }
  });
}

// ---- warm CLI 会话池 ---------------------------------------------------------
// 1.1.73 实测：`--print --input-format stream-json` 在 result 之后不退出，同进程
// 第二轮省掉 ~7.7s 的 init + 安全初始化（首轮 ~13.4s → 第二轮 ~3.3s）。
// 复用前提是「本次请求的消息前缀与进程内历史逐字一致」；任何不一致都重建，
// 绝不把别的会话上下文带进来。

function hashQoderConversation(messages) {
  const normalized = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;
    normalized.push([normalizeString(message.role) || 'user', extractMessageText(message.content)]);
  }
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function buildQoderWarmPlan(requestJson) {
  const messages = Array.isArray(requestJson && requestJson.messages) ? requestJson.messages : [];
  if (messages.length < 2) return null;
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'user') return null;
  if (Array.isArray(last.content)) {
    for (const part of last.content) {
      if (!part || typeof part !== 'object') return null;
      if (part.type !== 'text' && part.type !== 'input_text') return null;
    }
  } else if (typeof last.content !== 'string') {
    return null;
  }
  const lastText = extractMessageText(last.content).trim();
  if (!lastText) return null;
  return {
    lastText,
    prefixHash: hashQoderConversation(messages.slice(0, -1)),
    nextHistoryHash(assistantText) {
      return hashQoderConversation([...messages, { role: 'assistant', content: assistantText || '' }]);
    }
  };
}

let sharedQoderWarmPool = null;
function getQoderWarmPool(deps) {
  if (deps && deps.qoderWarmPool) return deps.qoderWarmPool;
  if (!sharedQoderWarmPool) {
    sharedQoderWarmPool = createQoderCliWarmPool({ spawn: childProcess.spawn });
    process.once('exit', () => {
      try { sharedQoderWarmPool.closeAll(); } catch (_error) { /* best effort */ }
    });
  }
  return sharedQoderWarmPool;
}

function shouldFallbackToColdAfterWarm(error) {
  if (!error || error.qoderWarmNoDelta !== true) return false;
  return normalizeString(error.code).startsWith('qoder_cli_warm_');
}

async function runQoderCliWarmTurn(options, account, requestJson, timeoutMs, deps = {}, onDelta) {
  const sessionKey = normalizeString(deps.sessionKey || (deps.requestMeta && deps.requestMeta.sessionKey));
  const plan = buildQoderWarmPlan(requestJson);
  if (!sessionKey || !plan) return null;
  const invocation = buildQoderCliInvocation(options, account, requestJson, timeoutMs, deps);
  const pool = getQoderWarmPool(deps);
  if (!pool) return null;
  const key = `${invocation.provider}\u0000${invocation.accountRef}\u0000${invocation.model}\u0000${sessionKey}`;
  const existing = pool.get(key);
  const canReuse = Boolean(existing && existing.state === 'idle' && existing.historyHash === plan.prefixHash);
  const entry = canReuse ? existing : pool.acquire(key, {
    cliPath: invocation.cliPath,
    args: [...invocation.args, '--input-format', 'stream-json'],
    env: invocation.env,
    cwd: invocation.cwd,
    // 与冷启动路径完全一致：Windows 的 npm .cmd 垫片必须经 shell 才能 spawn。
    shell: String(process.platform) === 'win32' && /\.(?:cmd|bat)$/i.test(invocation.cliPath),
    historyHash: plan.prefixHash
  });
  if (!entry) return null;
  const reused = canReuse && entry === existing;
  const state = createQoderTurnState();
  state.sessionId = entry.sessionId || '';
  let sawDelta = false;
  const watchdog = createNativeRunWatchdog({
    env: {},
    firstProgressTimeoutMs: invocation.idleTimeoutMs,
    stallTimeoutMs: invocation.idleTimeoutMs,
    upstreamErrorTimeoutMs: 0,
    maxTurnTimeoutMs: invocation.maxTurnTimeoutMs,
    killGraceMs: 0,
    onTimeout: (info) => {
      const code = info.reason === 'turn_limit'
        ? 'qoder_cli_turn_limit'
        : info.reason === 'stalled' ? 'qoder_cli_stalled' : 'qoder_cli_timeout';
      const message = info.reason === 'turn_limit'
        ? `qoder_cli_turn_limit_${info.limitMs}ms`
        : info.reason === 'stalled'
          ? `qoder_cli_idle_${info.limitMs}ms`
          : `qoder_cli_no_output_${info.limitMs}ms`;
      const error = new Error(message);
      error.code = code;
      pool.failTurn(entry, error);
    }
  });
  watchdog.start();
  const inputText = reused ? plan.lastText : invocation.prompt;
  const input = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: inputText }] }
  });
  try {
    await pool.sendTurn(entry, {
      input,
      signal: deps.signal || (options && options.signal),
      onLine: (_parsed, rawLine) => {
        handleQoderStreamLine(rawLine, state, invocation.provider, (delta) => {
          sawDelta = true;
          if (typeof onDelta === 'function') onDelta(delta);
        }, watchdog);
      }
    });
  } catch (error) {
    if (error && typeof error === 'object') error.qoderWarmNoDelta = !sawDelta;
    throw error;
  } finally {
    watchdog.stop();
  }
  if (state.failureMessage) {
    const error = new Error(state.failureMessage);
    error.code = state.failureCode || 'qoder_cli_upstream_error';
    error.qoderWarmNoDelta = !sawDelta;
    pool.discard(entry, error);
    throw error;
  }
  const result = buildQoderTurnResult(state, invocation.prompt, invocation.contextWindowTokens);
  entry.historyHash = plan.nextHistoryHash(result.content);
  entry.sessionId = entry.sessionId || state.sessionId;
  if (!result.sessionId) result.sessionId = entry.sessionId;
  result.warm = true;
  result.warmReused = reused;
  return result;
}

async function runQoderCliTurnAutomatic(options, account, requestJson, timeoutMs, deps = {}, onDelta) {
  const notifyTransport = (meta) => {
    if (typeof deps.onQoderCliTransport === 'function') {
      try { deps.onQoderCliTransport(meta); } catch (_error) { /* best effort */ }
    }
  };
  if (deps.enableQoderWarmCli !== false) {
    try {
      const warm = await runQoderCliWarmTurn(options, account, requestJson, timeoutMs, deps, onDelta);
      if (warm) {
        notifyTransport({ warm: true, reused: Boolean(warm.warmReused) });
        return warm;
      }
    } catch (error) {
      if (!shouldFallbackToColdAfterWarm(error)) throw error;
    }
  }
  notifyTransport({ warm: false, reused: false });
  return runQoderCliTurn(options, account, requestJson, timeoutMs, deps, onDelta);
}

async function fetchQoderCliChatCompletion(options, account, requestJson = {}, timeoutMs = 8000, deps = {}) {
  const result = await runQoderCliTurnAutomatic(options, account, requestJson, timeoutMs, deps);
  return buildChatCompletionPayload(result, String(requestJson && requestJson.model || '').trim());
}

// 返回 OpenAI Chat Completions SSE 形态的可读流（与 upstream-stream-forwarder 的
// pipeReadableBodyToResponse 契约一致），CLI delta 实时翻译为 chat.completion.chunk。
async function fetchQoderCliChatCompletionStream(options, account, requestJson = {}, timeoutMs = 8000, deps = {}) {
  const requestedModel = String(requestJson && requestJson.model || '').trim() || 'unknown';
  const body = new PassThrough();
  const upstreamRes = { ok: true, status: 200, body };
  const id = `chatcmpl-qoder-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  let roleSent = false;
  const sendChunk = (delta, finishReason = null, extra = {}) => {
    writeSseChunk(body, {
      id,
      object: 'chat.completion.chunk',
      created,
      model: requestedModel,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...extra
    });
  };

  const run = runQoderCliTurnAutomatic(options, account, requestJson, timeoutMs, deps, (delta) => {
    if (!roleSent) {
      roleSent = true;
      sendChunk({ role: 'assistant' });
    }
    sendChunk({ content: delta });
  }).then((result) => {
    if (result && result.usageEstimated) {
      body.usageEstimated = true;
      upstreamRes.usageEstimated = true;
    }
    if (result && result.messageId) {
      body.usageMessageId = result.messageId;
      upstreamRes.usageMessageId = result.messageId;
    }
    if (!roleSent) sendChunk({ role: 'assistant' });
    sendChunk({}, 'stop', result.usage ? { usage: result.usage } : {});
    body.write('data: [DONE]\n\n');
    body.end();
  }).catch((error) => {
    body.destroy(error);
  });
  // 防未处理 rejection：错误已通过 body.destroy 传给消费方。
  run.catch(() => {});
  // 消费端断开时杀掉 CLI 子进程：runQoderCliTurn 内部随 reject 清理，这里只需毁流。
  return upstreamRes;
}

module.exports = {
  QODER_CLI_TRANSPORT_ID,
  supportsQoderCliTransport,
  buildQoderCliPrompt,
  fetchQoderCliChatCompletion,
  fetchQoderCliChatCompletionStream,
  __private: {
    buildChatCompletionPayload,
    buildQoderCliInvocation,
    extractMessageText,
    readResultErrorMessage,
    readResultFailure,
    runQoderCliTurn,
    runQoderCliTurnAutomatic,
    runQoderCliWarmTurn,
    buildQoderWarmPlan,
    hashQoderConversation,
    toOpenAiUsage: toOpenAiUsageFields
  }
};
