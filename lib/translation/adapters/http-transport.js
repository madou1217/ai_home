'use strict';

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function failure(code, message, status = 0, retryable = true) {
  return { ok: false, text: '', usage: null, error: { code, message, status, retryable } };
}

function endpointUrl(endpoint, fallback, path) {
  const url = new URL(String(endpoint || fallback || '').trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search) {
    throw new Error('translation_config_invalid');
  }
  url.hash = '';
  const pathname = url.pathname.replace(/\/+$/, '');
  if (!pathname.endsWith(path)) url.pathname = `${pathname}${path}`;
  return url;
}

function automaticSource(source) {
  return !source || String(source).toLowerCase() === 'auto';
}

async function readResponseJson(response) {
  // Bound successful and error responses alike. Never reflect upstream bodies
  // into client errors: a service/proxy may include the request credentials.
  const reader = response.body && typeof response.body.getReader === 'function' && response.body.getReader();
  let text = '';
  if (reader) {
    const chunks = [];
    let bytes = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error('translation_response_too_large');
        }
        chunks.push(Buffer.from(part.value));
      }
      text = Buffer.concat(chunks).toString('utf8');
    } finally {
      reader.releaseLock();
    }
  } else {
    text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error('translation_response_too_large');
  }
  return JSON.parse(text);
}

function httpFailure(status) {
  const codes = { 401: 'translation_auth_failed', 403: 'translation_auth_failed', 429: 'translation_rate_limited', 456: 'translation_quota_exceeded' };
  const code = codes[status] || 'translation_upstream_http_error';
  const retryable = status === 408 || status === 425 || status === 429 || status >= 500;
  return failure(code, `翻译服务请求失败（HTTP ${status}）`, status, retryable);
}

/** Shared lifecycle; request/response mapping remains in each service adapter. */
function createHttpTranslationAdapter(spec, options = {}) {
  return async function translate(input = {}, context = {}) {
    if (context.signal && context.signal.aborted) return failure('translation_aborted', '翻译已取消', 0, false);
    if (typeof input.text !== 'string' || !input.text.trim() || !String(input.target || '').trim() || input.target === 'auto') {
      return failure('translation_input_invalid', '翻译内容和目标语言不能为空', 0, false);
    }
    // Canonical glossaries are inline term pairs. These APIs cannot consume
    // that shape directly; do not silently discard user terminology.
    if (input.glossary != null && (!Array.isArray(input.glossary) || input.glossary.length)) {
      return failure('translation_glossary_unsupported', '此翻译服务不支持内联术语表');
    }
    const formality = String(input.formality || 'default').trim();
    if (!['default', 'formal', 'casual'].includes(formality) || (!spec.formality && formality !== 'default')) {
      return failure('translation_formality_unsupported', '此翻译服务不支持所选语气');
    }
    let config;
    let request;
    try {
      const resolver = context.resolveProviderConfig || options.resolveProviderConfig;
      config = typeof resolver === 'function' ? await resolver(spec.id, context) : context.providerConfig;
      config = config && typeof config === 'object' ? config : {};
      const missing = (spec.required || []).filter((key) => !String(config[key] || '').trim());
      if (missing.length) return failure('translation_config_missing', `翻译服务缺少配置：${missing.join(', ')}`);
      request = spec.buildRequest({ ...input, formality }, config);
    } catch (_error) {
      return failure('translation_config_invalid', '翻译服务配置不可用');
    }
    if (context.signal && context.signal.aborted) return failure('translation_aborted', '翻译已取消', 0, false);
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    if (context.signal) context.signal.addEventListener('abort', onAbort, { once: true });
    const timeoutMs = Number(context.timeoutMs || options.timeoutMs) || DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(1, timeoutMs));
    let status = 0;
    try {
      const fetchImpl = context.fetch || options.fetch || globalThis.fetch;
      const response = await fetchImpl(request.url, {
        method: 'POST', redirect: 'error', ...request.init, signal: controller.signal
      });
      status = Number(response.status) || 0;
      if (!response.ok) {
        if (response.body && typeof response.body.cancel === 'function') await response.body.cancel();
        return httpFailure(status);
      }
      const payload = await readResponseJson(response);
      const parsed = spec.parseResponse(payload);
      if (!parsed || typeof parsed.text !== 'string' || !parsed.text.trim()) {
        return failure('translation_response_invalid', '翻译服务返回了无效译文', status);
      }
      if (context.signal && context.signal.aborted) return failure('translation_aborted', '翻译已取消', 0, false);
      if (timedOut) return failure('translation_timeout', '翻译服务请求超时');
      if (typeof context.emit === 'function') context.emit({ type: 'delta', content: parsed.text });
      return { ok: true, text: parsed.text, usage: parsed.usage || null, error: null };
    } catch (_error) {
      if (context.signal && context.signal.aborted) return failure('translation_aborted', '翻译已取消', 0, false);
      if (timedOut) return failure('translation_timeout', '翻译服务请求超时');
      return failure(status ? 'translation_response_invalid' : 'translation_network_error', status ? '翻译服务返回了无效响应' : '无法连接翻译服务', status);
    } finally {
      clearTimeout(timer);
      if (context.signal) context.signal.removeEventListener('abort', onAbort);
    }
  };
}

module.exports = { createHttpTranslationAdapter, endpointUrl, automaticSource };
