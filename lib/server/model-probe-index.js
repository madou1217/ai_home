'use strict';

// 模型探测的增量索引：把「每个 tick 全量扫一遍账号」换成「按到期时间分桶 + 最小堆」。
//
// 10k 账号时，旧实现每次 tick 要做两遍 O(n) 扫描 + 一次 O(n log n) 排序
// （候选集 + 积压判断），约 20ms；每个 WebUI 请求/每次刷新还要再枚举一次账号集合。
// 这里把「哪些账号到期了」变成数据结构事实：
//
//   byRef:      accountRef → entry{provider, account, eligible, dueAt}
//   buckets:    dueAt → Set<accountRef>      （到期时间分桶，空桶惰性清理）
//   bucketHeap: 各个非空 dueAt 的最小堆        （O(1) 取「最近到期」）
//
// 查询 = 取堆顶桶、按桶内 ref 逐个校验（O(limit + 失效项)），不再看没到期的账号。
// 索引只在「账号集合真的变了」时重建（池重载 = state.accounts 换对象，O(1) 判定），
// 单账号探测完成只更新该 ref 的 dueAt（O(log k)）。
//
// 到期语义（与旧 listProbeCandidates 完全一致）：
//   - 从未探测（无 byAccount、无探测时刻）→ dueAt = 0，永远最先；
//   - 探测成功（含空目录）→ probedAt + 6h；
//   - 探测失败 → probedAt + 10min（退避）；
//   - 生命周期事件插队 → 不改进度表，由调用方的 priority 表按 TTL 覆盖。

const { listModelDiscoveryAccounts, listModelDiscoveryProviders } = require('./model-discovery-accounts');
const {
  listAccountModelCacheRefs,
  shouldProbeAccountModels
} = require('./provider-model-discovery');

const ACCOUNT_STALE_MS = 6 * 60 * 60 * 1000;
const ERROR_BACKOFF_MS = 10 * 60 * 1000;
// 与调度器的 PRIORITY_TTL_MS 相同；放在这里避免索引模块反向依赖调度器。
const PRIORITY_TTL_LIMIT = 10 * 60 * 1000;

/** 极简数字最小堆（只存 dueAt 值，桶内细节在 buckets 里）。 */
function createMinHeap() {
  const items = [];
  function swap(i, j) {
    const tmp = items[i];
    items[i] = items[j];
    items[j] = tmp;
  }
  function up(index) {
    let i = index;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (items[parent] <= items[i]) break;
      swap(parent, i);
      i = parent;
    }
  }
  function down(index) {
    let i = index;
    const size = items.length;
    for (;;) {
      let smallest = i;
      const left = i * 2 + 1;
      const right = left + 1;
      if (left < size && items[left] < items[smallest]) smallest = left;
      if (right < size && items[right] < items[smallest]) smallest = right;
      if (smallest === i) break;
      swap(i, smallest);
      i = smallest;
    }
  }
  return {
    size: () => items.length,
    peek: () => (items.length ? items[0] : null),
    push(value) {
      items.push(value);
      up(items.length - 1);
    },
    pop() {
      if (!items.length) return null;
      const top = items[0];
      const last = items.pop();
      if (items.length) {
        items[0] = last;
        down(0);
      }
      return top;
    },
    items
  };
}

function createProbeIndex(now = Date.now()) {
  return {
    providersRef: null,
    // provider → { arrayRef, count, refs: Set<accountRef> }
    providerStates: new Map(),
    byRef: new Map(),
    buckets: new Map(),
    bucketHeap: createMinHeap(),
    // 建立索引时缓存的 cache.updatedAt：外部（手动刷新）改了缓存时据此整体重算。
    cacheUpdatedAt: 0,
    builtAt: now
  };
}

function cacheFacts(cache, accountRef) {
  const byAccount = cache && cache.byAccount;
  const errorsByAccount = cache && cache.errorsByAccount;
  const accountUpdatedAt = cache && cache.accountUpdatedAt;
  const models = byAccount && byAccount[accountRef];
  const error = errorsByAccount && errorsByAccount[accountRef] ? String(errorsByAccount[accountRef]) : '';
  const probedAt = Number(accountUpdatedAt && accountUpdatedAt[accountRef] || 0) || 0;
  return {
    missing: !(Array.isArray(models) && models.length > 0),
    error,
    probedAt
  };
}

function computeDueAt(facts) {
  if (facts.probedAt <= 0) return 0;
  return facts.probedAt + (facts.error ? ERROR_BACKOFF_MS : ACCOUNT_STALE_MS);
}

function removeFromBucket(index, entry) {
  const set = index.buckets.get(entry.dueAt);
  if (set) {
    set.delete(entry.ref);
    // 空桶不立刻删：bucketHeap 的键可能重复入堆，惰性清理更便宜。
  }
}

