'use strict';

// ZCode 的 **headless 单次问答**（`aih zcode <id> -p <prompt>`）—— 走官方 **app-server** 通道。
//
// 为什么不能直接让 CLI 自己的 `-p` 干：standalone CLI 的账号 provider 枚举（`ejn()`）写死
// `access.mode === 'individual-coding-plan'`，start-plan 账号在 standalone 下注册表为空 →
// `-p` 报 "Select a model before sending a message"（详见 AGENTS.md 的 zcode 条目）。
// app-server 模式下宿主可以**声明账号 provider**（`provider/updateAccountConfig`），
// 于是官方客户端会照常发请求并完成整轮 —— 实测 `model.network.completed` + `finishReason:stop`
// + `turn.completed`。
//
// 协议要点（全部真机取证，逐字见 AGENTS.md）：
//   * 报文信封是裸 `{id,method,params}`（**不带 jsonrpc**）；
//   * 必须应答的反向请求：`session/requestRuntimePreferences`（schema `Utn`）、
//     `interaction/requestProviderRuntimeHeaders`（`{headersApplied:true,requestAuth:{apiKey}}`，
//     start-plan 的 apiKey = zcodeJWT）、`interaction/requestPermission`；
//   * 顺序：`provider/updateAccountConfig` → `provider/refreshRegistry` → `session/create`
//     → `session/resume` → **`session/setMode`**（缺它 turn 不启动）→ `session/send`
//     （带 `modelSelection`）；
//   * 答案不从这里读：`session/messages` 只有用户消息，助手文本落在
//     `<hostHome>/.zcode/cli/db/db.sqlite` 的 `message`/`part` 表里，用
//     `lib/sessions/zcode-session-store.js` 的 `readZcodeSessionMessages` 读（唯一读取器）。

const { spawn } = require('node:child_process');
const nodePath = require('node:path');
const nodeFs = require('node:fs');
const { readZcodeSessionMessages } = require('../../../sessions/zcode-session-store');
const { readZcodeLiveOAuthCredential } = require('../../../account/zcode-credential');

const RUNTIME_PREFERENCES = Object.freeze({
  nativeSearchEnhancementsEnabled: true,
  toolSearchMode: 'off',
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: true,
  modelContextBudgetStrategy: 'preflight-v1'
});

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 跑一次 headless 问答。
 *
 * @param {object} input
 * @param {string} input.env             已装配好的 CLI 启动环境（含 ZCODE_DATA_BASE_DIR / HOME / 凭据密钥）
 * @param {string} input.cliPath         bundle 内的 `zcode.cjs`
 * @param {string} input.prompt          提示词
 * @param {string} input.providerId      账号 provider（如 `account:zai-start-plan`）
 * @param {string} input.modelId         模型 id（如 `GLM-5.3-Flash`）
 * @param {string} [input.workspacePath] 工作目录（默认 process.cwd()）
 * @param {string} [input.cliDbPath]     会话库路径（默认 `<hostHome>/.zcode/cli/db/db.sqlite`）
 * @param {number} [input.timeoutMs]     总超时（默认 180000）
 * @param {object} [input.deps]          { spawnImpl, fs, path, aiHomeDir, accountRef, hostHomeDir }
 * @returns {Promise<{ok: boolean, text: string, sessionId: string, error: string}>}
 */
