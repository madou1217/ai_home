'use strict';
const { requiresModelCooldown } = require('./model-cooldown-policy');
const { selectionWeight, canPreferAccount, preferAlternatives } = require('./account-selection-load');
const { evaluateAccountUsageGate } = require('./account-usage-gate');
const { isSoftRuntimeStatus } = require('../account/runtime-view');

const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');
const {
  allowsLiveRuntimeRecheck,
  isRoutingBlockActive,
  replacePersistedAccountRuntimeState,
  deriveAccountRuntimeStatus,
  getAccountModelCooldownUntil
} = require('./account-runtime-state');

const DEFAULT_SESSION_AFFINITY_TTL_MS = 30 * 60 * 1000;
const DEFAULT_SESSION_AFFINITY_MAX = 10_000;

function ensureSessionAffinity(state) {
  if (!state || typeof state !== 'object') return null;
  if (!state.sessionAffinity || typeof state.sessionAffinity !== 'object') {
    state.sessionAffinity = {
      ttlMs: DEFAULT_SESSION_AFFINITY_TTL_MS,
      maxEntries: DEFAULT_SESSION_AFFINITY_MAX
    };
  }
  SUPPORTED_SERVER_PROVIDERS.forEach((provider) => {
    if (!(state.sessionAffinity[provider] instanceof Map)) state.sessionAffinity[provider] = new Map();
  });
  if (!Number.isFinite(Number(state.sessionAffinity.ttlMs)) || Number(state.sessionAffinity.ttlMs) <= 0) {
    state.sessionAffinity.ttlMs = DEFAULT_SESSION_AFFINITY_TTL_MS;
  }
  if (!Number.isFinite(Number(state.sessionAffinity.maxEntries)) || Number(state.sessionAffinity.maxEntries) <= 0) {
    state.sessionAffinity.maxEntries = DEFAULT_SESSION_AFFINITY_MAX;
  }
  return state.sessionAffinity;
}

function purgeSessionMap(sessionMap, now) {
  if (!(sessionMap instanceof Map)) return;
  sessionMap.forEach((entry, key) => {
    if (!entry || !Number.isFinite(Number(entry.expiresAt)) || Number(entry.expiresAt) <= now) {
      sessionMap.delete(key);
    }
  });
}

function pickWeightedRandomAccount(available, options = {}) {
  if (!Array.isArray(available) || available.length === 0) return null;
  const weights = available.map(account => selectionWeight(account, options.accountActivity, options.provider));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!Number.isFinite(total) || total <= 0) {
    return available[Math.floor(Math.random() * available.length)];
  }
  let offset = Math.random() * total;
  for (let i = 0; i < available.length; i += 1) {
    offset -= weights[i];
    if (offset <= 0) return available[i];
  }
  return available[available.length - 1];
}

function syncPersistedAccountState(account, accountStateIndex) {
  if (!account) return false;
  if (!accountStateIndex || typeof accountStateIndex.getAccountState !== 'function') return true;
  const accountRef = String(account.accountRef || '').trim();
  if (!accountRef) return false;
  const row = accountStateIndex.getAccountState(accountRef);
  // CLI changes can leave an old account/key in the server's in-memory pool.
  // Durable status must win over that snapshot, including a deleted row.
  if (!row || row.status !== 'up') return false;
  if (Object.prototype.hasOwnProperty.call(row, 'runtimeState')) {
    replacePersistedAccountRuntimeState(account, row.runtimeState);
  }
  return true;
}

function resolveCursorState(state, options = {}) {
  if (options.cursorState && typeof options.cursorState === 'object') return options.cursorState;
  if (state && state.cursors && typeof state.cursors === 'object') return state.cursors;
  return state || {};
}

function resolveSelectionStrategy(state, options = {}) {
  return String(
    options.strategy
    || state && state.strategy
    || 'round-robin'
  ).trim().toLowerCase();
}

