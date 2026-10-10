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
  groups?: ProxyGroup[];
  nodes: ProxyNode[];
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
}
