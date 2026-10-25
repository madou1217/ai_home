'use strict';

function abortedResult() {
  return { ok: false, text: '', usage: null, attempts: [], error: { code: 'translation_aborted', message: '翻译已取消', retryable: false } };
}

function normalizeResult(result) {
  if (!result || typeof result !== 'object') return { ok: false, text: '', usage: null, attempts: [], error: { code: 'translation_result_invalid', message: '翻译返回了无效结果', retryable: true } };
  if (result.ok) return { ...result, text: String(result.text || ''), attempts: Array.isArray(result.attempts) ? result.attempts : [] };
  const error = result.error && typeof result.error === 'object' ? result.error : { code: 'translation_failed', message: '翻译失败', retryable: true };
  return { ...result, ok: false, text: String(result.text || ''), attempts: Array.isArray(result.attempts) ? result.attempts : [], error: { code: String(error.code || 'translation_failed'), message: String(error.message || '翻译失败'), retryable: error.retryable !== false, ...(error.status ? { status: Number(error.status) || 0 } : {}) } };
}

async function executeWithAbort(executor, request, context, signal) {
  if (!signal) return executor(request, context);
  if (signal.aborted) return abortedResult();
  let onAbort;
  const cancelled = new Promise((resolve) => {
    onAbort = () => resolve(abortedResult());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => signal.aborted ? abortedResult() : executor(request, context)),
      cancelled
    ]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function createTranslationExecutionPort({ direct, server } = {}) {
  const executors = { 'direct-provider': direct, 'aih-server': server };
  return {
    async translate(request = {}, options = {}) {
      const signal = options.signal;
      if (signal && signal.aborted) return abortedResult();
      const target = String(request.target || 'aih-server').trim().toLowerCase();
      const executor = executors[target];
      if (typeof executor !== 'function') return { ok: false, text: '', usage: null, attempts: [], error: { code: 'translation_target_unsupported', message: '翻译执行目标不可用', retryable: true } };
      const isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : () => true;
      const emit = typeof options.emit === 'function' ? (event) => { if (isCurrent()) options.emit(event); } : () => {};
      try {
        const context = { ...options, signal, isCurrent, emit };
        const result = normalizeResult(await executeWithAbort(executor, request, context, signal));
        if (signal && signal.aborted) return abortedResult();
        if (target === 'direct-provider' && !result.ok && result.error && result.error.retryable && request.fallbackTarget === 'aih-server' && typeof executors['aih-server'] === 'function') {
          const fallback = normalizeResult(await executeWithAbort(executors['aih-server'], { ...request, target: 'aih-server' }, context, signal));
          return { ...fallback, attempts: [...result.attempts, ...fallback.attempts] };
        }
        return result;
      } catch (error) {
        if (signal && signal.aborted) return abortedResult();
        return normalizeResult({ ok: false, error: { code: error && error.code || 'translation_execution_failed', message: error && error.message || '翻译执行失败', retryable: error && error.retryable !== false } });
      }
    }
  };
}

module.exports = { createTranslationExecutionPort, normalizeResult };
