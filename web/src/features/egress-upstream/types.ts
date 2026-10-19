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

export type EgressPoolStrategy = 'shared' | 'sticky';

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
