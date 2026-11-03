'use strict';

// 出网中继：让一台出不了外网（或访问某些站点很慢）的远端，借另一台远端的网络出去。两端都零安装。
//
//   入口机（如 desired.cn）                AIH Server                      出口机（如 AWS）
//   curl/git ──https_proxy──▶ 127.0.0.1:P ══SSH 反向转发══▶ 解析 CONNECT ══SSH direct-tcpip══▶ github.com:443
//
// - 入口：在入口机的 SSH 连接上 forwardIn('127.0.0.1', 0)，sshd 只在入口机本地回环上监听
//   （GatewayPorts=no 时本来也只能绑回环），端口随机；
// - 中继：AIH Server 收到转发进来的连接，读 HTTP 代理请求头（CONNECT host:port，或 http 的绝对 URI），
//   只放行 80 / 443 端口；
// - 出口：在出口机的 SSH 连接上 forwardOut 到目标（等价于 ssh -W），出口机不运行任何代理程序。
//
// 生命周期按「一次任务」收放（open → 任务 → close），不常驻；入口机上的端口任务结束即撤销。
// 注意：任务进行期间，入口机上的其他本地用户也能连到这个回环端口（与 ssh -R 相同的语义）。

const { remoteError } = require('../errors');

const ALLOWED_PORTS = new Set([80, 443]);
const MAX_HEADER_BYTES = 16 * 1024;

function parseProxyRequest(head) {
  const text = head.toString('latin1');
  const firstLine = text.slice(0, text.indexOf('\r\n'));
  const connect = /^CONNECT\s+([^\s:]+|\[[^\]]+\]):(\d+)\s+HTTP\/1\.[01]$/i.exec(firstLine);
  if (connect) return { kind: 'connect', host: connect[1].replace(/^\[|\]$/g, ''), port: Number(connect[2]) };
  const absolute = /^[A-Z]+\s+http:\/\/([^/\s:]+)(?::(\d+))?[^\s]*\s+HTTP\/1\.[01]$/i.exec(firstLine);
  if (absolute) return { kind: 'http', host: absolute[1], port: Number(absolute[2] || 80) };
  return null;
}

/** 从流里读出完整的代理请求头（到 \r\n\r\n），返回 {head, rest}。 */
function readHead(stream) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end >= 0) {
        cleanup();
        resolve({ head: buffer.subarray(0, end + 4), rest: buffer.subarray(end + 4) });
      } else if (buffer.length > MAX_HEADER_BYTES) {
        cleanup();
        reject(new Error('proxy_header_too_large'));
      }
    };
    const onEnd = () => { cleanup(); reject(new Error('proxy_header_incomplete')); };
    const cleanup = () => {
      stream.removeListener('data', onData);
      stream.removeListener('end', onEnd);
      stream.removeListener('close', onEnd);
    };
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('close', onEnd);
  });
}

class EgressRelay {
  /**
   * @param {{entry: object, exit: object}} raws 两台机器各自就绪的 ssh2 Client（建议用独立车道的连接）
   */
  constructor({ entry, exit }) {
    this.entry = entry;
    this.exit = exit;
    this.port = 0;
    this.streams = new Set();
    this.stats = { connections: 0, rejected: 0, bytesUp: 0, bytesDown: 0 };
    this.onTcpConnection = (info, accept, reject) => {
      if (!this.port || Number(info.destPort) !== this.port) return; // 别的转发
      const stream = accept();
      this.handle(stream).catch(() => { try { stream.end(); } catch (_error) { /* gone */ } });
    };
  }

  open() {
    return new Promise((resolve, reject) => {
      this.entry.on('tcp connection', this.onTcpConnection);
      this.entry.forwardIn('127.0.0.1', 0, (error, port) => {
        if (error) {
          this.entry.removeListener('tcp connection', this.onTcpConnection);
          return reject(remoteError('egress_forward_refused', '入口机拒绝建立反向转发（sshd 需允许 AllowTcpForwarding）', { cause: String(error.message || error) }));
        }
        this.port = Number(port);
        resolve(this.port);
      });
    });
  }

  async handle(inbound) {
    this.streams.add(inbound);
    inbound.once('close', () => this.streams.delete(inbound));
    const { head, rest } = await readHead(inbound);
    const request = parseProxyRequest(head);
    if (!request || !ALLOWED_PORTS.has(request.port)) {
      this.stats.rejected += 1;
      inbound.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const outbound = await new Promise((resolve, reject) => {
      this.exit.forwardOut('127.0.0.1', 0, request.host, request.port, (error, channel) => (error ? reject(error) : resolve(channel)));
    }).catch(() => null);
    if (!outbound) {
      inbound.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    this.stats.connections += 1;
    this.streams.add(outbound);
    outbound.once('close', () => this.streams.delete(outbound));
    if (request.kind === 'connect') inbound.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    else outbound.write(head);
    if (rest.length) outbound.write(rest);
    inbound.on('data', (chunk) => { this.stats.bytesUp += chunk.length; });
    outbound.on('data', (chunk) => { this.stats.bytesDown += chunk.length; });
    inbound.pipe(outbound);
    outbound.pipe(inbound);
    const closeBoth = () => {
      try { inbound.end(); } catch (_error) { /* gone */ }
      try { outbound.end(); } catch (_error) { /* gone */ }
    };
    inbound.once('close', closeBoth);
    outbound.once('close', closeBoth);
    inbound.on('error', closeBoth);
    outbound.on('error', closeBoth);
  }

  /** 给入口机上命令用的代理环境变量（只走回环端口；本地地址不走代理）。 */
  proxyEnv() {
    const url = `http://127.0.0.1:${this.port}`;
    return {
      https_proxy: url,
      HTTPS_PROXY: url,
      http_proxy: url,
      HTTP_PROXY: url,
      no_proxy: 'localhost,127.0.0.1,::1',
      NO_PROXY: 'localhost,127.0.0.1,::1'
    };
  }

  close() {
    for (const stream of this.streams) { try { stream.destroy ? stream.destroy() : stream.end(); } catch (_error) { /* gone */ } }
    this.streams.clear();
    this.entry.removeListener('tcp connection', this.onTcpConnection);
    if (this.port) {
      const port = this.port;
      this.port = 0;
      try { this.entry.unforwardIn('127.0.0.1', port, () => {}); } catch (_error) { /* 连接已断 */ }
    }
  }
}

module.exports = { ALLOWED_PORTS, EgressRelay, parseProxyRequest };
