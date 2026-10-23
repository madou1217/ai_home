'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

/**
 * 网关请求追踪上下文（request trace）。
 *
 * 解决什么问题：现有代理日志是**扁平**的 —— 一个客户端请求进来，内部可能对上游发起
 * 多次尝试（换账号重试、别名 fallback、跨 provider 兜底），每次都各写一行日志。
 * 事后排查时看到的是一堆并列的行，无法回答「这 5 次尝试属于同一个用户请求吗」，
 * 也无法回答「这个请求一共触发了几个下游请求」。
 *
 * 机制：用 AsyncLocalStorage 把「当前请求的追踪身份」挂在异步上下文上。
 * 入口（server.js 收到请求时）开一个 trace，内部所有日志出口通过
 * `currentTrace()` 自动拿到它，于是每一行都能带上：
 *   - `traceId`   本次客户端请求的追踪 id（与 access 日志的 requestId 同源）
 *   - `spanId`    本条日志自己的 id
 *   - `parentSpanId` 直接触发它的上游 span（例如「第 2 次账号重试」的父是「别名 fallback」）
 *   - `depth`     嵌套层数（0 = 客户端请求本身）
 *
 * 这样日志就能被读成一棵树，而不是一堆行。**不改变任何业务行为**：
 * 上下文缺失时所有函数都安全退化为「无追踪」，不会抛。
 */

const storage = new AsyncLocalStorage();

let spanCounter = 0;

function nextSpanId() {
  spanCounter = (spanCounter + 1) % Number.MAX_SAFE_INTEGER;
  return spanCounter.toString(36);
}

/** 当前异步上下文里的追踪状态；没有则返回 null。 */
function currentTrace() {
  return storage.getStore() || null;
}

  /** 当前请求的 traceId（供日志出口使用）；无追踪时返回空串。 */
function currentTraceId() {
  const trace = storage.getStore();
  return trace ? String(trace.traceId || '') : '';
}

/**
 * 在追踪上下文里执行一段逻辑。
 *
 * @param {object} options
 * @param {string} options.traceId     本次客户端请求的 id（与 access 日志一致）
 * @param {string} [options.route]     路由标识（如 '/v1/messages'），仅作诊断用
 * @param {string} [options.spanId]    本 span 的 id，缺省自动生成
 * @param {string} [options.parentSpanId]
 * @param {number} [options.depth]
 * @param {Function} fn                要执行的逻辑
 */
function runWithTrace(options = {}, fn) {
  const parent = storage.getStore() || null;
  const trace = {
    traceId: String(options.traceId || (parent && parent.traceId) || ''),
    spanId: String(options.spanId || nextSpanId()),
    parentSpanId: String(
      options.parentSpanId !== undefined
        ? options.parentSpanId
        : (parent ? parent.spanId : '')
    ),
    depth: Number.isFinite(options.depth)
      ? Number(options.depth)
      : (parent ? Number(parent.depth || 0) + 1 : 0),
    route: String(options.route || (parent && parent.route) || ''),
    // label 描述「这个 span 是什么」：attempt:2 / cross-provider:codex 之类。
    // 日志里带上它，才能一眼看出嵌套的每一层在做什么。
    label: String(options.label || ''),
    startedAt: Date.now()
  };
  if (typeof fn !== 'function') return trace;
  return storage.run(trace, fn);
}

/**
 * 开一个**子 span**：用于「请求里还有请求」的场景（上游尝试、跨 provider 兜底、
 * 内部子调用）。子 span 继承 traceId，parentSpanId 指向当前 span。
 */
function runWithChildSpan(options = {}, fn) {
  return runWithTrace(options, fn);
}

/**
 * 取当前追踪的日志字段。日志出口把这个对象并进条目即可。
 * 无追踪时返回空对象（保持既有日志形状不变）。
 */
function traceLogFields() {
  const trace = storage.getStore();
  if (!trace) return {};
  return {
    traceId: trace.traceId || undefined,
    spanId: trace.spanId || undefined,
    parentSpanId: trace.parentSpanId || undefined,
    spanDepth: trace.depth || 0,
    spanLabel: trace.label || undefined
  };
}

/**
 * 把一个异步函数的执行包成子 span，并统计耗时。
 * 返回 { result, span } 形式对调用方不友好，所以这里只在回调里暴露 span 信息。
 */
async function withChildSpan(options, fn) {
  const trace = currentTrace();
  const span = {
    spanId: nextSpanId(),
    parentSpanId: trace ? trace.spanId : '',
    traceId: trace ? trace.traceId : String(options && options.traceId || ''),
    depth: trace ? Number(trace.depth || 0) + 1 : 1,
    label: String(options && options.label || ''),
    startedAt: Date.now()
  };
  try {
    const result = await runWithTrace({ ...options, spanId: span.spanId, parentSpanId: span.parentSpanId, depth: span.depth }, fn);
    return result;
  } finally {
    span.durationMs = Date.now() - span.startedAt;
  }
}

module.exports = {
  currentTrace,
  currentTraceId,
  runWithChildSpan,
  runWithTrace,
  traceLogFields,
  withChildSpan,
  __private: { nextSpanId }
};
