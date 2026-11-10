'use strict';

// GET /v0/webui/accounts/:provider/:accountRef/config-files?mode=redacted|raw
// 账号级配置文件只读查看。文件候选、脱敏与 SQLite 导出全部由 Go
// (webuiaccountconfigapi) 承担；Node 只保留浏览器路径、管理密钥门与响应头。

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

  // GET 固定读 Go：账号校验、候选文件、脱敏与 SQLite 导出都在 Go 侧完成。
  const goHost = ctx.deps && ctx.deps.goCoreSync;
  if (!goHost || typeof goHost.getAccountConfigFiles !== 'function') {
    ctx.writeJson(ctx.res, 503, { ok: false, error: 'go_core_unavailable', message: 'Go Core 未就绪，账号配置不可读' });
    return true;
  }
  const mode = ctx.url && ctx.url.searchParams && String(ctx.url.searchParams.get('mode') || '').toLowerCase() === 'raw'
    ? 'raw'
    : 'redacted';
  let response = null;
  try {
    response = await goHost.getAccountConfigFiles(provider, accountRef, mode);
  } catch (_error) {
    response = null;
  }
  if (response && response.ok === true && response.data) {
    ctx.writeJson(ctx.res, 200, response.data);
    return true;
  }
  const status = Number(response && response.status) || 0;
  if ((status === 400 || status === 404) && response && response.data) {
    ctx.writeJson(ctx.res, status, response.data);
    return true;
  }
  ctx.writeJson(ctx.res, 503, {
    ok: false,
    error: String((response && response.data && response.data.error) || (response && response.errorCode) || 'go_core_unavailable'),
    message: 'Go Core 未就绪，账号配置不可读'
  });
  return true;
}

module.exports = {
  handleWebUiAccountConfigViewRoutes
};
