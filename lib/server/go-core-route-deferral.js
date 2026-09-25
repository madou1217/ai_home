'use strict';

// 已划给 Go 的条目在哪些请求上仍交还 Node 处理（Go Core 转发前的宿主判定）。
// 目标：划转不改变客户端可观察语义——Go 只接它能按 Node 同样语义完成的请求。

const { INFERENCE_ENTRY_IDS } = require('./go-core-route-ownership');
const { resolvePinnedAccount } = require('./pinned-account');
const { getImageBlob } = require('./image-blob-store');

const BLOB_ENTRY_ID = 'gateway.vision.blobs';
const BLOB_PATH_PREFIX = '/v1/blobs/';

const INFERENCE_ENTRIES = new Set(INFERENCE_ENTRY_IDS);
// Responses 在 Go 上只对 Codex 做过真实验证；经 Responses 驱动 agy/claude 账号（WebUI agy 会话底层
// 是 codex CLI）在 Go 上带 reasoning 会失败（2026-09-25 生产 503），这类请求留在 Node。
const RESPONSES_ENTRIES = new Set(['gateway.openai.responses', 'gateway.openai.responses.websocket']);

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

function needsRequestModel(entryId) {
  return INFERENCE_ENTRIES.has(entryId);
}

/**
 * 返回 true 表示交还 Node：
 *  - 钉选头存在但钉选不可用/格式非法/未知：Node 负责回落常池、403 pinned_account_unavailable、
 *    404 unknown_account_ref 或 400 invalid_account_ref；Go 只会一律 503，语义会变。
 *    可用钉选照常转发，Go 以 x-account-ref 独占路由到同一账号。
 *  - 推理条目且 Fabric 远端网关在线：Fabric 按模型/Provider 路由到远端节点只发生在 Node
 *    v1 路由里（钉选请求 Node 本身也不走 Fabric，因此只对未钉选请求交还）。
 *  - 推理条目的模型命中启用的 Node 别名（input.aliases，钉选请求 Node 也不用别名）。
 */
function shouldDeferGoRouteToNode(input = {}) {
  // blob 只存在于生成它的那一侧进程内仓：Node 仓里有这个 id 就由 Node 返回，否则交给 Go。
  if (input.entryId === BLOB_ENTRY_ID) {
    const pathname = String(input.pathname || '');
    const id = pathname.startsWith(BLOB_PATH_PREFIX) ? pathname.slice(BLOB_PATH_PREFIX.length) : '';
    const lookup = typeof input.getNodeBlob === 'function' ? input.getNodeBlob : getImageBlob;
    return Boolean(id && lookup(id));
  }
  const pinnedAccountRef = String(input.pinnedAccountRef || '').trim();
  if (pinnedAccountRef) {
    const pin = resolvePinnedAccount(input.state, input.accountStateIndex, pinnedAccountRef);
    if (!pin.usable) return true;
    return RESPONSES_ENTRIES.has(input.entryId) && pin.resolvedPin.provider !== 'codex';
  }
  if (RESPONSES_ENTRIES.has(input.entryId) && input.model && typeof input.goModelOwner === 'function'
    && input.goModelOwner(input.model) !== 'openai') {
    return true;
  }
  if (INFERENCE_ENTRIES.has(input.entryId) && typeof input.fabricGatewayReady === 'function'
    && input.fabricGatewayReady()) {
    return true;
  }
  if (!INFERENCE_ENTRIES.has(input.entryId)) return false;
  // 别名（含运行时回落到其它 Provider）只存在于 Node；命中启用别名的请求交还 Node。
  if (modelMatchesEnabledAlias(input.aliases, input.model)) return true;
  // Go 只能路由自己账号库里的模型；其余模型（只有 Node 承接的 Provider）交还 Node。
  // 集合尚未加载时保守交还。无模型的请求（异常体）交给 Go 按协议报错。
  if (input.model && typeof input.goRoutableModelIds === 'function') {
    const ids = input.goRoutableModelIds();
    if (!ids || !ids.has(input.model)) return true;
  }
  return false;
}

module.exports = { modelMatchesEnabledAlias, needsRequestModel, shouldDeferGoRouteToNode };
