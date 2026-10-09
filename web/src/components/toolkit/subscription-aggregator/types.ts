/** 订阅聚合器的前端类型，与 lib/cli/services/toolkit/subscription-aggregator 的接口同构。 */

/** 策略引用：proxy / auto / direct / reject，或 region:<id> / source:<subscriptionId> / preset:<id>。 */
export type AggregatorPolicy = string;

export type AggregatorRuleType = 'DOMAIN' | 'DOMAIN-SUFFIX' | 'DOMAIN-KEYWORD' | 'IP-CIDR' | 'GEOSITE' | 'GEOIP';

export type AggregatorFormat = 'mihomo' | 'sing-box' | 'base64';

export interface AggregatorUserInfo {
  upload?: number;
  download?: number;
  total?: number;
  /** 秒级时间戳；0 或缺失表示不限期 */
  expire?: number;
}

export interface AggregatorSource {
  id: string;
  name: string;
  url: string;
  nodeCount: number;
  lastSyncedAt: number | null;
  userInfo: AggregatorUserInfo | null;
}

export interface AggregatorProfile {
  id: string;
  name: string;
  token: string;
  subscriptionPath: string;
  nodeCount?: number;
  sources: { all: boolean; subscriptionIds: string[]; includeManualNodes: boolean };
  filter: { include: string; exclude: string; protocols: string[] };
  naming: { sourcePrefix: boolean; renames: Array<{ pattern: string; replace: string }> };
  dedupe: boolean;
  groups: { regions: string[]; perSource: boolean; testUrl: string; testIntervalSec: number };
  rules: {
    presets: Array<{ id: string; enabled: boolean; policy: AggregatorPolicy }>;
    custom: Array<{ type: AggregatorRuleType; value: string; policy: AggregatorPolicy }>;
    finalPolicy: AggregatorPolicy;
  };
  refreshHours: number;
  createdAt: number;
  updatedAt: number;
}

/** 可编辑字段（id 只在更新时带上，token/时间戳由服务端维护）。 */
export type AggregatorProfileInput = Omit<AggregatorProfile, 'token' | 'subscriptionPath' | 'nodeCount' | 'createdAt' | 'updatedAt' | 'id'> & {
  id?: string;
};

export interface AggregatorPresetInfo {
  id: string;
  name: string;
  description: string;
  defaultPolicy: AggregatorPolicy;
  enabledByDefault: boolean;
}

export interface AggregatorRegionInfo {
  id: string;
  code: string;
  name: string;
  flag: string;
}

export interface AggregatorCatalog {
  presets: AggregatorPresetInfo[];
  regions: AggregatorRegionInfo[];
  formats: Array<{ id: AggregatorFormat; name: string; extension: string; groups: boolean }>;
  ruleTypes: AggregatorRuleType[];
  /** 服务端规范化后的新建初始值 */
  defaultProfile: AggregatorProfileInput;
}

export interface AggregatorOverview {
  ok: boolean;
  profiles: AggregatorProfile[];
  sources: AggregatorSource[];
  manualNodeCount: number;
  catalog: AggregatorCatalog;
}

export interface AggregatorPreview {
  ok: boolean;
  content: string;
  format: AggregatorFormat;
  contentType: string;
  stats: {
    scoped: number;
    filtered: number;
    duplicates: number;
    nodes: number;
    skipped: number;
    groups: number;
    regions: number;
    rules: number;
  };
  skippedNodes: Array<{ name: string; reason: string }>;
  warnings: string[];
  userInfo: AggregatorUserInfo | null;
}

export interface AggregatorSyncResult {
  ok: boolean;
  count?: number;
  error?: string;
  message?: string;
}

export interface AggregatorSourceSaveResult {
  ok: boolean;
  subscription: AggregatorSource;
  sync?: AggregatorSyncResult;
  error?: string;
}