function addToBucket(index, entry) {
  let set = index.buckets.get(entry.dueAt);
  if (!set) {
    set = new Set();
    index.buckets.set(entry.dueAt, set);
    index.bucketHeap.push(entry.dueAt);
  }
  set.add(entry.ref);
}

function attachEntry(index, provider, account, accountRef) {
  const entry = index.byRef.get(accountRef);
  if (entry) {
    entry.provider = provider;
    entry.account = account;
    return entry;
  }
  const created = {
    ref: accountRef,
    provider,
    account,
    dueAt: 0
  };
  index.byRef.set(accountRef, created);
  addToBucket(index, created);
  return created;
}

function removeEntry(index, accountRef) {
  const entry = index.byRef.get(accountRef);
  if (!entry) return;
  removeFromBucket(index, entry);
  index.byRef.delete(accountRef);
}

// 单个 provider 的账号集合重建：只在「池重载 / 家族账号列表变化」时发生。
function rebuildProvider(index, provider, accounts, cache) {
  const state = index.providerStates.get(provider);
  const nextRefs = new Set();
  const eligibleAccounts = [];
  (Array.isArray(accounts) ? accounts : []).forEach((account) => {
    if (!shouldProbeAccountModels(provider, account)) return;
    const accountRef = listAccountModelCacheRefs(provider, account)[0] || '';
    if (!accountRef) return;
    nextRefs.add(accountRef);
    eligibleAccounts.push({ account, accountRef });
  });
  if (state) {
    state.refs.forEach((accountRef) => {
      if (!nextRefs.has(accountRef)) removeEntry(index, accountRef);
    });
  }
  eligibleAccounts.forEach(({ account, accountRef }) => {
    const entry = attachEntry(index, provider, account, accountRef);
    const dueAt = computeDueAt(cacheFacts(cache, accountRef));
    if (entry.dueAt !== dueAt) {
      removeFromBucket(index, entry);
      entry.dueAt = dueAt;
      addToBucket(index, entry);
    }
  });
  index.providerStates.set(provider, {
    arrayRef: accounts,
    count: Array.isArray(accounts) ? accounts.length : 0,
    refs: nextRefs
  });
}

function rebuildAll(state, deps, now) {
  const next = createProbeIndex(now);
  const cache = state && state.webUiModelsCache || {};
  listModelDiscoveryProviders(state, deps).forEach((provider) => {
    rebuildProvider(next, provider, listModelDiscoveryAccounts(state, provider, deps), cache);
  });
  next.providersRef = state && state.accounts;
  next.cacheUpdatedAt = Number(cache.updatedAt || 0);
  next.builtAt = now;
  return next;
}

/**
 * 确保索引与当前账号集合一致；返回（可能新建的）索引。
 * 常规路径只做 O(#providers) 的数组身份比较。
 */
function syncProbeIndex(state, index, deps, now = Date.now()) {
  if (!state) return index || createProbeIndex(now);
  if (!index) return rebuildAll(state, deps, now);
  // 池重载会整体替换 state.accounts：O(1) 判定，整体重建。
  if (state.accounts !== index.providersRef) {
    return rebuildAll(state, deps, now);
  }
  // 家族账号（CodeBuddy/WorkBuddy）来自凭据库，由 model-discovery-accounts 的
  // 短 TTL 缓存生成；列表变化会换成新数组，这里按 provider 就地重捆。
  listModelDiscoveryProviders(state, deps).forEach((provider) => {
    const accounts = listModelDiscoveryAccounts(state, provider, deps);
    const previous = index.providerStates.get(provider);
    if (previous && previous.arrayRef === accounts && previous.count === accounts.length) return;
    rebuildProvider(index, provider, accounts, state.webUiModelsCache || {});
  });
  // 外部刷新（手动/请求触发）改了缓存：到期时间可能全变，整体重算一次。
  // 调度器自己的探测完成后会 refreshProbeIndexRefs 并把 cacheUpdatedAt 对齐，
  // 所以这里只在「别人改了缓存」时触发。
  const cache = state.webUiModelsCache || {};
  const cacheUpdatedAt = Number(cache.updatedAt || 0);
  if (cacheUpdatedAt !== index.cacheUpdatedAt) {
    index.byRef.forEach((entry) => {
      const dueAt = computeDueAt(cacheFacts(cache, entry.ref));
      if (entry.dueAt !== dueAt) {
        removeFromBucket(index, entry);
        entry.dueAt = dueAt;
        addToBucket(index, entry);
      }
    });
    index.cacheUpdatedAt = cacheUpdatedAt;
  }
  return index;
}

