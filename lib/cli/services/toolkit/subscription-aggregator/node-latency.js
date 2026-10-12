'use strict';

const net = require('node:net');
const { isFakeIpAddress } = require('../proxy-pool/subscription-fetcher');

// 节点列表的 TCP 延迟：从服务器到节点地址建连所用的时间（不经过节点、不代表代理可用）。
// 并发建连、超时即失败；结果按 host:port 在内存里缓存几分钟，反复打开列表不重复测。
// 解析到 fake-ip（本机代理的 DNS 劫持）时，连的其实是本机代理，结果单独标出来。

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_CONCURRENCY = 16;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_TARGETS = 1000;

class NodeLatencyMeter {
  constructor(options = {}) {
    this.netConnect = options.netConnect || net.connect;
    this.now = options.now || (() => performance.now());
    this.clock = options.clock || Date.now;
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.concurrency = options.concurrency || DEFAULT_CONCURRENCY;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.cache = new Map();
  }

  measureOne(server, port) {
    return new Promise((resolve) => {
      const started = this.now();
      let resolvedAddress = '';
      const socket = this.netConnect({ host: server, port });
      const finish = (result) => {
        clearTimeout(timer);
        socket.destroy();
        resolve({ ...result, fakeIp: Boolean(resolvedAddress && isFakeIpAddress(resolvedAddress)) });
      };
      const timer = setTimeout(() => finish({ ms: null, error: 'ETIMEDOUT' }), this.timeoutMs);
      socket.once('lookup', (_error, address) => {
        resolvedAddress = String(address || '');
      });
      socket.once('connect', () => {
        resolvedAddress = resolvedAddress || socket.remoteAddress || '';
        finish({ ms: Math.round(this.now() - started) });
      });
      socket.once('error', (error) => finish({ ms: null, error: error.code || 'ECONNREFUSED' }));
    });
  }

  /** targets: [{ key, server, port }] → { [key]: { ms, error?, fakeIp, measuredAt } }；fresh=true 时忽略缓存。 */
  async measure(targets, { fresh = false } = {}) {
    const list = (Array.isArray(targets) ? targets : []).slice(0, MAX_TARGETS);
    const results = {};
    const pending = [];
    for (const target of list) {
      const cacheKey = `${String(target.server).toLowerCase()}:${Number(target.port)}`;
      const cached = this.cache.get(cacheKey);
      if (!fresh && cached && this.clock() - cached.measuredAt < this.cacheTtlMs) results[target.key] = cached;
      else pending.push({ ...target, cacheKey });
    }
    let next = 0;
    const worker = async () => {
      while (next < pending.length) {
        const target = pending[next];
        next += 1;
        const result = { ...(await this.measureOne(target.server, Number(target.port))), measuredAt: this.clock() };
        this.cache.set(target.cacheKey, result);
        results[target.key] = result;
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, pending.length) }, worker));
    // 缓存只留最近的结果，避免长期运行时无限增长。
    while (this.cache.size > MAX_TARGETS * 2) this.cache.delete(this.cache.keys().next().value);
    return results;
  }
}

module.exports = {
  NodeLatencyMeter
};
