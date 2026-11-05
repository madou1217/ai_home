'use strict';

// WebUI 额度统计的 Go 契约映射。
//
// 为什么需要这一层：Go 的管理接口用 snake_case（它同时服务于非 WebUI 调用方），
// 而 WebUI 的类型定义是 camelCase（web/src/types/index.ts 的 AccountQuotaStatsResponse）。
// 契约转换集中在这一个纯函数里，路由不再拼字段——字段改名时只有一处要改。
//
// 不做「按需挑字段」的白名单：Go 的窗口结构与前端类型一一对应（source/confidence/
// resetKind/classification…），逐个搬运只会制造第二份定义，漏一个就是运行时 undefined。

function toCamelCaseKey(key) {
  return String(key).replace(/_([a-z0-9])/g, (_match, char) => char.toUpperCase());
}

// toCamelCaseKeys 递归转换对象键名；数组逐项转换，原始值原样返回。
function toCamelCaseKeys(value) {
  if (Array.isArray(value)) return value.map((item) => toCamelCaseKeys(item));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[toCamelCaseKey(key)] = toCamelCaseKeys(item);
  }
  return out;
}

// mapQuotaStatsPayload 把 Go 的 { data } 信封映射成 WebUI 契约。
//
// empty_reason 在 Go 里用空串表示「没有空原因」，前端用的是 null：
// 空串会让「无数据」分支判断失效（'' 是 falsy 但类型不是 null）。
function mapQuotaStatsPayload(payload, extras = {}) {
  const data = payload && typeof payload === 'object' && payload.data && typeof payload.data === 'object'
    ? payload.data
    : null;
  if (!data) return null;
  const mapped = toCamelCaseKeys(data);
  return {
    ok: true,
    provider: String(extras.provider || ''),
    accountRef: String(extras.accountRef || ''),
    ...mapped,
    emptyReason: mapped.emptyReason ? mapped.emptyReason : null
  };
}

// buildQuotaStatsSearch 把 WebUI 的查询参数翻译成 Go 管理接口的参数名。
//
// 只翻译确实被前端使用的三个参数；to 是调试用参数，前端不发，Go 也不接受。
function buildQuotaStatsSearch(query = {}) {
  const params = new URLSearchParams();
  const windowMinutes = Number(query.window);
  if (Number.isFinite(windowMinutes) && windowMinutes > 0) {
    params.set('window', String(Math.trunc(windowMinutes)));
  }
  const scope = String(query.scope || '').trim();
  if (scope) params.set('scope', scope);
  const rangeDays = Number(query.rangeDays);
  if (Number.isFinite(rangeDays) && rangeDays > 0) {
    params.set('range_days', String(Math.trunc(rangeDays)));
  }
  return params.toString();
}

module.exports = {
  toCamelCaseKey,
  toCamelCaseKeys,
  mapQuotaStatsPayload,
  buildQuotaStatsSearch
};

