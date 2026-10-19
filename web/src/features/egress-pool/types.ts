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
  probe: EgressPoolNodeProbe | null;
  accounts: EgressPoolNodeAccount[];
}

export type EgressPoolEventType = 'switch' | 'cooldown' | 'recovered' | 'probe_failed';

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

export interface EgressPoolView {
  ok: boolean;
  available: boolean;
  status: EgressPoolStatus | null;
  nodes: EgressPoolNode[];
  events: EgressPoolEvent[];
  boundAccounts: EgressPoolBoundAccount[];
  serverTime: number;
}

export interface EgressPoolActionResult {
  ok: boolean;
  error?: string;
  node?: string;
  results?: Array<{ name: string; ok: boolean; latencyMs?: number; error?: string }>;
}
