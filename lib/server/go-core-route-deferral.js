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
const {
  accountAcceptedByGo,
  hasEnabledRules,
  hasUnacceptedEnabledRules
} = require('./upstream-error-rules-projection');

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

function needsRequestModel(entryId) {
  return INFERENCE_ENTRIES.has(entryId);
}

/**
 * 池里是否存在「Go 服务不了该 Provider 推理」的账号（存在即必须整体交还 Node）。
 *
 * 池的形状是 `state.accounts[provider] = [account, ...]`，所以 Provider 就是键。
 * 形状未知时按「未知即保守」处理：宁可留在 Node（Node 是完整实现），也不要转给 Go
 * 换一个 503 —— 与错误规则投影的「未承接即交还」同口径。
 *
 * 为什么是**池级**而不是只看请求模型：未钉选请求可能回落到池里任意 Provider 的账号，
 * 而 Go 的路由在划转后没有 Node 回落 —— 只要池里存在一个 Go 服务不了的 Provider 的账号，
 * 就无法保证请求不会落到它身上。这与错误规则采用池级作用域是同一条论证。
 *
 * 判定带入口：家族透传通道只在挂载它的入口上算「服务得了」
 * （见 go-core-servable-providers 的两条通道），别的入口照旧按「服务不了」交还。
 *
 * 代价（明说，不藏）：只要池里还有 Go 服务不了的 Provider，**未钉选推理请求就整体留在
 * Node**；Go 的 canary 对推理仍可通过钉选 codex/claude/agy 账号来跑。若将来有证据表明
 * Go 的路由严格受其模型目录约束（目录里只出现它能服务的 Provider），可以收紧成
 * 「目录 owner 级」判定 —— host 已经在解析 `/v1/models` 的 `owned_by`（= 厂商名），
 * 但那条依赖 Go 内部路由语义，未取证前不用。
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
 *  - 推理条目且 Fabric 远端网关在线：Fabric 按模型/Provider 路由到远端节点只发生在 Node
 *    v1 路由里（钉选请求 Node 本身也不走 Fabric，因此只对未钉选请求交还）。
 *  - 推理条目的模型命中启用的 Node 别名（input.aliases，钉选请求 Node 也不用别名）。
 *  - 自定义错误规则：Go 未承接该账号的规则时，交还 Node 求值（见下方作用域说明）。
 */
function explainGoRouteDeferral(input = {}) {
  const deferred = (reason) => ({ defer: true, reason });
  // blob 只存在于生成它的那一侧进程内仓：Node 仓里有这个 id 就由 Node 返回，否则交给 Go。
  if (input.entryId === BLOB_ENTRY_ID) {
    const pathname = String(input.pathname || '');
    const id = pathname.startsWith(BLOB_PATH_PREFIX) ? pathname.slice(BLOB_PATH_PREFIX.length) : '';
    const lookup = typeof input.getNodeBlob === 'function' ? input.getNodeBlob : getImageBlob;
    return id && lookup(id) ? deferred('node_blob') : FORWARDED;
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
      const pinnedProvider = String((pinned.resolvedPin && pinned.resolvedPin.provider) || '');
      if (goInferenceChannel(pinnedProvider, input.entryId) === GO_INFERENCE_CHANNEL_RELAY) {
        const pinnedAccount = pinned.resolvedPin && pinned.resolvedPin.account;
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
  // 未钉选请求可能跨 Provider / 别名回落到池里任意账号，所以规则作用域是整个运行池：
  // 只要池里存在一个 Go 未承接的规则账号，请求就可能落到它身上，必须交还 Node 求值。
  if (INFERENCE_ENTRIES.has(input.entryId)
    && hasUnacceptedEnabledRules(input.state && input.state.accounts || {}, ruleAcceptedRefs, goRefFor)) {
    return deferred('account_error_rules');
  }
  // 同理，池里只要有一个 Provider 在该入口上是 Go 服务不了的（没有上游/透传未挂载），未钉选
  // 请求就可能落到它身上 —— 必须整体交还 Node，否则表现为「同一个模型，有时 200 有时 503」。
  if (INFERENCE_ENTRIES.has(input.entryId) && poolHasNonGoServableProvider(input.state, input.entryId)) {
    return deferred('pool_has_non_go_servable_provider');
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
