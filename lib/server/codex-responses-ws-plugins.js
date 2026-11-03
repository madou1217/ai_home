'use strict';

// Responses WebSocket 与插件网关阶段之间的接缝。每条连接一份（handleCodexResponsesWebSocket 里创建）。
//
// 主体不改桥接状态机（codex-responses-session.js），只包装客户端 socket：
//   - 客户端发来的每个 response.create 先取一份代次租约（规划 §5.6：旧 WS 上每个新 response.create
//     拿当时的代次），跑 gateway.request（改写或拒绝），连接的首个 create 再跑 gateway.account；
//     有 gateway.attempt 时由中间件的 next() 把 create 交给桥接。暂存期间客户端的后续帧按顺序排队，
//     create 交出（或被拒绝）后立即放行，不等回答结束——回答中途的 response.cancel 不能被拖住。
//   - 被拒绝的 create 不进桥接、不出站：直接回一个带状态码的 error 事件（codex 把它当作该状态码的 HTTP 错误）。
//   - 桥接发给客户端的事件按 response id 归属到各自的 create：首个非前导、非失败的事件是提交点；
//     终止事件时投递一条 observe 摘要，租约在该 create 的中间件结束后释放。
//   - 客户端断开（含上游关闭导致的断开）时结束所有未完成的尝试与挂起的钩子，租约随之释放。
//
// 桥接内的换号恢复经两个可选钩子接入（没有插件时不传，桥接路径没有额外 await）：
//   - beforeRecover(job)：上一次尝试以未提交失败结束——把它的 next() 以 retry_next 交回中间件，
//     等它决定是否停止换号；再用当前 create 的代次刷新账号偏好。连接失败后的重复调用是幂等的。
//   - beforeReplay(job, account)：连上新账号、重放之前运行新一次尝试的中间件；拒绝则不重放。
//
// 账号偏好（gateway.account）只排序，候选与可调度规则不变；规则：连接的首个 create 求一次偏好，
// 之后每次恢复前刷新。注意首个 create 时桥接优先沿用升级时的账号（会话亲和），偏好主要作用于恢复换号；
// 之后的 create 留在连接的账号上（它持有续写）。
//
// 插件可以在连接存续期间启用或停用，所以是否参与按帧判断：当前没有任何网关类贡献时帧原样直通，
// 不做 JSON 解析（create 帧可能有几 MB）。没有插件系统时返回 null，调用方把原始 socket 原样交给桥接。

const { peekPluginSystem } = require('../plugins/control/plugin-system');
const { CAPABILITY: REQUEST_CAPABILITY, runRequestStage } = require('../plugins/gateway/request-stage');
const { CAPABILITY: ACCOUNT_CAPABILITY, runAccountStage } = require('../plugins/gateway/account-stage');
const { CAPABILITY: ATTEMPT_CAPABILITY, runAttemptStage } = require('../plugins/gateway/attempt-stage');

const OBSERVE_CAPABILITY = 'observe';
const GATEWAY_CAPABILITIES = Object.freeze([REQUEST_CAPABILITY, OBSERVE_CAPABILITY, ACCOUNT_CAPABILITY, ATTEMPT_CAPABILITY]);
const PREAMBLE_TYPES = new Set(['response.created', 'response.in_progress', 'response.queued']);
const FAILURE_TYPES = new Set(['error', 'response.failed', 'response.incomplete']);
const MAX_QUEUED_FRAMES = 16;
const MAX_QUEUED_BYTES = 32 * 1024 * 1024;

function parseJson(data, binary) {
  if (binary) return null;
  try { return JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)); } catch (_error) { return null; }
}

function errorEvent(status, code, message) {
  const type = status >= 500 ? 'server_error' : 'invalid_request_error';
  return JSON.stringify({ type: 'error', status, error: { type, code, message } });
}

function hasGatewayStages(runtime) {
  return GATEWAY_CAPABILITIES.some((capability) => runtime.hasContributions(capability));
}

function contributes(lease, capability) {
  return (lease.snapshot.byCapability.get(capability) || []).length > 0;
}

