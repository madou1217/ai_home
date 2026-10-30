'use strict';

const { normalizeExplicitProvider } = require('./router');
const { listModelIdLookupKeys } = require('./model-id');

// 归属表/绑定表的键：先精确 id，再小写 id，最后版本分隔符归一化的小写 id。
//
// 必须保留精确大小写这一档：qoder 这类上游会把同一个模型以 `Auto` / `GLM-5.3`
// 的大写形式再报一遍，而其实它们只由该账号提供。只用小写键会把 `Auto`（qoder）
// 和 `auto`（其他账号）合成一条证据，于是关闭 qoder 后 `Auto` 仍被「auto 有可见
// 账号」误放行（实测残留 8 个大写变体）。按顺序查、命中即返回就不会串。
function modelEvidenceLookupKeys(modelRaw) {
  const trimmed = String(modelRaw || '').trim();
  if (!trimmed) return [];
  // 混合大小写的 id 只登记精确键：否则 `DeepSeek-V4-Pro`（qoder）会给
  // `deepseek-v4-pro` 也写一条归属，把其他 provider 的 `DeepSeek-V4-pro`
  // 一起误伤（实测多隐藏 2 个大小写变体）。
  if (trimmed !== trimmed.toLowerCase()) return [trimmed];
  const versionNormalized = trimmed.replace(/(\d)\.(?=\d)/g, '$1-');
  return Array.from(new Set([trimmed, versionNormalized].filter(Boolean)));
}

// 两套模型目录口径，故意不同：
//
//   - **WebUI 模型管理 = 全量**：发现过、配置过什么就显示什么，用于排查与配置。
//   - **对外 /v1/models = 可见可用**：只发布「至少有一个启用账号能服务」的模型。
//     外部工具（harness / pi / dsh / codex…）拿这份目录当菜单，也不该看到
//     被关闭、被策略挡掉、或根本没有账号的模型。
//
// 本模块只回答一件事：某个 accountRef 现在是否属于对外可见的账号集合。
//
// 「启用」取**配置层**语义 —— 账号在运行池里、且没有需要人动手才能恢复的阻塞。
// 刻意**不看** cooldown / rate_limited / auth_invalid / 配额耗尽这些瞬时态：
//   * 它们是分钟级自动恢复的，写进目录会让 harness 菜单抖动（模型时有时无）；
//   * 请求路径本来就会给出 429 / 401 + Retry-After，不会因为目录里多一个模型而
//     把请求错误地路由出去。
// 只看「需要人或导入流程重新做一遍才能解除」的状态，目录才会稳定。

// schedulableStatus 的取值见 lib/account/derived-state.js#deriveSchedulableState。
// 只有这两类需要人工/配置变化才能恢复：
//   blocked_by_account_status —— 账号未配置或被关闭；
//   blocked_by_policy(relay_disabled) —— 明确不进中转（例如仅供探测/展示的 OAuth 计划账号）。
// blocked_by_runtime_status（限流/过热）与 blocked_by_quota（额度周期）会自动恢复，保留。
const DURABLE_SCHEDULABLE_STATUS = new Set(['blocked_by_account_status']);
const RELAY_DISABLED_POLICY_MARKER = 'relay';

// routingBlock 里需要人动手的状态：账单被封 / 无权限。两者都不会自愈。
const DURABLE_ROUTING_BLOCK_KINDS = new Set(['billing_blocked', 'permission_denied']);

function isRelayDisabled(account) {
  const reason = String(account && (account.schedulableReason || account.relayDisabledReason) || '')
    .trim()
    .toLowerCase();
  return reason.includes(RELAY_DISABLED_POLICY_MARKER);
}

/**
 * 单个账号是否属于「对外可见」集合。纯读，不改账号对象。
 */
function isCatalogVisibleAccount(account) {
  if (!account || typeof account !== 'object') return false;
  const schedulableStatus = String(account.schedulableStatus || '').trim().toLowerCase();
  if (schedulableStatus && DURABLE_SCHEDULABLE_STATUS.has(schedulableStatus)) return false;
  if (schedulableStatus === 'blocked_by_policy' && isRelayDisabled(account)) return false;
  const blockKind = String(account.routingBlock && account.routingBlock.kind || '').trim().toLowerCase();
  if (blockKind && DURABLE_ROUTING_BLOCK_KINDS.has(blockKind)) return false;
  return true;
}

