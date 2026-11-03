'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns');
const net = require('node:net');

/**
 * 把 AIH 自己的监听端口同时用作中转入口 —— 于是**不需要多开任何端口**。
 *
 * 做法是首字节分流（sslh 那一类）：HTTP/WebSocket/TLS 的第一字节是 ASCII 或 0x16，SOCKS5 恒为 0x05，
 * 所以看一眼首字节就能决定这条路给谁：
 *   - `0x05` → 我们自己接管，做 SOCKS5 认证（用户名 = 节点，见 relay-users），把连接转给回环上的内核边车；
 *   - 其余   → 原样交回 `http.Server`（`emit('connection', socket)`，Node 的标准做法）。
 *
 * 为什么认证要在这一层做：一个端口上无法再用端口号区分节点，用户名是唯一的选择器；同时这一层
 * 先验密码，认证不过的连接根本碰不到边车。边车则只绑回环、不需要再暴露任何端口。
 *
 * 为什么交回 HTTP 是安全的：只截获首字节为 0x05 的连接，HTTP 请求行（`GET `/`POST`…）、WebSocket
 * 升级、TLS ClientHello（0x16）都不会被误判。
 *
 * 边界：这条通路是 TCP 的。SOCKS5 的 UDP ASSOCIATE 需要客户端再连一个 UDP 端口，而那个端口不可能
 * 复用同一个 TCP 端口，所以本模式下渲染器不写 `udp-relay`（UDP 由客户端按自己的策略回落），
 * 需要 UDP 中转时用 `aih server config set --relay-port-mode dedicated`（每个节点一个端口）。
 */

const SOCKS5_VERSION = 0x05;
const CMD_CONNECT = 0x01;
const CMD_BIND = 0x02;
const CMD_ASSOCIATE = 0x03;
const REP_SUCCEEDED = 0x00;
const REP_GENERAL_FAILURE = 0x01;
const REP_COMMAND_NOT_SUPPORTED = 0x07;
const METHOD_NO_AUTH = 0x00;
const METHOD_USER_PASS = 0x02;
const METHOD_NONE = 0xff;
const AUTH_VERSION = 0x01;
const AUTH_OK = 0x00;
const AUTH_FAILED = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5000;

/** 常量时间比较：别让密码比较泄漏长度/前缀信息。 */
function sameSecret(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

/** 逐字节读取器：SOCKS5 握手是定长/带长度的二进制，需要精确读 n 个字节。 */
class SocketReader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.pending = null;
    this.closed = false;
    this.onData = (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    };
    this.onEnd = () => this.fail();
    socket.on('data', this.onData);
    socket.once('end', this.onEnd);
    socket.once('close', this.onEnd);
    socket.once('error', this.onEnd);
  }

  read(count) {
    return new Promise((resolve) => {
      this.pending = { count, resolve };
      this.drain();
    });
  }

  drain() {
    if (!this.pending || this.buffer.length < this.pending.count) return;
    const { count, resolve } = this.pending;
    const value = this.buffer.subarray(0, count);
    this.buffer = this.buffer.subarray(count);
    this.pending = null;
    resolve(value);
  }

  fail() {
    if (this.closed) return;
    this.closed = true;
    if (this.pending) {
      const { resolve } = this.pending;
      this.pending = null;
      resolve(null);
    }
  }

  /** 握手完成：把读取器摘掉，交还原始 socket（缓冲里剩下的字节由调用方转发）。 */
  detach() {
    this.socket.removeListener('data', this.onData);
    this.socket.removeListener('end', this.onEnd);
    this.socket.removeListener('close', this.onEnd);
    this.socket.removeListener('error', this.onEnd);
    const leftover = this.buffer;
    this.buffer = Buffer.alloc(0);
    return leftover;
  }
}

/** 读一条 SOCKS5 请求：VER CMD RSV ATYP DST.ADDR DST.PORT（返回原始字节，便于原样转发）。 */
async function readRequest(reader) {
  const head = await reader.read(4);
  if (!head || head[0] !== SOCKS5_VERSION) return null;
  const atyp = head[3];
  let address = Buffer.alloc(0);
  if (atyp === ATYP_IPV4) address = await reader.read(4);
  else if (atyp === ATYP_IPV6) address = await reader.read(16);
  else if (atyp === ATYP_DOMAIN) {
    const length = await reader.read(1);
    if (!length) return null;
    address = await reader.read(length[0]);
    address = length && address ? Buffer.concat([length, address]) : null;
  } else {
    return null;
  }
  if (!address) return null;
  const port = await reader.read(2);
  if (!port) return null;
  return { cmd: head[1], atyp, raw: Buffer.concat([head, address, port]) };
}

