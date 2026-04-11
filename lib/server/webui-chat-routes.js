'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  appendImagePathsToPrompt,
  persistChatImages,
  resolveChatAttachmentPath,
  guessAttachmentMimeType
} = require('./chat-attachments');
const { validateNativeSlashCommand, getProviderSlashCommands } = require('./native-slash-commands');

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

function readClaudeApiSettings(accountId, getProfileDir, getToolConfigDir) {
  const profileDir = typeof getProfileDir === 'function' ? getProfileDir('claude', accountId) : '';
  const configDir = typeof getToolConfigDir === 'function' ? getToolConfigDir('claude', accountId) : '';
  const envJson = parseJsonFileSafe(path.join(profileDir, '.aih_env.json')) || {};
  const settings = parseJsonFileSafe(path.join(configDir, 'settings.json')) || {};
  const settingsEnv = settings && settings.env && typeof settings.env === 'object' ? settings.env : {};
  const apiKey = normalizeString(
    envJson.ANTHROPIC_API_KEY
    || envJson.ANTHROPIC_AUTH_TOKEN
    || settingsEnv.ANTHROPIC_API_KEY
    || settingsEnv.ANTHROPIC_AUTH_TOKEN
  );
  const baseUrl = normalizeString(
    envJson.ANTHROPIC_BASE_URL
    || settingsEnv.ANTHROPIC_BASE_URL
  ).replace(/\/+$/, '');

  return {
    apiKey,
    baseUrl
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
      ctx.res.end();
    }
  };

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
    if (ctx.res.writableEnded) return true;
  }

  if (buffer.trim()) handleAnthropicEvent(buffer.trim());
  if (!ctx.res.writableEnded) {
    emitDone();
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
  return false;
}

function buildApiProxyMessages(messages, images) {
  const list = Array.isArray(messages) ? messages.map((message) => ({ ...message })) : [];
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
  let doneSent = false;

  function emitDone(extra = {}) {
    if (doneSent) return;
    doneSent = true;
    writeSse({
      type: 'done',
      mode: 'api-proxy',
      content,
      ...baseMeta(),
      ...extra
    });
  }

  return {
    handleChunk(parsed) {
      const choices = Array.isArray(parsed && parsed.choices) ? parsed.choices : [];
      choices.forEach((choice) => {
        const delta = choice && choice.delta && typeof choice.delta === 'object'
          ? String(choice.delta.content || '')
          : '';
        if (delta) {
          content += delta;
          writeSse({
            type: 'delta',
            delta,
            mode: 'api-proxy',
            ...baseMeta()
          });
        }
        if (choice && choice.finish_reason) {
          emitDone();
        }
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
    run.writeInput(input, { appendNewline });
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
  const useInteractiveNativeSlash = Boolean(
    ['gemini', 'codex', 'claude'].includes(String(provider || '').trim().toLowerCase())
    && slashMeta
    && slashMeta.isSlashCommand
  );

  if (!apiKeyMode && (sessionId || createSession) && normalizedPrompt) {
    try {
      const { runNativeSessionPrompt, spawnNativeSessionStream } = require('./native-session-chat');
      if (stream !== false) {
        const startedAt = Date.now();
        let firstTokenAt = 0;
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
        const nativeStream = spawnNativeSessionStream({
          provider,
          accountId,
          sessionId,
          projectDirName,
          projectPath,
          prompt: useInteractiveNativeSlash ? '' : normalizedPrompt,
          initialInput: useInteractiveNativeSlash ? normalizedPrompt : '',
          interactiveCli: useInteractiveNativeSlash,
          imagePaths: persistedImagePaths,
          model: requestModel,
          getProfileDir,
          ensureSessionStoreLinks,
          env: process.env,
          onEvent(event) {
            if (!event) return;
            if ((event.type === 'delta' || event.type === 'result') && !firstTokenAt) {
              firstTokenAt = Date.now();
            }
            writeSse({
              ...event,
              ...createChatEventMeta(startedAt, firstTokenAt
                ? { firstTokenElapsedMs: firstTokenAt - startedAt }
                : {})
            });
          }
        });
        registerNativeChatRun(nativeStream);
        const closeStream = () => {
          if (streamClosed) return;
          streamClosed = true;
          nativeStream.abort();
          unregisterNativeChatRun(nativeStream.runId);
        };

        ctx.req.on('close', closeStream);
        writeSse({
          type: 'ready',
          mode: 'native-session',
          provider,
          accountId,
          sessionId,
          runId: nativeStream.runId,
          interactionMode: useInteractiveNativeSlash ? 'terminal' : 'default',
          slashCommand: useInteractiveNativeSlash ? normalizedPrompt : '',
          createSession: Boolean(createSession && !sessionId),
          ...createChatEventMeta(startedAt)
        });

        nativeStream.done.then((result) => {
          unregisterNativeChatRun(nativeStream.runId);
          if (streamClosed || ctx.res.writableEnded) return;
          const doneAt = Date.now();
          const firstTokenElapsedMs = firstTokenAt ? (firstTokenAt - startedAt) : null;
          const resolvedSessionId = String(result && result.sessionId || sessionId || '');
          writeSse({
            type: 'done',
            mode: 'native-session',
            provider,
            accountId,
            runId: nativeStream.runId,
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
          unregisterNativeChatRun(nativeStream.runId);
          if (streamClosed || ctx.res.writableEnded) return;
          const errorAt = Date.now();
          writeSse({
            type: 'error',
            runId: nativeStream.runId,
            code: String(error && error.code || 'native_session_failed'),
            message: String((error && error.message) || error || 'native_session_failed'),
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

      const nativeResult = await runNativeSessionPrompt({
        provider,
        accountId,
        sessionId,
        projectDirName,
        projectPath,
        prompt: normalizedPrompt,
        imagePaths: persistedImagePaths,
        model: requestModel,
        getProfileDir,
        ensureSessionStoreLinks,
        env: process.env
      });
      writeJson(ctx.res, 200, {
        ok: true,
        provider,
        accountId,
        sessionId,
        mode: 'native-session',
        content: nativeResult.content || ''
      });
      return true;
    } catch (error) {
      const msg = String((error && error.message) || error || 'unknown');
      const code = String(error && error.code || '');
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

  const DEFAULT_MODELS = {
    codex: 'gpt-5.4',
    claude: 'claude-sonnet-4-20250514',
    gemini: 'gemini-2.5-pro'
  };

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
    model = DEFAULT_MODELS[provider] || 'gpt-4o';
  }

  const chatRequest = {
    model,
    messages: buildApiProxyMessages(messages, images),
    stream: stream || false
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
    const apiUrl = `http://127.0.0.1:${options.port || 8317}/v1/chat/completions`;
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
      }
      adapter.finalize();
      ctx.res.end();
    } else {
      const data = await response.json();
      const content = data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : '';

      writeJson(ctx.res, 200, {
        ok: true,
        content,
        model: data.model,
        usage: data.usage
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
  handleChatRequest
};