/** 探测完成后只更新这些 ref 的到期时间（以及账号对象引用）。 */
function refreshProbeIndexRefs(state, index, refs, now = Date.now()) {
  if (!state || !index) return index;
  const cache = state.webUiModelsCache || {};
  (Array.isArray(refs) ? refs : []).forEach((accountRef) => {
    const entry = index.byRef.get(accountRef);
    if (!entry) return;
    const dueAt = computeDueAt(cacheFacts(cache, accountRef));
    if (entry.dueAt !== dueAt) {
      removeFromBucket(index, entry);
      entry.dueAt = dueAt;
      addToBucket(index, entry);
    }
  });
  index.cacheUpdatedAt = Number(cache.updatedAt || 0);
  return index;
}

function isPriorityActive(priority, accountRef, now) {
  if (!priority) return 0;
  const at = typeof priority.get === 'function'
    ? Number(priority.get(accountRef) || 0)
    : Number(priority[accountRef] || 0);
  if (!(at > 0)) return 0;
  return now - at <= PRIORITY_TTL_LIMIT ? at : 0;
}

function makeCandidate(state, entry, now, priorityAt) {
  const cache = state && state.webUiModelsCache || {};
  const facts = cacheFacts(cache, entry.ref);
  return {
    provider: entry.provider,
    account: entry.account,
    accountRef: entry.ref,
    missing: facts.missing,
    error: Boolean(facts.error),
    age: Math.max(0, now - facts.probedAt),
    priority: priorityAt > 0
  };
}

/** 丢弃空桶/全失效桶，返回下一个「真有到期账号」的 dueAt（不移除有内容的桶）。 */
function peekDueBucket(index, now) {
  for (;;) {
    const key = index.bucketHeap.peek();
    if (key === null || key > now) return null;
    const set = index.buckets.get(key);
    if (!set || set.size === 0) {
      index.bucketHeap.pop();
      if (set) index.buckets.delete(key);
      continue;
    }
    return key;
  }
}

/** 取出一个到期桶（从堆中移除；调用方负责把仍有内容的桶放回，见 listDueCandidates）。 */
function popDueBucket(index, now) {
  const key = peekDueBucket(index, now);
  if (key === null) return null;
  index.bucketHeap.pop();
  return key;
}

/**
 * 取到期候选（priority 覆盖 TTL 内的插队）。
 * @param {number} limit 最多返回几个；Infinity 表示全部到期项。
 */
function listDueCandidates(state, index, priority, now, limit = Infinity) {
  const out = [];
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : Infinity;
  const prioritized = new Set();
  // 1. 插队项：数量等于「最近 10 分钟内有生命周期事件」的账号，通常个位数。
  if (priority && typeof priority.forEach === 'function') {
    priority.forEach((value, accountRef) => {
      if (out.length >= max) return;
      const at = isPriorityActive(priority, accountRef, now);
      if (!at) return;
      const entry = index.byRef.get(accountRef);
      if (!entry) return;
      prioritized.add(accountRef);
      out.push(makeCandidate(state, entry, now, at));
    });
  }
  if (out.length >= max) return sortCandidates(out);

  // 2. 正常到期项：按 dueAt 升序逐个取桶。桶从堆里弹出、扫完再放回，
  //    保证「桶里的账号全部被插队覆盖」时不会原地死循环。
  const restore = [];
  try {
    while (out.length < max) {
      const key = popDueBucket(index, now);
      if (key === null) break;
      const set = index.buckets.get(key);
      if (!set) continue;
      for (const accountRef of Array.from(set)) {
        const entry = index.byRef.get(accountRef);
        if (!entry || entry.dueAt !== key) {
          set.delete(accountRef);
          continue;
        }
        if (prioritized.has(accountRef)) continue;
        if (out.length >= max) break;
        out.push(makeCandidate(state, entry, now, 0));
      }
      if (set.size === 0) index.buckets.delete(key);
      else restore.push(key);
    }
  } finally {
    restore.forEach((key) => index.bucketHeap.push(key));
  }
  return sortCandidates(out);
}

// 与旧实现的排序保持一致：插队 > 从未探测 > 探测失败 > 最久未探测。
function sortCandidates(items) {
  return items.sort((left, right) => (
    Number(right.priority) - Number(left.priority)
    || Number(right.missing) - Number(left.missing)
    || Number(right.error) - Number(left.error)
    || Number(right.age) - Number(left.age)
  ));
}

function hasDueCandidates(state, index, priority, now) {
  if (priority && typeof priority.forEach === 'function') {
    let found = false;
    priority.forEach((value, accountRef) => {
      if (found) return;
      if (isPriorityActive(priority, accountRef, now) && index.byRef.has(accountRef)) found = true;
    });
    if (found) return true;
  }
  return peekDueBucket(index, now) !== null;
}

module.exports = {
  ACCOUNT_STALE_MS,
  ERROR_BACKOFF_MS,
  createProbeIndex,
  syncProbeIndex,
  refreshProbeIndexRefs,
  listDueCandidates,
  hasDueCandidates,
  peekDueBucket,
  __private: {
    cacheFacts,
    computeDueAt,
    createMinHeap
  }
};
