'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { StringDecoder } = require('node:string_decoder');

const SESSIONS_PATH = '/v0/webui/chat/sessions';
const DEFAULT_RECONNECT_DELAY_MS = 400;
const MAX_RECONNECT_DELAY_MS = 5000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 5;
const MAX_SSE_ERROR_BODY_BYTES = 64 * 1024;

class DesktopChatRuntimeError extends Error {
  constructor(code, statusCode = 0, details, requestId, message) {
    const diagnostic = typeof message === 'string' && message.trim()
      ? message.trim()
      : String(code || 'chat_runtime_failed');
    super(diagnostic);
    this.name = 'DesktopChatRuntimeError';
    this.code = String(code || 'chat_runtime_failed');
    this.statusCode = Number.isSafeInteger(statusCode) ? statusCode : 0;
    if (details !== undefined) this.details = details;
    if (requestId !== undefined) this.requestId = requestId;
  }
}

function resolveBaseUrl(options = {}) {
  const rawBaseUrl = options.baseUrl !== undefined ? options.baseUrl : options.origin;
  if (rawBaseUrl !== undefined && rawBaseUrl !== null && String(rawBaseUrl).trim() !== '') {
    let parsed;
    try {
      parsed = new URL(String(rawBaseUrl).trim());
    } catch (_error) {
      throw new TypeError('desktop chat runtime client requires valid http(s) baseUrl');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new TypeError('desktop chat runtime client requires valid http(s) baseUrl');
    }
    return parsed.origin + parsed.pathname.replace(/\/+$/, '');
  }
  if (options.port !== undefined && options.port !== null && String(options.port).trim() !== '') {
    const port = Number(options.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new TypeError('desktop chat runtime client requires valid port');
    }
    return `http://127.0.0.1:${port}`;
  }
  return '';
}

