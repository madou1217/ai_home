'use strict';

// Responses WebSocket 与插件网关阶段之间的接缝。不改桥接状态机（codex-responses-session.js），
// 只包装客户端 socket：
//   - 客户端发来的每个 response.create 先取一份代次租约（规划 §5.6：旧 WS 上每个新 response.create
//     拿当时的代次），再跑 gateway.request（改写或拒绝）；之后才交给桥接。暂存期间客户端的后续帧
//     按顺序排队，create 交出（或被拒绝）后立即放行，不等回答结束——回答中途的 response.cancel 不能被拖住。
//   - 被拒绝的 create 不进桥接、不出站：直接回一个带状态码的 error 事件（codex 把它当作该状态码的 HTTP 错误）。
//   - 桥接发给客户端的事件按 response id 归属到各自的 create：终止事件时投递一条 observe 摘要并释放租约；
//     客户端断开（含上游关闭导致的断开）时释放所有未结束的租约。
// 账号偏好（gateway.account）与尝试中间件（gateway.attempt）需要进入桥接的选号/恢复流程，不在这里；
// 它们活跃时 /v1/responses 升级按 426 回落 HTTPS（见 gateway-plugin-stage.js）。连接建立之后才启用的
// account / attempt 插件：下一个 create 不出站，回一个 500 error 事件并关闭连接——codex 把它当作可重试的
// 服务端错误、丢弃这条 socket 重连，重连拿到 426 后整会话回落 HTTPS，不会静默绕过插件。
//
// 插件可以在连接存续期间启用或停用，所以是否参与按帧判断：只要服务端有插件系统就包装 socket，
// 但当前没有任何网关类贡献时帧原样直通，不做 JSON 解析（create 帧可能有几 MB）。
// 没有插件系统时返回 null，调用方把原始 socket 原样交给桥接。

const { peekPluginSystem } = require('../plugins/control/plugin-system');
const { CAPABILITY: REQUEST_CAPABILITY, runRequestStage } = require('../plugins/gateway/request-stage');

const OBSERVE_CAPABILITY = 'observe';
const BRIDGE_CAPABILITIES = Object.freeze(['gateway.account', 'gateway.attempt']);
const GATEWAY_CAPABILITIES = Object.freeze([REQUEST_CAPABILITY, OBSERVE_CAPABILITY, ...BRIDGE_CAPABILITIES]);
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

function needsBridgeHooks(lease) {
  return BRIDGE_CAPABILITIES.some((capability) => (lease.snapshot.byCapability.get(capability) || []).length > 0);
}

/**
 * @returns {null | { wrapClient(client): object, noteAccount(account): void }}
 */
function createResponsesWebSocketPlugins({ state, provider = 'codex' } = {}) {
  const system = peekPluginSystem(state);
  if (!system) return null;
  const runtime = system.runtime;
  let accountRef = '';

  function wrapClient(client) {
    const messageListeners = [];
    const responses = [];
    let staging = false;
    let queued = [];
    let queuedBytes = 0;
    let closed = false;

    function deliver(data, binary) {
      for (const listener of messageListeners.slice()) listener(data, binary);
    }

    function finish(entry, outcome, error = '') {
      const index = responses.indexOf(entry);
      if (index === -1) return;
      responses.splice(index, 1);
      runtime.observe(entry.lease, {
        type: 'gateway.attempt',
        generation: entry.lease.generation,
        provider,
        model: entry.model,
        attempt: 0,
        accountRef,
        outcome,
        error: String(error || '').slice(0, 300),
        durationMs: Date.now() - entry.startedAt,
        committed: entry.committed
      });
      entry.lease.release();
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
      if (!PREAMBLE_TYPES.has(event.type) && !FAILURE_TYPES.has(event.type)) entry.committed = true;
      if (event.type === 'response.completed') finish(entry, 'return');
      else if (FAILURE_TYPES.has(event.type)) {
        const failure = event.error || (event.response && event.response.error) || {};
        finish(entry, 'error', failure.code || failure.type || failure.message || event.type);
      }
    }

    async function stage(payload) {
      const lease = runtime.acquire();
      if (!lease) return { payload, lease: null };
      if (needsBridgeHooks(lease)) {
        lease.release();
        return { fallback: errorEvent(500, 'plugin_websocket_unsupported', '网关插件需要 HTTPS 传输，请重连') };
      }
      const { type, ...body } = payload;
      if (!(lease.snapshot.byCapability.get(REQUEST_CAPABILITY) || []).length) return { payload, lease };
      try {
        const outcome = await runRequestStage(runtime, lease, { protocol: 'openai_responses', path: '/v1/responses', body });
        if (outcome.reject) {
          lease.release();
          return { reject: errorEvent(outcome.reject.status, 'plugin_rejected', outcome.reject.message) };
        }
        return { payload: outcome.changed ? { type, ...outcome.body } : payload, rewritten: Boolean(outcome.changed), lease };
      } catch (error) {
        lease.release();
        return { reject: errorEvent(502, error.code || 'plugin_failed', String(error.message || 'plugin failed')) };
      }
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
      const startedAt = Date.now();
      stage(payload).then((result) => {
        if (closed) {
          result.lease?.release();
          return;
        }
        if (result.fallback) {
          client.send(result.fallback, () => {
            if (client.readyState === client.OPEN) client.close(1000, 'plugin_websocket_unsupported');
          });
        } else if (result.reject) {
          client.send(result.reject);
        } else {
          if (result.lease) {
            responses.push({ lease: result.lease, id: '', model: String(result.payload.model || ''), startedAt, committed: false });
          }
          deliver(result.rewritten ? Buffer.from(JSON.stringify(result.payload)) : data, binary);
        }
      }, () => {
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
      for (const entry of responses.slice()) finish(entry, 'disconnected');
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
    // 当前上游连接的账号（连接建立或恢复换号时更新），用于观察事件。
    noteAccount(account) { accountRef = String(account && account.accountRef || ''); }
  };
}

module.exports = { createResponsesWebSocketPlugins };
