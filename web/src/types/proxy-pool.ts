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

export interface ProxyNodesResponse {
  ok: boolean;
  total: number;
  activeOutboundNodeId: string | null;
  routingMode: 'global' | 'rule' | 'direct';
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
}

export interface ProxySubscriptionsResponse {
  ok: boolean;
  subscriptions: ProxySubscription[];
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
}

export interface DedicatedPortsResponse {
  ok: boolean;
  config: DedicatedPortsConfig;
  active: DedicatedPortsActiveServer[];
}

export interface NodePingResponse {
  ok: boolean;
  nodeId: string;
  reachable: boolean;
  latencyMs: number;
  error?: string | null;
}
