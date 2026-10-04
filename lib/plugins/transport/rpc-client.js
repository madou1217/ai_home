'use strict';

// 插件宿主 RPC 的 Node 客户端（Node 公开宿主侧使用；Go 侧在 internal/adapters/pluginruntime 实现同一线合同）。
// call(method, value, { payload, signal, timeoutMs }) → { value, payload }。
// 取消/超时都会给宿主发 cancel，让插件 handler 的 signal 真的 abort，而不只是本地放弃等待。
//
// 反向调用（协议 v2）：宿主处理某个 call 时可以带 parent 回调客户端，交给 options.onCall(method, value, context)。
// 只接受 parent 仍在等待结果的反向调用；父调用一结束（结果、错误、取消、超时、断开），挂在它下面的
// 反向调用都会 abort。onCall 返回显式信封 { value, payload? }；没有 onCall 时一律回 method_unknown。

const net = require('node:net');
const crypto = require('node:crypto');
const { encodeFrame, FrameDecoder, validateMessage } = require('./frame');
const { limits, protocolVersion } = require('../sdk/contract.generated.json');
const { PluginError, requireCondition } = require('../sdk/errors');

function createRpcClient(options = {}) {
  const socketPath = String(options.socketPath || '').trim();
  const token = String(options.token || '');
  const connectTimeoutMs = Number(options.connectTimeoutMs || 3000);
  const maxInflight = Number(options.maxInflight || limits.inflightCalls);
  const requestedProtocol = Number(options.protocolVersion || protocolVersion);
  const socketFactory = options.socketFactory || net.createConnection;
  const onCall = typeof options.onCall === 'function' ? options.onCall : null;
  let socket = null;
  let connected = null;
  const pending = new Map();
  // 反向调用 id → { parent, controller }
  const inbound = new Map();

  function send(message, payload) {
    if (socket && !socket.destroyed) socket.write(encodeFrame(message, payload));
  }

  function abortChildren(parentId, reason) {
    for (const entry of inbound.values()) {
      if (entry.parent === parentId) entry.controller.abort(reason);
    }
  }

  function settlePending(id, entry) {
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.detach();
    abortChildren(id, new PluginError('plugin_rpc_cancelled', '父调用已结束'));
  }

  function replyError(id, error) {
    try { send({ kind: 'error', protocolVersion, id, error: { code: error?.code || 'plugin_rpc_error', message: String(error?.message || error?.code || 'plugin_rpc_error') } }); } catch (_error) {}
  }

  function handleInbound(message, payload) {
    if (!message.parent || !pending.has(message.parent)) {
      replyError(message.id, new PluginError('plugin_rpc_parent_unknown', '父调用不存在或已结束'));
      return;
    }
    if (!onCall) {
      replyError(message.id, new PluginError('plugin_rpc_method_unknown', `客户端不接受反向调用 ${message.method}`));
      return;
    }
    const controller = new AbortController();
    const remaining = Number(message.deadline) > 0 ? Math.max(1, Number(message.deadline) - Date.now()) : limits.invokeTimeoutMs;
    const timer = setTimeout(() => controller.abort(new PluginError('plugin_rpc_timeout')), remaining);
    inbound.set(message.id, { parent: message.parent, controller });
    Promise.resolve().then(() => onCall(message.method, message.value, {
      id: message.id, parent: message.parent, signal: controller.signal, deadline: Date.now() + remaining, payload
    })).then((result) => {
      // 被取消的反向调用不回发：宿主已经放弃等待，迟到的结果没有意义。
      if (controller.signal.aborted) return;
      const value = result ? result.value : undefined;
      const resultPayload = result && result.payload ? Buffer.from(result.payload) : Buffer.alloc(0);
      try { send({ kind: 'result', protocolVersion, id: message.id, value: value === undefined ? null : value }, resultPayload); }
      catch (error) { replyError(message.id, error); }
    }, (error) => {
      if (!controller.signal.aborted) replyError(message.id, error);
    }).finally(() => {
      clearTimeout(timer);
      inbound.delete(message.id);
    });
  }

  function rejectAll(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.detach();
      entry.reject(error);
    }
    pending.clear();
    for (const entry of inbound.values()) entry.controller.abort(new PluginError('plugin_rpc_closed'));
    inbound.clear();
  }

  function close(error = new PluginError('plugin_rpc_closed', '插件宿主连接已关闭')) {
    if (socket) socket.destroy();
    socket = null;
    connected = null;
    rejectAll(error);
  }

  function onMessage({ message, payload }) {
    validateMessage(message);
    // 宿主在传输层出错（超限/畸形帧）时用 id=transport 告知原因后断开。
    if (message.kind === 'error' && message.id === 'transport') {
      close(new PluginError(message.error?.code || 'plugin_rpc_error', message.error?.message));
      return;
    }
    if (message.kind === 'call') {
      handleInbound(message, payload);
      return;
    }
    if (message.kind === 'cancel') {
      inbound.get(message.id)?.controller.abort(new PluginError('plugin_rpc_cancelled'));
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    settlePending(message.id, entry);
    if (message.kind === 'error') {
      entry.reject(new PluginError(message.error?.code || 'plugin_rpc_error', message.error?.message));
      return;
    }
    entry.resolve({ value: message.value, payload });
  }

  function connect() {
    if (connected) return connected;
    connected = new Promise((resolve, reject) => {
      const handle = socketFactory(socketPath);
      socket = handle;
      let ready = false;
      const timer = setTimeout(() => {
        if (!ready) { handle.destroy(); reject(new PluginError('plugin_rpc_connect_timeout')); }
      }, connectTimeoutMs);
      const decoder = new FrameDecoder(({ message, payload }) => {
        if (ready) { onMessage({ message, payload }); return; }
        if (message.kind !== 'hello.result') return;
        clearTimeout(timer);
        if (message.error) {
          handle.destroy();
          const error = new PluginError(message.error.code, message.error.message);
          error.supported = message.supported || null;
          reject(error);
          return;
        }
        ready = true;
        resolve(handle);
      });
      handle.on('data', (chunk) => {
        try { decoder.push(chunk); } catch (error) { close(error); }
      });
      handle.once('error', (error) => {
        clearTimeout(timer);
        if (!ready) reject(new PluginError('plugin_rpc_connect_failed', error.message));
        else close(new PluginError('plugin_rpc_closed', error.message));
      });
      handle.once('close', () => {
        clearTimeout(timer);
        if (!ready) reject(new PluginError('plugin_rpc_closed', '握手前连接已关闭'));
        else close();
      });
      handle.once('connect', () => {
        try {
          handle.write(encodeFrame({ kind: 'hello', protocolVersion: requestedProtocol, id: crypto.randomUUID(), token }));
        } catch (error) { reject(error); }
      });
    }).catch((error) => {
      connected = null;
      socket = null;
      throw error;
    });
    return connected;
  }

  async function call(method, value, callOptions = {}) {
    requireCondition(typeof method === 'string' && method.length > 0, 'plugin_rpc_method_invalid');
    requireCondition(pending.size < maxInflight, 'plugin_rpc_inflight_limit');
    const payload = callOptions.payload ? Buffer.from(callOptions.payload) : Buffer.alloc(0);
    requireCondition(payload.length <= limits.payloadBytes, 'plugin_rpc_payload_limit');
    const handle = await connect();
    const id = crypto.randomUUID();
    const timeoutMs = Math.max(1, Number(callOptions.timeoutMs || limits.invokeTimeoutMs));
    const deadline = Date.now() + timeoutMs;
    const signal = callOptions.signal;
    return new Promise((resolve, reject) => {
      const sendCancel = () => {
        try { handle.write(encodeFrame({ kind: 'cancel', protocolVersion, id })); } catch (_error) {}
      };
      const entry = {
        resolve,
        reject,
        timer: null,
        detach: () => { if (signal) signal.removeEventListener('abort', abort); }
      };
      const abort = () => {
        if (!pending.has(id)) return;
        settlePending(id, entry);
        sendCancel();
        reject(new PluginError('plugin_rpc_cancelled', '插件调用已取消'));
      };
      entry.timer = setTimeout(() => {
        if (!pending.has(id)) return;
        settlePending(id, entry);
        sendCancel();
        reject(new PluginError('plugin_rpc_timeout', '插件调用超时'));
      }, timeoutMs);
      pending.set(id, entry);
      if (signal) {
        if (signal.aborted) { abort(); return; }
        signal.addEventListener('abort', abort, { once: true });
      }
      try {
        handle.write(encodeFrame({
          kind: 'call', protocolVersion, id, method, deadline,
          value: value === undefined ? null : value
        }, payload));
      } catch (error) {
        if (pending.has(id)) {
          settlePending(id, entry);
          reject(error);
        }
      }
    });
  }

  return { call, close, connect, pending: () => pending.size, inbound: () => inbound.size };
}

module.exports = { createRpcClient };
