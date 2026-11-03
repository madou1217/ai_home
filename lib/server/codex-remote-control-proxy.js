'use strict';

const http = require('node:http');
const fs = require('node:fs');
const WebSocket = require('ws');
const { rewriteCodexAppServerClientMessage } = require('./codex-app-server-proxy');
const { appendBoundedJsonLine } = require('./bounded-log-writer');

const DEFAULT_UPSTREAM_ORIGIN = 'https://chatgpt.com';
const DEFAULT_BASE_PATH = '/backend-api';
const MAX_HTTP_BODY_BYTES = 64 * 1024 * 1024;
const MAX_THREAD_SUMMARY_ITEMS = 10;
const MAX_CHUNK_ASSEMBLY_BYTES = 4 * 1024 * 1024;
const REMOTE_HYDRATION_NOTIFICATION_METHODS = new Set([
  'thread/started',
  'thread/status/changed',
  'thread/tokenUsage/updated'
]);

function tryParseJson(text) {
  try {
    return JSON.parse(String(text || ''));
  } catch (_error) {
    return null;
  }
}

function sanitizeTraceText(value, maxLength = 4000) {
  let text = String(value || '');
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]');
  text = text.replace(/"((?:access|refresh|id)_token|authToken|token)"\s*:\s*"[^"]+"/gi, '"$1":"[redacted]"');
  text = text.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[jwt-redacted]');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function createTraceWriter(traceFile) {
  const filePath = String(traceFile || '').trim();
  if (!filePath) return () => {};
  return (entry) => {
    appendBoundedJsonLine(fs, filePath, {
      at: new Date().toISOString(),
      component: 'codex_remote_control_proxy',
      ...entry
    });
  };
}

function jsonRpcThreadId(message) {
  const params = message && message.params && typeof message.params === 'object' && !Array.isArray(message.params)
    ? message.params
    : {};
  const thread = params.thread && typeof params.thread === 'object' && !Array.isArray(params.thread)
    ? params.thread
    : {};
  return String(params.threadId || params.thread_id || params.id || thread.id || '').trim();
}

function compactThreadListItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const id = String(item.id || item.sessionId || item.threadId || '').trim();
  if (!id) return null;
  const out = { id };
  const updatedAt = item.updatedAt || item.updated_at || item.updated_at_ms;
  const createdAt = item.createdAt || item.created_at || item.created_at_ms;
  if (updatedAt !== undefined && updatedAt !== null && updatedAt !== '') out.updatedAt = updatedAt;
  if (createdAt !== undefined && createdAt !== null && createdAt !== '') out.createdAt = createdAt;
  if (item.modelProvider) out.modelProvider = String(item.modelProvider);
  if (item.model_provider) out.modelProvider = String(item.model_provider);
  if (item.source) out.source = String(item.source);
  if (item.threadSource) out.threadSource = item.threadSource === null ? null : String(item.threadSource);
  if (item.thread_source) out.threadSource = String(item.thread_source);
  if (item.cwd) out.cwd = String(item.cwd);
  return out;
}

function addThreadListRequestSummary(summary, params) {
  if (Number.isFinite(Number(params.limit))) summary.limit = Number(params.limit);
  if (Object.prototype.hasOwnProperty.call(params, 'cursor')) {
    summary.cursor = params.cursor === null ? null : String(params.cursor || '');
  }
  if (params.sortKey) summary.sortKey = String(params.sortKey);
  if (Object.prototype.hasOwnProperty.call(params, 'archived')) summary.archived = params.archived === true;
  if (Array.isArray(params.modelProviders)) summary.modelProviders = params.modelProviders;
  if (Array.isArray(params.sourceKinds)) summary.sourceKinds = params.sourceKinds;
  summary.useStateDbOnly = params.useStateDbOnly === true;
}

function addThreadListResultSummary(summary, result) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || !Array.isArray(result.data)) return;
  const threads = result.data
    .map((item) => compactThreadListItem(item))
    .filter(Boolean)
    .slice(0, MAX_THREAD_SUMMARY_ITEMS);
  summary.resultThreads = threads;
  summary.resultThreadIds = threads.map((item) => item.id);
  if (result.nextCursor) summary.nextCursorValue = String(result.nextCursor);
  if (result.backwardsCursor) summary.backwardsCursorValue = String(result.backwardsCursor);
}

function summarizeJsonRpcMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return { kind: 'unknown' };
  }
  const summary = {};
  if (Object.prototype.hasOwnProperty.call(message, 'id')) {
    summary.id = String(message.id);
  }
  const method = String(message.method || '').trim();
  if (method) summary.method = method;
  const params = message.params && typeof message.params === 'object' && !Array.isArray(message.params)
    ? message.params
    : {};
  const threadId = jsonRpcThreadId(message);
  if (threadId) summary.threadId = threadId;
  if (method === 'thread/list') {
    addThreadListRequestSummary(summary, params);
  }
  if (message.error) {
    summary.error = String(message.error.message || message.error.code || 'error');
  }
  if (message.result && typeof message.result === 'object' && !Array.isArray(message.result)) {
    summary.hasResult = true;
    if (Array.isArray(message.result.data)) {
      summary.resultDataLength = message.result.data.length;
      summary.nextCursor = message.result.nextCursor ? true : false;
      addThreadListResultSummary(summary, message.result);
    }
    if (message.result.thread && typeof message.result.thread === 'object') {
      summary.resultThreadId = String(message.result.thread.id || '').trim() || undefined;
    }
  }
  return summary;
}

function summarizeRemoteEnvelope(payload) {
  const envelope = typeof payload === 'string' ? tryParseJson(payload) : payload;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { type: 'non_json' };
  }
  const type = String(envelope.type || '').trim();
  const summary = {
    type: type || 'unknown'
  };
  if (envelope.client_id) summary.clientId = String(envelope.client_id);
  if (envelope.stream_id) summary.streamId = String(envelope.stream_id);
  if (Object.prototype.hasOwnProperty.call(envelope, 'seq_id')) summary.seqId = envelope.seq_id;
  if (type === 'client_message' || type === 'server_message') {
    summary.message = summarizeJsonRpcMessage(envelope.message);
  }
  if (type === 'client_message_chunk' || type === 'server_message_chunk') {
    summary.segmentId = envelope.segment_id;
    summary.segmentCount = envelope.segment_count;
    summary.messageSizeBytes = envelope.message_size_bytes;
  }
  return summary;
}

function rewriteRemoteControlPayload(payload) {
  const text = Buffer.isBuffer(payload) ? payload.toString('utf8') : String(payload || '');
  const envelope = tryParseJson(text);
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { payload, changed: false, summary: { type: 'non_json' } };
  }
  if (String(envelope.type || '').trim() !== 'client_message') {
    return { payload: text, changed: false, summary: summarizeRemoteEnvelope(envelope) };
  }
  const originalMessage = envelope.message && typeof envelope.message === 'object' && !Array.isArray(envelope.message)
    ? envelope.message
    : null;
  if (!originalMessage) {
    return { payload: text, changed: false, summary: summarizeRemoteEnvelope(envelope) };
  }
  const rewrittenMessageText = rewriteCodexAppServerClientMessage(JSON.stringify(originalMessage));
  const rewrittenMessage = tryParseJson(rewrittenMessageText);
  if (!rewrittenMessage || rewrittenMessageText === JSON.stringify(originalMessage)) {
    return { payload: text, changed: false, summary: summarizeRemoteEnvelope(envelope) };
  }
  const nextEnvelope = {
    ...envelope,
    message: rewrittenMessage
  };
  return {
    payload: JSON.stringify(nextEnvelope),
    changed: true,
    summary: summarizeRemoteEnvelope(nextEnvelope)
  };
}

function readRemoteHydrationSuppressionState(filePath, options = {}) {
  const stateFile = String(filePath || '').trim();
  if (!stateFile) return new Set();
  const fsImpl = options.fs || fs;
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(stateFile, 'utf8'));
    const threads = Array.isArray(parsed && parsed.threads) ? parsed.threads : [];
    const out = new Set();
    for (const entry of threads) {
      const id = String(entry && entry.id || '').trim();
      const expiresAt = Number(entry && entry.expiresAt);
      if (id && Number.isFinite(expiresAt) && expiresAt > nowMs) out.add(id);
    }
    return out;
  } catch (_error) {
    return new Set();
  }
}

