import type {
  AggregatorCatalog,
  AggregatorClientInfo,
  AggregatorCustomGroup,
  AggregatorFormat,
  AggregatorFormatInfo,
  AggregatorImportClient,
  AggregatorPolicy,
  AggregatorProfile,
  AggregatorPull,
  AggregatorSource,
  AggregatorSourcePreview,
  AggregatorUserInfo
} from './types';

export type SubscriptionLinkFormat = 'auto' | AggregatorFormat;

/** 本地订阅内容的上限（与服务端节点库一致）。 */
export const LOCAL_SOURCE_MAX_BYTES = 2 * 1024 * 1024;

/** 输出格式选项（服务端 catalog.formats 的顺序）；订阅链接额外有「自动识别」。 */
export function formatOptions(formats: Array<Pick<AggregatorFormatInfo, 'id' | 'name'>>) {
  return formats.map((format) => ({ label: format.name, value: format.id }));
}

export function linkFormatOptions(formats: Array<Pick<AggregatorFormatInfo, 'id' | 'name'>>) {
  return [{ label: '自动识别', value: 'auto' }, ...formatOptions(formats)];
}

export function protocolOptions(protocols: string[]) {
  return protocols.map((value) => ({ label: value, value }));
}

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

export interface PolicyContext {
  catalog: Pick<AggregatorCatalog, 'regions' | 'presets'>;
  sources: Array<Pick<AggregatorSource, 'id' | 'name'>>;
  /** 自建组（编辑中取表单里的当前值） */
  groups?: Array<Pick<AggregatorCustomGroup, 'id' | 'name'>>;
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
  if (kind === 'group') {
    const group = context.groups?.find((item) => item.id === id);
    return group ? group.name.trim() || '未命名策略组' : '已删除的策略组';
  }
  return policy;
}

/**
 * 策略下拉选项（antd Select 分组格式）。预设组只给自定义规则选，
 * 订阅源组只在开启「按订阅源分组」时才存在。
 */
