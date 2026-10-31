'use strict';

// GET /v0/webui/accounts/:provider/:accountRef/config-files?mode=redacted|raw
// 账号级配置文件只读查看；文件候选全部由 lib/account/account-config-view.js 声明。

const { resolveAccountRef } = require('./account-ref-store');
const { AccountConfigViewError, readAccountConfigFiles } = require('../account/account-config-view');

const CONFIG_FILES_PATTERN = /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/config-files$/;

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

async function handleWebUiAccountConfigViewRoutes(ctx) {
  const match = String(ctx.pathname || '').match(CONFIG_FILES_PATTERN);
  if (!match) return false;
  writeNoStoreHeaders(ctx.res);

  if (ctx.method !== 'GET') {
    ctx.writeJson(ctx.res, 405, { ok: false, error: 'method_not_allowed', message: '仅支持 GET' });
    return true;
  }

  const provider = decodePathValue(match[1]).toLowerCase();
  const accountRef = decodePathValue(match[2]);
  if (!provider || !accountRef) {
    ctx.writeJson(ctx.res, 400, { ok: false, error: 'invalid_account_config_path', message: '无效的账号配置路径' });
    return true;
  }

  const deps = ctx.deps || {};
  const fs = ctx.fs || deps.fs || require('node:fs');
  const aiHomeDir = ctx.aiHomeDir || deps.aiHomeDir || '';
  const account = resolveAccountRef(fs, aiHomeDir, accountRef, { bestEffort: true });
  if (!account || (account.provider && String(account.provider).toLowerCase() !== provider)) {
    ctx.writeJson(ctx.res, 404, { ok: false, error: 'account_not_found', message: `未找到 ${provider} 账号 ${accountRef}` });
    return true;
  }

  const mode = ctx.url && ctx.url.searchParams ? ctx.url.searchParams.get('mode') : '';
  try {
    const result = readAccountConfigFiles(provider, accountRef, {
      fs,
      aiHomeDir,
      mode,
      getProfileDir: ctx.getProfileDir || deps.getProfileDir,
      hostHomeDir: ctx.hostHomeDir || deps.hostHomeDir
    });
    ctx.writeJson(ctx.res, 200, result);
  } catch (error) {
    const known = error instanceof AccountConfigViewError;
    ctx.writeJson(ctx.res, known ? 409 : 500, {
      ok: false,
      error: known ? error.code : 'account_config_read_failed',
      message: String(error && error.message || error)
    });
  }
  return true;
}

module.exports = {
  handleWebUiAccountConfigViewRoutes
};
