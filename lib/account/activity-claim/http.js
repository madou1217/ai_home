'use strict';

// 账号活动/福利领取：共享的 HTTP 语义。
//
// 这里的账号出口解析与额度探针完全同源（lib/server/account-egress-request-options），
// 因此「账号绑定了 url / system / pool 出口」时，签到与领套餐也走同一条出口，
// 不会出现「探针从代理出去、签到却直连」的分裂。

const {
  resolveAccountEgressRequestOptions: resolveAccountEgressRequestOptionsDefault
} = require('../../server/account-egress-request-options');

function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

/**
 * 解析账号出口，返回 { options } 或 { error }。
 * fail-closed：出口解析失败时调用方必须停止请求，绝不静默直连。
 */
async function resolveClaimEgressOptions(input = {}) {
  const resolver = typeof input.resolveAccountEgressRequestOptions === 'function'
    ? input.resolveAccountEgressRequestOptions
    : resolveAccountEgressRequestOptionsDefault;
  const env = (input.processObj && input.processObj.env) || {};
  try {
    const resolved = await resolver({
      fs: input.fs,
      aiHomeDir: input.aiHomeDir,
      processObj: input.processObj,
      provider: input.provider,
      accountRef: input.accountRef,
      options: {
        proxyUrl: env.AIH_SERVER_PROXY_URL || env.HTTPS_PROXY || env.HTTP_PROXY,
        noProxy: env.AIH_SERVER_NO_PROXY || env.NO_PROXY || env.no_proxy
      },
      deps: input.accountEgressDeps || {}
    });
    if (!resolved || !resolved.ok || !resolved.options) {
      return {
        error: `account_egress_unavailable:${normalizeText(resolved && (resolved.egressError || resolved.error)) || 'unknown'}`
      };
    }
    return { options: resolved.options };
  } catch (error) {
    return {
      error: `account_egress_unavailable:${normalizeText(error && error.message) || 'unknown'}`
    };
  }
}

/**
 * 读响应体并加硬上界。
 *
 * fetchWithTimeout 的 abort 定时器在 fetch 返回响应头后就清掉了，response.text()
 * 没有超时 —— 上游回完头再卡住正文时，领取链会一直等（2026-11-03 计划任务
 * 30 分钟 task_timeout 的一个可能来源）。正文读取同样必须有界。
 */
async function readBodyWithDeadline(response, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      response.text(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`fetch_body_timeout:${timeoutMs}`)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 发一次请求并解析 JSON。永不抛异常：错误统一变成 { error }。
 * 保留原始文本，因为上游业务错误的可读文案在 msg / data.message 里。
 */
async function fetchClaimJson(fetchWithTimeout, url, init, timeoutMs, egressOptions) {
  if (typeof fetchWithTimeout !== 'function') return { error: 'fetch_unavailable' };
  const bodyTimeoutMs = Math.max(1_000, Number(timeoutMs) || 15_000);
  try {
    const response = await fetchWithTimeout(url, init, timeoutMs, egressOptions || {});
    const text = await readBodyWithDeadline(response, bodyTimeoutMs);
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_error) {
      json = null;
    }
    return {
      status: Number(response && response.status) || 0,
      ok: Boolean(response && response.ok),
      json,
      text
    };
  } catch (error) {
    return { error: `request_failed:${normalizeText(error && error.message) || 'unknown'}` };
  }
}

/** 业务信封里可读的失败文案（qoder msg / zcode msg + data.message）。 */
function readEnvelopeMessage(json) {
  const source = json && typeof json === 'object' ? json : {};
  const data = source.data && typeof source.data === 'object' ? source.data : {};
  return normalizeText(source.msg)
    || normalizeText(source.message)
    || normalizeText(data.message)
    || normalizeText(source.error_description)
    || normalizeText(source.error);
}

module.exports = {
  fetchClaimJson,
  readBodyWithDeadline,
  normalizeText,
  readEnvelopeMessage,
  resolveClaimEgressOptions
};
