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
  supportsOpenCodeFreeCliTransport,
  fetchOpenCodeFreeCliChatCompletion,
  fetchOpenCodeFreeCliChatCompletionStream
} = require('./opencode-free-cli-transport');

/**
 * OpenCode 免费模型（`-free`）CLI transport strategy（与 openCodeGoTransport /
 * qoderCliTransport 同一 Strategy 契约）。
 *
 * Zen 免费档只认真实 opencode 客户端（HTTP 直打一律 403 FreeTierError，见
 * opencode-free-cli-transport.js 顶部取证），所以免费模型必须走原生 CLI 桥接；
 * 付费模型继续走 openCodeGoTransport 的 HTTP 通道，两者按模型名分流。
 */
const openCodeFreeCliTransport = {
  matches(ctx) {
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
      diagnosticMaxAttempts,
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

    const cliFetch = typeof deps.fetchOpenCodeFreeCliChatCompletion === 'function'
      ? deps.fetchOpenCodeFreeCliChatCompletion
      : fetchOpenCodeFreeCliChatCompletion;
    const cliStreamFetch = typeof deps.fetchOpenCodeFreeCliChatCompletionStream === 'function'
      ? deps.fetchOpenCodeFreeCliChatCompletionStream
      : fetchOpenCodeFreeCliChatCompletionStream;

    try {
      if (streamRequested) {
        const upstreamRes = await cliStreamFetch(options, account, requestJson || {}, attemptUpstreamTimeoutMs, {
          aiHomeDir: options && options.aiHomeDir,
          hostHomeDir: options && options.hostHomeDir,
          signal: requestMeta && requestMeta.signal
        });
        attemptMutable.streamTransport = 'opencode_free_cli_stream_json';
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
          attemptMutable.streamTransport = 'opencode_free_cli_stream_json_error';
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
          sourceKind: 'server_opencode_free_cli_proxy'
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

      const payload = await cliFetch(options, account, requestJson || {}, attemptUpstreamTimeoutMs, {
        aiHomeDir: options && options.aiHomeDir,
        hostHomeDir: options && options.hostHomeDir,
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
        sourceKind: 'server_opencode_free_cli_proxy'
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
    } catch (cliError) {
      const policy = classifyUpstreamFailure({
        provider,
        statusCode: 0,
        error: cliError,
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
        upstreamUrl: 'opencode-free-cli://headless',
        upstreamError: cliError,
        status: policy.clientStatusCode || 502,
        durationMs: Date.now() - requestStartedAt,
        policy
      });
      attemptMutable.lastError = policy.detail;
      attemptMutable.finalStatusCode = policy.clientStatusCode || 502;
      control.setLastError(attemptMutable.lastError);
      return policy.shouldRetryAnotherAccount ? { action: 'retry_next' } : { action: 'break' };
    }
  }
};

module.exports = { openCodeFreeCliTransport };
