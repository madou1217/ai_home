'use strict';

// 直接使用 ZCode 私有 sing-box 的 Clash API 测指定 outbound。这里不切 selector、
// 不关闭连接，也不触碰系统代理/TUN；调用方只把明确完成的节点测量写回节点仓。

const { request: undiciRequest } = require('undici');

const DEFAULT_DELAY_CONCURRENCY = 16;
const DEFAULT_DELAY_TARGET_URL = 'https://www.gstatic.com/generate_204';
const DEFAULT_DELAY_TIMEOUT_MS = 5000;

function positiveInteger(value, fallback, minimum = 1) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum ? parsed : fallback;
}

function normalizeTargetUrl(value) {
  const raw = String(value || DEFAULT_DELAY_TARGET_URL).trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return DEFAULT_DELAY_TARGET_URL;
  }
  return parsed.protocol === 'https:' && !parsed.username && !parsed.password
    ? parsed.toString()
    : DEFAULT_DELAY_TARGET_URL;
}

function responseBodyText(response) {
  if (!response?.body || typeof response.body.text !== 'function') return Promise.resolve('');
  return response.body.text().catch(() => '');
}

function failedProbe(error, reason, measured) {
  return {
    ok: false,
    measured,
    latencyMs: measured ? -1 : null,
    error,
    ...(reason ? { reason } : {})
  };
}

function isControllerTransportFailure(error) {
  const code = String(error?.code || error?.cause?.code || '').trim().toUpperCase();
  return [
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_SOCKET'
  ].includes(code);
}

async function probeSingBoxOutboundDelay(input = {}) {
  const controllerPort = Number(input.controllerPort);
  const controllerSecret = String(input.controllerSecret || '').trim();
  const outboundTag = String(input.outboundTag || '').trim();
  if (
    !Number.isInteger(controllerPort)
    || controllerPort < 1
    || !controllerSecret
    || !outboundTag
  ) {
    return failedProbe('sing_box_delay_probe_invalid', '', false);
  }

  const timeoutMs = positiveInteger(
    input.timeoutMs,
    DEFAULT_DELAY_TIMEOUT_MS,
    250
  );
  const url = new URL(
    `http://127.0.0.1:${controllerPort}/proxies/${encodeURIComponent(outboundTag)}/delay`
  );
  url.searchParams.set('timeout', String(timeoutMs));
  url.searchParams.set('url', normalizeTargetUrl(input.targetUrl));
  const requestImpl = input.requestImpl || undiciRequest;

  let response;
  try {
    response = await requestImpl(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${controllerSecret}` },
      headersTimeout: timeoutMs + 1000,
      bodyTimeout: timeoutMs + 1000
    });
  } catch (error) {
    return failedProbe(
      'sing_box_delay_probe_failed',
      String(error?.message || error || 'unknown'),
      !isControllerTransportFailure(error)
    );
  }

  const statusCode = Number(response?.statusCode || 0);
  const body = await responseBodyText(response);
  let parsed = null;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch {}

  if (statusCode >= 200 && statusCode < 300) {
    const latencyMs = Number(parsed?.delay);
    if (Number.isFinite(latencyMs) && latencyMs >= 0) {
      return { ok: true, measured: true, latencyMs };
    }
    return failedProbe('sing_box_delay_probe_invalid_response', 'missing_delay', false);
  }

  const controllerFailure = statusCode === 401 || statusCode === 403 || statusCode === 404;
  const reason = String(parsed?.message || parsed?.error || body || `http_${statusCode || 'unknown'}`)
    .slice(0, 200);
  return failedProbe('sing_box_delay_probe_failed', reason, !controllerFailure);
}

function normalizeCandidates(value) {
  const seenNodeIds = new Set();
  const candidates = [];
  for (const item of Array.isArray(value) ? value : []) {
    const nodeId = String(item?.nodeId || '').trim();
    const outboundTag = String(item?.outboundTag || '').trim();
    if (!nodeId || !outboundTag || seenNodeIds.has(nodeId)) continue;
    seenNodeIds.add(nodeId);
    candidates.push({ nodeId, outboundTag });
  }
  return candidates;
}

async function probeSingBoxOutboundDelays(input = {}) {
  const candidates = normalizeCandidates(input.candidates);
  if (!candidates.length) {
    return {
      ok: true,
      results: [],
      measuredCount: 0,
      healthyCount: 0,
      failedCount: 0
    };
  }

  const concurrency = Math.min(
    candidates.length,
    positiveInteger(input.concurrency, DEFAULT_DELAY_CONCURRENCY)
  );
  const results = new Array(candidates.length);
  let cursor = 0;
  const probeOutbound = typeof input.probeOutbound === 'function'
    ? input.probeOutbound
    : (candidate) => probeSingBoxOutboundDelay({
      ...input,
      outboundTag: candidate.outboundTag
    });

  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= candidates.length) return;
      const candidate = candidates[index];
      let measured;
      try {
        measured = await probeOutbound(candidate);
      } catch (error) {
        measured = failedProbe(
          'sing_box_delay_probe_failed',
          String(error?.message || error || 'unknown'),
          false
        );
      }
      results[index] = { nodeId: candidate.nodeId, ...measured };
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const measuredCount = results.filter((result) => result.measured === true).length;
  const healthyCount = results.filter((result) => result.ok === true).length;
  return {
    ok: true,
    results,
    measuredCount,
    healthyCount,
    failedCount: results.filter((result) => result.measured === true && result.ok !== true).length
  };
}

module.exports = {
  DEFAULT_DELAY_CONCURRENCY,
  DEFAULT_DELAY_TARGET_URL,
  DEFAULT_DELAY_TIMEOUT_MS,
  probeSingBoxOutboundDelay,
  probeSingBoxOutboundDelays
};
