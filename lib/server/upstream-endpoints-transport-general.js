'use strict';

const { appendUpstreamFailureDiagnosticLog } = require('./diagnostic-log');
const { isApiCredentialAccount } = require('../account/runtime-auth-mode');
const {
  applyClaudeCodeIdentityHeaders,
  ensureClaudeCodeSystemBuffer
} = require('./claude-official-client');
const { buildKimiRequestHeaders } = require('./kimi-request-headers');
const { applyAccountUpstreamHeaders } = require('./upstream-account-profile');
const { isClaudeMessagesPath } = require('./upstream-endpoints-path');
const { ensureZcodeThinkingBuffer } = require('./zcode-anthropic-thinking');
const { detectUpstreamBusinessFailure } = require('./zcode-business-error');
const {
  shouldSkipForwardHeader,
  normalizeHeaderValue,
  isSafeHeaderValue,
  sendRawUpstreamResponse,
  writeGeneralUpstreamResponseHeaders
} = require('./upstream-endpoints-headers');
const { STREAM_RESPONSE_OPEN_TIMEOUT_MS } = require('./upstream-endpoints-utils');
const { classifyUpstreamFailure } = require('./upstream-failure-policy');
const {
  createBoundedTailCapture,
  createDownstreamAbortContext,
  pipeReadableBodyToResponse
} = require('./upstream-stream-forwarder');
const {
  isUnrecoverableTokenRefreshFailure
} = require('./token-refresh-result');
const {
  createTokenRefreshUnavailablePolicy
} = require('./upstream-endpoints-failure');
const { scheduleAgyUsageRefreshAfterFailure } = require('./agy-usage-snapshot');
const {
  recordSuccessfulModelUsage
} = require('./upstream-endpoints-usage');
const { unwrapUpstreamEnvelopeBody } = require('./openai-response-envelope');
const { decodeResponseBuffer } = require('./response-body');

/**
 * General passthrough transport strategy (Strategy pattern).
 *
 * Terminal fallback of the attempt transport chain: forwards the request
 * verbatim to the resolved upstream (header normalization, provider-specific
 * identity/body shaping, streaming pipe or buffered body,
 * refresh-on-401/403, usage and failure accounting).
 *
 * matches() always returns true — this transport must be the LAST entry of the
 * chain. Mutable attempt state (streamTransport/lastError/finalStatusCode) is
 * written through ctx.attemptMutable; the attempt handler syncs it back to its
 * own scope around the chain call, including on escape paths into the outer
 * attempt catch. logRetryFailure reads the live attemptMutable values (the
 * factory-scope copy in the attempt module would observe stale pre-chain
 * values, so this module keeps its own reader).
 *
 * ctx fields consumed:
 *   options, state, req, res, method, requestJson, routeKey, requestStartedAt,
 *   cooldownMs, requestMeta, deps, provider, streamRequested,
 *   recordAccountSuccess, recordAccountFailure, upstreamFailureRecorder,
 *   diagnosticMaxAttempts, fetchWithTimeout, writeJson, recordModelUsage,
 *   appendProxyRequestLog, control, account, attemptUpstreamTimeoutMs,
 *   upstreamUrl, attemptMutable, accessToken, upstreamPath, guardedBodyBuffer,
 *   canRefreshAccount, forcedRefreshRetryUsed, modelPoolSelection,
 *   pushMetricError, refreshProviderAccessToken, requestedAccountRef
 */
