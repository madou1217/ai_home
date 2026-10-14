'use strict';

// 账号页状态条的数据视图：把 Go 的账号结果时间桶（按 Go 账号 ref）组装成 WebUI 契约。
//
// 契约（GET /v0/webui/account-outcomes）：
//   { generatedAt, dayStarts[90], hourStarts[24],
//     accounts: [{ accountRef, days: [{startMs, success, failures:{kind:n}}], hours: [...] }] }
// dayStarts/hourStarts 是本地时区桶起点（升序，最后一个是今天/当前小时）；days/hours 稀疏，
// 只含有数据的桶。一个 Go 账号可能对应多个 Node 账号（迁移时同身份合并），它们共享同一组计数。

const DAY_COUNT = 90;
const HOUR_COUNT = 24;
const HOUR_MS = 60 * 60 * 1000;

function localDayStart(ms) {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function localHourStart(ms) {
  const date = new Date(ms);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()).getTime();
}

function buildDayStarts(nowMs) {
  const today = new Date(localDayStart(nowMs));
  const starts = [];
  for (let offset = DAY_COUNT - 1; offset >= 0; offset -= 1) {
    starts.push(new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset).getTime());
  }
  return starts;
}

function buildHourStarts(nowMs) {
  const current = localHourStart(nowMs);
  const starts = [];
  for (let offset = HOUR_COUNT - 1; offset >= 0; offset -= 1) starts.push(current - offset * HOUR_MS);
  return starts;
}

// 把 Go 行 [{account_ref, bucket_start_ms, outcome, count}] 聚成每账号的稀疏桶。
function groupRows(rows, fromMs) {
  const byAccount = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const ref = String(row && row.account_ref || '');
    const startMs = Number(row && row.bucket_start_ms);
    const count = Number(row && row.count) || 0;
    const outcome = String(row && row.outcome || '');
    if (!ref || !Number.isFinite(startMs) || startMs < fromMs || count <= 0 || !outcome) continue;
    if (!byAccount.has(ref)) byAccount.set(ref, new Map());
    const buckets = byAccount.get(ref);
    if (!buckets.has(startMs)) buckets.set(startMs, { startMs, success: 0, failures: {} });
    const bucket = buckets.get(startMs);
    if (outcome === 'success') bucket.success += count;
    else bucket.failures[outcome] = (bucket.failures[outcome] || 0) + count;
  }
  return byAccount;
}

function sortedBuckets(map) {
  return map ? [...map.values()].sort((a, b) => a.startMs - b.startMs) : [];
}

/**
 * 合并两路来源的同账号桶：Go 承接的计数 + Node 承接的计数。
 * 任一路缺失时原样返回另一路，保证没有 Node 侧数据时行为与从前完全一致。
 */
function mergeBuckets(primary, extra) {
  if (!extra || extra.size === 0) return primary;
  if (!primary || primary.size === 0) return extra;
  const merged = new Map(primary);
  for (const [startMs, bucket] of extra) {
    const target = merged.get(startMs);
    if (!target) {
      merged.set(startMs, bucket);
      continue;
    }
    target.success += bucket.success;
    for (const [kind, count] of Object.entries(bucket.failures || {})) {
      target.failures[kind] = (target.failures[kind] || 0) + count;
    }
  }
  return merged;
}

/**
 * @param {object} input
 * @param {Array} input.dayRows Go 日粒度行（按 Go 账号 ref）
 * @param {Array} input.hourRows Go 小时粒度行（按 Go 账号 ref）
 * @param {Array} [input.nodeDayRows] Node 承接流量的日粒度行（按 Node 账号 ref）
 * @param {Array} [input.nodeHourRows] Node 承接流量的小时粒度行（按 Node 账号 ref）
 * @param {Array<string>} input.nodeAccountRefs Node 账号列表
 * @param {(nodeRef: string) => string} input.goAccountRefFor Node→Go 账号映射
 * @param {number} input.nowMs
 */
function buildAccountOutcomesView(input = {}) {
  const nowMs = Number(input.nowMs) || Date.now();
  const dayStarts = buildDayStarts(nowMs);
  const hourStarts = buildHourStarts(nowMs);
  const days = groupRows(input.dayRows, dayStarts[0]);
  const hours = groupRows(input.hourRows, hourStarts[0]);
  // Go 只记它自己承接的流量；交还 Node 的请求（自定义错误协议、Go 重启窗口等）由 Node 记，
  // 否则账号页状态条会在交还期间"冻结"。
  const nodeDays = groupRows(input.nodeDayRows, dayStarts[0]);
  const nodeHours = groupRows(input.nodeHourRows, hourStarts[0]);
  const mapRef = typeof input.goAccountRefFor === 'function' ? input.goAccountRefFor : (ref) => ref;
  const accounts = [];
  for (const nodeRef of Array.isArray(input.nodeAccountRefs) ? input.nodeAccountRefs : []) {
    const goRef = mapRef(nodeRef) || '';
    const dayBuckets = mergeBuckets(goRef ? days.get(goRef) : null, nodeDays.get(nodeRef));
    const hourBuckets = mergeBuckets(goRef ? hours.get(goRef) : null, nodeHours.get(nodeRef));
    if (!dayBuckets && !hourBuckets) continue;
    accounts.push({ accountRef: nodeRef, days: sortedBuckets(dayBuckets), hours: sortedBuckets(hourBuckets) });
  }
  return { generatedAt: nowMs, dayStarts, hourStarts, accounts };
}

module.exports = {
  DAY_COUNT,
  HOUR_COUNT,
  buildAccountOutcomesView,
  buildDayStarts,
  buildHourStarts
};
