'use strict';

// GET /v0/webui/account-outcomes：账号页状态条（90 天按天 + 最近 24 小时按小时）。
// 数据来自 Go 的账号结果时间桶；Go 未就绪或未返回时回 503，前端据此隐藏状态区。

const { buildAccountOutcomesView, buildDayStarts, buildHourStarts } = require('./account-outcomes-view');
const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');

function listNodeAccountRefs(state) {
  const refs = [];
  for (const provider of SUPPORTED_SERVER_PROVIDERS) {
    const pool = state && state.accounts && Array.isArray(state.accounts[provider]) ? state.accounts[provider] : [];
    for (const account of pool) {
      const ref = String(account && account.accountRef || '').trim();
      if (ref) refs.push(ref);
    }
  }
  return refs;
}

async function handleWebUiAccountOutcomesRoute(ctx) {
  const { method, pathname, res, state, deps = {} } = ctx;
  if (method !== 'GET' || pathname !== '/v0/webui/account-outcomes') return false;
  const writeJson = ctx.writeJson || deps.writeJson;
  const list = typeof deps.listGoAccountOutcomes === 'function' ? deps.listGoAccountOutcomes : null;
  if (!list) {
    writeJson(res, 503, { ok: false, error: 'account_outcomes_unavailable' });
    return true;
  }
  const nowMs = Date.now();
  const [dayRows, hourRows] = await Promise.all([
    list('day', buildDayStarts(nowMs)[0]),
    list('hour', buildHourStarts(nowMs)[0])
  ]);
  if (!dayRows || !hourRows) {
    writeJson(res, 503, { ok: false, error: 'account_outcomes_unavailable' });
    return true;
  }
  writeJson(res, 200, {
    ok: true,
    data: buildAccountOutcomesView({
      dayRows,
      hourRows,
      nodeAccountRefs: listNodeAccountRefs(state),
      goAccountRefFor: deps.goAccountRefFor,
      nowMs
    })
  });
  return true;
}

module.exports = { handleWebUiAccountOutcomesRoute };
