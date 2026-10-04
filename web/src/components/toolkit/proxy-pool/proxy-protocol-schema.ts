import type { ProxyNode, ProxyProtocolField, ProxyProtocolPlugin } from '@/types';

const COMMON_NODE_FIELDS = [
  'id', 'name', 'protocol', 'server', 'port', 'group', 'tags',
  'countryCode', 'countryName', 'countryFlag', 'subscriptionId',
  'latencyMs', 'lastChecked'
] as const;

const TRANSPORT_OPTIONS = [
  { label: 'TCP', value: 'tcp' },
  { label: 'WebSocket', value: 'ws' },
  { label: 'gRPC', value: 'grpc' }
];

const FIELD: Record<string, ProxyProtocolField> = {
  uuid: { key: 'uuid', label: 'UUID', type: 'text', required: true, placeholder: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' },
  password: { key: 'password', label: '密码 / 密钥', type: 'password', required: true },
  optionalPassword: { key: 'password', label: '密码（可选）', type: 'password' },
  optionalUsername: { key: 'username', label: '用户名（可选）', type: 'text' },
  cipher: { key: 'cipher', label: '加密方式', type: 'text', required: true, placeholder: 'aes-256-gcm / chacha20-ietf-poly1305' },
  network: { key: 'network', label: '传输网络', type: 'select', row: 'transport', options: TRANSPORT_OPTIONS },
  tls: { key: 'tls', label: 'TLS', type: 'switch', row: 'transport' },
  sni: { key: 'sni', label: 'SNI / Server name', type: 'text', row: 'tls', placeholder: '可选' },
  path: { key: 'path', label: '路径', type: 'text', row: 'tls', placeholder: '/ws（可选）' }
};

/**
 * 旧服务端（没有 /proxy-pool/protocols）的兜底清单，与服务端协议插件声明保持一致。
 * 新服务端一律以接口下发的插件清单为准。
 */
export const FALLBACK_PROXY_PROTOCOLS: ProxyProtocolPlugin[] = [
  { id: 'shadowsocks', name: 'Shadowsocks', protocols: ['shadowsocks'], editor: { fields: [FIELD.password, FIELD.cipher] }, nodeFields: ['password', 'cipher', 'plugin', 'pluginOpts'] },
  { id: 'vmess', name: 'VMess', protocols: ['vmess'], editor: { fields: [FIELD.uuid, FIELD.network, FIELD.tls, FIELD.sni, FIELD.path] }, nodeFields: ['uuid', 'cipher', 'alterId', 'network', 'tls', 'sni', 'path', 'host', 'type', 'alpn', 'serviceName', 'allowInsecure'] },
  { id: 'vless', name: 'VLESS', protocols: ['vless'], editor: { fields: [FIELD.uuid, FIELD.network, FIELD.tls, FIELD.sni, FIELD.path] }, nodeFields: ['uuid', 'network', 'tls', 'sni', 'path', 'host', 'alpn', 'flow', 'security', 'publicKey', 'shortId', 'fingerprint', 'serviceName', 'allowInsecure'] },
  { id: 'trojan', name: 'Trojan', protocols: ['trojan'], editor: { fields: [FIELD.password, FIELD.sni, FIELD.path] }, nodeFields: ['password', 'network', 'tls', 'sni', 'path', 'host', 'alpn', 'serviceName', 'allowInsecure'] },
  { id: 'hysteria2', name: 'Hysteria2', protocols: ['hysteria2'], editor: { fields: [FIELD.password, FIELD.sni] }, nodeFields: ['password', 'tls', 'sni', 'insecure', 'allowInsecure', 'obfs', 'obfsPassword', 'upMbps', 'downMbps'] },
  { id: 'socks5', name: 'SOCKS5', protocols: ['socks5'], editor: { fields: [FIELD.optionalPassword, FIELD.optionalUsername] }, nodeFields: ['username', 'password'] },
  { id: 'http', name: 'HTTP / HTTPS', protocols: ['http', 'https'], editor: { fields: [FIELD.optionalPassword, FIELD.optionalUsername] }, nodeFields: ['username', 'password', 'tls', 'sni', 'allowInsecure'] }
];

export function findProtocolPlugin(plugins: ProxyProtocolPlugin[], protocol: string | undefined) {
  if (!protocol) return undefined;
  return plugins.find((plugin) => plugin.protocols.includes(protocol));
}

/** 只保留通用字段与该协议插件声明的字段，避免切换协议后残留无关字段。 */
export function buildProxyNodePayload(
  plugins: ProxyProtocolPlugin[],
  existing: Partial<ProxyNode> = {},
  values: Partial<ProxyNode> = {}
): Partial<ProxyNode> {
  const source = { ...existing, ...values } as Record<string, unknown>;
  const plugin = findProtocolPlugin(plugins, source.protocol as string | undefined);
  const allowedFields = [...COMMON_NODE_FIELDS, ...(plugin?.nodeFields || [])];
  const payload: Record<string, unknown> = {};
  for (const field of allowedFields) {
    const value = source[field];
    if (value !== undefined && value !== '') payload[field] = value;
  }
  return payload as Partial<ProxyNode>;
}

export function protocolSelectOptions(plugins: ProxyProtocolPlugin[]) {
  return plugins.map((plugin) => ({ label: plugin.name, value: plugin.protocols[0] }));
}

export function protocolFilterOptions(plugins: ProxyProtocolPlugin[]) {
  return [{ label: '全部协议', value: 'all' }, ...protocolSelectOptions(plugins)];
}

/** 把字段按 row 分组：相邻同 row 的字段并排展示，其余单独一行。 */
export function groupProtocolFields(fields: ProxyProtocolField[]) {
  const groups: ProxyProtocolField[][] = [];
  for (const field of fields) {
    const last = groups[groups.length - 1];
    if (field.row && last && last[0].row === field.row) last.push(field);
    else groups.push([field]);
  }
  return groups;
}
