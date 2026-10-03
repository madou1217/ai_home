'use strict';

// 插件宿主 RPC 的 Node 客户端（Node 公开宿主侧使用；Go 侧在 internal/adapters/pluginruntime 实现同一线合同）。
// call(method, value, { payload, signal, timeoutMs }) → { value, payload }。
// 取消/超时都会给宿主发 cancel，让插件 handler 的 signal 真的 abort，而不只是本地放弃等待。

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
  let socket = null;
  let connected = null;
  const pending = new Map();

  function rejectAll(error) {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.detach();
      entry.reject(error);
    }
    pending.clear();
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
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    entry.detach();
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
        if (!pending.delete(id)) return;
        clearTimeout(entry.timer);
        entry.detach();
        sendCancel();
        reject(new PluginError('plugin_rpc_cancelled', '插件调用已取消'));
      };
      entry.timer = setTimeout(() => {
        if (!pending.delete(id)) return;
        entry.detach();
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
        if (pending.delete(id)) {
          clearTimeout(entry.timer);
          entry.detach();
          reject(error);
        }
      }
    });
  }

  return { call, close, connect, pending: () => pending.size };
}

module.exports = { createRpcClient };