async function runZcodeAppServerPrompt(input = {}) {
  const deps = input.deps || {};
  const fsImpl = deps.fs || nodeFs;
  const pathImpl = deps.path || nodePath;
  const spawnImpl = deps.spawnImpl || spawn;
  const env = input.env && typeof input.env === 'object' ? input.env : process.env;
  const cliPath = normalizeText(input.cliPath);
  const prompt = String(input.prompt || '').trim();
  const providerId = normalizeText(input.providerId);
  const modelId = normalizeText(input.modelId);
  const workspacePath = normalizeText(input.workspacePath) || process.cwd();
  const timeoutMs = Number(input.timeoutMs) > 0 ? Math.floor(Number(input.timeoutMs)) : 180000;
  if (!cliPath || !prompt || !providerId || !modelId) {
    return { ok: false, text: '', sessionId: '', error: 'zcode_app_server_input_invalid' };
  }
  const cliDbPath = normalizeText(input.cliDbPath)
    || pathImpl.join(normalizeText(deps.hostHomeDir) || require('node:os').homedir(),
      '.zcode', 'cli', 'db', 'db.sqlite');
  // `basedOnZCodeBuiltinRevision` 必须是**内置 provider 配置的 revision**，否则账号 provider 的
  // overlay 会被注册表丢弃（表现：turn 报 `Provider Registry 中不存在 Provider/Model`）。
  let builtinRevision = normalizeText(input.builtinRevision);
  if (!builtinRevision && normalizeText(input.builtinConfigPath)) {
    try {
      const builtin = JSON.parse(fsImpl.readFileSync(normalizeText(input.builtinConfigPath), 'utf8'));
      builtinRevision = normalizeText(String(builtin && builtin.revision || ''));
    } catch (_error) {
      builtinRevision = '';
    }
  }
  let apiKey = '';
  try {
    const credential = readZcodeLiveOAuthCredential(fsImpl, deps.aiHomeDir, deps.accountRef);
    apiKey = normalizeText(credential && credential.oauth && credential.oauth.jwtToken);
  } catch (_error) {
    apiKey = '';
  }

  const child = spawnImpl(process.execPath, [cliPath, 'app-server', '--stdio'], {
    env, stdio: ['pipe', 'pipe', 'pipe']
  });
  let seq = 0;
  let buffer = '';
  let sessionId = '';
  const pending = new Map();
  // 服务端**通知**（没有 id 的报文）是唯一能说清「为什么没跑起来」的来源
  // （例如 Provider Registry 丢弃了 overlay、模型不可用、turn 失败）。
  // 只留最近若干条，失败时随错误一起上报，不往正常输出里掺日志。
  const serverEvents = [];
  const recordEvent = (message) => {
    serverEvents.push({
      method: String(message && message.method || ''),
      params: message && message.params ? message.params : null
    });
    while (serverEvents.length > 12) serverEvents.shift();
  };
  const summarizeEvents = () => {
    if (serverEvents.length === 0) return 'no_server_events';
    const last = serverEvents[serverEvents.length - 1];
    let detail = '';
    try {
      detail = JSON.stringify(last.params || {}).slice(0, 240);
    } catch (_error) {
      detail = '';
    }
    return `${last.method}:${detail}`;
  };
  const send = (method, params) => {
    const id = ++seq;
    const promise = new Promise((resolve) => pending.set(id, resolve));
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return promise;
  };
  const reply = (id, payload) => child.stdin.write(`${JSON.stringify({ id, ...payload })}\n`);
  const onLine = (line) => {
    let message = null;
    try {
      message = JSON.parse(line);
    } catch (_error) {
      return;
    }
    if (message.method && message.id !== undefined) {
      // 宿主侧必须应答的反向请求。
      if (message.method === 'session/requestRuntimePreferences') {
        sessionId = sessionId || normalizeText(message.params && message.params.sessionId);
        reply(message.id, { result: RUNTIME_PREFERENCES });
      } else if (message.method === 'interaction/requestProviderRuntimeHeaders') {
        reply(message.id, { result: { headersApplied: true, requestAuth: apiKey ? { apiKey } : {} } });
      } else if (message.method === 'interaction/requestPermission') {
        reply(message.id, { result: { decision: 'allow' } });
      } else {
        reply(message.id, { error: { code: -32601, message: 'unsupported' } });
      }
      return;
    }
    if (message.method && message.id === undefined) {
      // 服务端通知：只记录，失败时上报（见 recordEvent）。
      recordEvent(message);
      return;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const resolve = pending.get(message.id);
      pending.delete(message.id);
      resolve(message);
    }
  };
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (line.trim()) onLine(line);
    }
  });
  return driveZcodeAppServer({
    child, send, timeoutMs, cliDbPath, prompt, providerId, modelId, workspacePath, builtinRevision,
    summarizeEvents,
    getSessionId: () => sessionId
  });
}

// 协议时序（与官方桌面宿主一致；`session/setMode` 缺了 turn 不会启动）。
async function driveZcodeAppServer(ctx) {
  const { child, send, timeoutMs, cliDbPath, prompt, providerId, modelId, workspacePath, builtinRevision, getSessionId } = ctx;
  const summarizeEvents = typeof ctx.summarizeEvents === 'function' ? ctx.summarizeEvents : () => 'no_server_events';
  const deadline = Date.now() + timeoutMs;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // RPC 返回里的 `error` 不能吞：账号 provider overlay 被注册表拒绝时，后续每一步都会
  // 以更难定位的方式失败（实测 turn 直接不启动）。这里就地报出来。
  const sendChecked = async (method, params) => {
    const response = await send(method, params);
    if (response && response.error) {
      const message = response.error.message || JSON.stringify(response.error);
      throw new Error(`${method} 被拒: ${String(message).slice(0, 200)}`);
    }
    return response;
  };
  try {
    await sendChecked('provider/updateAccountConfig', {
      revision: `aih-${Date.now()}`,
      basedOnZCodeBuiltinRevision: builtinRevision,
      providers: { [providerId]: { builtinModelIds: [modelId], access: { type: 'zhipu-account', entitled: true } } },
      states: { [providerId]: { availability: 'available', entitled: true, current: true } }
    });
    await sendChecked('provider/refreshRegistry', { reason: 'aih_headless' });
    const created = await sendChecked('session/create', { workspace: { workspaceKey: workspacePath, workspacePath } });
    const sessionId = getSessionId() || normalizeText(created.result && created.result.sessionId);
    if (!sessionId) return { ok: false, text: '', sessionId: '', error: 'zcode_app_server_session_missing' };
    await send('session/resume', { sessionId });
    await send('session/setMode', { sessionId, mode: 'yolo' });
    const accepted = await sendChecked('session/send', {
      sessionId, content: prompt, modelSelection: { providerId, modelId }
    });
    if (!accepted.result || accepted.result.accepted !== true) {
      return { ok: false, text: '', sessionId, error: 'zcode_app_server_send_rejected' };
    }
    // 轮询会话库取助手回复（答案不经过 RPC；见文件头说明）。
    while (Date.now() < deadline) {
      await wait(1200);
      let messages = [];
      try {
        messages = readZcodeSessionMessages(cliDbPath, sessionId) || [];
      } catch (_error) {
        messages = [];
      }
      const assistant = messages.filter((m) => m.role === 'assistant' && normalizeText(m.content));
      if (assistant.length > 0) {
        return { ok: true, text: String(assistant[assistant.length - 1].content).trim(), sessionId, error: '' };
      }
    }
    return { ok: false, text: '', sessionId, error: `zcode_app_server_timeout:${summarizeEvents()}` };
  } catch (error) {
    return { ok: false, text: '', sessionId: '', error: `zcode_app_server_failed:${error && error.message}` };
  } finally {
    try {
      child.kill();
    } catch (_error) { /* 忽略 */ }
  }
}

module.exports = { RUNTIME_PREFERENCES, runZcodeAppServerPrompt };

