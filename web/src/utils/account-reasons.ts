const KNOWN_REASON_MESSAGES: Record<string, string> = {
  auth_metadata_only: '当前只有账号元信息，尚未采到真实额度快照。请刷新用量后再判断是否真的耗尽。',
  codex_free_plan_missing_rate_limits: '当前账号的 token claim 已经是 free，但 Codex 没返回任何可计算的额度窗口。这更像账号已降级到 free，或 free 额度已经耗尽；建议直接重新登录确认。',
  codex_team_plan_missing_rate_limits: '当前账号的 token claim 仍是 team，但 Codex 没返回任何可计算的额度窗口。这更像 team entitlement、workspace，或套餐状态异常；建议重新登录确认。',
  provider_returned_no_numeric_usage: '已拿到 usage 快照，但上游没有返回可计算的 remaining 数值。',
  timeout: '额度查询超时。',
  probe_exception: '额度查询过程中发生异常。',
  probe_failed: '额度查询失败。',
  probe_not_ok: '额度探测返回非成功结果。',
  empty_parsed_snapshot: '上游返回了响应，但没有解析出可用额度。',
  direct_json_parse_failed: '直连额度响应解析失败。',
  direct_missing_rate_limits: '直连额度响应里缺少 rate limits。',
  direct_request_failed: '直连额度请求失败。'
};

function normalizeReason(reason?: string) {
  return String(reason || '').trim();
}

function findDirectHttpStatus(reason: string) {
  const match = reason.match(/direct_http_status_([0-9]{3}|unknown)/i);
  return match ? match[1].toUpperCase() : '';
}

function findHttpStatus(reason: string) {
  const directStatus = findDirectHttpStatus(reason);
  if (directStatus) {
    return { source: '直连额度请求', status: directStatus };
  }

  const refreshMatch = reason.match(/refresh_http_([0-9]{3})/i);
  if (refreshMatch) {
    return { source: '刷新认证请求', status: refreshMatch[1] };
  }

  const genericMatch = reason.match(/\bhttp_([0-9]{3})\b/i);
  if (genericMatch) {
    return { source: '上游请求', status: genericMatch[1] };
  }

  return null;
}

export function isAuthInvalidReauthRequiredReason(reason?: string) {
  return normalizeReason(reason).toLowerCase().includes('auth_invalid_reauth_required');
}

export function formatAccountIssueReason(reason?: string) {
  const text = normalizeReason(reason);
  if (!text) return '';

  const lower = text.toLowerCase();
  const httpStatus = findHttpStatus(text);

  if (isAuthInvalidReauthRequiredReason(text)) {
    if (httpStatus) {
      return `账号认证已失效，${httpStatus.source}返回 HTTP ${httpStatus.status}。请重新登录或重新授权后再使用。`;
    }
    return '账号认证已失效，需要重新登录或重新授权后再使用。';
  }

  if (Object.prototype.hasOwnProperty.call(KNOWN_REASON_MESSAGES, text)) {
    return KNOWN_REASON_MESSAGES[text];
  }

  if (httpStatus) {
    return `${httpStatus.source}返回 HTTP ${httpStatus.status}。`;
  }

  if (lower.startsWith('app_server_exit_')) {
    return `Codex app-server 退出：${text.replace(/^app_server_exit_/i, '')}。`;
  }

  if (lower.startsWith('spawn_error:')) {
    return `额度探测进程启动失败：${text.replace(/^spawn_error:/i, '').trim()}`;
  }

  return text;
}