/**
 * 从运行池（state.accounts）算出对外可见的 accountRef 集合。
 *
 * `state.accounts` 是**权威**的启用账号集合：账号加载器会把 status=down 的账号
 * 直接跳过（见 lib/server/accounts.js 的 getPersistedOperationalStatus 判定），
 * 所以「在池里」本身就等于「已启用」。这里不需要再读一遍状态库。
 *
 * @returns {{ known: boolean, accountRefs: Set<string>, hiddenAccountRefs: Set<string> }}
 *   known=false 表示拿不到账号池（命令行/桩对象），调用方应保持原样、**不要**过滤，
 *   否则一次缺失的池会把目录清空。
 */
function buildCatalogVisibility(state, options = {}) {
  const pools = state && state.accounts;
  if (!pools || typeof pools !== 'object') {
    return { known: false, accountRefs: new Set(), hiddenAccountRefs: new Set(), visibleProviders: new Set() };
  }
  const providerMode = normalizeExplicitProvider(options && options.provider);
  const accountRefs = new Set();
  const hiddenAccountRefs = new Set();
  // provider 档的可见性：有至少一个启用账号的 provider 才算「活着」。
  // provider 级目录（registry / byProvider）没有账号归属，只能靠它判断去留。
  const visibleProviders = new Set();
  Object.entries(pools).forEach(([providerRaw, accounts]) => {
    const provider = normalizeExplicitProvider(providerRaw)
      || String(providerRaw || '').trim().toLowerCase();
    if (providerMode && provider !== providerMode) return;
    (Array.isArray(accounts) ? accounts : []).forEach((account) => {
      const accountRef = String(account && account.accountRef || '').trim();
      if (!accountRef) return;
      if (isCatalogVisibleAccount(account)) {
        accountRefs.add(accountRef);
        visibleProviders.add(provider);
      } else {
        hiddenAccountRefs.add(accountRef);
      }
    });
  });
  // 同一 accountRef 不会同时可见与隐藏：隐藏集只收真正被挡掉的。
  hiddenAccountRefs.forEach((accountRef) => {
    accountRefs.delete(accountRef);
  });
  return { known: true, accountRefs, hiddenAccountRefs, visibleProviders };
}

/**
 * 按可见性过滤「(账号, 模型)」对。**必须在按模型 id 去重之前调用**：
 * 去重只保留先出现的那个账号，如果先出现的是被关闭的账号，去重后再过滤会把
 * 「另一个启用账号也能服务」的模型一起删掉（共享模型的误伤）。
 *
 * known=false 时原样返回。
 */
function filterEntriesByCatalogVisibility(entries, visibility) {
  const list = Array.isArray(entries) ? entries : [];
  if (!visibility || visibility.known !== true) return list;
  return list.filter((entry) => {
    const accountRef = String(entry && entry.accountRef || '').trim();
    if (!accountRef) return true;
    return visibility.accountRefs.has(accountRef);
  });
}

/**
 * 模型 → 账号的倒排证据：`state.modelAccountIndex.modelToAccounts`（O(1)）。
 * 拿不到索引时返回 null，表示「没有证据」，调用方应放行而不是删模型。
 */
function getInvertedIndexMap(state) {
  const map = state && state.modelAccountIndex && state.modelAccountIndex.modelToAccounts;
  return map instanceof Map ? map : null;
}

// 逐账号目录证据的备忘：按「byAccount 对象身份」缓存的 WeakMap。
//
// 为什么要和倒排索引并存：倒排索引只在**启动构建**和 WebUI 刷新路径
// （refreshOnCacheUpdate）里更新；codex-adapter 的全局目录刷新走
// collectModelIdsFromHandler，只把结果写进 globalModelsCache，不会 patch 索引。
// 只信索引的话，一个刚被探测到的账号在被关闭后，它的模型会因为没有证据而继续留在
// 对外目录里（实测：关闭 qoder 后 Cantus 等 15 个模型仍在）。缓存对象在每次刷新时
// 整体替换，所以用对象身份做备忘会自动失效，不需要额外版本号。
const EVIDENCE_MEMO = new WeakMap();

function buildEvidenceFromByAccount(byAccount) {
  const evidence = new Map();
  Object.entries(byAccount && typeof byAccount === 'object' ? byAccount : {}).forEach(([accountRef, models]) => {
    const ref = String(accountRef || '').trim();
    if (!ref) return;
    (Array.isArray(models) ? models : []).forEach((modelId) => {
      modelEvidenceLookupKeys(modelId).forEach((key) => {
        const refs = evidence.get(key);
        if (refs) {
          if (!refs.includes(ref)) refs.push(ref);
        } else {
          evidence.set(key, [ref]);
        }
      });
    });
  });
  return evidence;
}

