'use strict';

const { isLoopbackUrl } = require('./http-utils');
const { isApiCredentialAccount } = require('../account/runtime-auth-mode');
const {
  applyClaudeCodeIdentityHeaders,
  ensureClaudeCodeSystemBuffer
} = require('./claude-official-client');
const { classifyUpstreamFailure } = require('./upstream-failure-policy');
const {
  isZcodeCaptchaRequiredErrorBody,
  DEFAULT_VERIFY_TIMEOUT_MS: ZCODE_CAPTCHA_VERIFY_TIMEOUT_MS
} = require('./zcode-captcha-bridge');
const { applyZcodeDesktopIdentity, isNativeZcodeOAuthAccount } = require('./zcode-official-client');
const { appendUpstreamFailureDiagnosticLog } = require('./diagnostic-log');
const { resolveOpenAIChatFinishReason } = require('./protocol-finish-reason');
const {
  isImageGenerationModel,
  extractInlineImageMarkdown
} = require('./code-assist-image-generation');
const { anthropicMessageToCanonicalEvents } = require('./code-assist-anthropic-adapter');
const { scheduleAgyUsageRefreshAfterFailure } = require('./agy-usage-snapshot');
const { MIN_RETRY_ATTEMPT_BUDGET_MS } = require('./request-pool-retry-policy');
const { decodeResponseBuffer } = require('./response-body');
const { unwrapUpstreamEnvelopeBody } = require('./openai-response-envelope');
const { applyAccountUpstreamHeaders } = require('./upstream-account-profile');
const { buildKimiRequestHeaders } = require('./kimi-request-headers');
const {
  createBoundedTailCapture,
  createDownstreamAbortContext,
  pipeReadableBodyToResponse
} = require('./upstream-stream-forwarder');
const {
  isUnrecoverableTokenRefreshFailure
} = require('./token-refresh-result');
const { STREAM_RESPONSE_OPEN_TIMEOUT_MS } = require('./upstream-endpoints-utils');
const {
  resolveProviderUpstream,
  resolveProviderPath,
  isAnthropicCompatibleBaseUrl,
  isClaudeMessagesPath,
  isOpenAIChatCompletionsPath,
  isGeminiGenerateContentPath,
  isGeminiStreamGenerateContentPath
} = require('./upstream-endpoints-path');
const {
  shouldSkipForwardHeader,
  normalizeHeaderValue,
  isSafeHeaderValue,
  sanitizeAccessToken,
  sendRawUpstreamResponse,
  writeGeneralUpstreamResponseHeaders
} = require('./upstream-endpoints-headers');
const {
  writeCodeAssistAnthropicSseHeaders,
  writeCanonicalEventsAsAnthropicSse,
  writeCanonicalEventStreamAsAnthropicSse,
  requireNonEmptyGeminiGenerateContentStream,
  requireNonEmptyCanonicalEventStream,
  tapCanonicalEventStream
} = require('./upstream-endpoints-sse');
const {
  recordSuccessfulModelUsage,
  createModelUsageCapture
} = require('./upstream-endpoints-usage');
const {
  isGlobalNetworkFailure,
  withNetworkHint,
  mapGeminiFinishReason,
  createTokenRefreshUnavailablePolicy
} = require('./upstream-endpoints-failure');
const { shouldUseCodeAssistAnthropicDirectTransport } = require('./upstream-endpoints-transport');
const { runTransportChain } = require('./upstream-endpoints-transport-chain');
const { openCodeGoTransport } = require('./upstream-endpoints-transport-opencode-go');

/**
 * Creates the onAttempt handler for handleUpstreamPassthrough's
 * runWithAccountAttempts orchestration. All request-scoped dependencies flow
 * in through `shared`; mutable attempt state (streamTransport/lastError/
 * finalStatusCode/transientPoolRetry*) lives on shared.attemptMutable so the
 * caller observes the same values after each attempt and between rounds.
 *
 * The handler keeps behavior identical to the original inline onAttempt:
 * every transport branch is attempted in order until one returns a terminal
 * action, failures classify through upstream-failure-policy, and the mutable
 * state is synced back to attemptMutable on every exit.
 */
