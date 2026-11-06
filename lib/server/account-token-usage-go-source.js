'use strict';

// 账号行 token 用量的 **Go 优先读取层**（缓存 + 降级判定）。
//
// 为什么必须缓存，而不是每行一次请求：
//   账号页每次重建列表都会对每个账号调用 readAccountTokenUsage。43 个账号就是 43 行，
//   如果每行都向 Go 发一次 HTTP，一次列表重建就是 43 次请求；而页面会轮询/SSE 重建，
//   同一秒内能打出上百个请求，把本地管理接口放大成账号页的瓶颈。
//   所以这里按 accountRef 缓存 60s（TTL）：一次重建最多每账号一次，且只在缓存过期后
//   才向 Go 拉；列表重建本身不再产生请求。
//
// 失败策略：
//   - 保留上一次成功的值（便于观察与下一次成功前的对照），但 available=false 期间不采用；
//   - 调用方看到 source='node' 后走 Node 原有的「缓存 + pending 增量」逻辑，行为不变；
//   - 失败后 30s 才重试，避免 Go 抖动时每行每轮都重打。
//
// 形状：Go 的 data 已经是 Node 的字段名（day/week/month/total + models[].*CostUsd），
// 这里再走一遍 normalizeAccountTokenUsageValue，保证排序、零模型过滤、成本 null
// 与 Node 计算出的行完全一致；绝不把未知成本补成 0。

const {
  ACCOUNT_TOKEN_USAGE_DIMENSIONS,
  normalizeAccountTokenUsageValue
} = require('../usage/account-token-usage');

const GO_TOKEN_USAGE_TTL_MS = 60_000;
const GO_TOKEN_USAGE_RETRY_MS = 30_000;

// Go host 不可用（未装配 / 未启用 / 没有该方法）时返回 null，调用方直接走 Node 路径，
// 不建缓存条目，也不发请求。
function resolveGoTokenUsageHost(goHost) {
  if (!goHost || typeof goHost.getAccountTokenUsage !== 'function') return null;
  if (typeof goHost.isEnabled === 'function' && !goHost.isEnabled()) return null;
  return goHost;
}

// 只取 Node 账号行需要的字段；Go 的 from_ms/to_ms/cost_known 是端点诊断信息，
// 不进账号行。成本字段原样保留 null。
function normalizeGoAccountTokenUsage(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return normalizeAccountTokenUsageValue({
    day: data.day,
    week: data.week,
    month: data.month,
    total: data.total,
    models: Array.isArray(data.models) ? data.models : []
  }, ACCOUNT_TOKEN_USAGE_DIMENSIONS);
}

function notifyRefresh(options, accountRef, ok) {
  if (typeof options.onRefresh !== 'function') return;
  try {
    options.onRefresh(accountRef, ok);
  } catch (_error) {
    // 刷新回调只负责把新值推给账号行；它失败不能影响缓存状态或后续读取。
  }
}

function scheduleRefresh(host, accountRef, entry, options) {
  if (entry.inFlight) return entry.inFlight;
  const now = Date.now();
  if (entry.available) {
    if (Number(entry.expiresAt) > now) return null;
  } else if (now < Number(entry.retryAt)) {
    return null;
  }

  const refresh = Promise.resolve()
    .then(() => host.getAccountTokenUsage(accountRef))
    .then(
      (response) => {
        const value = response && response.ok === true
          ? normalizeGoAccountTokenUsage(response.data)
          : null;
        const finishedAt = Date.now();
        if (value) {
          entry.value = value;
          entry.available = true;
          entry.expiresAt = finishedAt + GO_TOKEN_USAGE_TTL_MS;
          entry.retryAt = 0;
          return value;
        }
        // 请求成功但数据不可用（账号尚未进 Go / 形状异常）也按失败处理：
        // 让调用方继续用 Node 计算，而不是把空结果当成「用量为 0」。
        entry.available = false;
        entry.retryAt = finishedAt + GO_TOKEN_USAGE_RETRY_MS;
        return null;
      },
      () => {
        entry.available = false;
        entry.retryAt = Date.now() + GO_TOKEN_USAGE_RETRY_MS;
        return null;
      }
    )
    .then((value) => {
      // 先清 inFlight 再通知：回调里会重新读缓存，必须看到已经落定的 entry。
      entry.inFlight = null;
      notifyRefresh(options, accountRef, Boolean(value));
      return value;
    });

  entry.inFlight = refresh;
  return refresh;
}

// 读取一个账号的 Go 用量。
// 返回 { value, source, refresh }：
//   value  —— 归一后的用量（不可用时 null）
//   source —— 'go' | 'node'，账号行直接透出为 tokenUsageSource
//   refresh —— 本次触发的后台请求（未触发时为 null），测试用它等待落定
function readGoAccountTokenUsage(liveState, accountRef, options = {}) {
  const host = resolveGoTokenUsageHost(options.goHost);
  const ref = String(accountRef || '').trim();
  const cache = liveState && liveState.goTokenUsage;
  if (!host || !ref || !(cache instanceof Map)) {
    return { value: null, source: 'node', refresh: null };
  }

  let entry = cache.get(ref);
  if (!entry) {
    entry = { value: null, available: false, expiresAt: 0, retryAt: 0, inFlight: null };
    cache.set(ref, entry);
  }

  const refresh = scheduleRefresh(host, ref, entry, options);
  if (entry.available && entry.value) {
    return { value: entry.value, source: 'go', refresh };
  }
  return { value: null, source: 'node', refresh };
}

module.exports = {
  GO_TOKEN_USAGE_RETRY_MS,
  GO_TOKEN_USAGE_TTL_MS,
  normalizeGoAccountTokenUsage,
  readGoAccountTokenUsage,
  resolveGoTokenUsageHost
};
