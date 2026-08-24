export type ProxyProtocol =
  | 'shadowsocks'
  | 'shadowsocksr'
  | 'vmess'
  | 'vless'
  | 'trojan'
  | 'hysteria'
  | 'hysteria2'
  | 'tuic'
  | 'socks5'
  | 'http'
  | 'https'
  | 'wireguard';

export interface ProxyNode {
  id: string;
  name: string;
  protocol: ProxyProtocol;
  server: string;
  port: number;
  password?: string;
  uuid?: string;
  username?: string;
  cipher?: string;
  alterId?: number;
  network?: string;
  tls?: boolean;
  sni?: string;
  path?: string;
  host?: string;
  security?: string;
  publicKey?: string;
  shortId?: string;
  fingerprint?: string;
  group?: string;
  tags?: string[];
  countryCode?: string;
  countryName?: string;
  countryFlag?: string;
  subscriptionId?: string | null;
  latencyMs?: number | null;
  lastChecked?: number | null;
  dedicatedPort?: number | null;
  rawUri?: string;
  updatedAt?: number;
}

export type ProxyGroupStrategy = 'sticky' | 'lowest_latency' | 'round_robin' | 'random';

export interface ProxyGroup {
  id: string;
  name: string;
  icon?: string;
  count: number;
  kind?: 'system' | 'tag' | 'country' | 'custom' | 'subscription' | 'manual';
  nodeIds?: string[];
  strategy?: ProxyGroupStrategy;
  failoverStrategy?: ProxyGroupStrategy;
  createdAt?: number;
  updatedAt?: number;
  classificationSource?: 'explicit' | 'node-name' | 'subscription' | 'runtime';
  description?: string;
}

export interface ProxyGroupsResponse {
  ok: boolean;
  groups: ProxyGroup[];
}

export interface ProxyGroupMutationResponse {
  ok: boolean;
  applied: boolean;
  group?: ProxyGroup;
  error?: string;
}

export interface ProxyNodesResponse {
  ok: boolean;
  total: number;
  activeOutboundNodeId: string | null;
  routingMode: 'global' | 'rule' | 'direct';
  groups?: ProxyGroup[];
  nodes: ProxyNode[];
}

export interface ProxySubscription {
  id: string;
  name: string;
  url: string;
  autoUpdate: boolean;
  intervalHours: number;
  nodeCount: number;
  lastSyncedAt: number | null;
  updatedAt: number;
  manualSyncOnly?: boolean;
}

export interface ProxySubscriptionsResponse {
  ok: boolean;
  subscriptions: ProxySubscription[];
}

export interface ProxyMutationResponse {
  ok: boolean;
  applied: boolean;
  error?: string;
  message?: string;
  warnings?: string[];
  core?: ProxyCoreStatus;
  removedNodeCount?: number;
}

export interface ProxySubscriptionSyncResponse extends ProxyMutationResponse {
  count?: number;
  nodes?: ProxyNode[];
  manualSyncOnly?: boolean;
}

export interface RoutingRule {
  id: string;
  name: string;
  target: string;
  outbound: 'proxy' | 'direct' | 'reject';
  nodeId?: string | null;
  domains?: string[];
  ips?: string[];
}

export interface RoutingConfig {
  mode: 'global' | 'rule' | 'direct';
  activeOutboundNodeId: string | null;
  rules: RoutingRule[];
}

export interface RoutingResponse {
  ok: boolean;
  routing: RoutingConfig;
  applied?: boolean;
  reason?: string;
  error?: string;
  message?: string;
  warnings?: string[];
}

export interface DedicatedPortsConfig {
  enabled: boolean;
  maxPorts: number;
  basePort: number;
  mappings: Record<string, number>;
}

export interface DedicatedPortsActiveServer {
  nodeId: string;
  port: number | null;
  listening: boolean;
  protocol?: 'mixed';
  usableAs?: Array<'http' | 'socks5'>;
}

