'use strict';

const { listAccountQuotaResetEvents } = require('../account/quota-reset-store');
const { resolveAccountRef } = require('./account-ref-store');

const RESET_EVENTS_PATTERN = /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/(?:quota-reset-events|reset-history)$/;

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

async function handleWebUiAccountQuotaResetRoutes(ctx) {
  const match = String(ctx.pathname || '').match(RESET_EVENTS_PATTERN);
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
      error: 'invalid_quota_reset_events_path',
      message: '无效的账号重置历史路径'
    });
    return true;
  }

  const fs = ctx.fs || (ctx.deps && ctx.deps.fs) || require('node:fs');
  const aiHomeDir = ctx.aiHomeDir || (ctx.deps && ctx.deps.aiHomeDir) || '';

  // Verify account exists
  const account = resolveAccountRef(fs, aiHomeDir, accountRef, { bestEffort: true });
  if (!account || (account.provider && account.provider.toLowerCase() !== provider)) {
    ctx.writeJson(ctx.res, 404, {
      ok: false,
      error: 'account_not_found',
      message: `未找到 ${provider} 账号 ${accountRef}`
    });
    return true;
  }

  const limitParam = ctx.url && ctx.url.searchParams ? ctx.url.searchParams.get('limit') : null;
  const beforeIdParam = ctx.url && ctx.url.searchParams ? ctx.url.searchParams.get('beforeId') : null;

  const limit = Math.max(1, Math.min(200, Number(limitParam) || 50));
  const beforeId = beforeIdParam ? Number(beforeIdParam) : null;

  try {
    const events = listAccountQuotaResetEvents(fs, aiHomeDir, accountRef, {
      limit,
      beforeId
    });

    ctx.writeJson(ctx.res, 200, {
      ok: true,
      provider,
      accountRef,
      events
    });
    return true;
  } catch (error) {
    ctx.writeJson(ctx.res, 500, {
      ok: false,
      error: 'list_quota_reset_events_failed',
      message: String(error && error.message || error)
    });
    return true;
  }
}

module.exports = {
  handleWebUiAccountQuotaResetRoutes
};