function createDesktopChatRuntimeClient(options = {}) {
  const baseUrl = resolveBaseUrl(options);
  const customFetch = typeof options.fetch === 'function' ? options.fetch : null;
  const openEvents = typeof options.openEvents === 'function' ? options.openEvents : null;
  if (!baseUrl && !customFetch) {
    throw new TypeError('desktop chat runtime client requires baseUrl/port or fetch');
  }
  const idFactory = typeof options.idFactory === 'function'
    ? options.idFactory
    : () => crypto.randomUUID();
  const reconnectEnabled = options.reconnect !== false;
  const reconnectDelayMs = normalizePositiveDelay(options.reconnectDelayMs, DEFAULT_RECONNECT_DELAY_MS);
  const maxReconnectAttempts = normalizeNonNegativeCount(options.maxReconnectAttempts, DEFAULT_MAX_RECONNECT_ATTEMPTS);
  const requestTimeoutMs = Number.isFinite(Number(options.requestTimeoutMs)) && Number(options.requestTimeoutMs) > 0
    ? Math.trunc(Number(options.requestTimeoutMs))
    : 0;
  const streams = new Set();
  const pendingCommands = new Map();
  let closed = false;

  function resolveUrl(relativePath) {
    return baseUrl ? `${baseUrl}${relativePath}` : relativePath;
  }

  function readAuthHeaders() {
    const headers = {};
    let keyValue = options.managementKey;
    if (typeof options.getManagementKey === 'function') {
      try {
        keyValue = options.getManagementKey();
      } catch (error) {
        throw new DesktopChatRuntimeError(
          'chat_runtime_auth_unavailable',
          0,
          undefined,
          undefined,
          error && error.message
        );
      }
    }
    const managementKey = typeof keyValue === 'string' ? keyValue.trim() : '';
    if (managementKey) headers.authorization = `Bearer ${managementKey}`;

    let serverIdValue = options.serverId;
    if (typeof options.getServerId === 'function') {
      try {
        serverIdValue = options.getServerId();
      } catch (_error) {
        serverIdValue = '';
      }
    }
    const serverId = typeof serverIdValue === 'string' ? serverIdValue.trim() : '';
    if (serverId) headers['x-aih-server-id'] = serverId;
    return headers;
  }

  function nextId(kind) {
    const value = idFactory(kind);
    const id = String(value || '').trim();
    if (!id) throw new DesktopChatRuntimeError('chat_runtime_request_id_invalid');
    return id;
  }

  function ensureOpen() {
    if (closed) throw new DesktopChatRuntimeError('chat_runtime_client_closed');
  }

  async function createSession(target) {
    ensureOpen();
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
      throw new DesktopChatRuntimeError('chat_runtime_session_target_invalid');
    }
    const response = await requestJson(SESSIONS_PATH, jsonRequest('POST', { ...target }));
    const session = asRecord(response.session, 'chat_runtime_session_invalid');
    return normalizeSession(session);
  }

  async function uploadAttachments(sessionId, input) {
    ensureOpen();
    const id = requiredText(sessionId, 'chat_runtime_session_id_invalid');
    const list = Array.isArray(input)
      ? input
      : (input && typeof input === 'object' && Array.isArray(input.attachments) ? input.attachments : null);
    if (!list || list.length === 0) {
      throw new DesktopChatRuntimeError('chat_runtime_attachments_invalid');
    }
    const response = await requestJson(
      `${SESSIONS_PATH}/${encodeURIComponent(id)}/attachments`,
      jsonRequest('POST', { attachments: list })
    );
    if (response.sessionId !== undefined && response.sessionId !== id) {
      throw new DesktopChatRuntimeError('chat_runtime_session_mismatch', 0, undefined, response.requestId);
    }
    if (!Array.isArray(response.attachments)) {
      throw new DesktopChatRuntimeError('chat_runtime_attachments_response_invalid', 0, undefined, response.requestId);
    }
    for (const item of response.attachments) {
      const record = asRecord(item, 'chat_runtime_attachments_response_invalid');
      const attachmentId = typeof record.attachmentId === 'string' && record.attachmentId.trim()
        ? record.attachmentId.trim()
        : (typeof record.id === 'string' && record.id.trim() ? record.id.trim() : '');
      if (!attachmentId) {
        throw new DesktopChatRuntimeError('chat_runtime_attachments_response_invalid', 0, undefined, response.requestId);
      }
    }
    return response.attachments;
  }

  function start(sessionId, after = 0) {
    ensureOpen();
    const id = requiredText(sessionId, 'chat_runtime_session_id_invalid');
    const cursor = normalizeCursor(after);
    const requestId = nextId('events');
    let currentCursor = cursor;
    let streamClosed = false;
    let attemptSeq = 0;
    let openedOnce = false;
    let sawSessionClosed = false;
    let reconnectAttempts = 0;
    let reconnectTimer = null;
    let abortAttempt = null;
    let customSource = null;

    const eventListeners = new Set();
    const errorListeners = new Set();
    const wrapper = {
      sessionId: id,
      requestId,
      get cursor() { return currentCursor; },
      onmessage: null,
      onopen: null,
      onerror: null,
      onEvent(listener) { if (typeof listener === 'function') eventListeners.add(listener); return this; },
      onError(listener) { if (typeof listener === 'function') errorListeners.add(listener); return this; },
      close() {
        if (streamClosed) return;
        closeInternal();
      }
    };

    function closeInternal() {
      streamClosed = true;
      attemptSeq += 1;
      streams.delete(wrapper);
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (abortAttempt) {
        try { abortAttempt(); } catch (_error) { /* best effort */ }
        abortAttempt = null;
      }
      if (customSource) {
        try { customSource.close?.(); } catch (_error) { /* best effort */ }
        customSource = null;
      }
    }

    function emitError(error) {
      const normalized = normalizeTransportError(error, requestId);
      if (typeof wrapper.onerror === 'function') wrapper.onerror(normalized);
      for (const listener of errorListeners) listener(normalized);
    }

    function dispatchMessage(rawMessage) {
      let event;
      try {
        event = parseEventMessage(rawMessage, id);
      } catch (error) {
        const fatal = normalizeTransportError(error, requestId);
        fatal.retryable = false;
        closeInternal();
        emitError(fatal);
        return false;
      }
      if (!event) return true;
      if (event.requestId !== undefined && event.requestId !== requestId) return true;
      const seq = event.seq;
      if (seq > 0 && seq <= currentCursor) return true;
      if (seq > 0) currentCursor = seq;
      if (event.type === 'session.closed') sawSessionClosed = true;
      if (typeof wrapper.onmessage === 'function') wrapper.onmessage({ ...rawMessage, data: event });
      for (const listener of eventListeners) listener(event);
      return true;
    }

    streams.add(wrapper);

    if (openEvents) {
      const targetUrl = resolveUrl(`${SESSIONS_PATH}/${encodeURIComponent(id)}/events?after=${currentCursor}`);
      let headers = {};
      try {
        headers = readAuthHeaders();
      } catch (error) {
        queueMicrotask(() => {
          if (streamClosed || closed) return;
          closeInternal();
          error.retryable = false;
          emitError(error);
        });
        return wrapper;
      }
      customSource = openEvents(targetUrl, { headers, cursor: currentCursor, sessionId: id, requestId });
      if (!customSource || typeof customSource !== 'object') {
        streams.delete(wrapper);
        throw new DesktopChatRuntimeError('chat_runtime_event_stream_invalid', 0, undefined, requestId);
      }
      customSource.onopen = (event) => { if (!streamClosed) wrapper.onopen?.(event); };
      customSource.onerror = (event) => { if (!streamClosed) emitError(event); };
      customSource.onmessage = (message) => {
        if (streamClosed) return;
        dispatchMessage(message);
      };
      return wrapper;
    }

    const connector = customFetch
      ? (connectOpts) => connectFetchSse(customFetch, connectOpts)
      : (connectOpts) => connectNodeHttpSse(connectOpts);

    function handleStreamFailure(error, forceFatal) {
      if (streamClosed || closed) return;
      const normalized = normalizeTransportError(error, requestId);
      const canRetry = !forceFatal && openedOnce && reconnectEnabled && reconnectAttempts < maxReconnectAttempts;
      if (!canRetry) {
        normalized.retryable = false;
        closeInternal();
        emitError(normalized);
        return;
      }
      reconnectAttempts += 1;
      const delay = Math.min(reconnectDelayMs * (2 ** (reconnectAttempts - 1)), MAX_RECONNECT_DELAY_MS);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
      reconnectTimer.unref?.();
    }

    function connect() {
      if (streamClosed || closed) return;
      const attempt = ++attemptSeq;
      let headers;
      try {
        headers = {
          ...readAuthHeaders(),
          accept: 'text/event-stream',
          'cache-control': 'no-cache',
          ...(currentCursor > 0 ? { 'last-event-id': String(currentCursor) } : {})
        };
      } catch (error) {
        handleStreamFailure(error, true);
        return;
      }

      const targetUrl = resolveUrl(`${SESSIONS_PATH}/${encodeURIComponent(id)}/events?after=${currentCursor}`);
      const parser = createSseFrameDecoder((frame) => {
        if (attempt !== attemptSeq || streamClosed || closed) return;
        dispatchMessage(frame);
      });

      abortAttempt = connector({
        url: targetUrl,
        headers,
        onOpen() {
          if (attempt !== attemptSeq || streamClosed || closed) return;
          openedOnce = true;
          reconnectAttempts = 0;
          wrapper.onopen?.({ type: 'open' });
        },
        onChunk(chunk) {
          if (attempt !== attemptSeq || streamClosed || closed) return;
          parser.push(chunk);
        },
        onHttpError(status, payload) {
          if (attempt !== attemptSeq || streamClosed || closed) return;
          abortAttempt = null;
          const httpError = buildHttpError(status, payload, requestId);
          const fatal = !openedOnce || !reconnectEnabled || (status >= 400 && status < 500);
          handleStreamFailure(httpError, fatal);
        },
        onTransportError(error) {
          if (attempt !== attemptSeq || streamClosed || closed) return;
          abortAttempt = null;
          if (sawSessionClosed) {
            closeInternal();
            return;
          }
          handleStreamFailure(error, !openedOnce);
        },
        onEnd() {
          if (attempt !== attemptSeq || streamClosed || closed) return;
          abortAttempt = null;
          parser.finish();
          if (streamClosed || closed) return;
          if (sawSessionClosed) {
            closeInternal();
            return;
          }
          handleStreamFailure(
            new DesktopChatRuntimeError('chat_runtime_event_stream_closed', 0, undefined, requestId),
            !openedOnce
          );
        }
      });
    }

    queueMicrotask(connect);
    return wrapper;
  }

  async function dispatchCommand(sessionId, command = {}) {
    ensureOpen();
    const id = requiredText(sessionId, 'chat_runtime_session_id_invalid');
    const source = asRecord(command, 'chat_command_invalid');
    const type = requiredText(source.type, 'chat_command_type_invalid');
    const commandId = requiredText(source.commandId || nextId('command'), 'chat_command_id_invalid');
    const requestId = requiredText(source.requestId || nextId('request'), 'chat_runtime_request_id_invalid');
    const payload = source.payload === undefined
      ? {}
      : asRecord(source.payload, 'chat_command_payload_invalid');
    return dispatch(id, commandId, requestId, { type, payload });
  }

  async function sendTurn(sessionId, text, turnOptions = {}) {
    ensureOpen();
    const id = requiredText(sessionId, 'chat_runtime_session_id_invalid');
    const content = requiredText(text, 'chat_turn_content_required');
    const optionsRecord = turnOptions && typeof turnOptions === 'object' ? turnOptions : {};
    const commandId = requiredText(optionsRecord.commandId || nextId('command'), 'chat_command_id_invalid');
    const requestId = requiredText(optionsRecord.requestId || nextId('request'), 'chat_runtime_request_id_invalid');
    const payload = {
      ...(optionsRecord.payload && typeof optionsRecord.payload === 'object' && !Array.isArray(optionsRecord.payload)
        ? optionsRecord.payload
        : {}),
      content
    };
    for (const key of ['model', 'reasoningEffort', 'attachmentIds']) {
      if (optionsRecord[key] !== undefined) payload[key] = optionsRecord[key];
    }
    return dispatch(id, commandId, requestId, { type: 'turn.submit', payload });
  }

  async function stopTurn(sessionId, commandId) {
    ensureOpen();
    const id = requiredText(sessionId, 'chat_runtime_session_id_invalid');
    const stopId = requiredText(commandId || nextId('stop'), 'chat_command_id_invalid');
    const requestId = nextId('request');
    return dispatch(id, stopId, requestId, {
      type: 'turn.interrupt',
      payload: { reason: 'user_stop' }
    });
  }

  function dispatch(sessionId, commandId, requestId, command) {
    const existing = pendingCommands.get(commandId);
    if (existing) {
      if (existing.sessionId !== sessionId || existing.fingerprint !== commandFingerprint(command)) {
        return Promise.reject(
          new DesktopChatRuntimeError('chat_runtime_command_idempotency_conflict', 409, undefined, requestId)
        );
      }
      return existing.promise;
    }
    const promise = requestJson(
      `${SESSIONS_PATH}/${encodeURIComponent(sessionId)}/commands`,
      jsonRequest('POST', {
        requestId,
        commandId,
        sessionId,
        type: command.type,
        payload: command.payload
      })
    )
      .then((response) => normalizeCommandResult(response, sessionId, commandId, requestId))
      .finally(() => pendingCommands.delete(commandId));
    pendingCommands.set(commandId, { promise, sessionId, fingerprint: commandFingerprint(command) });
    return promise;
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const stream of [...streams]) stream.close();
    pendingCommands.clear();
  }

  return { createSession, start, uploadAttachments, dispatchCommand, sendTurn, stopTurn, close };

  async function requestJson(relativePath, init) {
    const targetUrl = resolveUrl(relativePath);
    const authHeaders = readAuthHeaders();
    const mergedInit = {
      ...init,
      headers: {
        accept: 'application/json',
        ...authHeaders,
        ...(init.headers || {})
      }
    };
    const response = customFetch
      ? await performFetchJsonRequest(customFetch, targetUrl, mergedInit)
      : await performNodeHttpJsonRequest(targetUrl, mergedInit, requestTimeoutMs);

    const body = asRecord(response.payload, 'chat_runtime_response_invalid');
    if (!response.ok) {
      throw buildHttpError(response.status, body);
    }
    if (body.ok !== true) {
      throw new DesktopChatRuntimeError(
        'chat_runtime_response_not_ok',
        response.status,
        body.details,
        body.requestId,
        body.message
      );
    }
    return body;
  }
}

