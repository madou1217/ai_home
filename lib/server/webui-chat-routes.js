'use strict';

const { DEFAULT_SERVER_PORT } = require('./server-defaults');

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ensureCodexHooksEnabled, ensureCodexProjectRegistered } = require('./codex-project-registry');
const { resolveProviderDefaultModel } = require('./provider-default-models');
const { defaultSessionEventBus } = require('./session-event-bus');
const {
  appendImagePathsToPrompt,
  persistChatImages,
  resolveChatAttachmentPath,
  guessAttachmentMimeType
} = require('./chat-attachments');
const { validateNativeSlashCommand, getProviderSlashCommands } = require('./native-slash-commands');
const { isOfficialNativeSessionProvider } = require('./native-session-chat');
const {
  supportsAihServerProfile,
  buildAihServerProfileEnv
} = require('../account/self-relay-account');
const { readServerConfig } = require('./server-config-store');
const {
  readAccountCredentialRecord,
  readAccountCredentials
} = require('./account-credential-store');
const { isAccountRef } = require('./account-ref-store');
const {
  resolveRuntimeTarget,
  serializeRuntimeTarget
} = require('../account/runtime-target');
const { createCodexLaunchSupport } = require('../cli/services/pty/codex-launch-support');
const { normalizeApprovalMode, approvalModeNeedsBridge } = require('./native-approval-modes');
const { canonicalizeProviderResourceValue } = require('../runtime/provider-resource-path');
const {
  registerApprovalRequest,
  decideApproval,
  cancelApprovalsForRun,
  getPendingApprovalPromptForRun,
  toApprovalPrompt
} = require('./native-approval-bridge');
const { loadAliases, resolveAlias } = require('./model-alias-store');
const {
  CLAUDE_CREDENTIAL_TYPES,
  readClaudeCredential
} = require('../account/claude-credential');

function parseJsonFileSafe(filePath, fsImpl = fs) {
  try {
    return JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function canonicalizeChatPayload(ctx, provider, payload) {
  const deps = ctx.deps || {};
  return canonicalizeProviderResourceValue(payload, {
    provider,
    aiHomeDir: deps.aiHomeDir || ctx.aiHomeDir,
    hostHomeDir: deps.hostHomeDir || ctx.hostHomeDir
  });
}

function finishStartedChatStream(ctx, provider, payload) {
  const res = ctx && ctx.res;
  if (!res || !res.headersSent) return false;
  if (!res.writableEnded && !res.destroyed) {
    try {
      const event = canonicalizeChatPayload(ctx, provider, {
        type: 'error',
        ...payload
      });
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch (_error) {
      // The transport may already be closed; ending it is still best effort.
    }
    try {
      if (!res.writableEnded) res.end();
    } catch (_error) {}
  }
  return true;
}

// 把上游(v1-router / api-proxy)返回的原始错误体翻译成干净、可执行的中文提示，
// 避免把 {"ok":false,"error":"no_available_account",...} 这种嵌套 JSON 直接甩给用户。
function humanizeUpstreamError(rawText, { status, model, provider } = {}) {
  const raw = normalizeString(rawText);
  let payload = null;
  if (raw && (raw[0] === '{' || raw[0] === '[')) {
    try {
      payload = JSON.parse(raw);
    } catch (_error) {
      payload = null;
    }
  }

  const code = payload && typeof payload.error === 'string' ? payload.error : '';
  const detail = payload
    ? normalizeString(payload.detail || payload.message || payload.reason)
    : '';
  const modelLabel = normalizeString(model);
  const providerLabel = normalizeString(provider);
  const modelText = modelLabel ? `「${modelLabel}」` : '';
  const providerText = providerLabel ? `${providerLabel} ` : '';

  switch (code) {
    case 'no_available_account':
      return (
        `当前 server 上没有可用于模型${modelText || ''}的${providerText}账号。`
        + `可能原因：该账号未在此 server 完成登录/凭据配置，或该模型未在账号的可用清单里。`
        + `请在「账号」页补全该 server 上的账号凭据，或改用其他账号/模型后重试。`
      );
    case 'account_not_configured':
      return (
        `所选${providerText}账号在当前 server 上尚未完成配置(缺少登录凭据)。`
        + `请先在「账号」页为该 server 补全登录后再发送。`
      );
    case 'missing_model':
    case 'model_required':
      return '请先选择一个模型再发送。';
    case 'model_not_found':
      return `模型${modelText || ''}在当前 server 上不可用，请改用其他模型。`;
    case 'rate_limited':
    case 'cooldown':
      return (
        `该${providerText}账号当前被上游限流/熔断${detail ? `（${detail}）` : ''}。`
        + `请稍后重试，或改用其他账号。`
      );
    default:
      break;
  }

  // 未知结构化错误：优先用 detail/message，退回到原始文本，最后才用 HTTP 状态码。
  if (detail) return detail;
  if (raw && !payload) return raw;
  if (status) return `请求失败（HTTP ${status}）`;
  return '请求失败';
}

function resolveNativeFallbackAccountRefs(loadServerRuntimeAccounts, provider, accountRef) {
  const normalizedProvider = normalizeString(provider).toLowerCase();
  const normalizedAccountRef = normalizeString(accountRef);
  if (normalizedProvider !== 'gemini' || typeof loadServerRuntimeAccounts !== 'function') return [];

  try {
    const runtimeAccounts = loadServerRuntimeAccounts();
    const providerAccounts = Array.isArray(runtimeAccounts && runtimeAccounts[normalizedProvider])
      ? runtimeAccounts[normalizedProvider]
      : [];
    const now = Date.now();
    return providerAccounts
      .map((account) => account && typeof account === 'object' ? account : null)
      .filter(Boolean)
      .filter((account) => normalizeString(account.accountRef) !== normalizedAccountRef)
      .filter((account) => now >= Number(account.cooldownUntil || 0))
      .filter((account) => now >= Number(account.authInvalidUntil || 0))
      .map((account) => normalizeString(account.accountRef));
  } catch (_error) {
    return [];
  }
}

// 从已加载的运行时账号里取该账号的权威 apiKeyMode（与账号列表同源、来自持久化派生状态）。
function resolveRuntimeApiKeyMode(loadServerRuntimeAccounts, provider, accountRef) {
  if (typeof loadServerRuntimeAccounts !== 'function') return false;
  const normalizedProvider = normalizeString(provider).toLowerCase();
  const normalizedAccountRef = normalizeString(accountRef);
  try {
    const runtimeAccounts = loadServerRuntimeAccounts();
    const list = Array.isArray(runtimeAccounts && runtimeAccounts[normalizedProvider])
      ? runtimeAccounts[normalizedProvider]
      : [];
    const account = list.find((item) => (
      item && normalizeString(item.accountRef) === normalizedAccountRef
    ));
    if (!account) return false;
    return Boolean(account.apiKeyMode) || normalizeString(account.authType).toLowerCase() === 'api-key';
  } catch (_error) {
    return false;
  }
}

// 该账号是否有可用凭据（app-state.db 判定，与账号列表同源）。无法判定时返回 true(不拦)。
// 用途：聊天前置校验——未登录/未配置(如只有 config.toml、无 auth.json 的半成品 codex 账号)
// 不该真去开 native 会话拿一个隐晦的 401 native_session_failed，直接给用户可操作的清晰报错。
function nativeAccountHasCredentials(provider, accountRef, fsImpl, aiHomeDir) {
  const p = normalizeString(provider).toLowerCase();
  const fs = fsImpl || require('node:fs');
  if (!p || !isAccountRef(accountRef) || !aiHomeDir) return false;
  try {
    const record = readAccountCredentialRecord(fs, aiHomeDir, accountRef);
    return Boolean(record && record.provider === p && (
      Object.keys(record.env).length > 0
      || Object.keys(record.nativeAuth).length > 0
    ));
  } catch (_error) {
    return true;
  }
}

// 会话"上次使用模型"的服务端真相在 model_usage_records。codex/claude/gemini 由本地
// 会话文件扫描补记；agy 的 brain transcript 不带 model 字段、扫描器不覆盖——若不在
// native 轮完成时落一条，agy 会话刷新后永远召回不到上次用模，模型选择器退回账号
// 目录第一个（claude-opus-*），用户会误以为 provider/账号被换掉了。token 数在此
// 路径未知，记 0；eventKey 按 runId 幂等。
function recordNativeSessionModelUsage(ctx, record) {
  const svc = ctx.deps && ctx.deps.modelUsageService;
  if (!svc || typeof svc.recordUsage !== 'function') return;
  const model = normalizeString(record && record.model);
  const sessionId = normalizeString(record && record.sessionId);
  const provider = normalizeString(record && record.provider).toLowerCase();
  if (!model || !sessionId || !provider) return;
  try {
    svc.recordUsage({
      eventKey: `${provider}:native-done:${sessionId}:${normalizeString(record.runId) || Date.now()}`,
      provider,
      accountRef: normalizeString(record.accountRef),
      sessionId,
      sourceKind: 'native_session_done',
      model,
      timestampMs: Date.now()
    });
  } catch (_error) {}
}

function normalizeNativeSessionModel(provider, requestModel, apiKeyMode) {
  const normalizedProvider = normalizeString(provider).toLowerCase();
  const model = normalizeString(requestModel);
  if (!model) return undefined;
  if (normalizedProvider !== 'gemini' || apiKeyMode) return model;
  if (/^gemini-2\.5-(pro|flash)\b/i.test(model)) return model;
  return undefined;
}

// native 路径的模型别名解析：把用户选的同 provider 别名换成真实目标模型,再交给 CLI。
// 跨 provider 别名(targetProvider !== provider,如 claude-*→agy)在 native 不适用(无法换号),
// 保持原样返回。失败(读不到别名库等)一律回退原模型,绝不阻塞会话。
async function resolveNativeAliasModel(ctx, provider, requestModel) {
  const model = normalizeString(requestModel);
  if (!model) return requestModel;
  const normalizedProvider = normalizeString(provider).toLowerCase();
  try {
    const aliasData = await loadAliases(ctx.fs, ctx.aiHomeDir);
    const aliases = aliasData && Array.isArray(aliasData.aliases) ? aliasData.aliases : [];
    if (!aliases.length) return requestModel;
    const resolved = resolveAlias(aliases, model, normalizedProvider);
    if (!resolved || !resolved.target) return requestModel;
    const targetProvider = normalizeString(resolved.targetProvider).toLowerCase();
    if (targetProvider && targetProvider !== normalizedProvider) {
      // 跨 provider 别名:native 绑定当前 provider/account,无法路由到别的 provider → 保持原样。
      return requestModel;
    }
    return resolved.target;
  } catch (_error) {
    return requestModel;
  }
}

function sanitizeClaudeProjectDirName(projectPath) {
  return normalizeString(projectPath).replace(/[^a-zA-Z0-9]/g, '-');
}

function resolveNativeProjectDirName(provider, projectDirName, projectPath) {
  const normalizedProjectDirName = normalizeString(projectDirName);
  if (normalizedProjectDirName) return normalizedProjectDirName;
  if (normalizeString(provider).toLowerCase() !== 'claude') return '';
  const normalizedProjectPath = normalizeString(projectPath);
  if (!normalizedProjectPath) return '';
  return sanitizeClaudeProjectDirName(normalizedProjectPath);
}

function publishNativeSessionEvent(ctx, session, event = {}) {
  const provider = normalizeString(session && session.provider).toLowerCase();
  const sessionId = normalizeString(session && session.sessionId);
  if (!provider || !sessionId) return false;
  const bus = (ctx.deps && ctx.deps.sessionEventBus) || defaultSessionEventBus;
  if (!bus || typeof bus.publish !== 'function') return false;
  try {
    return bus.publish({
      provider,
      sessionId,
      projectDirName: normalizeString(session && session.projectDirName),
      projectPath: normalizeString(session && session.projectPath)
    }, {
      source: 'native-session-chat',
      ...event
    });
  } catch (_error) {
    return false;
  }
}

function truncateText(value, maxLength) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (!Number.isFinite(maxLength) || maxLength <= 0 || text.length <= maxLength) return text;
  return `${text.slice(0, maxLength).trim()}\n...`;
}

function listProjectRootEntries(fsImpl, projectPath, maxEntries = 12) {
  if (!fsImpl || !projectPath) return [];
  try {
    return fsImpl.readdirSync(projectPath)
      .map((item) => String(item || '').trim())
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right))
      .slice(0, maxEntries);
  } catch (_error) {
    return [];
  }
}

