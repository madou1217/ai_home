'use strict';

// OpenCode 免费模型（`-free`）的 OpenAI chat 兼容推理 transport。
//
// 为什么不能走 HTTP（2026-10-15 本机实测，排障必读）：
// Zen 免费档现在是**客户端门禁**。从 curl / node(undici) / Bun fetch 直打
// `POST https://opencode.ai/zen/v1/chat/completions`（或 `/zen/v1/responses`），
// 无论匿名、伪造 key、**账号真 key**，甚至逐字节复刻 opencode CLI 的请求头 + UA
// （`opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14`、
// `x-opencode-client/project/request/session/session-id`、HTTP/1.1、带 tools 数组），
// 一律 403 `FreeTierError: OpenCode's free tier can only be used from within OpenCode`。
// 只有真实 `opencode` 二进制能过（实测 200 + 正常回复，带账号 key 时必须）。所以
// `opencode-server-client.js` 那条 HTTP 通道拿不到免费模型，免费模型改由本模块桥接。
//
// 另有一条实测到的**请求形状**约束：把 CLI 的工具全部关掉（tools 全 false）后，连 CLI
// 自己也会吃 403 FreeTierError；保留任意只读工具（read/glob/grep/list/todowrite）即恢复
// 200。因此这里只关闭有副作用的工具（见 RELAY_DISABLED_TOOLS），不整体清空工具面。
//
// 桥接方式与 qoder-cli-transport 同构：
//   - prompt 经 stdin 传入（整条对话扁平化成 transcript，规避 Windows argv 上限）；
//   - 认证与隔离交给账号投影：materializeProviderAuth 把账号 auth.json 写到
//     `<projection>/.local/share/opencode/auth.json`，这里把 HOME/XDG_* 指向该投影，
//     CLI 因此以该账号身份运行，且不污染宿主 opencode 数据/会话库；
//   - `opencode run --format json` 的 JSONL 事件流翻译成 OpenAI Chat Completions
//     语义（缓冲聚合 + SSE delta），上游错误原样透出，不做掩盖。

const childProcess = require('node:child_process');
const nodeFs = require('node:fs');
const nodeOs = require('node:os');
const nodePath = require('node:path');
const { PassThrough } = require('node:stream');

const { materializeProviderAuth } = require('../account/native-auth-projection');
const { resolveAccountRuntimeDir, resolveAihRunPath } = require('../runtime/aih-storage-layout');
const { normalizePathString } = require('../runtime/platform-path');
const { resolveProviderCliPath } = require('../cli/services/ai-cli/ensure-native-cli');
const { buildSharedCacheEnv } = require('../cli/services/ai-cli/launch-profile/home-redirect-strategy');
const { OPENCODE_UNSET_ENV } = require('../cli/services/ai-cli/launch-profile/opencode-strategy');
const { computeDelta } = require('./native-session-chat-stream');
const {
  buildOpenCodePrompt,
  __private: { stripOpenCodeGoModelPrefix }
} = require('./opencode-server-client');

const OPENCODE_FREE_CLI_TRANSPORT_ID = 'opencode_free_cli_headless';
// CLI 冷启动（含插件/目录初始化）+ 免费模型首包，短超时对 CLI 通道没有意义。
const MIN_CLI_TIMEOUT_MS = 120000;
const STDERR_TAIL_MAX = 2000;
// 免费档门禁要求请求里必须带工具（全关会被 403），所以只关有副作用的那些：
// bash/edit/write/patch 会改机器，webfetch/websearch 会出网，task 会拉子代理。
// 保留 read/glob/grep/list/skill/todowrite —— 只读、在隔离 workspace 内。
const RELAY_DISABLED_TOOLS = Object.freeze({
  bash: false,
  edit: false,
  write: false,
  patch: false,
  webfetch: false,
  websearch: false,
  task: false
});
// CLI 目录（models.dev 投影）落后于 Zen /models 时，新免费模型不在 CLI 目录里，
// 直接 `--model` 会 ProviderModelNotFoundError。这里用配置声明补一条最小定义，
// 让「Zen 已上线但 CLI 目录还没跟上」的免费模型也能用（deepseek-v4.1-flash-free 实测）。
const RELAY_MODEL_LIMIT = Object.freeze({ context: 200000, output: 32768 });

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 裸模型名（去掉 opencode-go/ opencode/ zen/ go/ 前缀）。 */
function bareOpenCodeModelId(model) {
  return normalizeString(stripOpenCodeGoModelPrefix(normalizeString(model)));
}

