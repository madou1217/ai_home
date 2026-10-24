'use strict';

// 已划给 Go 的条目在哪些请求上仍交还 Node 处理（Go Core 转发前的宿主判定）。
// 目标：划转不改变客户端可观察语义——Go 只接它能按 Node 同样语义完成的请求。

const { INFERENCE_ENTRY_IDS } = require('./go-core-route-ownership');
const { resolvePinnedAccount } = require('./pinned-account');
const { getImageBlob } = require('./image-blob-store');
const {
  goInferenceChannel,
  goServesInference,
  GO_INFERENCE_CHANNEL_RELAY
} = require('./go-core-servable-providers');
const { selectPoolAccountsForModel } = require('./model-account-pool-selector');
const { findAccountsForModel } = require('./model-account-index');
const {
  accountAcceptedByGo,
  hasEnabledRules,
  hasUnacceptedEnabledRules
} = require('./upstream-error-rules-projection');
const { isCustomUpstreamAccount } = require('../account/official-upstream-endpoint');

const { wouldApplyModelNamespace } = require('./model-namespace-header');

const BLOB_ENTRY_ID = 'gateway.vision.blobs';
const BLOB_PATH_PREFIX = '/v1/blobs/';

const INFERENCE_ENTRIES = new Set(INFERENCE_ENTRY_IDS);

/** 启用的 Node 模型别名是否命中该模型（精确或尾部 * 前缀；不区分作用域，保守交还）。 */
function modelMatchesEnabledAlias(aliases, model) {
  const requested = String(model || '').trim();
  if (!requested || !Array.isArray(aliases)) return false;
  return aliases.some((record) => {
    if (!record || record.enabled === false) return false;
    const alias = String(record.alias || '').trim();
    if (!alias) return false;
    return alias.endsWith('*') ? requested.startsWith(alias.slice(0, -1)) : alias === requested;
  });
}

/** Go 是否已确认接受这条别名（其路由目录里已有等价规则）。 */
function aliasAcceptedByGo(record, acceptedIds) {
  if (!(acceptedIds instanceof Set) || acceptedIds.size === 0) return false;
  return acceptedIds.has(String((record && record.id) || ''));
}

/**
 * 启用的 Node 别名是否命中该模型，且 Go 尚未接受它。
 *
 * Go 只接受能忠实执行的别名（作用域可表达、目标可路由）；未接受的别名（含插件别名、
 * 以及 Go 编译时丢弃的别名）仍然只在 Node 有语义，必须交还。
 */
function modelMatchesUnacceptedAlias(aliases, model, acceptedIds) {
  const requested = String(model || '').trim();
  if (!requested || !Array.isArray(aliases)) return false;
  return aliases.some((record) => {
    if (!record || record.enabled === false) return false;
    const alias = String(record.alias || '').trim();
    if (!alias) return false;
    const matches = alias.endsWith('*') ? requested.startsWith(alias.slice(0, -1)) : alias === requested;
    return matches && !aliasAcceptedByGo(record, acceptedIds);
  });
}

/** 读取宿主注入的「Go 已接受别名」集合；不可用时返回 null（视为全部未接受）。 */
function goAcceptedAliasSet(input) {
  if (typeof input.goAcceptedAliasIds !== 'function') return null;
  const ids = input.goAcceptedAliasIds();
  return ids instanceof Set ? ids : null;
}

/** 读取宿主注入的「Go 已承接规则账号」集合；不可用时返回 null（视为全部未承接）。 */
function goAcceptedRuleRefSet(input) {
  if (typeof input.goAcceptedErrorRuleRefs !== 'function') return null;
  const refs = input.goAcceptedErrorRuleRefs();
  return refs instanceof Set ? refs : null;
}

/**
 * 账号出口：Go Core 不执行账号出口（代理地址 / 出口池 / 系统代理），被它承接的请求会绕过
 * 出口直连上游。宿主注入 `egressBoundRefs()`（需要经 Node 出口的账号集合，见
 * account-egress-binding-index；读不出来返回 null = 未知，保守交还）。
 * 作用域与自定义错误规则一致：钉选只看被钉选账号；未钉选看运行池里有没有这样的账号。
 */
