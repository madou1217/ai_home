'use strict';

const dns = require('node:dns');
const net = require('node:net');
const tls = require('node:tls');
const { isBlockedMetadataAddress, isFakeIpAddress } = require('../proxy-pool/subscription-fetcher');

// 节点探针：只知道地址时猜协议。依次看 DNS、TCP 建连与延迟、服务端先发的横幅（SSH）、TLS 握手
// （ALPN、证书名与 SNI 是否相符——不相符常见于 REALITY 伪装）、SOCKS5 握手、HTTP CONNECT。
// 需要凭据的协议（Shadowsocks、无 TLS 的 VMess / VLESS）端口开着但不回应；UDP 协议（Hysteria2、TUIC、
// WireGuard）没有凭据探不出来，只能由界面说明。

const MAX_PORTS = 32;
const PORT_CONCURRENCY = 8;
const CONNECT_TIMEOUT_MS = 3000;
const BANNER_WAIT_MS = 400;
const HANDSHAKE_TIMEOUT_MS = 2000;
// 不带端口时试这些常见端口（HTTPS 及 Cloudflare 回源端口、HTTP、SOCKS、Shadowsocks、SSH）。
const COMMON_PORTS = Object.freeze([443, 8443, 2053, 2083, 2087, 2096, 80, 8080, 8880, 1080, 8388, 22]);
const CONNECT_PROBE_TARGET = 'www.gstatic.com:443';
const HOST_PATTERN = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/i;

function probeError(code) {
  return Object.assign(new Error(code), { code });
}

/** 主机名或 IP（IPv6 可带方括号）；端口列表去重、限 32 个，不给时用常见端口。 */
function normalizeProbeInput(input = {}) {
  const host = String(input.host ?? '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host.length > 253 || (!net.isIP(host) && !HOST_PATTERN.test(host))) throw probeError('invalid_probe_host');
  const raw = Array.isArray(input.ports) ? input.ports : (input.port !== undefined && input.port !== '' ? [input.port] : []);
  const ports = [...new Set(raw.map(Number))];
  if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) throw probeError('invalid_probe_port');
  if (ports.length > MAX_PORTS) throw probeError('too_many_probe_ports');
  return { host, ports: ports.length ? ports : [...COMMON_PORTS] };
}

/** 读到第一段数据或超时就结束（超时返回空 Buffer），不抛错。 */
function readFirstChunk(socket, waitMs) {
  return new Promise((resolve) => {
    const finish = (chunk) => {
      clearTimeout(timer);
      socket.removeListener('data', finish);
      socket.removeListener('error', onEnd);
      socket.removeListener('close', onEnd);
      resolve(chunk || Buffer.alloc(0));
    };
    const onEnd = () => finish(null);
    const timer = setTimeout(() => finish(null), waitMs);
    socket.once('data', finish);
    socket.once('error', onEnd);
    socket.once('close', onEnd);
  });
}

/** 横幅只取第一行，不可见字符换成点。 */
function printable(buffer, limit = 80) {
  return buffer.toString('latin1').split(/\r?\n/)[0].slice(0, limit).replace(/[^\x20-\x7e]/g, '.').trim();
}

/** 证书里的 DNS 名（SAN 优先，没有时用 CN）是否覆盖 servername（支持一级通配符）。 */
function certificateCovers(names, servername) {
  const target = String(servername || '').toLowerCase();
  return names.some((name) => {
    const pattern = String(name).toLowerCase();
    if (pattern.startsWith('*.')) return target.endsWith(pattern.slice(1)) && target.split('.').length === pattern.split('.').length;
    return pattern === target;
  });
}

function certificateNames(certificate) {
  const sans = String(certificate?.subjectaltname || '').split(',').map((item) => item.trim())
    .filter((item) => item.startsWith('DNS:')).map((item) => item.slice(4));
  const commonName = certificate?.subject?.CN;
  return sans.length ? sans : (commonName ? [String(commonName)] : []);
}

