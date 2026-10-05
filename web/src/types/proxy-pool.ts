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

export interface ProxyProtocolFieldOption {
  label: string;
  value: string;
}

/** 协议插件声明的节点编辑字段（服务端 protocols/<id>.js 的 editor.fields）。 */
export interface ProxyProtocolField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'number' | 'switch' | 'select';
  required?: boolean;
  requiredMessage?: string;
  placeholder?: string;
  row?: string;
  options?: ProxyProtocolFieldOption[];
}

export interface ProxyProtocolPlugin {
  id: string;
  name: string;
  protocols: string[];
  editor: { fields: ProxyProtocolField[] };
  nodeFields: string[];
}

export interface ProxyProtocolsResponse {
  ok: boolean;
  core?: { id: string; name: string };
  protocols: ProxyProtocolPlugin[];
}

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
  storageOnly?: boolean;
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

export interface OutboundCandidate {
  nodeId: string;
  name: string;
  protocol: string;
  latencyMs: number;
}

/** 推荐默认出口：只测速排序，不修改分流配置。 */
export interface OutboundSuggestResponse {
  ok: boolean;
  error?: string;
  testedCount?: number;
  reachableCount?: number;
  candidates: OutboundCandidate[];
}

export interface OutboundFailoverConfig {
  enabled: boolean;
  intervalSec: number;
  failureThreshold: number;
}

export interface OutboundFailoverEvent {
  at: number;
  reason: 'unreachable' | 'node_missing' | string;
  failures: number;
  from: { nodeId: string; name: string };
  to: { nodeId: string; name: string; latencyMs: number };
  applied: boolean;
}

export interface OutboundFailoverCheck {
  at: number;
  action: 'healthy' | 'degraded' | 'switched' | 'no_candidate' | 'skipped' | 'failed' | string;
  reason?: string;
  nodeId?: string;
  latencyMs?: number;
  failures?: number;
  event?: OutboundFailoverEvent;
}

export interface OutboundFailoverStatus {
  ok: boolean;
  error?: string;
  config: OutboundFailoverConfig;
  scheduled: boolean;
  consecutiveFailures: number;
  lastCheck: OutboundFailoverCheck | null;
  /** 最近的切换记录，新的在前 */
  events: OutboundFailoverEvent[];
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

export interface ProxyCoreCapabilities {
  hotReload?: boolean;
  dedicatedPorts?: boolean;
  tun?: boolean;
}

/** 代理内核插件（服务端 proxy-pool/cores 注册表下发）。 */
export interface ProxyCoreInfo {
  id: string;
  name: string;
  configFormat?: string;
  releaseUrl?: string;
  capabilities?: ProxyCoreCapabilities;
  active: boolean;
}

export interface ProxyCoresResponse {
  ok: boolean;
  cores: ProxyCoreInfo[];
}

export interface ProxyCoreStatus {
  /** 当前代理内核插件 id（mihomo / sing-box …）。 */
  engine: string;
  engineName?: string;
  releaseUrl?: string;
  binaryEnvVar?: string;
  capabilities?: ProxyCoreCapabilities;
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
