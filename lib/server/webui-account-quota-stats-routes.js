'use strict';

// 账号额度统计（5h / 7天 / 30天）的 WebUI 前门。
//
// 计算已经全部切到 Go：窗口重建（Node 的 quota-window-reconstruction 同源算法）、
// 维度选择、用量聚合、成本计算都在 Go 完成。Node 这里只做三件事：
//   1. 路径解析与账号存在性校验（404 的语义属于 WebUI，不属于管理接口）；
//   2. 查询参数翻译（window / scope / rangeDays → range_days）；
//   3. snake_case → camelCase 的契约映射（见 quota-stats-go-contract.js）。
//
// 没有本地回落：回落等于保留第二套算法，两套口径一旦分叉就再也对不上。

const { resolveAccountRef } = require('./account-ref-store');
const {
  mapQuotaStatsPayload,
  buildQuotaStatsSearch
} = require('./quota-stats-go-contract');

const QUOTA_STATS_PATTERN = /^\/v0\/webui\/accounts\/([^/]+)\/([^/]+)\/quota-stats$/;

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

async function handleWebUiAccountQuotaStatsRoutes(ctx) {
  const match = String(ctx.pathname || '').match(QUOTA_STATS_PATTERN);
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
      error: 'invalid_quota_stats_path',
      message: '无效的额度统计路径'
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
  if (!goHost
    || typeof goHost.getQuotaStats !== 'function'
    || typeof goHost.isEnabled !== 'function'
    || !goHost.isEnabled()) {
    ctx.writeJson(ctx.res, 503, {
      ok: false,
      error: 'go_core_required',
      message: '额度统计已切换到 Go Core，当前 Go Core 不可用。'
    });
    return true;
  }

  const searchParams = ctx.url && ctx.url.searchParams ? ctx.url.searchParams : null;
  const query = {
    window: searchParams ? searchParams.get('window') : 0,
    scope: searchParams ? searchParams.get('scope') : '',
    rangeDays: searchParams ? searchParams.get('rangeDays') : 0
  };

  let response;
  try {
    response = await goHost.getQuotaStats(accountRef, query);
  } catch (error) {
    ctx.writeJson(ctx.res, 502, {
      ok: false,
      error: 'quota_stats_failed',
      message: String((error && error.message) || error || 'quota_stats_failed')
    });
    return true;
  }

  if (!response || response.ok !== true) {
    const status = response && Number.isFinite(response.status) ? response.status : 0;
    if (status === 404) {
      ctx.writeJson(ctx.res, 404, {
        ok: false,
        error: 'account_not_found',
        message: `Go Core 未找到账号 ${accountRef}`
      });
      return true;
    }
    if (status === 400) {
      ctx.writeJson(ctx.res, 400, {
        ok: false,
        error: 'invalid_quota_stats_query',
        message: '额度统计参数无效（窗口期只支持 300 / 10080 / 43200 分钟）'
      });
      return true;
    }
    ctx.writeJson(ctx.res, 502, {
      ok: false,
      error: response && response.errorCode || 'quota_stats_failed',
      message: 'Go Core 额度统计失败'
    });
    return true;
  }

  const payload = mapQuotaStatsPayload(response.data, { provider, accountRef });
  if (!payload) {
    ctx.writeJson(ctx.res, 502, {
      ok: false,
      error: 'quota_stats_empty',
      message: 'Go Core 返回的额度统计为空'
    });
    return true;
  }

  // buildQuotaStatsSearch 与这里用的是同一份参数翻译，避免「发出去」和「记日志」两套规则。
  ctx.writeJson(ctx.res, 200, payload);
  return true;
}

module.exports = {
  QUOTA_STATS_PATTERN,
  buildQuotaStatsSearch,
  handleWebUiAccountQuotaStatsRoutes
};

