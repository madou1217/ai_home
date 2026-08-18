'use strict';

const { appendUpstreamFailureDiagnosticLog } = require('./diagnostic-log');
const { isApiCredentialAccount } = require('../account/runtime-auth-mode');
const {
  applyClaudeCodeIdentityHeaders,
  ensureClaudeCodeSystemBuffer
} = require('./claude-official-client');
const { buildKimiRequestHeaders } = require('./kimi-request-headers');
const { applyZcodeDesktopIdentity, isNativeZcodeOAuthAccount } = require('./zcode-official-client');
const { applyAccountUpstreamHeaders } = require('./upstream-account-profile');
const { isClaudeMessagesPath } = require('./upstream-endpoints-path');
const {
  shouldSkipForwardHeader,
  normalizeHeaderValue,
  isSafeHeaderValue,
  sendRawUpstreamResponse,
  writeGeneralUpstreamResponseHeaders
} = require('./upstream-endpoints-headers');
const { STREAM_RESPONSE_OPEN_TIMEOUT_MS } = require('./upstream-endpoints-utils');
const {
  isZcodeCaptchaRequiredErrorBody,
  DEFAULT_VERIFY_TIMEOUT_MS: ZCODE_CAPTCHA_VERIFY_TIMEOUT_MS
} = require('./zcode-captcha-bridge');
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
 * identity/body shaping, zcode captcha gate, streaming pipe or buffered body,
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
            attemptMutable.lastError = 'zcode_captcha_required: experiment_all_variants_failed';
            attemptMutable.finalStatusCode = 409;
            control.setLastError(attemptMutable.lastError);
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
                attemptMutable.streamTransport = 'downstream_cancelled';
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
            attemptMutable.lastError = `zcode_captcha_required: ${reason}`;
            attemptMutable.finalStatusCode = 409;
            control.setLastError(attemptMutable.lastError);
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
      attemptMutable.lastError = policy.detail;
      attemptMutable.finalStatusCode = policy.clientStatusCode || upstreamRes.status || 502;
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