function egressBoundRefSet(input) {
  if (typeof input.egressBoundRefs !== 'function') return new Set();
  const refs = input.egressBoundRefs();
  return refs instanceof Set ? refs : null;
}

function poolHasEgressBoundAccount(state, refs, entryId) {
  if (refs === null) return true;
  if (refs.size === 0) return false;
  const pools = state && state.accounts;
  if (!pools || typeof pools !== 'object') return true;
  // 只有 Go 在这个入口上服务得了的 Provider 的账号会被 Go 选中；其余 Provider 的账号
  // （例如 opencode）本来就由 Node 承接，绑没绑出口都不影响 Go 的转发。
  return Object.entries(pools).some(([provider, pool]) => goServesInference(provider, entryId)
    && (Array.isArray(pool) ? pool : []).some((account) => refs.has(String((account && account.accountRef) || ''))));
}

/**
 * Go Core 的 native quota / failure state 不能归因给第三方或另一台 AIH
 * gateway 的 API Key 账号。Node 已经拥有完整的 custom-upstream 语义和
 * relay 头部处理，因此这类账号必须留在 Node，直到 Go 有同一份上游边界合同。
 *
 * 这里消费账号投影上的通用事实（apiKeyMode + baseUrl），不按厂商域名或
 * provider 名字猜测；官方 API Key 仍可由 Go 处理。
 */
function isCustomUpstreamRuntimeAccount(account, provider) {
  if (!account || !provider) return false;
  return isCustomUpstreamAccount({
    provider,
    apiKeyMode: Boolean(account.apiKeyMode),
    baseUrl: account.baseUrl || account.openaiBaseUrl || account.anthropicBaseUrl || ''
  });
}

function poolHasCustomUpstreamAccount(state, entryId) {
  const pools = state && state.accounts;
  // Let the existing pool-shape gate report unknown input with its established
  // reason. This predicate only answers a positive custom-upstream fact.
  if (!pools || typeof pools !== 'object' || Array.isArray(pools)) return false;
  return Object.entries(pools).some(([provider, pool]) => {
    if (!goServesInference(provider, entryId) || !Array.isArray(pool)) return false;
    return pool.some((account) => isCustomUpstreamRuntimeAccount(account, provider));
  });
}

function needsRequestModel(entryId) {
  return INFERENCE_ENTRIES.has(entryId);
}

/**
 * 池里是否存在「Go 服务不了该 Provider 推理」的账号（存在即进入了池门判定）。
 *
 * 池的形状是 `state.accounts[provider] = [account, ...]`，所以 Provider 就是键。
 * 形状未知时按「未知即保守」处理：宁可留在 Node（Node 是完整实现），也不要转给 Go
 * 换一个 503 —— 与错误规则投影的「未承接即交还」同口径。
 *
 * 为什么起点是**池级**而不是只看请求模型：未钉选请求可能回落到池里任意 Provider 的账号，
 * 而 Go 的路由在划转后没有 Node 回落 —— 只要池里存在一个 Go 服务不了的 Provider 的账号，
 * 就无法保证请求不会落到它身上。这与错误规则采用池级作用域是同一条论证。
 *
 * 判定带入口：家族透传通道只在挂载它的入口上算「服务得了」
 * （见 go-core-servable-providers 的两条通道），别的入口照旧按「服务不了」交还。
 * 命中本判定后由 explainPoolDeferral 继续做模型级收窄，不要直接用它下交还结论。
 */
function poolHasNonGoServableProvider(state, entryId) {
  const pools = state && state.accounts;
  if (!pools || typeof pools !== 'object' || Array.isArray(pools)) return true;
  for (const [provider, pool] of Object.entries(pools)) {
    if (!Array.isArray(pool) || pool.length === 0) continue;
    if (!goServesInference(provider, entryId)) return true;
  }
  return false;
}