/** 免费模型判定：裸模型名以 `-free` 结尾（Zen/Go 两套目录同规则）。 */
function isOpenCodeFreeModelId(model) {
  const bare = bareOpenCodeModelId(model);
  return bare.length > 0 && bare.toLowerCase().endsWith('-free');
}

function supportsOpenCodeFreeCliTransport(provider, model) {
  return normalizeString(provider).toLowerCase() === 'opencode' && isOpenCodeFreeModelId(model);
}


/**
 * 生成给 CLI 的 OPENCODE_CONFIG_CONTENT：声明模型 + 关闭有副作用的工具。
 * 调用方已有的 OPENCODE_CONFIG_CONTENT 会被合并保留（不能整体覆盖）。
 */
function buildRelayConfigContent(bareModelId, existingContent = '') {
  const id = normalizeString(bareModelId);
  let base = {};
  const existing = normalizeString(existingContent);
  if (existing) {
    try {
      const parsed = JSON.parse(existing);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) base = parsed;
    } catch (_error) {
      base = {};
    }
  }
  const providers = base.provider && typeof base.provider === 'object' && !Array.isArray(base.provider)
    ? base.provider
    : {};
  const opencodeProvider = providers.opencode && typeof providers.opencode === 'object' && !Array.isArray(providers.opencode)
    ? providers.opencode
    : {};
  const models = opencodeProvider.models && typeof opencodeProvider.models === 'object' && !Array.isArray(opencodeProvider.models)
    ? opencodeProvider.models
    : {};
  const tools = base.tools && typeof base.tools === 'object' && !Array.isArray(base.tools) ? base.tools : {};
  const next = {
    ...base,
    ...(id
      ? {
          provider: {
            ...providers,
            opencode: {
              ...opencodeProvider,
              models: {
                ...models,
                [id]: {
                  id,
                  name: id,
                  attachment: false,
                  reasoning: false,
                  tool_call: true,
                  temperature: true,
                  limit: { ...RELAY_MODEL_LIMIT }
                }
              }
            }
          }
        }
      : {}),
    tools: { ...tools, ...RELAY_DISABLED_TOOLS }
  };
  return JSON.stringify(next);
}

/** OpenAI messages → 单条 transcript（CLI 每次调用都是全新会话，上下文由调用方带全）。 */
function buildOpenCodeCliPrompt(requestJson = {}) {
  const { system, text } = buildOpenCodePrompt(requestJson || {});
  const parts = [];
  if (system) parts.push(system);
  if (text) parts.push(text);
  const transcript = parts.join('\n\n').trim();
  return transcript
    ? `以下是完整的对话记录，请作为 Assistant 回复最后一条 User 消息：\n\n${transcript}\n\nAssistant:`
    : '';
}

/** CLI 的 error 事件形状不固定：error.data.message / error.message / message / error 字符串都要兜住。 */
function extractCliErrorMessage(parsed) {
  const error = parsed && parsed.error;
  if (typeof error === 'string') return normalizeString(error);
  if (error && typeof error === 'object') {
    const data = error.data && typeof error.data === 'object' ? error.data : null;
    const message = normalizeString(data && data.message)
      || normalizeString(error.message)
      || normalizeString(error.name);
    if (message) return message;
  }
  return normalizeString(parsed && parsed.message);
}

