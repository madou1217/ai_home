'use strict';

// 插件宿主侧的本机 RPC 服务：POSIX 私有 Unix socket（0700 目录 + 0600 文件）、Windows named pipe。
//
// 连接必须先握手：hello 带共享令牌与协议版本。版本不在支持范围时回一个带 plugin_rpc_incompatible
// 和支持范围的 hello.result 再断开；令牌不对直接断开（不泄露任何信息）；握手超时也断开。
// 每个 call 有自己的 AbortController：对端 cancel、deadline 到期、连接断开都会触发 abort；
// 已取消的调用不再回发结果。

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { encodeFrame, FrameDecoder, validateMessage } = require('./frame');
const { limits, protocolVersion, supportedProtocolVersions } = require('../sdk/contract.generated.json');
const { PluginError, requireCondition } = require('../sdk/errors');

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.alloc(0);
}

function isSilentAbort(reason) {
  return reason?.code === 'plugin_rpc_cancelled' || reason?.code === 'plugin_rpc_closed';
}

function createRpcServer(options = {}) {
  const socketPath = String(options.socketPath || '').trim();
  const token = String(options.token || '');
  const onCall = options.onCall;
  const maxInflight = Number(options.maxInflight || limits.inflightCalls);
  const handshakeTimeoutMs = Number(options.handshakeTimeoutMs || limits.handshakeTimeoutMs);
  const platform = options.platform || process.platform;
  const server = options.server || net.createServer();
  const connections = new Set();
  let listening = false;

  function send(connection, message, payload) {
    if (!connection.destroyed) connection.write(encodeFrame(message, payload));
  }

  function fail(connection, id, error) {
    const code = error?.code || 'plugin_rpc_error';
    const detail = process.env.AIH_PLUGIN_DEBUG === '1' && error?.stack
      ? `${String(error.message || code)}\n${error.stack}`
      : String(error?.message || code);
    send(connection, { kind: 'error', protocolVersion, id, error: { code, message: detail } });
  }

  function authenticate(candidate) {
    const left = Buffer.from(String(candidate || ''));
    const right = Buffer.from(token);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  }

  function handshake(connection, state, message) {
    if (message.kind !== 'hello' || !authenticate(message.token)) {
      connection.destroy();
      return;
    }
    const requested = Number(message.protocolVersion);
    if (requested < supportedProtocolVersions.min || requested > supportedProtocolVersions.max) {
      send(connection, {
        kind: 'hello.result',
        protocolVersion,
        id: message.id,
        supported: supportedProtocolVersions,
        error: { code: 'plugin_rpc_incompatible', message: `协议版本 ${requested} 不在支持范围 ${supportedProtocolVersions.min}-${supportedProtocolVersions.max}` }
      });
      connection.end();
      return;
    }
    clearTimeout(state.handshakeTimer);
    state.authenticated = true;
    send(connection, { kind: 'hello.result', protocolVersion, id: message.id, supported: supportedProtocolVersions, value: { protocolVersion } });
  }

  function dispatch(connection, state, message, payload) {
    validateMessage(message);
    if (message.kind === 'cancel') {
      state.inflight.get(message.id)?.abort(new PluginError('plugin_rpc_cancelled'));
      return;
    }
    if (message.kind !== 'call' || typeof message.method !== 'string') {
      fail(connection, message.id, new PluginError('plugin_rpc_invalid'));
      return;
    }
    if (state.inflight.size >= maxInflight) {
      fail(connection, message.id, new PluginError('plugin_rpc_inflight_limit'));
      return;
    }
    const controller = new AbortController();
    state.inflight.set(message.id, controller);
    const deadline = Number(message.deadline || 0);
    const remaining = deadline > 0 ? Math.max(1, deadline - Date.now()) : limits.invokeTimeoutMs;
    const timer = setTimeout(() => controller.abort(new PluginError('plugin_rpc_timeout')), remaining);
    Promise.resolve().then(() => onCall(message.method, message.value, {
      id: message.id, signal: controller.signal, deadline: deadline || Date.now() + remaining, payload
    })).then((result) => {
      // 已取消（对端 cancel / 连接断开）的调用不回发；超时则如实回超时，不回迟到的结果。
      if (controller.signal.aborted) {
        if (!isSilentAbort(controller.signal.reason)) fail(connection, message.id, controller.signal.reason);
        return;
      }
      // onCall 必须返回显式信封 { value, payload? }，这里不猜测返回值的形状。
      const value = result ? result.value : undefined;
      const resultPayload = toBuffer(result ? result.payload : null);
      send(connection, { kind: 'result', protocolVersion, id: message.id, value: value === undefined ? null : value }, resultPayload);
    }).catch((error) => {
      if (controller.signal.aborted && isSilentAbort(controller.signal.reason)) return;
      fail(connection, message.id, controller.signal.aborted ? controller.signal.reason : error);
    }).finally(() => {
      clearTimeout(timer);
      state.inflight.delete(message.id);
    });
  }

  server.on('connection', (connection) => {
    const state = { authenticated: false, inflight: new Map(), handshakeTimer: null };
    connections.add(connection);
    state.handshakeTimer = setTimeout(() => { if (!state.authenticated) connection.destroy(); }, handshakeTimeoutMs);
    const decoder = new FrameDecoder(({ message, payload }) => {
      if (!state.authenticated) handshake(connection, state, message);
      else dispatch(connection, state, message, payload);
    });
    connection.on('data', (chunk) => {
      try { decoder.push(chunk); } catch (error) {
        // 超限/畸形帧：先尽力告知原因再断开，对端不至于只看到 EOF。
        try { fail(connection, 'transport', error); } catch (_error) {}
        connection.destroy();
      }
    });
    connection.on('error', () => {});
    connection.once('close', () => {
      clearTimeout(state.handshakeTimer);
      for (const controller of state.inflight.values()) controller.abort(new PluginError('plugin_rpc_closed'));
      state.inflight.clear();
      connections.delete(connection);
    });
  });

  async function listen() {
    requireCondition(socketPath, 'plugin_rpc_socket_missing');
    if (platform !== 'win32') {
      fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
      try { fs.unlinkSync(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => { server.removeListener('error', reject); resolve(); });
    });
    if (platform !== 'win32') {
      try { fs.chmodSync(socketPath, 0o600); } catch (_error) {}
    }
    listening = true;
    return { socketPath };
  }

  async function close() {
    for (const connection of connections) connection.destroy();
    if (!listening) return;
    listening = false;
    await new Promise((resolve) => server.close(() => resolve()));
    if (platform !== 'win32') {
      try { fs.unlinkSync(socketPath); } catch (_error) {}
    }
  }

  return { listen, close, server, connections };
}

module.exports = { createRpcServer };
