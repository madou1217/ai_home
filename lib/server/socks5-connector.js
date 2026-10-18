'use strict';

// SOCKS5 出口的传输层适配器：把 socks5:// 地址变成 undici 能用的 connect 函数。
//
// 为什么需要它：undici 的 ProxyAgent 只接受 http(s):// 代理（构造时直接
// `Invalid URL protocol`），所以在此之前账号出口只能收 HTTP(S) 代理，
// socks5 一律被入口拒绝（见 zcode-egress-resolver 的 ALLOWED_PROXY_SCHEMES）。
// 而 undici 的 Agent 允许注入自定义 connect —— 于是 SOCKS5 不需要任何新依赖，
// 只要在这里实现握手（RFC 1928）再把 socket 交回去。
//
// socks5 与 socks5h 的区别按标准实现，不能混为一谈：
//   - socks5h：把**域名**发给代理（ATYP=3），由代理侧解析 —— 出口 IP 与解析位置
//     一致，本地 DNS 被污染/不可达时也能用。
//   - socks5：本地先解析成 IP 再发（ATYP=1/4），与 curl/Go 的同名 scheme 语义一致。

const net = require('node:net');
const tls = require('node:tls');
const dns = require('node:dns');

const SOCKS_VERSION = 0x05;
const METHOD_NO_AUTH = 0x00;
const METHOD_USERNAME_PASSWORD = 0x02;
const METHOD_NONE_ACCEPTABLE = 0xff;
const CMD_CONNECT = 0x01;
const ATYP_IPV4 = 0x01;
const ATYP_DOMAIN = 0x03;
const ATYP_IPV6 = 0x04;
const REPLY_SUCCEEDED = 0x00;

// 握手总时长上限：代理不可达时不能让请求挂到上游超时。
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000;

const SOCKS_SCHEMES = new Set(['socks5:', 'socks5h:']);

/** 该地址是否是本模块能处理的 SOCKS 代理。 */
function isSocksProxyUrl(value) {
  try {
    return SOCKS_SCHEMES.has(new URL(String(value || '').trim()).protocol);
  } catch (_error) {
    return false;
  }
}

const REPLY_LABELS = Object.freeze({
  0x01: 'general_socks_server_failure',
  0x02: 'connection_not_allowed_by_ruleset',
  0x03: 'network_unreachable',
  0x04: 'host_unreachable',
  0x05: 'connection_refused',
  0x06: 'ttl_expired',
  0x07: 'command_not_supported',
  0x08: 'address_type_not_supported'
});

function replyFailureMessage(replyCode) {
  return REPLY_LABELS[replyCode] || `socks5_reply_${replyCode}`;
}

/** 展开 IPv6 字面量成 8 组 16 位整数；非法返回 null。 */
function expandIpv6(address) {
  const withoutZone = String(address).replace(/^\[|\]$/g, '').split('%')[0];
  const halves = withoutZone.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0) return null;
  if (halves.length === 1 && missing !== 0) return null;
  const groups = [
    ...head.map((group) => parseInt(group, 16)),
    ...new Array(halves.length === 2 ? missing : 0).fill(0),
    ...tail.map((group) => parseInt(group, 16))
  ];
  if (groups.length !== 8) return null;
  if (groups.some((group) => !Number.isInteger(group) || group < 0 || group > 0xffff)) return null;
  return groups;
}

/** 目标地址编码成 SOCKS5 请求里的 ATYP+ADDR 段；编码不了返回 null。 */
function encodeTarget(address) {
  const value = String(address || '');
  const family = net.isIP(value);
  if (family === 4) {
    return Buffer.concat([Buffer.from([ATYP_IPV4]), Buffer.from(value.split('.').map(Number))]);
  }
  if (family === 6) {
    const groups = expandIpv6(value);
    if (!groups) return null;
    const bytes = Buffer.alloc(16);
    groups.forEach((group, index) => bytes.writeUInt16BE(group, index * 2));
    return Buffer.concat([Buffer.from([ATYP_IPV6]), bytes]);
  }
  const host = Buffer.from(value, 'utf8');
  if (host.length === 0 || host.length > 255) return null;
  return Buffer.concat([Buffer.from([ATYP_DOMAIN, host.length]), host]);
}

/** CONNECT 应答里 BND.ADDR 的长度；域名类型返回 null（长度在下一字节）。 */
function boundAddressLength(atyp) {
  if (atyp === ATYP_IPV4) return 4;
  if (atyp === ATYP_IPV6) return 16;
  if (atyp === ATYP_DOMAIN) return null;
  return -1;
}

/**
 * 建 SOCKS5 隧道：连代理 → 问候 →（可选）认证 → CONNECT → 按目标协议包 TLS。
 *
 * 只做「建立隧道」这一件事，因此对 http / https 目标都通用：TLS 包装与 undici
 * 自己的 connector 同一约定（protocol === 'https:' 时用 tls.connect 包一层）。
 */