/**
 * 逐 Provider 找出「索引里真的有这个模型账号」的承载者——即 Node 可能在这个模型上选中的 Provider。
 *
 * 与 Node 的 Provider 选择同规则：`resolveRequestProvider` 先用 getModelBindingScore 定盘，
 * 只在绑定强度最高的那批 Provider 里挑；而绑定分完全由倒排索引（modelToAccounts /
 * accountToModels）计算，**只有正向证据**——账号目录已知且含该模型（探测缓存 + 账号声明 +
 * 用量目录），目录未知的账号不产生任何绑定。因此这里用同一个正向索引判定承载者：
 * 「谁可能拿到这个模型」=「索引里谁有它的账号」。
 *
 * 刻意不用 selectPoolAccountsForModel（那是**账号池**的收窄，弱证据放行、目录未知的账号
 * 会留在池里）：池收窄回答「这个 Provider 内部哪些账号还能服务」，前提是 Provider 已经选定；
 * 承载者回答「Node 会选哪个 Provider」。混用会让一个目录未知的账号（探测预算还没轮到它）
 * 把整个 Provider 变成承载者，于是所有模型的承载者都混入非透传 Provider，模型级解禁
 * 退化成永不生效——而这不是保守，是判定对象错了。
 *
 * 保守性仍然保留在「不选中的一边」：绑定量低于最高分的 Provider 也算承载者（交还），
 * 只有「承载者集合里的每一个都是透传通道」才转发。
 *
 * @returns {string[]|null} Provider 名数组；null 表示没有模型可判（调用方保守处理）。
 */
function modelCarrierProviders(input) {
  const model = String(input.model || '').trim();
  const state = input.state;
  if (!model || !state || typeof state !== 'object') return null;
  const index = state.modelAccountIndex;
  // 与 getModelBindingScore 同一前置：索引未建（builtAt 未置位）时所有绑定都是 0，
  // Node 会落到「缓存 + 注册表」的回落选择，那一步不在本判定的证据范围内 → 按未知处理。
  if (!index || !(index.builtAt > 0)) return [];
  const refs = findAccountsForModel(index, model);
  if (!Array.isArray(refs) || refs.length < 1) return [];
  const accountByRef = index.accountByRef instanceof Map ? index.accountByRef : null;
  if (!accountByRef) return null;
  const carriers = new Set();
  for (const ref of refs) {
    const account = accountByRef.get(ref);
    const provider = String((account && account.provider) || '').trim();
    if (provider) carriers.add(provider);
  }
  return [...carriers];
}

/**
 * 未钉选请求的池门（模型级收窄版）。返回原因名表示交还 Node，返回 '' 表示继续转发判定。
 *
 * 旧语义（整体）：池里只要有一个 Provider 在该入口上 Go 服务不了，就整体交还 Node。
 * 它对「未钉选请求可能跨 Provider 回落到任意账号」是正确的，但代价是**所有**未钉选
 * 推理都留在 Node —— 池里几乎总有无 Go 通道的账号（opencode / kimi / zcode / …），
 * 于是 Go 的推理入口只剩钉选 canary 能用。
 *
 * 新语义（模型级，刻意收窄）：承载者集合（见 modelCarrierProviders）全为「透传通道」
 * Provider（家族四支，且该入口挂载了透传）时转发。论证：承载者以外的 Provider 拿不到
 * 这个模型（没有索引绑定 = Node 的绑定分 0，永远不会被选），而 Go 的家族征召链只在这批
 * Provider 里选号（familyRelayAccountSource 按家族表链式征召）。
 *
 * 为什么不用「承载者恰好全是 codex/claude/agy 也转发」的 canonical 单 Provider 解禁：
 * 绑定分只是定盘，同分时还有同族加成 + 注册表序两道裁决；Go 的路由目录/规则顺序与
 * Node 并不相同（agy 还有 Node 独占的 MODEL_WINDOW_GATES 窗口门），未取证前不做，
 * 避免「同一个请求两侧选中不同 Provider」。
 */
function explainPoolDeferral(input) {
  const pools = input.state && input.state.accounts;
  if (!pools || typeof pools !== 'object' || Array.isArray(pools)) {
    return 'pool_has_non_go_servable_provider';
  }
  if (!poolHasNonGoServableProvider(input.state, input.entryId)) return '';
  const carriers = modelCarrierProviders(input);
  if (!Array.isArray(carriers)) return 'pool_has_non_go_servable_provider';
  if (carriers.length < 1) return 'pool_model_carriers_unknown';
  const relayOnly = carriers.every((provider) => (
    goInferenceChannel(provider, input.entryId) === GO_INFERENCE_CHANNEL_RELAY
  ));
  return relayOnly ? '' : 'pool_has_non_go_servable_provider';
}

