import type {
  AggregatorCatalog,
  AggregatorFormat,
  AggregatorPolicy,
  AggregatorProfile,
  AggregatorSource,
  AggregatorUserInfo
} from './types';

export type SubscriptionLinkFormat = 'auto' | AggregatorFormat;

export const LINK_FORMAT_OPTIONS: Array<{ label: string; value: SubscriptionLinkFormat }> = [
  { label: '自动识别', value: 'auto' },
  { label: 'Clash / mihomo', value: 'mihomo' },
  { label: 'sing-box', value: 'sing-box' },
  { label: 'Base64', value: 'base64' }
];

export const PROTOCOL_OPTIONS = ['vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria2', 'socks5', 'http']
  .map((value) => ({ label: value, value }));

const BUILTIN_POLICY_LABELS: Record<string, string> = {
  proxy: '🚀 节点选择',
  auto: '♻️ 自动选择',
  direct: '直连 DIRECT',
  reject: '拒绝 REJECT'
};

export function formatBytes(value: number | undefined) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const scaled = bytes / 1024 ** exponent;
  return `${scaled >= 100 || exponent === 0 ? Math.round(scaled) : scaled.toFixed(1)} ${units[exponent]}`;
}

export function formatExpire(expire: number | undefined) {
  if (!expire) return '长期有效';
  const date = new Date(expire * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 订阅面板报告的流量：已用 / 总量，没有数据时返回空串。 */
export function formatTraffic(info: AggregatorUserInfo | null | undefined) {
  if (!info || !info.total) return '';
  const used = Number(info.upload || 0) + Number(info.download || 0);
  return `${formatBytes(used)} / ${formatBytes(info.total)}`;
}

export function buildSubscriptionUrl(origin: string, path: string, format: SubscriptionLinkFormat) {
  const base = `${String(origin || '').replace(/\/+$/, '')}${path}`;
  return format === 'auto' ? base : `${base}?target=${encodeURIComponent(format)}`;
}

interface PolicyContext {
  catalog: Pick<AggregatorCatalog, 'regions' | 'presets'>;
  sources: Array<Pick<AggregatorSource, 'id' | 'name'>>;
}

export function policyLabel(policy: AggregatorPolicy, context: PolicyContext) {
  if (BUILTIN_POLICY_LABELS[policy]) return BUILTIN_POLICY_LABELS[policy];
  const [kind, id] = [policy.slice(0, policy.indexOf(':')), policy.slice(policy.indexOf(':') + 1)];
  if (kind === 'region') {
    const region = context.catalog.regions.find((item) => item.id === id);
    return region ? `${region.flag} ${region.name}节点` : policy;
  }
  if (kind === 'source') {
    const source = context.sources.find((item) => item.id === id);
    return source ? `📦 ${source.name}` : id === 'manual' ? '📦 手动节点' : policy;
  }
  if (kind === 'preset') return context.catalog.presets.find((item) => item.id === id)?.name || policy;
  return policy;
}

/**
 * 策略下拉选项（antd Select 分组格式）。预设组只给自定义规则选，
 * 订阅源组只在开启「按订阅源分组」时才存在。
 */
export function buildPolicyOptions(context: PolicyContext & { includePresets?: boolean; includeSources?: boolean }) {
  const option = (value: string) => ({ label: policyLabel(value, context), value });
  const groups = [
    { label: '内置', options: ['proxy', 'auto', 'direct', 'reject'].map(option) },
    { label: '地区', options: context.catalog.regions.map((region) => option(`region:${region.id}`)) }
  ];
  if (context.includeSources && context.sources.length) {
    groups.push({ label: '订阅源', options: context.sources.map((source) => option(`source:${source.id}`)) });
  }
  if (context.includePresets) {
    groups.push({ label: '规则组', options: context.catalog.presets.map((preset) => option(`preset:${preset.id}`)) });
  }
  return groups;
}

export function describeSourceScope(profile: Pick<AggregatorProfile, 'sources'>, sourceCount: number) {
  const base = profile.sources.all
    ? `全部订阅源（${sourceCount}）`
    : `${profile.sources.subscriptionIds.length} 个订阅源`;
  return profile.sources.includeManualNodes ? `${base} + 手动节点` : base;
}

export function countEnabledPresets(profile: Pick<AggregatorProfile, 'rules'>) {
  return profile.rules.presets.filter((preset) => preset.enabled).length;
}

/** 订阅地址的查询串通常就是凭据（参数名五花八门），列表里只显示域名与路径。 */
export function maskSourceUrl(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}${parsed.search ? '?…' : ''}`;
  } catch (_error) {
    return url.length > 48 ? `${url.slice(0, 40)}…` : url;
  }
}

function nameFromUrl(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (_error) {
    return '订阅';
  }
}

/**
 * 批量粘贴：每行一个订阅，支持「URL」「名称 URL」「名称,URL」「名称|URL」。
 * 不是 http(s) 地址的行原样返回给界面提示，不静默丢弃。
 */
export function parseBatchSources(text: string) {
  const sources: Array<{ name: string; url: string }> = [];
  const invalid: string[] = [];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(?:(.+?)\s*[,|，\s]\s*)?(https?:\/\/\S+)$/i);
    if (!match) {
      invalid.push(line);
      continue;
    }
    const url = match[2];
    sources.push({ name: (match[1] || '').trim() || nameFromUrl(url), url });
  }
  return { sources, invalid };
}

const ERROR_TEXT: Record<string, string> = {
  invalid_aggregator_pattern: '正则表达式无效',
  invalid_aggregator_policy: '策略引用无效',
  invalid_aggregator_rule: '分流规则格式不正确',
  invalid_aggregator_test_url: '测速地址必须是 http(s) URL',
  too_many_aggregator_rules: '自定义规则过多（最多 500 条）',
  aggregator_profile_not_found: '聚合订阅不存在，可能已被删除',
  subscription_not_found: '订阅源不存在，可能已被删除',
  invalid_subscription_url: '订阅地址必须是 http(s) URL',
  subscription_url_blocked: '订阅地址指向内网或保留地址，已拦截',
  subscription_fetch_timeout: '拉取订阅超时',
  subscription_fetch_failed: '拉取订阅失败',
  subscription_http_error: '订阅服务器返回错误状态',
  no_valid_proxy_nodes_found: '订阅里没有可用节点'
};

export function aggregatorErrorText(code: string | undefined, fallback: string) {
  if (!code) return fallback;
  return ERROR_TEXT[code] || code;
}
