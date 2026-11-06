'use strict';

// POST /v0/webui/usage/backfill：把一批 Node 历史用量转发给 Go 的账本导入端点。
//
// 为什么由 Node 中转：Go 的 management key 是 Node 启动时生成的（不落盘、不对外），
// 唯一持有者就是这里的 goCoreSync。让脚本自己去打 Go 就得把密钥落到磁盘或环境变量里，
// 那是比「多一跳」更大的设计问题。

const PATH = '/v0/webui/usage/backfill';
const MAX_EVENTS = 2000;

function writeJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
}

async function handleWebUiUsageBackfillRoute(ctx) {
  const { req, res, pathname, method } = ctx;
  if (pathname !== PATH) return false;
  if (method !== 'POST') {
    writeJson(res, 405, { ok: false, error: 'method_not_allowed' });
    return true;
  }
  const deps = ctx.deps || {};
  const goHost = deps.goCoreSync;
  if (!goHost || typeof goHost.importUsageEvents !== 'function') {
    writeJson(res, 503, { ok: false, error: 'go_core_unavailable' });
    return true;
  }
  let payload;
  try {
    const raw = await deps.readRequestBody(req, { maxBytes: 8 * 1024 * 1024 });
    payload = JSON.parse(raw.toString('utf8'));
  } catch (_error) {
    writeJson(res, 400, { ok: false, error: 'invalid_request_body' });
    return true;
  }
  const events = Array.isArray(payload && payload.events) ? payload.events : [];
  if (events.length === 0 || events.length > MAX_EVENTS) {
    writeJson(res, 400, { ok: false, error: events.length ? 'too_many_events' : 'events_required' });
    return true;
  }
  const response = await goHost.importUsageEvents(events);
  if (!response || response.ok !== true) {
    writeJson(res, response && response.status ? response.status : 502, {
      ok: false,
      error: (response && response.errorCode) || 'import_failed'
    });
    return true;
  }
  const data = (response.data && response.data.data) || response.data || {};
  // 形状与 Go 的 {data:{imported,skipped}} 对齐：调用方（scripts/backfill-usage-ledger.js）
  // 只认这一种，形状不一致会让「导入了 4.7 万行」显示成 imported=0。
  writeJson(res, 200, { ok: true, data: { imported: Number(data.imported) || 0, skipped: Number(data.skipped) || 0 } });
  return true;
}

module.exports = { handleWebUiUsageBackfillRoute, PATH };
