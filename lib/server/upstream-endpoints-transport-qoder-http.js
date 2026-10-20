'use strict';

// Qoder / Qoder CN 的 HTTP 直连策略（Strategy）。
//
// 与 qoderCliTransport 同一契约，但 **HTTP 优先、CLI 兜底**：
//   - 首字节之前失败（签名、认证、代理、HTTP 4xx/5xx、空流、上游错误 envelope）
//     只记录一条 `qoder_http_failed` 请求日志并返回 null，让链上的 CLI Strategy 接手；
//     **不记账号失败**（同一个账号马上会被 CLI 再试一次，双记会把一次请求算两次）。
//   - 首字节之后失败（SSE 中段断开/超时）无法再回落（响应头已写），按上游失败记账。
//   - 两条通道共用 `<provider>:message:<id>` 幂等键；HTTP 没有会话 JSONL 扫描器，
//     但仍用同一个形状，保证客户端重试/两通道切换不会写出两条相同记录。
//
// 设计纪律：transport 负责协议，Strategy 负责编排；这里不解析 body / SSE。

const { classifyUpstreamFailure } = require('./upstream-failure-policy');
const { withAttemptAnnotations, annotateAttempt } = require('./attempt-annotations');
const { writeUpstreamSseHeaders } = require('./upstream-endpoints-headers');
const {
  createBoundedTailCapture,
  pipeReadableBodyToResponse
} = require('./upstream-stream-forwarder');
const { recordSuccessfulModelUsage } = require('./upstream-endpoints-usage');
const {
  readQoderTokenCounters,
  readQoderUsageDetails,
  qoderEstimatedSourceKind
} = require('../usage/qoder-usage');
const {
  supportsQoderHttpTransport,
  fetchQoderHttpChatCompletion,
  fetchQoderHttpChatCompletionStream
} = require('./qoder-http-transport');

const QODER_HTTP_SOURCE_KIND = 'server_qoder_http_proxy';

function qoderHttpUsageSourceKind(estimated) {
  return estimated
    ? qoderEstimatedSourceKind(QODER_HTTP_SOURCE_KIND)
    : QODER_HTTP_SOURCE_KIND;
}

function qoderHttpUsageEventKey(provider, messageId, fallbackRequestId) {
  const id = String(messageId || '').trim();
  if (id) return `${provider}:message:${id}`;
  const requestId = String(fallbackRequestId || '').trim();
  return requestId ? `${provider}:http:${requestId}` : undefined;
}

// 注解只记数值/事实，不记 token、签名串、machineToken。
function annotateQoderHttpAttempt(attemptMutable, source, overrides = {}) {
  if (!attemptMutable || !source || typeof source !== 'object') return;
  annotateAttempt(attemptMutable, 'qoderHttp', true);
  annotateAttempt(attemptMutable, 'qoderHttpEgress', source.egress);
  annotateAttempt(attemptMutable, 'qoderHttpProxyFallback', source.proxyFallback === true);
  annotateAttempt(attemptMutable, 'qoderHttpEndpoint', source.endpoint);
  annotateAttempt(attemptMutable, 'qoderHttpEndpointSource', source.endpointSource);
  annotateAttempt(attemptMutable, 'qoderHttpClientVersion', source.version);
  annotateAttempt(attemptMutable, 'qoderHttpModelKey', source.modelKey);
  annotateAttempt(attemptMutable, 'qoderHttpToolCount', source.toolCount);
  annotateAttempt(attemptMutable, 'qoderHttpFirstTokenMs', Math.round(Number(source.firstTokenMs) || 0));
  const timing = source.timing && typeof source.timing === 'object' ? source.timing : {};
  annotateAttempt(attemptMutable, 'qoderHttpUpstreamTotalMs', Math.round(Number(timing.totalDuration) || 0));
  annotateAttempt(attemptMutable, 'qoderHttpServerDurationMs', Math.round(Number(timing.serverDuration) || 0));
  // 流式请求在首字节前会先注解一次（egress/endpoint 已确定），此时 usage 尚未定稿；
  // 只有 finalize 之后（或非流式 payload）才允许写 usage 注解，否则一次成功请求会同时
  // 留下“estimated”和“exact”两个互相矛盾的标记。
  const usageFinalized = Object.prototype.hasOwnProperty.call(overrides, 'usageFinalized')
    ? overrides.usageFinalized
    : source.usageFinalized;
  if (usageFinalized === false) return;
  annotateAttempt(attemptMutable, 'qoderHttpUsageMessageId', source.usageMessageId);
  const usage = source.usage && typeof source.usage === 'object' ? source.usage : null;
  const estimated = source.usageEstimated === true || !usage;
  if (attemptMutable.annotations && typeof attemptMutable.annotations === 'object') {
    if (estimated) delete attemptMutable.annotations.qoderHttpUsageExact;
    else delete attemptMutable.annotations.qoderHttpUsageEstimated;
  }
  if (estimated) annotateAttempt(attemptMutable, 'qoderHttpUsageEstimated', true);
  else annotateAttempt(attemptMutable, 'qoderHttpUsageExact', true);
  const counters = usage ? readQoderTokenCounters(usage) : null;
  if (counters) {
    annotateAttempt(attemptMutable, 'qoderHttpPromptTokens', counters.inputTokens);
    annotateAttempt(attemptMutable, 'qoderHttpCompletionTokens', counters.outputTokens);
    annotateAttempt(attemptMutable, 'qoderHttpCachedTokens', counters.cacheReadInputTokens);
    annotateAttempt(attemptMutable, 'qoderHttpReasoningTokens', counters.reasoningOutputTokens);
  }
  const details = readQoderUsageDetails(usage) || readQoderUsageDetails(source.estimatedDetails);
  if (details) {
    annotateAttempt(attemptMutable, 'qoderHttpCredits', details.credits);
    annotateAttempt(attemptMutable, 'qoderHttpOriginalCredits', details.originalCredits);
    annotateAttempt(attemptMutable, 'qoderHttpBillable', details.billable === true);
  }
}