/** 读一条 SOCKS5 回复，返回 { host, port }（3 字节头 + 地址 + 2 字节端口）。 */
async function readReply(reader) {
  const head = await reader.read(4);
  if (!head || head[0] !== SOCKS5_VERSION) return null;
  const atyp = head[3];
  let address = '';
  if (atyp === ATYP_IPV4) {
    const bytes = await reader.read(4);
    if (!bytes) return null;
    address = [...bytes].join('.');
  } else if (atyp === ATYP_IPV6) {
    const bytes = await reader.read(16);
    if (!bytes) return null;
    address = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(':');
  } else if (atyp === ATYP_DOMAIN) {
    const length = await reader.read(1);
    const bytes = length ? await reader.read(length[0]) : null;
    if (!bytes) return null;
    address = bytes.toString('utf8');
  } else {
    return null;
  }
  const port = await reader.read(2);
  if (!port) return null;
  return { host: address, port: port.readUInt16BE(0) };
}

function ipv4Bytes(host) {
  const parts = String(host).split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return Buffer.from(parts);
}

/**
 * 回复给客户端的 BND 地址：UDP 数据报要发到这里。
 * 优先用客户端连过来的本机地址（局域网/直连场景就是它），域名则解析成 IP（NAT/域名入口场景）。
 */
async function resolveBindAddress(host) {
  if (!host) return null;
  if (net.isIPv4(host)) return { atyp: ATYP_IPV4, bytes: ipv4Bytes(host) };
  if (net.isIPv6(host)) return null;
  try {
    const { address } = await dns.promises.lookup(host, { family: 4 });
    const bytes = ipv4Bytes(address);
    return bytes ? { atyp: ATYP_IPV4, bytes } : null;
  } catch (_error) {
    return null;
  }
}

function buildReply(reply, atyp, addressBytes, port) {
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port, 0);
  return Buffer.concat([Buffer.from([SOCKS5_VERSION, reply, 0x00, atyp]), addressBytes, portBytes]);
}

/**
 * @param {object} options
 * @param {import('node:http').Server} options.httpServer 非 SOCKS5 的连接交回它
 * @param {() => ({ enabled: boolean, password: string, portForUser: (user: string) => number } | null)} options.resolveRelay
 *        问中转要「这个用户名对应哪个回环端口」；拿不到（没在跑）就拒掉这条 SOCKS5 连接
 */
