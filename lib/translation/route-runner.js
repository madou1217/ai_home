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

// 首字对冲：同一路由 HEDGE_AFTER_MS 内没有任何译文输出，就再并发发一个同样的请求，
// 谁先出字用谁、另一个立即中止。实测中转偶发单次 6–12s 才出首字（同时段直连上游只要
// 1.5–2.6s），用户要求超过 5s 出首字就算失败；对冲只发生在「还没有任何输出」之前，
// 不违反下面的不重放规则，代价只是长尾请求多一次上游调用。对冲请求带 hedgeIndex，
// 执行器据此换会话亲和键，让它落到另一个账号上（同账号重发只会在同一个上游队列里排队）。
// 分两档：1.5s 发第二个、3s 发第三个。flash 系上游自身首字约 1.5–2.6s，单档 2.5s 时
// 对冲请求自己也要 3s+ 才出字，救不回 5s 线（实测 20 次仍有 3 次 5.1–5.8s）。
const HEDGE_SCHEDULE_MS = Object.freeze([1500, 3000]);

function linkAbort(parent) {
  const controller = new AbortController();
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller;
}

async function executeHedged(run, { signal, forward, hedgeScheduleMs = HEDGE_SCHEDULE_MS } = {}) {
  return new Promise((resolve) => {
    const contenders = [];
    let winner = null;
    let settled = false;
    const hedgeTimers = [];
    const clearHedgeTimers = () => { while (hedgeTimers.length) clearTimeout(hedgeTimers.pop()); };

    function finish(result) {
      if (settled) return;
      settled = true;
      clearHedgeTimers();
      for (const item of contenders) if (item !== winner) item.controller.abort();
      resolve(result);
    }

    function claim(item) {
      if (winner) return winner === item;
      winner = item;
      clearHedgeTimers();
      for (const other of contenders) if (other !== item) other.controller.abort();
      for (const event of item.buffer) forward(event);
      item.buffer = [];
      return true;
    }

    function start() {
      const item = { controller: linkAbort(signal), buffer: [], done: false, result: null };
      contenders.push(item);
      const emit = (event) => {
        if (settled || (winner && winner !== item)) return;
        if (winner === item) { forward(event); return; }
        if (event && event.type === 'delta' && String(event.content || '')) {
          claim(item);
          forward(event);
          return;
        }
        item.buffer.push(event);
      };
      Promise.resolve()
        .then(() => run(item.controller.signal, emit, contenders.indexOf(item)))
        .catch((error) => ({ ok: false, error: { code: error && error.code || 'translation_route_failed', message: String(error && error.message || '翻译路由失败'), status: error && error.status, retryable: error && error.retryable } }))
        .then((result) => {
          item.done = true;
          item.result = result;
          if (settled) return;
          if (winner === item) { finish(result); return; }
          if (winner) return;
          // 没出过字就成功（非流式整段返回）也算赢。
          if (result && result.ok) { claim(item); finish(result); return; }
          // 失败：还有别的在跑就等它；都结束了立即返回（交给路由链换下一条，不等对冲档）。
          if (contenders.every((other) => other.done)) finish(result);
        });
    }

    start();
    for (const delayMs of hedgeScheduleMs) {
      const timer = setTimeout(() => {
        const index = hedgeTimers.indexOf(timer);
        if (index >= 0) hedgeTimers.splice(index, 1);
        if (settled || winner || (signal && signal.aborted)) return;
        start();
      }, delayMs);
      if (typeof timer.unref === 'function') timer.unref();
      hedgeTimers.push(timer);
    }
  });
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
        const runOnce = (attemptSignal, attemptEmit, hedgeIndex = 0) => {
          const context = { ...options, signal: attemptSignal, route, descriptor, emit: attemptEmit, hedgeIndex };
          return typeof options.executeRoute === 'function'
            ? options.executeRoute({ ...input, operation, route }, context, attemptEmit)
            : facade.execute({ ...input, provider: descriptor.id, operation, route }, context);
        };
        result = await executeWithAbort(() => (options.hedge === false
          ? runOnce(signal, forward)
          : executeHedged(runOnce, { signal, forward, hedgeScheduleMs: options.hedgeScheduleMs })), signal);
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
