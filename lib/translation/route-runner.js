'use strict';

const { getTranslationProviderFacade } = require('./provider-facade');
const { planTranslationRoutes } = require('./route-planner');

function abortedResult() {
  return { ok: false, text: '', usage: null, error: { code: 'translation_aborted', message: '翻译已取消', retryable: false } };
}

function classifyTranslationFailure(error = {}, options = {}) {
  error = error || {};
  const code = String(error.code || 'translation_failed');
  const status = Number(error.status) || 0;
  if (options.aborted || code === 'translation_aborted' || error.name === 'AbortError') return { code: 'translation_aborted', retryable: false };
  if (options.partial) return { code, retryable: false };
  if (typeof error.retryable === 'boolean') return { code, retryable: error.retryable };
  if (status) return { code, retryable: status === 408 || status === 409 || status === 425 || status === 429 || status >= 500 };
  return { code, retryable: !['translation_model_required', 'translation_input_invalid', 'translation_language_unsupported'].includes(code) };
}

async function executeWithAbort(execute, signal) {
  if (!signal) return execute();
  if (signal.aborted) return abortedResult();
  let onAbort;
  const cancelled = new Promise((resolve) => {
    onAbort = () => resolve(abortedResult());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => signal.aborted ? abortedResult() : execute()), cancelled]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

// A route executor owns transport. The chain owns ordering, attempts and the
// no-replay-after-output rule, regardless of the provider behind that executor.
async function runTranslationRoutes(input = {}, options = {}, emit = () => {}) {
  const facade = options.facade || getTranslationProviderFacade();
  const plan = planTranslationRoutes(options.routes || input.routes, { facade, operation: input.operation });
  const signal = options.signal;
  const attempts = [];
  let result = { ok: false, text: '', usage: null, error: { code: 'translation_routes_unavailable', message: '没有可用的翻译路由', retryable: false } };
  for (const entry of plan) {
    if (signal && signal.aborted) return { ...abortedResult(), attempts };
    const { route, descriptor, operation } = entry;
    const attempt = { attempt: attempts.length + 1, routeId: route.id, provider: route.provider, modelProvider: route.modelProvider || '', model: route.model, operation };
    emit({ type: 'attempt_start', ...attempt });
    let partialText = '';
    let finished = false;
    const forward = (event) => {
      if (finished || (signal && signal.aborted)) return;
      if (event.type === 'delta') partialText += String(event.content || '');
      // The HTTP boundary emits one final done/error for the entire chain.
      if (event.type !== 'done' && event.type !== 'error') emit(event);
    };
    try {
      if (!descriptor) {
        result = { ok: false, error: { code: 'translation_provider_unsupported', message: '翻译路由不支持此操作' } };
      } else {
        const context = { ...options, signal, route, descriptor, emit: forward };
        result = await executeWithAbort(() => typeof options.executeRoute === 'function'
          ? options.executeRoute({ ...input, operation, route }, context, forward)
          : facade.execute({ ...input, provider: descriptor.id, operation, route }, context), signal);
      }
      if (!result || typeof result.ok !== 'boolean') result = { ok: false, error: { code: 'translation_result_invalid', message: '翻译路由返回了无效结果' } };
    } catch (error) {
      error = error || {};
      result = { ok: false, error: { code: error.code || (error.name === 'AbortError' ? 'translation_aborted' : 'translation_route_failed'), message: String(error.message || '翻译路由失败'), status: error.status, retryable: error.retryable } };
    }
    if (signal && signal.aborted) result = abortedResult();
    if (result.ok && !String(result.text || partialText).trim()) result = { ...result, ok: false, error: { code: 'translation_empty_output', message: '上游没有返回译文' } };
    if (result.ok) {
      if (!partialText && result.text) forward({ type: 'delta', content: String(result.text) });
      finished = true;
      attempts.push({ ...attempt, ok: true, retryable: false });
      emit({ type: 'attempt_success', ...attempt, retryable: false });
      return { ...result, route, attempts };
    }
    const failure = classifyTranslationFailure(result.error, { aborted: signal && signal.aborted, partial: Boolean(partialText || result.text) });
    finished = true;
    result = { ...result, text: partialText || result.text || '', error: { ...result.error, ...failure } };
    attempts.push({ ...attempt, ok: false, ...failure });
    emit({ type: 'attempt_failure', ...attempt, ...failure, status: Number(result.error.status) || 0 });
    if (!failure.retryable) break;
  }
  return { ...result, attempts };
}

module.exports = { runTranslationRoutes, classifyTranslationFailure };
