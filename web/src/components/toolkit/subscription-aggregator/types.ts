/** 订阅聚合器的前端类型，与 lib/cli/services/toolkit/subscription-aggregator 的接口同构。 */

/** 策略引用：proxy / auto / direct / reject，或 region:<id> / source:<subscriptionId> / preset:<id>。 */
export type AggregatorPolicy = string;

export type AggregatorRuleType = 'DOMAIN' | 'DOMAIN-SUFFIX' | 'DOMAIN-KEYWORD' | 'IP-CIDR' | 'GEOSITE' | 'GEOIP';

/** 输出格式 id（mihomo、sing-box、surge…），可选值由服务端 catalog.formats 提供。 */
export type AggregatorFormat = string;

export interface AggregatorUserInfo {
  upload?: number;
  download?: number;
  total?: number;
  /** 秒级时间戳；0 或缺失表示不限期 */
  expire?: number;
}

/** remote：订阅地址；local：粘贴的节点内容（保存即解析，不联网）。 */
export type AggregatorSourceKind = 'remote' | 'local';

export interface AggregatorSource {
  id: string;
  name: string;
  kind: AggregatorSourceKind;
  /** 本地订阅为 null */
  url: string | null;
  /** 远程订阅自定义的 User-Agent；为空时用 catalog.defaultUserAgent */
  userAgent?: string | null;
  /** 本地订阅的节点内容 */
  content?: string;
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

/** 保存订阅源：远程带 url（可选 userAgent），本地带 content；id 只在更新时带上。 */
export interface AggregatorSourceInput {
  id?: string;
  name: string;
  kind: AggregatorSourceKind;
  url?: string;
  userAgent?: string;
  content?: string;
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

export interface AggregatorFormatInfo {
  id: AggregatorFormat;
  name: string;
  extension: string;
  /** 是否输出策略组与分流规则（Base64 / 链接列表 / JSON 只有节点） */
  groups: boolean;
}

export interface AggregatorCatalog {
  presets: AggregatorPresetInfo[];
  regions: AggregatorRegionInfo[];
  formats: AggregatorFormatInfo[];
  /** 节点库支持的全部协议（协议过滤的可选值） */
  protocols: string[];
  /** 远程订阅默认的 User-Agent */
  defaultUserAgent: string;
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