async function performFetchJsonRequest(fetchImpl, targetUrl, init) {
  let response;
  try {
    response = await fetchImpl(targetUrl, init);
  } catch (error) {
    throw new DesktopChatRuntimeError(
      'chat_runtime_transport_failed',
      0,
      undefined,
      undefined,
      error && error.message
    );
  }
  if (!response || typeof response !== 'object') {
    throw new DesktopChatRuntimeError('chat_runtime_response_invalid');
  }
  let payload;
  try {
    payload = await response.json();
  } catch (_error) {
    throw new DesktopChatRuntimeError('chat_runtime_response_json_invalid', Number(response.status) || 0);
  }
  return {
    ok: Boolean(response.ok),
    status: Number(response.status) || 0,
    payload
  };
}

function performNodeHttpJsonRequest(targetUrl, init, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const transport = parsed.protocol === 'https:' ? https : http;
    const bodyBuffer = typeof init.body === 'string' ? Buffer.from(init.body, 'utf8') : null;
    const headers = {
      ...(init.headers || {}),
      ...(bodyBuffer ? { 'content-length': String(bodyBuffer.byteLength) } : {})
    };
    const req = transport.request(parsed, { method: init.method || 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('error', (error) => {
        reject(new DesktopChatRuntimeError(
          'chat_runtime_transport_failed',
          Number(res.statusCode) || 0,
          undefined,
          undefined,
          error && error.message
        ));
      });
      res.on('end', () => {
        const status = Number(res.statusCode) || 0;
        const rawText = Buffer.concat(chunks).toString('utf8');
        let payload;
        try {
          payload = JSON.parse(rawText);
        } catch (_error) {
          reject(new DesktopChatRuntimeError('chat_runtime_response_json_invalid', status));
          return;
        }
        resolve({
          ok: status >= 200 && status < 300,
          status,
          payload
        });
      });
    });
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new DesktopChatRuntimeError('chat_runtime_request_timeout'));
      });
    } else {
      req.setTimeout(0);
    }
    req.on('error', (error) => {
      if (error instanceof DesktopChatRuntimeError) {
        reject(error);
        return;
      }
      reject(new DesktopChatRuntimeError(
        'chat_runtime_transport_failed',
        0,
        undefined,
        undefined,
        error && error.message
      ));
    });
    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

