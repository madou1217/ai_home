export type ProxyProtocol =
  | 'shadowsocks'
  | 'vmess'
  | 'vless'
  | 'trojan'
  | 'hysteria2'
  | 'socks5'
  | 'http'
  | 'https';

export interface ProxyNode {
  id: string;
  name: string;
  protocol: ProxyProtocol;
  server: string;
  port: number;
  username?: string;
  password?: string;
  uuid?: string;
  cipher?: string;
  alterId?: number;
  network?: 'tcp' | 'ws' | 'grpc';
  tls?: boolean;
  sni?: string;
  path?: string;
  host?: string;
  flow?: string;
  security?: string;
  publicKey?: string;
  shortId?: string;
  fingerprint?: string;
  serviceName?: string;
  alpn?: string | string[];
  allowInsecure?: boolean;
  insecure?: boolean;
  plugin?: string;
  pluginOpts?: string | Record<string, string | number | boolean>;
  obfs?: string;
  obfsPassword?: string;
  upMbps?: number;
  downMbps?: number;
  group?: string;
  tags?: string[];
  countryCode?: string;
  countryName?: string;
  countryFlag?: string;
  subscriptionId?: string | null;
  latencyMs?: number | null;
  lastChecked?: number | null;
  rawUri?: string;
  createdAt?: number;
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
  groups: ProxyGroup[];
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
  manualSyncOnly?: boolean;
  subscriptions: ProxySubscription[];
}

export interface ProxyMutationResponse {
  ok: boolean;
  applied: boolean;
  error?: string;
  message?: string;
  warnings?: string[];
  removedNodeCount?: number;
}

export interface ProxySubscriptionSyncResponse extends ProxyMutationResponse {
  count?: number;
  nodes?: ProxyNode[];
  manualSyncOnly?: boolean;
  storageOnly?: boolean;
}