/** step_finish.part.tokens → OpenAI usage（cache 读写都算进 prompt）。 */
function toOpenAiUsage(tokens) {
  if (!tokens || typeof tokens !== 'object') return undefined;
  const cache = tokens.cache && typeof tokens.cache === 'object' ? tokens.cache : {};
  const prompt = (Number(tokens.input) || 0) + (Number(cache.read) || 0) + (Number(cache.write) || 0);
  const completion = (Number(tokens.output) || 0) + (Number(tokens.reasoning) || 0);
  const total = Number(tokens.total) || (prompt + completion);
  if (!prompt && !completion && !total) return undefined;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

function mapFinishReason(reason) {
  const value = normalizeString(reason).toLowerCase();
  if (value === 'length' || value === 'max_tokens') return 'length';
  if (value === 'tool-calls' || value === 'tool_calls') return 'tool_calls';
  if (value === 'content-filter') return 'content_filter';
  return 'stop';
}

/** 每次 relay 的隔离 workspace（`--dir` 必须存在；工具副作用只落在这里）。 */
function ensureRelayWorkspaceDir(fs, aiHomeDir, accountRef, path) {
  const dir = resolveAihRunPath(aiHomeDir, 'opencode-free-relay', normalizeString(accountRef))
    || path.join(aiHomeDir, 'run', 'opencode-free-relay', normalizeString(accountRef));
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_error) {
    return '';
  }
  return dir;
}

/**
 * CLI 子进程 env：HOME/XDG_* 指向账号投影（账号身份只认投影里的原生 auth.json），
 * 宿主污染变量先剥离再放回我们自己的 OPENCODE_CONFIG_CONTENT，缓存目录与宿主共享。
 * 代理只接受 http(s)（Bun 对 socks5 直接 UnsupportedProxyProtocol）。
 */
function buildRelayEnv(options, deps, sandboxDir, hostHomeDir, path, configContent) {
  const env = { ...(deps.env || process.env) };
  OPENCODE_UNSET_ENV.forEach((key) => { delete env[key]; });
  env.HOME = sandboxDir;
  env.USERPROFILE = sandboxDir;
  env.XDG_CONFIG_HOME = path.join(sandboxDir, '.config');
  env.XDG_DATA_HOME = path.join(sandboxDir, '.local', 'share');
  env.XDG_STATE_HOME = path.join(sandboxDir, '.local', 'state');
  Object.assign(env, buildSharedCacheEnv(hostHomeDir, path));
  env.OPENCODE_CONFIG_CONTENT = configContent;
  const proxyUrl = normalizeString(options && options.proxyUrl);
  if (proxyUrl) {
    if (!/^https?:\/\//i.test(proxyUrl)) {
      const error = new Error(`opencode_free_cli_proxy_unsupported:${proxyUrl}`);
      error.code = 'opencode_free_cli_proxy_unsupported';
      throw error;
    }
    env.HTTPS_PROXY = proxyUrl;
    env.HTTP_PROXY = proxyUrl;
    env.https_proxy = proxyUrl;
    env.http_proxy = proxyUrl;
  }
  const noProxy = normalizeString(options && options.noProxy);
  if (noProxy) env.NO_PROXY = noProxy;
  return env;
}