// createEligibilityEvaluator 把「账号当前是否可被选中」的全部硬条件收敛成一个函数。
//
// 返回 (account, { ignoreModelCooldown }) => reason：空串表示合格，非空是稳定原因码。
// 选号（chooseServerAccount）与只读诊断（/v0/webui/routing/weights）共用同一份判断，
// 避免出现「页面显示可用、实际却不选」的漂移。
//
// 注意：syncPersistedAccountState 会同步持久化运行态，是有副作用的；本函数保证一次
// 评估里每个账号只同步一次，调用方不要对同一账号重复调用。
function createEligibilityEvaluator(state, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const provider = String(options.provider || '').trim().toLowerCase();
  const accountStateIndex = options.accountStateIndex || null;
  const excludedRefsInput = options.excludeAccountRefs;
  const excludedRefs = excludedRefsInput instanceof Set
    ? excludedRefsInput
    : new Set(Array.isArray(excludedRefsInput) ? excludedRefsInput : []);
  const model = String(options.model || '').trim();
  const activity = options.accountActivity || state?.accountActivity;
  // Last-resort override: bypass ONLY the soft per-(account, model) cooldown so a
  // request can still be served when every candidate is merely model-cooled
  // (rather than 503'ing the client). Account-level/hard blocks below — runtime
  // status (auth_invalid etc.), account-wide cooldownUntil, schedulable status,
  // exhausted quota — are NOT bypassed.
  const allowModelCooled = Boolean(options.allowModelCooled);
  const modelKey = model.toLowerCase();

  return function evaluateEligibility(account, { ignoreModelCooldown = false } = {}) {
    // 先看内存里的 (账号, 模型) 冷却：O(1) 哈希查找，命中就不碰 DB。
    // 1 万账号里 8000 个对该模型已冷却时，原先每次选号都要对这 8000 个各做一次 SQLite 读 +
    // runtime_state JSON 解析（基准 ~20ms/请求），而它们注定被下面的冷却判定拒掉。冷却由门禁
    // 同步写进池账号对象（observeFailure → 内存 + 事件持久化），所以内存就是即时的屏蔽依据。
    // 放行条件与下面两处冷却判定一致：严格冷却（真实限流/额度）永远拦；软冷却只在
    // allowModelCooled / ignoreModelCooldown 时放行，这时仍走完整同步。
    if (model && account && account.modelCooldowns) {
      const cooledUntil = getAccountModelCooldownUntil(account, model, now);
      if (cooledUntil > now) {
        const strict = requiresModelCooldown(account.modelFailureStreaks?.[modelKey]);
        if (strict || (!ignoreModelCooldown && !allowModelCooled)) return 'model_cooldown';
      }
    }
    if (!syncPersistedAccountState(account, accountStateIndex)) return 'account_state_unavailable';
    const runtimeStatus = deriveAccountRuntimeStatus(account, now);
    // 具体状态（auth_invalid / rate_limited / cooling_down …）直接带进原因码，
    // 诊断页可以按状态分别展示，不用再猜「运行态不可用」是哪一种。
    //
    // 软冷却钉选探测：v1-router 判定「会话绑定的账号只有软冷却、且全池没有健康替代」
    // 时会传 allowRuntimeCooledAccountRef。只对这一个账号放行 rate_limited /
    // upstream_error 这类猜测冷却，让它真打一次上游；硬状态（登录/额度/账单/权限）
    // 不放行，试也不会成功。
    if (runtimeStatus.status !== 'healthy') {
      const allowRef = String(options.allowRuntimeCooledAccountRef || '').trim();
      const softProbe = Boolean(allowRef)
        && allowRef === String(account && account.accountRef || '')
        && isSoftRuntimeStatus(runtimeStatus.status);
      if (!softProbe) return 'runtime_' + runtimeStatus.status;
    }
    // A routing block past its recheck time (billing / permission / shared quota)
    // opens one account-wide probe request. Idle sockets do not count. Success
    // clears the block, a repeated refusal re-arms it, and a fresh quota snapshot
    // may clear a quota block first (the usage gate below still applies).
    const routingBlock = account.routingBlock;
    if (routingBlock && !isRoutingBlockActive(routingBlock, now)
        && activity?.selectionLoad?.(provider, account.accountRef).inFlight > 0) return 'routing_block_probe_in_flight';
    if (now < Number(account && account.cooldownUntil || 0)) return 'account_cooldown';
    const modelFailure = account.modelFailureStreaks?.[String(model).toLowerCase()];
    if (requiresModelCooldown(modelFailure) && model && getAccountModelCooldownUntil(account, model, now) > now) return 'model_cooldown';
    // Capacity cooldown expiry opens a single recovery attempt, not a herd of
    // requests. Successful inference clears the streak; failure closes it again.
    if (modelFailure?.kind === 'model_capacity_unavailable'
        && activity?.selectionLoad?.(provider, account.accountRef, model).modelInFlight > 0) return 'model_capacity_recovery_in_flight';
    // Per-(account, model) cooldown: skip this account only for the requested
    // model; it remains eligible for its other (non-cooled) models.
    if (!ignoreModelCooldown && !allowModelCooled && model && getAccountModelCooldownUntil(account, model, now) > now) return 'model_cooldown';
    // Runtime status was re-evaluated above. A pool snapshot taken before a
    // timed block expired must not keep that account excluded until a reload.
    if (account && !allowsLiveRuntimeRecheck(account.schedulableStatus)) return 'runtime_blocked';
    if (account && !account.apiKeyMode) {
      const pct = account.remainingPct;
      if (pct != null && pct !== '' && Number.isFinite(Number(pct)) && Number(pct) <= 0) return 'quota_exhausted';
    }
    // 额度门禁（见 account-usage-gate）：按最新用量快照与后台切换阈值判定，人工启用不绕过。
    // 账号对象上的 remainingPct 只是加载池时的值（部分 loader 根本不填），不能单独作数。
    if (!evaluateAccountUsageGate(account, model).schedulable) return 'usage_gate';
    const accountRef = String(account && account.accountRef || '');
    if (accountRef && excludedRefs.has(accountRef)) return 'excluded_by_request';
    return '';
  };
}