// 模型 → 账号的「构建期归属」，与目录体一起缓存。
//
// 为什么需要第四种证据：`/v1/models` 的本地条目来自能力索引（`buildLocalModelEntries`），
// 条目本身不带 accountRef（`mergeGatewayModelEntries` 会按模型去重，只留先出现的账号）。
// 于是像 Cantus 这种「只由 qoder 账号声明」的模型，在 qoder 被关闭后：
//   * 倒排索引里没有它（codex-adapter 的全局刷新不 patch 索引）；
//   * 逐账号目录里也没有它（它来自账号声明的 availableModels，不是探测结果）；
// 过滤就拿不到任何证据、只能放行，实测要等到后台重建（~100ms~数秒）才会消失。
// 归属表在建缓存时从能力索引的 modelProviders（模型 → provider → 账号集合）直接生成，
// 存量缓存体因此自带「谁在提供它」，池一变就能立刻收窄。
function buildModelAccountEvidence(modelCapabilityIndex) {
  const evidence = new Map();
  const modelProviders = modelCapabilityIndex && modelCapabilityIndex.modelProviders;
  if (!(modelProviders instanceof Map)) return evidence;
  modelProviders.forEach((providers, modelId) => {
    if (!(providers instanceof Map)) return;
    const refs = [];
    providers.forEach((accountRefs) => {
      (accountRefs instanceof Set ? accountRefs : []).forEach((accountRef) => {
        const ref = String(accountRef || '').trim();
        if (ref && !refs.includes(ref)) refs.push(ref);
      });
    });
    if (refs.length === 0) return;
    modelEvidenceLookupKeys(modelId).forEach((key) => {
      const existing = evidence.get(key);
      if (existing) {
        refs.forEach((ref) => { if (!existing.includes(ref)) existing.push(ref); });
      } else {
        evidence.set(key, refs.slice());
      }
    });
  });
  return evidence;
}

/**
 * 把一份逐账号目录（accountRef → [modelId]）并进归属表。
 * 用于探测结果：全局目录构建时每个 provider 的探测结果各自带着 byAccount，
 * 但只把 ids 合并进总表，归属会丢——池变化后这批模型就没有证据、收不窄。
 */
function addByAccountEvidence(target, byAccount) {
  if (!(target instanceof Map)) return target;
  buildEvidenceFromByAccount(byAccount).forEach((refs, key) => {
    const existing = target.get(key);
    if (existing) refs.forEach((ref) => { if (!existing.includes(ref)) existing.push(ref); });
    else target.set(key, refs.slice());
  });
  return target;
}

function getByAccountEvidence(state) {
  const webUiByAccount = state && state.webUiModelsCache && state.webUiModelsCache.byAccount;
  const upstreamByAccount = state && state.modelsCache && state.modelsCache.byAccount;
  const memo = EVIDENCE_MEMO.get(state);
  if (memo && memo.webUiByAccount === webUiByAccount && memo.upstreamByAccount === upstreamByAccount) {
    return memo.evidence;
  }
  const merged = new Map();
  [buildEvidenceFromByAccount(webUiByAccount), buildEvidenceFromByAccount(upstreamByAccount)]
    .forEach((source) => {
      source.forEach((refs, key) => {
        const target = merged.get(key);
        if (target) {
          refs.forEach((ref) => { if (!target.includes(ref)) target.push(ref); });
        } else {
          merged.set(key, refs.slice());
        }
      });
    });
  EVIDENCE_MEMO.set(state, { webUiByAccount, upstreamByAccount, evidence: merged });
  return merged;
}

/**
 * 一个模型 id 是否有「可见账号」在提供。
 *
 * 证据按权威度依次为：
 *   1. `provenance`（缓存体自带的构建期归属，见 buildModelAccountEvidence）——
 *      有归属就以它为准：它记录了这条条目究竟是哪些账号声明出来的；
 *   2. 倒排索引 ∪ 逐账号目录（webUiModelsCache / modelsCache 的 byAccount）。
 * 倒排索引不是每次探测都会更新（见 EVIDENCE_MEMO 的说明），所以 2 只是兜底，
 * 只看它会把「刚被探测到、随后被关闭」的账号的模型漏掉。
 *
 * 没有任何证据的 id（别名 / 手动模型 / 来源不明）一律返回 true：
 * 可见性只负责**收窄有证据的**部分，不能把别名和手动配置误删。
 */
