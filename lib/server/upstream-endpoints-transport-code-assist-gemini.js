'use strict';

const { classifyUpstreamFailure } = require('./upstream-failure-policy');
const { scheduleAgyUsageRefreshAfterFailure } = require('./agy-usage-snapshot');
const {
  isGeminiGenerateContentPath,
  isGeminiStreamGenerateContentPath
} = require('./upstream-endpoints-path');
const { requireNonEmptyGeminiGenerateContentStream } = require('./upstream-endpoints-sse');
const {
  recordSuccessfulModelUsage,
  createModelUsageCapture
} = require('./upstream-endpoints-usage');
const { mapGeminiFinishReason } = require('./upstream-endpoints-failure');
const { resolveOpenAIChatFinishReason } = require('./protocol-finish-reason');
const {
  isImageGenerationModel,
  extractInlineImageMarkdown
} = require('./code-assist-image-generation');
const { createCodeAssistHelpers } = require('./upstream-endpoints-code-assist-helpers');

/**
 * Code Assist Gemini transport strategy (Strategy pattern).
 *
 * Handles both Gemini Code Assist protocol surfaces through one transport:
 *   - generateContent (`/v1beta/...:generateContent`) for the Gemini client
 *     protocol, streaming via fetchGeminiCodeAssistGenerateContentStream with
 *     a buffered fallback;
 *   - `/v1/chat/completions` (OpenAI-compatible surface) via
 *     fetchGeminiCodeAssistChatCompletion(Stream), re-encoding Gemini pieces as
 *     OpenAI chat chunks with reasoning/tool-call/image-markdown support.
 *
 * Mutable attempt state (streamTransport/lastError/finalStatusCode) is read
 * and written through ctx.attemptMutable so the attempt handler observes the
 * same values it syncs in/out around each attempt. Retry/auth helpers and the
 * gemini code-assist diagnostic accumulator come from the shared
 * createCodeAssistHelpers factory; the diagnostic is synced out on every exit
 * path (including the escape path into the outer attempt catch).
 *
 * Note: when the chat-completions upstream answers GEMINI_CODE_ASSIST_NOT_APPLICABLE
 * the transport returns undefined (falls through the chain) so the attempt
 * handler continues to the general passthrough — the inline branch previously
 * swallowed that code the same way.
 */
const codeAssistGeminiTransport = {
  matches(ctx) {
    if (!ctx.codeAssistProvider || ctx.method !== 'POST') return false;
    const url = String(ctx.req && ctx.req.url || '');
    if (isGeminiGenerateContentPath(url)) {
      return typeof ctx.fetchGeminiCodeAssistGenerateContent === 'function';
    }
    if (url.startsWith('/v1/chat/completions')) {
      return typeof ctx.fetchGeminiCodeAssistChatCompletion === 'function';
    }
    return false;
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
      writeJson,
      fetchGeminiCodeAssistGenerateContent,
      fetchGeminiCodeAssistGenerateContentStream,
      fetchGeminiCodeAssistChatCompletion,
      fetchGeminiCodeAssistChatCompletionStream,
      recordModelUsage,
      appendProxyRequestLog,
      control,
      account,
      attemptUpstreamTimeoutMs,
      upstreamUrl,
      attemptMutable,
      req
    } = ctx;
    const helpers = createCodeAssistHelpers(ctx);
    const {
      accountGeminiRequestOptions,
      geminiDiagnosticLogFields,
      logRetryFailure,
      handleCodeAssistAuthFailure
    } = helpers;

    try {
      if (isGeminiGenerateContentPath(String(req && req.url || ''))) {
        // --- generateContent branch (verbatim from the inline attempt body) ---
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
            attemptMutable.streamTransport = 'upstream_sse';
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
                streamTransport: attemptMutable.streamTransport,
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
            attemptMutable.streamTransport = 'buffered_fallback';
            res.statusCode = 200;
            res.setHeader('content-type', 'text/event-stream; charset=utf-8');
            res.setHeader('cache-control', 'no-cache');
            res.setHeader('connection', 'keep-alive');
            res.setHeader('x-aih-server-account-ref', account.accountRef);
            if (account.email) res.setHeader('x-aih-server-account-email', account.email);
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
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
            upstreamUrl: helpers.diagnostic.value && helpers.diagnostic.value.upstreamUrl || upstreamUrl,
            upstreamError: codeAssistError
          });
          attemptMutable.lastError = policy.detail;
          attemptMutable.finalStatusCode = policy.clientStatusCode || 502;
          control.setLastError(attemptMutable.lastError);
          // 同上：已开始流式就不能换账号重试（ERR_HTTP_HEADERS_SENT），直接结束被中断的流。
          if (res.headersSent || res.writableEnded) {
            try { if (!res.writableEnded) res.end(); } catch (_endError) { /* best effort */ }
            return { action: 'return' };
          }
          if (policy.shouldRetryAnotherAccount) return { action: 'retry_next' };
          writeJson(res, attemptMutable.finalStatusCode, { ok: false, error: 'upstream_failed', detail: attemptMutable.lastError });
          return { action: 'return' };
        }
      } else {
        // --- chat completions branch (verbatim from the inline attempt body) ---
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
              attemptMutable.streamTransport = 'upstream_sse';
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

          console.log(`[aih] Dispatching buffered chat completion to Gemini Code Assist (account: ${account.accountRef}, model: ${requestJson && requestJson.model})`);
          const payload = await fetchGeminiCodeAssistChatCompletion(accountGeminiRequestOptions, account, requestJson || {}, attemptUpstreamTimeoutMs);
          if (streamMode) {
            attemptMutable.streamTransport = 'buffered_fallback';
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
              upstreamUrl: helpers.diagnostic.value && helpers.diagnostic.value.upstreamUrl || upstreamUrl,
              upstreamError: codeAssistError
            });
            attemptMutable.lastError = policy.detail;
            attemptMutable.finalStatusCode = policy.clientStatusCode || 502;
            control.setLastError(attemptMutable.lastError);
            if (policy.shouldRetryAnotherAccount) return { action: 'retry_next' };
            writeJson(res, attemptMutable.finalStatusCode, { ok: false, error: 'upstream_failed', detail: attemptMutable.lastError });
            return { action: 'return' };
          }
        }
      }
    } finally {
      attemptMutable.geminiCodeAssistDiagnostic = helpers.diagnostic.value;
    }
  }
};

module.exports = { codeAssistGeminiTransport };
