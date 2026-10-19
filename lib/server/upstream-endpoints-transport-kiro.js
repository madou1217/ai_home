'use strict';

const { classifyUpstreamFailure } = require('./upstream-failure-policy');
const { appendUpstreamFailureDiagnosticLog } = require('./diagnostic-log');
const { attemptAnnotations, withAttemptAnnotations } = require('./attempt-annotations');
const { writeUpstreamSseHeaders } = require('./upstream-endpoints-headers');
const {
  createBoundedTailCapture,
  pipeReadableBodyToResponse
} = require('./upstream-stream-forwarder');
const { recordSuccessfulModelUsage } = require('./upstream-endpoints-usage');
const {
  supportsKiroChatTransport,
  fetchKiroChatCompletion,
  fetchKiroChatCompletionStream
} = require('./kiro-chat-transport');

// 上游不给 token 用量（只有 credits / 上下文百分比），transport 的 usage 是按字符估算的，
// sourceKind 里明确带 estimated，避免估算值被当成上游实测值追溯。
const KIRO_USAGE_SOURCE_KIND = 'server_kiro_stream_proxy_estimated';

/**
 * kiro 推理 transport strategy（与 qoderCliTransport / openCodeGoTransport 同一 Strategy 契约）。
 *
 * kiro 的 chat 面不是 OpenAI 兼容 HTTP：它是 CodeWhisperer 的流式 RPC
 * （x-amz-target + application/x-amz-json-1.0 + AWS event-stream 响应）。旧实现把它交给
 * 通用 transport 打 `{base}/chat/completions`，上游回 UnknownOperationException 并被当成
 * 200 正文透出 —— 本策略是这条通道的唯一入口。
 */
const kiroStreamTransport = {
  // CodeWhisperer 原生工具协议（kiro-dialect.js）。
  capabilities: Object.freeze({ clientTools: true }),

  matches(ctx) {
    return supportsKiroChatTransport(ctx && ctx.provider);
  },

  async run(ctx) {
    const {
      options,
      state,
      res,
      requestJson,
      routeKey,
      requestStartedAt,
      cooldownMs,
      requestMeta,
      deps,
      provider,
      streamRequested,
      recordAccountSuccess,
      recordAccountFailure,
      diagnosticMaxAttempts,
      recordModelUsage,
      appendProxyRequestLog,
      control,
      account,
      attemptUpstreamTimeoutMs,
      attemptMutable
    } = ctx;
    const logRequest = (entry) => {
      if (!options.logRequests) return;
      appendProxyRequestLog(withAttemptAnnotations(entry, attemptMutable));
    };

    const streamFetch = typeof deps.fetchKiroChatCompletionStream === 'function'
      ? deps.fetchKiroChatCompletionStream
      : fetchKiroChatCompletionStream;
    const bufferedFetch = typeof deps.fetchKiroChatCompletion === 'function'
      ? deps.fetchKiroChatCompletion
      : fetchKiroChatCompletion;
    const upstreamUrl = 'kiro-codewhisperer-streaming://GenerateAssistantResponse';

    try {
      if (streamRequested) {
        const upstreamRes = await streamFetch(options, account, requestJson || {}, attemptUpstreamTimeoutMs, {
          signal: requestMeta && requestMeta.signal
        });
        // fetch 只在上游给出首个可见事件后才 resolve：此前的失败（400 模型不可用 / 401 / 429 /
        // 容量提示）都走 catch → handleKiroFailure，可以换账号重试，客户端一个字节都没收到。
        attemptMutable.streamTransport = 'kiro_event_stream';
        writeUpstreamSseHeaders(res, account);
        const usageTail = createBoundedTailCapture();
        let streamWriteError = null;
        try {
          await pipeReadableBodyToResponse(upstreamRes && upstreamRes.body, res, {
            onChunk: (chunk) => usageTail.append(chunk)
          });
        } catch (error) {
          if (!res.headersSent && !res.writableEnded) throw error;
          streamWriteError = error;
        }
        try { if (!res.writableEnded) res.end(); } catch (_endError) { /* best effort */ }
        // 首字节之后的上游失败已作为流内错误帧交付给客户端（协议桥渲染成原生错误事件），
        // 这里只负责记账——不能再换号，也不能当成功。
        const outcome = upstreamRes && upstreamRes.completion ? await upstreamRes.completion : null;
        const midStreamError = streamWriteError || (outcome && !outcome.ok ? outcome.error : null);

        if (midStreamError && isClientAbort(midStreamError, requestMeta)) {
          // 客户端自己断开（Claude Code 的 Esc / Codex 的中断）不是账号故障。
          attemptMutable.streamTransport = 'kiro_event_stream_client_aborted';
          return { action: 'return' };
        }
        if (midStreamError) {
          attemptMutable.streamTransport = 'kiro_event_stream_error';
          const policy = classifyUpstreamFailure({
            provider,
            statusCode: Number(midStreamError.kiroStatusCode) || 0,
            error: midStreamError,
            defaultCooldownMs: cooldownMs
          });
          if (policy.kind === 'timeout') state.metrics.totalTimeouts += 1;
          recordAccountFailure(account, policy);
          state.metrics.totalFailures += 1;
          state.metrics.providerFailures[provider] = Number(state.metrics.providerFailures[provider] || 0) + 1;
          logRequest({
            at: new Date().toISOString(),
            requestId: requestMeta && requestMeta.requestId,
            route: routeKey,
            provider,
            accountRef: account.accountRef,
            status: 200,
            error: policy.detail,
            streamRequested,
            streamTransport: attemptMutable.streamTransport,
            durationMs: Date.now() - requestStartedAt
          });
          return { action: 'return' };
        }

        recordSuccessfulModelUsage(recordModelUsage, {
          provider,
          account,
          requestMeta,
          requestJson,
          raw: usageTail.toBuffer(),
          sourceKind: KIRO_USAGE_SOURCE_KIND
        });
        recordAccountSuccess(account);
        logRequest({
          at: new Date().toISOString(),
          requestId: requestMeta && requestMeta.requestId,
          route: routeKey,
          provider,
          accountRef: account.accountRef,
          status: 200,
          streamRequested,
          streamTransport: attemptMutable.streamTransport,
          durationMs: Date.now() - requestStartedAt
        });
        return { action: 'return' };
      }

      const payload = await bufferedFetch(options, account, requestJson || {}, attemptUpstreamTimeoutMs, {
        signal: requestMeta && requestMeta.signal
      });
      attemptMutable.streamTransport = 'non_stream';
      const raw = Buffer.from(JSON.stringify(payload));
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('x-aih-server-account-ref', account.accountRef);
      if (account.email) res.setHeader('x-aih-server-account-email', account.email);
      res.setHeader('content-length', raw.length);
      res.end(raw);
      recordSuccessfulModelUsage(recordModelUsage, {
        provider,
        account,
        requestMeta,
        requestJson,
        payload,
        sourceKind: KIRO_USAGE_SOURCE_KIND
      });
      recordAccountSuccess(account);
      logRequest({
        at: new Date().toISOString(),
        requestId: requestMeta && requestMeta.requestId,
        route: routeKey,
        provider,
        accountRef: account.accountRef,
        status: 200,
        streamRequested,
        streamTransport: attemptMutable.streamTransport,
        durationMs: Date.now() - requestStartedAt
      });
      return { action: 'return' };
    } catch (error) {
      return handleKiroFailure(ctx, error, upstreamUrl);
    }
  }
};