function authTypeOf(account) {
  return account && (account.apiKeyMode || account.authType === 'api-key') ? 'api-key' : String(account && account.authType || 'oauth');
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

/**
 * @returns {null | {
 *   wrapClient(client): object,
 *   wrapChooser(choose): Function,
 *   bridgeHooks(): { beforeRecover: Function, beforeReplay: Function },
 *   noteAccount(account): void
 * }}
 */
function createResponsesWebSocketPlugins({ state, provider = 'codex' } = {}) {
  const system = peekPluginSystem(state);
  if (!system) return null;
  const runtime = system.runtime;
  const responses = [];
  let currentAccount = null;
  let preferredAccountRefs = [];
  let accountStageDone = false;
  let closed = false;

  function livePool() {
    const pool = state && state.accounts && Array.isArray(state.accounts[provider]) ? state.accounts[provider] : [];
    return pool.filter((account) => account && account.accessToken);
  }

  // 用当前 create 的代次求账号偏好；插件失败按 failurePolicy：deny 抛出，delegate 已在阶段内跳过。
  async function refreshPreference(entry) {
    if (!contributes(entry.lease, ACCOUNT_CAPABILITY)) {
      preferredAccountRefs = [];
      return;
    }
    preferredAccountRefs = await runAccountStage(runtime, entry.lease, { provider, model: entry.model, candidates: livePool() });
  }

  function commitTracker(entry) {
    return {
      committed: () => entry.committed,
      onCommit(listener) {
        entry.commitListeners.add(listener);
        return () => entry.commitListeners.delete(listener);
      }
    };
  }

  // 启动一次尝试的中间件；send() 是真正的执行（交给桥接或放行重放）。
  // 返回的 started 在 next() 被调用时以 true 兑现，中间件没调用 next 就结束时以 { rejected } 兑现。
  function startAttempt(entry, account, send) {
    const started = deferred();
    const end = deferred();
    entry.attempt = { end, settled: false };
    entry.stage = runAttemptStage(runtime, entry.lease, {
      attempt: {
        provider, model: entry.model, attempt: entry.attemptIndex,
        accountRef: String(account && account.accountRef || ''), authType: authTypeOf(account)
      },
      runAttempt: () => {
        send();
        started.resolve(true);
        return end.promise;
      },
      commit: commitTracker(entry),
      lastError: () => entry.lastError,
      signal: entry.abort.signal
    }).then((result) => {
      if (!result.started) started.resolve({ rejected: result.rejected });
      return result;
    }, (error) => {
      started.resolve({ rejected: { status: 502, code: error.code || 'plugin_failed', message: String(error.message || 'plugin failed') } });
      return { started: false, stop: false };
    });
    return started.promise;
  }

  function endAttempt(entry, action) {
    if (!entry.attempt || entry.attempt.settled) return;
    entry.attempt.settled = true;
    entry.attempt.end.resolve({ action });
  }

  function releaseWhenSettled(entry) {
    Promise.resolve(entry.stage).finally(() => entry.lease.release());
  }

  function finish(entry, outcome, error = '') {
    const index = responses.indexOf(entry);
    if (index === -1) return;
    responses.splice(index, 1);
    endAttempt(entry, outcome === 'return' || outcome === 'error' ? 'return' : outcome);
    runtime.observe(entry.lease, {
      type: 'gateway.attempt',
      generation: entry.lease.generation,
      provider,
      model: entry.model,
      attempt: entry.attemptIndex,
      accountRef: String(currentAccount && currentAccount.accountRef || ''),
      outcome,
      error: String(error || '').slice(0, 300),
      durationMs: Date.now() - entry.startedAt,
      committed: entry.committed
    });
    releaseWhenSettled(entry);
  }

  function markCommitted(entry) {
    if (entry.committed) return;
    entry.committed = true;
    for (const listener of [...entry.commitListeners]) listener(200);
  }

  // 桥接一次只会为一个 create 恢复（流水线之后桥接不再恢复）；找不到唯一的活动尝试时不插手。
  function recoveringEntry() {
    const active = responses.filter((entry) => entry.attempt && !entry.attempt.settled);
    if (active.length === 1) return active[0];
    const waiting = responses.filter((entry) => entry.awaitingReplay);
    return waiting.length === 1 ? waiting[0] : null;
  }

  async function beforeRecover(job) {
    const entry = recoveringEntry();
    if (!entry || closed) return 'continue';
    if (entry.attempt && !entry.attempt.settled) {
      entry.lastError = String(job && job.failureCode || 'upstream_failed');
      endAttempt(entry, 'retry_next');
      const result = await entry.stage;
      if (closed) return 'stop';
      if (result && result.stop) return 'stop';
      entry.attemptIndex += 1;
      entry.awaitingReplay = true;
    }
    try {
      await refreshPreference(entry);
    } catch (_error) {
      return 'stop';
    }
    return closed ? 'stop' : 'continue';
  }

  async function beforeReplay(_job, account) {
    const entry = recoveringEntry();
    if (!entry || closed || !contributes(entry.lease, ATTEMPT_CAPABILITY)) return null;
    entry.awaitingReplay = false;
    const started = await startAttempt(entry, account, () => {});
    if (started === true) return null;
    const rejected = started.rejected || { status: 502, code: 'plugin_failed', message: 'plugin failed' };
    releaseWhenSettled(entry);
    return { reject: errorEvent(rejected.status, rejected.code || 'plugin_rejected', rejected.message) };
  }

  function wrapChooser(choose) {
    return (pool, cursors, key, selection = {}) => (preferredAccountRefs.length
      ? choose(pool, cursors, key, { ...selection, preferredAccountRefs })
      : choose(pool, cursors, key, selection));
  }

  function wrapClient(client) {
    const messageListeners = [];
    let staging = false;
    let queued = [];
    let queuedBytes = 0;

    function deliver(data, binary) {
      for (const listener of messageListeners.slice()) listener(data, binary);
    }

    // 桥接 → 客户端：按 response id 归属。response.created 绑定到最早一个还没绑定 id 的 create；
    // 不带 response 对象的事件（增量、error）归到最早一个未结束的 create。
    function inspectOutbound(data, options) {
      if (!responses.length) return;
      const event = parseJson(data, options && options.binary);
      if (!event || typeof event.type !== 'string') return;
      const id = event.response && typeof event.response.id === 'string' ? event.response.id : '';
      let entry = null;
      if (event.type === 'response.created' && id) {
        entry = responses.find((item) => !item.id) || null;
        if (entry) entry.id = id;
      } else if (id) {
        entry = responses.find((item) => item.id === id) || null;
      }
      entry ||= responses[0];
      if (!PREAMBLE_TYPES.has(event.type) && !FAILURE_TYPES.has(event.type)) markCommitted(entry);
      if (event.type === 'response.completed') finish(entry, 'return');
      else if (FAILURE_TYPES.has(event.type)) {
        const failure = event.error || (event.response && event.response.error) || {};
        finish(entry, 'error', failure.code || failure.type || failure.message || event.type);
      }
    }

    // request 阶段与首个 create 的账号阶段；返回 { reject } 或 { payload, rewritten, lease }。
    async function stageRequest(payload) {
      const lease = runtime.acquire();
      if (!lease) return { payload, lease: null };
      const { type, ...body } = payload;
      let next = payload;
      let rewritten = false;
      try {
        if (contributes(lease, REQUEST_CAPABILITY)) {
          const outcome = await runRequestStage(runtime, lease, { protocol: 'openai_responses', path: '/v1/responses', body });
          if (outcome.reject) {
            lease.release();
            return { reject: errorEvent(outcome.reject.status, 'plugin_rejected', outcome.reject.message) };
          }
          if (outcome.changed) {
            next = { type, ...outcome.body };
            rewritten = true;
          }
        }
        if (!accountStageDone) {
          accountStageDone = true;
          await refreshPreference({ lease, model: String(next.model || '') });
        }
      } catch (error) {
        lease.release();
        return { reject: errorEvent(502, error.code || 'plugin_failed', String(error.message || 'plugin failed')) };
      }
      return { payload: next, rewritten, lease };
    }

    async function admit(data, binary, payload, startedAt) {
      const result = await stageRequest(payload);
      if (closed) {
        result.lease?.release();
        return;
      }
      if (result.reject) {
        client.send(result.reject);
        return;
      }
      const frame = result.rewritten ? Buffer.from(JSON.stringify(result.payload)) : data;
      if (!result.lease) {
        deliver(frame, binary);
        return;
      }
      const entry = {
        lease: result.lease, id: '', model: String(result.payload.model || ''), startedAt,
        committed: false, commitListeners: new Set(), attempt: null, stage: null,
        attemptIndex: 0, awaitingReplay: false, lastError: '', abort: new AbortController()
      };
      responses.push(entry);
      if (!contributes(entry.lease, ATTEMPT_CAPABILITY)) {
        deliver(frame, binary);
        return;
      }
      // next() 把 create 交给桥接；中间件不调用 next 而是拒绝时，create 不出站。
      const started = await startAttempt(entry, currentAccount, () => deliver(frame, binary));
      if (started === true || closed) return;
      const index = responses.indexOf(entry);
      if (index !== -1) responses.splice(index, 1);
      releaseWhenSettled(entry);
      const rejected = started.rejected || { status: 502, code: 'plugin_failed', message: 'plugin failed' };
      client.send(errorEvent(rejected.status, rejected.code || 'plugin_rejected', rejected.message));
    }

    function intake(data, binary) {
      if (closed) return;
      if (staging) {
        queuedBytes += data.length;
        if (queued.length >= MAX_QUEUED_FRAMES || queuedBytes > MAX_QUEUED_BYTES) {
          if (client.readyState === client.OPEN) client.close(1011, 'plugin_queue_limit');
          return;
        }
        queued.push({ data: Buffer.from(data), binary });
        return;
      }
      if (!hasGatewayStages(runtime)) {
        deliver(data, binary);
        return;
      }
      const payload = parseJson(data, binary);
      if (!payload || payload.type !== 'response.create') {
        deliver(data, binary);
        return;
      }
      staging = true;
      admit(data, binary, payload, Date.now()).catch(() => {
        if (!closed) client.send(errorEvent(502, 'plugin_failed', 'plugin stage failed'));
      }).finally(() => {
        staging = false;
        const backlog = queued;
        queued = [];
        queuedBytes = 0;
        for (const frame of backlog) intake(frame.data, frame.binary);
      });
    }

    client.on('message', intake);
    client.once('close', () => {
      closed = true;
      queued = [];
      for (const entry of responses.slice()) {
        entry.abort.abort();
        finish(entry, 'disconnected');
      }
    });

    // 其余属性和方法一律转发给真实 socket（函数绑定到真实 socket），桥接依赖的 send 回调、
    // pause/resume 背压、readyState、close 与事件订阅都保持原样；只接管 message 订阅与 send 的检查。
    const proxy = new Proxy(client, {
      get(target, property) {
        if (property === 'on' || property === 'addListener' || property === 'once') {
          return (event, listener) => {
            if (event !== 'message') {
              target[property](event, listener);
              return proxy;
            }
            if (property === 'once') {
              const wrapped = (...args) => {
                messageListeners.splice(messageListeners.indexOf(wrapped), 1);
                listener(...args);
              };
              messageListeners.push(wrapped);
            } else messageListeners.push(listener);
            return proxy;
          };
        }
        if (property === 'send') {
          return (data, options, callback) => {
            try { inspectOutbound(data, options); } catch (_error) { /* 观察不能影响转发 */ }
            return target.send(data, options, callback);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    return proxy;
  }

  return {
    wrapClient,
    wrapChooser,
    bridgeHooks: () => ({ beforeRecover, beforeReplay }),
    // 当前上游连接的账号（连接建立或恢复换号时更新），用于尝试输入与观察事件。
    noteAccount(account) { currentAccount = account || null; }
  };
}

module.exports = { createResponsesWebSocketPlugins };