export function buildPolicyOptions(context: PolicyContext & { includePresets?: boolean; includeSources?: boolean }) {
  const option = (value: string) => ({ label: policyLabel(value, context), value });
  const groups = [{ label: '内置', options: ['proxy', 'auto', 'direct', 'reject'].map(option) }];
  if (context.groups?.length) {
    groups.push({ label: '自建组', options: context.groups.filter((group) => group.id).map((group) => option(`group:${group.id}`)) });
  }
  groups.push({ label: '地区', options: context.catalog.regions.map((region) => option(`region:${region.id}`)) });
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

/** 列表里的来源说明：远程显示脱敏地址（自定义了 User-Agent 时附上），本地显示内容行数。 */
export function describeSourceOrigin(source: Pick<AggregatorSource, 'kind' | 'url' | 'userAgent' | 'content'>) {
  if (source.kind === 'local') {
    const lines = String(source.content || '').split(/\r?\n/).filter((line) => line.trim()).length;
    return `本地内容 · ${lines} 行`;
  }
  const url = maskSourceUrl(source.url || '');
  return source.userAgent ? `${url} · UA ${source.userAgent}` : url;
}

export function utf8ByteLength(text: string) {
  return new TextEncoder().encode(text).length;
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
  invalid_aggregator_group_name: '策略组名称不能包含逗号、等号或换行',
  duplicate_aggregator_group_name: '策略组重名（也不能和自动生成的组同名）',
  invalid_aggregator_group_cycle: '策略组互相套用成了环',
  invalid_aggregator_group_member: '策略组套用了不存在的组',
  too_many_aggregator_groups: '自建策略组过多（最多 50 个）',
  too_many_aggregator_group_members: '策略组成员过多（最多套用 100 个、勾选 500 个节点）',
  aggregator_profile_not_found: '聚合订阅不存在，可能已被删除',
  subscription_not_found: '订阅源不存在，可能已被删除',
  invalid_subscription_url: '订阅地址必须是 http(s) URL',
  invalid_subscription_user_agent: 'User-Agent 只能是可见 ASCII 字符（最多 200 个）',
  invalid_subscription_content: '本地内容不能为空',
  subscription_content_too_large: '本地内容超过 2 MB',
  unsupported_aggregator_format: '不支持的输出格式',
  unsupported_aggregator_client: '不认识的客户端',
  invalid_aggregator_origin: '服务地址必须是 http(s)://主机[:端口]',
  subscription_url_blocked: '订阅地址指向内网或保留地址，已拦截',
  subscription_fetch_timeout: '拉取订阅超时',
  subscription_fetch_failed: '拉取订阅失败',
  subscription_http_error: '订阅服务器返回错误状态',
  no_valid_proxy_nodes_found: '订阅里没有可用节点'
};

// 预览里「未输出」节点的原因（服务端返回错误码）。
const SKIP_REASON_PATTERNS: Array<[RegExp, (value: string) => string]> = [
  [/^unsupported_proxy_protocol_(.+)$/, (value) => `不支持 ${value}`],
  [/^unsupported_proxy_transport_(.+)$/, (value) => `不支持 ${value} 传输`],
  [/^unsupported_shadowsocks_plugin_(.+)$/, (value) => `不支持 SS 插件 ${value}`],
  [/^unsupported_snell_version_(.+)$/, (value) => `不支持 Snell v${value}`],
  // sing-box 1.14 的 Snell 出站只实现 v4 / v6，与 mihomo 支持到 v3 是两回事。
  [/^unsupported_sing_box_snell_version_(.+)$/, (value) => `sing-box 不支持 Snell v${value}`],
  [/^unsupported_hysteria_protocol_(.+)$/, (value) => `不支持 Hysteria 的 ${value} 传输`],
  [/^missing_required_proxy_field_(.+)$/, (value) => `缺少字段 ${value}`],
  [/^requires_sing_box_(.+)$/, (value) => `需要 sing-box ≥ ${value}`],
  [/^invalid_proxy_link_(.+)$/, (value) => `${value} 链接格式不对`]
];

const GROUP_TYPE_NAMES: Record<string, string> = { fallback: '故障转移', 'load-balance': '负载均衡' };

/** 预览里的提示（服务端警告码 → 说明）。describePolicy 把 region:jp 之类的引用换成组名。 */
export function previewWarningText(warning: string, describePolicy: (policy: string) => string = (policy) => policy) {
  if (warning === 'aggregator_no_nodes') return '没有节点被选中，检查订阅源范围与过滤条件';
  // 上下文本身可能带冒号（rule:DOMAIN,x.com），策略引用只认已知前缀，否则会从错误的位置切开。
  const fallback = warning.match(/^aggregator_policy_fallback:(.+):((?:region|source|preset|group):[^:]+)$/);
  if (fallback) return `「${fallback[1]}」引用的 ${describePolicy(fallback[2])} 没有对应策略组，已改用节点选择`;
  const missing = warning.match(/^aggregator_group_member_missing:(.+):((?:region|source|group):[^:]+)$/);
  if (missing) return `「${missing[1]}」套用的 ${describePolicy(missing[2])} 没有生成（分组没开启或没有节点），已从组里去掉`;
  const degraded = warning.match(/^aggregator_group_type_degraded:(.+):(fallback|load-balance)$/);
  if (degraded) return `这个格式不支持${GROUP_TYPE_NAMES[degraded[2]]}，「${degraded[1]}」改成了延迟最低`;
  return warning;
}

const IMPORT_FORMAT_LABELS: Record<string, string> = {
  clash: 'Clash / mihomo 配置',
  'sing-box': 'sing-box 配置',
  xray: 'Xray / V2Ray 配置（v2rayN 等导出）',
  egern: 'Egern 配置',
  wireguard: 'WireGuard 配置文件',
  'aih-json': 'AI Home 节点 JSON',
  sip008: 'SIP008（Shadowsocks 在线配置）',
  surge: 'Surge / Surfboard / Loon 代理行',
  'quantumult-x': 'Quantumult X 节点',
  uri: '分享链接'
};

/** 节点名前补上推断出的国旗：名称里已经有国旗、或推断不出（🌐）时不加，免得重复或互相矛盾。 */
export function nameWithFlag(name: string, flag: string) {
  if (!flag || flag === '🌐' || /\p{Regional_Indicator}{2}/u.test(name)) return name;
  return `${flag} ${name}`;
}

/** 解析预览识别出的格式名；base64 包裹的写成「Base64 包裹的…」。 */
export function importFormatLabel(format: string): string {
  if (!format) return '未识别的内容';
  if (format.startsWith('base64+')) return `Base64 包裹的${importFormatLabel(format.slice('base64+'.length))}`;
  return IMPORT_FORMAT_LABELS[format] || format;
}

/** 解析预览的一句话：识别为什么、导入几个、跳过几个。 */
export function describeSourcePreview(preview: Pick<AggregatorSourcePreview, 'format' | 'nodes' | 'skippedNodes'>) {
  if (!preview.nodes.length && !preview.skippedNodes.length) return '没有识别出节点';
  const skipped = preview.skippedNodes.length ? `，跳过 ${preview.skippedNodes.length} 个` : '';
  return `识别为${importFormatLabel(preview.format)}：${preview.nodes.length} 个节点${skipped}`;
}

/** 跳过原因按说明文字合并计数（同一原因常常成批出现），出现多的排前面。 */
export function summarizeSkipReasons(skipped: Array<{ reason: string }>) {
  const counts = new Map<string, number>();
  for (const item of skipped) {
    const text = skipReasonText(item.reason);
    counts.set(text, (counts.get(text) || 0) + 1);
  }
  return [...counts].map(([text, count]) => ({ text, count })).sort((a, b) => b.count - a.count);
}

export function skipReasonText(reason: string) {
  if (reason === 'unsupported_hysteria2_obfs') return '不支持 Hysteria2 混淆';
  if (reason === 'invalid_wireguard_endpoint') return 'WireGuard 端点格式不对';
  // 这两条不能落到下面的通用前缀匹配上（会译成「需要 sing-box ≥ official_app」这种看不懂的话）。
  if (reason === 'requires_sing_box_official_app') return '需要 sing-box 官方 App（自带 libcronet）';
  if (reason === 'unsupported_sing_box_snell_obfs_tls') return 'sing-box 不支持 Snell 的 tls 混淆';
  if (reason === 'unsupported_surge_snell_shadow_tls') return 'Surge 的 Snell 不支持 ShadowTLS';
  if (reason === 'unsupported_proxy_protocol_tuic-v4') return '不支持 TUIC v4';
  for (const [pattern, describe] of SKIP_REASON_PATTERNS) {
    const match = reason.match(pattern);
    if (match) return describe(match[1]);
  }
  return reason;
}

/** 自动识别的客户端按拿到的格式分组（格式按 catalog.formats 的顺序）。 */
export function groupClientsByFormat(
  clients: Array<Pick<AggregatorClientInfo, 'name' | 'format'>>,
  formats: Array<Pick<AggregatorFormatInfo, 'id' | 'name'>>
) {
  return formats
    .map((format) => ({
      format: format.id,
      formatName: format.name,
      clientNames: clients.filter((client) => client.format === format.id).map((client) => client.name)
    }))
    .filter((group) => group.clientNames.length > 0);
}

/** 服务地址是不是只有本机能访问（手机扫不了）。 */
export function isLoopbackOrigin(origin: string) {
  try {
    const host = new URL(origin).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host === '::1' || /^127\./.test(host);
  } catch (_error) {
    return false;
  }
}

/** 本机已安装（URL Scheme 有处理程序）的客户端排前面，其余保持服务端给的顺序。 */
export function sortImportClients<T extends Pick<AggregatorImportClient, 'scheme'>>(clients: T[], handlers: Record<string, string | null>) {
  const installed = (client: T) => Boolean(client.scheme && handlers[client.scheme]);
  return [...clients.filter(installed), ...clients.filter((client) => !installed(client))];
}

/** 拉取时间：一小时内显示「N 分钟前」，一天内「N 小时前」，更早显示日期时间。 */
export function formatPullTime(at: number, now = Date.now()) {
  const minutes = Math.floor(Math.max(0, now - at) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 小时前`;
  return new Date(at).toLocaleString();
}

/** 一次拉取的说明：客户端 · 格式（节点视图）· 节点数。 */
export function describePull(pull: Pick<AggregatorPull, 'clientName' | 'format' | 'view' | 'nodes'>, formats: Array<Pick<AggregatorFormatInfo, 'id' | 'name'>>) {
  const format = formats.find((item) => item.id === pull.format)?.name || pull.format;
  return `${pull.clientName} · ${format}${pull.view === 'nodes' ? '（仅节点）' : ''} · ${pull.nodes} 个节点`;
}

/** 接口错误里的错误码（服务端 { error }），没有时取异常消息。 */
export function responseErrorCode(error: unknown) {
  const candidate = error as { response?: { data?: { error?: string } }; message?: string };
  return candidate?.response?.data?.error || candidate?.message;
}

export function aggregatorErrorText(code: string | undefined, fallback: string) {
  if (!code) return fallback;
  return ERROR_TEXT[code] || code;
}
