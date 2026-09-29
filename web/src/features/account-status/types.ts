// 账号健康状态可视化 —— 数据契约类型。
// 对应后端 GET /v0/webui/account-outcomes（lib/server/account-outcomes-view.js）。

/** 失败分类闭集（与后端 Go 核心的 outcome kind 一一对应），value 为中文展示名。 */
export const FAILURE_KIND_LABELS = {
  rate_limited: '限流',
  model_overloaded: '模型过载',
  upstream_unavailable: '上游不可用',
  request_timeout: '超时',
  connection_reset: '连接重置',
  stream_disconnected: '流中途断开',
  credential_rejected: '凭据被拒',
  static_credential_rejected: '密钥被拒',
  reauthentication_required: '需重新登录',
  quota_exhausted: '额度用完',
  billing_blocked: '账单受限',
  workspace_deactivated: '工作区停用',
  model_unsupported: '不支持该模型',
  region_unsupported: '地区不支持',
  permission_denied: '无权限',
  invalid_request: '请求参数被拒',
  not_found: '资源不存在',
  safety_rejected: '安全策略拒绝',
  malformed_response: '响应异常',
  request_cancelled: '客户端取消',
  unclassified: '其他'
} as const;

export type FailureKind = keyof typeof FAILURE_KIND_LABELS;

/** 中立结果：既不计入分子也不计入分母（客户端主动取消，不代表账号/上游健康状况）。 */
export const NEUTRAL_FAILURE_KIND: FailureKind = 'request_cancelled';

export function getFailureKindLabel(kind: string): string {
  return (FAILURE_KIND_LABELS as Record<string, string>)[kind] || kind;
}

/** 一个时间桶（一天或一小时）的结果计数；稀疏——只有有数据的桶才会出现在数组里。 */
export interface OutcomeBucket {
  startMs: number;
  success: number;
  failures: Record<string, number>;
}

export interface AccountOutcomes {
  accountRef: string;
  days: OutcomeBucket[];
  hours: OutcomeBucket[];
}

export interface AccountOutcomesData {
  generatedAt: number;
  /** 90 个本地零点时间戳，升序，最后一个是今天 */
  dayStarts: number[];
  /** 24 个本地整点时间戳，升序，最后一个是当前小时 */
  hourStarts: number[];
  accounts: AccountOutcomes[];
}

export interface AccountOutcomesResponse {
  ok: boolean;
  data?: AccountOutcomesData;
  error?: string;
}

/** 健康档位：none 表示该窗口内没有（可计数的）请求，不代表 100% 或 0%。 */
export type HealthTier = 'operational' | 'degraded' | 'partial' | 'major' | 'none';

export type BucketGranularity = 'day' | 'hour';
