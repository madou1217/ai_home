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
const {
  mergeQoderUsageDetails,
  readQoderUsageDetails,
  resolveQoderUsage,
  toOpenAiUsage: toOpenAiUsageFields
} = require('../usage/qoder-usage');

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
  return {
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
}

function writeSseChunk(stream, payload) {
  stream.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// 共享核心：spawn CLI、喂 stdin、逐行解析 stream-json。onDelta 实收文本增量；
// 返回 { content, usage, sessionId, model } 或抛带 code 的 Error。
async function runQoderCliTurn(options, account, requestJson, timeoutMs, deps = {}, onDelta) {
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

  const spawnImpl = typeof deps.spawn === 'function' ? deps.spawn : childProcess.spawn;
  const overrideIdleMs = Number(deps.cliIdleTimeoutMs);
  const idleTimeoutMs = Number.isFinite(overrideIdleMs) && overrideIdleMs > 0
    ? Math.max(20, overrideIdleMs)
    : Math.max(MIN_CLI_IDLE_TIMEOUT_MS, Number(timeoutMs) || 0);
  const overrideMaxTurnMs = Number(deps.cliMaxTurnTimeoutMs);
  const maxTurnTimeoutMs = Number.isFinite(overrideMaxTurnMs) && overrideMaxTurnMs > 0
    ? Math.max(20, overrideMaxTurnMs)
    : DEFAULT_CLI_MAX_TURN_MS;

  return await new Promise((resolve, reject) => {
    const state = { content: '', thinkingContent: '', qoderUsageDetails: null };
    let sessionId = '';
    let resultUsageRaw;
    let resultModel = '';
    let failureMessage = '';
    let failureCode = '';
    let stderrTail = '';
    let settled = false;
    let child;
    let watchdog = null;
    try {
      child = spawnImpl(cliPath, args, {
        env,
        cwd: hostHomeDir,
        windowsHide: true,
        shell: String(process.platform) === 'win32' && /\.(?:cmd|bat)$/i.test(cliPath),
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (spawnError) {
      reject(spawnError);
      return;
    }

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (watchdog) watchdog.stop();
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
    // 与原生会话共用同一个看门狗（native-run-watchdog）：
    //   * 第一次上游进展前 120s 静默 → no_first_progress；
    //   * 之后任意 120s 没有新 delta/thinking → stalled（持续输出的长回答不会被误杀）；
    //   * 单轮 30min 硬上限 → turn_limit。
    // Qoder CLI 不会吐重连行，所以 upstreamErrorTimeoutMs=0（关闭重试风暴分级）。
    watchdog = createNativeRunWatchdog({
      env: {},
      firstProgressTimeoutMs: idleTimeoutMs,
      stallTimeoutMs: idleTimeoutMs,
      upstreamErrorTimeoutMs: 0,
      maxTurnTimeoutMs,
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
    const captureUsageDetails = (usage) => {
      const details = readQoderUsageDetails(usage);
      if (details) state.qoderUsageDetails = mergeQoderUsageDetails(state.qoderUsageDetails, details);
    };
    const signal = deps.signal || (options && options.signal);
    if (signal && typeof signal.addEventListener === 'function') {
      if (signal.aborted) {
        killChild();
        failWith('qoder_cli_aborted', 'qoder_cli_aborted');
        return;
      }
      signal.addEventListener('abort', () => {
        killChild();
        failWith('qoder_cli_aborted', 'qoder_cli_aborted');
      }, { once: true });
    }

    let lineBuffer = '';
    const handleLine = (line) => {
      if (!line.trim()) return;
      let parsed = null;
      try { parsed = JSON.parse(line); } catch (_error) { return; }
      if (parsed && parsed.type === 'system' && parsed.subtype === 'init') {
        resultModel = normalizeString(parsed.model) || resultModel;
      }
      if (parsed && parsed.type === 'assistant' && parsed.message && parsed.message.usage) {
        captureUsageDetails(parsed.message.usage);
      }
      if (parsed && parsed.type === 'stream_event') {
        const streamEvent = parsed.event && typeof parsed.event === 'object' ? parsed.event : null;
        if (streamEvent && streamEvent.message && streamEvent.message.usage) {
          captureUsageDetails(streamEvent.message.usage);
        }
        if (streamEvent && streamEvent.usage) captureUsageDetails(streamEvent.usage);
      }
      if (parsed && parsed.type === 'result') {
        resultUsageRaw = parsed.usage;
        captureUsageDetails(parsed.usage);
        if (parsed.is_error) {
          const failure = readResultFailure(parsed);
          failureMessage = failure.message;
          failureCode = failure.code;
        }
      }
      // CLI 合成的错误占位消息（model 为 <synthetic>，如配额墙的 pricingUrl JSON）不是
      // 模型回复：不透出为 delta，仅留作失败兜底文案，由错误通道透出可读信息。
      if (parsed && parsed.type === 'assistant'
          && parsed.message && parsed.message.model === '<synthetic>') {
        const syntheticText = extractMessageText(parsed.message.content);
        if (syntheticText && !failureMessage) {
          const failure = readResultFailure({ errors: [syntheticText] });
          failureMessage = failure.message;
          failureCode = failure.code;
        }
        return;
      }
      const events = parseNativeStreamEvent(provider, line, state);
      for (const event of Array.isArray(events) ? events : events ? [events] : []) {
        if (watchdog) watchdog.observe(event);
        if (event && event.type === 'delta' && event.delta && typeof onDelta === 'function') {
          onDelta(event.delta);
        }
        if (event && event.type === 'session-created' && event.sessionId) sessionId = event.sessionId;
        if (event && event.type === 'error' && event.message && !failureMessage) {
          failureMessage = event.message;
          failureCode = 'qoder_cli_upstream_error';
        }
      }
    };
    child.stdout.on('data', (chunk) => {
      lineBuffer += chunk.toString('utf8');
      let index;
      while ((index = lineBuffer.indexOf('\n')) !== -1) {
        handleLine(lineBuffer.slice(0, index));
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
      if (lineBuffer.trim()) handleLine(lineBuffer);
      if (failureMessage) {
        failWith(failureMessage, failureCode || 'qoder_cli_upstream_error');
        return;
      }
      if (code !== 0 && !state.content) {
        failWith(`qoder_cli_exit_${code}:${stderrTail.trim().slice(-300) || 'no_stderr'}`, 'qoder_cli_exit_nonzero');
        return;
      }
      const resolvedUsage = resolveQoderUsage({
        usage: resultUsageRaw,
        details: state.qoderUsageDetails,
        promptText: prompt,
        outputText: `${state.content}${state.thinkingContent}`
      });
      finish(resolve, {
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
        sessionId,
        model: resultModel
      });
    });

    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (writeError) {
      killChild();
      failWith(`qoder_cli_stdin_failed:${writeError.message}`, 'qoder_cli_stdin_failed');
    }
  });
}

async function fetchQoderCliChatCompletion(options, account, requestJson = {}, timeoutMs = 8000, deps = {}) {
  const result = await runQoderCliTurn(options, account, requestJson, timeoutMs, deps);
  return buildChatCompletionPayload(result, String(requestJson && requestJson.model || '').trim());
}

// 返回 OpenAI Chat Completions SSE 形态的可读流（与 upstream-stream-forwarder 的
// pipeReadableBodyToResponse 契约一致），CLI delta 实时翻译为 chat.completion.chunk。
async function fetchQoderCliChatCompletionStream(options, account, requestJson = {}, timeoutMs = 8000, deps = {}) {
  const requestedModel = String(requestJson && requestJson.model || '').trim() || 'unknown';
  const body = new PassThrough();
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

  const run = runQoderCliTurn(options, account, requestJson, timeoutMs, deps, (delta) => {
    if (!roleSent) {
      roleSent = true;
      sendChunk({ role: 'assistant' });
    }
    sendChunk({ content: delta });
  }).then((result) => {
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
  return { ok: true, status: 200, body };
}

module.exports = {
  QODER_CLI_TRANSPORT_ID,
  supportsQoderCliTransport,
  buildQoderCliPrompt,
  fetchQoderCliChatCompletion,
  fetchQoderCliChatCompletionStream,
  __private: {
    buildChatCompletionPayload,
    extractMessageText,
    readResultErrorMessage,
    readResultFailure,
    runQoderCliTurn,
    toOpenAiUsage: toOpenAiUsageFields
  }
};
