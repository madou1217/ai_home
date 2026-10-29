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
  // Go Core is optional. Node still records the same account outcome buckets
  // while it owns the data plane, so a disabled/unready Go process must not
  // make the WebUI hide health completely.
  // Node 承接流量的结果桶是可选来源：缺失时退回只读 Go（与从前行为一致）。
  const listNode = typeof deps.listNodeAccountOutcomes === 'function' ? deps.listNodeAccountOutcomes : null;
  const nowMs = Date.now();
  const dayFrom = buildDayStarts(nowMs)[0];
  const hourFrom = buildHourStarts(nowMs)[0];
  const [dayRows, hourRows, nodeDayRows, nodeHourRows] = await Promise.all([
    list ? list('day', dayFrom) : null,
    list ? list('hour', hourFrom) : null,
    listNode ? listNode('day', dayFrom) : null,
    listNode ? listNode('hour', hourFrom) : null
  ]);
  if ((!dayRows || !hourRows) && (!nodeDayRows || !nodeHourRows)) {
    writeJson(res, 503, { ok: false, error: 'account_outcomes_unavailable' });
    return true;
  }
  writeJson(res, 200, {
    ok: true,
    data: buildAccountOutcomesView({
      dayRows,
      hourRows,
      nodeDayRows,
      nodeHourRows,
      nodeAccountRefs: listNodeAccountRefs(state),
      goAccountRefFor: deps.goAccountRefFor,
      nowMs
    })
  });
  return true;
}

module.exports = { handleWebUiAccountOutcomesRoute };