/**
 * 透传通道（家族）钉选账号的模型可用性判定。
 *
 * Go 的家族透传不看 Go 的路由目录（按账号原生登录态直连官方端点），但「钉选账号
 * 能否服务这个模型」的硬证据必须与 Node 同口径：Node 的钉选路径会把单账号池喂给
 * selectPoolAccountsForModel，被强否定证据（用户显式停用 / 目录已知且不含该模型）
 * 排除时返回 no_available_account——而不是把请求原样打到上游换一个 400。这里复用
 * 同一个收窄函数，两侧结论按构造一致；弱证据（目录未知 / 索引未建）一律放行，
 * 与 Node 的放行分支相同。
 */
function relayPinnedAccountCanServeModel(state, provider, model, account) {
  if (!provider || !model || !account) return true;
  const selection = selectPoolAccountsForModel({
    pool: [account],
    provider,
    model,
    state
  });
  return Array.isArray(selection.pool) && selection.pool.length > 0;
}

const FORWARDED = Object.freeze({ defer: false, reason: '' });

/**
 * 交还 Node 的判定，并给出原因（G5 按原因计数，见 go-core-node-fallback-counters）。
 *
 * 交还 Node 的情形：
 *  - 钉选头存在但钉选不可用/格式非法/未知：Node 负责回落常池、403 pinned_account_unavailable、
 *    404 unknown_account_ref 或 400 invalid_account_ref；Go 只会一律 503，语义会变。
 *    可用钉选照常转发，Go 以 x-account-ref 独占路由到同一账号。
 *  - 显式 Provider 选择（x-provider 头）：Go 不读该头，显式选择只在 Node 有语义。
 *  - 模型命名空间头（x-aih-model-namespace）且模型是裸名：补全只在 Node v1-router 发生，
 *    Go 收到裸名会选不到账号（钉选与否都一样，Node 两条路径都补全）。
 *  - 推理条目且 Fabric 远端网关在线：Fabric 按模型/Provider 路由到远端节点只发生在 Node
 *    v1 路由里（钉选请求 Node 本身也不走 Fabric，因此只对未钉选请求交还）。
 *  - 推理条目的模型命中启用的 Node 别名（input.aliases，钉选请求 Node 也不用别名）。
 *  - 自定义错误规则：Go 未承接该账号的规则时，交还 Node 求值（见下方作用域说明）。
 */
