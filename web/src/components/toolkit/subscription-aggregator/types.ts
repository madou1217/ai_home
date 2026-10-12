/** 订阅聚合器的前端类型，与 lib/cli/services/toolkit/subscription-aggregator 的接口同构。 */

/** 策略引用：proxy / auto / direct / reject，或 region:<id> / source:<subscriptionId> / preset:<id> / group:<自建组 id>。 */
export type AggregatorPolicy = string;

/** 策略组的策略：手动选择 / 延迟最低 / 故障转移 / 负载均衡。 */
export type AggregatorGroupType = 'select' | 'url-test' | 'fallback' | 'load-balance';

export type AggregatorLoadBalanceStrategy = 'consistent-hashing' | 'round-robin';

/** 自建策略组：套用的组（内置策略 / 地区 / 订阅源 / 其它自建组）在前，再加按名称规则或勾选选入的节点。 */
export interface AggregatorCustomGroup {
  id: string;
  name: string;
  type: AggregatorGroupType;
  members: AggregatorPolicy[];
  nodes: { include: string; exclude: string; names: string[] };
  /** 会测速的组：空串 / 0 表示沿用这份配置的测速地址与间隔 */
  testUrl?: string;
  interval?: number | null;
  /** 延迟最低：比当前成员快超过这么多毫秒才切换 */
  tolerance?: number | null;
  strategy?: AggregatorLoadBalanceStrategy;
}

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

/** 客户端拉取一次订阅的记录（服务端内存里保留最近 20 次）。 */
export interface AggregatorPull {
  at: number;
  clientId: string;
  clientName: string;
  format: AggregatorFormat;
  view: 'full' | 'nodes';
  nodes: number;
}

export interface AggregatorProfile {
  id: string;
  name: string;
  token: string;
  subscriptionPath: string;
  nodeCount?: number;
  recentPulls?: AggregatorPull[];
  sources: { all: boolean; subscriptionIds: string[]; includeManualNodes: boolean };
  filter: { include: string; exclude: string; protocols: string[] };
  naming: { sourcePrefix: boolean; renames: Array<{ pattern: string; replace: string }> };
  dedupe: boolean;
  groups: { regions: string[]; perSource: boolean; testUrl: string; testIntervalSec: number; custom: AggregatorCustomGroup[] };
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

/** 一键导入：某个客户端的导入方式（深链接 / 下载配置 / 复制地址）。 */
export interface AggregatorImportClient {
  id: string;
  name: string;
  /** 同一个链接覆盖的具体 App（例如 Clash 系） */
  apps: string;
  /** 深链接的 URL Scheme；空表示没有导入链接 */
  scheme: string;
  /** 空表示由服务端按客户端 UA 选格式 */
  format: AggregatorFormat;
  view: '' | 'nodes';
  devices: Array<'desktop' | 'mobile'>;
  /** false：写法只见于第三方面板，待实测 */
  verified: boolean;
  /** 没有导入链接，下载托管配置后用客户端打开 */
  download: boolean;
  note: string;
  /** 这个客户端用的订阅地址 */
  url: string;
  /** 深链接；空表示复制地址或下载配置 */
  link: string;
}

export interface AggregatorImportLinks {
  ok: boolean;
  origin: string;
  /** 通用订阅地址（按 User-Agent 自动选格式） */
  url: string;
  clients: AggregatorImportClient[];
}

/** 本机安装检测：URL Scheme → 处理它的应用名；local=false 表示 WebUI 不在服务器这台机器上。 */
export interface AggregatorLocalClients {
  ok: boolean;
  local: boolean;
  handlers: Record<string, string | null>;
}

/** 服务端识别表里的客户端与它默认拿到的格式。 */
export interface AggregatorClientInfo {
  id: string;
  name: string;
  format: AggregatorFormat;
}

export interface AggregatorGroupTypeInfo {
  id: AggregatorGroupType;
  name: string;
  description: string;
}

export interface AggregatorLoadBalanceStrategyInfo {
  id: AggregatorLoadBalanceStrategy;
  name: string;
}

/** 编辑中（未保存）的配置会选中的节点：名称是改名、去重之后的最终名称。 */
export interface AggregatorDraftNode {
  name: string;
  protocol: string;
  /** 识别出的地区 id；空串表示没识别出 */
  region: string;
  source: string;
}

export interface AggregatorCatalog {
  presets: AggregatorPresetInfo[];
  regions: AggregatorRegionInfo[];
  formats: AggregatorFormatInfo[];
  /** 按 User-Agent 自动识别的客户端 */
  clients: AggregatorClientInfo[];
  /** 节点库支持的全部协议（协议过滤的可选值） */
  protocols: string[];
  /** 远程订阅默认的 User-Agent */
  defaultUserAgent: string;
  ruleTypes: AggregatorRuleType[];
  groupTypes: AggregatorGroupTypeInfo[];
  loadBalanceStrategies: AggregatorLoadBalanceStrategyInfo[];
  /** 自动生成的组名，自建组不能用 */
  reservedGroupNames: string[];
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
  /** 模拟的客户端（预览时选了客户端才有） */
  client?: { id: string; name: string } | null;
  view?: 'full' | 'nodes';
}

/** 规则测试：命中的规则来自哪里（内置私有地址 / 第几条自定义规则 / 哪个预设 / 漏网之鱼）。 */
export type AggregatorRuleOrigin =
  | { kind: 'private' }
  | { kind: 'custom'; index: number }
  | { kind: 'preset'; id: string }
  | { kind: 'final' };

/** 规则测试结果：命中的规则，以及顺着「手动选择」组默认成员走过的组。 */
export interface AggregatorRouteTrace {
  ok: boolean;
  target: { kind: 'domain' | 'ip'; value: string };
  /** type：domain / domain-suffix / domain-keyword / ip-cidr / geosite / geoip / final */
  rule: { origin: AggregatorRuleOrigin | null; type: string; value: string };
  groups: Array<{ name: string; type: AggregatorGroupType; members: string[]; memberCount: number }>;
  /** 走到底是直连 / 拒绝 / 某个节点；停在会自动选择的组时为 null */
  end: { kind: 'direct' | 'reject' | 'node'; name: string } | null;
  /** 下载失败、没参与判断的规则集（geosite:xxx） */
  unavailable: string[];
  checked: number;
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