function shouldSuppressRemoteHydrationEnvelope(envelope, options = {}) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return false;
  if (String(envelope.type || '').trim() !== 'server_message') return false;
  const message = envelope.message && typeof envelope.message === 'object' && !Array.isArray(envelope.message)
    ? envelope.message
    : null;
  if (!message) return false;
  const method = String(message.method || '').trim();
  if (!REMOTE_HYDRATION_NOTIFICATION_METHODS.has(method)) return false;
  const threadId = jsonRpcThreadId(message);
  if (!threadId) return false;
  const suppressedThreadIds = options.suppressedThreadIds || readRemoteHydrationSuppressionState(
    options.suppressStateFile,
    options
  );
  return Boolean(suppressedThreadIds && typeof suppressedThreadIds.has === 'function' && suppressedThreadIds.has(threadId));
}

function createRemoteChunkAssembler(writeTrace) {
  const chunks = new Map();
  return (envelope, direction) => {
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) return;
    const type = String(envelope.type || '').trim();
    if (type !== 'client_message_chunk' && type !== 'server_message_chunk') return;
    const segmentCount = Number(envelope.segment_count);
    const segmentId = Number(envelope.segment_id);
    const messageSizeBytes = Number(envelope.message_size_bytes);
    const chunkBase64 = String(envelope.message_chunk_base64 || '').trim();
    if (
      !Number.isInteger(segmentCount)
      || segmentCount <= 0
      || !Number.isInteger(segmentId)
      || segmentId < 0
      || segmentId >= segmentCount
      || !chunkBase64
    ) {
      return;
    }
    if (Number.isFinite(messageSizeBytes) && messageSizeBytes > MAX_CHUNK_ASSEMBLY_BYTES) return;
    const key = [
      type,
      String(envelope.client_id || ''),
      String(envelope.stream_id || ''),
      String(envelope.seq_id || '')
    ].join(':');
    const entry = chunks.get(key) || {
      type,
      clientId: String(envelope.client_id || ''),
      streamId: String(envelope.stream_id || ''),
      seqId: envelope.seq_id,
      segmentCount,
      messageSizeBytes,
      parts: new Array(segmentCount),
      received: 0
    };
    if (entry.segmentCount !== segmentCount) {
      chunks.delete(key);
      return;
    }
    if (!entry.parts[segmentId]) entry.received += 1;
    entry.parts[segmentId] = chunkBase64;
    chunks.set(key, entry);
    if (entry.received !== entry.segmentCount) return;
    chunks.delete(key);
    try {
      const buffers = entry.parts.map((part) => Buffer.from(part, 'base64'));
      const messageText = Buffer.concat(buffers).toString('utf8');
      const message = tryParseJson(messageText);
      writeTrace({
        direction,
        binary: false,
        summary: {
          type: `${type}_reassembled`,
          clientId: entry.clientId,
          streamId: entry.streamId,
          seqId: entry.seqId,
          segmentCount: entry.segmentCount,
          messageSizeBytes: entry.messageSizeBytes,
          message: summarizeJsonRpcMessage(message)
        }
      });
    } catch (error) {
      writeTrace({
        direction,
        binary: false,
        summary: {
          type: `${type}_reassemble_failed`,
          clientId: entry.clientId,
          streamId: entry.streamId,
          seqId: entry.seqId,
          error: sanitizeTraceText(error && error.message || error)
        }
      });
    }
  };
}

function targetUrlFor(reqUrl, upstreamOrigin) {
  const target = new URL(String(reqUrl || DEFAULT_BASE_PATH), upstreamOrigin);
  return target;
}

function stripHopHeaders(headers, extraSkip = []) {
  const skip = new Set([
    'connection',
    'content-length',
    'host',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    ...extraSkip.map((name) => String(name || '').toLowerCase())
  ]);
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const normalized = key.toLowerCase();
    if (skip.has(normalized)) continue;
    if (value === undefined || value === null) continue;
    out[key] = value;
  }
  return out;
}

function stripWebSocketHeaders(headers) {
  return stripHopHeaders(headers, [
    'sec-websocket-accept',
    'sec-websocket-extensions',
    'sec-websocket-key',
    'sec-websocket-protocol',
    'sec-websocket-version'
  ]);
}

function collectRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_HTTP_BODY_BYTES) {
        reject(new Error('request_body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function proxyHttpRequest(req, res, options) {
  const upstreamOrigin = String(options.upstreamOrigin || DEFAULT_UPSTREAM_ORIGIN).trim() || DEFAULT_UPSTREAM_ORIGIN;
  const writeTrace = options.writeTrace || (() => {});
  const target = targetUrlFor(req.url, upstreamOrigin);
  const body = await collectRequestBody(req);
  writeTrace({
    direction: 'http_to_chatgpt',
    method: req.method,
    path: target.pathname,
    bodyBytes: body.length
  });
  let upstreamResponse;
  try {
    upstreamResponse = await fetch(target, {
      method: req.method,
      headers: stripHopHeaders(req.headers),
      body: body.length > 0 ? body : undefined,
      redirect: 'manual'
    });
  } catch (error) {
    writeTrace({
      direction: 'http_from_chatgpt',
      method: req.method,
      path: target.pathname,
      error: sanitizeTraceText(error && error.message || error)
    });
    res.statusCode = 502;
    res.end('remote_control_proxy_upstream_failed');
    return;
  }
  const responseBuffer = Buffer.from(await upstreamResponse.arrayBuffer());
  res.statusCode = upstreamResponse.status;
  upstreamResponse.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'content-encoding') return;
    if (key.toLowerCase() === 'transfer-encoding') return;
    res.setHeader(key, value);
  });
  res.setHeader('content-length', String(responseBuffer.length));
  writeTrace({
    direction: 'http_from_chatgpt',
    method: req.method,
    path: target.pathname,
    status: upstreamResponse.status,
    bodyBytes: responseBuffer.length,
    requestId: upstreamResponse.headers.get('x-request-id') || upstreamResponse.headers.get('x-oai-request-id') || '',
    cfRay: upstreamResponse.headers.get('cf-ray') || ''
  });
  res.end(responseBuffer);
}

function attachWebSocketProxy(server, options) {
  const upstreamOrigin = String(options.upstreamOrigin || DEFAULT_UPSTREAM_ORIGIN).trim() || DEFAULT_UPSTREAM_ORIGIN;
  const writeTrace = options.writeTrace || (() => {});
  const wss = new WebSocket.Server({ noServer: true });
  const assembleChunks = createRemoteChunkAssembler(writeTrace);

  server.on('upgrade', (req, socket, head) => {
    const target = targetUrlFor(req.url, upstreamOrigin);
    target.protocol = target.protocol === 'http:' ? 'ws:' : 'wss:';
    let upgraded = false;
    writeTrace({
      direction: 'ws_connect_to_chatgpt',
      path: target.pathname
    });
    const upstream = new WebSocket(target, {
      headers: stripWebSocketHeaders(req.headers)
    });

    upstream.once('open', () => {
      upgraded = true;
      wss.handleUpgrade(req, socket, head, (client) => {
        client.on('message', (data, isBinary) => {
          const text = isBinary ? '' : data.toString('utf8');
          const envelope = text ? tryParseJson(text) : null;
          const suppressed = !isBinary && shouldSuppressRemoteHydrationEnvelope(envelope, {
            suppressStateFile: options.suppressStateFile
          });
          writeTrace({
            direction: 'ws_app_server_to_chatgpt',
            binary: Boolean(isBinary),
            summary: isBinary ? { type: 'binary' } : summarizeRemoteEnvelope(envelope || text),
            ...(suppressed ? { suppressed: true, reason: 'hidden_hydration_notification' } : {})
          });
          if (!isBinary) assembleChunks(envelope, 'ws_app_server_to_chatgpt');
          if (suppressed) return;
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: isBinary });
        });
        upstream.on('message', (data, isBinary) => {
          if (isBinary) {
            writeTrace({
              direction: 'ws_chatgpt_to_app_server',
              binary: true,
              summary: { type: 'binary' }
            });
            if (client.readyState === WebSocket.OPEN) client.send(data, { binary: true });
            return;
          }
          const envelope = tryParseJson(data.toString('utf8'));
          const rewritten = rewriteRemoteControlPayload(data);
          writeTrace({
            direction: 'ws_chatgpt_to_app_server',
            binary: false,
            rewritten: rewritten.changed,
            summary: rewritten.summary
          });
          assembleChunks(envelope, 'ws_chatgpt_to_app_server');
          if (client.readyState === WebSocket.OPEN) client.send(rewritten.payload);
        });
        client.on('close', () => {
          try { upstream.close(); } catch (_error) {}
        });
        upstream.on('close', () => {
          try { client.close(); } catch (_error) {}
        });
        client.on('error', (error) => {
          writeTrace({ direction: 'ws_client_error', error: sanitizeTraceText(error && error.message || error) });
        });
        upstream.on('error', (error) => {
          writeTrace({ direction: 'ws_upstream_error', error: sanitizeTraceText(error && error.message || error) });
          try { client.close(); } catch (_closeError) {}
        });
      });
    });

    upstream.once('error', (error) => {
      if (upgraded) return;
      writeTrace({
        direction: 'ws_connect_to_chatgpt',
        path: target.pathname,
        error: sanitizeTraceText(error && error.message || error)
      });
      try {
        socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      } catch (_writeError) {}
      try { socket.destroy(); } catch (_destroyError) {}
    });
  });
}

