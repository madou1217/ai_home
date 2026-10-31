'use strict';

// 统一截止时间：所有远端操作都必须在有限时间内拿到结果或错误，绝不悬空。
//
// ssh2 的回调可能重复触发或永不触发（通道 close 与 error 交错、socket 半开），
// 所以这里同时做三件事：超时、外部取消（AbortSignal）、只结算一次。
// 超时 / 取消时调用 onCancel 释放底层资源（关通道），配额由调用方的 finally 归还。

const { remoteError } = require('../errors');

/**
 * @template T
 * @param {(settle: {resolve: (v: T) => void, reject: (e: Error) => void}) => (void | (() => void))} executor
 *   返回值（可选）是取消函数：超时或外部取消时调用，用于关闭通道。
 * @param {{timeoutMs: number, signal?: AbortSignal, label?: string, timers?: {setTimeout, clearTimeout}}} options
 * @returns {Promise<T>}
 */
function withDeadline(executor, options) {
  const { timeoutMs, signal, label = 'operation' } = options;
  const timers = options.timers || { setTimeout, clearTimeout };
  return new Promise((resolve, reject) => {
    let settled = false;
    let cancel = null;
    let timer = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) timers.clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    const runCancel = () => {
      if (typeof cancel !== 'function') return;
      try { cancel(); } catch (_error) { /* 释放失败不能掩盖超时本身 */ }
    };
    const onAbort = () => {
      runCancel();
      finish(reject, remoteError('aborted', `${label} 已取消`));
    };
    if (signal && signal.aborted) {
      reject(remoteError('aborted', `${label} 已取消`));
      return;
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    timer = timers.setTimeout(() => {
      runCancel();
      finish(reject, remoteError('operation_timeout', `${label} 超时（${timeoutMs}ms）`, { timeoutMs }));
    }, timeoutMs);
    try {
      cancel = executor({
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error)
      }) || null;
    } catch (error) {
      finish(reject, error);
    }
  });
}

module.exports = { withDeadline };
