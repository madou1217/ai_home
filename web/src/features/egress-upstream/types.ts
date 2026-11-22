// 上游地区策略视图（GET /v0/webui/egress-upstreams，见 lib/server/egress-upstream-view.js）。

export type EgressVerdictStatus = 'allowed' | 'denied' | 'pending' | 'unknown';
export type EgressVerdictSource = 'rule' | 'evidence' | 'hint' | 'geo' | 'none';
export type EgressRuleEffect = 'deny' | 'allow';
export type EgressMatchField = 'country' | 'region' | 'city' | 'asn' | 'cidr' | 'nodes' | 'groups';

export interface EgressGeo {
  country: string;
  region?: string;
  city?: string;
  asn?: string;
  org?: string;
  ip?: string;
  at?: number;
}

export interface EgressRuleMatch {
  country: string[];
  region: string[];
  city: string[];
  asn: string[];
  cidr: string[];
  nodes: string[];
  groups: string[];
}

export interface EgressRule {
  id: string;
  effect: EgressRuleEffect;
  match: EgressRuleMatch;
  note: string;
}

export interface EgressHint extends EgressRule {
  source: string;
  asOf: string;
}

export interface EgressUpstreamPolicy {
  rules: EgressRule[];
  evidenceTtlMs: number;
  credentialedProbe: boolean;
  updatedAt: number;
}

export interface EgressEvidence {
  exitKey: string;
  status: 'ok' | 'blocked' | 'reachable';
  reason: string;
  source: 'probe' | 'traffic' | 'credentialed' | 'manual';
  at: number;
  accountRef?: string;
  expired: boolean;
  node?: string;
}

export interface EgressNodeVerdict {
  status: EgressVerdictStatus;
  source: EgressVerdictSource;
  detail: string;
  soft: boolean;
  ruleId: string;
}

export interface EgressUpstreamNode {
  name: string;
  identity: string;
  label: string;
  geo: EgressGeo | null;
  geoText: string;
  groups: string[];
  verdict: EgressNodeVerdict;
  evidence: (Omit<EgressEvidence, 'exitKey' | 'node'>) | null;
}

export interface EgressPoolScope {
  kind: 'all' | 'groups' | 'nodes';
  groups: string[];
  nodes: string[];
}

export type EgressPoolStrategy = 'shared' | 'sticky' | 'session';

export interface EgressUpstreamAccount {
  accountRef: string;
  provider: string;
  label: string;
  egress: null | {
    mode: string;
    retired: boolean;
    scope?: EgressPoolScope;
    strategy?: EgressPoolStrategy;
    proxyUrl?: string;
  };
  lane: null | {
    activeNode: string;
    activeLabel?: string;
    blocked: string;
    strategy?: string;
    allowedCount: number;
    scopeCount: number;
  };
  network: null | {
    exit: 'direct' | 'proxy' | 'system';
    proxyUrl?: string;
    geo?: EgressGeo | null;
    geoText?: string;
    stale?: boolean;
    status: EgressVerdictStatus;
    source: EgressVerdictSource;
    detail: string;
  };
}

export interface EgressUpstream {
  id: string;
  host: string;
  providers: string[];
  official: boolean;
  policy: EgressUpstreamPolicy;
  effectiveTtlMs: number;
  hints: EgressHint[];
  accounts: EgressUpstreamAccount[];
  unboundCount: number;
  deniedAccounts: number;
  nodes: EgressUpstreamNode[];
  summary: Record<EgressVerdictStatus, number>;
  evidence: EgressEvidence[];
}

export interface EgressCatalogGroup {
  id: string;
  name: string;
  profileName: string;
  size: number;
}

export interface EgressUpstreamView {
  ok: boolean;
  upstreams: EgressUpstream[];
  groups: EgressCatalogGroup[];
  pool: { ready: boolean; nodeCount: number; geoKnown: number; lanes: unknown[]; laneOverflow: string[] };
  network: { direct: null | { geo: EgressGeo; geoText: string; at: number; stale: boolean } };
  probing: boolean;
  serverTime: number;
}