// 共享核心：spawn `opencode run --format json`、喂 stdin、逐行解析 JSONL。
// onDelta 实收文本增量；返回 { content, usage, sessionId, model, finishReason } 或抛带 code 的 Error。
// 文本 part 语义与 native-session-chat-stream 的 opencode 分支一致（part.text 视作快照，
// 对全局 content 求增量），WebUI native 路径与本通道因此对同一份 CLI 输出给出同样结果。
async function runOpenCodeFreeCliTurn(options, account, requestJson, timeoutMs, deps = {}, onDelta) {
  const provider = normalizeString(account && account.provider).toLowerCase() || 'opencode';
  const requestedModel = normalizeString(requestJson && requestJson.model);
  if (!supportsOpenCodeFreeCliTransport(provider, requestedModel)) {
    const error = new Error('opencode_free_cli_unsupported_model');
    error.code = 'opencode_free_cli_unsupported_model';
    throw error;
  }
  const accountRef = normalizeString(account && account.accountRef);
  if (!accountRef) {
    const error = new Error('opencode_free_cli_missing_account_ref');
    error.code = 'opencode_free_cli_missing_account_ref';
    throw error;
  }
  const prompt = buildOpenCodeCliPrompt(requestJson);
  if (!prompt) {
    const error = new Error('opencode_free_cli_prompt_required');
    error.code = 'opencode_free_cli_prompt_required';
    throw error;
  }

  const fs = deps.fs || nodeFs;
  const path = deps.path || nodePath;
  const os = deps.os || nodeOs;
  const aiHomeDir = normalizePathString(deps.aiHomeDir || (options && options.aiHomeDir))
    || path.join(os.homedir(), '.ai_home');
  const runtimeDir = resolveAccountRuntimeDir(aiHomeDir, 'opencode', accountRef);
  const materialize = typeof deps.materializeProviderAuth === 'function'
    ? deps.materializeProviderAuth
    : materializeProviderAuth;
  const materialized = materialize(fs, runtimeDir, 'opencode', { path, aiHomeDir, accountRef });
  if (materialized && materialized.missing) {
    const error = new Error('opencode_free_cli_auth_missing');
    error.code = 'opencode_free_cli_auth_missing';
    throw error;
  }

  const cliPath = normalizeString(
    typeof deps.resolveProviderCliPath === 'function'
      ? deps.resolveProviderCliPath('opencode')
      : resolveProviderCliPath('opencode')
  );
  if (!cliPath) {
    const error = new Error('opencode_free_cli_not_installed');
    error.code = 'opencode_free_cli_not_installed';
    throw error;
  }

  const hostHomeDir = normalizePathString(deps.hostHomeDir || (options && options.hostHomeDir))
    || path.dirname(aiHomeDir);
  const workspaceDir = ensureRelayWorkspaceDir(fs, aiHomeDir, accountRef, path) || runtimeDir;
  if (!workspaceDir) {
    const error = new Error('opencode_free_cli_workspace_unavailable');
    error.code = 'opencode_free_cli_workspace_unavailable';
    throw error;
  }
  const bareModel = bareOpenCodeModelId(requestedModel);
  const env = buildRelayEnv(options, deps, runtimeDir, hostHomeDir, path,
    buildRelayConfigContent(bareModel, (deps.env || process.env).OPENCODE_CONFIG_CONTENT));
  const args = [
    'run', '--format', 'json', '--dangerously-skip-permissions',
    '--model', `opencode/${bareModel}`,
    '--dir', workspaceDir
  ];
  const spawnImpl = typeof deps.spawn === 'function' ? deps.spawn : childProcess.spawn;
  const effectiveTimeoutMs = Math.max(MIN_CLI_TIMEOUT_MS, Number(timeoutMs) || 0);

  return await new Promise((resolve, reject) => {
    const state = { content: '' };
    let sessionId = '';
    let finishReason = 'stop';
    let usage;
    let failureMessage = '';
    let stderrTail = '';
    let settled = false;
    let child;
    try {
      child = spawnImpl(cliPath, args, {
        env,
        cwd: workspaceDir,
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
      error.code = code || 'opencode_free_cli_turn_failed';
      finish(reject, error);
    };
    const killChild = () => {
      try { if (child && child.kill) child.kill(); } catch (_error) { /* best effort */ }
    };
    const timer = setTimeout(() => {
      killChild();
      failWith(`opencode_free_cli_timeout_${effectiveTimeoutMs}ms`, 'opencode_free_cli_timeout');
    }, effectiveTimeoutMs);
    const signal = deps.signal || (options && options.signal);
    if (signal && typeof signal.addEventListener === 'function') {
      if (signal.aborted) {
        killChild();
        failWith('opencode_free_cli_aborted', 'opencode_free_cli_aborted');
        return;
      }
      signal.addEventListener('abort', () => {
        killChild();
        failWith('opencode_free_cli_aborted', 'opencode_free_cli_aborted');
      }, { once: true });
    }

    const addUsage = (tokens) => {
      const next = toOpenAiUsage(tokens);
      if (!next) return;
      usage = usage
        ? {
            prompt_tokens: usage.prompt_tokens + next.prompt_tokens,
            completion_tokens: usage.completion_tokens + next.completion_tokens,
            total_tokens: usage.total_tokens + next.total_tokens
          }
        : next;
    };


    let lineBuffer = '';
    const handleLine = (line) => {
      if (!line.trim()) return;
      let parsed = null;
      try { parsed = JSON.parse(line); } catch (_error) { return; }
      if (!parsed || typeof parsed !== 'object') return;
      if (parsed.sessionID && !sessionId) sessionId = normalizeString(parsed.sessionID);
      if (parsed.type === 'text' && parsed.part && typeof parsed.part.text === 'string') {
        const text = String(parsed.part.text || '');
        const delta = computeDelta(state.content, text, false);
        state.content += delta;
        if (delta && typeof onDelta === 'function') onDelta(delta);
        return;
      }
      if (parsed.type === 'step_finish') {
        const part = parsed.part && typeof parsed.part === 'object' ? parsed.part : {};
        if (part.reason) finishReason = mapFinishReason(part.reason);
        addUsage(part.tokens);
        return;
      }
      if (parsed.type === 'error' && !failureMessage) {
        failureMessage = extractCliErrorMessage(parsed) || 'opencode_free_cli_upstream_error';
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
      failWith(`opencode_free_cli_spawn_failed:${spawnError.message}`, 'opencode_free_cli_spawn_failed');
    });
    child.on('close', (code) => {
      if (lineBuffer.trim()) handleLine(lineBuffer);
      if (failureMessage) {
        failWith(failureMessage, 'opencode_free_cli_upstream_error');
        return;
      }
      if (code !== 0 && !state.content) {
        failWith(`opencode_free_cli_exit_${code}:${stderrTail.trim().slice(-300) || 'no_stderr'}`, 'opencode_free_cli_exit_nonzero');
        return;
      }
      finish(resolve, {
        content: state.content,
        usage,
        sessionId,
        model: bareModel,
        finishReason
      });
    });

    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (writeError) {
      killChild();
      failWith(`opencode_free_cli_stdin_failed:${writeError.message}`, 'opencode_free_cli_stdin_failed');
    }
  });
}

function buildChatCompletionPayload(result, requestedModel) {
  return {
    id: `chatcmpl-opencode-free-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: requestedModel || result.model || 'unknown',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: result.content || '' },
      finish_reason: result.finishReason || 'stop'
    }],
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.sessionId ? { session_id: result.sessionId, sessionId: result.sessionId } : {})
  };
}

function writeSseChunk(stream, payload) {
  stream.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function fetchOpenCodeFreeCliChatCompletion(options, account, requestJson = {}, timeoutMs = 8000, deps = {}) {
  const result = await runOpenCodeFreeCliTurn(options, account, requestJson, timeoutMs, deps);
  return buildChatCompletionPayload(result, String(requestJson && requestJson.model || '').trim());
}

// 返回 OpenAI Chat Completions SSE 形态的可读流（与 upstream-stream-forwarder 的
// pipeReadableBodyToResponse 契约一致），CLI delta 实时翻译为 chat.completion.chunk。
async function fetchOpenCodeFreeCliChatCompletionStream(options, account, requestJson = {}, timeoutMs = 8000, deps = {}) {
  const requestedModel = String(requestJson && requestJson.model || '').trim() || 'unknown';
  const body = new PassThrough();
  const id = `chatcmpl-opencode-free-${Date.now()}`;
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

  const run = runOpenCodeFreeCliTurn(options, account, requestJson, timeoutMs, deps, (delta) => {
    if (!roleSent) {
      roleSent = true;
      sendChunk({ role: 'assistant' });
    }
    sendChunk({ content: delta });
  }).then((result) => {
    if (!roleSent) sendChunk({ role: 'assistant' });
    sendChunk({}, result.finishReason || 'stop', result.usage ? { usage: result.usage } : {});
    body.write('data: [DONE]\n\n');
    body.end();
  }).catch((error) => {
    body.destroy(error);
  });
  // 防未处理 rejection：错误已通过 body.destroy 传给消费方。
  run.catch(() => {});
  return { ok: true, status: 200, body };
}

module.exports = {
  OPENCODE_FREE_CLI_TRANSPORT_ID,
  RELAY_DISABLED_TOOLS,
  bareOpenCodeModelId,
  buildChatCompletionPayload,
  buildOpenCodeCliPrompt,
  buildRelayConfigContent,
  buildRelayEnv,
  ensureRelayWorkspaceDir,
  fetchOpenCodeFreeCliChatCompletion,
  fetchOpenCodeFreeCliChatCompletionStream,
  isOpenCodeFreeModelId,
  mapFinishReason,
  supportsOpenCodeFreeCliTransport,
  __private: {
    extractCliErrorMessage,
    runOpenCodeFreeCliTurn,
    toOpenAiUsage
  }
};