/** 由一个端口的探测结果推断可能的协议（候选按可能性排序）和给人看的说明。 */
function classifyPort(result) {
  if (!result.open) return { candidates: [], note: '' };
  if (result.banner?.startsWith('SSH-')) return { candidates: ['ssh'], note: `SSH 服务（${result.banner}）` };
  if (result.socks5) {
    return {
      candidates: ['socks5'],
      note: result.socks5 === 'userpass' ? 'SOCKS5 代理，需要用户名密码' : result.socks5 === 'none' ? 'SOCKS5 代理，无需认证' : 'SOCKS5 代理，拒绝了认证方式'
    };
  }
  if (result.tls) {
    if (result.tls.proxyStatus === 407 || result.tls.proxyStatus === 200) {
      return { candidates: ['https'], note: result.tls.proxyStatus === 407 ? 'HTTPS 代理，需要认证' : 'HTTPS 代理，无需认证' };
    }
    if (result.tls.sniMatch === false && result.tls.names.length) {
      return {
        candidates: ['vless', 'trojan', 'anytls'],
        note: `证书属于 ${result.tls.names[0]}，与地址不符：可能是 REALITY（伪装成该网站，填它作 SNI），也可能是证书配错`
      };
    }
    return { candidates: ['trojan', 'vless', 'vmess', 'anytls', 'https'], note: `TLS 服务${result.tls.alpn ? `（ALPN ${result.tls.alpn}）` : ''}：需要凭据的协议识别不出具体是哪种` };
  }
  if (result.httpStatus === 407 || result.httpStatus === 200) {
    return { candidates: ['http'], note: result.httpStatus === 407 ? 'HTTP 代理，需要认证' : 'HTTP 代理，无需认证' };
  }
  if (result.httpStatus) return { candidates: ['vmess', 'vless'], note: `HTTP 服务（状态 ${result.httpStatus}）：可能是 WebSocket 传输，或者只是网站` };
  if (result.banner) return { candidates: [], note: `服务端主动发送：${result.banner}` };
  return { candidates: ['shadowsocks', 'vmess', 'vless', 'trojan'], note: '端口开放但不回应：需要凭据的协议（Shadowsocks、无 TLS 的 VMess / VLESS 等）' };
}

class NodeProbe {
  constructor(options = {}) {
    this.lookup = options.lookup || ((host) => dns.promises.lookup(host, { all: true, verbatim: true }));
    this.netConnect = options.netConnect || net.connect;
    this.tlsConnect = options.tlsConnect || tls.connect;
    this.now = options.now || (() => performance.now());
    this.connectTimeoutMs = options.connectTimeoutMs || CONNECT_TIMEOUT_MS;
    this.bannerWaitMs = options.bannerWaitMs ?? BANNER_WAIT_MS;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs || HANDSHAKE_TIMEOUT_MS;
  }

  async resolve(host) {
    if (net.isIP(host)) return [host];
    const answers = await this.lookup(host);
    const addresses = answers.map((answer) => answer.address);
    // IPv4 优先：多数节点只在 IPv4 上监听，本机 IPv6 也未必通。
    return [...addresses.filter((address) => net.isIPv4(address)), ...addresses.filter((address) => !net.isIPv4(address))];
  }