function readProjectTextFile(fsImpl, filePath, maxLength = 1800) {
  if (!fsImpl || !filePath || !fsImpl.existsSync(filePath)) return '';
  try {
    const stat = fsImpl.statSync(filePath);
    if (!stat || !stat.isFile()) return '';
    return truncateText(fsImpl.readFileSync(filePath, 'utf8'), maxLength);
  } catch (_error) {
    return '';
  }
}

function buildPackageJsonSummary(fsImpl, projectPath) {
  if (!fsImpl || !projectPath) return '';
  const packageJsonPath = path.join(projectPath, 'package.json');
  if (!fsImpl.existsSync(packageJsonPath)) return '';

  try {
    const parsed = JSON.parse(fsImpl.readFileSync(packageJsonPath, 'utf8'));
    const scripts = Object.keys(parsed && parsed.scripts && typeof parsed.scripts === 'object' ? parsed.scripts : {})
      .filter(Boolean)
      .slice(0, 8);
    const dependencies = Object.keys(parsed && parsed.dependencies && typeof parsed.dependencies === 'object' ? parsed.dependencies : {})
      .filter(Boolean)
      .slice(0, 8);
    const devDependencies = Object.keys(parsed && parsed.devDependencies && typeof parsed.devDependencies === 'object' ? parsed.devDependencies : {})
      .filter(Boolean)
      .slice(0, 8);
    const summary = {
      name: normalizeString(parsed && parsed.name),
      version: normalizeString(parsed && parsed.version),
      description: normalizeString(parsed && parsed.description),
      scripts,
      dependencies,
      devDependencies
    };
    return JSON.stringify(summary, null, 2);
  } catch (_error) {
    return readProjectTextFile(fsImpl, packageJsonPath, 1200);
  }
}

function buildProjectContextMessage(fsImpl, projectPath) {
  const normalizedProjectPath = normalizeString(projectPath);
  if (!normalizedProjectPath || !path.isAbsolute(normalizedProjectPath)) return '';
  if (!fsImpl || !fsImpl.existsSync(normalizedProjectPath)) return '';

  try {
    const stat = fsImpl.statSync(normalizedProjectPath);
    if (!stat || !stat.isDirectory()) return '';
  } catch (_error) {
    return '';
  }

  const rootEntries = listProjectRootEntries(fsImpl, normalizedProjectPath, 16);
  const knownFiles = ['README.md', 'README', 'readme.md', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod']
    .filter((fileName) => fsImpl.existsSync(path.join(normalizedProjectPath, fileName)));
  const packageJsonSummary = buildPackageJsonSummary(fsImpl, normalizedProjectPath);
  const readmePath = ['README.md', 'README', 'readme.md']
    .map((fileName) => path.join(normalizedProjectPath, fileName))
    .find((filePath) => fsImpl.existsSync(filePath));
  const readmeSummary = readProjectTextFile(fsImpl, readmePath, 1800);

  const sections = [
    '当前工作项目上下文（由 AI Home 自动注入，请基于这些信息回答与项目相关的问题）',
    `项目路径: ${normalizedProjectPath}`,
    `项目目录名: ${path.basename(normalizedProjectPath)}`,
    rootEntries.length > 0 ? `根目录条目: ${rootEntries.join(', ')}` : '',
    knownFiles.length > 0 ? `关键文件: ${knownFiles.join(', ')}` : '',
    packageJsonSummary ? `package.json 摘要:\n${packageJsonSummary}` : '',
    readmeSummary ? `README 摘要:\n${readmeSummary}` : ''
  ].filter(Boolean);

  return truncateText(sections.join('\n\n'), 5000);
}

function injectProjectContextMessage(messages, projectContextText) {
  const list = Array.isArray(messages) ? messages.map((message) => ({ ...message })) : [];
  const contextText = normalizeString(projectContextText);
  if (!contextText) return list;
  return [
    { role: 'system', content: contextText },
    ...list
  ];
}

function getOpenCodeSessionHostHome() {
  try {
    return require('../sessions/session-reader').getRealHome();
  } catch (_error) {
    return process.env.REAL_HOME || process.env.HOME || '';
  }
}

function toOpenAiHistoryMessages(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => ({
      role: String(message && message.role || '').trim(),
      content: String(message && message.content || '').trim()
    }))
    .filter((message) => (message.role === 'user' || message.role === 'assistant') && message.content);
}

function appendCurrentUserMessage(history, currentMessages) {
  const list = [...toOpenAiHistoryMessages(history)];
  const currentUser = [...(Array.isArray(currentMessages) ? currentMessages : [])]
    .reverse()
    .find((message) => message && message.role === 'user' && String(message.content || '').trim());
  if (!currentUser) return list;
  const content = String(currentUser.content || '').trim();
  const last = list[list.length - 1];
  if (last && last.role === 'user' && last.content === content) return list;
  list.push({ role: 'user', content });
  return list;
}

function buildOpenCodeApiProxyMessages(currentMessages, sessionId) {
  const existingSessionId = normalizeString(sessionId);
  if (!existingSessionId) return currentMessages;
  try {
    const { readSessionMessages } = require('../sessions/session-reader');
    const history = readSessionMessages('opencode', { sessionId: existingSessionId });
    if (!Array.isArray(history) || history.length < 1) return currentMessages;
    return appendCurrentUserMessage(history, currentMessages);
  } catch (_error) {
    return currentMessages;
  }
}

function beginOpenCodeApiProxyTurn(input = {}) {
  const { beginOpenCodeChatTurn } = require('../sessions/opencode-session-store');
  return beginOpenCodeChatTurn({
    hostHome: getOpenCodeSessionHostHome(),
    sessionId: input.sessionId,
    projectPath: input.projectPath,
    prompt: input.prompt,
    model: input.model,
    agent: 'build',
    nowMs: Date.now()
  });
}

function completeOpenCodeApiProxyTurn(input = {}) {
  if (!input || !input.turn || !input.turn.sessionId) return false;
  const { completeOpenCodeChatTurn } = require('../sessions/opencode-session-store');
  return completeOpenCodeChatTurn({
    hostHome: getOpenCodeSessionHostHome(),
    sessionId: input.turn.sessionId,
    userMessageId: input.turn.userMessageId,
    projectPath: input.projectPath,
    content: input.content,
    model: input.model,
    usage: input.usage,
    finishReason: input.finishReason,
    agent: 'build',
    startedMs: input.startedMs,
    nowMs: Date.now()
  });
}

function requireOpenCodeTurnSessionId(turn) {
  const sessionId = normalizeString(turn && turn.sessionId);
  if (sessionId) return sessionId;
  const error = new Error('opencode_session_id_missing');
  error.code = 'opencode_session_id_missing';
  throw error;
}

function resolveApiProxyJsonSessionId(data) {
  return normalizeString(data && data.id);
}

function attachAbortableRequestClose(req, onClose, res) {
  if (typeof onClose !== 'function') return () => {};
  let attached = false;
  if (req && typeof req.on === 'function') {
    req.on('close', onClose);
    req.on('aborted', onClose);
    attached = true;
  }
  if (res && typeof res.on === 'function') {
    res.on('close', onClose);
    attached = true;
  }
  return attached ? onClose : () => {};
}

