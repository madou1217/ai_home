// 出口池面板的数据形状 —— 与 lib/server/webui-egress-pool-routes.js 的 GET /v0/webui/egress-pool 对齐。

export type EgressNodeFailureKind = 'free_limit' | 'gate' | 'network' | 'ip_blocked';

export interface EgressPoolNodeProbe {
  ok: boolean;
  latencyMs: number;
  at: number;
  error?: string;
}

export interface EgressPoolNodeAccount {
  accountRef: string;
  uses: number;
  lastUsedAt: number;
}

export interface EgressPoolNode {
  name: string;
  identity: string;
  label: string;
  protocol: string;
  server: string;
  port: number;
  countryCode: string;
  countryFlag: string;
  uses: number;
  successes: number;
  failures: number;
  failuresByKind: Partial<Record<EgressNodeFailureKind, number>>;
  consecutiveFailures: number;
  lastUsedAt: number;
  lastSuccessAt: number;
  lastFailureAt: number;
  lastFailureKind: EgressNodeFailureKind | '';
  cooling: boolean;
  cooldownUntil: number;
  cooldownKind: EgressNodeFailureKind | '';
  cooldownRemainingMs: number;
  /** 被拦截策略挡住（延迟超阈值 / 探测不通 / 手动关闭）：不参与轮换与车道。 */
  blocked: boolean;
  blockedReason: string;
  blockedDetail: string;
  probe: EgressPoolNodeProbe | null;
  accounts: EgressPoolNodeAccount[];
}

export type EgressPoolEventType = 'switch' | 'cooldown' | 'recovered' | 'probe_failed' | 'blocked' | 'unblocked';

export interface EgressPoolEvent {
  at: number;
  type: EgressPoolEventType;
  node: string;
  from?: string;
  kind?: EgressNodeFailureKind;
  reason?: string;
  cooldownMs?: number;
  accountRef?: string;
  model?: string;
  latencyMs?: number;
}

export interface EgressPoolStatus {
  enabled?: boolean;
  ready: boolean;
  starting?: boolean;
  proxyUrl: string;
  nodeCount: number;
  activeNodeIndex?: number;
  activeNode?: string;
  coolingCount?: number;
  probeIntervalMs?: number;
  lastError?: string;
}

export interface EgressPoolBoundAccount {
  accountRef: string;
  provider: string;
  updatedAt: number;
}

/** 节点拦截策略（见 lib/runtime/egress-pool-node-policy.js）。 */
export interface EgressPoolNodePolicy {
  latency: { enabled: boolean; maxMs: number };
  unreachable: { enabled: boolean };
  disabledCount: number;
  summary: string;
}

export interface EgressPoolPagination {
  page: number;
  pageSize: number;
  total: number;
  pageCount: number;
}

export interface EgressPoolView {
  ok: boolean;
  available: boolean;
  status: EgressPoolStatus | null;
  nodes: EgressPoolNode[];
  events: EgressPoolEvent[];
  boundAccounts: EgressPoolBoundAccount[];
  /** 当前拦截策略；无池时为 null。 */
  nodePolicy: EgressPoolNodePolicy | null;
  /** 服务端分页信息（带 page 参数请求时才有；全量请求时为 undefined）。 */
  pagination?: EgressPoolPagination;
  /** 各筛选类别下的总条数（服务端算，分页时前端不用再遍历全量）。 */
  nodeCounts?: Record<string, number>;
  /** 节点表版本指纹：没变时服务端回 304，前端沿用上一份数据。 */
  version?: string;
  serverTime: number;
}

export interface EgressPoolActionResult {
  ok: boolean;
  error?: string;
  node?: string;
  blocked?: boolean;
  removed?: number;
  nodePolicy?: EgressPoolNodePolicy;
  results?: Array<{ name: string; ok: boolean; latencyMs?: number; error?: string }>;
}