function createRelayPortMux(options = {}) {
  const httpServer = options.httpServer;
  const resolveRelay = options.resolveRelay;
  // UDP 前端在监听之后才绑（端口以真实监听端口为准），所以这里拿的是 getter。
  const resolveUdpFront = typeof options.resolveUdpFront === 'function' ? options.resolveUdpFront : () => null;
  const timeoutMs = Number(options.timeoutMs || DEFAULT_HANDSHAKE_TIMEOUT_MS);
  let associationSeq = 0;
  // 分流器接管的连接（含尚未完成首字节判定的）：停服时要由这里销毁，
  // 因为 http server 在分流模式下从不 listen，Node 的 closeAllConnections 管不到它们。
  const handedSockets = new Set();
  // 是否接管监听口：由中转的端口模式决定（server 模式接管，dedicated 模式完全不介入）。
  let enabledCache = null;
  function enabled() {
    if (enabledCache === null) {
      const relay = typeof resolveRelay === 'function' ? resolveRelay() : null;
      enabledCache = Boolean(relay && relay.enabled === true);
    }
    return enabledCache;
  }

  function listener() {
    const server = net.createServer({ pauseOnConnect: true }, (socket) => {
      handedSockets.add(socket);
      socket.once('close', () => handedSockets.delete(socket));
      onConnection(socket);
    });
    return server;
  }

  /**
   * 关闭分流器接管的全部连接。
   *
   * 为什么必须有这个口子：http server 在分流模式下**从不 listen**，Node 的
   * `server.closeIdleConnections()` / `closeAllConnections()` 对通过 `emit('connection')`
   * 交进来的 socket 不生效（实测：调用后连接照旧，`listener.close()` 要等对端自己断开，
   * 停服被拖 3s，端口连接泄漏）。所以由分流器自己记住这些 socket 并在停服时销毁。
   * 调用时机与 dedicated 模式的 `closeAllConnections()` 一致：排空在途请求之后。
   */
  function destroyConnections() {
    const sockets = [...handedSockets];
    handedSockets.clear();
    sockets.forEach((socket) => {
      try { socket.destroy(); } catch (_error) {}
    });
    return sockets.length;
  }

  function onConnection(socket) {
    socket.on('error', () => socket.destroy());
    socket.setTimeout(timeoutMs, () => socket.destroy());
    // 只 peek 一个字节：不消费、不改变顺序（unshift 回去再决定给谁）。
    socket.once('readable', () => {
      const head = socket.read(1);
      if (!head || head.length === 0) {
        socket.destroy();
        return;
      }
      socket.unshift(head);
      if (head[0] !== SOCKS5_VERSION) {
        socket.setTimeout(0);
        httpServer.emit('connection', socket);
        return;
      }
      handleSocks(socket).catch(() => socket.destroy());
    });
  }

  async function handleSocks(socket) {
    const reader = new SocketReader(socket);
    // 1. 问候：[0x05, nmethods, methods…]
    const greeting = await reader.read(2);
    if (!greeting || greeting[0] !== SOCKS5_VERSION) return socket.destroy();
    const methods = await reader.read(greeting[1]);
    if (!methods) return socket.destroy();
    if (!methods.includes(METHOD_USER_PASS)) {
      // 客户端只想免认证：这个入口必须认证（用户名就是节点选择器）。
      socket.write(Buffer.from([SOCKS5_VERSION, METHOD_NONE]));
      return socket.destroy();
    }
    socket.write(Buffer.from([SOCKS5_VERSION, METHOD_USER_PASS]));

    // 2. 用户名/密码：[0x01, ulen, user…, plen, pass…]
    const authHeader = await reader.read(2);
    if (!authHeader || authHeader[0] !== AUTH_VERSION) return socket.destroy();
    const user = await reader.read(authHeader[1]);
    if (!user) return socket.destroy();
    const passLength = await reader.read(1);
    if (!passLength) return socket.destroy();
    const pass = await reader.read(passLength[0]);
    if (!pass) return socket.destroy();

    const relay = typeof resolveRelay === 'function' ? resolveRelay() : null;
    const username = user.toString('utf8');
    if (!relay || relay.enabled !== true || !sameSecret(pass.toString('utf8'), relay.password)) {
      socket.write(Buffer.from([AUTH_VERSION, AUTH_FAILED]));
      return socket.destroy();
    }
    const port = relay.portForUser(username);
    if (!Number.isInteger(port) || port <= 0) {
      socket.write(Buffer.from([AUTH_VERSION, AUTH_FAILED]));
      return socket.destroy();
    }

    // 3. 认证通过先回执（协议要求：认证完成后再发请求）。
    socket.write(Buffer.from([AUTH_VERSION, AUTH_OK]));
    // 4. 往后的 SOCKS5 请求由我们自己看：CONNECT 直通给边车，ASSOCIATE 需要接管（UDP 端口要固定）。
    const request = await readRequest(reader);
    if (!request) return socket.destroy();
    if (request.cmd === CMD_ASSOCIATE) return handleAssociate(socket, reader, port);
    if (request.cmd !== CMD_CONNECT) {
      socket.write(buildReply(REP_COMMAND_NOT_SUPPORTED, ATYP_IPV4, Buffer.alloc(4), 0));
      return socket.destroy();
    }

    // 5. 转到回环上的内核边车：它只认回环、不需要再认证（认证已经在上面做过）。
    const target = await connectLoopback(port);
    if (!target) {
      socket.write(buildReply(REP_GENERAL_FAILURE, ATYP_IPV4, Buffer.alloc(4), 0));
      return socket.destroy();
    }
    const targetReader = new SocketReader(target);
    target.write(Buffer.from([SOCKS5_VERSION, 1, METHOD_NO_AUTH]));
    const methodReply = await targetReader.read(2);
    if (!methodReply || methodReply[1] !== METHOD_NO_AUTH) {
      target.destroy();
      socket.write(buildReply(REP_GENERAL_FAILURE, ATYP_IPV4, Buffer.alloc(4), 0));
      return socket.destroy();
    }
    const leftover = reader.detach();
    const targetLeftover = targetReader.detach();
    socket.setTimeout(0);
    // 请求原样补发给边车（我们只是看了一眼，没有改写）。
    target.write(Buffer.concat([request.raw, leftover]));
    if (targetLeftover.length) socket.write(targetLeftover);
    socket.pipe(target);
    target.pipe(socket);
    return undefined;
  }

  /**
   * UDP ASSOCIATE：客户端要的不是一条 TCP 隧道，而是一个**固定的 UDP 入口**。
   * 边车给的是临时端口（实测 127.0.0.1:54038 这种），防火墙放行不了、NAT 后还会回私网地址，
   * 所以这里我们自己拿一个关联、把 BND 改写成「客户端能连到的地址 + AIH 端口号的 UDP 侧」，
   * 数据报交给 relay-udp-front 桥接到边车（那边认同一套 SOCKS5 UDP 封装，原样透传）。
   */
  async function handleAssociate(socket, reader, port) {
    const udpFront = resolveUdpFront();
    if (!udpFront || udpFront.enabled() !== true) {
      socket.write(buildReply(REP_COMMAND_NOT_SUPPORTED, ATYP_IPV4, Buffer.alloc(4), 0));
      return socket.destroy();
    }
    const control = await connectLoopback(port);
    if (!control) {
      socket.write(buildReply(REP_GENERAL_FAILURE, ATYP_IPV4, Buffer.alloc(4), 0));
      return socket.destroy();
    }
    const controlReader = new SocketReader(control);
    control.write(Buffer.from([SOCKS5_VERSION, 1, METHOD_NO_AUTH]));
    const methodReply = await controlReader.read(2);
    if (!methodReply || methodReply[1] !== METHOD_NO_AUTH) {
      control.destroy();
      socket.write(buildReply(REP_GENERAL_FAILURE, ATYP_IPV4, Buffer.alloc(4), 0));
      return socket.destroy();
    }
    control.write(Buffer.from([SOCKS5_VERSION, CMD_ASSOCIATE, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0]));
    const sidecarBnd = await readReply(controlReader);
    if (!sidecarBnd) {
      control.destroy();
      socket.write(buildReply(REP_GENERAL_FAILURE, ATYP_IPV4, Buffer.alloc(4), 0));
      return socket.destroy();
    }

    const bind = await resolveBindAddress(advertiseHost() || socket.localAddress);
    if (!bind) {
      control.destroy();
      socket.write(buildReply(REP_GENERAL_FAILURE, ATYP_IPV4, Buffer.alloc(4), 0));
      return socket.destroy();
    }
    const id = `assoc-${++associationSeq}`;
    udpFront.addAssociation({ id, sidecarBnd });
    reader.detach();
    socket.setTimeout(0);
    // 播报端口默认是本前端绑的端口；经 frp 之类的转发时由前端按 relay settings 的 advertisePort 覆写。
    const advertisedPort = typeof udpFront.advertisePort === 'function' ? udpFront.advertisePort() : udpFront.port();
    socket.write(buildReply(REP_SUCCEEDED, bind.atyp, bind.bytes, advertisedPort));

    // 关联的生命周期 = 客户端那条控制连接（RFC 1928）；任一侧断开就回收。
    const release = () => {
      udpFront.removeAssociation(id);
      control.destroy();
    };
    socket.once('close', release);
    socket.once('error', release);
    control.once('close', () => {
      udpFront.removeAssociation(id);
      socket.destroy();
    });
    return undefined;
  }

  function advertiseHost() {
    const udpFront = resolveUdpFront();
    if (udpFront && typeof udpFront.advertiseHost === 'function') return udpFront.advertiseHost();
    return '';
  }

  function connectLoopback(port) {
    return new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.setTimeout(timeoutMs);
      const fail = () => {
        socket.removeAllListeners();
        socket.destroy();
        resolve(null);
      };
      socket.once('error', fail);
      socket.once('timeout', fail);
      socket.once('connect', () => {
        socket.removeListener('error', fail);
        socket.removeListener('timeout', fail);
        socket.setTimeout(0);
        resolve(socket);
      });
    });
  }

  return {
    enabled,
    listener,
    destroyConnections,
    /** 这个 socket 的首字节是不是 SOCKS5（测试与排障用）。 */
    isSocks5: (head) => Boolean(head && head.length && head[0] === SOCKS5_VERSION)
  };
}

module.exports = {
  AUTH_FAILED,
  AUTH_OK,
  AUTH_VERSION,
  ATYP_IPV4,
  CMD_ASSOCIATE,
  CMD_CONNECT,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  METHOD_NONE,
  METHOD_NO_AUTH,
  METHOD_USER_PASS,
  REP_COMMAND_NOT_SUPPORTED,
  SOCKS5_VERSION,
  SocketReader,
  createRelayPortMux,
  readReply,
  readRequest,
  resolveBindAddress,
  sameSecret
};