async function waitForNativeSessionTranscriptReadable(provider, sessionId, projectDirName, options = {}) {
  const normalizedProvider = normalizeString(provider).toLowerCase();
  const normalizedSessionId = normalizeString(sessionId);
  const normalizedProjectDirName = normalizeString(projectDirName);
  if (!normalizedProvider || !normalizedSessionId) return false;

  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 5_000;
  const readerOptions = {
    accountRef: normalizeString(options.accountRef),
    aiHomeDir: normalizeString(options.aiHomeDir),
    hostHomeDir: normalizeString(options.hostHomeDir)
  };
  const startedAt = Date.now();
  const { resolveSessionFilePath, readSessionMessages } = require('../sessions/session-reader');

  const isReadable = () => {
    const sessionPath = resolveSessionFilePath(normalizedProvider, {
      sessionId: normalizedSessionId,
      projectDirName: normalizedProjectDirName
    }, readerOptions);
    if (!sessionPath || !fs.existsSync(sessionPath)) return false;
    const messages = readSessionMessages(normalizedProvider, {
      sessionId: normalizedSessionId,
      projectDirName: normalizedProjectDirName
    }, readerOptions);
    return Array.isArray(messages) && messages.length > 0;
  };

  while ((Date.now() - startedAt) < timeoutMs) {
    if (isReadable()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return isReadable();
}

async function refreshProjectsSnapshotAfterNativeSession(ctx, provider, sessionId, projectDirName, options = {}) {
  const normalizedSessionId = normalizeString(sessionId);
  // 即便没解析到 sessionId（如 codex 推断超时返回空），也要强制刷新项目快照——
  // 否则新会话已落盘但列表缓存陈旧 → 刷新页面「会话列表不可见」。有 sessionId 时先等
  // transcript 可读再刷新（拿到完整标题/消息）；没有就跳过等待直接刷新。
  if (normalizedSessionId) {
    await waitForNativeSessionTranscriptReadable(provider, normalizedSessionId, projectDirName, {
      accountRef: options.accountRef,
      aiHomeDir: ctx.aiHomeDir,
      hostHomeDir: options.hostHomeDir
    });
  }
  const { refreshProjectsSnapshot } = require('./webui-project-cache');
  await refreshProjectsSnapshot(ctx, { forceRefresh: true });
  return true;
}

function readClaudeApiSettings(accountRef, fsImpl, aiHomeDir) {
  const fsForRead = fsImpl || fs;
  const envJson = readAccountCredentials(fsForRead, aiHomeDir, accountRef);
  const credential = readClaudeCredential({ env: envJson });
  const apiKey = credential.credentialType === CLAUDE_CREDENTIAL_TYPES.AUTH_TOKEN
    ? ''
    : normalizeString(credential.token);
  const baseUrl = normalizeString(
    envJson.ANTHROPIC_BASE_URL
  ).replace(/\/+$/, '');

  return {
    apiKey,
    baseUrl,
    credentialType: credential.credentialType
  };
}

function isAnthropicCompatibleClaudeBaseUrl(baseUrl) {
  return normalizeString(baseUrl).toLowerCase().includes('/apps/anthropic');
}

function buildAnthropicMessagesPayload(messages, model, stream) {
  const inputMessages = Array.isArray(messages) ? messages : [];
  const anthropicMessages = [];
  const systemParts = [];

  inputMessages.forEach((message) => {
    const role = normalizeString(message && message.role).toLowerCase();
    const content = message && message.content;
    let text = '';

    if (typeof content === 'string') {
      text = content.trim();
    } else if (Array.isArray(content)) {
      text = content
        .map((item) => {
          if (typeof item === 'string') return item;
          if (!item || typeof item !== 'object') return '';
          if (item.type === 'text') return String(item.text || '');
          return '';
        })
        .filter(Boolean)
        .join('\n')
        .trim();
    }
    if (!text) return;

    if (role === 'system') {
      systemParts.push(text);
      return;
    }

    anthropicMessages.push({
      role: role === 'assistant' ? 'assistant' : 'user',
      content: [{ type: 'text', text }]
    });
  });

  return {
    model,
    stream: Boolean(stream),
    max_tokens: 4096,
    ...(systemParts.length > 0 ? { system: systemParts.join('\n\n') } : {}),
    messages: anthropicMessages
  };
}

function extractAnthropicTextFromResponse(json) {
  const content = Array.isArray(json && json.content) ? json.content : [];
  return content
    .filter((item) => item && item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('');
}

async function handleClaudeAnthropicCompatibleChat(ctx, request) {
  const {
    options,
    writeJson,
    createChatEventMeta
  } = ctx;
  const {
    provider,
    accountRef,
    model,
    messages,
    stream
  } = request;

  const { fetchWithTimeout } = require('./http-utils');
  const claudeConfig = readClaudeApiSettings(accountRef, ctx.fs, ctx.aiHomeDir);
  if (!claudeConfig.apiKey || !claudeConfig.baseUrl) {
    writeJson(ctx.res, 400, {
      ok: false,
      error: 'invalid_claude_api_config',
      message: 'claude API Key 或 ANTHROPIC_BASE_URL 缺失'
    });
    return true;
  }

  const upstreamUrl = `${claudeConfig.baseUrl}/v1/messages`;
  const payload = buildAnthropicMessagesPayload(messages, model, stream);
  const headers = {
    'content-type': 'application/json',
    'x-api-key': claudeConfig.apiKey,
    'anthropic-version': '2023-06-01'
  };

  const response = await fetchWithTimeout(upstreamUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  }, 60000, {
    proxyUrl: options.proxyUrl,
    noProxy: options.noProxy
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    writeJson(ctx.res, response.status, {
      ok: false,
      error: 'upstream_error',
      message: humanizeUpstreamError(errorText, {
        status: response.status,
        model,
        provider
      })
    });
    return true;
  }

  if (!stream) {
    const data = await response.json().catch(() => ({}));
    writeJson(ctx.res, 200, canonicalizeChatPayload(ctx, provider, {
      ok: true,
      provider,
      accountRef,
      mode: 'api-proxy',
      content: extractAnthropicTextFromResponse(data)
    }));
    return true;
  }

  const startedAt = Date.now();
  let firstTokenAt = 0;
  let content = '';
  ctx.res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  if (typeof ctx.res.flushHeaders === 'function') ctx.res.flushHeaders();

  const writeSse = (payloadItem) => {
    if (ctx.res.writableEnded) return;
    ctx.res.write(`data: ${JSON.stringify(canonicalizeChatPayload(ctx, provider, payloadItem))}\n\n`);
  };

  writeSse({
    type: 'ready',
    mode: 'api-proxy',
    provider,
    accountRef,
    interactionMode: 'default',
    ...createChatEventMeta(startedAt)
  });

  const reader = response.body && typeof response.body.getReader === 'function'
    ? response.body.getReader()
    : null;
  if (!reader) {
    writeSse({
      type: 'error',
      code: 'api_proxy_stream_unavailable',
      message: 'api_proxy_stream_unavailable',
      mode: 'api-proxy',
      ...createChatEventMeta(startedAt)
    });
    ctx.res.end();
    return true;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let doneSent = false;
  let streamClosed = false;

  const emitDone = () => {
    if (doneSent) return;
    doneSent = true;
    writeSse({
      type: 'done',
      mode: 'api-proxy',
      provider,
      accountRef,
      content,
      ...createChatEventMeta(startedAt, firstTokenAt
        ? {
            firstTokenElapsedMs: firstTokenAt - startedAt,
            totalElapsedMs: Date.now() - startedAt
          }
        : { totalElapsedMs: Date.now() - startedAt })
    });
  };

  const handleAnthropicEvent = (block) => {
    const lines = block.split('\n');
    let eventType = '';
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith('event:')) eventType = line.slice(6).trim();
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    const payloadText = dataLines.join('\n');
    if (!payloadText || payloadText === '[DONE]') return;

    let parsed = null;
    try {
      parsed = JSON.parse(payloadText);
    } catch (_error) {
      return;
    }

    if (eventType === 'content_block_delta' && parsed && parsed.delta && typeof parsed.delta.text === 'string') {
      const delta = parsed.delta.text;
      if (delta) {
        content += delta;
        if (!firstTokenAt) firstTokenAt = Date.now();
        writeSse({
          type: 'delta',
          delta,
          mode: 'api-proxy',
          ...createChatEventMeta(startedAt, firstTokenAt
            ? { firstTokenElapsedMs: firstTokenAt - startedAt }
            : {})
        });
      }
      return;
    }

    if (eventType === 'message_stop') {
      emitDone();
    }

    if (eventType === 'error') {
      writeSse({
        type: 'error',
        code: 'api_proxy_stream_failed',
        message: String(parsed && parsed.error && parsed.error.message || 'api_proxy_stream_failed'),
        mode: 'api-proxy',
        ...createChatEventMeta(startedAt, firstTokenAt
          ? { firstTokenElapsedMs: firstTokenAt - startedAt }
          : {})
      });
      doneSent = true;
      streamClosed = true;
      ctx.res.end();
    }
  };

  const closeStream = () => {
    if (streamClosed) return;
    streamClosed = true;
    try {
      if (reader && typeof reader.cancel === 'function') {
        reader.cancel().catch(() => {});
      }
    } catch (_error) {}
  };
  attachAbortableRequestClose(ctx.req, closeStream, ctx.res);

  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 2);
        if (block) handleAnthropicEvent(block);
        boundary = buffer.indexOf('\n\n');
      }

      if (done) break;
      if (ctx.res.writableEnded || streamClosed) return true;
    }
  } finally {
    try {
      if (typeof reader.releaseLock === 'function') {
        reader.releaseLock();
      }
    } catch (_error) {}
  }

  if (buffer.trim()) handleAnthropicEvent(buffer.trim());
  if (!ctx.res.writableEnded) {
    emitDone();
    streamClosed = true;
    ctx.res.end();
  }
  return true;
}

function detectApiKeyMode(provider, accountRef, fsImpl, aiHomeDir) {
  const safeProvider = String(provider || '').trim().toLowerCase();
  const fsForRead = fsImpl || fs;
  if (!isAccountRef(accountRef) || !aiHomeDir) return false;
  const envJson = readAccountCredentials(fsForRead, aiHomeDir, accountRef);

  if (safeProvider === 'codex') {
    return Boolean(String(envJson.OPENAI_API_KEY || '').trim());
  }
  if (safeProvider === 'gemini') {
    return Boolean(String(envJson.GEMINI_API_KEY || envJson.GOOGLE_API_KEY || '').trim());
  }
  if (safeProvider === 'claude') {
    return Boolean(String(envJson.ANTHROPIC_API_KEY || envJson.ANTHROPIC_AUTH_TOKEN || '').trim());
  }
  if (safeProvider === 'agy') {
    return Boolean(String(envJson.AGY_ACCESS_TOKEN || envJson.GOOGLE_OAUTH_ACCESS_TOKEN || '').trim());
  }
  return false;
}

function buildApiProxyMessages(messages, images) {
  // 丢掉空内容 / pending 占位的 assistant 消息：发给无状态上游（尤其 gemini/agy）会触发
  // INVALID_ARGUMENT（400）。content 为数组（含图片）视为非空。
  const list = (Array.isArray(messages) ? messages : [])
    .filter((message) => {
      if (!message) return false;
      if (message.role !== 'assistant') return true;
      if (Array.isArray(message.content)) return message.content.length > 0;
      return Boolean(String(message.content || '').trim());
    })
    .map((message) => ({ ...message }));
  const imageList = Array.isArray(images) ? images.filter(Boolean) : [];
  if (list.length === 0 || imageList.length === 0) return list;

  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (!message || message.role !== 'user') continue;
    const text = String(message.content || '').trim();
    message.content = [
      ...(text ? [{ type: 'text', text }] : []),
      ...imageList.map((imageUrl) => ({
        type: 'image_url',
        image_url: { url: imageUrl }
      }))
    ];
    break;
  }
  return list;
}

