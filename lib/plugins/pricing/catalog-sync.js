'use strict';

// 从插件 `pricing.catalog` 收集价格快照，交给 catalog-source-store 做「离线快照 + 人工复核」。
//
// 插件只返回 quotes / source / generatedAt；是否生效由宿主决定：
//   * 首次来源 → 直接写快照；
//   * 价格变化 → 写 pending + 复核队列，保留旧快照继续计费；
//   * 插件失败 → 什么都不写（旧快照不被覆盖）。
//
// 自动刷新只在插件代次变化时触发；另有低频定时器（默认每天一次）重新采集，
// 采集只发生在同步任务里，绝不在 /v1 请求路径上抓官方页面。
// 采集间隔不写入任何新的 AIH_* 环境变量。

const { createPricingCatalogSourceStore } = require('../../usage/pricing/catalog-source-store');

const DEFAULT_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function invokeValue(result) {
  if (result && Object.prototype.hasOwnProperty.call(result, 'value')) return result.value;
  return result;
}

function createPluginPricingSync(options = {}) {
  const runtime = options.runtime || null;
  const store = options.store || null;
  const fs = options.fs || require('node:fs');
  const aiHomeDir = normalizeText(options.aiHomeDir);
  const refreshIntervalMs = Math.max(60_000, Number(options.refreshIntervalMs) || DEFAULT_REFRESH_INTERVAL_MS);
  const timers = options.timers || { setTimeout, clearTimeout, clearInterval, setInterval };
  const log = typeof options.log === 'function' ? options.log : () => {};
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const audit = options.audit && typeof options.audit.append === 'function' ? options.audit : null;
  let timer = null;
  let running = null;
  let runningCommunity = false;
  let runtimeChangePending = false;
  let lastReport = null;
  let cachedStore = store;

  function auditPricing(event, details = {}) {
    try { audit?.append(event, details); } catch (_error) { /* 审计失败不影响采集 */ }
  }

  function sourceStore() {
    if (cachedStore) return cachedStore;
    if (!aiHomeDir) return null;
    cachedStore = createPricingCatalogSourceStore({ fs, aiHomeDir, now });
    return cachedStore;
  }

  function normalizeResult(result, item) {
    const value = Array.isArray(result) ? { quotes: result } : (result && typeof result === 'object' ? result : {});
    const source = value.source && typeof value.source === 'object' ? { ...value.source } : {};
    const sourceId = normalizeText(source.id) || `plugin:${item.instanceId}:${item.id}`;
    return {
      sourceId,
      source: {
        ...source,
        id: sourceId,
        kind: normalizeText(source.kind) || 'community'
      },
      quotes: Array.isArray(value.quotes) ? value.quotes : [],
      fetchedAt: value.generatedAt || source.fetchedAt || new Date(now()).toISOString()
    };
  }

  async function collectOnce(collectOptions = {}) {
    const catalogStore = sourceStore();
    if (!catalogStore) {
      return { ok: false, reason: 'pricing_source_store_unavailable', sources: [], reviews: [] };
    }
    const lease = runtime && typeof runtime.acquire === 'function' ? runtime.acquire() : null;
    const attempts = [];
    const applied = [];
    const reviews = [];
    const community = [];
    try {
      if (lease) {
        const chain = lease.snapshot.byCapability.get('pricing.catalog') || [];
        for (const item of chain) {
          try {
            const result = invokeValue(await runtime.invoke(item.id, {
              schemaVersion: 1,
              kind: 'catalog',
              now: new Date(now()).toISOString()
            }, { generation: lease.generation, timeoutMs: Number(options.timeoutMs) || 15_000 }));
            const normalized = normalizeResult(result, item);
            const outcome = catalogStore.applySnapshot({
              sourceId: normalized.sourceId,
              source: normalized.source,
              quotes: normalized.quotes,
              fetchedAt: normalized.fetchedAt,
              requireReview: true
            });
            attempts.push({ id: item.id, ok: true, quotes: normalized.quotes.length });
            applied.push({ sourceId: normalized.sourceId, instanceId: item.instanceId, ...outcome });
            reviews.push(...(outcome.reviews || []));
          } catch (error) {
            // 失败保留旧快照；只记录 attempt，供 doctor / 管理面观察。
            attempts.push({
              id: item.id,
              ok: false,
              error: normalizeText(error && error.code) || 'pricing_catalog_failed',
              detail: normalizeText(error && error.message)
            });
            log({ event: 'pricing_catalog_failed', contributionId: item.id, message: error && error.message });
          }
        }
      }
      // 社区兜底与插件无关：没有安装任何插件时也要能采集 LiteLLM / OpenRouter。
      if (collectOptions.community === true && typeof options.communityRefresh === 'function') {
        try {
          const results = await options.communityRefresh({ store: catalogStore });
          for (const item of Array.isArray(results) ? results : []) {
            community.push(item);
            if (item && item.ok === false) {
              attempts.push({ id: item.sourceId || 'community', ok: false, error: normalizeText(item.error) || 'community_refresh_failed' });
            } else {
              attempts.push({ id: item.sourceId || 'community', ok: true, quotes: Number(item.quoteCount) || 0 });
              if (item && item.applied === true) applied.push(item);
            }
          }
        } catch (error) {
          attempts.push({ id: 'community', ok: false, error: normalizeText(error && error.code) || 'community_refresh_failed' });
        }
      }
      if (typeof options.onApplied === 'function' && applied.some((item) => item.applied === true)) {
        try { await options.onApplied({ report: { sources: applied } }); } catch (_error) { /* 计费刷新由宿主兜底 */ }
      }
      const report = {
        ok: attempts.every((attempt) => attempt.ok),
        at: new Date(now()).toISOString(),
        runtimeActive: Boolean(lease),
        attempts,
        sources: applied,
        reviews,
        community
      };
      lastReport = report;
      if (applied.some((item) => item.applied === true)) {
        auditPricing('pricing_apply', {
          sources: applied.filter((item) => item.applied === true).map((item) => item.sourceId),
          reviews: reviews.length
        });
      }
      if (reviews.length) {
        auditPricing('pricing_review_queued', {
          sources: Array.from(new Set(reviews.map((item) => item.sourceId).filter(Boolean))),
          reviews: reviews.length
        });
      }
      return report;
    } finally {
      if (lease) lease.release();
    }
  }

  function syncNow(syncOptions = {}) {
    const wantsCommunity = syncOptions.community === true;
    if (running) {
      // 正在跑的采集代次没有包含社区源时，等它结束后补一次，避免显式刷新被吞掉。
      if (wantsCommunity && !runningCommunity) return running.then(() => syncNow(syncOptions));
      // 代次变更可能在首轮采集进行中到达（此时运行时还没发布完）：
      // 记一个 pending，等当前采集结束后再采一次插件来源。
      if (syncOptions.runtimeChange === true) {
        runtimeChangePending = true;
        return running;
      }
      return running;
    }
    runningCommunity = wantsCommunity;
    running = collectOnce(syncOptions).finally(() => {
      running = null;
      runningCommunity = false;
      if (runtimeChangePending) {
        runtimeChangePending = false;
        void syncNow({ runtimeChange: true });
      }
    });
    return running;
  }

  function start() {
    if (timer) return;
    timer = timers.setInterval(() => { void syncNow({ community: true }); }, refreshIntervalMs);
    timer?.unref?.();
    // 代次切换后重新采集：插件升级/启停不应该等到下一个每日窗口。
    if (runtime && typeof runtime.onChange === 'function') {
      unsubscribe = runtime.onChange(() => {
        // 激活过程中快照尚未切换完成时 acquire 会返回 null，下一次通知会补上；
        // 这里只做去抖，不阻塞发布队列。
        if (debounce) timers.clearTimeout?.(debounce);
        debounce = timers.setTimeout(() => { debounce = null; void syncNow({ runtimeChange: true }); }, 300);
        debounce?.unref?.();
      });
    }
    // 启动采集不 await：社区源网络慢也不阻塞 server 起来，插件来源仍由代次通知补采。
    void syncNow({ community: true });
  }

  let unsubscribe = null;
  let debounce = null;

  function stop() {
    if (timer) timers.clearInterval(timer);
    timer = null;
    if (debounce) timers.clearTimeout?.(debounce);
    debounce = null;
    if (typeof unsubscribe === 'function') unsubscribe();
    unsubscribe = null;
  }

  return { collectOnce, lastReport: () => lastReport, start, stop, syncNow, store: sourceStore };
}

module.exports = {
  DEFAULT_REFRESH_INTERVAL_MS,
  createPluginPricingSync
};
