'use strict';

// Qoder / Qoder CN 的 OpenAI chat 兼容推理 transport：Qoder 没有可直放的 HTTP API
// （凭证是 WASM 用 machineId 加密的本地 blob，请求还要过 Cosy/sgsdk 签名），唯一
// 正规通道是原生 CLI。本模块把 `qodercli(cn) --print --output-format stream-json`
// 的 headless 会话桥接成 OpenAI Chat Completions 语义：
//   - prompt 经 stdin 传入（整条对话记录扁平化，规避 Windows argv 32K 上限）；
//   - 认证完全交给 CLI（materializeProviderAuth + --config-dir <账号 runtimeDir>，
//     PAT 账号走 QODER_PERSONAL_ACCESS_TOKEN env 注入）；
//   - headless 默认权限模式下需确认的操作自动拒绝 + --max-turns 1：模型只作答，
//     工具面由 chat harness 层负责；
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

const QODER_CLI_TRANSPORT_ID = 'qoder_cli_headless';
// CLI 冷启动（安全初始化 hook 实测 ~1.5s）+ 模型首包，短超时对 CLI 通道没有意义。
const MIN_CLI_TIMEOUT_MS = 120000;
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

// OpenAI messages → 单条 transcript prompt（CLI 每次调用都是全新会话，上下文由调用方带全）。
function buildQoderCliPrompt(requestJson = {}) {
  const messages = Array.isArray(requestJson.messages) ? requestJson.messages : [];
  const lines = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const label = ROLE_LABELS[String(message.role || '').toLowerCase()] || 'User';
    const text = extractMessageText(message.content);
    if (text) lines.push(`${label}:\n${text}`);
  }
  const transcript = lines.join('\n\n');
  return transcript
    ? `以下是完整的对话记录，请作为 Assistant 回复最后一条 User 消息：\n\n${transcript}\n\nAssistant:`
    : '';
}

function readResultErrorMessage(parsed) {
  const errors = Array.isArray(parsed && parsed.errors) ? parsed.errors : [];
  const first = normalizeString(errors[0]) || normalizeString(parsed && parsed.result) || 'qoder_cli_upstream_error';
  // 配额/套餐墙：上游 errors 里是 {"pricingUrl": "..."} JSON（error_code 118）。
  if (/pricingUrl|error_code.?118/i.test(first) || /pricingUrl/i.test(JSON.stringify(parsed && parsed.errors || ''))) {
    return 'qoder 账号套餐/额度不足，上游拒绝推理（error_code 118），请前往 qoder  pricing 页升级或等待额度重置';
  }
  return first;
}

function toOpenAiUsage(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  const prompt = Number(usage.input_tokens) || 0;
  const completion = Number(usage.output_tokens) || 0;
  if (!prompt && !completion) return undefined;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
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
    AIH_QODER_PROVIDER: provider
  };
  const proxyUrl = normalizeString((options && options.proxyUrl) || deps.proxyUrl);
  if (proxyUrl) {
    env.HTTP_PROXY = proxyUrl;
    env.HTTPS_PROXY = proxyUrl;
    env.http_proxy = proxyUrl;
    env.https_proxy = proxyUrl;
  }
  if (account.apiKeyMode && account.accessToken) {
    env.QODER_PERSONAL_ACCESS_TOKEN = account.accessToken;
  } else {
    delete env.QODER_PERSONAL_ACCESS_TOKEN;
  }

  const args = ['--print', '--output-format', 'stream-json', '--max-turns', '1'];
  const model = normalizeString(requestJson && requestJson.model);
  if (model) args.push('--model', model);
  args.push('--config-dir', runtimeDir);

  const spawnImpl = typeof deps.spawn === 'function' ? deps.spawn : childProcess.spawn;
  const effectiveTimeoutMs = Math.max(MIN_CLI_TIMEOUT_MS, Number(timeoutMs) || 0);

  return await new Promise((resolve, reject) => {
    const state = { content: '' };
    let sessionId = '';
    let resultUsage;
    let resultModel = '';
    let failureMessage = '';
    let stderrTail = '';
    let settled = false;
    let child;
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
      clearTimeout(timer);
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
    const timer = setTimeout(() => {
      killChild();
      failWith(`qoder_cli_timeout_${effectiveTimeoutMs}ms`, 'qoder_cli_timeout');
    }, effectiveTimeoutMs);
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
      if (parsed && parsed.type === 'result') {
        resultUsage = toOpenAiUsage(parsed.usage);
        if (parsed.is_error) failureMessage = readResultErrorMessage(parsed);
      }
      const events = parseNativeStreamEvent(provider, line, state);
      for (const event of Array.isArray(events) ? events : events ? [events] : []) {
        if (event && event.type === 'delta' && event.delta && typeof onDelta === 'function') {
          onDelta(event.delta);
        }
        if (event && event.type === 'session-created' && event.sessionId) sessionId = event.sessionId;
        if (event && event.type === 'error' && event.message && !failureMessage) failureMessage = event.message;
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
        failWith(failureMessage, 'qoder_cli_upstream_error');
        return;
      }
      if (code !== 0 && !state.content) {
        failWith(`qoder_cli_exit_${code}:${stderrTail.trim().slice(-300) || 'no_stderr'}`, 'qoder_cli_exit_nonzero');
        return;
      }
      finish(resolve, {
        content: state.content,
        usage: resultUsage,
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
    runQoderCliTurn,
    toOpenAiUsage
  }
};