function createOpenAiChunkAdapter(writeSse, baseMeta) {
  let content = '';
  let reasoning = '';
  let doneSent = false;
  let sessionId = '';
  let finishReason = '';

  function emitDone(extra = {}) {
    if (doneSent) return;
    doneSent = true;
    writeSse({
      type: 'done',
      mode: 'api-proxy',
      content,
      reasoning,
      ...(sessionId ? { sessionId } : {}),
      ...baseMeta(),
      ...extra
    });
  }

  return {
    handleChunk(parsed) {
      const parsedSessionId = String(parsed && (parsed.session_id || parsed.sessionId) || '').trim();
      if (parsedSessionId && !sessionId) {
        sessionId = parsedSessionId;
        writeSse({
          type: 'session-created',
          sessionId,
          mode: 'api-proxy',
          ...baseMeta()
        });
      }
      const choices = Array.isArray(parsed && parsed.choices) ? parsed.choices : [];
      choices.forEach((choice) => {
        const delta = choice && choice.delta && typeof choice.delta === 'object'
          ? String(choice.delta.content || '')
          : '';
        const reasoningDelta = choice && choice.delta && typeof choice.delta === 'object'
          ? String(choice.delta.reasoning_content || '')
          : '';
        if (reasoningDelta) {
          reasoning += reasoningDelta;
          writeSse({
            type: 'thinking',
            thinking: reasoningDelta,
            mode: 'api-proxy',
            ...baseMeta()
          });
        }
        if (delta) {
          content += delta;
          writeSse({
            type: 'delta',
            delta,
            mode: 'api-proxy',
            ...baseMeta()
          });
        }
        if (choice && choice.finish_reason) finishReason = String(choice.finish_reason || '');
      });
    },
    handleError(message) {
      writeSse({
        type: 'error',
        code: 'api_proxy_stream_failed',
        message,
        mode: 'api-proxy',
        ...baseMeta()
      });
    },
    finalize() {
      emitDone();
    },
    getState() {
      return {
        content,
        reasoning,
        sessionId,
        finishReason
      };
    }
  };
}

async function handleGetSlashCommandsRequest(ctx) {
  const provider = String(ctx.url.searchParams.get('provider') || '').trim().toLowerCase();
  if (!provider) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'missing_provider' });
    return true;
  }
  ctx.writeJson(ctx.res, 200, {
    ok: true,
    provider,
    commands: getProviderSlashCommands(provider)
  });
  return true;
}

async function handleGetChatAttachmentRequest(ctx) {
  const { url, res } = ctx;
  const targetPath = String(url.searchParams.get('path') || '');

  let resolvedPath = '';
  try {
    resolvedPath = resolveChatAttachmentPath(targetPath, {
      fs: ctx.fs || (ctx.deps && ctx.deps.fs),
      aiHomeDir: ctx.aiHomeDir || (ctx.deps && ctx.deps.aiHomeDir),
      hostHomeDir: ctx.hostHomeDir || (ctx.deps && ctx.deps.hostHomeDir)
    });
  } catch (_error) {
    ctx.writeJson(res, 404, { ok: false, error: 'chat_attachment_not_found' });
    return true;
  }

  const contentType = guessAttachmentMimeType(resolvedPath);
  if (!contentType) {
    ctx.writeJson(res, 415, { ok: false, error: 'unsupported_chat_attachment_type' });
    return true;
  }
  const stat = fs.statSync(resolvedPath);
  const payload = fs.readFileSync(resolvedPath);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': stat.size,
    'Cache-Control': 'private, max-age=300'
  });
  res.end(payload);
  return true;
}

async function handleNativeChatRunInputRequest(ctx) {
  const {
    pathname,
    readRequestBody,
    writeJson,
    getNativeChatRun,
    unregisterNativeChatRun
  } = ctx;

  const matches = pathname.match(/^\/v0\/webui\/chat\/runs\/([^/]+)\/input$/);
  const runId = matches && matches[1] ? matches[1] : '';
  const payload = await readRequestBody(ctx.req, { maxBytes: 256 * 1024 })
    .then((buf) => buf ? JSON.parse(buf.toString('utf8')) : null)
    .catch(() => null);
  const input = String(payload && payload.input || '');
  const appendNewline = !payload || payload.appendNewline !== false;
  const promptId = String(payload && payload.promptId || '').trim();
  const mode = String(payload && payload.mode || '').trim();
  const run = getNativeChatRun(runId);

  if (!run) {
    writeJson(ctx.res, 404, { ok: false, error: 'native_chat_run_not_found' });
    return true;
  }
  if (!input) {
    writeJson(ctx.res, 400, { ok: false, error: 'native_chat_input_empty' });
    return true;
  }

  try {
    if (mode === 'steer') {
      // mid-run 插话(P2c):注入下一条 user 消息,claude stream-json run 支持;其余 unsupported。
      if (typeof run.writeSteer !== 'function') {
        const error = new Error('native_steer_unsupported');
        error.code = 'native_steer_unsupported';
        throw error;
      }
      run.writeSteer(input);
    } else {
      run.writeInput(input, promptId ? { appendNewline, promptId } : { appendNewline });
    }
    writeJson(ctx.res, 200, { ok: true, runId, mode: mode || 'input' });
  } catch (error) {
    const code = String(error && error.code || 'native_chat_input_failed');
    if (code === 'native_session_run_not_active') {
      unregisterNativeChatRun(runId);
    }
    writeJson(ctx.res, 400, canonicalizeChatPayload(ctx, run.provider, {
      ok: false,
      error: code,
      message: String((error && error.message) || error || 'native_chat_input_failed')
    }));
  }
  return true;
}

async function handleNativeChatRunResizeRequest(ctx) {
  const {
    pathname,
    readRequestBody,
    writeJson,
    getNativeChatRun,
    unregisterNativeChatRun
  } = ctx;

  const matches = pathname.match(/^\/v0\/webui\/chat\/runs\/([^/]+)\/resize$/);
  const runId = matches && matches[1] ? matches[1] : '';
  const payload = await readRequestBody(ctx.req, { maxBytes: 64 * 1024 })
    .then((buf) => buf ? JSON.parse(buf.toString('utf8')) : null)
    .catch(() => null);
  const cols = Number(payload && payload.cols);
  const rows = Number(payload && payload.rows);
  const run = getNativeChatRun(runId);

  if (!run) {
    writeJson(ctx.res, 404, { ok: false, error: 'native_chat_run_not_found' });
    return true;
  }
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
    writeJson(ctx.res, 400, { ok: false, error: 'native_chat_resize_invalid' });
    return true;
  }

  try {
    run.resize(cols, rows);
    writeJson(ctx.res, 200, { ok: true, runId, cols, rows });
  } catch (error) {
    const code = String(error && error.code || 'native_chat_resize_failed');
    if (code === 'native_session_run_not_active') {
      unregisterNativeChatRun(runId);
    }
    writeJson(ctx.res, 400, canonicalizeChatPayload(ctx, run.provider, {
      ok: false,
      error: code,
      message: String((error && error.message) || error || 'native_chat_resize_failed')
    }));
  }
  return true;
}

// GET /v0/webui/chat/runs?sessionId=&provider=&projectDirName= —— 列出注册表中仍在跑的 native run。
// detached 场景（刷新/导航/代理抖动断连后服务端只 detach 不 kill）的状态恢复入口：
// 页面重连后据此得知"该会话有 run 正在跑"（恢复运行中/停止按钮），并用 activePrompt
// 恢复待回答的交互 prompt（回答仍走 POST /runs/:runId/input + promptId）。
async function handleNativeChatRunListRequest(ctx) {
  const { url, writeJson } = ctx;
  const listRuns = typeof ctx.listNativeChatRuns === 'function'
    ? ctx.listNativeChatRuns
    : require('./native-chat-run-store').listNativeChatRuns;
  const sessionId = normalizeString(url.searchParams.get('sessionId'));
  const provider = normalizeString(url.searchParams.get('provider')).toLowerCase();
  const projectDirName = normalizeString(url.searchParams.get('projectDirName'));

  const runs = listRuns()
    .filter((run) => run && normalizeString(run.runId))
    .filter((run) => !sessionId || normalizeString(run.sessionId) === sessionId)
    .filter((run) => !provider || normalizeString(run.provider).toLowerCase() === provider)
    // projectDirName 仅在两边都有值时参与匹配（codex/agy 的 run 不带该字段）。
    .filter((run) => !projectDirName
      || !normalizeString(run.projectDirName)
      || normalizeString(run.projectDirName) === projectDirName)
    .map((run) => ({
      runId: normalizeString(run.runId),
      provider: normalizeString(run.provider).toLowerCase(),
      accountRef: normalizeString(run.accountRef),
      sessionId: normalizeString(run.sessionId),
      projectDirName: normalizeString(run.projectDirName),
      projectPath: normalizeString(run.projectPath),
      startedAt: Number(run.startedAt) || 0,
      interactionMode: normalizeString(run.interactionMode) || 'default',
      activePrompt: (typeof run.getActivePrompt === 'function' ? run.getActivePrompt() : null)
        // 挂起的审批(P3)也算待答 prompt:detached 刷新后审批卡随 /chat/runs 恢复。
        || getPendingApprovalPromptForRun(normalizeString(run.runId))
        || null
    }));

  writeJson(ctx.res, 200, canonicalizeChatPayload(ctx, provider, { ok: true, runs }));
  return true;
}

// POST /v0/webui/chat/runs/:runId/abort —— 【显式 stop】。前端点停止时调用它真正 kill CLI 进程。
// 与"被动断连"（浏览器导航/刷新、跨境代理抖动 → SSE close）区分开：被动断连只 detach 不 kill
// （见 closeStream），让 native run 跑完写进 CLI 自己的会话库、重连后能看到完整结果（并行子代理
// 综合等长任务不再被断连腰斩成"看着没处理完"）。只有这个显式 abort 才真正终止。
async function handleNativeChatRunAbortRequest(ctx) {
  const { pathname, writeJson, getNativeChatRun, unregisterNativeChatRun } = ctx;
  const matches = pathname.match(/^\/v0\/webui\/chat\/runs\/([^/]+)\/abort$/);
  const runId = matches && matches[1] ? matches[1] : '';
  const run = getNativeChatRun(runId);
  if (!run) {
    // 已完成/已清理：幂等成功，前端不用报错。
    writeJson(ctx.res, 200, { ok: true, runId, alreadyGone: true });
    return true;
  }
  try {
    if (typeof run.abort === 'function') run.abort();
    cancelApprovalsForRun(runId, 'aborted');
    unregisterNativeChatRun(runId);
    writeJson(ctx.res, 200, { ok: true, runId });
  } catch (error) {
    writeJson(ctx.res, 400, canonicalizeChatPayload(ctx, run.provider, {
      ok: false,
      error: 'native_chat_abort_failed',
      message: String((error && error.message) || error || 'native_chat_abort_failed')
    }));
  }
  return true;
}

