'use strict';

// WebUI 数据面：账号 × 模型的**上下文窗口**查看与设置。
//
// 读写都固定走 Go（webuimodelcontextapi）：
//   - 解析优先级：手动覆盖 > 上游探测 > models.dev 目录 > unknown；
//   - 写入是 app-state "config:model-context-overrides" 的唯一写者；
//   - Node 只保留浏览器路径与 400/404/409 透传，不再本地读写覆盖表。
//
// 维度刻意是「账号 × 模型」：同 provider 下中转/OAuth/API Key 的真实窗口不同。
// 代理样板（宿主缺失、方法缺失、抛错、状态透传）统一走 webui-go-proxy。

const { proxyGo, writeGoFailure } = require('./webui-go-proxy');

// 单账号读写：/v0/webui/accounts/:provider/:accountRef/model-context
const ACCOUNT_ROUTE_PATTERN = /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/model-context$/;
// 批量写入：/v0/webui/accounts/:provider/model-context/bulk
const BULK_ROUTE_PATTERN = /^\/v0\/webui\/accounts\/([^/]+)\/model-context\/bulk$/;

const UNAVAILABLE_MESSAGE = 'Go Core 未就绪，模型上下文不可用';

function decodeSegment(value) {
  try {
    return decodeURIComponent(value).trim();
  } catch (_error) {
    return '';
  }
}

async function readJsonBody(ctx) {
  if (typeof ctx.readRequestBody !== 'function') return {};
  try {
    const raw = await ctx.readRequestBody(ctx.req);
    return JSON.parse(String(raw || '').trim() || '{}');
  } catch (_error) {
    return null;
  }
}

function searchParam(ctx, name) {
  const params = ctx.url && ctx.url.searchParams;
  return String((params && params.get(name)) || '').trim();
}

/**
 * GET  /v0/webui/accounts/:provider/:accountRef/model-context?models=a,b
 * POST /v0/webui/accounts/:provider/:accountRef/model-context  { model, tokens }
 * POST /v0/webui/accounts/:provider/model-context/bulk         { model, tokens, accountRefs: [...] }
 */
async function handleModelContextRequest(ctx) {
  const { pathname } = ctx;
  const method = String(ctx.method || '').toUpperCase();
  const bulkMatch = BULK_ROUTE_PATTERN.exec(String(pathname || ''));
  const accountMatch = bulkMatch ? null : ACCOUNT_ROUTE_PATTERN.exec(String(pathname || ''));
  if (!bulkMatch && !accountMatch) return false;
  if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') return false;

  const provider = decodeSegment((bulkMatch || accountMatch)[1]);
  if (!provider) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_path' });
    return true;
  }
  if (bulkMatch && method !== 'POST') {
    ctx.writeJson(ctx.res, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }

  // 宿主缺失要在解析请求体之前判定，保持原有的 503 优先于 400 的顺序。
  if (!(ctx.deps && ctx.deps.goCoreSync)) {
    return writeGoFailure(ctx, null, { message: UNAVAILABLE_MESSAGE });
  }

  if (bulkMatch) {
    const body = await readJsonBody(ctx);
    if (!body) {
      ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_json_body' });
      return true;
    }
    return proxyGo(ctx, {
      method: 'setAccountModelContextBulk',
      args: [provider, body],
      message: UNAVAILABLE_MESSAGE
    });
  }

  const accountRef = decodeSegment(accountMatch[2]);
  if (method === 'GET') {
    return proxyGo(ctx, {
      method: 'getAccountModelContext',
      args: [provider, accountRef, searchParam(ctx, 'models')],
      message: UNAVAILABLE_MESSAGE
    });
  }
  if (method === 'DELETE') {
    return proxyGo(ctx, {
      method: 'clearAccountModelContext',
      args: [provider, accountRef, searchParam(ctx, 'model')],
      message: UNAVAILABLE_MESSAGE
    });
  }

  const body = await readJsonBody(ctx);
  if (!body) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_json_body' });
    return true;
  }
  return proxyGo(ctx, {
    method: 'setAccountModelContext',
    args: [provider, accountRef, body],
    message: UNAVAILABLE_MESSAGE
  });
}

module.exports = {
  ACCOUNT_ROUTE_PATTERN,
  BULK_ROUTE_PATTERN,
  handleModelContextRequest
};