const generalPassthroughTransport = {
  matches() {
    return true;
  },

  async run(ctx) {
    const {
      options,
      state,
      req,
      res,
      method,
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
      writeJson,
      recordModelUsage,
      appendProxyRequestLog,
      control,
      account,
      attemptUpstreamTimeoutMs,
      upstreamUrl,
      attemptMutable,
      accessToken,
      upstreamPath,
      guardedBodyBuffer,
      canRefreshAccount,
      forcedRefreshRetryUsed,
      modelPoolSelection,
      pushMetricError,
      refreshProviderAccessToken,
      requestedAccountRef
    } = ctx;
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
        geminiCodeAssist: attemptMutable.geminiCodeAssistDiagnostic || undefined,
        policy,
        ...data
      });
    };

    // --- general passthrough (verbatim from the inline attempt body) ---
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
      // zcode 上游是 Anthropic 兼容端点，仅保留 API-key 账号（x-api-key 直连
      // open.bigmodel.cn / api.z.ai）。OAuth 计划账号 relay 已于 2026-08-19 取消：
      // Start Plan 推理准入门由 Z.ai 服务端活动窗口控制（405/3012，官方桌面端同待遇），
      // 客户端侧无解；OAuth 账号不再进入推理池（accounts.js loadZcodeServerAccounts）。
      if (!headers['anthropic-version']) headers['anthropic-version'] = '2023-06-01';
      delete headers.authorization;
      headers['x-api-key'] = accessToken;
      // GLM「始终思考」模型（glm-5.3）必须显式 thinking，缺失时上游 400 (1210)。
      // 客户端自带 thinking 或模型不在清单内时缓冲区逐字节不变。
      forwardBody = ensureZcodeThinkingBuffer(forwardBody);
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
        attemptMutable.streamTransport = 'downstream_cancelled';
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
          attemptMutable.lastError = policy.detail;
          attemptMutable.finalStatusCode = 503;
          control.setLastError(attemptMutable.lastError);
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
      attemptMutable.lastError = policy.detail;
      attemptMutable.finalStatusCode = policy.clientStatusCode || upstreamRes.status || 502;
      control.setLastError(attemptMutable.lastError);
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
      attemptMutable.streamTransport = 'upstream_sse';
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
        attemptMutable.streamTransport = 'downstream_cancelled';
        if (options.logRequests) {
          appendProxyRequestLog({
            at: new Date().toISOString(),
            requestId: requestMeta && requestMeta.requestId,
            route: routeKey,
            provider,
            accountRef: account.accountRef,
            status: 499,
            streamRequested,
            streamTransport: attemptMutable.streamTransport,
            durationMs: Date.now() - requestStartedAt
          });
        }
        return { action: 'return' };
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
            status: upstreamRes.status,
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
          streamTransport: attemptMutable.streamTransport,
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
      attemptMutable.streamTransport = upstreamContentType.includes('text/event-stream')
        ? 'upstream_sse'
        : 'passthrough_raw';
    } else {
      attemptMutable.streamTransport = 'non_stream';
    }
    // zcode 家族把业务失败放在 HTTP 200 的响应体里（详见 zcode-business-error）。
    // 只按状态码判定会把这类拒绝当成功放行：不记失败、不熔断、不换账号，
    // 客户端只拿到一段无法解析的 JSON。识别出来后归一成一次真实失败，
    // 复用下面与 4xx/5xx 完全相同的既有路径，不另起一套并行机制。
    const businessError = detectUpstreamBusinessFailure({
      provider,
      statusCode: upstreamRes.status,
      body: raw
    });
    // 业务信封的传输状态是 200，对失败分类毫无意义；传 0 让分类器走结构化
    // 业务码判定，避免把 200 当成「上游成功」的证据。
    const failureStatusCode = businessError ? 0 : upstreamRes.status;
    if (upstreamRes.status >= 400 || businessError) {
      const detail = businessError
        ? `upstream_business_${businessError.code}: ${businessError.message}`
        : `upstream_${upstreamRes.status}: ${String(raw).slice(0, 320)}`;
      const policy = classifyUpstreamFailure({
        provider,
        statusCode: failureStatusCode,
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
      attemptMutable.lastError = policy.detail;
      attemptMutable.finalStatusCode = policy.clientStatusCode || failureStatusCode || 502;
      control.setLastError(attemptMutable.lastError);
      // 冷缓存 unchecked 模式：无法按模型过滤账号，当前账号 4xx 尝试下一个
      const uncheckedColdRetry = modelPoolSelection.unchecked && upstreamRes.status >= 400 && upstreamRes.status < 500;
      if (policy.shouldRetryAnotherAccount || uncheckedColdRetry) {
        // 换账号之前留档：如果后面没有账号可续，这就是本次请求唯一的真相，
        // 必须原样还给客户端，而不是把 429 粉饰成「无可调度账号」。
        upstreamFailureRecorder.record({
          statusCode: attemptMutable.finalStatusCode,
          upstreamRes,
          raw,
          account,
          streamRequested,
          passthrough: Boolean(policy.shouldPassthroughToClient && raw.length > 0),
          error: 'upstream_failed',
          detail: attemptMutable.lastError
        });
        return { action: 'retry_next' };
      }
      state.metrics.totalFailures += 1;
      state.metrics.providerFailures[provider] = Number(state.metrics.providerFailures[provider] || 0) + 1;
      pushMetricError(state.metrics, routeKey, provider, {
        message: attemptMutable.lastError,
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
          error: attemptMutable.lastError,
          streamRequested,
          streamTransport: attemptMutable.streamTransport,
          durationMs: Date.now() - requestStartedAt
        });
      }
      if (policy.shouldPassthroughToClient && raw.length > 0) {
        sendRawUpstreamResponse(res, upstreamRes, raw, account, streamRequested);
      } else {
        writeJson(res, attemptMutable.finalStatusCode, { ok: false, error: 'upstream_failed', detail: attemptMutable.lastError });
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
        streamTransport: attemptMutable.streamTransport,
        durationMs: Date.now() - requestStartedAt
      });
    }
    return { action: 'return' };
  }
};

module.exports = { generalPassthroughTransport };