// POST /v0/webui/internal/approval-request —— claude 权限工具(MCP)打进来的审批请求(P3)。
// 【长挂】响应直到用户在 webUI 决策(decideApproval 回填)或工具端超时断开。
// 仅 loopback 可达；webui-auth-gate 只为该内部 POST ingress 保留窄白名单。
async function handleNativeApprovalInboundRequest(ctx) {
  const { readRequestBody, writeJson, getNativeChatRun } = ctx;
  const payload = await readRequestBody(ctx.req, { maxBytes: 512 * 1024 })
    .then((buf) => buf ? JSON.parse(buf.toString('utf8')) : null)
    .catch(() => null);
  const runId = normalizeString(payload && payload.runId);
  const entry = registerApprovalRequest({
    runId,
    toolName: payload && payload.toolName,
    input: payload && payload.input,
    toolUseId: payload && payload.toolUseId
  }, (decision) => {
    if (!ctx.res.writableEnded) writeJson(ctx.res, 200, decision);
  });
  // 发布到会话事件通道:live SSE 页与 detached watch 页都能弹审批卡。
  const run = typeof getNativeChatRun === 'function' ? getNativeChatRun(runId) : null;
  if (run && run.provider && run.sessionId) {
    publishNativeSessionEvent(ctx, {
      provider: run.provider,
      sessionId: run.sessionId,
      projectDirName: run.projectDirName,
      projectPath: run.projectPath
    }, {
      type: 'session:approval-request',
      phase: 'interactive-prompt',
      at: Date.now(),
      runId,
      promptId: entry.approvalId,
      prompt: toApprovalPrompt(entry)
    });
  }
  // 工具端断开(claude 被杀/超时)→ 清掉挂账,避免僵尸审批卡。
  attachAbortableRequestClose(ctx.req, () => {
    decideApproval(entry.approvalId, 'deny', 'approval_channel_closed');
  }, ctx.res);
  return true; // 响应由 decideApproval 回填,勿在此 end
}

// POST /v0/webui/chat/runs/:runId/approvals/:approvalId —— 前端的审批决策(P3)。
async function handleNativeApprovalDecisionRequest(ctx) {
  const { pathname, readRequestBody, writeJson, getNativeChatRun } = ctx;
  const matches = pathname.match(/^\/v0\/webui\/chat\/runs\/([^/]+)\/approvals\/([^/]+)$/);
  const runId = matches && matches[1] ? decodeURIComponent(matches[1]) : '';
  const approvalId = matches && matches[2] ? decodeURIComponent(matches[2]) : '';
  const payload = await readRequestBody(ctx.req, { maxBytes: 64 * 1024 })
    .then((buf) => buf ? JSON.parse(buf.toString('utf8')) : null)
    .catch(() => null);
  const decision = normalizeString(payload && payload.decision) === 'allow' ? 'allow' : 'deny';
  const entry = decideApproval(approvalId, decision, payload && payload.message);
  if (!entry) {
    writeJson(ctx.res, 200, { ok: true, approvalId, alreadyResolved: true });
    return true;
  }
  const run = typeof getNativeChatRun === 'function' ? getNativeChatRun(runId) : null;
  if (run && run.provider && run.sessionId) {
    publishNativeSessionEvent(ctx, {
      provider: run.provider,
      sessionId: run.sessionId,
      projectDirName: run.projectDirName,
      projectPath: run.projectPath
    }, {
      type: 'session:approval-resolved',
      phase: 'interactive-prompt',
      at: Date.now(),
      runId,
      promptId: approvalId,
      reason: decision
    });
  }
  writeJson(ctx.res, 200, { ok: true, approvalId, decision });
  return true;
}

