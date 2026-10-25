'use strict';

function failure(code, message, retryable = true, status = 0) {
  return { ok: false, text: '', usage: null, error: { code, message, retryable, ...(status ? { status } : {}) }, attempts: [] };
}

function aborted() {
  return failure('translation_aborted', '翻译已取消', false);
}

function combineSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(Math.max(1, Number(timeoutMs) || 180000));
  if (!signal) return timeout;
  return AbortSignal.any([signal, timeout]);
}

function parseDataBlock(block) {
  const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
  if (!data || data === '[DONE]') return null;
  try { return JSON.parse(data); } catch (_error) { return null; }
}

/** Execute a translation through an AIH Server's web translation stream. */
function createAihServerExecutor(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const getManagementKey = options.getManagementKey || (() => '');
  const timeoutMs = options.timeoutMs || 180000;

  return async function execute(request = {}, context = {}) {
    const signal = context.signal;
    if (signal && signal.aborted) return aborted();
    const origin = String(request.origin || options.origin || '').trim().replace(/\/$/, '');
    if (!/^https?:\/\//.test(origin)) return failure('translation_server_target_invalid', '翻译服务目标不可用', true);
    if (typeof fetchImpl !== 'function') return failure('translation_server_unavailable', '翻译服务不可用', true);
    const headers = { 'Content-Type': 'application/json' };
    const key = typeof context.getManagementKey === 'function' ? context.getManagementKey() : getManagementKey();
    if (key) headers.Authorization = `Bearer ${key}`;
    const serverId = String(request.serverId || '').trim();
    if (serverId) headers['x-aih-server-id'] = serverId;
    const body = {
      text: String(request.text || ''),
      source: String(request.source || 'auto'),
      target: String(request.targetLanguage || request.languageTarget || request.to || 'zh-Hans'),
      targetPolicy: String(request.targetPolicy || 'saved'),
      ...(request.operation ? { operation: request.operation } : {}),
      ...(Array.isArray(request.routes) ? { routes: request.routes } : {})
    };
    let response;
    try {
      response = await fetchImpl(`${origin}/v0/webui/translation/stream`, {
        method: 'POST', headers, body: JSON.stringify(body), signal: combineSignal(signal, context.timeoutMs || timeoutMs)
      });
    } catch (error) {
      if (signal && signal.aborted) return aborted();
      return failure(error && error.name === 'TimeoutError' ? 'translation_timeout' : 'translation_network_error', error && error.name === 'TimeoutError' ? '翻译服务请求超时' : '无法连接翻译服务', true);
    }
    if (!response || !response.ok) {
      let detail = '翻译请求失败';
      try { const payload = await response.json(); detail = String(payload && (payload.detail || payload.message) || detail); } catch (_error) { /* keep generic */ }
      return failure('translation_server_http_error', detail, Number(response && response.status) >= 500 || Number(response && response.status) === 429, Number(response && response.status) || 0);
    }
    let text = '';
    let usage = null;
    let streamError = null;
    const emit = context.emit || (() => {});
    const consume = (event) => {
      if (!event || (context.isCurrent && !context.isCurrent())) return;
      if (event.type === 'delta') {
        const content = String(event.content || '');
        text += content;
        emit({ ...event, content });
      } else if (event.type === 'done') {
        if (!text && typeof event.text === 'string') text = event.text;
        usage = event.usage || null;
        emit(event);
      } else if (event.type === 'error') {
        streamError = event;
        emit(event);
      } else emit(event);
    };
    try {
      let buffer = '';
      if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
        const decoder = new TextDecoder();
        for await (const bytes of response.body) {
          buffer += decoder.decode(bytes, { stream: true });
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const event = parseDataBlock(block);
            if (event) consume(event);
          }
        }
      } else if (response.body && typeof response.body.getReader === 'function') {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            buffer += decoder.decode(part.value, { stream: true });
            let boundary;
            while ((boundary = buffer.indexOf('\n\n')) >= 0) {
              const block = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              const event = parseDataBlock(block);
              if (event) consume(event);
            }
          }
        } finally { reader.releaseLock(); }
      } else {
        const payload = await response.json();
        consume(payload);
      }
      // Some fetch implementations close an SSE stream without a final blank
      // line. Treat the remaining complete data block as an event so a final
      // delta/done is not silently discarded.
      if (buffer.trim()) {
        const event = parseDataBlock(buffer);
        if (event) consume(event);
      }
    } catch (error) {
      if (signal && signal.aborted) return aborted();
      return failure('translation_stream_invalid', '翻译服务返回了无效响应', true);
    }
    if (signal && signal.aborted) return aborted();
    if (!text.trim()) {
      if (streamError) {
        return failure(
          String(streamError.code || 'translation_server_error'),
          String(streamError.message || '翻译服务返回错误'),
          streamError.retryable !== false,
          Number(streamError.status) || 0
        );
      }
      return failure('translation_empty_output', '上游没有返回译文', true);
    }
    return { ok: true, text, usage, error: null, attempts: [] };
  };
}

module.exports = { createAihServerExecutor };
