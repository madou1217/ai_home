'use strict';

const net = require('node:net');
const { isFakeIpAddress } = require('../proxy-pool/subscription-fetcher');

// 节点列表的 TCP 延迟：从服务器到节点地址建连所用的时间（不经过节点、不代表代理可用）。
// 并发建连、超时即失败；结果按 host:port 在内存里缓存几分钟，反复打开列表不重复测。
// 解析到 fake-ip（本机代理的 DNS 劫持）时，连的其实是本机代理，结果单独标出来。

const DEFAULT_TIMEOUT_MS = 3000;
// 并发（2026-10-21）：2w 节点时 16 并发 × 3s 超时要 62 分钟，等于测不完。建连是纯出站、
// 对端只做一次 TCP 握手，提到 64 并发；上限仍保留，避免一次开太多 fd。
const DEFAULT_CONCURRENCY = 64;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
// 单次最多测多少个：不再是「超过就丢弃」（2w 节点时用户只会看到前 1000 个的结果），
// 而是分片上限 —— 调用方按 sourceId 分批调，每批都在这个范围内。
const MAX_TARGETS = 4000;

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
  /**
   * 测一批目标的 TCP 建连耗时。并发执行、边测边填（`onResult` 每完成一个就回调一次，
   * 界面据此增量刷新，不用等整批测完）。
   * targets: [{ key, server, port }] → { [key]: { ms, error?, fakeIp, measuredAt } }；fresh=true 时忽略缓存。
   */
  async measure(targets, { fresh = false, onResult = null } = {}) {
    const list = (Array.isArray(targets) ? targets : []).slice(0, MAX_TARGETS);
    const results = {};
    const pending = [];
    for (const target of list) {
      const cacheKey = `${String(target.server).toLowerCase()}:${Number(target.port)}`;
      const cached = this.cache.get(cacheKey);
      if (!fresh && cached && this.clock() - cached.measuredAt < this.cacheTtlMs) {
        results[target.key] = cached;
        if (onResult) onResult(target.key, cached);
      } else {
        pending.push({ ...target, cacheKey });
      }
    }
    let next = 0;
    const worker = async () => {
      while (next < pending.length) {
        const target = pending[next];
        next += 1;
        const result = { ...(await this.measureOne(target.server, Number(target.port))), measuredAt: this.clock() };
        this.cache.set(target.cacheKey, result);
        results[target.key] = result;
        if (onResult) {
          try { onResult(target.key, result); } catch (_error) { /* 进度回调出错不影响测量 */ }
        }
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
