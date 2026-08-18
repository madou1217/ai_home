'use strict';

const { classifyUpstreamFailure } = require('./upstream-failure-policy');
const { appendUpstreamFailureDiagnosticLog } = require('./diagnostic-log');
const {
  fetchOpenCodeChatCompletion,
  fetchOpenCodeChatCompletionStream
} = require('./opencode-server-client');
const { writeUpstreamSseHeaders } = require('./upstream-endpoints-headers');
const {
  createBoundedTailCapture,
  pipeReadableBodyToResponse
} = require('./upstream-stream-forwarder');
const { recordSuccessfulModelUsage } = require('./upstream-endpoints-usage');
const {
  writeOpenAIChatCompletionPayloadAsSse
} = require('./openai-chat-sse');
const { shouldUseOpenCodeGoApiTransport } = require('./upstream-endpoints-transport');

/**
 * OpenCode go API transport strategy (Strategy pattern).
 *
 * Implementations of the common transport contract:
 *   - matches(ctx): applies only when the protocol route plan resolved to
 *     OPENCODE_GO_API.
 *   - run(ctx): performs the upstream opencode go exchange (SSE passthrough
 *     with buffered fallback when streaming is unsupported) and returns a
 *     terminal attempt action, or throws/classifies failures per
 *     upstream-failure-policy.
 *
 * Mutable attempt state (streamTransport/lastError/finalStatusCode) is read
 * and written through ctx.attemptMutable so the attempt handler observes the
 * same values it syncs in/out around each attempt.
 */
const openCodeGoTransport = {
  matches(ctx) {
    return shouldUseOpenCodeGoApiTransport(ctx.requestMeta);
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
      fetchWithTimeout,
      fetchOpenCodeChatCompletionDep,
      fetchOpenCodeChatCompletionStreamDep,
      recordModelUsage,
      appendProxyRequestLog,
      control,
      account,
      attemptUpstreamTimeoutMs,
      attemptMutable
    } = ctx;

    const opencodeFetch = fetchOpenCodeChatCompletionDep || fetchOpenCodeChatCompletion;
    const opencodeStreamFetch = fetchOpenCodeChatCompletionStreamDep || fetchOpenCodeChatCompletionStream;
    try {
      if (streamRequested && typeof opencodeStreamFetch === 'function') {
        try {
          const upstreamRes = await opencodeStreamFetch({
            ...options,
            cwd: requestMeta && requestMeta.cwd || process.cwd()
          }, account, requestJson || {}, attemptUpstreamTimeoutMs, {
            fetchWithTimeout,
            openCodeServerManager: deps.openCodeServerManager
          });
          attemptMutable.streamTransport = 'upstream_sse';
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
            attemptMutable.streamTransport = 'upstream_sse_error';
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
            sourceKind: 'server_opencode_go_proxy'
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
        } catch (streamError) {
          const streamErrorCode = String(streamError && streamError.code || '').trim().toUpperCase();
          if (streamErrorCode !== 'OPENCODE_STREAM_UNSUPPORTED') throw streamError;
        }
      }

      const payload = await opencodeFetch({
        ...options,
        cwd: requestMeta && requestMeta.cwd || process.cwd()
      }, account, requestJson || {}, attemptUpstreamTimeoutMs, {
        fetchWithTimeout,
        openCodeServerManager: deps.openCodeServerManager
      });
      attemptMutable.streamTransport = streamRequested ? 'buffered_fallback' : 'non_stream';
      if (streamRequested) {
        writeOpenAIChatCompletionPayloadAsSse(
          res,
          payload,
          payload.model || requestJson && requestJson.model,
          { sessionId: payload.sessionId || payload.session_id }
        );
      } else {
        const raw = Buffer.from(JSON.stringify(payload));
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('x-aih-server-account-ref', account.accountRef);
        if (account.email) res.setHeader('x-aih-server-account-email', account.email);
        res.setHeader('content-length', raw.length);
        res.end(raw);
      }
      recordSuccessfulModelUsage(recordModelUsage, {
        provider,
        account,
        requestMeta,
        requestJson,
        payload,
        sourceKind: 'server_opencode_go_proxy'
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
    } catch (opencodeError) {
      const match = String(opencodeError && opencodeError.code || '').trim().toUpperCase().match(/^HTTP_(\d{3})$/);
      const policy = classifyUpstreamFailure({
        provider,
        statusCode: match ? Number(match[1]) : 0,
        error: opencodeError,
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
        upstreamUrl: 'https://opencode.ai/zen/go/v1',
        upstreamError: opencodeError,
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

module.exports = { openCodeGoTransport };