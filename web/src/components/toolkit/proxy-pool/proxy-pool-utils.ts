import { message } from 'antd';
import type { ProxyCoreStatus, ProxyNode, ProxyProtocol } from '@/types';

const PROXY_NODE_COMMON_FIELDS = [
  'id', 'name', 'protocol', 'server', 'port', 'group', 'tags',
  'countryCode', 'countryName', 'countryFlag', 'subscriptionId',
  'latencyMs', 'lastChecked'
] as const;

const PROXY_NODE_PROTOCOL_FIELDS: Partial<Record<ProxyProtocol, readonly string[]>> = {
  shadowsocks: ['password', 'cipher', 'plugin', 'pluginOpts'],
  vmess: ['uuid', 'cipher', 'alterId', 'network', 'tls', 'sni', 'path', 'host', 'type', 'alpn', 'serviceName', 'allowInsecure'],
  vless: ['uuid', 'network', 'tls', 'sni', 'path', 'host', 'alpn', 'flow', 'security', 'publicKey', 'shortId', 'fingerprint', 'serviceName', 'allowInsecure'],
  trojan: ['password', 'network', 'tls', 'sni', 'path', 'host', 'alpn', 'serviceName', 'allowInsecure'],
  hysteria2: ['password', 'tls', 'sni', 'insecure', 'allowInsecure', 'obfs', 'obfsPassword', 'upMbps', 'downMbps'],
  socks5: ['username', 'password'],
  http: ['username', 'password', 'tls', 'sni', 'allowInsecure'],
  https: ['username', 'password', 'tls', 'sni', 'allowInsecure']
};

export const FUNCTIONAL_GROUP_OPTIONS = [
  { label: '全部', value: 'all' },
  { label: 'AI 标签', value: 'ai' },
  { label: '开发标签', value: 'dev' },
  { label: '独立端口', value: 'dedicated' }
];

export const PROTOCOL_OPTIONS: Array<{ label: string; value: ProxyProtocol | 'all' }> = [
  { label: '全部协议', value: 'all' },
  { label: 'Shadowsocks', value: 'shadowsocks' },
  { label: 'VMess', value: 'vmess' },
  { label: 'VLESS', value: 'vless' },
  { label: 'Trojan', value: 'trojan' },
  { label: 'Hysteria 2', value: 'hysteria2' },
  { label: 'SOCKS5', value: 'socks5' },
  { label: 'HTTP', value: 'http' }
];

export function buildProxyNodePayload(
  existing: Partial<ProxyNode> = {},
  values: Partial<ProxyNode> = {}
): Partial<ProxyNode> {
  const source = { ...existing, ...values } as Record<string, unknown>;
  const protocol = source.protocol as ProxyProtocol | undefined;
  const allowedFields = [
    ...PROXY_NODE_COMMON_FIELDS,
    ...(protocol ? (PROXY_NODE_PROTOCOL_FIELDS[protocol] || []) : [])
  ];
  const payload: Record<string, unknown> = {};
  for (const field of allowedFields) {
    const value = source[field];
    if (value !== undefined && value !== '') payload[field] = value;
  }
  return payload as Partial<ProxyNode>;
}

export function getErrorMessage(error: unknown, fallback: string) {
  const candidate = error as {
    message?: string;
    response?: { data?: { message?: string; error?: string } };
  };
  return candidate?.response?.data?.message
    || candidate?.response?.data?.error
    || candidate?.message
    || fallback;
}

export function isMutationApplied(result: { ok: boolean; applied?: boolean }) {
  return result.ok && result.applied === true;
}

export function getMutationMessage(
  result: { error?: string; message?: string; warnings?: string[] },
  fallback: string
) {
  return result.message || result.error || result.warnings?.join('；') || fallback;
}

export function maskSubscriptionUrl(value: string) {
  try {
    const url = new URL(value);
    const sensitiveKeys = /token|key|secret|password|passwd|auth/i;
    url.searchParams.forEach((_item, key) => {
      if (sensitiveKeys.test(key)) url.searchParams.set(key, 'REDACTED');
    });
    if (url.username) url.username = 'REDACTED';
    if (url.password) url.password = 'REDACTED';
    return url.toString();
  } catch {
    return value.length > 72 ? `${value.slice(0, 44)}…${value.slice(-12)}` : value;
  }
}

export function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function copyText(value: string, successMessage: string) {
  try {
    await navigator.clipboard.writeText(value);
    message.success(successMessage);
  } catch {
    message.error('无法访问剪贴板，请手动复制');
  }
}

export function formatLastSynced(timestamp: number | null) {
  if (!timestamp) return '尚未同步';
  return new Date(timestamp).toLocaleString();
}

export function coreStatusPresentation(core: ProxyCoreStatus | null) {
  if (!core) {
    return { type: 'info' as const, title: '正在读取代理核心状态', description: '尚未取得数据面状态。' };
  }
  if (!core.installed) {
    return {
      type: 'error' as const,
      title: 'Mihomo 代理核心未安装',
      description: '节点仍可管理和导出，但测速、分流和独立端口不会伪装为可用。安装后可通过 AIH_MIHOMO_BIN 指定二进制。'
    };
  }
  if (!core.running) {
    const source = core.binarySource === 'known-app'
      ? '复用已安装的外部 Mihomo/Clash Verge 二进制'
      : core.binarySource === 'managed'
        ? '使用 AIH 托管的 Mihomo 二进制'
        : '';
    return {
      type: 'warning' as const,
      title: 'Mihomo 已检测到，但数据面未启动',
      description: [source, core.lastError || '启动核心后，真实代理流量、测速和分流才会生效。'].filter(Boolean).join('；')
    };
  }
  if (!core.dataPlaneReady) {
    return {
      type: 'error' as const,
      title: 'Mihomo 进程未通过就绪检查',
      description: core.lastError || '控制端口尚未就绪，所有数据面操作保持禁用。'
    };
  }
  return {
    type: 'success' as const,
    title: 'Mihomo 数据面已就绪',
    description: `${core.version || core.binaryName || 'mihomo'}；mixed 端口 127.0.0.1:${core.mixedPort || 10800}；测速、分流与独立 mixed 端口均由真实代理核心执行。`
  };
}
