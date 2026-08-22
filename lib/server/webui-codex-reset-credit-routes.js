'use strict';

const LIST_PATTERN = /^\/v0\/webui\/accounts\/codex\/([^/]+)\/reset-credits$/;
const CONSUME_PATTERN = /^\/v0\/webui\/accounts\/codex\/([^/]+)\/reset-credits\/consume$/;
const OPERATION_PATTERN = /^\/v0\/webui\/accounts\/codex\/([^/]+)\/reset-operations\/([^/]+)$/;
const RECONCILE_PATTERN = /^\/v0\/webui\/accounts\/codex\/([^/]+)\/reset-operations\/([^/]+)\/reconcile$/;

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

async function readJsonBody(ctx) {
  const readRequestBody = ctx.readRequestBody || (ctx.deps && ctx.deps.readRequestBody);
  if (typeof readRequestBody !== 'function') return null;
  try {
    const body = await readRequestBody(ctx.req, { maxBytes: 32 * 1024 });
    return body && body.length > 0 ? JSON.parse(body.toString('utf8')) : {};
  } catch (_error) {
    return null;
  }
}

function writeError(ctx, error) {
  const code = String(error && error.code || 'codex_reset_request_failed');
  const statusCode = Number(error && error.statusCode) || 500;
  const message = String(error && error.message || code);
  ctx.writeJson(ctx.res, statusCode, {
    ok: false,
    error: code,
    message
  });
}

function resolveRoute(pathname) {
  const patterns = [
    ['reconcile', RECONCILE_PATTERN],
    ['operation', OPERATION_PATTERN],
    ['consume', CONSUME_PATTERN],
    ['list', LIST_PATTERN]
  ];
  for (const [kind, pattern] of patterns) {
    const match = String(pathname || '').match(pattern);
    if (!match) continue;
    const accountRef = decodePathValue(match[1]);
    const operationId = decodePathValue(match[2]);
    return accountRef ? { kind, accountRef, operationId } : { invalid: true };
  }
  return null;
}

async function handleWebUiCodexResetCreditRoutes(ctx) {
  const route = resolveRoute(ctx.pathname);
  if (!route) return false;
  writeNoStoreHeaders(ctx.res);
  if (route.invalid) {
    ctx.writeJson(ctx.res, 400, {
      ok: false,
      error: 'invalid_codex_reset_credit_path',
      message: 'Codex 重置卡路径无效'
    });
    return true;
  }
  const service = ctx.deps && ctx.deps.codexResetCreditService;
  if (!service) {
    ctx.writeJson(ctx.res, 503, {
      ok: false,
      error: 'codex_reset_service_unavailable',
      message: 'Codex 重置服务不可用'
    });
    return true;
  }

  try {
    if (route.kind === 'list' && ctx.method === 'GET') {
      const result = await service.list(route.accountRef);
      ctx.writeJson(ctx.res, 200, { ok: true, ...result });
      return true;
    }
    if (route.kind === 'consume' && ctx.method === 'POST') {
      const body = await readJsonBody(ctx);
      if (!body || !body.operationId || !body.inventoryVersion) {
        ctx.writeJson(ctx.res, 400, {
          ok: false,
          error: 'invalid_codex_reset_consume_payload',
          message: '重置操作 ID 或库存版本缺失'
        });
        return true;
      }
      const result = await service.consume({
        accountRef: route.accountRef,
        operationId: String(body.operationId).trim(),
        inventoryVersion: String(body.inventoryVersion).trim()
      });
      ctx.writeJson(ctx.res, result.reconciliationRequired ? 202 : 200, {
        ok: true,
        ...result
      });
      return true;
    }
    if (route.kind === 'operation' && ctx.method === 'GET') {
      const operation = service.getOperation({
        accountRef: route.accountRef,
        operationId: route.operationId
      });
      ctx.writeJson(ctx.res, 200, { ok: true, operation });
      return true;
    }
    if (route.kind === 'reconcile' && ctx.method === 'POST') {
      const result = await service.reconcile({
        accountRef: route.accountRef,
        operationId: route.operationId
      });
      ctx.writeJson(ctx.res, result.reconciliationRequired ? 202 : 200, {
        ok: true,
        ...result
      });
      return true;
    }
    ctx.writeJson(ctx.res, 405, {
      ok: false,
      error: 'method_not_allowed',
      message: '不支持的 Codex 重置卡操作'
    });
    return true;
  } catch (error) {
    writeError(ctx, error);
    return true;
  }
}

module.exports = {
  handleWebUiCodexResetCreditRoutes
};
