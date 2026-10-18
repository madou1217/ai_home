'use strict';

// OpenCode 免费模型（`-free`）的 OpenAI chat 兼容推理 transport —— **兜底通道**：
// 首选是 HTTP 直连（opencode-zen-free-client.js + upstream-endpoints-transport-opencode-free-http.js），
// 直连被上游加固拒绝（403 FreeTierError）时由本模块在同一传输链上接管，功能不降级。
//
// 为什么还需要它（2026-10-15 门禁发现、2026-10-16 完整逆向，排障必读）：
// Zen 免费档是**客户端门禁**，直连必须同时满足五条件（UA 四段式形状 / 白名单头名携带
// 结构合法会话 id / tools 含 `read` / stream:true / title 内容例外），精确判据与实验
// 记录见 opencode-zen-free-client.js 模块头。真机 `opencode` 二进制天然满足全部条件，
// 所以它是永不失效的最后一条腿。
//
// 与门禁相关的一条实测：把 CLI 的工具全部关掉（tools 全 false）后，连 CLI 自己也会吃
// 403 FreeTierError —— 工具面是门禁条件之一（其中 `read` 名必须存在，2026-10-16 定位）。
// 因此这里只关闭有副作用的工具（见 RELAY_DISABLED_TOOLS），不整体清空工具面。
//
// 桥接方式与 qoder-cli-transport 同构：
//   - prompt 经 stdin 传入（整条对话扁平化成 transcript，规避 Windows argv 上限）；
//   - 认证与隔离交给账号投影：materializeProviderAuth 把账号 auth.json 写到
//     `<projection>/.local/share/opencode/auth.json`，这里把 HOME/XDG_* 指向该投影，
//     CLI 因此以该账号身份运行，且不污染宿主 opencode 数据/会话库；
//   - `opencode run --format json` 的 JSONL 事件流翻译成 OpenAI Chat Completions
//     语义（缓冲聚合 + SSE delta），上游错误原样透出，不做掩盖；
//   - `run` 的参数形态按 CLI 布局表（lib/runtime/opencode-run-layouts.js）组装：
//     v1 显式 `--dir`，v2 目录由 cwd/PWD 表达（`--dir` 已被移除）并追加
//     `--standalone` 绕开 v2 后台 service 的 channel 固定端口（多账号并发即端口冲突）。

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
const {
  openCodeRunDirectoryArgs,
  openCodeRunEnvPatch,
  openCodeRunStandaloneArgs,
  resolveOpenCodeRunLayout
} = require('../runtime/opencode-run-layouts');
const { computeDelta } = require('./native-session-chat-stream');
const { buildOpenCodePrompt } = require('./opencode-server-client');
const { bareOpenCodeModelId, isOpenCodeFreeModelId } = require('./opencode-free-models');

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

// 免费模型判定（`-free` 后缀或目录价格为 0）的单一来源在 opencode-free-models.js。
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

/** 每次 relay 的隔离 workspace（v1 作为 `--dir`、v2 作为 spawn cwd；工具副作用只落在这里）。 */
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
  // 布局驱动（lib/runtime/opencode-run-layouts.js 是唯一事实来源）：
  //   v1 → `--dir <workspaceDir>` 显式表达工作目录；
  //   v2 → `--dir` 已移除（写了直接吃 `Unrecognized flag: --dir`），目录由 cwd 表达，
  //        并追加 `--standalone`：v2 默认连 channel 固定的后台 service（latest=49374），
  //        多账号并发时后启动的实例必吃 EADDRINUSE（2026-10-15 事故），
  //        standalone 改用进程私有 server（临时端口），并发冲突从根上消失。
  const layout = resolveOpenCodeRunLayout({
    cliPath,
    env: deps.env || process.env,
    fs,
    spawnSync: deps.spawnSync
  });
  const args = ['run', '--format', 'json', '--dangerously-skip-permissions', '--model', `opencode/${bareModel}`];
  args.push(...openCodeRunDirectoryArgs(layout, workspaceDir));
  args.push(...openCodeRunStandaloneArgs(layout));
  // v2 的工作目录 = `PWD ?? cwd`（官方 run/run.ts 的 localDirectory），而 spawn 只设
  // cwd 不改 PWD —— server/终端进程残留的 PWD 会把 relay 带去错误目录，这里对齐到
  // workspaceDir（v1 无此约定时补丁为空对象）。
  Object.assign(env, openCodeRunEnvPatch('opencode', { cliPath, cwd: workspaceDir }) || {});
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