export interface EgressProbeResult {
  status: 'blocked' | 'reachable' | 'skipped';
  reason: string;
  node: string;
  geo?: EgressGeo | null;
}

export interface EgressActionResult {
  ok: boolean;
  error?: string;
  background?: boolean;
  count?: number;
  removed?: number;
  results?: EgressProbeResult[];
}

/** 按账号当前生效出口探测上游的结果（POST /egress-upstreams/{id}/probe-account）。 */
export interface EgressAccountProbeResult extends EgressActionResult {
  status?: 'reachable' | 'blocked' | 'skipped';
  exit?: 'pool' | 'proxy' | 'system' | 'direct' | 'ssh';
  proxyUrl?: string;
  node?: string;
  reason?: string;
  geo?: EgressGeo | null;
}

/** 出口策略目录（GET /egress-upstreams/strategies，服务端唯一声明）。 */
export type EgressStrategyLayer = 'application' | 'system' | 'network';
export type EgressStrategyInput = 'none' | 'proxy_url' | 'ssh_connection' | 'pool_scope';

export interface EgressStrategyStatus {
  id: string;
  label: string;
  description: string;
  layer: EgressStrategyLayer | string;
  input: EgressStrategyInput | string;
  requiresMihomo: boolean;
  requiresSsh: boolean;
  supportsLaunch: boolean;
  supportsProbe: boolean;
  available: boolean;
  status: 'ready' | 'degraded' | 'unavailable' | string;
  reason?: string;
  boundAccounts: number;
}

/** 出口池路由规则与 DNS 策略（GET/PUT /egress-upstreams/routing）。 */
export type EgressRoutingRuleType = 'domain' | 'domain-suffix' | 'domain-keyword' | 'ip-cidr';
export type EgressRoutingAction = 'proxy' | 'direct' | 'reject';

export interface EgressRoutingRule {
  id: string;
  type: EgressRoutingRuleType;
  value: string;
  action: EgressRoutingAction;
  note?: string;
}

export interface EgressRoutingDNS {
  mode: 'default' | 'doh' | 'plain';
  servers: string[];
  route: 'proxy' | 'direct';
}

export interface EgressRoutingPolicy {
  rules: EgressRoutingRule[];
  dns: EgressRoutingDNS;
  updatedAt?: number;
}

export interface EgressRoutingTestResult {
  target: string;
  kind: 'domain' | 'ip' | string;
  matched: boolean;
  ruleId?: string;
  type?: string;
  value?: string;
  action: 'proxy' | 'direct' | 'reject' | string;
}

export interface EgressRoutingResponse {
  ok: boolean;
  policy: EgressRoutingPolicy;
  applied?: boolean;
  error?: string;
}

/** 代理层冲突诊断（GET /egress-upstreams/diagnostics，只读）。 */
export interface EgressProxyProcess {
  pid: number;
  command: string;
  kind: 'aih-core' | 'clash-verge' | 'mihomo' | 'sing-box' | string;
}

export interface EgressPortOwner {
  port: number;
  pid: number;
  command: string;
  aih: boolean;
}

export interface EgressDiagnostics {
  ok: boolean;
  platform: string;
  pool: {
    running: boolean;
    mixedPort: number;
    controllerPort: number;
    probePort: number;
    lanePorts: number[];
    ownerPid: number;
    corePid: number;
    coreKind?: string;
    coreVersion?: string;
    phase?: string;
    phaseReason?: string;
    freshHealthy?: number;
    coreSource: 'managed' | 'path' | 'client' | '';
    coreVerified: boolean;
    coreCommand: string;
  };
  processes: EgressProxyProcess[];
  portOwners: EgressPortOwner[];
  conflicts: string[];
  notes: string[];
}
