export type DetectSkipEntry = { reason?: string; detail?: string };

// 这些原因属于“本来就没有可入库的变化”，不应在扫描完成的 toast 里制造告警。
const BENIGN_SKIP_REASONS = new Set([
  'existing_account_unchanged',
  'account_deleted_by_user',
  'credential_file_missing',
  'desktop_credential_unavailable',
]);

const SKIP_REASON_TEXT: Record<string, string> = {
  desktop_credential_read_failed: '桌面凭据库读取失败',
  desktop_credential_unreadable: '桌面凭据无法解析',
  desktop_credential_unsupported_format: '桌面凭据格式不支持',
  desktop_credential_keyring_unavailable: '桌面凭据钥匙串不可用',
  candidate_credential_expired: '凭据已过期',
  credential_source_mismatch: '凭据站点不匹配',
  credential_realm_mismatch: '凭据认证域不匹配',
  credential_identity_mismatch: '凭据身份不一致',
  credential_domain_mismatch: '凭据域名不一致',
  refresh_realm_mismatch: '刷新令牌认证域不匹配',
  incomplete_oauth_credential: 'OAuth 凭据不完整',
  invalid_identity: '账号身份无效',
  identity_unverifiable: '账号身份无法验证',
  codebuddy_credential_sync_failed: '凭据同步失败',
  host_account_register_failed: '账号入库失败',
  host_account_detector_cancelled: '扫描已取消',
  host_account_detector_unavailable: '扫描器不可用',
  tombstone_check_failed: '删除记录检查失败',
};

function compactDetail(value: string): string {
  const text = value.trim().replace(/\s+/g, ' ');
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

/**
 * 把扫描结果里的 skipped 压成一句 toast 补充文案。
 *
 * 只统计需要用户处理的原因；无变化的账号、已删除账号等常态跳过会被忽略。
 * 同一个 reason 合并计数，最多展示两条，detail 作为括号里的次级说明。
 */
export function formatDetectSkipSummary(skipped?: DetectSkipEntry[] | null): string {
  const actionable = (Array.isArray(skipped) ? skipped : [])
    .filter((item) => item && !BENIGN_SKIP_REASONS.has(String(item.reason || '').trim()));
  if (actionable.length === 0) return '';

  const groups = new Map<string, { count: number; detail: string }>();
  for (const item of actionable) {
    const reason = String(item.reason || '').trim() || 'unknown';
    const current = groups.get(reason) || { count: 0, detail: '' };
    current.count += 1;
    if (!current.detail && item.detail) current.detail = String(item.detail);
    groups.set(reason, current);
  }

  const parts = Array.from(groups.entries())
    .sort((left, right) => right[1].count - left[1].count)
    .slice(0, 2)
    .map(([reason, group]) => {
      const label = SKIP_REASON_TEXT[reason] || reason;
      const count = group.count > 1 ? ` ×${group.count}` : '';
      const detail = group.detail ? `（${compactDetail(group.detail)}）` : '';
      return `${label}${count}${detail}`;
    });

  return `另有 ${actionable.length} 个来源未入库：${parts.join('、')}`;
}
