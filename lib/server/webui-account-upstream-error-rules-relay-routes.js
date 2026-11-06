'use strict';

// 账号级上游错误规则的「导入 / 对拍读取」中转路由。
//
//   GET  /v0/webui/account-upstream-error-rules         读取 Go 当前的账号级配置
//   POST /v0/webui/account-upstream-error-rules/import  让 Node 把当前配置强制推给 Go
//
// 为什么必须走 Node 中转：Go 的 management key 由 Node 启动时生成，不落盘、不对外，
// 唯一持有者是进程内的 goCoreSync。让 scripts/import-account-upstream-error-rules.js
// 直连 Go 就得把密钥写进磁盘或环境变量，泄漏面比「多一跳」大得多。
//
// 导入本身复用正常推送路径（force 绕过内容未变的跳过），不在这里重复实现规则校验：
// 「哪些账号有配置、规则是否可忠实投影」只有一个事实来源。

const COLLECTION_PATH = '/v0/webui/account-upstream-error-rules';
const IMPORT_PATH = COLLECTION_PATH + '/import';

// 管理客户端在响应带 data 包装时已经把内层放进 data；两种形状都接受。
function responseBody(response) {
  const data = response && response.data;
  if (data && typeof data === 'object') {
    return data.data && typeof data.data === 'object' ? data.data : data;
  }
  const body = response && response.body;
  if (body && typeof body === 'object') {
    return body.data && typeof body.data === 'object' ? body.data : body;
  }
  return null;
}

function upstreamStatus(response) {
  const status = Number(response && response.status) || 0;
  return status >= 400 ? status : 502;
}

async function handleGetRules(ctx, goHost) {
  if (typeof goHost.listAccountUpstreamErrorRules !== 'function') {
    ctx.writeJson(ctx.res, 503, { ok: false, error: 'go_core_unavailable' });
    return true;
  }
  const response = await goHost.listAccountUpstreamErrorRules();
  const body = response && response.ok === true ? responseBody(response) : null;
  if (!body) {
    ctx.writeJson(ctx.res, upstreamStatus(response), {
      ok: false,
      error: (response && response.errorCode) || 'go_core_unavailable'
    });
    return true;
  }
  const accounts = (Array.isArray(body.accounts) ? body.accounts : []).map((account) => {
    const goRef = String(account && account.account_ref || '').trim();
    let nodeRef = goRef;
    // 账号同步 rekey 后 Go 引用与 Node 引用不同；对拍脚本按 Node 引用看结果。
    if (goRef && typeof goHost.nodeAccountRefFor === 'function') {
      try { nodeRef = String(goHost.nodeAccountRefFor(goRef) || '').trim() || goRef; } catch (_error) {}
    }
    return { ...account, node_account_ref: nodeRef };
  });
  ctx.writeJson(ctx.res, 200, {
    ok: true,
    generation: Number(body.generation) || 0,
    supported_providers: Array.isArray(body.supported_providers) ? body.supported_providers : [],
    accounts
  });
  return true;
}

async function handleImportRules(ctx, goHost) {
  if (typeof goHost.pushUpstreamErrorRules !== 'function') {
    ctx.writeJson(ctx.res, 503, { ok: false, error: 'go_core_unavailable' });
    return true;
  }
  const result = await goHost.pushUpstreamErrorRules({ force: true });
  if (!result || result.ok !== true) {
    ctx.writeJson(ctx.res, 502, {
      ok: false,
      error: (result && result.errorCode) || 'go_core_unavailable'
    });
    return true;
  }
  ctx.writeJson(ctx.res, 200, {
    ok: true,
    pushed: Number(result.pushed) || 0,
    accepted: Number(result.accepted) || 0,
    failed: Number(result.failed) || 0,
    dropped: Number(result.dropped) || 0,
    droppedReasons: Array.isArray(result.droppedReasons) ? result.droppedReasons : [],
    skippedAccounts: Array.isArray(result.skippedAccounts) ? result.skippedAccounts : []
  });
  return true;
}

async function handleWebUiAccountUpstreamErrorRulesRelayRoutes(ctx) {
  const { method, pathname } = ctx;
  if (pathname !== COLLECTION_PATH && pathname !== IMPORT_PATH) return false;
  const goHost = ctx.deps && ctx.deps.goCoreSync;
  if (!goHost) {
    ctx.writeJson(ctx.res, 503, { ok: false, error: 'go_core_unavailable' });
    return true;
  }
  if (pathname === COLLECTION_PATH) {
    if (method !== 'GET') {
      ctx.writeJson(ctx.res, 405, { ok: false, error: 'method_not_allowed' });
      return true;
    }
    return handleGetRules(ctx, goHost);
  }
  if (method !== 'POST') {
    ctx.writeJson(ctx.res, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }
  return handleImportRules(ctx, goHost);
}

module.exports = {
  COLLECTION_PATH,
  IMPORT_PATH,
  handleWebUiAccountUpstreamErrorRulesRelayRoutes
};
