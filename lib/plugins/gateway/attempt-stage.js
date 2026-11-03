'use strict';

// gateway.attempt：包在每一次上游尝试外面的洋葱中间件。
//
// 插件 handler 收到 { provider, model, attempt, accountRef, authType }（不含请求体、凭据），
// 上下文里多一个 next()：经反向调用让网关执行内层（下一个中间件，最内层是真实的上游尝试），
// 在提交点返回尝试摘要 { committed, outcome, status?, error?, stopped?, rejected? }。
// 提交点 = 响应头已写给客户端（流式是首字节，非流式就是整个响应结束）；之后的一切都不可撤回。
//
// 插件只能收窄宿主的行为，不能扩大：
//   - 不调用 next 时可以返回 { reject: { status, message } } 拒绝这次尝试（上游零命中）；
//   - 调用 next 之后、未提交的失败上可以返回 { recovery: 'stop' } 停止后续换号（按尝试耗尽结束）；
//   - next 至多一次（宿主与网关两端都校验），插件无法自行重试或重复计费；
//   - 已提交之后的返回值只用于观察，不改变结果；尝试本身抛出的错误原样抛给宿主。
// 预算：next 之前、next 返回之后各有一段插件预算（默认 1s）；等待上游（next 进行中）不计入。
// 失败语义按 failurePolicy：deny（默认）→ 还没执行尝试时拒绝本请求（502），已执行时只记录；
// delegate → 视为透明中间件，由网关替它调用 next。

const { PluginError } = require('../sdk/errors');

const CAPABILITY = 'gateway.attempt';
const NEXT_METHOD = 'gateway.next';
const DEFAULT_STEP_BUDGET_MS = 1000;
// 整个中间件调用（含等待上游）的硬上限；与网关请求持有代次的上限一致。
const DEFAULT_INVOKE_DEADLINE_MS = 10 * 60 * 1000;
const RECOVERY_ACTIONS = new Set(['retry_next', 'retry_same', 'retry_transient']);

function stepFailure(item, code, message) {
  const error = new PluginError(code, `插件 ${item.instanceId} 的 ${item.id}：${message}`);
  error.instanceId = item.instanceId;
  error.contributionId = item.id;
  return error;
}

function validReject(value) {
  const reject = value && value.reject;
  if (!reject || typeof reject !== 'object') return null;
  const status = Number(reject.status);
  if (!Number.isInteger(status) || status < 400 || status > 599) return null;
  return { status, message: String(reject.message || 'rejected by plugin').slice(0, 500) };
}

/**
 * @param {object} runtime 插件运行时（invoke 支持 onCall）
 * @param {object} lease 请求固定的代次租约
 * @param {object} request
 *   attempt: { provider, model, attempt, accountRef, authType }
 *   runAttempt: () => Promise<outcome>  真实的上游尝试，至多执行一次
 *   commit: { committed(): boolean, onCommit(fn): () => void }
 *   lastError: () => string
 *   signal?: AbortSignal  客户端断开时中止插件调用（不中止尝试本身）
 * @returns {Promise<{ started: boolean, outcome?: object, stop: boolean, rejected: object|null, failures: object[] }>}
 */