function connectNodeHttpSse({ url, headers, onOpen, onChunk, onHttpError, onTransportError, onEnd }) {
  let disposed = false;
  let activeResponse = null;
  const parsed = new URL(url);
  const transport = parsed.protocol === 'https:' ? https : http;
  const req = transport.request(parsed, { method: 'GET', headers }, (res) => {
    if (disposed) {
      res.destroy();
      return;
    }
    activeResponse = res;
    res.setTimeout(0);
    const status = Number(res.statusCode) || 0;
    if (status < 200 || status >= 300) {
      let bytes = 0;
      const chunks = [];
      res.on('data', (chunk) => {
        if (bytes < MAX_SSE_ERROR_BODY_BYTES) {
          chunks.push(chunk);
          bytes += chunk.length;
        }
      });
      res.on('error', (error) => {
        if (!disposed) onTransportError(error);
      });
      res.on('end', () => {
        if (disposed) return;
        const payload = tryParseJsonObject(Buffer.concat(chunks).toString('utf8'));
        onHttpError(status, payload);
      });
      return;
    }
    onOpen();
    res.on('data', (chunk) => {
      if (!disposed) onChunk(chunk);
    });
    res.on('error', (error) => {
      if (!disposed) onTransportError(error);
    });
    res.on('end', () => {
      if (!disposed) onEnd();
    });
  });
  req.setTimeout(0);
  req.on('socket', (socket) => {
    socket.setKeepAlive?.(true);
  });
  req.on('error', (error) => {
    if (!disposed) onTransportError(error);
  });
  req.end();
  return () => {
    disposed = true;
    try { activeResponse?.destroy(); } catch (_error) { /* best effort */ }
    try { req.destroy(); } catch (_error) { /* best effort */ }
  };
}

