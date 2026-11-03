'use strict';

// SSH 连接适配器（Adapter）：把 ssh2 的 Client 包成一个最小接口
//   connect(target, connectConfig) → Promise<RawConnection>
// RawConnection 只暴露 exec / sftp / end / ping 与 close/error 事件。
// ping(cb)：一次 SSH 层往返（keepalive@openssh.com 全局请求），远端不起进程，用于纯 RTT 健康探测。
//
// 这是唯一 require('ssh2') 的地方；以后迁 Go（golang.org/x/crypto/ssh）只替换这一层。
// 认证材料由 target.auth 提供（见 target-resolver），这里只负责交给 ssh2，不落盘、不进日志。

const { Client } = require('ssh2');
const { remoteError, fromTransportError } = require('../errors');

function createSshConnector({ hostKeyStore, ClientImpl = Client } = {}) {
  return {
    connect(target, connectConfig) {
      return new Promise((resolve, reject) => {
        const client = new ClientImpl();
        // ssh2 在一次握手失败后可能再发一次 error（例如先 timeout 再 socket close）；
        // 常驻空监听防止迟到错误变成未捕获异常把 Server 进程打崩。
        client.on('error', () => {});
        const verify = hostKeyStore ? hostKeyStore.verifier(target.host, target.port) : null;
        let settled = false;
        const fail = (error) => {
          if (settled) return;
          settled = true;
          client.removeAllListeners('ready');
          try { client.end(); } catch (_error) { /* not connected */ }
          if (verify && verify.mismatch) reject(hostKeyStore.mismatchError(verify, target.host, target.port));
          else reject(fromTransportError(error));
        };
        client.once('ready', () => {
          if (settled) return;
          settled = true;
          client.removeListener('error', fail);
          // 一问一答的小包协议：关掉 Nagle，否则每次往返会多等一个 delayed-ACK（约 40ms）。
          if (typeof client.setNoDelay === 'function') client.setNoDelay(true);
          client.ping = pingOf(client);
          resolve(client);
        });
        client.once('error', fail);
        try {
          client.connect({
            host: target.host,
            port: target.port,
            username: target.username,
            ...target.auth,
            readyTimeout: connectConfig.readyTimeoutMs,
            keepaliveInterval: connectConfig.keepaliveIntervalMs,
            keepaliveCountMax: connectConfig.keepaliveCountMax,
            ...(verify ? { hostVerifier: verify } : {})
          });
        } catch (error) {
          fail(error);
        }
      });
    }
  };
}

/**
 * ssh2 没有公开「带回调的全局请求」，keepalive 用的是内部 _protocol.ping + _callbacks 队列
 * （回复按请求顺序到达，success/failure 都算一次往返）。内部结构不在时退回 exec，
 * 只影响探测精度，不影响正确性。
 */
function pingOf(client) {
  if (client._protocol && typeof client._protocol.ping === 'function' && Array.isArray(client._callbacks)) {
    return (callback) => {
      client._callbacks.push(() => callback(null));
      try { client._protocol.ping(); } catch (error) { callback(error); }
    };
  }
  return (callback) => client.exec('true', (error, stream) => {
    if (error) return callback(error);
    stream.resume();
    stream.stderr.resume();
    stream.once('close', () => callback(null));
  });
}

/** 没有可用认证材料时的明确错误（例如 agent 认证但 Server 进程没有 SSH_AUTH_SOCK）。 */
function missingAuthError(reason) {
  return remoteError('auth_failed', `没有可用的 SSH 认证材料：${reason}`);
}

module.exports = { createSshConnector, missingAuthError };