function createUpstreamAttemptHandler(shared) {
  const {
    options,
    state,
    req,
    res,
    method,
    bodyBuffer,
    requestJson,
    routeKey,
    requestStartedAt,
    cooldownMs,
    requestMeta,
    deps,
    provider,
    refreshProviderAccessToken,
    streamRequested,
    guardedBodyBuffer,
    requestedModel,
    requestedAccountRef,
    recordAccountSuccess,
    recordAccountFailure,
    upstreamFailureRecorder,
    refreshCodeAssistAfterAuthFailure,
    codeAssistProvider,
    geminiRequestOptions,
    modelPoolSelection,
    shouldCoverCodeAssistPool,
    diagnosticMaxAttempts,
    requestBudgetMs,
    fetchWithTimeout,
    pushMetricError,
    writeJson,
    fetchGeminiCodeAssistChatCompletion,
    fetchGeminiCodeAssistChatCompletionStream,
    fetchGeminiCodeAssistGenerateContent,
    fetchGeminiCodeAssistGenerateContentStream,
    fetchCodeAssistAnthropicMessage,
    fetchCodeAssistAnthropicMessageStream,
    fetchOpenCodeChatCompletionDep,
    fetchOpenCodeChatCompletionStreamDep,
    markProxyAccountFailure,
    recordModelUsage,
    appendProxyRequestLog,
    forcedRefreshRetryUsed,
    attemptMutable
  } = shared;

  // Mutable attempt state at factory scope: attemptBody closes over these
  // bindings across all retry rounds; the handler re-syncs them from
  // attemptMutable each call (prepareRetryRound flips transientPoolRetry*
  // between rounds) and writes them back on exit.
  let streamTransport = attemptMutable.streamTransport;
  let lastError = attemptMutable.lastError;
  let finalStatusCode = attemptMutable.finalStatusCode;
  let transientPoolRetryUsed = attemptMutable.transientPoolRetryUsed;
  let transientPoolRetryDeadlineAt = attemptMutable.transientPoolRetryDeadlineAt;

  const attemptBody = async (account, control) => {
      let retryAttemptBudgetMs = 0;
      if (transientPoolRetryUsed) {
        retryAttemptBudgetMs = transientPoolRetryDeadlineAt - Date.now();
        if (retryAttemptBudgetMs < MIN_RETRY_ATTEMPT_BUDGET_MS) {
          lastError = 'transient_pool_retry_budget_exhausted';
          control.setLastError(lastError);
          return { action: 'break' };
        }
      }
      const attemptUpstreamTimeoutMs = transientPoolRetryUsed
        ? Math.floor(Math.min(
            Number(options.upstreamTimeoutMs) || requestBudgetMs,
            retryAttemptBudgetMs
          ))
        : options.upstreamTimeoutMs;
      const transportCtx = {
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
      };
      const transportAction = await runTransportChain(transportCtx, [openCodeGoTransport]);
      if (transportAction) {
        streamTransport = attemptMutable.streamTransport;
        lastError = attemptMutable.lastError;
        finalStatusCode = attemptMutable.finalStatusCode;
        return transportAction;
      }
      const upstreamBase = resolveProviderUpstream(options, provider, account);
      if (!upstreamBase) {
        lastError = `missing_upstream_for_provider_${provider}`;
        control.setLastError(lastError);
        return { action: 'break' };
      }
      if (isLoopbackUrl(upstreamBase, options.port)) {
        lastError = 'infinite_loop_detected';
        control.setLastError(lastError);
        return { action: 'break' };
      }
      const upstreamPath = resolveProviderPath(provider, req.url || '', upstreamBase);
      const upstreamUrl = `${upstreamBase}${upstreamPath}`;
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
          streamTransport,
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
        lastError = policy.detail;
        finalStatusCode = 503;
        control.setLastError(lastError);
        return { action: requestedAccountRef ? 'break' : 'retry_next' };
      };
      if (
        provider === 'claude'
        && isAnthropicCompatibleBaseUrl(upstreamBase)
        && isOpenAIChatCompletionsPath(upstreamPath)
      ) {
        lastError = 'configured_claude_base_url_uses_anthropic_compatible_endpoint_but_current_request_is_openai_chat_completions';
        control.setLastError(lastError);
        writeJson(res, 400, {
          ok: false,
          error: 'invalid_request',
          detail: '当前 claude 账号配置的 base URL 是 Anthropic 兼容端点（如 DashScope /apps/anthropic），但 /v0/webui/chat API 代理当前发送的是 OpenAI /chat/completions 协议。该组合暂不兼容；需要改走 Anthropic /v1/messages 适配，或改用 OpenAI 兼容 base URL。'
        });
        return { action: 'return' };
      }
      const canRefreshAccount = typeof refreshProviderAccessToken === 'function'
        && !isApiCredentialAccount(account);
      if (canRefreshAccount) {
        try {
          await refreshProviderAccessToken(account, {
            force: false,
            timeoutMs: attemptUpstreamTimeoutMs,
            proxyUrl: options.proxyUrl,
            noProxy: options.noProxy
          }, {
            fetchWithTimeout
          });
        } catch (_error) {}
      }
      const accessToken = sanitizeAccessToken(account.accessToken);
      if (!accessToken) {
        // If a refresh_token exists the daemon will recover this account soon — skip
        // without marking a failure so the cooldown counter doesn't accumulate.
        if (!sanitizeAccessToken(account.refreshToken)) {
          markProxyAccountFailure(account, 'invalid_access_token', cooldownMs, options.failureThreshold);
        }
        lastError = `invalid_access_token_account_${account.accountRef}`;
        control.setLastError(lastError);
        return { action: 'retry_next' };
      }
      try {
        if (
          shouldUseCodeAssistAnthropicDirectTransport(requestMeta)
          && typeof fetchCodeAssistAnthropicMessage === 'function'
        ) {
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
                streamTransport = 'upstream_sse';
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
                    streamTransport,
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
              streamTransport = 'buffered_fallback';
              writeCodeAssistAnthropicSseHeaders(res, account);
              writeCanonicalEventsAsAnthropicSse(
                res,
                anthropicMessageToCanonicalEvents(payload),
                requestJson && requestJson.model
              );
              res.end();
            } else {
              streamTransport = 'non_stream';
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
                streamTransport,
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
            lastError = retryPolicy.detail;
            finalStatusCode = retryPolicy.clientStatusCode || 502;
            if (match) {
              upstreamFailureRecorder.record({
                statusCode: finalStatusCode,
                account,
                streamRequested,
                error: 'upstream_failed',
                detail: lastError
              });
            }
            control.setLastError(lastError);
            // 一旦已开始向客户端流式（响应头已发出），就【不能再换账号重试】：换账号会再写一遍响应头
            // → "Cannot set headers after they are sent" (ERR_HTTP_HEADERS_SENT) → 连环 502，并污染已发出的流。
            // 直接结束当前(被中断的)流，让客户端按流中断处理，避免 6 连重试 + 误导错误 + 客户端死循环。
            if (res.headersSent || res.writableEnded) {
              try { if (!res.writableEnded) res.end(); } catch (_endError) { /* best effort */ }
              return { action: 'return' };
            }
            if (retryPolicy.shouldRetryAnotherAccount) return { action: 'retry_next' };
            writeJson(res, finalStatusCode, { ok: false, error: 'upstream_failed', detail: lastError });
            return { action: 'return' };
          }
        }

        if (
          codeAssistProvider
          && method === 'POST'
          && isGeminiGenerateContentPath(req.url || '')
          && typeof fetchGeminiCodeAssistGenerateContent === 'function'
        ) {
          try {
            const streamMode = isGeminiStreamGenerateContentPath(req.url || '')
              || String(requestMeta && requestMeta.clientProtocol || '').trim() === 'gemini_stream_generate_content';
            if (streamMode && typeof fetchGeminiCodeAssistGenerateContentStream === 'function') {
              console.log(`[aih] Dispatching stream generateContent to Gemini Code Assist (account: ${account.accountRef}, model: ${requestJson && requestJson.model})`);
              const upstreamStream = await fetchGeminiCodeAssistGenerateContentStream(
                accountGeminiRequestOptions,
                account,
                requestJson || {},
                attemptUpstreamTimeoutMs
              );
              const nonEmptyUpstreamStream = await requireNonEmptyGeminiGenerateContentStream(upstreamStream);
              streamTransport = 'upstream_sse';
              res.statusCode = 200;
              res.setHeader('content-type', 'text/event-stream; charset=utf-8');
              res.setHeader('cache-control', 'no-cache');
              res.setHeader('connection', 'keep-alive');
              res.setHeader('x-aih-server-account-ref', account.accountRef);
              if (account.email) res.setHeader('x-aih-server-account-email', account.email);
              const usageCapture = createModelUsageCapture();
              for await (const piece of nonEmptyUpstreamStream) {
                usageCapture.observePayload(piece);
                res.write(`data: ${JSON.stringify(piece)}\n\n`);
              }
              res.end();

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
                  streamTransport,
                  ...geminiDiagnosticLogFields(),
                  durationMs: Date.now() - requestStartedAt
                });
              }
              return { action: 'return' };
            }

            console.log(`[aih] Dispatching buffered generateContent to Gemini Code Assist (account: ${account.accountRef}, model: ${requestJson && requestJson.model})`);
            const payload = await fetchGeminiCodeAssistGenerateContent(
              accountGeminiRequestOptions,
              account,
              requestJson || {},
              attemptUpstreamTimeoutMs
            );
            if (streamMode) {
              streamTransport = 'buffered_fallback';
              res.statusCode = 200;
              res.setHeader('content-type', 'text/event-stream; charset=utf-8');
              res.setHeader('cache-control', 'no-cache');
              res.setHeader('connection', 'keep-alive');
              res.setHeader('x-aih-server-account-ref', account.accountRef);
              if (account.email) res.setHeader('x-aih-server-account-email', account.email);
              res.write(`data: ${JSON.stringify(payload)}\n\n`);
              res.end();
            } else {
              streamTransport = 'non_stream';
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
                streamTransport,
                ...geminiDiagnosticLogFields(),
                durationMs: Date.now() - requestStartedAt
              });
            }
            return { action: 'return' };
          } catch (codeAssistError) {
            const authRecovery = await handleCodeAssistAuthFailure(codeAssistError);
            if (authRecovery) return authRecovery;
            console.error(`[aih] Gemini Code Assist generateContent adapter error for account ${account.accountRef} (${account.email || 'no-email'}):`, codeAssistError);
            const match = String(codeAssistError && codeAssistError.code || '').trim().toUpperCase().match(/^HTTP_(\d{3})$/);
            const policy = classifyUpstreamFailure({
              provider,
              statusCode: match ? Number(match[1]) : 0,
              error: codeAssistError,
              defaultCooldownMs: cooldownMs
            });
            if (policy.kind === 'timeout') state.metrics.totalTimeouts += 1;
            recordAccountFailure(account, policy);
            scheduleAgyUsageRefreshAfterFailure({
              provider,
              account,
              policy,
              options,
              fs: deps.fs,
              fetchWithTimeout
            });
            logRetryFailure(policy, {
              status: policy.clientStatusCode || 502,
              upstreamUrl: geminiCodeAssistDiagnostic && geminiCodeAssistDiagnostic.upstreamUrl || upstreamUrl,
              upstreamError: codeAssistError
            });
            lastError = policy.detail;
            finalStatusCode = policy.clientStatusCode || 502;
            control.setLastError(lastError);
            // 同上：已开始流式就不能换账号重试（ERR_HTTP_HEADERS_SENT），直接结束被中断的流。
            if (res.headersSent || res.writableEnded) {
              try { if (!res.writableEnded) res.end(); } catch (_endError) { /* best effort */ }
              return { action: 'return' };
            }
            if (policy.shouldRetryAnotherAccount) return { action: 'retry_next' };
            writeJson(res, finalStatusCode, { ok: false, error: 'upstream_failed', detail: lastError });
            return { action: 'return' };
          }
        }

        if (
          codeAssistProvider
          && method === 'POST'
          && String(req.url || '').startsWith('/v1/chat/completions')
          && typeof fetchGeminiCodeAssistChatCompletion === 'function'
        ) {
        try {
          const streamMode = !!(requestJson && requestJson.stream);
          if (streamMode && typeof fetchGeminiCodeAssistChatCompletionStream === 'function') {
            try {
              console.log(`[aih] Dispatching stream chat completion to Gemini Code Assist (account: ${account.accountRef}, model: ${requestJson && requestJson.model})`);
              const upstreamStream = await fetchGeminiCodeAssistChatCompletionStream(
                accountGeminiRequestOptions,
                account,
                requestJson || {},
                attemptUpstreamTimeoutMs
              );
              streamTransport = 'upstream_sse';
              const id = `chatcmpl-${Date.now()}`;
              const created = Math.floor(Date.now() / 1000);
              let model = String(requestJson && requestJson.model || 'unknown').trim() || 'unknown';
              let finished = false;
              let hasStreamToolCalls = false;

              res.statusCode = 200;
              res.setHeader('content-type', 'text/event-stream; charset=utf-8');
              res.setHeader('cache-control', 'no-cache');
              res.setHeader('connection', 'keep-alive');
              res.setHeader('x-aih-server-account-ref', account.accountRef);
              if (account.email) res.setHeader('x-aih-server-account-email', account.email);
              const usageCapture = createModelUsageCapture();
              res.write(`data: ${JSON.stringify({
                id,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
              })}\n\n`);

              for await (const piece of upstreamStream) {
                usageCapture.observePayload(piece);
                const modelFromPiece = String(piece && piece.model || '').trim();
                if (modelFromPiece) model = modelFromPiece;
                const candidates = Array.isArray(piece && piece.candidates) ? piece.candidates : [];
                const toolCallsByCandidate = Array.isArray(piece && piece.toolCallsByCandidate)
                  ? piece.toolCallsByCandidate
                  : [];
                for (let candidateIdx = 0; candidateIdx < candidates.length; candidateIdx += 1) {
                  const candidate = candidates[candidateIdx];
                  const toolCalls = Array.isArray(toolCallsByCandidate[candidateIdx])
                    ? toolCallsByCandidate[candidateIdx]
                    : [];
                  if (toolCalls.length > 0) {
                    hasStreamToolCalls = true;
                    const normalizedToolCalls = toolCalls.map((toolCall, index) => ({
                      index,
                      id: String(toolCall && toolCall.id || `call_${index + 1}`),
                      type: 'function',
                      function: {
                        name: String(
                          toolCall
                          && toolCall.function
                          && toolCall.function.name
                          || ''
                        ),
                        arguments: String(
                          toolCall
                          && toolCall.function
                          && toolCall.function.arguments
                          || '{}'
                        )
                      }
                    }));
                    res.write(`data: ${JSON.stringify({
                      id,
                      object: 'chat.completion.chunk',
                      created,
                      model,
                      choices: [{ index: 0, delta: { tool_calls: normalizedToolCalls }, finish_reason: null }]
                    })}\n\n`);
                  }
                  const parts = Array.isArray(candidate && candidate.content && candidate.content.parts)
                    ? candidate.content.parts
                    : [];
                  const thoughtText = parts
                    .filter((part) => part && part.thought === true)
                    .map((part) => String(part && part.text || ''))
                    .join('');
                  if (thoughtText) {
                    res.write(`data: ${JSON.stringify({
                      id,
                      object: 'chat.completion.chunk',
                      created,
                      model,
                      choices: [{ index: 0, delta: { reasoning_content: thoughtText }, finish_reason: null }]
                    })}\n\n`);
                  }
                  const text = parts
                    .filter((part) => !(part && part.thought === true))
                    .map((part) => String(part && part.text || ''))
                    .join('');
                  if (text) {
                    res.write(`data: ${JSON.stringify({
                      id,
                      object: 'chat.completion.chunk',
                      created,
                      model,
                      choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
                    })}\n\n`);
                  }
                  // 图像生成模型把图片放在 inlineData part(base64),文本提取会漏掉;
                  // 转成 markdown data URL 图片,沿用现有文本渲染通道透出到前端。
                  const imageMarkdown = isImageGenerationModel(requestJson && requestJson.model)
                    ? extractInlineImageMarkdown(parts)
                    : '';
                  if (imageMarkdown) {
                    res.write(`data: ${JSON.stringify({
                      id,
                      object: 'chat.completion.chunk',
                      created,
                      model,
                      choices: [{ index: 0, delta: { content: `${text ? '\n\n' : ''}${imageMarkdown}` }, finish_reason: null }]
                    })}\n\n`);
                  }
                  const finishReasonRaw = String(candidate && candidate.finishReason || '').trim().toUpperCase();
                  if (!finished && finishReasonRaw) {
                    const finishReason = resolveOpenAIChatFinishReason(
                      mapGeminiFinishReason(finishReasonRaw),
                      { hasToolCalls: hasStreamToolCalls }
                    );
                    res.write(`data: ${JSON.stringify({
                      id,
                      object: 'chat.completion.chunk',
                      created,
                      model,
                      choices: [{ index: 0, delta: {}, finish_reason: finishReason }]
                    })}\n\n`);
                    finished = true;
                  }
                }
              }

              if (!finished) {
                res.write(`data: ${JSON.stringify({
                  id,
                  object: 'chat.completion.chunk',
                  created,
                  model,
                  choices: [{
                    index: 0,
                    delta: {},
                    finish_reason: resolveOpenAIChatFinishReason('stop', { hasToolCalls: hasStreamToolCalls })
                  }]
                })}\n\n`);
              }
              res.write('data: [DONE]\n\n');
              res.end();

              const capturedUsage = usageCapture.getUsageInput();
              recordSuccessfulModelUsage(recordModelUsage, {
                provider,
                account,
                requestMeta,
                requestJson,
                usage: capturedUsage && capturedUsage.usage,
                usageFormat: capturedUsage && capturedUsage.usageFormat,
                model: capturedUsage && capturedUsage.model || model,
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
                  streamTransport,
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

          console.log(`[aih] Dispatching buffered chat completion to Gemini Code Assist (account: ${account.accountRef}, model: ${requestJson && requestJson.model})`);
          const payload = await fetchGeminiCodeAssistChatCompletion(accountGeminiRequestOptions, account, requestJson || {}, attemptUpstreamTimeoutMs);
          if (streamMode) {
            streamTransport = 'buffered_fallback';
            const id = String(payload && payload.id || `chatcmpl-${Date.now()}`).trim();
            const created = Number(payload && payload.created) || Math.floor(Date.now() / 1000);
            const model = String(payload && payload.model || 'unknown').trim();
            const text = String(
              payload
              && Array.isArray(payload.choices)
              && payload.choices[0]
              && payload.choices[0].message
              && payload.choices[0].message.content
              || ''
            );
            const reasoningText = String(
              payload
              && Array.isArray(payload.choices)
              && payload.choices[0]
              && payload.choices[0].message
              && payload.choices[0].message.reasoning_content
              || ''
            );
            const toolCalls = (
              payload
              && Array.isArray(payload.choices)
              && payload.choices[0]
              && payload.choices[0].message
              && Array.isArray(payload.choices[0].message.tool_calls)
            ) ? payload.choices[0].message.tool_calls : [];
            const finishReason = resolveOpenAIChatFinishReason(String(
              payload
              && Array.isArray(payload.choices)
              && payload.choices[0]
              && payload.choices[0].finish_reason
              || (toolCalls.length > 0 ? 'tool_calls' : 'stop')
            ).trim() || (toolCalls.length > 0 ? 'tool_calls' : 'stop'), {
              hasToolCalls: toolCalls.length > 0
            });
            res.statusCode = 200;
            res.setHeader('content-type', 'text/event-stream; charset=utf-8');
            res.setHeader('cache-control', 'no-cache');
            res.setHeader('connection', 'keep-alive');
            res.setHeader('x-aih-server-account-ref', account.accountRef);
            if (account.email) res.setHeader('x-aih-server-account-email', account.email);
            const chunks = [{
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
            }];
            if (reasoningText) {
              chunks.push({
                id,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{ index: 0, delta: { reasoning_content: reasoningText }, finish_reason: null }]
              });
            }
            if (text) {
              chunks.push({
                id,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
              });
            }
            if (toolCalls.length > 0) {
              const normalizedToolCalls = toolCalls.map((toolCall, index) => ({
                index,
                id: String(toolCall && toolCall.id || `call_${index + 1}`),
                type: 'function',
                function: {
                  name: String(
                    toolCall
                    && toolCall.function
                    && toolCall.function.name
                    || ''
                  ),
                  arguments: String(
                    toolCall
                    && toolCall.function
                    && toolCall.function.arguments
                    || '{}'
                  )
                }
              }));
              chunks.push({
                id,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{ index: 0, delta: { tool_calls: normalizedToolCalls }, finish_reason: null }]
              });
            }
            chunks.push({
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [{ index: 0, delta: {}, finish_reason: finishReason }]
            });
            chunks.forEach((item) => {
              res.write(`data: ${JSON.stringify(item)}\n\n`);
            });
            res.write('data: [DONE]\n\n');
            res.end();
          } else {
            streamTransport = 'non_stream';
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
              streamTransport,
              ...geminiDiagnosticLogFields(),
              durationMs: Date.now() - requestStartedAt
            });
          }
          return { action: 'return' };
        } catch (codeAssistError) {
          if (String(codeAssistError && codeAssistError.code || '').trim() !== 'GEMINI_CODE_ASSIST_NOT_APPLICABLE') {
            const authRecovery = await handleCodeAssistAuthFailure(codeAssistError);
            if (authRecovery) return authRecovery;
            console.error(`[aih] Gemini Code Assist API error for account ${account.accountRef} (${account.email || 'no-email'}):`, codeAssistError);
            const match = String(codeAssistError && codeAssistError.code || '').trim().toUpperCase().match(/^HTTP_(\d{3})$/);
            const policy = classifyUpstreamFailure({
              provider,
              statusCode: match ? Number(match[1]) : 0,
              error: codeAssistError,
              defaultCooldownMs: cooldownMs
            });
            if (policy.kind === 'timeout') state.metrics.totalTimeouts += 1;
            recordAccountFailure(account, policy);
            scheduleAgyUsageRefreshAfterFailure({
              provider,
              account,
              policy,
              options,
              fs: deps.fs,
              fetchWithTimeout
            });
            logRetryFailure(policy, {
              status: policy.clientStatusCode || 502,
              upstreamUrl: geminiCodeAssistDiagnostic && geminiCodeAssistDiagnostic.upstreamUrl || upstreamUrl,
              upstreamError: codeAssistError
            });
            lastError = policy.detail;
            finalStatusCode = policy.clientStatusCode || 502;
            control.setLastError(lastError);
            if (policy.shouldRetryAnotherAccount) return { action: 'retry_next' };
            writeJson(res, finalStatusCode, { ok: false, error: 'upstream_failed', detail: lastError });
            return { action: 'return' };
          }
        }
      }

      const headers = {};
      Object.entries(req.headers || {}).forEach(([k, v]) => {
        const key = String(k || '').toLowerCase();
        if (shouldSkipForwardHeader(k)) return;
        const normalized = normalizeHeaderValue(v);
        if (!normalized) return;
        if (!isSafeHeaderValue(normalized)) return;
        headers[key] = normalized;
      });
      headers.authorization = `Bearer ${accessToken}`;
      if (provider === 'kimi' && !isApiCredentialAccount(account)) {
        Object.assign(headers, buildKimiRequestHeaders(account));
      }
      let forwardBody = guardedBodyBuffer;
      if (provider === 'claude' && isClaudeMessagesPath(upstreamPath)) {
        if (!headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01';
        if (isApiCredentialAccount(account)) {
          delete headers.authorization;
          headers['x-api-key'] = accessToken;
        } else {
          delete headers['x-api-key'];
          headers.authorization = `Bearer ${accessToken}`;
          if (!headers['anthropic-beta']) headers['anthropic-beta'] = 'oauth-2025-04-20';
        }
        // 订阅额度按 Claude Code 客户端判定。真实 Claude Code 自带这份身份，
        // 其请求在此保持字节不变；任何缺失它的客户端若不补齐会被上游按限流拒绝。
        applyClaudeCodeIdentityHeaders(headers, account);
        forwardBody = ensureClaudeCodeSystemBuffer(forwardBody, account);
      }
      if (provider === 'zcode' && isClaudeMessagesPath(upstreamPath)) {
        // zcode 上游是 Anthropic 兼容端点：API-key 账号用 x-api-key。
        // OAuth 计划账号走 zcode-plan anthropic 推理端点（桌面端同款双头：
        // Bearer + x-api-key，凭据均为 zcodeJwtToken）；每请求强制阿里云验证码
        // （400 code 3007），由下方 3007 拦截分支经 WebUI 验证码桥求解后重发。
        if (!headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01';
        if (isApiCredentialAccount(account)) {
          delete headers.authorization;
          headers['x-api-key'] = accessToken;
        } else {
          const zcodeJwt = String(account.zcodeJwtToken || '').trim() || accessToken;
          headers.authorization = `Bearer ${zcodeJwt}`;
          headers['x-api-key'] = zcodeJwt;
          // 对齐桌面端黄金请求身份（2026-08-18 mitm 取证，见
          // zcode-official-client.js 头注释）：缺这份身份的请求在验证码门
          // 之后会被 405/3012 间歇闸掉。
          const applied = applyZcodeDesktopIdentity(headers, forwardBody, account);
          forwardBody = applied.bodyBuffer;
        }
      }
      // The local HTTP proxy can return a gzip body while stripping both
      // content-encoding and content-type. Ask for identity on streams so the
      // body can be forwarded incrementally; the pipe still sniffs gzip magic
      // below as a defensive fallback for non-compliant upstreams/proxies.
      if (streamRequested) headers['accept-encoding'] = 'identity';
      // Account-configured overrides win over inherited client headers; some
      // relay endpoints reject requests that lack their required markers.
      // Applied before the internal x-aih-* markers so those stay authoritative.
      applyAccountUpstreamHeaders(headers, account);
      headers['x-aih-account-ref'] = account.accountRef;
      headers['x-aih-account-email'] = account.email || '';
      // zcode 官方端点不透传内部记账标记与下游浏览器杂头（mitm 黄金请求无这些
      // 字段；账号邮箱不应泄露给上游）。下游响应头上的 x-aih-server-account-ref
      // 不受影响。
      if (isNativeZcodeOAuthAccount(account) && isClaudeMessagesPath(upstreamPath)) {
        delete headers['x-aih-account-ref'];
        delete headers['x-aih-account-email'];
        for (const name of [
          'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-dest', 'sec-fetch-user',
          'accept-language', 'priority'
        ]) {
          delete headers[name];
        }
      }
      // Keep the selected account observable even when the upstream error is
      // normalized locally instead of passed through with response headers.
      if (account.accountRef) res.setHeader('x-aih-server-account-ref', account.accountRef);

      console.log(`[aih] Forwarding general request to upstream: ${method} ${upstreamUrl} (account: ${account.accountRef})`);
      const responseOpenTimeoutMs = streamRequested
        ? Math.max(STREAM_RESPONSE_OPEN_TIMEOUT_MS, Number(attemptUpstreamTimeoutMs) || 0)
        : attemptUpstreamTimeoutMs;
      const downstreamAbort = createDownstreamAbortContext(req, res);
      let upstreamRes;
      try {
        upstreamRes = await fetchWithTimeout(upstreamUrl, {
          method,
          headers,
          body: ['GET', 'HEAD'].includes(method) ? undefined : forwardBody,
          signal: downstreamAbort.signal
        }, responseOpenTimeoutMs, {
          proxyUrl: options.proxyUrl,
          noProxy: options.noProxy
        });
      } catch (error) {
        if (downstreamAbort.isDisconnected()) {
          streamTransport = 'downstream_cancelled';
          return { action: 'return' };
        }
        throw error;
      } finally {
        downstreamAbort.dispose();
      }

      let upstreamErrorText = '';
      if (upstreamRes.status >= 400) {
        upstreamErrorText = typeof upstreamRes.clone === 'function'
          ? await upstreamRes.clone().text().catch(() => '')
          : '';
        console.error(`[aih] Upstream returned error status ${upstreamRes.status} for ${method} ${upstreamUrl}:`, upstreamErrorText);
      }

      // zcode OAuth 计划账号：400 {"code":3007} 是「缺阿里云验证码」的请求级拦截，
      // 不是账号失效——首次 3007 不计失败、不熔断。经 WebUI 验证码桥拿到一次性
      // verify param 后原样重发一次（桌面端同款 X-Aliyun-Captcha-Verify-Param 头）。
      // 重发仍 3007 才落入下方普通失败处理（此时才参与熔断记账）。
      if (
        upstreamRes.status >= 400
        && provider === 'zcode'
        && !isApiCredentialAccount(account)
        && isZcodeCaptchaRequiredErrorBody(upstreamErrorText)
      ) {
        console.log(`[aih:zcode-captcha] 3007 captcha required (account: ${account.accountRef}, at: ${new Date().toISOString()})`);
        const captchaBridge = deps.zcodeCaptchaBridge;
        if (captchaBridge && typeof captchaBridge.requestVerification === 'function') {
          // 诊断模式（AIH_ZCODE_CAPTCHA_EXPERIMENT=1）：变体矩阵逐个用全新 param
          // 试上游，找出 405 的触发条件；任一变体成功即作为本次响应返回。
          if (process.env.AIH_ZCODE_CAPTCHA_EXPERIMENT === '1') {
            const { runCaptchaRetryExperiment } = require('./zcode-captcha-experiment');
            const outcome = await runCaptchaRetryExperiment({
              bridge: captchaBridge,
              account,
              upstreamUrl,
              method,
              baseHeaders: headers,
              forwardBody,
              fetchWithTimeout,
              timeoutMs: responseOpenTimeoutMs,
              proxyOptions: { proxyUrl: options.proxyUrl, noProxy: options.noProxy },
              verifyTimeoutMs: ZCODE_CAPTCHA_VERIFY_TIMEOUT_MS
            });
            if (outcome && outcome.res && outcome.res.status < 400) {
              upstreamRes = outcome.res;
              upstreamErrorText = '';
            } else {
              lastError = 'zcode_captcha_required: experiment_all_variants_failed';
              finalStatusCode = 409;
              control.setLastError(lastError);
              writeJson(res, 409, {
                ok: false,
                error: 'zcode_captcha_required',
                detail: 'captcha 重试变体矩阵全部失败，详见服务端日志 [aih:zcode-captcha-x]',
                reason: 'experiment_all_variants_failed',
                results: outcome ? outcome.results : []
              });
              return { action: 'return' };
            }
          } else {
            const verification = await captchaBridge.requestVerification(account.accountRef, {
              timeoutMs: ZCODE_CAPTCHA_VERIFY_TIMEOUT_MS
            });
            if (verification && verification.ok && verification.verifyParam) {
              headers['x-aliyun-captcha-verify-param'] = verification.verifyParam;
              if (verification.region) headers['x-aliyun-captcha-verify-region'] = verification.region;
              // 黄金请求实证（2026-08-18 mitm）：成功请求保持桌面端 ZCode UA，
              // verify param 不绑定求解浏览器的 UA/sec-ch-ua，因此这里绝不覆盖
              // 身份头——桌面端「求解在渲染层、请求在 agent」天然就是分离的。
              console.log(`[aih:zcode-captcha] retrying upstream with verify param (account: ${account.accountRef}, at: ${new Date().toISOString()})`);
              const retryAbort = createDownstreamAbortContext(req, res);
              try {
                upstreamRes = await fetchWithTimeout(upstreamUrl, {
                  method,
                  headers,
                  body: ['GET', 'HEAD'].includes(method) ? undefined : forwardBody,
                  signal: retryAbort.signal
                }, responseOpenTimeoutMs, {
                  proxyUrl: options.proxyUrl,
                  noProxy: options.noProxy
                });
              } catch (error) {
                if (retryAbort.isDisconnected()) {
                  streamTransport = 'downstream_cancelled';
                  return { action: 'return' };
                }
                throw error;
              } finally {
                retryAbort.dispose();
              }
              if (upstreamRes.status >= 400) {
                upstreamErrorText = typeof upstreamRes.clone === 'function'
                  ? await upstreamRes.clone().text().catch(() => '')
                  : '';
                console.error(`[aih] Upstream returned error status ${upstreamRes.status} for ${method} ${upstreamUrl} after captcha retry:`, upstreamErrorText);
              }
            } else {
              const reason = String(verification && verification.reason || 'captcha_unavailable');
              console.log(`[aih:zcode-captcha] verification failed: ${reason} (account: ${account.accountRef}, at: ${new Date().toISOString()})`);
              lastError = `zcode_captcha_required: ${reason}`;
              finalStatusCode = 409;
              control.setLastError(lastError);
              writeJson(res, 409, {
                ok: false,
                error: 'zcode_captcha_required',
                detail: 'zcode 计划端点要求阿里云人机验证；请在 WebUI 账号页完成验证后重试',
                reason
              });
              return { action: 'return' };
            }
          }
        }
        // 未注入验证码桥：按原逻辑走下方普通失败处理。
      }

      if (upstreamRes.status === 401 || upstreamRes.status === 403) {
        const accountRef = String(account.accountRef || '');
        const allowRefreshRetry = (
          canRefreshAccount
          && !forcedRefreshRetryUsed.has(accountRef)
        );
        if (allowRefreshRetry) {
          let refreshResult = null;
          try {
            refreshResult = await refreshProviderAccessToken(account, {
              force: true,
              timeoutMs: attemptUpstreamTimeoutMs,
              proxyUrl: options.proxyUrl,
              noProxy: options.noProxy
            }, {
              fetchWithTimeout
            });
          } catch (_error) {
            refreshResult = {
              ok: false,
              refreshed: false,
              reason: 'refresh_exception'
            };
          }
          if (refreshResult && refreshResult.ok && refreshResult.refreshed) {
            forcedRefreshRetryUsed.add(accountRef);
            control.retrySameAccount();
            return { action: 'retry_same' };
          }
          if (!isUnrecoverableTokenRefreshFailure(refreshResult)) {
            const policy = createTokenRefreshUnavailablePolicy(provider, refreshResult, cooldownMs);
            recordAccountFailure(account, policy);
            logRetryFailure(policy, {
              status: 503,
              upstreamStatus: upstreamRes.status
            });
            lastError = policy.detail;
            finalStatusCode = 503;
            control.setLastError(lastError);
            return { action: requestedAccountRef ? 'break' : 'retry_next' };
          }
        }
        let authFailureBody = '';
        try {
          authFailureBody = String(Buffer.from(await upstreamRes.arrayBuffer()));
        } catch (_error) {}
        const policy = classifyUpstreamFailure({
          provider,
          statusCode: upstreamRes.status,
          headers: upstreamRes.headers,
          body: authFailureBody,
          detail: `upstream_${upstreamRes.status}_account_${account.accountRef}`,
          defaultCooldownMs: cooldownMs
        });
        recordAccountFailure(account, policy);
        logRetryFailure(policy, {
          status: upstreamRes.status,
          upstreamStatus: upstreamRes.status,
          upstreamHeaders: upstreamRes.headers,
          upstreamBody: authFailureBody
        });
        lastError = policy.detail;
        finalStatusCode = policy.clientStatusCode || upstreamRes.status || 502;
        control.setLastError(lastError);
        return { action: 'retry_next' };
      }

      const normalizeClaudeMessagesResponse = provider === 'claude' && isClaudeMessagesPath(upstreamPath);
      const upstreamContentType = String(upstreamRes.headers.get('content-type') || '').toLowerCase();
      if (
        streamRequested
        && upstreamRes.status < 400
        && upstreamRes.body
        && (
          normalizeClaudeMessagesResponse
          || upstreamContentType.includes('text/event-stream')
        )
      ) {
        streamTransport = 'upstream_sse';
        writeGeneralUpstreamResponseHeaders(res, upstreamRes, account, {
          normalizeClaudeMessagesResponse,
          streamRequested: true
        });
        if (typeof res.flushHeaders === 'function') res.flushHeaders();

        const usageTail = createBoundedTailCapture();
        let streamWriteError = null;
        let pipeResult = { downstreamDisconnected: false };
        try {
          pipeResult = await pipeReadableBodyToResponse(upstreamRes.body, res, {
            onChunk: (chunk) => usageTail.append(chunk)
          });
        } catch (error) {
          streamWriteError = error;
        }

        if (pipeResult.downstreamDisconnected) {
          streamTransport = 'downstream_cancelled';
          if (options.logRequests) {
            appendProxyRequestLog({
              at: new Date().toISOString(),
              requestId: requestMeta && requestMeta.requestId,
              route: routeKey,
              provider,
              accountRef: account.accountRef,
              status: 499,
              streamRequested,
              streamTransport,
              durationMs: Date.now() - requestStartedAt
            });
          }
          return { action: 'return' };
        }

        try { if (!res.writableEnded) res.end(); } catch (_endError) { /* best effort */ }
        if (streamWriteError) {
          streamTransport = 'upstream_sse_error';
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
              status: upstreamRes.status,
              error: policy.detail,
              streamRequested,
              streamTransport,
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
          sourceKind: 'server_proxy'
        });
        recordAccountSuccess(account);
        if (options.logRequests) {
          appendProxyRequestLog({
            at: new Date().toISOString(),
            requestId: requestMeta && requestMeta.requestId,
            route: routeKey,
            provider,
            accountRef: account.accountRef,
            status: upstreamRes.status,
            streamRequested,
            streamTransport,
            durationMs: Date.now() - requestStartedAt
          });
        }
        return { action: 'return' };
      }

      const upstreamRaw = Buffer.from(await upstreamRes.arrayBuffer());
      // Relays that wrap completions in a {"data":...,"success":true} envelope
      // are normalized back to the canonical OpenAI shape; anything else keeps
      // its original bytes.
      const envelopeBody = (streamRequested || upstreamRes.status >= 400)
        ? null
        : unwrapUpstreamEnvelopeBody(
          upstreamRaw,
          String(upstreamRes.headers.get('content-encoding') || '')
        );
      const raw = envelopeBody || (normalizeClaudeMessagesResponse
        ? Buffer.from(decodeResponseBuffer(
          upstreamRaw,
          String(upstreamRes.headers.get('content-encoding') || '')
        ), 'utf8')
        : upstreamRaw);
      if (streamRequested) {
        streamTransport = upstreamContentType.includes('text/event-stream')
          ? 'upstream_sse'
          : 'passthrough_raw';
      } else {
        streamTransport = 'non_stream';
      }
      if (upstreamRes.status >= 400) {
        const detail = `upstream_${upstreamRes.status}: ${String(raw).slice(0, 320)}`;
        const policy = classifyUpstreamFailure({
          provider,
          statusCode: upstreamRes.status,
          headers: upstreamRes.headers,
          body: String(raw),
          detail,
          defaultCooldownMs: cooldownMs
        });
        recordAccountFailure(account, policy);
        scheduleAgyUsageRefreshAfterFailure({
          provider,
          account,
          policy,
          options,
          fs: deps.fs,
          fetchWithTimeout
        });
        if (policy.shouldRetryAnotherAccount) {
          logRetryFailure(policy, {
            status: upstreamRes.status,
            upstreamStatus: upstreamRes.status,
            upstreamHeaders: upstreamRes.headers,
            upstreamBody: String(raw)
          });
        }
        lastError = policy.detail;
        finalStatusCode = policy.clientStatusCode || upstreamRes.status || 502;
        control.setLastError(lastError);
        // 冷缓存 unchecked 模式：无法按模型过滤账号，当前账号 4xx 尝试下一个
        const uncheckedColdRetry = modelPoolSelection.unchecked && upstreamRes.status >= 400 && upstreamRes.status < 500;
        if (policy.shouldRetryAnotherAccount || uncheckedColdRetry) {
          // 换账号之前留档：如果后面没有账号可续，这就是本次请求唯一的真相，
          // 必须原样还给客户端，而不是把 429 粉饰成「无可调度账号」。
          upstreamFailureRecorder.record({
            statusCode: finalStatusCode,
            upstreamRes,
            raw,
            account,
            streamRequested,
            passthrough: Boolean(policy.shouldPassthroughToClient && raw.length > 0),
            error: 'upstream_failed',
            detail: lastError
          });
          return { action: 'retry_next' };
        }
        state.metrics.totalFailures += 1;
        state.metrics.providerFailures[provider] = Number(state.metrics.providerFailures[provider] || 0) + 1;
        pushMetricError(state.metrics, routeKey, provider, {
          message: lastError,
          error: 'upstream_failed',
          accountRef: account.accountRef,
          model: (requestJson && requestJson.model) || (requestMeta && requestMeta.model) || '',
          sessionId: requestMeta && (requestMeta.sessionId || requestMeta.sessionKey),
          projectPath: requestMeta && requestMeta.projectPath,
          projectDirName: requestMeta && requestMeta.projectDirName
        });
        if (options.logRequests) {
          appendProxyRequestLog({
            at: new Date().toISOString(),
            requestId: requestMeta && requestMeta.requestId,
            route: routeKey,
            provider,
            accountRef: account.accountRef,
            status: upstreamRes.status,
            error: lastError,
            streamRequested,
            streamTransport,
            durationMs: Date.now() - requestStartedAt
          });
        }
        if (policy.shouldPassthroughToClient && raw.length > 0) {
          sendRawUpstreamResponse(res, upstreamRes, raw, account, streamRequested);
        } else {
          writeJson(res, finalStatusCode, { ok: false, error: 'upstream_failed', detail: lastError });
        }
        return { action: 'return' };
      }

      writeGeneralUpstreamResponseHeaders(res, upstreamRes, account, {
        normalizeClaudeMessagesResponse,
        streamRequested,
        bodyRewritten: Boolean(envelopeBody)
      });
      res.setHeader('content-length', raw.length);
      res.end(raw);

      recordSuccessfulModelUsage(recordModelUsage, {
        provider,
        account,
        requestMeta,
        requestJson,
        raw,
        sourceKind: 'server_proxy'
      });
      recordAccountSuccess(account);
      if (options.logRequests) {
        appendProxyRequestLog({
          at: new Date().toISOString(),
          requestId: requestMeta && requestMeta.requestId,
          route: routeKey,
          provider,
          accountRef: account.accountRef,
          status: upstreamRes.status,
          streamRequested,
          streamTransport,
          durationMs: Date.now() - requestStartedAt
        });
      }
      return { action: 'return' };
    } catch (e) {
      const policy = classifyUpstreamFailure({
        provider,
        error: e,
        defaultCooldownMs: cooldownMs
      });
      if (policy.kind === 'timeout') state.metrics.totalTimeouts += 1;
      recordAccountFailure(account, policy);
      scheduleAgyUsageRefreshAfterFailure({
        provider,
        account,
        policy,
        options,
        fs: deps.fs,
        fetchWithTimeout
      });
      logRetryFailure(policy, {
        status: policy.clientStatusCode || 502,
        upstreamError: e
      });
      lastError = policy.detail;
      finalStatusCode = policy.clientStatusCode || 502;
      // A transport exception is still a real upstream attempt. The optional
      // auth-refresh budget can leave no selectable sibling after this retry,
      // so preserve the timeout/network verdict before the orchestrator reports
      // `no_account`; otherwise a concrete 504 is rewritten as a false 503.
      upstreamFailureRecorder.record({
        statusCode: finalStatusCode,
        account,
        streamRequested,
        passthrough: false,
        error: 'upstream_failed',
        detail: lastError
      });
      if (isGlobalNetworkFailure(e)) {
        lastError = withNetworkHint(policy.detail, resolveProviderUpstream(options, provider, account));
        control.setLastError(lastError);
        return { action: 'break' };
      }
      control.setLastError(lastError);
      return { action: 'retry_next' };
    }

  };

  return async (account, control) => {
    streamTransport = attemptMutable.streamTransport;
    lastError = attemptMutable.lastError;
    finalStatusCode = attemptMutable.finalStatusCode;
    transientPoolRetryUsed = attemptMutable.transientPoolRetryUsed;
    transientPoolRetryDeadlineAt = attemptMutable.transientPoolRetryDeadlineAt;
    try {
      return await attemptBody(account, control);
    } finally {
      attemptMutable.streamTransport = streamTransport;
      attemptMutable.lastError = lastError;
      attemptMutable.finalStatusCode = finalStatusCode;
      attemptMutable.transientPoolRetryUsed = transientPoolRetryUsed;
      attemptMutable.transientPoolRetryDeadlineAt = transientPoolRetryDeadlineAt;
    }
  };
}

module.exports = {
  createUpstreamAttemptHandler
};