async function runAttemptStage(runtime, lease, request, options = {}) {
  const chain = lease.snapshot.byCapability.get(CAPABILITY) || [];
  const budgetMs = Math.max(1, Number(options.stepBudgetMs) || DEFAULT_STEP_BUDGET_MS);
  const deadlineMs = Math.max(budgetMs, Number(options.invokeDeadlineMs) || DEFAULT_INVOKE_DEADLINE_MS);
  const state = { attempt: null, inner: null, stop: false, rejected: null, failures: [] };

  function flags(summary) {
    return { ...summary, stopped: state.stop, ...(state.rejected ? { rejected: state.rejected } : {}) };
  }

  // 最内层：真实尝试只执行一次；摘要在提交点或尝试结束（先到者）时给出。
  function runInner() {
    if (state.inner) return state.inner;
    state.attempt = Promise.resolve().then(() => request.runAttempt());
    state.attempt.catch(() => {});
    state.inner = new Promise((resolve) => {
      const unsubscribe = request.commit.onCommit((status) => resolve({ committed: true, outcome: 'committed', status }));
      state.attempt.then(
        (outcome) => resolve({
          committed: request.commit.committed(),
          outcome: String(outcome && outcome.action || 'unknown'),
          error: String(request.lastError() || '').slice(0, 300)
        }),
        (error) => resolve({ committed: request.commit.committed(), outcome: 'error', error: String(error && (error.code || error.message) || '').slice(0, 300) })
      ).finally(unsubscribe);
    });
    return state.inner;
  }

  async function enter(index) {
    if (index >= chain.length) return runInner();
    const item = chain[index];
    const controller = new AbortController();
    const forward = () => controller.abort(new PluginError('plugin_rpc_cancelled', '客户端已断开'));
    if (request.signal) {
      if (request.signal.aborted) forward();
      else request.signal.addEventListener('abort', forward, { once: true });
    }
    let timer = null;
    let overBudget = false;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        overBudget = true;
        controller.abort(new PluginError('plugin_rpc_timeout', '超出插件预算'));
      }, budgetMs);
    };
    let inner = null;
    const callInner = () => {
      if (!inner) inner = enter(index + 1);
      return inner;
    };
    const onCall = async (method) => {
      if (method !== NEXT_METHOD) throw new PluginError('plugin_rpc_method_unknown', `不支持的反向调用 ${method}`);
      if (inner) throw new PluginError('plugin_next_called_twice', 'next() 在一次调用中只能调用一次');
      clearTimeout(timer);
      const summary = await callInner();
      arm();
      return { value: flags(summary) };
    };
    arm();
    let result;
    let failure = null;
    try {
      result = (await runtime.invoke(item.id, { ...request.attempt }, {
        generation: lease.generation, timeoutMs: deadlineMs, signal: controller.signal, onCall
      })).value;
    } catch (error) {
      // 本地取消在 RPC 层统一表现为 cancelled；超出预算要如实报超时。
      if (overBudget) failure = stepFailure(item, 'plugin_rpc_timeout', `超出插件预算 ${budgetMs}ms`);
      else failure = error.contributionId ? error : stepFailure(item, error.code || 'plugin_failed', error.message);
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', forward);
    }

    if (!failure && !inner) {
      const reject = validReject(result);
      if (reject) {
        state.rejected = reject;
        return flags({ committed: false, outcome: 'rejected' });
      }
      failure = stepFailure(item, 'plugin_result_invalid', '没有调用 next() 时必须返回 { reject: { status, message } }');
    }
    if (failure) {
      state.failures.push({ instanceId: item.instanceId, contributionId: item.id, code: failure.code, message: failure.message });
      if (!inner) {
        if (item.failurePolicy !== 'delegate') {
          state.rejected = { status: 502, code: failure.code || 'plugin_failed', message: failure.message };
          return flags({ committed: false, outcome: 'rejected' });
        }
        callInner();
      }
      return flags(await inner);
    }
    const summary = await inner;
    // 只收窄：停止换号只对未提交的尝试有效；其余返回值仅供观察。
    if (result && result.recovery === 'stop' && !summary.committed) state.stop = true;
    return flags(summary);
  }

  await enter(0);
  if (!state.attempt) return { started: false, stop: false, rejected: state.rejected, failures: state.failures };
  // 尝试的结果（包括抛出的错误）原样交还宿主。
  const outcome = await state.attempt;
  const stop = state.stop && !request.commit.committed() && RECOVERY_ACTIONS.has(String(outcome && outcome.action || ''));
  return { started: true, outcome, stop, rejected: null, failures: state.failures };
}

module.exports = { CAPABILITY, NEXT_METHOD, runAttemptStage };
