'use strict';

// 窗口激活探测的派发层：把一个「极小请求」通过 /v1/* 数据面发给本机网关。
//
// 为什么走 HTTP 自调用而不是 in-process 派发：完全复用真实数据面（账号选择、凭据、
// 用量记账、失败退避），与 scripts/gateway-account-auth-smoke.js 逐字段一致，且
// /v1/* 天然不经过 chat-runtime —— 只「像 relay chat 一样」用一次账号，绝不建立
// 项目会话。先例见 lib/server/webui-chat-routes.js 的内层网关自调用。
//
// 本文件只负责「发一个请求、读一个有上限的响应、判定是否命中目标账号」；
// 是否该发、发给谁由 window-activation-scheduler.js 决定。任何异常都归一化返回，
// 绝不向上抛（调度器承诺永不抛）。

const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
// 探测响应读完即弃，只用于判成功/取服务账号头；硬上限防止异常上游拖垮内存。
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;

function normalizeBaseUrl(baseUrl) {
  const text = String(baseUrl || '').trim();
  return text ? text.replace(/\/+$/, '') : '';
}

async function readBodyLimited(response, maxResponseBytes) {
  if (response && response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      totalBytes += chunk.length;
      if (totalBytes > maxResponseBytes) {
        try { await reader.cancel(); } catch (_cancelError) { /* best-effort */ }
        break;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, totalBytes).toString('utf8');
  }
  if (response && typeof response.text === 'function') {
    const text = await response.text();
    return Buffer.byteLength(text, 'utf8') > maxResponseBytes
      ? text.slice(0, maxResponseBytes)
      : text;
  }
  return '';
}

function readHeader(response, name) {
  try {
    if (response && response.headers && typeof response.headers.get === 'function') {
      return String(response.headers.get(name) || '').trim();
    }
  } catch (_headerError) { /* ignore */ }
  return '';
}

/**
 * 发一次窗口激活探测。
 *
 * @param {object} input
 * @param {string} input.baseUrl     本机网关基址，如 http://127.0.0.1:9527
 * @param {string} input.clientKey   网关客户端密钥（空则按网关既有约定发 'dummy'）
 * @param {object} input.spec        probe-specs 里的规格
 * @param {string} input.provider    账号 provider（用于 x-provider）
 * @param {string} input.accountRef  目标账号（用于 x-account-ref 钉选）
 * @param {Function} [input.fetchImpl] 注入的 fetch（默认 fetchWithTimeout）
 * @param {number} [input.timeoutMs]
 * @param {number} [input.maxResponseBytes]
 * @returns {Promise<{ok: boolean, matched: boolean, httpStatus: number|null, servedAccountRef: string, error: string}>}
 */
async function dispatchProbe(input = {}) {
  const {
    baseUrl,
    clientKey,
    spec,
    provider,
    accountRef,
    fetchImpl,
    timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES
  } = input;

  const result = {
    ok: false,
    matched: false,
    httpStatus: null,
    servedAccountRef: '',
    error: ''
  };

  const origin = normalizeBaseUrl(baseUrl);
  if (!origin || !spec || typeof spec.body !== 'function' || !accountRef) {
    result.error = 'probe_input_invalid';
    return result;
  }
  const doFetch = typeof fetchImpl === 'function'
    ? fetchImpl
    : (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) {
    result.error = 'probe_fetch_unavailable';
    return result;
  }

  let response;
  try {
    response = await doFetch(new URL(spec.path, `${origin}/`).toString(), {
      method: 'POST',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${clientKey || 'dummy'}`,
        'x-provider': String(provider || spec.provider || '').trim().toLowerCase(),
        'x-account-ref': accountRef
      },
      body: JSON.stringify(spec.body())
    }, timeoutMs);
  } catch (error) {
    result.error = String((error && error.code) || (error && error.name) || (error && error.message) || 'probe_transport_failure');
    return result;
  }

  // 读完即弃：只为拿到状态码与「服务账号」响应头，正文内容一律不保留。
  try {
    await readBodyLimited(response, maxResponseBytes);
  } catch (_readError) { /* body 读取失败不影响状态判定 */ }

  result.httpStatus = Number.isInteger(response && response.status) ? response.status : null;
  result.servedAccountRef = readHeader(response, 'x-aih-server-account-ref');
  result.matched = result.servedAccountRef === accountRef;
  result.ok = Boolean(response && response.ok);
  if (!result.ok && !result.error) {
    result.error = result.httpStatus ? `http_${result.httpStatus}` : 'probe_http_failure';
  }
  return result;
}

module.exports = {
  DEFAULT_PROBE_TIMEOUT_MS,
  DEFAULT_MAX_RESPONSE_BYTES,
  dispatchProbe
};