async function handleChatRequest(ctx) {
  const {
    options,
    readRequestBody,
    writeJson,
    fs,
    getToolConfigDir,
    getProfileDir,
    loadServerRuntimeAccounts,
    ensureSessionStoreLinks,
    registerNativeChatRun,
    unregisterNativeChatRun,
    createChatEventMeta
  } = ctx;

  const payload = await readRequestBody(ctx.req, { maxBytes: 10 * 1024 * 1024 })
    .then((buf) => buf ? JSON.parse(buf.toString('utf8')) : null)
    .catch(() => null);

  if (!payload || !payload.messages) {
    writeJson(ctx.res, 400, { ok: false, error: 'invalid_payload' });
    return true;
  }

  const {
    messages,
    provider,
    accountRef: requestedAccountRef,
    gateway,
    stream,
    model: requestModel,
    prompt,
    createSession,
    sessionId,
    projectDirName,
    projectPath,
    images,
    // 会话级审批模式(P3):bypass(默认,现状)/ confirm(权限请求转发 webUI)/ plan(计划模式+确认)。
    approvalMode
  } = payload;

  const useAihServerProfile = Boolean(gateway) && supportsAihServerProfile(provider);
  const runtimeTarget = resolveRuntimeTarget({
    gateway: useAihServerProfile,
    accountRef: requestedAccountRef
  });
  if (!provider || !runtimeTarget) {
    writeJson(ctx.res, 400, {
      ok: false,
      error: 'missing_account_info',
      detail: 'provider and either gateway=true or a valid accountRef are required'
    });
    return true;
  }
  const { accountRef } = runtimeTarget;
  const responseIdentity = serializeRuntimeTarget(runtimeTarget);
  const storedServerConfig = useAihServerProfile
    ? readServerConfig({ fs, aiHomeDir: ctx.aiHomeDir })
    : null;
  const nativeProcessEnv = useAihServerProfile
    ? {
        ...process.env,
        ...buildAihServerProfileEnv(provider, {
          ...storedServerConfig,
          port: options.port || storedServerConfig.port,
          apiKey: options.clientKey || storedServerConfig.apiKey
        })
      }
    : process.env;

  // P0: WebUI 会话走 aih-server 网关 profile(和 CLI `aih codex` 一致)——池化该 provider 全部账号
  // aih-server profile：网关凭据从 readServerConfig() 热读，不写文件。
  // buildBuiltinServerProfileEnv (runtime.js) 动态构建，无需持久化。
  let normalizedPrompt = String(
    prompt
    || (
      Array.isArray(messages)
        ? [...messages].reverse().find((message) => message && message.role === 'user' && String(message.content || '').trim())
        : null
    )?.content
    || ''
  ).trim();
  let persistedImagePaths = [];
  const apiKeyMode = !useAihServerProfile && (
    detectApiKeyMode(provider, accountRef, fs, ctx.aiHomeDir)
    || resolveRuntimeApiKeyMode(loadServerRuntimeAccounts, provider, accountRef)
  );

  // apikey codex 走 native 会话（native CLI 本就能用 API key）需要 config.toml 里有从账号凭据
  // (app-state.db 的 OPENAI_BASE_URL/OPENAI_API_KEY)生成的 [model_providers.<key>]，否则
  // gpt-5.5 这类自定义端点模型在 CLI 侧无法路由 → no_available_account。该 config-sync 原本只在
  // `aih codex` 终端启动时跑，webui native 路径不跑 → 远端(如 AWS)config 缺该段。这里在 spawn 前
  // 幂等补跑（best-effort，失败不阻塞——真缺凭据会在后续 native 报错里体现）。
  if (provider === 'codex' && apiKeyMode) {
    const syncGlobalConfigToHost = ctx.deps && ctx.deps.syncGlobalConfigToHost;
    if (typeof syncGlobalConfigToHost === 'function') {
      try { syncGlobalConfigToHost('codex', accountRef); } catch (_error) { /* best-effort */ }
    }
  }

  // 前置校验：未登录/未配置凭据的账号(如只有 config.toml、无 auth.json 的半成品 codex 账号)
  // 直接拒绝并给可操作报错，避免真去开 native 会话拿到隐晦的 401 native_session_failed。
  if (!useAihServerProfile && !nativeAccountHasCredentials(provider, accountRef, fs, ctx.aiHomeDir)) {
    writeJson(ctx.res, 400, {
      ok: false,
      error: 'account_not_configured',
      code: 'account_not_configured',
      message: `该账号（${provider} ${accountRef}）尚未登录或未配置凭据，无法发起会话。请重新登录该账号，或改用其他已登录的账号。`
    });
    return true;
  }

  if (Array.isArray(images) && images.length > 0) {
    try {
      persistedImagePaths = persistChatImages(images, {
        fs,
        provider,
        aiHomeDir: ctx.aiHomeDir,
        hostHomeDir: ctx.deps && ctx.deps.hostHomeDir,
        projectPath
      });
      normalizedPrompt = appendImagePathsToPrompt(normalizedPrompt, persistedImagePaths);
    } catch (error) {
      writeJson(ctx.res, 400, canonicalizeChatPayload(ctx, provider, {
        ok: false,
        error: 'invalid_chat_images',
        message: String((error && error.message) || error || 'invalid_chat_images')
      }));
      return true;
    }
  }

  let slashMeta = null;
  try {
    slashMeta = validateNativeSlashCommand(provider, normalizedPrompt);
  } catch (error) {
    const code = String(error && error.code || 'native_slash_command_unsupported');
    writeJson(ctx.res, 400, canonicalizeChatPayload(ctx, provider, {
      ok: false,
      error: code,
      code,
      message: String((error && error.message) || error || 'native_slash_command_unsupported'),
      commands: Array.isArray(error && error.commands) ? error.commands : []
    }));
    return true;
  }
  // opencode 也走 native（`opencode run --format json` headless，已验证可用），不再甩去 api-proxy
  // 导致 /chat 里 401/缺模型。之前把 opencode 排除在 webui native 之外是历史遗留。
  const webuiNativeSessionProvider = isOfficialNativeSessionProvider(provider);
  // slash 命令的意义就是交互(如 /model 弹选择器切模型)——一律走交互终端(xterm),包括 agy。
  // 普通对话才走 headless(agy 用 --print),二者分开:普通稳、slash 可交互。
  const useInteractiveNativeSlash = Boolean(
    webuiNativeSessionProvider
    && slashMeta
    && slashMeta.isSlashCommand
  );
  const useOfficialNativeSession = Boolean(
    webuiNativeSessionProvider
    && !useInteractiveNativeSlash
    && normalizedPrompt
  );
  // 模型别名解析（native 路径此前不解析别名 → 用户在原生会话里选的自定义别名被原样塞给 CLI
  // → `claude --model <别名>` / `codex -m <别名>` 报错或落到错误模型）。/v1 网关走 v1-router 的
  // 别名解析，native 必须自己补上。只解析【同 provider】别名:native 绑定 provider+account,
  // 跨 provider 别名(如 claude-*→agy)是网关语义、无法在 native 里换号,保持原样交由上层。
  const effectiveRequestModel = await resolveNativeAliasModel(ctx, provider, requestModel);
  const nativeSessionModel = normalizeNativeSessionModel(provider, effectiveRequestModel, apiKeyMode);
  const resolvedProjectDirName = resolveNativeProjectDirName(provider, projectDirName, projectPath);

  // slash command 是真实 CLI 进程的能力，与账号用 OAuth 还是 API key 鉴权无关——
  // 真实 CLI 带 API key（ANTHROPIC_API_KEY 等）同样能启动并执行 slash。因此 slash 一律走
  // native，不再被 apiKeyMode 甩去 /v1 代理（旧实现会让 API-key 账号丢掉 slash 能力）。
  // 普通消息仍保留原有路由：apiKeyMode 账号（可能指向自定义 base_url 的第三方端点）走代理，
  // 避免改动既有对外行为。
  // apikey 账号也走 native（native CLI 能用 API key → 拿到真会话:sessionId/持久化/隔离/续接，
  // 而非无状态 api-proxy 补全）。codex：spawn 前 config-sync 生成 [model_providers]（env_key）；
  // claude：buildProviderEnv 加载账号 DB 凭据的 ANTHROPIC_AUTH_TOKEN/ANTHROPIC_BASE_URL 进
  // spawn env。opencode apikey 的 native 凭据注入待验证，暂不放行。
  const apiKeyNativeReady = provider === 'codex' || provider === 'claude';
  const runNativeInteractive = (sessionId || createSession) && normalizedPrompt && (
    useInteractiveNativeSlash || (useOfficialNativeSession && (!apiKeyMode || apiKeyNativeReady))
  );
  if (runNativeInteractive) {
    // claude/codex/opencode 普通会话走 headless 流式（claude: --print stream-json；
    // codex: exec --json；opencode: run --format json），输出结构化 JSONL、干净可解析、
    // 不卡在交互 TUI。slash 命令仍走交互式 PTY。
    const useHeadlessStream = (
      provider === 'claude'
      || provider === 'codex'
      || provider === 'opencode'
      || provider === 'qoder'
      || provider === 'qodercn'
    )
      && useOfficialNativeSession && !useInteractiveNativeSlash;
    const nativeCliInteractive = !useHeadlessStream;
    // 普通会话不再强制走终端。agy 改用 headless `--print`(见 native-session-chat 的 agy 分支):
    // 干净结构化回复、跳过首次引导、正常「完成」→ 稳定不卡"正在处理"。终端(xterm)能力保留给
    // slash 命令(以及将来显式「打开终端」),不再对 agy 默认强制,避免 WebUI 一直卡在 TUI 里。
    const useTerminalMode = useInteractiveNativeSlash;
    // agy 用 --print,输出是干净模型回复、不存在交互式菜单;关掉 interactive-prompt 抓取,
    // 避免回复里偶发的编号列表/“press Enter”被误判成需要确认的 prompt。
    const suppressInteractivePrompt = provider === 'agy';
    const normalizedApprovalMode = normalizeApprovalMode(approvalMode);
    // codex confirm/plan(P3b)：exec --json 是单向输出流、无法回带审批决策，改走 app-server
    // JSON-RPC runner(每账号 tmux 常驻 + ws,审批经审批桥往返)。bypass 与其他 provider 零变化。
    const useCodexAppServerRunner = provider === 'codex'
      && useHeadlessStream
      && approvalModeNeedsBridge(normalizedApprovalMode);
    // opencode confirm/plan(P3c)：headless run(--dangerously-skip-permissions)无权限回路，
    // 改走常驻 `opencode serve` HTTP API runner(会话级注入 ask 规则,permission.asked 经审批桥
    // 往返 webUI)。bypass 保持现状 run 路径零变化。
    const useOpenCodeServeRunner = provider === 'opencode'
      && useHeadlessStream
      && approvalModeNeedsBridge(normalizedApprovalMode);
    try {
      if (provider === 'codex' && projectPath) {
        ensureCodexHooksEnabled({ fs });
        ensureCodexProjectRegistered(projectPath, {
          fs
        });
      }
      const {
        runNativeSessionPrompt,
        spawnNativeSessionStream,
        classifyNativeSessionFailure
      } = require('./native-session-chat');
      if (stream !== false) {
        const startedAt = Date.now();
        let firstTokenAt = 0;
        const fallbackAccountRefs = useAihServerProfile
          ? []
          : resolveNativeFallbackAccountRefs(loadServerRuntimeAccounts, provider, accountRef);
        const attemptAccountRefs = [accountRef, ...fallbackAccountRefs];
        let currentStream = null;
        ctx.res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive'
        });
        if (typeof ctx.res.flushHeaders === 'function') ctx.res.flushHeaders();

        let streamClosed = false;
        const writeSse = (payloadItem) => {
          if (streamClosed || ctx.res.writableEnded) return;
          ctx.res.write(`data: ${JSON.stringify(canonicalizeChatPayload(ctx, provider, payloadItem))}\n\n`);
        };
        const createAttemptStream = (attemptIndex) => {
          const attemptAccountRef = attemptAccountRefs[attemptIndex];
          const bufferedEvents = [];
          let attemptVisible = false;
          const handleStreamEvent = (event) => {
            if (!event) return;
            if (!useTerminalMode && event.type === 'terminal-output') {
              return;
            }
            // 新建会话拿到真实 sessionId 后立即回填 run handle，并补发 turn-started：
            // detached 重连（GET /runs?sessionId= / sessions/watch）都按 sessionId 找 run，
            // 不回填的话新会话在跑完前对刷新后的页面完全不可见。
            if (event.type === 'session-created' && event.sessionId && nativeRunHandle
              && !nativeRunHandle.sessionId) {
              nativeRunHandle.sessionId = normalizeString(event.sessionId);
              publishNativeSessionEvent(ctx, {
                provider,
                sessionId: nativeRunHandle.sessionId,
                projectDirName: resolvedProjectDirName,
                projectPath
              }, {
                type: 'session:turn-started',
                reason: 'native_session_created',
                phase: 'turn-started',
                at: Date.now(),
                runId: nativeRunHandle.runId
              });
            }
            // 交互 prompt 的出现/清除同步发布到会话事件通道：detached（刷新/断连重连）的
            // 客户端靠 sessions/watch 也能弹出/收起 PlanChoiceDock，回答走 runs/:runId/input。
            if (event.type === 'interactive-prompt' || event.type === 'interactive-prompt-cleared') {
              publishNativeSessionEvent(ctx, {
                provider,
                sessionId: (nativeRunHandle && nativeRunHandle.sessionId) || sessionId,
                projectDirName: resolvedProjectDirName,
                projectPath
              }, event.type === 'interactive-prompt'
                ? {
                    type: 'session:interactive-prompt',
                    phase: 'interactive-prompt',
                    at: Date.now(),
                    runId: nativeRunHandle && nativeRunHandle.runId,
                    prompt: event.prompt
                  }
                : {
                    type: 'session:interactive-prompt-cleared',
                    phase: 'interactive-prompt',
                    at: Date.now(),
                    runId: nativeRunHandle && nativeRunHandle.runId,
                    promptId: event.promptId,
                    reason: event.reason
                  });
            }
            if (event.type === 'retry-status') {
              publishNativeSessionEvent(ctx, {
                provider,
                sessionId: (nativeRunHandle && nativeRunHandle.sessionId) || sessionId,
                projectDirName: resolvedProjectDirName,
                projectPath
              }, {
                type: 'session:retry-status',
                phase: event.phase,
                at: Date.now(),
                runId: nativeRunHandle && nativeRunHandle.runId,
                retryStatus: event
              });
            }
            const eventPayload = {
              ...event,
              runId: nativeRunHandle.runId,
              ...createChatEventMeta(startedAt, firstTokenAt
                ? { firstTokenElapsedMs: firstTokenAt - startedAt }
                : {})
            };
            if (useTerminalMode) {
              writeSse(eventPayload);
              return;
            }
            // 交互 prompt 需要用户立刻响应，不能进「首 token 前缓冲」（agy/gemini 的 PTY 轮
            // 可能整轮都卡在 prompt 上、永远等不到首个 delta → 死锁），直接写通。
            if (event.type === 'interactive-prompt'
              || event.type === 'interactive-prompt-cleared'
              || event.type === 'retry-status') {
              writeSse(eventPayload);
              return;
            }
            if (event.type === 'delta' || event.type === 'result') {
              if (!firstTokenAt) firstTokenAt = Date.now();
              if (!attemptVisible) {
                attemptVisible = true;
                bufferedEvents.forEach((item) => writeSse(item));
                bufferedEvents.length = 0;
              }
              writeSse({
                ...event,
                runId: nativeRunHandle.runId,
                ...createChatEventMeta(startedAt, {
                  firstTokenElapsedMs: firstTokenAt - startedAt
                })
              });
              return;
            }
            if (event.type === 'error') {
              return;
            }
            bufferedEvents.push(eventPayload);
          };
          const streamInstance = useCodexAppServerRunner
            ? require('./codex-app-server-runner').startCodexAppServerTurn({
              accountRef: attemptAccountRef,
              gateway: useAihServerProfile,
              sessionId,
              projectDirName: resolvedProjectDirName,
              projectPath,
              prompt: normalizedPrompt,
              imagePaths: persistedImagePaths,
              model: nativeSessionModel,
              approvalMode: normalizedApprovalMode,
              getProfileDir,
              env: nativeProcessEnv,
              aiHomeDir: ctx.aiHomeDir,
              sessionEventBus: ctx.deps && ctx.deps.sessionEventBus,
              onEvent: handleStreamEvent
            })
            : useOpenCodeServeRunner
            ? require('./opencode-serve-runner').startOpenCodeServeTurn({
              accountRef: attemptAccountRef,
              gateway: useAihServerProfile,
              sessionId,
              projectDirName: resolvedProjectDirName,
              projectPath,
              prompt: normalizedPrompt,
              model: nativeSessionModel,
              getProfileDir,
              env: nativeProcessEnv,
              aiHomeDir: ctx.aiHomeDir,
              sessionEventBus: ctx.deps && ctx.deps.sessionEventBus,
              onEvent: handleStreamEvent
            })
            : spawnNativeSessionStream({
              provider,
              accountRef: attemptAccountRef,
              gateway: useAihServerProfile,
              sessionId,
              projectDirName: resolvedProjectDirName,
              projectPath,
              prompt: useOfficialNativeSession ? normalizedPrompt : '',
              initialInput: useInteractiveNativeSlash ? normalizedPrompt : '',
              interactiveCli: nativeCliInteractive,
              emitTerminalOutput: useTerminalMode,
              // terminalMode(slash/显式终端):只发原始 terminal-output 供 xterm 渲染,不抓
              // interactive-prompt(否则前端同时弹 TerminalDock+坏的 acknowledge)、不收编暖机 LS。
              terminalMode: useTerminalMode,
              // agy headless(--print):关掉 interactive-prompt 抓取 + 不收编暖机 LS(--print 跑完即退)。
              suppressInteractivePrompt,
              // agy --print 实测是【流式 stdout】(逐段吐字)。把 stdout 直接作为 delta 事件推给前端做
              // 真流式,而不是等整轮跑完一次性 done(之前 firstTokenElapsedMs=null、16s 后才蹦出来)。
              streamRawStdout: provider === 'agy' && !useTerminalMode,
              // 终端模式是常驻交互进程；agy transcript 的 PLANNER_RESPONSE 也只是阶段性输出。
              // 两者都必须等待进程自身退出，不能在 transcript 首次更新时提前结束本轮。
              completeOnTranscriptUpdate: provider !== 'agy'
                && useOfficialNativeSession
                && !useHeadlessStream
                && !useTerminalMode,
              imagePaths: persistedImagePaths,
              model: nativeSessionModel,
              getProfileDir,
              ensureSessionStoreLinks,
              env: nativeProcessEnv,
              // tmux 化 run 的清单/日志落盘根（server 重启后据此收养仍在跑的 run）。
              aiHomeDir: ctx.aiHomeDir,
              // 会话级审批模式(P3):confirm/plan 时 claude 挂权限工具,请求打回本机审批桥。
              approvalMode: normalizedApprovalMode,
              approvalRequestUrl: `http://127.0.0.1:${options.port || DEFAULT_SERVER_PORT}/v0/webui/internal/approval-request`,
              onEvent: handleStreamEvent
            });
          return {
            attemptAccountRef,
            bufferedEvents,
            wasVisible() {
              return attemptVisible;
            },
            streamInstance
          };
        };
        let nativeRunHandle = null;
        const initialAttempt = createAttemptStream(0);
        currentStream = initialAttempt.streamInstance;
        nativeRunHandle = {
          runId: currentStream.runId || (typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `native-stream-${Date.now()}-${Math.random().toString(16).slice(2)}`),
          provider,
          ...responseIdentity,
          sessionId,
          projectDirName: resolvedProjectDirName,
          projectPath: normalizeString(projectPath),
          startedAt,
          interactionMode: useTerminalMode ? 'terminal' : 'default',
          // detached 重连时恢复待回答的交互 prompt（GET /v0/webui/chat/runs 返回 activePrompt）。
          getActivePrompt() {
            return currentStream && typeof currentStream.getActivePrompt === 'function'
              ? (currentStream.getActivePrompt() || null)
              : null;
          },
          abort() {
            if (currentStream && typeof currentStream.abort === 'function') {
              currentStream.abort();
            }
          },
          writeInput(input, writeOptions = {}) {
            if (!currentStream || typeof currentStream.writeInput !== 'function') {
              const error = new Error('native_session_run_not_active');
              error.code = 'native_session_run_not_active';
              throw error;
            }
            return currentStream.writeInput(input, writeOptions);
          },
          writeSteer(text) {
            if (!currentStream || typeof currentStream.writeSteer !== 'function') {
              const error = new Error('native_steer_unsupported');
              error.code = 'native_steer_unsupported';
              throw error;
            }
            return currentStream.writeSteer(text);
          },
          resize(cols, rows) {
            if (!currentStream || typeof currentStream.resize !== 'function') {
              const error = new Error('native_session_run_not_active');
              error.code = 'native_session_run_not_active';
              throw error;
            }
            return currentStream.resize(cols, rows);
          }
        };
        registerNativeChatRun(nativeRunHandle);
        // 被动断连（浏览器导航/刷新、跨境代理抖动 → SSE close）**只 detach 不 kill**：停止往已关的
        // SSE 写，但让 native run 在后台跑完（CLI 写进自己的会话库、done 时刷新快照）。这样长任务
        // （如 opencode 并行子代理 review 综合，耗时几分钟）不会被一次断连腰斩成"看着没处理完"，
        // 重连后读 session messages 就能看到完整结果——对齐"关终端不丢"的持久会话理念。
        // run 不在这里 unregister（保持注册以便重连交互/显式 abort 找到它），完成/失败路径会 unregister。
        // 真正的终止走【显式 stop】→ POST /runs/:runId/abort（handleNativeChatRunAbortRequest）。
        const closeStream = () => {
          if (streamClosed) return;
          streamClosed = true;
          // 不 abort、不 unregister：run 继续，SSE 写入自然 no-op（writableEnded）。
        };

        attachAbortableRequestClose(ctx.req, closeStream, ctx.res);
        writeSse({
          type: 'ready',
          mode: 'native-session',
          provider,
          ...responseIdentity,
          sessionId,
          runId: nativeRunHandle.runId,
          interactionMode: useTerminalMode ? 'terminal' : 'default',
          slashCommand: useInteractiveNativeSlash ? normalizedPrompt : '',
          createSession: Boolean(createSession && !sessionId),
          ...createChatEventMeta(startedAt)
        });
        publishNativeSessionEvent(ctx, {
          provider,
          sessionId,
          projectDirName: resolvedProjectDirName,
          projectPath
        }, {
          type: 'session:turn-started',
          reason: 'native_session_ready',
          phase: 'turn-started',
          at: startedAt,
          runId: nativeRunHandle.runId
        });

        const runAttempt = async (attemptIndex, existingAttempt = null) => {
          const attempt = existingAttempt || createAttemptStream(attemptIndex);
          currentStream = attempt.streamInstance;
          try {
            const result = await currentStream.done;
            if (!attempt.wasVisible()) {
              attempt.bufferedEvents.forEach((item) => writeSse(item));
            }
            return {
              result,
              attemptAccountRef: attempt.attemptAccountRef
            };
          } catch (error) {
            const classifiedFailure = classifyNativeSessionFailure(provider, error);
            const canRetry = !useInteractiveNativeSlash
              && classifiedFailure.retryAnotherAccount === true
              && attemptIndex < attemptAccountRefs.length - 1
              && !firstTokenAt;
            if (canRetry) {
              return runAttempt(attemptIndex + 1);
            }
            throw error;
          }
        };

        // 注意：完成/失败的收尾（会话索引、快照刷新、session:turn-* 事件发布）必须在
        // 「streamClosed 早退」之前执行——被动断连(detached)后 SSE 已关，但后台 run 跑完时
        // 仍要让 sessions/watch 的订阅者（刷新后重连的页面）收到 turn-completed/failed、
        // 且新会话要进项目快照。否则 detached run 结束后页面永远停在"运行中"。
        runAttempt(0, initialAttempt).then(async ({ result, attemptAccountRef }) => {
          cancelApprovalsForRun(nativeRunHandle.runId, 'run_finished');
          unregisterNativeChatRun(nativeRunHandle.runId);
          const doneAt = Date.now();
          const firstTokenElapsedMs = firstTokenAt ? (firstTokenAt - startedAt) : null;
          const resolvedSessionId = String(result && result.sessionId || sessionId || '');
          nativeRunHandle.sessionId = resolvedSessionId;
          // 只要是「新建会话」这一轮就刷新项目快照——即使 resolvedSessionId 为空（codex 推断
          // 超时等），新会话也已落盘，必须刷新缓存，否则刷新页面列表看不到。
          if (createSession && !sessionId) {
            // codex 新会话若 rollout/DB 解析不出标题会被列表过滤（'未命名会话'），导致刷新后不可见。
            // 用本轮 prompt 作标题补一条 session_index 条目，让 reader 给它一个标题 → 列表可见。
            if (provider === 'codex' && resolvedSessionId) {
              try {
                require('./native-session-chat').ensureCodexSessionIndexEntry({
                  sessionId: resolvedSessionId,
                  prompt: normalizedPrompt
                });
              } catch (_error) {
                // best effort
              }
            }
            // agy 存储无 cwd → 写 sessionId→projectPath 索引，readAgyProjectsFromHost 据此入列表。
            if (provider === 'agy' && resolvedSessionId && projectPath) {
              try {
                require('./native-session-chat').ensureAgySessionProjectIndex({
                  sessionId: resolvedSessionId,
                  projectPath
                });
              } catch (_error) {
                // best effort
              }
            }
            try {
              await refreshProjectsSnapshotAfterNativeSession(ctx, provider, resolvedSessionId, resolvedProjectDirName, {
                accountRef: attemptAccountRef
              });
            } catch (_error) {
              // best effort; done event should not be blocked forever by snapshot refresh failures
            }
          }
          recordNativeSessionModelUsage(ctx, {
            provider,
            sessionId: resolvedSessionId,
            accountRef: attemptAccountRef,
            model: effectiveRequestModel,
            runId: nativeRunHandle.runId
          });
          publishNativeSessionEvent(ctx, {
            provider,
            sessionId: resolvedSessionId,
            projectDirName: resolvedProjectDirName,
            projectPath
          }, {
            type: 'session:turn-completed',
            reason: 'native_session_done',
            phase: 'turn-completed',
            at: doneAt,
            runId: nativeRunHandle.runId
          });
          if (streamClosed || ctx.res.writableEnded) return;
          writeSse({
            type: 'done',
            mode: 'native-session',
            provider,
            ...(useAihServerProfile ? responseIdentity : { accountRef: attemptAccountRef }),
            runId: nativeRunHandle.runId,
            sessionId: resolvedSessionId,
            content: result && typeof result.content === 'string' ? result.content : '',
            ...createChatEventMeta(startedAt, {
              firstTokenElapsedMs,
              totalElapsedMs: doneAt - startedAt
            })
          });
          streamClosed = true;
          ctx.res.end();
        }).catch((error) => {
          cancelApprovalsForRun(nativeRunHandle.runId, 'run_finished');
          unregisterNativeChatRun(nativeRunHandle.runId);
          const errorAt = Date.now();
          const classifiedFailure = classifyNativeSessionFailure(provider, error);
          publishNativeSessionEvent(ctx, {
            provider,
            sessionId: nativeRunHandle.sessionId || sessionId,
            projectDirName: resolvedProjectDirName,
            projectPath
          }, {
            type: 'session:turn-failed',
            reason: String(classifiedFailure.code || error && error.code || 'native_session_failed'),
            phase: 'turn-failed',
            at: errorAt,
            runId: nativeRunHandle.runId
          });
          if (streamClosed || ctx.res.writableEnded) return;
          writeSse({
            type: 'error',
            runId: nativeRunHandle.runId,
            code: String(classifiedFailure.code || error && error.code || 'native_session_failed'),
            message: String(classifiedFailure.message || (error && error.message) || error || 'native_session_failed'),
            ...createChatEventMeta(startedAt, {
              firstTokenElapsedMs: firstTokenAt ? (firstTokenAt - startedAt) : null,
              totalElapsedMs: errorAt - startedAt
            })
          });
          streamClosed = true;
          ctx.res.end();
        });
        return true;
      }

      publishNativeSessionEvent(ctx, {
        provider,
        sessionId,
        projectDirName: resolvedProjectDirName,
        projectPath
      }, {
        type: 'session:turn-started',
        reason: 'native_session_ready',
        phase: 'turn-started',
        at: Date.now()
      });
      const nativeResult = await runNativeSessionPrompt({
        provider,
        accountRef,
        gateway: useAihServerProfile,
        sessionId,
        projectDirName: resolvedProjectDirName,
        projectPath,
        prompt: normalizedPrompt,
        imagePaths: persistedImagePaths,
        model: nativeSessionModel,
        getProfileDir,
        ensureSessionStoreLinks,
        env: nativeProcessEnv,
        aiHomeDir: ctx.aiHomeDir
      });
      const resolvedSessionId = String(nativeResult && nativeResult.sessionId || sessionId || '');
      // 新建会话这一轮一律刷新快照（即使 resolvedSessionId 为空），避免新会话落盘但列表缓存陈旧。
      if (createSession && !sessionId) {
        if (provider === 'codex' && resolvedSessionId) {
          try {
            require('./native-session-chat').ensureCodexSessionIndexEntry({
              sessionId: resolvedSessionId,
              prompt: normalizedPrompt
            });
          } catch (_error) {
            // best effort
          }
        }
        if (provider === 'agy' && resolvedSessionId && projectPath) {
          try {
            require('./native-session-chat').ensureAgySessionProjectIndex({
              sessionId: resolvedSessionId,
              projectPath
            });
          } catch (_error) {
            // best effort
          }
        }
        try {
          await refreshProjectsSnapshotAfterNativeSession(ctx, provider, resolvedSessionId, resolvedProjectDirName, {
            accountRef
          });
        } catch (_error) {
          // best effort
        }
      }
      publishNativeSessionEvent(ctx, {
        provider,
        sessionId: resolvedSessionId,
        projectDirName: resolvedProjectDirName,
        projectPath
      }, {
        type: 'session:turn-completed',
        reason: 'native_session_done',
        phase: 'turn-completed',
        at: Date.now()
      });
      writeJson(ctx.res, 200, canonicalizeChatPayload(ctx, provider, {
        ok: true,
        provider,
        ...responseIdentity,
        sessionId: resolvedSessionId,
        mode: 'native-session',
        content: nativeResult.content || ''
      }));
      return true;
    } catch (error) {
      const msg = String((error && error.message) || error || 'unknown');
      const code = String(error && error.code || '');
      publishNativeSessionEvent(ctx, {
        provider,
        sessionId,
        projectDirName: resolvedProjectDirName,
        projectPath
      }, {
        type: 'session:turn-failed',
        reason: code || 'native_session_failed',
        phase: 'turn-failed',
        at: Date.now()
      });
      const statusCode = (
        code === 'native_session_invalid_context'
        || code === 'native_session_resume_unsupported'
        || code === 'missing_session_id'
        || code === 'empty_prompt'
      ) ? 400 : 500;
      const failure = {
        ok: false,
        error: 'native_session_failed',
        code,
        message: msg
      };
      if (finishStartedChatStream(ctx, provider, {
        ...failure,
        mode: 'native-session'
      })) return true;
      writeJson(ctx.res, statusCode, canonicalizeChatPayload(ctx, provider, failure));
      return true;
    }
  }

  let model = requestModel || null;
  if (!model) {
    try {
      const configDir = getToolConfigDir(provider, accountRef, { gateway: useAihServerProfile });
      const configPath = require('node:path').join(configDir, 'config.toml');
      if (fs.existsSync(configPath)) {
        const tomlContent = fs.readFileSync(configPath, 'utf8');
        const modelMatch = tomlContent.match(/^model\s*=\s*["']([^"']+)["']/m);
        if (modelMatch) model = modelMatch[1];
      }
    } catch (_error) {}
  }
  if (!model) {
    model = resolveProviderDefaultModel(provider, '', {
      state: ctx.state,
      accountRef
    });
  }

  const baseApiProxyMessages = buildApiProxyMessages(messages, images);
  let opencodeTurn = null;
  let opencodeSessionId = normalizeString(sessionId);
  if (provider === 'opencode' && (opencodeSessionId || createSession)) {
    try {
      opencodeTurn = beginOpenCodeApiProxyTurn({
        sessionId: opencodeSessionId,
        projectPath,
        prompt: normalizedPrompt,
        model
      });
      opencodeSessionId = opencodeTurn.sessionId;
    } catch (error) {
      writeJson(ctx.res, 500, canonicalizeChatPayload(ctx, provider, {
        ok: false,
        error: 'opencode_session_store_failed',
        code: String(error && error.code || ''),
        message: String((error && error.message) || error || 'opencode_session_store_failed')
      }));
      return true;
    }
  }
  const apiProxyMessages = provider === 'opencode'
    ? buildOpenCodeApiProxyMessages(baseApiProxyMessages, opencodeSessionId)
    : baseApiProxyMessages;

  const chatRequest = {
    model,
    messages: injectProjectContextMessage(
      apiProxyMessages,
      buildProjectContextMessage(fs, projectPath)
    ),
    stream: stream || false,
    ...(provider === 'opencode'
      ? { session_id: opencodeSessionId || normalizeString(sessionId) }
      : {})
  };

  if (
    provider === 'claude'
    && apiKeyMode
    && isAnthropicCompatibleClaudeBaseUrl(readClaudeApiSettings(accountRef, fs, ctx.aiHomeDir).baseUrl)
  ) {
    return handleClaudeAnthropicCompatibleChat(ctx, {
      provider,
      accountRef,
      model,
      messages: chatRequest.messages,
      stream: stream || false
    });
  }

  try {
    const { fetchWithTimeout } = require('./http-utils');
    const apiUrl = `http://127.0.0.1:${options.port || DEFAULT_SERVER_PORT}/v1/chat/completions`;
    const response = await fetchWithTimeout(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${options.clientKey || 'dummy'}`,
        'X-Provider': provider,
        ...(!useAihServerProfile ? { 'X-Account-Ref': accountRef } : {})
      },
      body: JSON.stringify(chatRequest)
    }, 60000);

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      writeJson(ctx.res, response.status, {
        ok: false,
        error: 'upstream_error',
        message: humanizeUpstreamError(errorText, {
          status: response.status,
          model,
          provider
        })
      });
      return true;
    }

    if (stream) {
      const startedAt = Date.now();
      let firstTokenAt = 0;
      ctx.res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      if (typeof ctx.res.flushHeaders === 'function') ctx.res.flushHeaders();
      const writeSse = (payloadItem) => {
        if (ctx.res.writableEnded) return;
        ctx.res.write(`data: ${JSON.stringify(canonicalizeChatPayload(ctx, provider, payloadItem))}\n\n`);
      };
      writeSse({
        type: 'ready',
        mode: 'api-proxy',
        provider,
        accountRef,
        interactionMode: 'default',
        ...createChatEventMeta(startedAt)
      });
      const adapter = createOpenAiChunkAdapter(writeSse, () => createChatEventMeta(startedAt, firstTokenAt
        ? { firstTokenElapsedMs: firstTokenAt - startedAt }
        : {}));
      const reader = response.body && typeof response.body.getReader === 'function'
        ? response.body.getReader()
        : null;
      if (!reader) {
        writeSse({
          type: 'error',
          code: 'api_proxy_stream_unavailable',
          message: 'api_proxy_stream_unavailable',
          mode: 'api-proxy',
          ...createChatEventMeta(startedAt)
        });
        ctx.res.end();
        return true;
      }
      const decoder = new TextDecoder();
      let buffer = '';
      let streamClosed = false;
      const closeStream = () => {
        if (streamClosed) return;
        streamClosed = true;
        try {
          if (reader && typeof reader.cancel === 'function') {
            reader.cancel().catch(() => {});
          }
        } catch (_error) {}
      };
      attachAbortableRequestClose(ctx.req, closeStream, ctx.res);
      try {
        while (true) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
          let boundary = buffer.indexOf('\n\n');
          while (boundary >= 0) {
            const rawBlock = buffer.slice(0, boundary).trim();
            buffer = buffer.slice(boundary + 2);
            if (rawBlock) {
              const payloadText = rawBlock
                .split('\n')
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trim())
                .join('\n');
              if (payloadText && payloadText !== '[DONE]') {
                try {
                  const parsed = JSON.parse(payloadText);
                  const deltaText = String(
                    parsed
                    && parsed.choices
                    && parsed.choices[0]
                    && parsed.choices[0].delta
                    && parsed.choices[0].delta.content
                    || ''
                  );
                  if (deltaText && !firstTokenAt) firstTokenAt = Date.now();
                  adapter.handleChunk(parsed);
                } catch (_error) {}
              }
            }
            boundary = buffer.indexOf('\n\n');
          }
          if (done) break;
          if (ctx.res.writableEnded || streamClosed) return true;
        }
      } finally {
        try {
          if (typeof reader.releaseLock === 'function') {
            reader.releaseLock();
          }
        } catch (_error) {}
      }
      const adapterState = adapter.getState();
      if (opencodeTurn) {
        try {
          completeOpenCodeApiProxyTurn({
            turn: opencodeTurn,
            projectPath,
            content: adapterState.content,
            model,
            finishReason: adapterState.finishReason,
            startedMs: startedAt
          });
          await refreshProjectsSnapshotAfterNativeSession(ctx, provider, opencodeTurn.sessionId, resolvedProjectDirName);
        } catch (_error) {
          // The upstream response has already succeeded; keep the SSE turn alive
          // and let the next project refresh recover from the session DB.
        }
      }
      adapter.finalize();
      ctx.res.end();
    } else {
      const data = await response.json();
      const content = data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : '';
      if (opencodeTurn) {
        try {
          completeOpenCodeApiProxyTurn({
            turn: opencodeTurn,
            projectPath,
            content,
            model: data.model || model,
            usage: data.usage,
            finishReason: data.choices && data.choices[0] && data.choices[0].finish_reason,
            startedMs: Date.now()
          });
          await refreshProjectsSnapshotAfterNativeSession(ctx, provider, opencodeTurn.sessionId, resolvedProjectDirName);
        } catch (_error) {
          // best effort
        }
      }

      writeJson(ctx.res, 200, canonicalizeChatPayload(ctx, provider, {
        ok: true,
        content,
        model: data.model,
        usage: data.usage,
        sessionId: opencodeTurn
          ? requireOpenCodeTurnSessionId(opencodeTurn)
          : resolveApiProxyJsonSessionId(data)
      }));
    }

    return true;
  } catch (error) {
    const failure = {
      ok: false,
      error: 'chat_failed',
      message: String((error && error.message) || error || 'unknown')
    };
    if (finishStartedChatStream(ctx, provider, {
      ...failure,
      mode: 'api-proxy'
    })) return true;
    writeJson(ctx.res, 500, canonicalizeChatPayload(ctx, provider, failure));
    return true;
  }
}

module.exports = {
  handleGetChatAttachmentRequest,
  handleGetSlashCommandsRequest,
  handleNativeChatRunListRequest,
  handleNativeChatRunInputRequest,
  handleNativeChatRunResizeRequest,
  handleNativeChatRunAbortRequest,
  handleNativeApprovalInboundRequest,
  handleNativeApprovalDecisionRequest,
  handleChatRequest,
  resolveNativeAliasModel,
  normalizeNativeSessionModel,
  humanizeUpstreamError
};
