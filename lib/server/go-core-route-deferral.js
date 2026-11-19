'use strict';

// 推理入口的归属判定。所有推理入口已由 Go 承接；此模块保留兼容导出，
// 不再把请求交还给其它宿主。

const { INFERENCE_ENTRY_IDS } = require('./go-core-route-ownership');
const { resolvePinnedAccount } = require('./pinned-account');
const {
  goInferenceChannel,
  goServesInference,
  GO_INFERENCE_CHANNEL_CANONICAL,
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



const INFERENCE_ENTRIES = new Set(INFERENCE_ENTRY_IDS);

// 生图入口：Go 有独立的完整实现（判据见 explainPoolDeferral 的图片分支）。
const IMAGE_ENTRY_IDS = new Set([
  'gateway.images.generations',
  'gateway.images.edits'
]);

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
 * Go Core 的 native quota / failure state 不能归因给第三方或另一台 AIH
 * gateway 的 API Key 账号。Node 已经拥有完整的 custom-upstream 语义和
 * relay 头部处理，因此**钉选到这类账号**的请求必须留在 Node。
 *
 * 只用于钉选分支：钉选是独占路由，Go 会忽略自己的路由排除、按 x-account-ref
 * 直接打到被钉账号上，所以排除标记兜不住这条路径。
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
 * 历史池门说明。当前推理入口全部由 Go 承接，本文件不再产生交还。
 *
 * 旧语义仅保留作迁移史说明。
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
 *
 * 生图入口（IMAGE_ENTRY_IDS）例外，判据换成「承载者都有 Go 的图片实现」：那条
 * canonical/relay 的收窄针对的是**推理协议桥**（Go 侧要跨协议转换、要跟随 Node 的
 * 目录与窗口门），生图在 Go 侧是另一支完整实现（透传 / codex / agy 三支策略 + 自己的
 * 换号链、流式、同源回取、用量与账号结果），不存在「两侧选中不同 Provider」的分叉。
 * 反过来若沿用推理池门，只要池里有一个没有图片实现的 Provider（kiro / zcode /
 * codebuddy 都是），生图就整体留在 Node —— 这条 Go 路径在真机上永远走不到。
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
  // 判据统一成「这个模型的承载者是不是全都能被 Go 服务」。
  //
  // 旧口径只放行「承载者全为 relay 通道」：只要池里有一个 Go 不认识的 Provider（本机是
  // gemini），claude / codex / agy 的 canonical 模型也全部留在 Node——真机表现为
  // 「池里有 gemini 账号 ⇒ claude 请求不增长 usage_ledger」。canonical 通道比 relay
  // 更强（Go 有自己的上游适配器），没有理由被排除在外。
  const allServable = carriers.every((provider) => goServesInference(provider, input.entryId));
  return allServable ? '' : 'pool_has_non_go_servable_provider';
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
 * 推理归属判定。当前所有推理入口都由 Go 承接，函数始终返回转发。
 *
 * 历史原因清单（仅兼容计数，不再触发）：
 *  - 钉选头存在但钉选不可用/格式非法/未知：Node 负责回落常池、403 pinned_account_unavailable、
 *    404 unknown_account_ref 或 400 invalid_account_ref；Go 只会一律 503，语义会变。
 *    可用钉选照常转发，Go 以 x-account-ref 独占路由到同一账号。
 *  - 显式 Provider 选择（x-provider 头）已由 Go 读取并按 Provider 过滤路由。
 *  - 模型命名空间头已由 Go 在 Canonical 入口补全。
 *  - 持久别名与插件 catalog 别名已由 Go 路由目录编译。
 *  - 会话级模型改写（x-aih-model-alias 或 /-/ma/ 路径前缀）已由 Go 应用。
 *  - 自定义错误规则由 Go 的 upstream rule evaluator 承接。
 */
function explainGoRouteDeferral() {
  // 推理入口已全部由 Go 承接：不再按钉选、Provider、模型目录、错误规则、
  // 出口或路由归属头交还。Go 的 Canonical/Relay 通道负责最终结果。
  return FORWARDED;
}

/** 兼容包装；当前始终返回 false（不交还）。 */
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
