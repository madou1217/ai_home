'use strict';

const dgram = require('node:dgram');

const { parseRelaySettings } = require('./relay-settings');

/**
 * 「跟随 AIH 端口」模式下的 UDP 中继前端（SOCKS5 UDP ASSOCIATE 的服务端）。
 *
 * 为什么需要它：UDP 必须有独立的 UDP 端口，而且 sing-box 每次关联给客户端的 BND 是**临时端口**
 * （实测 127.0.0.1:54038 / 192.168.31.8:59244 这种），防火墙/安全组/frp 无法预先放行；AWS 那种
 * 1:1 NAT 还会回私网地址。所以由本模块占一个**固定已知**的 UDP 端口（就用 AIH 那个端口号），
 * 自己跟客户端打交道，再把数据报桥接给回环上边车的 UDP 中继。
 *
 * 数据报是**原样透传**的：客户端按 SOCKS5 UDP 格式（RSV+FRAG+目标地址+目标端口+正文）发来，
 * 边车的中继也认同一套格式，所以这里不做任何解码 —— 只做「谁的数据报」→「哪个关联」的路由。
 *
 * 关联路由：
 * - 来自边车中继地址的数据报 = 回程 → 交给锁定了该关联的客户端；
 * - 其余 = 客户端来报 → 按 `客户端IP:端口` 查表；没锁过且有唯一活动关联时锁定它；
 *   歧义（同一 IP 有多个活动关联且没锁）时丢弃，避免把 A 节点的流量塞进 B 节点。
 */

const DEFAULT_IDLE_TIMEOUT_MS = 120000;
const REAP_INTERVAL_MS = 30000;

function keyOf(rinfo) {
  return `${rinfo.address}:${rinfo.port}`;
}

function createRelayUdpFront(options = {}) {
  const port = Number(options.port || 0);
  const host = String(options.host || '0.0.0.0');
  // 播报给客户端的 UDP 地址：默认用客户端连过来的本机地址（socket.localAddress），
  // 但 1:1 NAT（AWS 弹性 IP）下本机看到的是私网地址，那时用 relay settings 的 advertiseHost 钉一个外部地址/域名。
  const settings = parseRelaySettings(process.env);
  const advertiseHostValue = String(options.advertiseHost || settings.advertiseHost || '').trim();
  // 经过 frp 之类的端口转发时，客户端要发的端口也不是本地那个（例如本地 9527 → 远端 29527），
  // 用 relay settings 的 advertisePort 钉住；不设就用本前端实际绑定的端口。
  const advertisePortValue = Number(options.advertisePort || settings.advertisePort || 0);
  // 部署侧只放行了 TCP 时（例如安全组没有同号 UDP 规则）设 relay settings 的 udp=0（`aih server config set --relay-udp off`）：不起 UDP 前端，
  // 条目也就不声明 udp-relay，客户端不会去尝试一条根本到不了的 UDP 通路。
  const disabled = /^(0|false|off|no)$/i.test(String(settings.udp || '').trim());
  const idleTimeoutMs = Number(options.idleTimeoutMs || DEFAULT_IDLE_TIMEOUT_MS);
  const log = options.log || { warn: () => {}, log: () => {} };
  const now = options.now || (() => Date.now());
  const createSocket = options.createSocket || (() => dgram.createSocket('udp4'));

  let socket = null;
  let reaper = null;
  const associations = new Map();
  const bySidecar = new Map();
  const byClient = new Map();

  function sidecarKey(bnd) {
    return `${bnd.host}:${bnd.port}`;
  }

  function pickAssociation(rinfo) {
    const locked = byClient.get(keyOf(rinfo));
    if (locked) return associations.get(locked) || null;
    const candidates = [...associations.values()].filter((item) => !item.clientKey);
    return candidates.length === 1 ? candidates[0] : null;
  }

  function sendSafely(socketImpl, chunk, port, host) {
    try {
      socketImpl.send(chunk, port, host, () => undefined);
    } catch (_error) {
      // socket 正在关（停服/关联回收的竞态）：丢掉这一个数据报，不要抛出。
    }
  }

  function onMessage(chunk, rinfo) {
    if (!socket) return;
    const fromSidecar = bySidecar.get(keyOf(rinfo));
    if (fromSidecar) {
      const association = associations.get(fromSidecar);
      if (!association || !association.clientKey) return;
      sendSafely(socket, chunk, association.clientPort, association.clientHost);
      association.lastUsed = now();
      return;
    }
    const association = pickAssociation(rinfo);
    if (!association) {
      log.warn?.(`[aih:relay-udp] 丢弃来自 ${keyOf(rinfo)} 的数据报：没有可归属的中转关联`);
      return;
    }
    if (!association.clientKey) {
      association.clientKey = keyOf(rinfo);
      association.clientHost = rinfo.address;
      association.clientPort = rinfo.port;
      byClient.set(association.clientKey, association.id);
    }
    sendSafely(socket, chunk, association.sidecarBnd.port, association.sidecarBnd.host);
    association.lastUsed = now();
  }

  function reap() {
    const deadline = now() - idleTimeoutMs;
    for (const association of [...associations.values()]) {
      if (association.lastUsed > deadline) continue;
      removeAssociation(association.id);
    }
  }

  function addAssociation({ id, sidecarBnd }) {
    if (!socket) return false;
    const existing = associations.get(id);
    if (existing) removeAssociation(id);
    associations.set(id, {
      id, sidecarBnd, clientKey: '', clientHost: '', clientPort: 0, lastUsed: now()
    });
    bySidecar.set(sidecarKey(sidecarBnd), id);
    return true;
  }

  function removeAssociation(id) {
    const association = associations.get(id);
    if (!association) return;
    associations.delete(id);
    bySidecar.delete(sidecarKey(association.sidecarBnd));
    if (association.clientKey) byClient.delete(association.clientKey);
  }

  return {
    enabled: () => Boolean(socket),
    port: () => (socket ? socket.address().port : port),
    advertiseHost: () => advertiseHostValue,
    advertisePort: () => advertisePortValue || (socket ? socket.address().port : port),
    associationCount: () => associations.size,

    async start() {
      if (disabled) return { ok: false, error: 'udp_disabled' };
      if (socket) return { ok: true, port: socket.address().port };
      const created = createSocket();
      const bound = await new Promise((resolve) => {
        const fail = (error) => resolve({ error: error.code || error.message });
        created.once('error', fail);
        created.bind({ port, address: host }, () => {
          created.removeListener('error', fail);
          created.on('error', (error) => log.warn?.(`[aih:relay-udp] socket error: ${error.message}`));
          resolve({ ok: true });
        });
      });
      if (bound.error) {
        created.close();
        return { ok: false, error: bound.error };
      }
      socket = created;
      socket.on('message', onMessage);
      reaper = setInterval(reap, REAP_INTERVAL_MS);
      if (typeof reaper.unref === 'function') reaper.unref();
      return { ok: true, port: socket.address().port };
    },

    stop() {
      if (reaper) clearInterval(reaper);
      reaper = null;
      associations.clear();
      bySidecar.clear();
      byClient.clear();
      if (!socket) return;
      const closing = socket;
      socket = null;
      // 先摘掉 message 监听再关：否则关闭过程中到达的数据报会打到已关闭的 socket 上。
      closing.removeListener('message', onMessage);
      try { closing.close(); } catch (_error) { /* 已经关了 */ }
    },

    addAssociation,
    removeAssociation
  };
}

module.exports = {
  DEFAULT_IDLE_TIMEOUT_MS,
  REAP_INTERVAL_MS,
  createRelayUdpFront
};
