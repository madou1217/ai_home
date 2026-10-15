'use strict';

const { classifyUpstreamFailure } = require('./upstream-failure-policy');
const { appendUpstreamFailureDiagnosticLog } = require('./diagnostic-log');
const {
  annotateAttempt,
  attemptAnnotations,
  withAttemptAnnotations
} = require('./attempt-annotations');
const { writeUpstreamSseHeaders } = require('./upstream-endpoints-headers');
const {
  createBoundedTailCapture,
  pipeReadableBodyToResponse
} = require('./upstream-stream-forwarder');
const { recordSuccessfulModelUsage } = require('./upstream-endpoints-usage');
const { writeOpenAIChatCompletionPayloadAsSse } = require('./openai-chat-sse');
const { supportsOpenCodeFreeCliTransport } = require('./opencode-free-cli-transport');
const {
  OPENCODE_ZEN_FREE_URL,
  fetchOpenCodeZenFreeChatCompletion,
  fetchOpenCodeZenFreeChatCompletionStream
} = require('./opencode-zen-free-client');

/**
 * OpenCode 免费模型（`-free`）的 Zen 直连 HTTP transport strategy —— 免费模型链上的
 * **第一策略**（与 openCodeGoTransport / qoderCliTransport / openCodeFreeCliTransport
 * 同一 Strategy 契约）。
 *
 * 为什么首选它而不是 CLI：无子进程开销（省掉一次 opencode 冷启动）、请求/响应逐字节
 * 直通（SSE 原样透传，含 reasoning 扩展字段），且不依赖本机是否装了 opencode CLI。
 *
 * 门禁兜底（本策略的容错设计，也是「抛开 CLI」不牺牲可用性的关键）：
 *   - 门禁机制与离线铸造见 opencode-zen-free-client.js 模块头（UA 形状 + 白名单头名 +
 *     结构合法 session id + tools 含 `read` + stream:true，五条件）；
 *   - 若上游加固校验使直连重新吃到 403 FreeTierError，run() **返回 null 而不是记账** ——
 *     同一条链上的 openCodeFreeCliTransport 会用真实 opencode 二进制继续服务，
 *     功能不降级（只是慢一点），并且该次回退以注解
 *     `opencodeFreeZenGatedFallback` 落进后续所有代理日志行，排障可见；
 *   - 门禁不是账号/凭据故障（upstream-failure-policy 的
 *     opencode_free_tier_client_gated：scope none、不冷却、不换号），所以这里绝不能
 *     给账号记失败、也不能落进通用 401/403 分支（那会锁号 1 年）。
 */
const openCodeFreeHttpTransport = {
  matches(ctx) {
    // 与 CLI 通道共用同一谓词：两条通道服务同一个免费模型集合（`-free` 结尾），
    // 改集合只改 opencode-free-cli-transport.js 一处。
    return supportsOpenCodeFreeCliTransport(
      ctx && ctx.provider,
      ctx && ctx.requestJson && ctx.requestJson.model
    );
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
      upstreamFailureRecorder,
      diagnosticMaxAttempts,
      fetchWithTimeout,
      recordModelUsage,
      appendProxyRequestLog,
      control,
      account,
      attemptUpstreamTimeoutMs,
      attemptMutable
    } = ctx;
    // 代理请求日志的**唯一出口**：注解袋子在这里自动并入条目（见 attempt-annotations）。
    const logRequest = (entry) => {
      if (!options.logRequests) return;
      appendProxyRequestLog(withAttemptAnnotations(entry, attemptMutable));
    };

    const httpFetch = typeof deps.fetchOpenCodeZenFreeChatCompletion === 'function'
      ? deps.fetchOpenCodeZenFreeChatCompletion
      : fetchOpenCodeZenFreeChatCompletion;
    const httpStreamFetch = typeof deps.fetchOpenCodeZenFreeChatCompletionStream === 'function'
      ? deps.fetchOpenCodeZenFreeChatCompletionStream
      : fetchOpenCodeZenFreeChatCompletionStream;
    const zenDeps = {
      fetchWithTimeout,
      env: deps.env,
      signal: requestMeta && requestMeta.signal
    };

    try {
      if (streamRequested) {
        const upstreamRes = await httpStreamFetch(options, account, requestJson || {}, attemptUpstreamTimeoutMs, zenDeps);
        attemptMutable.streamTransport = 'opencode_free_zen_sse';
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
          attemptMutable.streamTransport = 'opencode_free_zen_sse_error';
          const policy = classifyUpstreamFailure({
            provider,
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
          sourceKind: 'server_opencode_free_zen_proxy'
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

      const payload = await httpFetch(options, account, requestJson || {}, attemptUpstreamTimeoutMs, zenDeps);
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
        sourceKind: 'server_opencode_free_zen_proxy'
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
    } catch (freeHttpError) {
      const match = String(freeHttpError && freeHttpError.code || '').trim().toUpperCase().match(/^HTTP_(\d{3})$/);
      const policy = classifyUpstreamFailure({
        provider,
        account,
        statusCode: Number(freeHttpError && freeHttpError.statusCode) || (match ? Number(match[1]) : 0),
        body: freeHttpError && freeHttpError.responseBody,
        error: freeHttpError,
        defaultCooldownMs: cooldownMs
      });
      // 门禁兜底：403 FreeTierError = 「HTTP 直连通道被上游拒绝」，不是账号故障。
      // 不记账、不冷却、不换号，直接交还链上的 CLI 通道（见模块头注释）；
      // 用注解留痕，CLI 通道后续的日志行会自动带上 opencodeFreeZenGatedFallback。
      if (policy.failureReason === 'opencode_free_tier_client_gated') {
        annotateAttempt(attemptMutable, 'opencodeFreeZenGatedFallback', true);
        return null;
      }
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
        upstreamUrl: OPENCODE_ZEN_FREE_URL,
        upstreamError: freeHttpError,
        status: policy.clientStatusCode || 502,
        durationMs: Date.now() - requestStartedAt,
        policy
      });
      attemptMutable.lastError = policy.detail;
      attemptMutable.finalStatusCode = policy.clientStatusCode || 502;
      upstreamFailureRecorder.record({
        statusCode: attemptMutable.finalStatusCode,
        account,
        streamRequested,
        passthrough: false,
        error: 'upstream_failed',
        detail: attemptMutable.lastError
      });
      control.setLastError(attemptMutable.lastError);
      return policy.shouldRetryAnotherAccount ? { action: 'retry_next' } : { action: 'break' };
    }
  }
};

module.exports = { openCodeFreeHttpTransport };
