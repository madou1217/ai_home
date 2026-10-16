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

// 上游不给 token 用量（无 messageMetadataEvent），transport 的 usage 是按字符估算的，
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

        if (streamWriteError) {
          attemptMutable.streamTransport = 'kiro_event_stream_error';
          const policy = classifyUpstreamFailure({
            provider,
            statusCode: Number(streamWriteError.kiroStatusCode) || 0,
            error: streamWriteError,
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
