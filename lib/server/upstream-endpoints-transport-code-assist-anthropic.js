'use strict';

const { classifyUpstreamFailure } = require('./upstream-failure-policy');
const { appendUpstreamFailureDiagnosticLog } = require('./diagnostic-log');
const { anthropicMessageToCanonicalEvents } = require('./code-assist-anthropic-adapter');
const { scheduleAgyUsageRefreshAfterFailure } = require('./agy-usage-snapshot');
const { isUnrecoverableTokenRefreshFailure } = require('./token-refresh-result');
const {
  writeCodeAssistAnthropicSseHeaders,
  writeCanonicalEventsAsAnthropicSse,
  writeCanonicalEventStreamAsAnthropicSse,
  requireNonEmptyCanonicalEventStream,
  tapCanonicalEventStream
} = require('./upstream-endpoints-sse');
const {
  recordSuccessfulModelUsage,
  createModelUsageCapture
} = require('./upstream-endpoints-usage');
const {
  createTokenRefreshUnavailablePolicy
} = require('./upstream-endpoints-failure');
const { shouldUseCodeAssistAnthropicDirectTransport } = require('./upstream-endpoints-transport');

/**
 * Code Assist Anthropic direct transport strategy (Strategy pattern).
 *
 * Implementations of the common transport contract:
 *   - matches(ctx): applies only when the protocol route plan resolved to
 *     CODE_ASSIST_ANTHROPIC_DIRECT and the anthropic message fetchers are
 *     available.
 *   - run(ctx): performs the upstream Code Assist (AGY) anthropic message
 *     exchange — SSE passthrough with buffered fallback for HTTP_400/404/405/
 *     501 — and returns a terminal attempt action, or classifies failures per
 *     upstream-failure-policy with auth-refresh recovery.
 *
 * Mutable attempt state (streamTransport/lastError/finalStatusCode) is read
 * and written through ctx.attemptMutable so the attempt handler observes the
 * same values it syncs in/out around each attempt. The gemini code-assist
 * diagnostic accumulator is local to this transport (mirrors the inline
 * attempt-body behavior where it was never synced out).
 */