function chooseServerAccount(accounts, state, cursorKey = 'cursor', options = {}) {
  if (!Array.isArray(accounts) || accounts.length === 0) return null;
  const now = Date.now();
  const provider = String(options.provider || '').trim().toLowerCase();
  const activity = options.accountActivity || state?.accountActivity;
  // 选号与诊断共用同一份资格判断；evaluator 内部会按需同步持久化运行态。
  const evaluateEligibility = createEligibilityEvaluator(state, {
    ...options,
    provider,
    now,
    accountActivity: activity
  });
  const available = accounts.filter((account) => !evaluateEligibility(account));
  if (available.length === 0) return null;
  const canPrefer = account => canPreferAccount(account, available, activity, provider);

  const sessionKey = String(options.sessionKey || '').trim();
  const affinity = sessionKey ? ensureSessionAffinity(state) : null;
  const affinityMap = affinity && provider && affinity[provider] instanceof Map ? affinity[provider] : null;
  let releasedPreference = null;

  if (affinityMap && sessionKey) {
    purgeSessionMap(affinityMap, now);
    const bound = affinityMap.get(sessionKey);
    if (bound && String(bound.accountRef || '').trim()) {
      const hit = available.find((account) => String(account.accountRef || '') === String(bound.accountRef));
      if (hit && canPrefer(hit)) {
        bound.expiresAt = now + Number(affinity.ttlMs);
        affinityMap.set(sessionKey, bound);
        return hit;
      }
      if (hit) releasedPreference = hit;
      // 携带加密思考链（encrypted_content / previous_response_id）的请求换号必然
      // 400：绑定账号只要硬条件仍健康，仅被（账号,模型）软冷却挡住时也硬性优先它，
      // 软冷却放行语义与 allowModelCooled 一致，但只作用于这一个绑定账号。
      if (options.preserveEncryptedReasoningAffinity) {
        const stickyHit = accounts.find(
          (account) => String(account && account.accountRef || '') === String(bound.accountRef)
        );
        if (stickyHit && canPrefer(stickyHit) && !evaluateEligibility(stickyHit, { ignoreModelCooldown: true })) {
          bound.expiresAt = now + Number(affinity.ttlMs);
          affinityMap.set(sessionKey, bound);
          return stickyHit;
        }
      }
      affinityMap.delete(sessionKey);
    }
  }

  // 偏好顺序：插件给出的有序偏好（只会是本次候选的子集）→ 默认账号。都在会话亲和之后：亲和优先。
  const preferredRefs = [
    ...(Array.isArray(options.preferredAccountRefs) ? options.preferredAccountRefs : []),
    String(options.preferredAccountRef || '').trim()
  ].map((ref) => String(ref || '').trim()).filter(Boolean);
  let picked = null;
  for (const ref of preferredRefs) {
    picked = available.find((account) => String(account && account.accountRef || '').trim() === ref) || null;
    if (picked && canPrefer(picked)) break;
    if (picked) releasedPreference = picked;
    picked = null;
  }
  // 定向回退偏好（如 OAuth 账号 auth_invalid 后偏好 api-key）：排序偏好而非硬过滤，
  // 只在 healthy 候选内收敛，没有匹配账号时退回完整可用池，冷却/health 语义不变。
  const preferAuthType = String(options.preferAuthType || '').trim().toLowerCase();
  let candidates = preferAlternatives(releasedPreference, available, activity, provider);
  if (!picked && preferAuthType) {
    const matching = candidates.filter(
      (account) => preferAuthType === 'api-key'
        ? Boolean(account && (account.apiKeyMode || account.authType === 'api-key'))
        : String(account && account.authType || '').trim().toLowerCase() === preferAuthType
    );
    if (matching.length > 0) candidates = matching;
  }
  const strategy = resolveSelectionStrategy(state, options);
  const cursorState = resolveCursorState(state, options);
  if (!picked && strategy === 'random') {
    picked = pickWeightedRandomAccount(candidates, { accountActivity: activity, provider });
  } else if (!picked) {
    const candidateSet = new Set(candidates);
    const total = accounts.length;
    const cursor = Number(cursorState[cursorKey] || 0);
    for (let i = 0; i < total; i += 1) {
      const idx = (cursor + i) % total;
      const account = accounts[idx];
      if (!candidateSet.has(account)) continue;
      cursorState[cursorKey] = (idx + 1) % total;
      picked = account;
      break;
    }
  }

  if (picked && affinityMap && sessionKey) {
    if (affinityMap.size >= Number(affinity.maxEntries)) {
      const oldest = affinityMap.keys().next();
      if (!oldest.done) affinityMap.delete(oldest.value);
    }
    affinityMap.set(sessionKey, {
      accountRef: String(picked.accountRef || ''),
      expiresAt: now + Number(affinity.ttlMs)
    });
  }

  return picked;
}