  /** 建立一个 TCP 连接（超时 / 出错时 reject，code 为系统错误码或 ETIMEDOUT）。 */
  openSocket(address, port, timeoutMs = this.connectTimeoutMs) {
    return new Promise((resolve, reject) => {
      const started = this.now();
      const socket = this.netConnect({ host: address, port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(probeError('ETIMEDOUT'));
      }, timeoutMs);
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve({ socket, latencyMs: Math.round(this.now() - started) });
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        socket.destroy();
        reject(probeError(error.code || 'ECONNREFUSED'));
      });
    });
  }

  /** 新连接上发一段握手、读第一段回应；连不上或不回应时返回空 Buffer。 */
  async exchange(address, port, payload) {
    let socket;
    try {
      ({ socket } = await this.openSocket(address, port, this.handshakeTimeoutMs));
      socket.write(payload);
      return await readFirstChunk(socket, this.handshakeTimeoutMs);
    } catch (_error) {
      return Buffer.alloc(0);
    } finally {
      socket?.destroy();
    }
  }

  async probeSocks5(address, port) {
    // 同时提供「无认证」与「用户名密码」两种方式，看服务端选哪个。
    const reply = await this.exchange(address, port, Buffer.from([0x05, 0x02, 0x00, 0x02]));
    if (reply.length < 2 || reply[0] !== 0x05) return '';
    return reply[1] === 0x00 ? 'none' : reply[1] === 0x02 ? 'userpass' : 'rejected';
  }

  async probeHttpConnect(address, port) {
    const reply = await this.exchange(address, port, `CONNECT ${CONNECT_PROBE_TARGET} HTTP/1.1\r\nHost: ${CONNECT_PROBE_TARGET}\r\n\r\n`);
    const status = reply.toString('latin1').match(/^HTTP\/1\.[01] (\d{3})/);
    return status ? Number(status[1]) : 0;
  }

  probeTls(address, port, servername) {
    return new Promise((resolve) => {
      let settled = false;
      const socket = this.tlsConnect({
        host: address,
        port,
        servername: servername || undefined,
        ALPNProtocols: ['h2', 'http/1.1'],
        rejectUnauthorized: false
      });
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), this.handshakeTimeoutMs);
      socket.once('error', () => finish(null));
      socket.once('secureConnect', () => {
        // 握手已完成：接下来只等 CONNECT 的回应（readFirstChunk 自带超时），握手计时器不再适用。
        clearTimeout(timer);
        const certificate = socket.getPeerCertificate() || {};
        const names = certificateNames(certificate);
        const info = {
          alpn: socket.alpnProtocol || '',
          names: names.slice(0, 10),
          issuer: certificate.issuer?.O || certificate.issuer?.CN || '',
          selfSigned: Boolean(certificate.issuer && certificate.subject && JSON.stringify(certificate.issuer) === JSON.stringify(certificate.subject)),
          validTo: certificate.valid_to || '',
          sniMatch: servername ? certificateCovers(names, servername) : null,
          proxyStatus: 0
        };
        // 同一条 TLS 连接上再问一次 CONNECT：HTTPS 代理（含 NaiveProxy）会回 407 / 200。
        socket.write(`CONNECT ${CONNECT_PROBE_TARGET} HTTP/1.1\r\nHost: ${CONNECT_PROBE_TARGET}\r\n\r\n`);
        void readFirstChunk(socket, this.handshakeTimeoutMs).then((reply) => {
          const status = reply.toString('latin1').match(/^HTTP\/1\.[01] (\d{3})/);
          finish({ ...info, proxyStatus: status ? Number(status[1]) : 0 });
        });
      });
    });
  }

  async probePort(address, port, servername) {
    let opened;
    try {
      opened = await this.openSocket(address, port);
    } catch (error) {
      return { port, open: false, error: error.code };
    }
    const result = { port, open: true, latencyMs: opened.latencyMs };
    const banner = await readFirstChunk(opened.socket, this.bannerWaitMs);
    opened.socket.destroy();
    if (banner.length) {
      result.banner = printable(banner);
    } else {
      const tlsInfo = await this.probeTls(address, port, servername);
      if (tlsInfo) result.tls = tlsInfo;
      else {
        const socks5 = await this.probeSocks5(address, port);
        if (socks5) result.socks5 = socks5;
        else {
          const httpStatus = await this.probeHttpConnect(address, port);
          if (httpStatus) result.httpStatus = httpStatus;
        }
      }
    }
    return { ...result, ...classifyPort(result) };
  }

  async probe(input) {
    const { host, ports } = normalizeProbeInput(input);
    let addresses;
    try {
      addresses = await this.resolve(host);
    } catch (error) {
      return { ok: true, host, addresses: [], dnsError: error.code || 'ENOTFOUND', fakeIp: false, ports: [] };
    }
    if (!addresses.length) return { ok: true, host, addresses: [], dnsError: 'ENOTFOUND', fakeIp: false, ports: [] };
    if (addresses.some(isBlockedMetadataAddress)) throw probeError('probe_address_blocked');
    const address = addresses[0];
    const servername = net.isIP(host) ? '' : host;
    const results = new Array(ports.length);
    let next = 0;
    const worker = async () => {
      while (next < ports.length) {
        const index = next;
        next += 1;
        results[index] = await this.probePort(address, ports[index], servername);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PORT_CONCURRENCY, ports.length) }, worker));
    return {
      ok: true,
      host,
      addresses: addresses.slice(0, 8),
      // 本机代理的 fake-ip：连接其实连到了本机代理，延迟与开放情况都不代表节点本身。
      fakeIp: addresses.filter((item) => net.isIPv4(item)).every(isFakeIpAddress) && addresses.some((item) => net.isIPv4(item)),
      ports: results
    };
  }
}

module.exports = {
  COMMON_PORTS,
  MAX_PORTS,
  NodeProbe,
  certificateCovers,
  classifyPort,
  normalizeProbeInput
};