export interface DedicatedPortsResponse {
  ok: boolean;
  config: DedicatedPortsConfig;
  active: DedicatedPortsActiveServer[];
}

export interface DedicatedPortMutationResponse extends ProxyMutationResponse {
  port?: number;
  running?: boolean;
  releasedPort?: number | null;
}

export interface NodePingResponse {
  ok: boolean;
  nodeId: string;
  reachable: boolean;
  latencyMs: number;
  error?: string | null;
}

export interface AggregateExportResponse {
  ok: boolean;
  format: 'mihomo' | 'base64';
  contentType: string;
  requestedNodeCount?: number;
  nodeCount: number;
  exportedNodeCount?: number;
  skippedNodes?: Array<{ nodeId?: string; name?: string; reason: string }>;
  warnings?: string[];
  content: string;
}

export interface ProxyCoreListener {
  nodeId: string;
  port: number;
  listening: boolean;
}

export interface ProxyCoreStatus {
  engine: 'mihomo';
  installed: boolean;
  binaryName?: string | null;
  binarySource?: 'env' | 'path' | 'known-app' | 'managed' | null;
  binaryManaged?: boolean;
  version?: string;
  running: boolean;
  dataPlaneReady: boolean;
  mixedProxyUrl?: string | null;
  requestedMixedPort?: number;
  mixedPort?: number;
  portSelection?: {
    ok: boolean;
    port?: number;
    requestedPort?: number;
    reused?: boolean;
    reason?: string;
  } | null;
  activeListeners: ProxyCoreListener[];
  tun?: ProxyTunConfig;
  lastError?: string | null;
}

export interface ProxyCoreStatusResponse {
  ok: boolean;
  core: ProxyCoreStatus;
}

export interface ProxyCoreActionResponse extends ProxyCoreStatusResponse {
  action: 'start' | 'stop' | 'reload';
  applied: boolean;
  error?: string;
  message?: string;
  warnings?: string[];
}

export interface ProxyTunConfig {
  enabled: boolean;
  stack?: 'system' | 'gvisor' | 'mixed';
  autoRoute?: boolean;
  autoDetectInterface?: boolean;
  strictRoute?: boolean;
  dnsHijack?: string[];
}

export interface NetworkLayerStatus {
  platform: string;
  systemProxy: {
    enabled: boolean;
    probeStatus?: string;
    source?: string;
    httpProxy?: string;
    httpsProxy?: string;
    socksProxy?: string | string[];
    bypassList?: string[];
  };
  tun: {
    state: 'active' | 'inactive' | 'unknown';
    owner?: string | null;
    interfaceDetected?: boolean;
    routeDetected?: boolean;
    evidence?: string[];
  };
  effectiveRoute: 'tun' | 'system-proxy' | 'unknown' | 'direct-unknown';
  effectiveRouteKnown: boolean;
  takeoverAllowed: boolean;
  conflicts: string[];
}

export interface NetworkStatusResponse extends NetworkLayerStatus {
  ok: boolean;
}

export interface NetworkPlanResponse {
  ok: boolean;
  plan?: {
    planId: string;
    kind?: 'system-proxy' | 'tun';
    action: 'enable' | 'disable' | 'restore';
    service?: string;
    proxyUrl?: string | null;
    snapshotHash: string;
    previousTun?: ProxyTunConfig;
    tun?: ProxyTunConfig;
    operations?: Array<{ key: string; command: string; args: string[] }>;
    rollbackOperations?: Array<{ key: string; command: string; args: string[] }>;
  };
  network?: NetworkLayerStatus;
  core?: ProxyCoreStatus;
  error?: string;
  message?: string;
}

export interface NetworkApplyResponse {
  ok: boolean;
  applied?: boolean;
  rollbackApplied?: boolean;
  error?: string;
  message?: string;
  core?: ProxyCoreStatus;
  operations?: Array<{ key: string; ok: boolean; exitCode?: number | null }>;
}