function isModelServableByVisibleAccount(state, modelId, visibility, provenance, providerBindings) {
  if (!visibility || visibility.known !== true) return true;
  // 倒排表的键是 normalizeModelId 之后的小写 id（含版本分隔符变体），
  // 直接拿原始 id 查会漏掉 `Cantus` / `DeepSeek-V4-Pro` 这类大写模型名。
  // 归属/绑定按 modelEvidenceLookupKeys 的顺序查（精确大小写优先）；
  // 倒排索引只有小写键，单独用 listModelIdLookupKeys。
  const keys = modelEvidenceLookupKeys(modelId);
  if (keys.length === 0) return true;
  const indexKeys = listModelIdLookupKeys(modelId);
  const isVisible = (accountRef) => visibility.accountRefs.has(String(accountRef || '').trim());
  if (provenance) {
    for (const key of keys) {
      const refs = provenanceRefsFor(provenance, key);
      if (refs && refs.length > 0) return refs.some(isVisible);
    }
  }
  // 账号级归属缺失时退到 provider 档：provider 级目录（registry / byProvider）是
  // 「该 provider 当前能提供什么」，pool 里没有这个 provider 的启用账号时它就不该对外发布。
  if (providerBindings) {
    for (const key of keys) {
      const provider = String(providerBindings[key] || '').trim().toLowerCase();
      if (!provider) continue;
      if (!visibility.visibleProviders) return true;
      return visibility.visibleProviders.has(provider);
    }
  }
  const inverted = getInvertedIndexMap(state);
  const evidence = state && typeof state === 'object' ? getByAccountEvidence(state) : null;
  // 逐账号目录可能按精确 id（混合大小写）登记，倒排表只按小写；两套键都要查。
  const catalogKeys = Array.from(new Set([...keys, ...indexKeys]));
  let sawEvidence = false;
  for (const key of catalogKeys) {
    const fromIndex = inverted ? inverted.get(key) : null;
    const fromCatalog = evidence ? evidence.get(key) : null;
    for (const refs of [fromIndex, fromCatalog]) {
      if (!Array.isArray(refs) || refs.length === 0) continue;
      sawEvidence = true;
      if (refs.some(isVisible)) return true;
    }
  }
  return !sawEvidence;
}

// 归属表既可以是 Map（内存里刚建的），也可以是普通对象（从缓存快照反序列化回来的）。
function provenanceRefsFor(provenance, key) {
  if (!provenance) return null;
  if (provenance instanceof Map) return provenance.get(key) || null;
  const value = provenance[key];
  return Array.isArray(value) ? value : null;
}

/**
 * 按可见性过滤 OpenAI `/v1/models` 响应体（缓存的永远是未过滤的体，过滤在这里做，
 * 所以池一变，下一个请求就是新口径，不必等后台刷新）。
 *
 * `provenance` 是缓存体自带的「模型 → 账号」归属表；缺省时退回索引/目录证据。
 *
 * @returns {{ body: string, hidden: number, changed: boolean }}
 */
function filterOpenAIModelsBodyByCatalogVisibility(bodyText, state, visibility, provenance, providerBindings) {
  const text = String(bodyText || '');
  if (!visibility || visibility.known !== true) return { body: text, hidden: 0, changed: false };
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (_error) {
    return { body: text, hidden: 0, changed: false };
  }
  if (!payload || !Array.isArray(payload.data)) return { body: text, hidden: 0, changed: false };
  let hidden = 0;
  const data = payload.data.filter((item) => {
    if (isModelServableByVisibleAccount(state, item && item.id, visibility, provenance, providerBindings)) return true;
    hidden += 1;
    return false;
  });
  if (hidden === 0) return { body: text, hidden: 0, changed: false };
  payload.data = data;
  return { body: JSON.stringify(payload), hidden, changed: true };
}

module.exports = {
  modelEvidenceLookupKeys,
  buildCatalogVisibility,
  buildModelAccountEvidence,
  addByAccountEvidence,
  filterEntriesByCatalogVisibility,
  filterOpenAIModelsBodyByCatalogVisibility,
  isCatalogVisibleAccount,
  isModelServableByVisibleAccount,
  DURABLE_ROUTING_BLOCK_KINDS,
  DURABLE_SCHEDULABLE_STATUS
};
