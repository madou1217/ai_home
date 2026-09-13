'use strict';

const { classifyUpstreamFailure } = require('./upstream-failure-policy');
const { appendUpstreamFailureDiagnosticLog } = require('./diagnostic-log');
const { writeUpstreamSseHeaders } = require('./upstream-endpoints-headers');
const {
  createBoundedTailCapture,
  pipeReadableBodyToResponse
} = require('./upstream-stream-forwarder');
const { recordSuccessfulModelUsage } = require('./upstream-endpoints-usage');
const {
  supportsQoderCliTransport,
  fetchQoderCliChatCompletion,
  fetchQoderCliChatCompletionStream
} = require('./qoder-cli-transport');

/**
 * Qoder CLI headless transport strategy（与 openCodeGoTransport 同一 Strategy 契约）。
 * qoder/qodercn 没有可直放的 HTTP 上游（凭证 WASM 加密 + Cosy 签名），推理经
 * 原生 CLI headless stream-json 桥接为 OpenAI chat 语义。
 */
const qoderCliTransport = {
  matches(ctx) {
    return supportsQoderCliTransport(ctx && ctx.provider);
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

    const cliFetch = typeof deps.fetchQoderCliChatCompletion === 'function'
      ? deps.fetchQoderCliChatCompletion
      : fetchQoderCliChatCompletion;
    const cliStreamFetch = typeof deps.fetchQoderCliChatCompletionStream === 'function'
      ? deps.fetchQoderCliChatCompletionStream
      : fetchQoderCliChatCompletionStream;

    try {
      if (streamRequested) {
        const upstreamRes = await cliStreamFetch(options, account, requestJson || {}, attemptUpstreamTimeoutMs, {
          aiHomeDir: options && options.aiHomeDir,
          signal: requestMeta && requestMeta.signal
        });
        attemptMutable.streamTransport = 'qoder_cli_stream_json';
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
          attemptMutable.streamTransport = 'qoder_cli_stream_json_error';
          const policy = classifyUpstreamFailure({
            provider,
            error: streamWriteError,
            defaultCooldownMs: cooldownMs
          });
          if (policy.kind === 'timeout') state.metrics.totalTimeouts += 1;
          recordAccountFailure(account, policy);
          state.metrics.totalFailures += 1;
          state.metrics.providerFailures[provider] = Number(state.metrics.providerFailures[provider] || 0) + 1;
          if (options.logRequests) {
            appendProxyRequestLog({
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
          }
          return { action: 'return' };
        }

        recordSuccessfulModelUsage(recordModelUsage, {
          provider,
          account,
          requestMeta,
          requestJson,
          raw: usageTail.toBuffer(),
          sourceKind: 'server_qoder_cli_proxy'
        });
        recordAccountSuccess(account);
        if (options.logRequests) {
          appendProxyRequestLog({
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
        }
        return { action: 'return' };
      }

      const payload = await cliFetch(options, account, requestJson || {}, attemptUpstreamTimeoutMs, {
        aiHomeDir: options && options.aiHomeDir,
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
        sourceKind: 'server_qoder_cli_proxy'
      });
      recordAccountSuccess(account);
      if (options.logRequests) {
        appendProxyRequestLog({
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
      }
      return { action: 'return' };
    } catch (qoderError) {
      const policy = classifyUpstreamFailure({
        provider,
        statusCode: 0,
        error: qoderError,
        defaultCooldownMs: cooldownMs
      });
      if (policy.kind === 'timeout') state.metrics.totalTimeouts += 1;
      recordAccountFailure(account, policy);
      appendUpstreamFailureDiagnosticLog({
        options,
        appendProxyRequestLog,
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
        upstreamUrl: 'qoder-cli://headless',
        upstreamError: qoderError,
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

module.exports = { qoderCliTransport };