function socks5Connect(proxyUrl, options, callback) {
  const parsed = new URL(proxyUrl);
  const proxyHost = parsed.hostname;
  const proxyPort = Number(parsed.port) || 1080;
  const username = decodeURIComponent(parsed.username || '');
  const password = decodeURIComponent(parsed.password || '');
  const remoteDns = parsed.protocol === 'socks5h:';
  const timeoutMs = Number(options && options.timeout) > 0
    ? Number(options.timeout)
    : DEFAULT_HANDSHAKE_TIMEOUT_MS;

  const { hostname, servername, protocol, port: rawPort } = options || {};
  const port = Number(rawPort) || (protocol === 'https:' ? 443 : 80);

  let settled = false;
  let socket = null;
  let timer = null;
  let stage = 'greeting';
  let pending = Buffer.alloc(0);

  const fail = (error) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    timer = null;
    if (socket) {
      socket.removeAllListeners();
      socket.destroy();
    }
    callback(error, null);
  };

  const succeed = (readySocket) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    timer = null;
    if (readySocket !== socket) socket.removeAllListeners();
    callback(null, readySocket);
  };

  /** 隧道已打通：https 目标再包一层 TLS，其余原样交出。 */
  const finishTunnel = () => {
    socket.removeAllListeners('data');
    pending = Buffer.alloc(0);
    if (protocol !== 'https:') {
      succeed(socket);
      return;
    }
    const tlsSocket = tls.connect({
      socket,
      servername: servername || hostname,
      ALPNProtocols: ['http/1.1']
    });
    tlsSocket.once('secureConnect', () => succeed(tlsSocket));
    tlsSocket.once('error', (error) => {
      tlsSocket.destroy();
      fail(error);
    });
  };

  const writeRequest = (encodedTarget) => {
    const portBuffer = Buffer.alloc(2);
    portBuffer.writeUInt16BE(port, 0);
    socket.write(Buffer.concat([
      Buffer.from([SOCKS_VERSION, CMD_CONNECT, 0x00]),
      encodedTarget,
      portBuffer
    ]));
    stage = 'reply';
  };

  const issueRequest = () => {
    if (remoteDns) {
      const encoded = encodeTarget(hostname);
      if (!encoded) return fail(new Error('socks5_target_encoding_failed'));
      writeRequest(encoded);
      return;
    }
    // socks5（本地解析）：先解析成 IP，再把字面量交给代理。
    dns.lookup(String(hostname), { verbatim: true }, (error, address) => {
      if (settled) return;
      if (error) return fail(error);
      const encoded = encodeTarget(address);
      if (!encoded) return fail(new Error('socks5_target_encoding_failed'));
      writeRequest(encoded);
    });
  };

  /** 读满 n 字节后回调（TCP 不保证一次读完，二进制协议必须按长度收）。 */
  const readExact = (count, onReady) => {
    if (pending.length < count) return;
    const frame = pending.subarray(0, count);
    pending = pending.subarray(count);
    onReady(frame);
  };

  const handleGreeting = () => {
    readExact(2, (frame) => {
      if (frame[0] !== SOCKS_VERSION) return fail(new Error('socks5_bad_version'));
      const method = frame[1];
      if (method === METHOD_NONE_ACCEPTABLE) return fail(new Error('socks5_no_acceptable_auth_method'));
      if (method === METHOD_USERNAME_PASSWORD) {
        const user = Buffer.from(username, 'utf8');
        const pass = Buffer.from(password, 'utf8');
        if (user.length > 255 || pass.length > 255) return fail(new Error('socks5_credentials_too_long'));
        socket.write(Buffer.concat([
          Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass
        ]));
        stage = 'auth';
        handleAuth();
        return;
      }
      if (method !== METHOD_NO_AUTH) return fail(new Error('socks5_unsupported_auth_method'));
      issueRequest();
    });
  };

  const handleAuth = () => {
    readExact(2, (frame) => {
      if (frame[1] !== 0x00) return fail(new Error('socks5_auth_failed'));
      issueRequest();
    });
  };

  // 应答按「整帧」解析：先窥视头部算出完整长度，凑够才一次性消费。不能分段消费 ——
  // 头部消费后剩余字节还没到时，下一个 data 事件会从头重入，把地址字节当成新头部
  // （VER≠5 → socks5_bad_version）。远端代理把应答拆成多个 TCP 段时就会这样。
  const handleReply = () => {
    if (pending.length < 4) return;
    if (pending[0] !== SOCKS_VERSION) return fail(new Error('socks5_bad_version'));
    if (pending[1] !== REPLY_SUCCEEDED) return fail(new Error(replyFailureMessage(pending[1])));
    const addressLength = boundAddressLength(pending[3]);
    if (addressLength === -1) return fail(new Error('socks5_bad_address_type'));
    let total;
    if (addressLength === null) {
      if (pending.length < 5) return;
      total = 4 + 1 + pending[4] + 2;
    } else {
      total = 4 + addressLength + 2;
    }
    if (pending.length < total) return;
    pending = pending.subarray(total);
    finishTunnel();
  };

  const dispatch = () => {
    if (stage === 'greeting') return handleGreeting();
    if (stage === 'auth') return handleAuth();
    return handleReply();
  };

  try {
    socket = net.connect({ host: proxyHost, port: proxyPort });
  } catch (error) {
    fail(error);
    return;
  }
  socket.setNoDelay(true);
  timer = setTimeout(() => fail(new Error('socks5_handshake_timeout')), timeoutMs);
  socket.on('error', fail);
  socket.on('close', () => fail(new Error('socks5_proxy_closed')));
  socket.on('data', (chunk) => {
    if (settled) return;
    pending = Buffer.concat([pending, chunk]);
    dispatch();
  });
  socket.once('connect', () => {
    const methods = (username || password)
      ? [METHOD_NO_AUTH, METHOD_USERNAME_PASSWORD]
      : [METHOD_NO_AUTH];
    socket.write(Buffer.from([SOCKS_VERSION, methods.length, ...methods]));
  });
}

/** 生成 undici Agent 的 connect 实现；签名与 undici 的 buildConnector 一致。 */
function createSocks5Connector(proxyUrl, options = {}) {
  const url = String(proxyUrl || '').trim();
  if (!isSocksProxyUrl(url)) throw new Error('socks5_proxy_url_invalid');
  const defaults = options && typeof options === 'object' ? options : {};
  return function connect(connectOptions, callback) {
    socks5Connect(url, { ...defaults, ...connectOptions }, callback);
  };
}

module.exports = {
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  createSocks5Connector,
  isSocksProxyUrl
};