function startCodexRemoteControlProxy(options = {}) {
  const host = String(options.host || '127.0.0.1').trim() || '127.0.0.1';
  const port = Number.isFinite(Number(options.port)) ? Number(options.port) : 0;
  const writeTrace = options.writeTrace || createTraceWriter(options.traceFile);
  const server = http.createServer((req, res) => {
    proxyHttpRequest(req, res, {
      upstreamOrigin: options.upstreamOrigin,
      writeTrace
    }).catch((error) => {
      writeTrace({ direction: 'http_proxy_error', error: sanitizeTraceText(error && error.message || error) });
      res.statusCode = 500;
      res.end('remote_control_proxy_failed');
    });
  });
  attachWebSocketProxy(server, {
    upstreamOrigin: options.upstreamOrigin,
    writeTrace,
    suppressStateFile: options.suppressStateFile
  });
  server.listen(port, host);
  return server;
}

function parseArgs(argv) {
  const out = {
    host: '127.0.0.1',
    port: 0,
    readyFile: '',
    traceFile: '',
    suppressStateFile: '',
    upstreamOrigin: DEFAULT_UPSTREAM_ORIGIN,
    parentPid: 0
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index] || '');
    if (token === '--host') {
      out.host = String(argv[index + 1] || '').trim() || out.host;
      index += 1;
    } else if (token === '--port') {
      out.port = Number(argv[index + 1] || 0) || 0;
      index += 1;
    } else if (token === '--ready-file') {
      out.readyFile = String(argv[index + 1] || '').trim();
      index += 1;
    } else if (token === '--trace-file') {
      out.traceFile = String(argv[index + 1] || '').trim();
      index += 1;
    } else if (token === '--suppress-state-file') {
      out.suppressStateFile = String(argv[index + 1] || '').trim();
      index += 1;
    } else if (token === '--upstream-origin') {
      out.upstreamOrigin = String(argv[index + 1] || '').trim() || out.upstreamOrigin;
      index += 1;
    } else if (token === '--parent-pid') {
      out.parentPid = Number(argv[index + 1] || 0) || 0;
      index += 1;
    }
  }
  return out;
}

function startParentWatch(parentPid, shutdown) {
  const pid = Number(parentPid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return setInterval(() => {
    try {
      process.kill(pid, 0);
    } catch (_error) {
      shutdown();
    }
  }, 5000);
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  const writeReady = (payload) => {
    if (!args.readyFile) return;
    try {
      fs.writeFileSync(args.readyFile, `${JSON.stringify(payload)}\n`, 'utf8');
    } catch (_error) {}
  };
  const server = startCodexRemoteControlProxy({
    host: args.host,
    port: args.port,
    traceFile: args.traceFile,
    suppressStateFile: args.suppressStateFile,
    upstreamOrigin: args.upstreamOrigin
  });
  server.on('listening', () => {
    const address = server.address();
    writeReady({
      ok: true,
      host: args.host,
      port: address && address.port
    });
  });
  server.on('error', (error) => {
    writeReady({
      ok: false,
      error: String(error && error.message || error || 'remote_proxy_failed')
    });
    process.exitCode = 1;
  });
  const shutdown = () => {
    try { server.close(() => process.exit(0)); } catch (_error) { process.exit(0); }
  };
  const parentWatch = startParentWatch(args.parentPid, shutdown);
  if (parentWatch && typeof parentWatch.unref === 'function') parentWatch.unref();
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = {
  sanitizeTraceText,
  summarizeJsonRpcMessage,
  summarizeRemoteEnvelope,
  createRemoteChunkAssembler,
  readRemoteHydrationSuppressionState,
  rewriteRemoteControlPayload,
  shouldSuppressRemoteHydrationEnvelope,
  startCodexRemoteControlProxy
};