function connectFetchSse(fetchImpl, { url, headers, onOpen, onChunk, onHttpError, onTransportError, onEnd }) {
  let disposed = false;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let reader = null;

  (async () => {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers,
        ...(controller ? { signal: controller.signal } : {})
      });
    } catch (error) {
      if (!disposed) {
        onTransportError(new DesktopChatRuntimeError(
          'chat_runtime_transport_failed',
          0,
          undefined,
          undefined,
          error && error.message
        ));
      }
      return;
    }
    if (disposed) return;
    if (!response || typeof response !== 'object') {
      onTransportError(new DesktopChatRuntimeError('chat_runtime_response_invalid'));
      return;
    }
    const status = Number(response.status) || 0;
    if (!response.ok) {
      let payload = null;
      try {
        payload = typeof response.json === 'function'
          ? await response.json()
          : (typeof response.text === 'function' ? tryParseJsonObject(await response.text()) : null);
      } catch (_error) {
        payload = null;
      }
      if (!disposed) onHttpError(status, payload);
      return;
    }
    onOpen();
    const body = response.body;
    if (!body) {
      if (!disposed) onEnd();
      return;
    }
    if (typeof body.getReader === 'function') {
      reader = body.getReader();
      while (!disposed) {
        const step = await reader.read();
        if (disposed) return;
        if (step.done) break;
        if (step.value !== undefined) onChunk(step.value);
      }
    } else if (typeof body[Symbol.asyncIterator] === 'function') {
      for await (const chunk of body) {
        if (disposed) return;
        if (chunk !== undefined) onChunk(chunk);
      }
    }
    if (!disposed) onEnd();
  })().catch((error) => {
    if (!disposed) onTransportError(error);
  });

  return () => {
    disposed = true;
    try { controller?.abort(); } catch (_error) { /* best effort */ }
    try { reader?.cancel?.().catch(() => {}); } catch (_error) { /* best effort */ }
  };
}

