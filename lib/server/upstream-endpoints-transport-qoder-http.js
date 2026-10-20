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
const { recordTransportAttempt } = require('./transport-attempts');
const {
  readQoderTokenCounters,
  qoderEstimatedSourceKind,
  summarizeQoderUsage
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

    // 统一 attempt 记录：与 qoderCliTransport 写同一个 transportAttempts 模型。
    // 一次策略尝试只允许写一条（成功/失败二选一），durationMs 是本策略从进入
    // run() 到结束的耗时；HTTP 专有事实全部落在 details，不另起一套扁平字段。
    const attemptStartedAt = Date.now();
    let attemptRecorded = false;
    const recordQoderHttpAttempt = (outcome, extra = {}) => {
      if (attemptRecorded) return;
      attemptRecorded = true;
      const source = extra.source && typeof extra.source === 'object' ? extra.source : null;
      const sourceTiming = source && source.timing && typeof source.timing === 'object' ? source.timing : {};
      recordTransportAttempt(attemptMutable, {
        transport: 'qoder_http',
        outcome,
        durationMs: Date.now() - attemptStartedAt,
        upstream: extra.upstream || (source && source.endpoint) || '',
        provider,
        accountRef: account && account.accountRef,
        model: extra.model || String(requestJson && requestJson.model || '').trim() || (source && source.modelKey) || '',
        stream: Boolean(streamRequested),
        // 首字节前失败没有首字节：不要写一个误导性的 0。只有真正测到 >0 才带。
        firstTokenMs: extra.firstTokenMs !== undefined
          ? extra.firstTokenMs
          : (Number(source && source.firstTokenMs) > 0 ? source.firstTokenMs : undefined),
        errorCode: extra.errorCode,
        usage: extra.usage,
        details: {
          endpointSource: source && source.endpointSource,
          egress: source && source.egress,
          clientVersion: source && source.version,
          upstreamModel: source && source.modelKey,
          toolCount: source && source.toolCount,
          upstreamTotalMs: sourceTiming.totalDuration,
          serverDurationMs: sourceTiming.serverDuration,
          usageMessageId: source && source.usageMessageId,
          proxyFallback: source ? source.proxyFallback === true : undefined,
          streamTransport: attemptMutable && attemptMutable.streamTransport,
          statusCode: extra.statusCode,
          ...extra.details
        }
      });
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
      // 请求级回退标记（不是统计字段）：告诉读日志的人「这次 HTTP 交给 CLI 了」。
      // 具体的错误码/上游/耗时只在 transportAttempts 的 qoder_http 条目里记一次。
      annotateAttempt(attemptMutable, 'qoderHttpFallback', true);
      // 首字节前失败也是本次 HTTP 策略的最终结果：写统一 attempt 记录后交还 CLI。
      recordQoderHttpAttempt('failure', {
        upstream: error && error.qoderHttpEndpoint,
        errorCode: String((error && error.code) || 'qoder_http_failed'),
        statusCode: policy.clientStatusCode || 502,
        details: {
          egress: error && error.qoderHttpEgress,
          policyKind: policy.kind,
          streamTransport: 'qoder_http_failed'
        }
      });
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
        // 这是回退链的中间证据行，不是本次请求的最终结果；同一 requestId 后面
        // 还会有一条包含全部 attempt 的最终行。统计时只取最终行，避免把 HTTP
        // 失败重复计两次（见 docs/providers/qoder-client-protocol.md 4.5）。
        transportAttemptsPartial: true,
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
      let streamWriteError = null;
      try {
        await pipeReadableBodyToResponse(upstreamRes && upstreamRes.body, res);
      } catch (error) {
        // 头已经写过，不能再回落；按首字节后的失败记账（由下方统一处理）。
        streamWriteError = error;
      }
      try { if (!res.writableEnded) res.end(); } catch (_error) { /* best effort */ }
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
        // 失败流里如果已经收到精确 usage，统一 attempt 记录同样带上；
        // usage.source 明确标 exact/estimated，后续统计不会把失败请求当成功。
        recordQoderHttpAttempt('failure', {
          source: upstreamRes,
          errorCode: String((streamWriteError && streamWriteError.code) || policy.kind || 'qoder_http_stream_failed'),
          statusCode: 200,
          usage: summarizeQoderUsage(upstreamRes && upstreamRes.usage, {
            estimated: Boolean(upstreamRes && upstreamRes.usageEstimated),
            details: upstreamRes && upstreamRes.estimatedDetails
          }),
          details: { policyKind: policy.kind }
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

      recordQoderHttpAttempt('success', {
        source: upstreamRes,
        statusCode: 200,
        usage: summarizeQoderUsage(upstreamRes && upstreamRes.usage, {
          estimated: Boolean(upstreamRes && upstreamRes.usageEstimated),
          details: upstreamRes && upstreamRes.estimatedDetails
        })
      });
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
    recordQoderHttpAttempt('success', {
      source: {
        endpoint: payload && payload.qoderHttpEndpoint,
        endpointSource: payload && payload.qoderHttpEndpointSource,
        version: payload && payload.qoderHttpClientVersion,
        modelKey: payload && payload.qoderHttpModelKey,
        toolCount: payload && payload.qoderHttpToolCount,
        firstTokenMs: payload && payload.qoderHttpFirstTokenMs,
        timing: payload && payload.qoderHttpTiming,
        usage: payload && payload.usage,
        usageEstimated: payload && payload.usageEstimated,
        usageMessageId: payload && payload.usageMessageId,
        proxyFallback: payload && payload.qoderHttpProxyFallback,
        egress: payload && payload.qoderHttpEgress
      },
      statusCode: 200,
      usage: summarizeQoderUsage(payload && payload.usage, {
        estimated: payload && payload.usageEstimated === true
      })
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
