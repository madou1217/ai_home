const CODEX_FREE_QUOTA_PENDING_MESSAGE = '当前 Free 账号未返回可计算的额度窗口，剩余额度未知。';
const CODEX_TEAM_QUOTA_PENDING_MESSAGE = '当前 Team 账号未返回可计算的额度窗口，剩余额度未知。';

const KNOWN_REASON_MESSAGES: Record<string, string> = {
  zcode_oauth_management_only: '当前 AIH 的 ZCode OAuth 接入用于账号管理、桌面启动和用量查询；网关推理需使用 Coding Plan API Key 账号。',
  // Go Core 承接流量时记录的账号级硬阻塞（lib/server/go-runtime-overlay.js），外部真相源更新后自动解除。
  go_runtime_credentials_rejected: '上游拒绝了账号凭据，需要重新登录或更新凭据后恢复调度。',
  go_runtime_quota_exhausted: '上游报告账号额度耗尽，下一次额度快照确认恢复后自动解除。',
  go_runtime_billing_blocked: '上游报告账单状态异常，账单状态恢复后自动解除。',
  go_runtime_account_deactivated: '上游报告账号 / 工作区已停用，账号状态恢复后自动解除。',
  go_runtime_policy_blocked: '上游策略拒绝该账号（地区 / 权限），策略更新后自动解除。',
  auth_metadata_only: '当前只有账号元信息，尚未采到真实额度快照。请刷新用量后再判断是否真的耗尽。',
  codex_free_plan_missing_rate_limits: CODEX_FREE_QUOTA_PENDING_MESSAGE,
  codex_team_plan_missing_rate_limits: CODEX_TEAM_QUOTA_PENDING_MESSAGE,
  codex_free_plan_pending_rate_limits: CODEX_FREE_QUOTA_PENDING_MESSAGE,
  codex_team_plan_pending_rate_limits: CODEX_TEAM_QUOTA_PENDING_MESSAGE,
  provider_returned_no_numeric_usage: '额度已查询，当前响应缺少可计算的剩余额度。',
  timeout: '额度查询超时。',
  probe_exception: '额度查询过程中发生异常。',
  probe_failed: '额度查询失败。',
  probe_not_ok: '额度探测返回非成功结果。',
  empty_parsed_snapshot: '上游返回了响应，但没有解析出可用额度。',
  direct_json_parse_failed: '直连额度响应解析失败。',
  direct_missing_rate_limits: '直连额度响应里缺少 rate limits。',
  direct_request_failed: '直连额度请求失败。',
  restored_expired_oauth_backup: '账号已从备份恢复，原登录凭据已过期，请重新登录。',
  model_region_restricted: 'OpenCode 当前模型受区域/托管范围限制，不是账号认证失效；请切换模型或完成 workspace opt-in。'
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

  if (lower.includes('zcode_balance_parameter_error')) {
    return 'ZCode 余额接口返回参数错误（业务码 3001），不是登录失效；请等待上游接口修复或刷新探测。';
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
