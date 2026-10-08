'use strict';

// 已划给 Go 的条目在哪些请求上仍交还 Node 处理（Go Core 转发前的宿主判定）。
// 目标：划转不改变客户端可观察语义——Go 只接它能按 Node 同样语义完成的请求。

const { INFERENCE_ENTRY_IDS } = require('./go-core-route-ownership');
const { resolvePinnedAccount } = require('./pinned-account');
const { getImageBlob } = require('./image-blob-store');

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

function needsRequestModel(entryId) {
  return INFERENCE_ENTRIES.has(entryId);
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
  if (pinnedAccountRef) {
    if (!resolvePinnedAccount(input.state, input.accountStateIndex, pinnedAccountRef).usable) {
      return deferred('pinned_account_unusable');
    }
    // 迁移时有账号在 Go 里换了 id（rekey / 同身份合并）：钉选头里是 Node id，Go 不认识。
    // 没有 Node→Go 映射的钉选交还 Node；有映射的由转发层改写成 Go id。
    if (typeof input.goAccountRefFor === 'function' && !input.goAccountRefFor(pinnedAccountRef)) {
      return deferred('pinned_account_unmapped');
    }
    // 钉选请求同样只在 Go 能路由该模型时转发（2026-09-27 codex gpt-6-astra 只在 Go 已停用账号上）。
    if (INFERENCE_ENTRIES.has(input.entryId) && input.model && typeof input.goRoutableModelIds === 'function') {
      const ids = input.goRoutableModelIds();
      if (!ids || !ids.has(input.model)) return deferred('pinned_model_not_routable');
    }
    return FORWARDED;
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
