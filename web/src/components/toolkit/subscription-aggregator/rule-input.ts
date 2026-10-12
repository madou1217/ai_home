import type { AggregatorRuleType } from './types';

export interface QuickRule {
  type: AggregatorRuleType;
  value: string;
}

export const RULE_TYPE_LABELS: Record<AggregatorRuleType, string> = {
  DOMAIN: '完整域名',
  'DOMAIN-SUFFIX': '域名及子域名',
  'DOMAIN-KEYWORD': '域名关键字',
  'IP-CIDR': 'IP 段',
  GEOSITE: '网站集（GEOSITE）',
  GEOIP: 'IP 归属地（GEOIP）'
};

// 与服务端 profile-schema 的校验保持一致：不合规的输入在这里就认不出，不会等到保存才报错。
const DOMAIN_PATTERN = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)+$/;
const RULE_SET_NAME_PATTERN = /^[a-z0-9!@._-]+$/;
const KEYWORD_PATTERN = /^[^\s,]+$/;
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const PREFIXED_PATTERN = /^(geosite|geoip|keyword|domain)\s*[:：]\s*(\S+)$/i;

function isIpv6(address: string) {
  if (!/^[0-9a-f:]+$/i.test(address) || (address.match(/::/g) || []).length > 1) return false;
  const groups = address.split(':');
  if (groups.some((group) => group.length > 4)) return false;
  return address.includes('::') ? groups.length <= 8 : groups.length === 8;
}

function parseIpRule(text: string): QuickRule | null {
  const [address, prefixText, extra] = text.split('/');
  if (extra !== undefined || (prefixText !== undefined && !/^\d{1,3}$/.test(prefixText))) return null;
  const v4 = address.match(IPV4_PATTERN);
  if (v4) {
    const prefix = prefixText === undefined ? 32 : Number(prefixText);
    return v4.slice(1).every((octet) => Number(octet) <= 255) && prefix <= 32 ? { type: 'IP-CIDR', value: `${address}/${prefix}` } : null;
  }
  if (isIpv6(address)) {
    const prefix = prefixText === undefined ? 128 : Number(prefixText);
    return prefix <= 128 ? { type: 'IP-CIDR', value: `${address.toLowerCase()}/${prefix}` } : null;
  }
  return null;
}

/** 粘贴的网址只取主机名：去掉协议、账号、端口、路径与开头的 *. / 点。 */
function hostFromInput(text: string) {
  return text
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .replace(/^[^@]*@/, '')
    .replace(/:\d+$/, '')
    .replace(/^(?:\*\.|\.)/, '')
    .toLowerCase();
}

/**
 * 快速添加分流规则：域名或网址 → 域名及子域名，IP / CIDR → IP 段，
 * geosite:名称、geoip:国家代码、keyword:关键字、domain:完整域名 → 对应类型；
 * 不带点的单词按域名关键字处理。认不出返回 null。
 */
export function parseQuickRule(input: string): QuickRule | null {
  const text = String(input || '').trim();
  if (!text) return null;
  const prefixed = text.match(PREFIXED_PATTERN);
  if (prefixed) {
    const kind = prefixed[1].toLowerCase();
    const value = prefixed[2].toLowerCase();
    if (kind === 'keyword') return KEYWORD_PATTERN.test(value) ? { type: 'DOMAIN-KEYWORD', value } : null;
    if (kind === 'domain') {
      const host = hostFromInput(value);
      return DOMAIN_PATTERN.test(host) ? { type: 'DOMAIN', value: host } : null;
    }
    return RULE_SET_NAME_PATTERN.test(value) ? { type: kind === 'geosite' ? 'GEOSITE' : 'GEOIP', value } : null;
  }
  // 全是数字和点（可能带 /前缀）或者只由十六进制与冒号组成：按 IP 处理，不合法就是认不出，不当成域名。
  if (/^[\d.]+(?:\/\d+)?$/.test(text) || /^[0-9a-f:]*:[0-9a-f:]*(?:\/\d+)?$/i.test(text)) return parseIpRule(text);
  // 按网站匹配时 www. 是多余的：去掉后子域名（m.、music.）也能命中。
  const host = hostFromInput(text).replace(/^www\.(?=[^.]+\.)/, '');
  if (DOMAIN_PATTERN.test(host)) return { type: 'DOMAIN-SUFFIX', value: host };
  if (KEYWORD_PATTERN.test(host) && !host.includes('.')) return { type: 'DOMAIN-KEYWORD', value: host };
  return null;
}

/** 规则的简短写法（与 parseQuickRule 的输入互通），用于标签展示。 */
export function formatQuickRule(rule: QuickRule) {
  switch (rule.type) {
    case 'DOMAIN-SUFFIX':
    case 'IP-CIDR':
      return rule.value;
    case 'DOMAIN':
      return `domain:${rule.value}`;
    case 'DOMAIN-KEYWORD':
      return `keyword:${rule.value}`;
    default:
      return `${rule.type.toLowerCase()}:${rule.value}`;
  }
}