const qoderHttpTransport = {
  matches(ctx) {
    return supportsQoderHttpTransport(ctx && ctx.provider);
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

    const httpFetch = typeof deps.fetchQoderHttpChatCompletion === 'function'
      ? deps.fetchQoderHttpChatCompletion
      : fetchQoderHttpChatCompletion;
    const httpStreamFetch = typeof deps.fetchQoderHttpChatCompletionStream === 'function'
      ? deps.fetchQoderHttpChatCompletionStream
      : fetchQoderHttpChatCompletionStream;
    const httpDeps = {
      aiHomeDir: options && options.aiHomeDir,
      hostHomeDir: options && options.hostHomeDir,
      signal: requestMeta && requestMeta.signal,
      requestMeta,
      fs: deps.fs,
      path: deps.path,
      materializeProviderAuth: deps.materializeProviderAuth,
      resolveProviderCliPath: deps.resolveProviderCliPath,
      resolveQoderHttpInvocation: deps.resolveQoderHttpInvocation,
      resolveQoderHttpEndpoint: deps.resolveQoderHttpEndpoint,
      readQoderUmid: deps.readQoderUmid,
      qoderClientVersion: deps.qoderClientVersion,
      signQoderRequest: deps.signQoderRequest,
      fetchQoderHttp: deps.fetchQoderHttp,
      qoderHttpDispatcher: deps.qoderHttpDispatcher,
      compressQoderBody: deps.compressQoderBody
    };

    // 首字节之前失败：只留证据，交给 CLI 兜底，不记账号失败。
    const handlePreHeaderFailure = (error) => {
      const policy = classifyUpstreamFailure({
        provider,
        statusCode: Number(error && error.statusCode) || 0,
        error,
        defaultCooldownMs: cooldownMs
      });
      annotateAttempt(attemptMutable, 'qoderHttpFallback', true);
      annotateAttempt(attemptMutable, 'qoderHttpErrorCode', String((error && error.code) || 'qoder_http_failed'));
      annotateAttempt(attemptMutable, 'qoderHttpErrorStatus', Number(error && error.statusCode) || 0);
      annotateAttempt(attemptMutable, 'qoderHttpEgress', error && error.qoderHttpEgress);
      annotateAttempt(attemptMutable, 'qoderHttpEndpoint', error && error.qoderHttpEndpoint);
      logRequest({
        at: new Date().toISOString(),
        requestId: requestMeta && requestMeta.requestId,
        route: routeKey,
        provider,
        accountRef: account.accountRef,
        status: policy.clientStatusCode || 502,
        error: policy.detail,
        streamRequested,
        streamTransport: 'qoder_http_failed',
        durationMs: Date.now() - requestStartedAt
      });
      return null;
    };

    if (streamRequested) {
      let upstreamRes = null;
      try {
        upstreamRes = await httpStreamFetch(options, account, requestJson || {}, attemptUpstreamTimeoutMs, httpDeps);
      } catch (error) {
        return handlePreHeaderFailure(error);
      }
      attemptMutable.streamTransport = 'qoder_http_sse';
      writeUpstreamSseHeaders(res, account);
      // 首字节前先记 egress/endpoint；usage 尚未定稿，显式禁止写 usage 注解。
      annotateQoderHttpAttempt(attemptMutable, upstreamRes, { usageFinalized: false });
      let streamWriteError = null;
      try {
        await pipeReadableBodyToResponse(upstreamRes && upstreamRes.body, res);
      } catch (error) {
        // 头已经写过，不能再回落；按首字节后的失败记账（由下方统一处理）。
        streamWriteError = error;
      }
      try { if (!res.writableEnded) res.end(); } catch (_error) { /* best effort */ }
      // timing/usage 在流结束时才到；这里补一次，让成功/失败日志都带上最终值。
      annotateQoderHttpAttempt(attemptMutable, upstreamRes);
      // 生产者先于 pipe 失败时 pipe 会 reject；这里再兜一层，防止 body 已 end 后
      // state.error 才落定而把失败误记成成功。
      if (!streamWriteError && upstreamRes && upstreamRes.error) streamWriteError = upstreamRes.error;

      if (streamWriteError) {
        attemptMutable.streamTransport = 'qoder_http_sse_error';
        const policy = classifyUpstreamFailure({
          provider,
          statusCode: Number(streamWriteError && streamWriteError.statusCode) || 0,
          error: streamWriteError,
          defaultCooldownMs: cooldownMs
        });
        // 失败流里上游已经发过精确 usage（生成完成、尾部出错）时，token 已被消耗，
        // 仍然记账；sourceKind 用精确值，避免把真实消耗丢掉。
        if (readQoderTokenCounters(upstreamRes && upstreamRes.usage)) {
          recordSuccessfulModelUsage(recordModelUsage, {
            provider,
            account,
            requestMeta,
            requestJson,
            usage: upstreamRes.usage,
            usageFormat: 'openai',
            eventKey: qoderHttpUsageEventKey(provider, upstreamRes.usageMessageId, upstreamRes.requestId),
            sourceKind: qoderHttpUsageSourceKind(false)
          });
        }
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
        usage: upstreamRes && upstreamRes.usage,
        usageFormat: 'openai',
        eventKey: qoderHttpUsageEventKey(provider, upstreamRes && upstreamRes.usageMessageId, upstreamRes && upstreamRes.requestId),
        sourceKind: qoderHttpUsageSourceKind(upstreamRes && upstreamRes.usageEstimated)
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

    let payload = null;
    try {
      payload = await httpFetch(options, account, requestJson || {}, attemptUpstreamTimeoutMs, httpDeps);
    } catch (error) {
      return handlePreHeaderFailure(error);
    }
    attemptMutable.streamTransport = 'qoder_http_json';
    annotateQoderHttpAttempt(attemptMutable, {
      egress: payload && payload.qoderHttpEgress,
      endpoint: payload && payload.qoderHttpEndpoint,
      endpointSource: payload && payload.qoderHttpEndpointSource,
      version: payload && payload.qoderHttpClientVersion,
      modelKey: payload && payload.qoderHttpModelKey,
      toolCount: payload && payload.qoderHttpToolCount,
      firstTokenMs: payload && payload.qoderHttpFirstTokenMs,
      timing: payload && payload.qoderHttpTiming,
      usage: payload && payload.usage,
      usageMessageId: payload && payload.usageMessageId,
      usageEstimated: payload && payload.usageEstimated,
      proxyFallback: payload && payload.qoderHttpProxyFallback,
      usageFinalized: true
    });
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
      usage: payload && payload.usage,
      usageFormat: 'openai',
      payload,
      eventKey: qoderHttpUsageEventKey(provider, payload && payload.usageMessageId, payload && payload.qoderHttpRequestId),
      sourceKind: qoderHttpUsageSourceKind(payload && payload.usageEstimated)
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
};

module.exports = { qoderHttpTransport, __private: { qoderHttpUsageEventKey } };