function isClientAbort(error, requestMeta) {
  if (error && error.code === 'kiro_client_aborted') return true;
  return Boolean(requestMeta && requestMeta.signal && requestMeta.signal.aborted);
}

// 失败路径：把 transport 抛出的错误（带 kiroStatusCode）交给统一的失败策略分类，
// 再按 shouldRetryAnotherAccount 决定换账号重试还是收尾。
function handleKiroFailure(ctx, error, upstreamUrl) {
  const {
    options,
    state,
    requestJson,
    routeKey,
    requestStartedAt,
    cooldownMs,
    requestMeta,
    provider,
    streamRequested,
    recordAccountFailure,
    diagnosticMaxAttempts,
    appendProxyRequestLog,
    control,
    account,
    attemptMutable
  } = ctx;
  if (isClientAbort(error, requestMeta)) {
    attemptMutable.lastError = 'client_aborted';
    attemptMutable.finalStatusCode = 499;
    control.setLastError(attemptMutable.lastError);
    return { action: 'break' };
  }
  const policy = classifyUpstreamFailure({
    provider,
    statusCode: Number(error && error.kiroStatusCode) || 0,
    error,
    defaultCooldownMs: cooldownMs
  });
  if (policy.kind === 'timeout') state.metrics.totalTimeouts += 1;
  recordAccountFailure(account, policy);
  appendUpstreamFailureDiagnosticLog({
    options,
    appendProxyRequestLog,
    annotations: attemptAnnotations(attemptMutable),
    requestId: requestMeta && requestMeta.requestId,
    route: routeKey,
    provider,
    account,
    attempt: control.attempt + 1,
    maxAttempts: diagnosticMaxAttempts(),
    requestedModel: String(requestJson && requestJson.model || '').trim(),
    effectiveModel: String(requestJson && requestJson.model || '').trim(),
    streamRequested,
    streamTransport: attemptMutable.streamTransport,
    upstreamUrl,
    upstreamError: error,
    status: policy.clientStatusCode || 502,
    durationMs: Date.now() - requestStartedAt,
    policy
  });
  attemptMutable.lastError = policy.detail;
  attemptMutable.finalStatusCode = policy.clientStatusCode || 502;
  control.setLastError(attemptMutable.lastError);
  return policy.shouldRetryAnotherAccount ? { action: 'retry_next' } : { action: 'break' };
}

module.exports = { kiroStreamTransport };