// describeSelectionWeights 计算「下一次请求的起点概率」，供只读诊断页面使用。
//
// 语义与 chooseServerAccount 的 random 分支一致：先按同一份资格判断过滤，再按
// selectionWeight 归一化。它不消费会话亲和、默认账号偏好和 cursor —— 这些是请求级
// 上下文，诊断页面没有；返回里由调用方标注，避免把概率误读成长期流量份额。
function describeSelectionWeights(accounts, state, options = {}) {
  const provider = String(options.provider || '').trim().toLowerCase();
  const model = String(options.model || '').trim();
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const activity = options.accountActivity || state?.accountActivity;
  const strategy = resolveSelectionStrategy(state, options);
  const list = Array.isArray(accounts) ? accounts : [];
  const accountByRef = new Map(
    list.map((account) => [String(account && account.accountRef || ''), account])
  );
  const evaluateEligibility = createEligibilityEvaluator(state, {
    ...options,
    provider,
    model,
    now,
    accountActivity: activity
  });
  // excludeReasons 是调用方在资格判断之前就确定的事实（例如模型目录不含该账号）；
  // 它优先于运行态原因，保证页面解释的是「为什么这次请求不会选它」的第一因。
  const excludeReasons = options.excludeReasons instanceof Map ? options.excludeReasons : null;
  const rows = list.map((account) => {
    const forced = excludeReasons
      ? excludeReasons.get(String(account && account.accountRef || ''))
      : '';
    const reason = forced || evaluateEligibility(account);
    const load = activity?.selectionLoad?.(provider, account.accountRef, model);
    const pct = Number(account && account.remainingPct);
    return {
      accountRef: String(account && account.accountRef || ''),
      provider: String(account && account.provider || provider || ''),
      cliAccountId: account && account.cliAccountId !== undefined ? account.cliAccountId : null,
      email: String(account && account.email || ''),
      eligible: !reason,
      // reason 是稳定原因码，UI 负责翻译；空串表示可调度。
      reason,
      remainingPct: Number.isFinite(pct) ? pct : null,
      inFlight: Number(load && load.inFlight) || 0,
      modelInFlight: Number(load && load.modelInFlight) || 0,
      rate: Number(load && load.rate) || 0,
      windowMs: Number(load && load.windowMs) || 0,
      weight: 0,
      probability: 0
    };
  });
  let totalWeight = 0;
  for (const row of rows) {
    if (!row.eligible) continue;
    const weight = selectionWeight(accountByRef.get(row.accountRef), activity, provider);
    row.weight = weight;
    totalWeight += weight;
  }
  if (totalWeight > 0) {
    for (const row of rows) {
      if (row.eligible) row.probability = row.weight / totalWeight;
    }
  }
  rows.sort((left, right) => (
    Number(right.eligible) - Number(left.eligible)
    || right.probability - left.probability
    || left.email.localeCompare(right.email)
  ));
  return {
    provider,
    model,
    strategy,
    totalWeight,
    eligibleCount: rows.filter((row) => row.eligible).length,
    totalCount: rows.length,
    candidates: rows
  };
}

module.exports = {
  chooseServerAccount,
  describeSelectionWeights,
  pickWeightedRandomAccount
};
