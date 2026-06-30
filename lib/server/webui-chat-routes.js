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
const { loadAliases, resolveAlias } = require('./model-alias-store');
const {
  CLAUDE_CREDENTIAL_TYPES,
  readClaudeCredential
} = require('../account/claude-credential');

function parseJsonFileSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resolveNativeFallbackAccountIds(loadServerRuntimeAccounts, provider, accountId) {
  const normalizedProvider = normalizeString(provider).toLowerCase();
  const normalizedAccountId = normalizeString(accountId);
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
      .filter((account) => normalizeString(account.id) && normalizeString(account.id) !== normalizedAccountId)
      .filter((account) => now >= Number(account.cooldownUntil || 0))
      .filter((account) => now >= Number(account.authInvalidUntil || 0))
      .map((account) => normalizeString(account.id));
  } catch (_error) {
    return [];
  }
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

async function waitForNativeSessionTranscriptReadable(provider, sessionId, projectDirName, timeoutMs = 5_000) {
  const normalizedProvider = normalizeString(provider).toLowerCase();
  const normalizedSessionId = normalizeString(sessionId);
  const normalizedProjectDirName = normalizeString(projectDirName);
  if (!normalizedProvider || !normalizedSessionId) return false;

  const startedAt = Date.now();
  const { resolveSessionFilePath, readSessionMessages } = require('../sessions/session-reader');

  const isReadable = () => {
    const sessionPath = resolveSessionFilePath(normalizedProvider, {
      sessionId: normalizedSessionId,
      projectDirName: normalizedProjectDirName
    });
    if (!sessionPath || !fs.existsSync(sessionPath)) return false;
    const messages = readSessionMessages(normalizedProvider, {
      sessionId: normalizedSessionId,
      projectDirName: normalizedProjectDirName
    });
    return Array.isArray(messages) && messages.length > 0;
  };

  while ((Date.now() - startedAt) < timeoutMs) {
    if (isReadable()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return isReadable();
}

async function refreshProjectsSnapshotAfterNativeSession(ctx, provider, sessionId, projectDirName) {
  const normalizedSessionId = normalizeString(sessionId);
  // 即便没解析到 sessionId（如 codex 推断超时返回空），也要强制刷新项目快照——
  // 否则新会话已落盘但列表缓存陈旧 → 刷新页面「会话列表不可见」。有 sessionId 时先等
  // transcript 可读再刷新（拿到完整标题/消息）；没有就跳过等待直接刷新。
  if (normalizedSessionId) {
    await waitForNativeSessionTranscriptReadable(provider, normalizedSessionId, projectDirName);
  }
  const { refreshProjectsSnapshot } = require('./webui-project-cache');
  await refreshProjectsSnapshot(ctx, { forceRefresh: true });
  return true;
}

function readClaudeApiSettings(accountId, getProfileDir, getToolConfigDir) {
  const profileDir = typeof getProfileDir === 'function' ? getProfileDir('claude', accountId) : '';
  const configDir = typeof getToolConfigDir === 'function' ? getToolConfigDir('claude', accountId) : '';
  const envJson = parseJsonFileSafe(path.join(profileDir, '.aih_env.json')) || {};
  const settings = parseJsonFileSafe(path.join(configDir, 'settings.json')) || {};
  const settingsEnv = settings && settings.env && typeof settings.env === 'object' ? settings.env : {};
  const credential = readClaudeCredential({ env: envJson, settingsEnv });
  const apiKey = credential.credentialType === CLAUDE_CREDENTIAL_TYPES.AUTH_TOKEN
    ? ''
    : normalizeString(credential.token);
  const baseUrl = normalizeString(
    envJson.ANTHROPIC_BASE_URL
    || settingsEnv.ANTHROPIC_BASE_URL
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
    accountId,
    model,
    messages,
    stream
  } = request;

  const { fetchWithTimeout } = require('./http-utils');
  const claudeConfig = readClaudeApiSettings(accountId, ctx.getProfileDir, ctx.getToolConfigDir);
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
      message: errorText || `HTTP ${response.status}`
    });
    return true;
  }

  if (!stream) {
    const data = await response.json().catch(() => ({}));
    writeJson(ctx.res, 200, {
      ok: true,
      provider,
      accountId,
      mode: 'api-proxy',
      content: extractAnthropicTextFromResponse(data)
    });
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
    ctx.res.write(`data: ${JSON.stringify(payloadItem)}\n\n`);
  };

  writeSse({
    type: 'ready',
    mode: 'api-proxy',
    provider,
    accountId,
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
      accountId,
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

function detectApiKeyMode(provider, accountId, getProfileDir, getToolConfigDir) {
  const safeProvider = String(provider || '').trim().toLowerCase();
  if (typeof getProfileDir !== 'function') return false;
  const profileDir = getProfileDir(safeProvider, accountId);
  if (!profileDir) return false;
  const envJson = parseJsonFileSafe(path.join(profileDir, '.aih_env.json')) || {};

  if (safeProvider === 'codex') {
    if (String(envJson.OPENAI_API_KEY || '').trim()) return true;
    if (typeof getToolConfigDir === 'function') {
      const authJson = parseJsonFileSafe(path.join(getToolConfigDir(safeProvider, accountId), 'auth.json')) || {};
      if (String(authJson.OPENAI_API_KEY || '').trim()) return true;
    }
    return false;
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
    resolvedPath = resolveChatAttachmentPath(targetPath);
  } catch (_error) {
    ctx.writeJson(res, 404, { ok: false, error: 'chat_attachment_not_found' });
    return true;
  }

  const contentType = guessAttachmentMimeType(resolvedPath);
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
    run.writeInput(input, promptId ? { appendNewline, promptId } : { appendNewline });
    writeJson(ctx.res, 200, { ok: true, runId });
  } catch (error) {
    const code = String(error && error.code || 'native_chat_input_failed');
    if (code === 'native_session_run_not_active') {
      unregisterNativeChatRun(runId);
    }
    writeJson(ctx.res, 400, {
      ok: false,
      error: code,
      message: String((error && error.message) || error || 'native_chat_input_failed')
    });
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
    writeJson(ctx.res, 400, {
      ok: false,
      error: code,
      message: String((error && error.message) || error || 'native_chat_resize_failed')
    });
  }
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
    accountId,
    stream,
    model: requestModel,
    prompt,
    createSession,
    sessionId,
    projectDirName,
    projectPath,
    images
  } = payload;

  if (!provider || !accountId) {
    writeJson(ctx.res, 400, { ok: false, error: 'missing_account_info', detail: 'provider and accountId are required' });
    return true;
  }

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
  const apiKeyMode = detectApiKeyMode(provider, accountId, getProfileDir, getToolConfigDir);

  if (Array.isArray(images) && images.length > 0) {
    try {
      const profileDir = typeof getProfileDir === 'function'
        ? getProfileDir(provider, accountId)
        : '';
      persistedImagePaths = persistChatImages(images, {
        fs,
        provider,
        profileDir,
        projectPath
      });
      normalizedPrompt = appendImagePathsToPrompt(normalizedPrompt, persistedImagePaths);
    } catch (error) {
      writeJson(ctx.res, 400, {
        ok: false,
        error: 'invalid_chat_images',
        message: String((error && error.message) || error || 'invalid_chat_images')
      });
      return true;
    }
  }

  let slashMeta = null;
  try {
    slashMeta = validateNativeSlashCommand(provider, normalizedPrompt);
  } catch (error) {
    const code = String(error && error.code || 'native_slash_command_unsupported');
    writeJson(ctx.res, 400, {
      ok: false,
      error: code,
      code,
      message: String((error && error.message) || error || 'native_slash_command_unsupported'),
      commands: Array.isArray(error && error.commands) ? error.commands : []
    });
    return true;
  }
  const webuiNativeSessionProvider = isOfficialNativeSessionProvider(provider) && provider !== 'opencode';
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
  const runNativeInteractive = (sessionId || createSession) && normalizedPrompt && (
    useInteractiveNativeSlash || (!apiKeyMode && useOfficialNativeSession)
  );
  if (runNativeInteractive) {
    const useClaudeHeadlessStream = provider === 'claude' && useOfficialNativeSession && !useInteractiveNativeSlash;
    const nativeCliInteractive = !useClaudeHeadlessStream;
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
        const fallbackAccountIds = resolveNativeFallbackAccountIds(loadServerRuntimeAccounts, provider, accountId);
        const attemptAccountIds = [accountId, ...fallbackAccountIds];
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
          ctx.res.write(`data: ${JSON.stringify(payloadItem)}\n\n`);
        };
        const createAttemptStream = (attemptIndex) => {
          const attemptAccountId = attemptAccountIds[attemptIndex];
          const bufferedEvents = [];
          let attemptVisible = false;
          const streamInstance = spawnNativeSessionStream({
            provider,
            accountId: attemptAccountId,
            sessionId,
            projectDirName: resolvedProjectDirName,
            projectPath,
            prompt: useOfficialNativeSession ? normalizedPrompt : '',
            initialInput: useInteractiveNativeSlash ? normalizedPrompt : '',
            interactiveCli: nativeCliInteractive,
            emitTerminalOutput: useInteractiveNativeSlash,
            completeOnTranscriptUpdate: useOfficialNativeSession && !useClaudeHeadlessStream,
            imagePaths: persistedImagePaths,
            model: nativeSessionModel,
            getProfileDir,
            ensureSessionStoreLinks,
            env: process.env,
            onEvent(event) {
              if (!event) return;
              if (!useInteractiveNativeSlash && event.type === 'terminal-output') {
                return;
              }
              const eventPayload = {
                ...event,
                runId: nativeRunHandle.runId,
                ...createChatEventMeta(startedAt, firstTokenAt
                  ? { firstTokenElapsedMs: firstTokenAt - startedAt }
                  : {})
              };
              if (useInteractiveNativeSlash) {
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
            }
          });
          return {
            attemptAccountId,
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
          sessionId,
          projectDirName: resolvedProjectDirName,
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
        const closeStream = () => {
          if (streamClosed) return;
          streamClosed = true;
          nativeRunHandle.abort();
          unregisterNativeChatRun(nativeRunHandle.runId);
        };

        attachAbortableRequestClose(ctx.req, closeStream, ctx.res);
        writeSse({
          type: 'ready',
          mode: 'native-session',
          provider,
          accountId,
          sessionId,
          runId: nativeRunHandle.runId,
          interactionMode: useInteractiveNativeSlash ? 'terminal' : 'default',
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
          at: startedAt
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
              attemptAccountId: attempt.attemptAccountId
            };
          } catch (error) {
            const classifiedFailure = classifyNativeSessionFailure(provider, error);
            const canRetry = !useInteractiveNativeSlash
              && classifiedFailure.retryAnotherAccount === true
              && attemptIndex < attemptAccountIds.length - 1
              && !firstTokenAt;
            if (canRetry) {
              return runAttempt(attemptIndex + 1);
            }
            throw error;
          }
        };

        runAttempt(0, initialAttempt).then(async ({ result, attemptAccountId }) => {
          unregisterNativeChatRun(nativeRunHandle.runId);
          if (streamClosed || ctx.res.writableEnded) return;
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
              await refreshProjectsSnapshotAfterNativeSession(ctx, provider, resolvedSessionId, resolvedProjectDirName);
            } catch (_error) {
              // best effort; done event should not be blocked forever by snapshot refresh failures
            }
          }
          writeSse({
            type: 'done',
            mode: 'native-session',
            provider,
            accountId: attemptAccountId,
            runId: nativeRunHandle.runId,
            sessionId: resolvedSessionId,
            content: result && typeof result.content === 'string' ? result.content : '',
            ...createChatEventMeta(startedAt, {
              firstTokenElapsedMs,
              totalElapsedMs: doneAt - startedAt
            })
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
            at: doneAt
          });
          streamClosed = true;
          ctx.res.end();
        }).catch((error) => {
          unregisterNativeChatRun(nativeRunHandle.runId);
          if (streamClosed || ctx.res.writableEnded) return;
          const errorAt = Date.now();
          const classifiedFailure = classifyNativeSessionFailure(provider, error);
          publishNativeSessionEvent(ctx, {
            provider,
            sessionId,
            projectDirName: resolvedProjectDirName,
            projectPath
          }, {
            type: 'session:turn-failed',
            reason: String(classifiedFailure.code || error && error.code || 'native_session_failed'),
            phase: 'turn-failed',
            at: errorAt
          });
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
        accountId,
        sessionId,
        projectDirName: resolvedProjectDirName,
        projectPath,
        prompt: normalizedPrompt,
        imagePaths: persistedImagePaths,
        model: nativeSessionModel,
        getProfileDir,
        ensureSessionStoreLinks,
        env: process.env
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
          await refreshProjectsSnapshotAfterNativeSession(ctx, provider, resolvedSessionId, resolvedProjectDirName);
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
      writeJson(ctx.res, 200, {
        ok: true,
        provider,
        accountId,
        sessionId: resolvedSessionId,
        mode: 'native-session',
        content: nativeResult.content || ''
      });
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
      writeJson(ctx.res, statusCode, {
        ok: false,
        error: 'native_session_failed',
        code,
        message: msg
      });
      return true;
    }
  }

  let model = requestModel || null;
  if (!model) {
    try {
      const configDir = getToolConfigDir(provider, accountId);
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
      accountId
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
      writeJson(ctx.res, 500, {
        ok: false,
        error: 'opencode_session_store_failed',
        code: String(error && error.code || ''),
        message: String((error && error.message) || error || 'opencode_session_store_failed')
      });
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
    && isAnthropicCompatibleClaudeBaseUrl(readClaudeApiSettings(accountId, getProfileDir, getToolConfigDir).baseUrl)
  ) {
    return handleClaudeAnthropicCompatibleChat(ctx, {
      provider,
      accountId,
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
        'X-Account-Id': accountId
      },
      body: JSON.stringify(chatRequest)
    }, 60000);

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      writeJson(ctx.res, response.status, {
        ok: false,
        error: 'upstream_error',
        message: errorText || `HTTP ${response.status}`
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
        ctx.res.write(`data: ${JSON.stringify(payloadItem)}\n\n`);
      };
      writeSse({
        type: 'ready',
        mode: 'api-proxy',
        provider,
        accountId,
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

      writeJson(ctx.res, 200, {
        ok: true,
        content,
        model: data.model,
        usage: data.usage,
        sessionId: opencodeTurn
          ? requireOpenCodeTurnSessionId(opencodeTurn)
          : resolveApiProxyJsonSessionId(data)
      });
    }

    return true;
  } catch (error) {
    writeJson(ctx.res, 500, {
      ok: false,
      error: 'chat_failed',
      message: String((error && error.message) || error || 'unknown')
    });
    return true;
  }
}

module.exports = {
  handleGetChatAttachmentRequest,
  handleGetSlashCommandsRequest,
  handleNativeChatRunInputRequest,
  handleNativeChatRunResizeRequest,
  handleChatRequest,
  resolveNativeAliasModel,
  normalizeNativeSessionModel
};
