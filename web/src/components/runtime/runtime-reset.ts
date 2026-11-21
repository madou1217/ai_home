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