const codeAssistAnthropicTransport = {
  matches(ctx) {
    return shouldUseCodeAssistAnthropicDirectTransport(ctx.requestMeta)
      && typeof ctx.fetchCodeAssistAnthropicMessage === 'function';
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
      codeAssistProvider,
      geminiRequestOptions,
      shouldCoverCodeAssistPool,
      diagnosticMaxAttempts,
      fetchWithTimeout,
      writeJson,
      fetchCodeAssistAnthropicMessage,
      fetchCodeAssistAnthropicMessageStream,
      refreshCodeAssistAfterAuthFailure,
      requestedAccountRef,
      recordModelUsage,
      appendProxyRequestLog,
      control,
      account,
      attemptUpstreamTimeoutMs,
      upstreamUrl,
      attemptMutable
    } = ctx;

    let geminiCodeAssistDiagnostic = null;
    const accountGeminiRequestOptions = codeAssistProvider
      ? {
          ...geminiRequestOptions,
          appendGeminiCodeAssistDiagnostic: (diagnostic) => {
            if (!diagnostic || typeof diagnostic !== 'object') return;
            const previousStreamToolDiagnostics = Array.isArray(
              geminiCodeAssistDiagnostic && geminiCodeAssistDiagnostic.streamToolDiagnostics
            )
              ? geminiCodeAssistDiagnostic.streamToolDiagnostics
              : [];
            const nextStreamToolDiagnostics = Array.isArray(diagnostic.streamToolDiagnostics)
              ? [...previousStreamToolDiagnostics, ...diagnostic.streamToolDiagnostics].slice(-20)
              : previousStreamToolDiagnostics;
            geminiCodeAssistDiagnostic = {
              ...(geminiCodeAssistDiagnostic || {}),
              ...diagnostic,
              ...(nextStreamToolDiagnostics.length > 0 ? { streamToolDiagnostics: nextStreamToolDiagnostics } : {})
            };
          }
        }
      : geminiRequestOptions;
    const geminiDiagnosticLogFields = () => geminiCodeAssistDiagnostic ? {
      geminiCodeAssistSessionId: geminiCodeAssistDiagnostic.sessionId,
      geminiCodeAssistUserPromptId: geminiCodeAssistDiagnostic.userPromptId,
      geminiCodeAssistRequestId: geminiCodeAssistDiagnostic.requestId,
      geminiCodeAssistRequestType: geminiCodeAssistDiagnostic.requestType,
      geminiCodeAssistRequestEnvelope: geminiCodeAssistDiagnostic.requestEnvelope,
      geminiCodeAssistSessionSource: geminiCodeAssistDiagnostic.sessionSource,
      geminiCodeAssistSessionReused: geminiCodeAssistDiagnostic.sessionReused,
      geminiCodeAssistExternalSessionKeyHash: geminiCodeAssistDiagnostic.externalSessionKeyHash,
      geminiCodeAssistCreditsEnabled: geminiCodeAssistDiagnostic.creditsEnabled,
      geminiCodeAssistCreditBalance: geminiCodeAssistDiagnostic.creditBalance,
      geminiCodeAssistCreditDecisionReason: geminiCodeAssistDiagnostic.creditDecisionReason,
      geminiCodeAssistCreditTypesIncluded: geminiCodeAssistDiagnostic.creditTypesIncluded,
      geminiCodeAssistCreditTypesField: geminiCodeAssistDiagnostic.creditTypesField,
      geminiCodeAssistCreditTypesForced: geminiCodeAssistDiagnostic.creditTypesForced,
      geminiCodeAssistPublicModel: geminiCodeAssistDiagnostic.publicModel,
      geminiCodeAssistWireModel: geminiCodeAssistDiagnostic.wireModel,
      geminiCodeAssistUpstreamUrl: geminiCodeAssistDiagnostic.upstreamUrl,
      geminiCodeAssistMethod: geminiCodeAssistDiagnostic.method,
      geminiCodeAssistUserAgent: geminiCodeAssistDiagnostic.userAgent,
      geminiCodeAssistClientName: geminiCodeAssistDiagnostic.clientName,
      geminiCodeAssistClientVersion: geminiCodeAssistDiagnostic.clientVersion,
      geminiCodeAssistProjectHeader: geminiCodeAssistDiagnostic.projectHeader,
      geminiCodeAssistProjectHeaderRetry: geminiCodeAssistDiagnostic.projectHeaderRetry,
      geminiCodeAssistProjectHeaderRetryReason: geminiCodeAssistDiagnostic.projectHeaderRetryReason,
      geminiCodeAssistAnthropicBetaHeader: geminiCodeAssistDiagnostic.anthropicBetaHeader,
      geminiCodeAssistForceStreamForBuffered: geminiCodeAssistDiagnostic.forceStreamForBuffered,
      geminiCodeAssistClientProtocol: geminiCodeAssistDiagnostic.clientProtocol,
      geminiCodeAssistSourceClientProtocol: geminiCodeAssistDiagnostic.sourceClientProtocol,
      geminiCodeAssistRequestProtocol: geminiCodeAssistDiagnostic.requestProtocol,
      geminiCodeAssistUpstreamProtocol: geminiCodeAssistDiagnostic.upstreamProtocol,
      geminiCodeAssistRequestAdapter: geminiCodeAssistDiagnostic.requestAdapter,
      geminiCodeAssistResponseAdapter: geminiCodeAssistDiagnostic.responseAdapter,
      geminiCodeAssistProtocolAdapterPath: geminiCodeAssistDiagnostic.protocolAdapterPath,
      geminiCodeAssistProviderProtocolPlan: geminiCodeAssistDiagnostic.providerProtocolPlan,
      geminiCodeAssistResponsePolicy: geminiCodeAssistDiagnostic.responsePolicy,
      geminiCodeAssistRequestSummary: geminiCodeAssistDiagnostic.requestSummary,
      geminiCodeAssistResponseToolCalls: geminiCodeAssistDiagnostic.responseToolCalls,
      geminiCodeAssistResponseFinishReasons: geminiCodeAssistDiagnostic.responseFinishReasons,
      geminiCodeAssistStreamToolDiagnostics: geminiCodeAssistDiagnostic.streamToolDiagnostics
    } : {};
    const logRetryFailure = (policy, data = {}) => {
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
        upstreamUrl,
        durationMs: Date.now() - requestStartedAt,
        geminiCodeAssist: geminiCodeAssistDiagnostic || undefined,
        policy,
        ...data
      });
    };
    const handleCodeAssistAuthFailure = async (error) => {
      const recovery = await refreshCodeAssistAfterAuthFailure(error, account);
      if (!recovery) return null;
      if (recovery.retrySameAccount) return { action: 'retry_same' };
      if (isUnrecoverableTokenRefreshFailure(recovery.refreshResult)) return null;

      const policy = createTokenRefreshUnavailablePolicy(
        provider,
        recovery.refreshResult,
        cooldownMs
      );
      recordAccountFailure(account, policy);
      logRetryFailure(policy, {
        status: 503,
        upstreamStatus: 401,
        upstreamError: error
      });
      attemptMutable.lastError = policy.detail;
      attemptMutable.finalStatusCode = 503;
      control.setLastError(attemptMutable.lastError);
      return { action: requestedAccountRef ? 'break' : 'retry_next' };
    };

    try {
      const streamMode = !!(requestJson && requestJson.stream);
      if (streamMode && typeof fetchCodeAssistAnthropicMessageStream === 'function') {
        try {
          console.log(`[aih] Dispatching stream anthropic messages to AGY Code Assist (account: ${account.accountRef}, model: ${requestJson && requestJson.model})`);
          const upstreamEvents = await fetchCodeAssistAnthropicMessageStream(
            accountGeminiRequestOptions,
            account,
            requestJson || {},
            attemptUpstreamTimeoutMs
          );
          const nonEmptyUpstreamEvents = await requireNonEmptyCanonicalEventStream(upstreamEvents);
          attemptMutable.streamTransport = 'upstream_sse';
          writeCodeAssistAnthropicSseHeaders(res, account);
          const usageCapture = createModelUsageCapture();
          await writeCanonicalEventStreamAsAnthropicSse(
            res,
            tapCanonicalEventStream(nonEmptyUpstreamEvents, usageCapture),
            requestJson && requestJson.model
          );
          res.end();

          const requestedModelId = String(requestJson && requestJson.model || '').trim();
          const capturedUsage = usageCapture.getUsageInput();
          recordSuccessfulModelUsage(recordModelUsage, {
            provider,
            account,
            requestMeta,
            requestJson,
            usage: capturedUsage && capturedUsage.usage,
            usageFormat: capturedUsage && capturedUsage.usageFormat,
            model: capturedUsage && capturedUsage.model,
            sourceKind: 'server_code_assist_proxy'
          });
          recordAccountSuccess(account, requestedModelId);
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
              ...geminiDiagnosticLogFields(),
              durationMs: Date.now() - requestStartedAt
            });
          }
          return { action: 'return' };
        } catch (streamError) {
          const streamErrorCode = String(streamError && streamError.code || '').trim().toUpperCase();
          const canFallbackToBuffered = streamErrorCode === 'HTTP_400'
            || streamErrorCode === 'HTTP_404'
            || streamErrorCode === 'HTTP_405'
            || streamErrorCode === 'HTTP_501';
          if (!canFallbackToBuffered) throw streamError;
        }
      }

      console.log(`[aih] Dispatching buffered anthropic messages to AGY Code Assist (account: ${account.accountRef}, model: ${requestJson && requestJson.model})`);
      const payload = await fetchCodeAssistAnthropicMessage(
        accountGeminiRequestOptions,
        account,
        requestJson || {},
        attemptUpstreamTimeoutMs
      );
      if (streamMode) {
        attemptMutable.streamTransport = 'buffered_fallback';
        writeCodeAssistAnthropicSseHeaders(res, account);
        writeCanonicalEventsAsAnthropicSse(
          res,
          anthropicMessageToCanonicalEvents(payload),
          requestJson && requestJson.model
        );
        res.end();
      } else {
        attemptMutable.streamTransport = 'non_stream';
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
        sourceKind: 'server_code_assist_proxy'
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
          ...geminiDiagnosticLogFields(),
          durationMs: Date.now() - requestStartedAt
        });
      }
      return { action: 'return' };
    } catch (codeAssistError) {
      const authRecovery = await handleCodeAssistAuthFailure(codeAssistError);
      if (authRecovery) return authRecovery;
      console.error(`[aih] AGY Code Assist Anthropic adapter error for account ${account.accountRef} (${account.email || 'no-email'}):`, codeAssistError);
      const match = String(codeAssistError && codeAssistError.code || '').trim().toUpperCase().match(/^HTTP_(\d{3})$/);
      const policy = classifyUpstreamFailure({
        provider,
        statusCode: match ? Number(match[1]) : 0,
        error: codeAssistError,
        defaultCooldownMs: cooldownMs
      });
      const retryPolicy = policy.kind === 'not_found' && shouldCoverCodeAssistPool
        ? {
            ...policy,
            retryable: true,
            shouldRetryAnotherAccount: true,
            shouldPassthroughToClient: false
          }
        : policy;
      if (retryPolicy.kind === 'timeout') state.metrics.totalTimeouts += 1;
      recordAccountFailure(account, retryPolicy);
      scheduleAgyUsageRefreshAfterFailure({
        provider,
        account,
        policy: retryPolicy,
        options,
        fs: deps.fs,
        fetchWithTimeout
      });
      logRetryFailure(retryPolicy, {
        status: retryPolicy.clientStatusCode || 502,
        upstreamUrl: geminiCodeAssistDiagnostic && geminiCodeAssistDiagnostic.upstreamUrl || upstreamUrl,
        upstreamError: codeAssistError
      });
      attemptMutable.lastError = retryPolicy.detail;
      attemptMutable.finalStatusCode = retryPolicy.clientStatusCode || 502;
      if (match) {
        upstreamFailureRecorder.record({
          statusCode: attemptMutable.finalStatusCode,
          account,
          streamRequested,
          error: 'upstream_failed',
          detail: attemptMutable.lastError
        });
      }
      control.setLastError(attemptMutable.lastError);
      // 一旦已开始向客户端流式（响应头已发出），就【不能再换账号重试】：换账号会再写一遍响应头
      // → "Cannot set headers after they are sent" (ERR_HTTP_HEADERS_SENT) → 连环 502，并污染已发出的流。
      // 直接结束当前(被中断的)流，让客户端按流中断处理，避免 6 连重试 + 误导错误 + 客户端死循环。
      if (res.headersSent || res.writableEnded) {
        try { if (!res.writableEnded) res.end(); } catch (_endError) { /* best effort */ }
        return { action: 'return' };
      }
      if (retryPolicy.shouldRetryAnotherAccount) return { action: 'retry_next' };
      writeJson(res, attemptMutable.finalStatusCode, { ok: false, error: 'upstream_failed', detail: attemptMutable.lastError });
      return { action: 'return' };
    } finally {
      // The code-assist diagnostics are accumulated by the upstream fetchers
      // through accountGeminiRequestOptions. If this handler itself throws
      // (escape path to the outer attempt catch), the caller still observes
      // the populated diagnostic via attemptMutable.
      attemptMutable.geminiCodeAssistDiagnostic = geminiCodeAssistDiagnostic;
    }
  }
};

module.exports = { codeAssistAnthropicTransport };