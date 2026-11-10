'use strict';

// WebUI 数据面：账号 × 模型的**上下文窗口**查看与设置。
//
// 读写都固定走 Go（webuimodelcontextapi）：
//   - 解析优先级：手动覆盖 > 上游探测 > models.dev 目录 > unknown；
//   - 写入是 app-state "config:model-context-overrides" 的唯一写者；
//   - Node 只保留浏览器路径与 400/404/409 透传，不再本地读写覆盖表。
//
// 维度刻意是「账号 × 模型」：同 provider 下中转/OAuth/API Key 的真实窗口不同。

// 单账号读写：/v0/webui/accounts/:provider/:accountRef/model-context
const ACCOUNT_ROUTE_PATTERN = /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/model-context$/;
// 批量写入：/v0/webui/accounts/:provider/model-context/bulk
const BULK_ROUTE_PATTERN = /^\/v0\/webui\/accounts\/([^/]+)\/model-context\/bulk$/;

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

function writeProxyFailure(ctx, response) {
  const status = Number(response && response.status) || 0;
  if ((status === 400 || status === 404 || status === 409) && response && response.data) {
    ctx.writeJson(ctx.res, status, response.data);
    return;
  }
  ctx.writeJson(ctx.res, 503, {
    ok: false,
    error: String((response && response.data && response.data.error) || (response && response.errorCode) || 'go_core_unavailable'),
    message: 'Go Core 未就绪，模型上下文不可用'
  });
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

  const goHost = ctx.deps && ctx.deps.goCoreSync;
  if (!goHost) {
    ctx.writeJson(ctx.res, 503, { ok: false, error: 'go_core_unavailable', message: 'Go Core 未就绪，模型上下文不可用' });
    return true;
  }

  let response = null;
  try {
    if (bulkMatch) {
      const body = await readJsonBody(ctx);
      if (!body) {
        ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_json_body' });
        return true;
      }
      response = typeof goHost.setAccountModelContextBulk === 'function'
        ? await goHost.setAccountModelContextBulk(provider, body)
        : null;
		} else {
			const accountRef = decodeSegment(accountMatch[2]);
			if (method === 'GET') {
				const models = String(ctx.url && ctx.url.searchParams && ctx.url.searchParams.get('models') || '').trim();
				response = typeof goHost.getAccountModelContext === 'function'
					? await goHost.getAccountModelContext(provider, accountRef, models)
					: null;
			} else if (method === 'DELETE') {
				const model = String(ctx.url && ctx.url.searchParams && ctx.url.searchParams.get('model') || '').trim();
				response = typeof goHost.clearAccountModelContext === 'function'
					? await goHost.clearAccountModelContext(provider, accountRef, model)
					: null;
			} else {
        const body = await readJsonBody(ctx);
        if (!body) {
          ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_json_body' });
          return true;
        }
        response = typeof goHost.setAccountModelContext === 'function'
          ? await goHost.setAccountModelContext(provider, accountRef, body)
          : null;
      }
    }
  } catch (_error) {
    response = null;
  }

  if (response && response.ok === true && response.data) {
    ctx.writeJson(ctx.res, 200, response.data);
    return true;
  }
  writeProxyFailure(ctx, response);
  return true;
}

module.exports = {
  ACCOUNT_ROUTE_PATTERN,
  BULK_ROUTE_PATTERN,
  handleModelContextRequest
};