function createSseFrameDecoder(onFrame) {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let eventType = '';
  let lastEventId = '';
  let dataLines = [];

  function processLines(finalChunk) {
    let cursor = 0;
    while (cursor <= buffer.length) {
      const br = findLineBreak(buffer, cursor, finalChunk);
      if (!br) break;
      const line = buffer.slice(cursor, br.lineEnd);
      cursor = br.nextStart;
      handleLine(line);
    }
    buffer = cursor < buffer.length ? buffer.slice(cursor) : '';
  }

  function handleLine(line) {
    if (line === '') {
      if (dataLines.length > 0) {
        const data = dataLines.join('\n');
        const type = eventType || 'message';
        dataLines = [];
        eventType = '';
        onFrame({ data, type, lastEventId });
      } else {
        eventType = '';
      }
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon >= 0 ? line.slice(0, colon) : line;
    let value = colon >= 0 ? line.slice(colon + 1) : '';
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') dataLines.push(value);
    else if (field === 'event') eventType = value;
    else if (field === 'id' && !value.includes('\0')) lastEventId = value;
  }

  return {
    push(chunk) {
      if (typeof chunk === 'string') buffer += chunk;
      else if (Buffer.isBuffer(chunk)) buffer += decoder.write(chunk);
      else if (chunk instanceof Uint8Array) buffer += decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      processLines(false);
    },
    finish() {
      buffer += decoder.end();
      processLines(true);
      if (buffer.length > 0) {
        handleLine(buffer);
        buffer = '';
      }
    }
  };
}

function findLineBreak(text, startIndex, finalChunk) {
  for (let i = startIndex; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 10) return { lineEnd: i, nextStart: i + 1 };
    if (code === 13) {
      if (i + 1 >= text.length && !finalChunk) return null;
      const nextStart = text.charCodeAt(i + 1) === 10 ? i + 2 : i + 1;
      return { lineEnd: i, nextStart };
    }
  }
  return null;
}

function buildHttpError(status, payload, fallbackRequestId) {
  const body = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const code = typeof body.error === 'string' && body.error.trim()
    ? body.error.trim()
    : `chat_runtime_http_${status}`;
  return new DesktopChatRuntimeError(
    code,
    Number(status) || 0,
    body.details,
    body.requestId !== undefined ? body.requestId : fallbackRequestId,
    body.message
  );
}

