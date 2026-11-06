'use strict';

// 账号 token 用量（day/week/month/total + 分模型）的**调试对拍入口**。
//
// 为什么这个入口只认 ?source=go：
//   它不是正式契约，只是切流阶段用来「同一账号、同一时刻，Node 行里的 tokenUsage
//   与 Go 的 usage_ledger 结论是否一致」的取证入口。一旦不带参数也能返回数据，
//   就会有调用方把它当成稳定 API 依赖，把 Go 的原始形状（snake_case 的 from_ms /
//   to_ms、cost_known、成本恒为 null）固化到前端或脚本里；之后 Go 改字段就变成了
//   破坏性变更，而它本来只是内部诊断面。
//   所以缺 source 一律 400：调用方必须显式声明「我在要 Go 的原始结果」。
//   正式数据面仍是账号行里的 tokenUsage（装配在 webui-account-live.js）。
//
// 鉴权沿用 /v0/webui/* 的统一管理密钥门（见 webui-auth-gate.js）：能到这里就说明
// 请求已经带过当前 Management Key，本文件不再重复校验，避免出现第二套鉴权口径。

const { resolveAccountRef } = require('./account-ref-store');

const TOKEN_USAGE_PATTERN = /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/token-usage$/;

function writeNoStoreHeaders(res) {
  if (!res || typeof res.setHeader !== 'function') return;
  res.setHeader('cache-control', 'no-store');
  res.setHeader('pragma', 'no-cache');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
}

function decodePathValue(value) {
  try {
    return decodeURIComponent(String(value || '')).trim();
  } catch (_error) {
    return '';
  }
}

async function handleWebUiAccountTokenUsageRoutes(ctx) {
  const match = String(ctx.pathname || '').match(TOKEN_USAGE_PATTERN);
  if (!match) return false;

  writeNoStoreHeaders(ctx.res);

  if (ctx.method !== 'GET') {
    ctx.writeJson(ctx.res, 405, {
      ok: false,
      error: 'method_not_allowed',
      message: 'Method not allowed'
    });
    return true;
  }

  const provider = decodePathValue(match[1]).toLowerCase();
  const accountRef = decodePathValue(match[2]);
  if (!provider || !accountRef) {
    ctx.writeJson(ctx.res, 400, {
      ok: false,
      error: 'invalid_token_usage_path',
      message: '无效的 token 用量路径'
    });
    return true;
  }

  // 先判 source 再查账号：没有 source 的请求本身就不是这个入口的合法用法，
  // 没必要为它读一遍账号索引，也避免 404 把「参数错」伪装成「账号不存在」。
  const searchParams = ctx.url && ctx.url.searchParams ? ctx.url.searchParams : null;
  const source = String(searchParams ? searchParams.get('source') || '' : '').trim().toLowerCase();
  if (source !== 'go') {
    ctx.writeJson(ctx.res, 400, {
      ok: false,
      error: 'source_required',
      message: '这是对拍调试入口，必须显式带 ?source=go 才会返回 Go 的原始结果'
    });
    return true;
  }

  const fs = ctx.fs || (ctx.deps && ctx.deps.fs) || require('node:fs');
  const aiHomeDir = ctx.aiHomeDir || (ctx.deps && ctx.deps.aiHomeDir) || '';

  const account = resolveAccountRef(fs, aiHomeDir, accountRef, { bestEffort: true });
  if (!account || (account.provider && account.provider.toLowerCase() !== provider)) {
    ctx.writeJson(ctx.res, 404, {
      ok: false,
      error: 'account_not_found',
      message: `未找到 ${provider} 账号 ${accountRef}`
    });
    return true;
  }

  const goHost = ctx.deps && ctx.deps.goCoreSync;
  if (!goHost || typeof goHost.getAccountTokenUsage !== 'function') {
    ctx.writeJson(ctx.res, 503, { ok: false, error: 'go_core_unavailable' });
    return true;
  }

  const response = await goHost.getAccountTokenUsage(accountRef);
  if (!response || response.ok !== true) {
    // 不做本地回落：这个入口存在的意义就是「Go 说了什么」，回落成 Node 的数会把
    // 对拍结论变成假一致。
    ctx.writeJson(ctx.res, (response && response.status) || 502, {
      ok: false,
      error: (response && response.errorCode) || 'go_token_usage_failed'
    });
    return true;
  }
  ctx.writeJson(ctx.res, 200, { ok: true, go: response.data });
  return true;
}

module.exports = {
  TOKEN_USAGE_PATTERN,
  handleWebUiAccountTokenUsageRoutes
};
