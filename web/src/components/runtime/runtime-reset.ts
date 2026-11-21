// 运行态恢复时间的纯格式化：账号徽章、运行时标签与移动端共用同一口径。

export const formatRuntimeUntil = (value?: number) => {
  const ts = Number(value || 0);
  if (!ts) return '-';
  if (ts <= Date.now()) return '已恢复';
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
};

// 限流/额度类阻塞理应带恢复时间；上游没给时明确说「未提供」，
// 不把空白或原始错误留给用户猜。
const RESET_EXPECTED_STATUSES = new Set([
  'rate_limited',
  'quota_exhausted',
  'account_usage_exhausted',
  'account_no_resource_package',
  'cooling_down'
]);

export const formatRuntimeReset = (status?: string, until?: number) => {
  const ts = Number(until || 0);
  if (ts) return formatRuntimeUntil(ts);
  const key = String(status || '').trim();
  if (RESET_EXPECTED_STATUSES.has(key)) return '上游未提供，后台会自动重试';
  return '';
};

// 额度快照里的恢复时间按条目声明；取所有未来时间里最早的一个。
// snapshot 的 kind 联合很多，这里只做结构化读取，不让调用方依赖某个 shape。
export const getUsageSnapshotResetAt = (snapshot?: unknown) => {
  if (!snapshot || typeof snapshot !== 'object') return 0;
  const entries = (snapshot as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) return 0;
  const now = Date.now();
  let earliest = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const ts = Number((entry as { resetAtMs?: unknown }).resetAtMs || 0);
    if (ts > now && (!earliest || ts < earliest)) earliest = ts;
  }
  return earliest;
};

// 账号恢复时间优先用实时运行态，其次用最近额度快照。
export const getAccountResetAt = (record: {
  runtimeUntil?: number | null;
  usageSnapshot?: unknown;
}) => {
  const runtimeUntil = Number(record.runtimeUntil || 0);
  if (runtimeUntil > Date.now()) return runtimeUntil;
  return getUsageSnapshotResetAt(record.usageSnapshot);
};