function tryParseJsonObject(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function normalizePositiveDelay(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? Math.trunc(num) : fallback;
}

function normalizeNonNegativeCount(value, fallback) {
  const num = Number(value);
  return Number.isInteger(num) && num >= 0 ? num : fallback;
}

function jsonRequest(method, body) {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function normalizeSession(source) {
  const sessionId = requiredText(source.sessionId, 'chat_runtime_session_id_invalid');
  const state = requiredState(source.state);
  const lastEventSeq = nonNegativeInteger(source.lastEventSeq, 'chat_runtime_session_seq_invalid');
  const createdAt = nonNegativeInteger(source.createdAt, 'chat_runtime_session_created_at_invalid');
  const updatedAt = nonNegativeInteger(source.updatedAt, 'chat_runtime_session_updated_at_invalid');
  const policy = asRecord(source.policy, 'chat_runtime_session_policy_invalid');
  const runtimeBinding = asRecord(source.runtimeBinding, 'chat_runtime_session_binding_invalid');
  const capabilitySnapshot = normalizeCapabilitySnapshot(source.capabilitySnapshot);
  return {
    ...source,
    sessionId,
    provider: requiredText(source.provider, 'chat_runtime_session_provider_invalid'),
    executionAccountRef: requiredText(source.executionAccountRef, 'chat_runtime_session_execution_account_invalid'),
    projectPath: typeof source.projectPath === 'string' ? source.projectPath : '',
    state,
    lastEventSeq,
    createdAt,
    updatedAt,
    policy,
    runtimeBinding,
    capabilitySnapshot
  };
}

function normalizeCommandResult(source, sessionId, commandId, requestId) {
  if (source.requestId !== undefined && source.requestId !== requestId) {
    throw new DesktopChatRuntimeError('chat_runtime_request_mismatch', 0, undefined, requestId);
  }
  if (source.sessionId !== sessionId) throw new DesktopChatRuntimeError('chat_runtime_session_mismatch', 0, undefined, requestId);
  if (source.commandId !== commandId) throw new DesktopChatRuntimeError('chat_runtime_command_mismatch', 0, undefined, requestId);
  if (!Number.isSafeInteger(source.acceptedSeq) || source.acceptedSeq < 0) throw new DesktopChatRuntimeError('chat_runtime_command_seq_invalid', 0, undefined, requestId);
  if (typeof source.duplicate !== 'boolean') throw new DesktopChatRuntimeError('chat_runtime_command_duplicate_invalid', 0, undefined, requestId);
  return {
    sessionId,
    commandId,
    acceptedSeq: source.acceptedSeq,
    duplicate: source.duplicate,
    ...(source.result === undefined ? {} : { result: source.result }),
    requestId
  };
}

function commandFingerprint(command) {
  return JSON.stringify([command.type, command.payload]);
}

function parseEventMessage(message, sessionId) {
  const data = message && Object.prototype.hasOwnProperty.call(message, 'data') ? message.data : message;
  let value;
  if (typeof data === 'string') {
    try { value = JSON.parse(data); } catch (_error) { throw new DesktopChatRuntimeError('chat_runtime_event_json_invalid'); }
  } else {
    value = data;
  }
  return normalizeRuntimeEvent(value, sessionId);
}

const CHAT_RUNTIME_EVENT_SCHEMA = 'aih.chat.event.v1';
const EVENT_TYPES = new Set([
  'session.created', 'session.runtime.bound', 'session.runtime.rebound',
  'session.policy.changed', 'session.closed', 'session.snapshot.reset',
  'session.goal.updated', 'session.goal.cleared', 'turn.queued', 'turn.started',
  'turn.phase.changed', 'turn.interrupt.requested', 'turn.metrics.updated',
  'turn.interrupted', 'turn.completed', 'turn.failed', 'queue.item.added',
  'queue.item.updated', 'queue.item.moved', 'queue.item.removed',
  'queue.item.dispatched', 'timeline.item.started', 'timeline.item.delta',
  'timeline.item.updated', 'timeline.item.completed', 'interaction.requested',
  'interaction.updated', 'interaction.resolved', 'interaction.expired',
  'run.detached', 'run.reattached', 'run.adopted', 'run.lost',
  'runtime.prewarm.started', 'runtime.prewarm.ready', 'runtime.prewarm.failed',
  'stream.error'
]);

function normalizeRuntimeEvent(value, sessionId) {
  const event = asRecord(value, 'chat_runtime_event_invalid');
  if (event.schema !== CHAT_RUNTIME_EVENT_SCHEMA) throw new DesktopChatRuntimeError('chat_runtime_event_schema_invalid');
  const type = requiredText(event.type, 'chat_runtime_event_type_invalid');
  if (!EVENT_TYPES.has(type)) throw new DesktopChatRuntimeError('chat_runtime_event_type_invalid');
  if (requiredText(event.sessionId, 'chat_runtime_session_id_invalid') !== sessionId) return null;
  requiredText(event.eventId, 'chat_runtime_event_id_invalid');
  nonNegativeInteger(event.at, 'chat_runtime_event_at_invalid');
  const source = asRecord(event.source, 'chat_runtime_event_source_invalid');
  requiredText(source.provider, 'chat_runtime_event_provider_invalid');
  requiredText(source.runtimeId, 'chat_runtime_event_runtime_id_invalid');
  const payload = asRecord(event.payload, 'chat_runtime_event_payload_invalid');
  const seq = type === 'stream.error' || type === 'session.snapshot.reset'
    ? nonNegativeInteger(event.seq, 'chat_runtime_event_seq_invalid')
    : positiveInteger(event.seq, 'chat_runtime_event_seq_invalid');
  if (type === 'session.snapshot.reset' && payload.throughSeq !== seq) {
    throw new DesktopChatRuntimeError('chat_runtime_snapshot_cursor_mismatch');
  }
  return { ...event, type, seq, payload };
}

function normalizeTransportError(error, requestId) {
  if (error instanceof DesktopChatRuntimeError) return error;
  const code = String(error && error.code || 'chat_runtime_event_stream_failed');
  const normalized = new DesktopChatRuntimeError(
    code,
    Number(error && error.statusCode) || 0,
    error && error.details,
    requestId,
    error && error.message
  );
  if (error && error.retryable === false) normalized.retryable = false;
  return normalized;
}

function normalizeCursor(value) {
  const cursor = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new DesktopChatRuntimeError('chat_runtime_event_cursor_invalid');
  return cursor;
}

function positiveInteger(value, code) {
  const number = nonNegativeInteger(value, code);
  if (number === 0) throw new DesktopChatRuntimeError(code);
  return number;
}

const SESSION_STATES = new Set([
  'idle', 'starting', 'running', 'waiting_input', 'interrupting',
  'completing', 'recovering', 'closed'
]);

function requiredState(value) {
  const state = requiredText(value, 'chat_runtime_state_invalid');
  if (!SESSION_STATES.has(state)) throw new DesktopChatRuntimeError('chat_runtime_state_invalid');
  return state;
}

function nonNegativeInteger(value, code) {
  if (!Number.isSafeInteger(value) || value < 0) throw new DesktopChatRuntimeError(code);
  return value;
}

const CAPABILITY_NAMES = new Set([
  'session.resume', 'timeline.reasoning', 'timeline.tool', 'timeline.diff',
  'mode.plan', 'interaction.question', 'interaction.approval',
  'interaction.plan_confirmation', 'turn.interrupt', 'turn.steer.current',
  'turn.steer.tool_boundary', 'turn.queue', 'slash.execute', 'terminal.stream',
  'run.adopt', 'session.goal'
]);
const CAPABILITY_SUPPORT = new Set(['native', 'emulated', 'unsupported', 'unknown']);
const CAPABILITY_FIELDS = new Set(['revision', 'capturedAt', 'capabilities', 'slashCommands', 'slashPassthrough', 'turnInterveneModes']);
const DESCRIPTOR_FIELDS = new Set(['support', 'reason', 'alternatives']);

function normalizeCapabilitySnapshot(value) {
  const source = asRecord(value, 'chat_runtime_capabilities_invalid');
  rejectUnknownFields(source, CAPABILITY_FIELDS, 'chat_runtime_capabilities_shape_invalid');
  const result = {};
  if (source.revision !== undefined) result.revision = requiredText(source.revision, 'chat_runtime_capabilities_revision_invalid');
  if (source.capturedAt !== undefined) result.capturedAt = nonNegativeInteger(source.capturedAt, 'chat_runtime_capabilities_captured_at_invalid');
  if (source.slashPassthrough !== undefined) {
    if (typeof source.slashPassthrough !== 'boolean') {
      throw new DesktopChatRuntimeError('chat_runtime_slash_passthrough_invalid');
    }
    result.slashPassthrough = source.slashPassthrough;
  }
  if (source.capabilities !== undefined) {
    const capabilities = asRecord(source.capabilities, 'chat_runtime_capability_map_invalid');
    const normalizedCapabilities = {};
    for (const [name, descriptor] of Object.entries(capabilities)) {
      if (!CAPABILITY_NAMES.has(name)) throw new DesktopChatRuntimeError('chat_runtime_capability_name_invalid');
      normalizedCapabilities[name] = normalizeCapabilityDescriptor(descriptor);
    }
    result.capabilities = normalizedCapabilities;
  }
  for (const key of ['slashCommands', 'turnInterveneModes']) {
    if (source[key] === undefined) continue;
    if (!Array.isArray(source[key])) throw new DesktopChatRuntimeError(`chat_runtime_capability_${key === 'slashCommands' ? 'slash_commands' : 'turn_intervene_modes'}_invalid`);
    const code = key === 'slashCommands'
      ? 'chat_runtime_capability_slash_commands_invalid'
      : 'chat_runtime_capability_turn_intervene_modes_invalid';
    result[key] = source[key].map((entry) => requiredText(entry, code));
  }
  return result;
}

function normalizeCapabilityDescriptor(value) {
  const source = asRecord(value, 'chat_runtime_capability_descriptor_invalid');
  rejectUnknownFields(source, DESCRIPTOR_FIELDS, 'chat_runtime_capability_descriptor_shape_invalid');
  const support = requiredText(source.support, 'chat_runtime_capability_support_invalid');
  if (!CAPABILITY_SUPPORT.has(support)) throw new DesktopChatRuntimeError('chat_runtime_capability_support_invalid');
  const descriptor = { support };
  if (source.reason !== undefined) descriptor.reason = requiredText(source.reason, 'chat_runtime_capability_reason_invalid');
  if (source.alternatives !== undefined) {
    if (!Array.isArray(source.alternatives)) throw new DesktopChatRuntimeError('chat_runtime_capability_alternatives_invalid');
    descriptor.alternatives = source.alternatives.map((entry) => requiredText(entry, 'chat_runtime_capability_alternatives_invalid'));
  }
  return descriptor;
}

function rejectUnknownFields(source, fields, code) {
  if (Object.keys(source).some((field) => !fields.has(field))) throw new DesktopChatRuntimeError(code);
}

function requiredText(value, code) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new DesktopChatRuntimeError(code);
  return text;
}

function asRecord(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DesktopChatRuntimeError(code);
  return value;
}

module.exports = {
  SESSIONS_PATH,
  DesktopChatRuntimeError,
  createDesktopChatRuntimeClient
};