function explainGoRouteDeferral(input = {}) {
  const deferred = (reason) => ({ defer: true, reason });
  // 客户端（aih 启动的跨 Provider harness）显式要求这条请求由 Node 完整实现。
  // 这是唯一一个不看路由、不看待判输入的短路：Go 上同一入口的跨 Provider 协议桥
  // 仍有未对齐的语义，转发过去会返回 200 但长时间不结束（Anthropic /v1/messages
  // -> Codex Responses）。该头由 Node 在转发前消费，未声明时不改变任何行为。
  if (input.forceNode === true) return deferred('route_owner_node');
  // blob 只存在于生成它的那一侧进程内仓：Node 仓里有这个 id 就由 Node 返回，否则交给 Go。
  if (input.entryId === BLOB_ENTRY_ID) {
    const pathname = String(input.pathname || '');
    const id = pathname.startsWith(BLOB_PATH_PREFIX) ? pathname.slice(BLOB_PATH_PREFIX.length) : '';
    const lookup = typeof input.getNodeBlob === 'function' ? input.getNodeBlob : getImageBlob;
    return id && lookup(id) ? deferred('node_blob') : FORWARDED;
  }
  if (INFERENCE_ENTRIES.has(input.entryId) && wouldApplyModelNamespace(input.modelNamespace, input.model)) {
    return deferred('model_namespace_header');
  }
  const pinnedAccountRef = String(input.pinnedAccountRef || '').trim();
  // 钉选解析在规则判定之前完成：规则判定的作用域取决于请求是不是钉选的。
  const pinned = pinnedAccountRef
    ? resolvePinnedAccount(input.state, input.accountStateIndex, pinnedAccountRef)
    : null;
  // 自定义错误协议由谁执行取决于 Go 是否已承接该账号的规则：Go 未承接（含未推送、被
  // Provider 能力/规则编译丢弃、或 Go 还没就绪）时必须交还 Node，否则该账号的异常语义
  // 会被 Go 的内置启发式静默改写。
  const ruleAcceptedRefs = goAcceptedRuleRefSet(input);
  const goRefFor = typeof input.goAccountRefFor === 'function' ? input.goAccountRefFor : null;
  if (pinnedAccountRef) {
    const pinnedProvider = String((pinned.resolvedPin && pinned.resolvedPin.provider) || '');
    const pinnedAccount = pinned.resolvedPin && pinned.resolvedPin.account;
    // Keep custom upstream lifecycle and error semantics in Node even when a
    // stale Go runtime overlay makes the pin look blocked. Node owns the
    // authoritative persisted status and can return the correct 403/404 or
    // pool fallback without letting Go's native quota state decide first.
    if (INFERENCE_ENTRIES.has(input.entryId)
      && isCustomUpstreamRuntimeAccount(pinnedAccount, pinnedProvider)) {
      return deferred('custom_upstream_node_only');
    }
    if (!pinned.usable) {
      return deferred('pinned_account_unusable');
    }
    // 迁移时有账号在 Go 里换了 id（rekey / 同身份合并）：钉选头里是 Node id，Go 不认识。
    // 没有 Node→Go 映射的钉选交还 Node；有映射的由转发层改写成 Go id。
    if (typeof input.goAccountRefFor === 'function' && !input.goAccountRefFor(pinnedAccountRef)) {
      return deferred('pinned_account_unmapped');
    }
    // 钉选请求同样只在 Go 能路由该模型时转发（2026-09-27 codex gpt-6-astra 只在 Go 已停用账号上）。
    // 透传通道（家族）是例外：Go 按账号原生登录态直连官方端点、不看 Go 路由目录，模型
    // 可用性改按 Node 自己的硬证据判定（与 Node 钉选路径同一套收窄函数），避免出现
    // 「Node 会拒的请求被 Go 原样打到上游」。
    if (INFERENCE_ENTRIES.has(input.entryId) && input.model) {
      if (goInferenceChannel(pinnedProvider, input.entryId) === GO_INFERENCE_CHANNEL_RELAY) {
        if (!relayPinnedAccountCanServeModel(input.state, pinnedProvider, input.model, pinnedAccount)) {
          return deferred('pinned_model_not_routable');
        }
      } else if (typeof input.goRoutableModelIds === 'function') {
        const ids = input.goRoutableModelIds();
        if (!ids || !ids.has(input.model)) return deferred('pinned_model_not_routable');
      }
    }
    // 钉选账号的 Provider 在该入口上没有 Go 上游（含透传未挂载的入口）时也必须留在 Node：
    // 路由划给 Go 之后没有 Node 回落，Go 只会失败。可用钉选是独占路由，所以只看被钉选
    // 账号自己的 Provider 与入口。
    if (INFERENCE_ENTRIES.has(input.entryId)) {
      const pinnedProvider = String((pinned.resolvedPin && pinned.resolvedPin.provider) || '');
      if (pinnedProvider && !goServesInference(pinnedProvider, input.entryId)) {
        return deferred('provider_not_go_servable');
      }
    }
    // 钉选账号绑定了网关侧出口：Go 不执行账号出口，交还 Node。
    if (INFERENCE_ENTRIES.has(input.entryId)) {
      const refs = egressBoundRefSet(input);
      const pinnedAccount = pinned.resolvedPin && pinned.resolvedPin.account;
      const ref = String((pinnedAccount && pinnedAccount.accountRef) || pinnedAccountRef);
      if (refs === null || refs.has(ref)) return deferred('account_egress');
    }
    // 可用钉选是独占路由（Node 只在钉选不可用时才回落常池，那种情况已在上面交还），
    // 因此规则作用域只看被钉选账号自己：池里别的账号带着 Go 未承接的规则与本请求无关。
    if (INFERENCE_ENTRIES.has(input.entryId)) {
      const pinnedAccount = pinned.resolvedPin && pinned.resolvedPin.account;
      if (pinnedAccount && hasEnabledRules(pinnedAccount)
        && !accountAcceptedByGo(pinnedAccount.accountRef, ruleAcceptedRefs, goRefFor)) {
        return deferred('account_error_rules');
      }
    }
    return FORWARDED;
  }
  // 显式 Provider 选择（x-provider）只在 Node 有语义：Go 不读该头，转发后 Go 按自己的
  // 路由目录选 Provider，可能与客户端指定的 Provider 不同。钉选 + 显式 Provider 同现时
  // 账号由钉选决定（Node 的钉选路径还会用被钉账号的 Provider 覆写该头），不受影响；
  // 未钉选请求则在选中 Provider 之前就被显式选择接管，一律交还 Node。
  if (INFERENCE_ENTRIES.has(input.entryId) && String(input.explicitProvider || '').trim()) {
    return deferred('explicit_provider');
  }
  // 未钉选请求可能跨 Provider / 别名回落到池里任意账号，所以规则作用域是整个运行池：
  // 只要池里存在一个 Go 未承接的规则账号，请求就可能落到它身上，必须交还 Node 求值。
  if (INFERENCE_ENTRIES.has(input.entryId)
    && hasUnacceptedEnabledRules(input.state && input.state.accounts || {}, ruleAcceptedRefs, goRefFor)) {
    return deferred('account_error_rules');
  }
  // A custom upstream may be another AIH gateway or a third-party OpenAI-compatible
  // endpoint. Go's native account runtime cannot know whether a quota/capacity error
  // belongs to that remote pool, so keep the whole candidate pool on Node rather than
  // writing remote quota state into a local relay account.
  if (INFERENCE_ENTRIES.has(input.entryId)
    && poolHasCustomUpstreamAccount(input.state, input.entryId)) {
    return deferred('custom_upstream_node_only');
  }
  // 未钉选请求可能落到池里任意账号：池里有一个绑定了网关侧出口的账号，就整体交还 Node。
  if (INFERENCE_ENTRIES.has(input.entryId) && poolHasEgressBoundAccount(input.state, egressBoundRefSet(input), input.entryId)) {
    return deferred('account_egress');
  }
  // 池门（模型级收窄，见 explainPoolDeferral）：池里存在 Go 服务不了的 Provider 时，
  // 只有「这个模型的承载者全为透传通道」才继续交给 Go；其余情形整体交还 Node，
  // 否则表现为「同一个模型，有时 200 有时 503」。
  if (INFERENCE_ENTRIES.has(input.entryId)) {
    const poolDeferral = explainPoolDeferral(input);
    if (poolDeferral) return deferred(poolDeferral);
  }
  if (INFERENCE_ENTRIES.has(input.entryId) && typeof input.fabricGatewayReady === 'function'
    && input.fabricGatewayReady()) {
    return deferred('fabric_gateway_online');
  }
  if (!INFERENCE_ENTRIES.has(input.entryId)) return FORWARDED;
  // 别名（含运行时回落到其它 Provider）只存在于 Node；命中启用别名的请求交还 Node。
  // Go 已确认接受的别名例外——Go 的目录里已有等价路由，不必再交还。
  if (modelMatchesUnacceptedAlias(input.aliases, input.model, goAcceptedAliasSet(input))) {
    return deferred('model_alias');
  }
  // Go 只能路由自己账号库里的模型；其余模型（只有 Node 承接的 Provider）交还 Node。
  // 集合尚未加载时保守交还。无模型的请求（异常体）交给 Go 按协议报错。
  if (input.model && typeof input.goRoutableModelIds === 'function') {
    const ids = input.goRoutableModelIds();
    if (!ids || !ids.has(input.model)) return deferred('model_not_routable');
  }
  return FORWARDED;
}

/** 返回 true 表示交还 Node。布尔包装，语义与 explainGoRouteDeferral 完全一致。 */
function shouldDeferGoRouteToNode(input = {}) {
  return explainGoRouteDeferral(input).defer;
}

module.exports = {
  explainGoRouteDeferral,
  modelMatchesEnabledAlias,
  modelMatchesUnacceptedAlias,
  needsRequestModel,
  shouldDeferGoRouteToNode
};
