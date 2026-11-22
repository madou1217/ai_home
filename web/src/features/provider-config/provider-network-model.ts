import type { Account } from '@/types';
import type {
  EgressAccountProbeResult,
  EgressRule,
  EgressUpstream,
  EgressUpstreamAccount
} from '@/features/egress-upstream/types';
import { describeAccountEgress, describeGeo, describeVerdict } from '@/features/egress-upstream/egress-upstream-presentation';

/** 网络页的一行账号：账号信息 + 它所在的上游（同一账号可能命中多个上游，取第一个）。 */
export interface ProviderNetworkRow {
  accountRef: string;
  label: string;
  upstream: EgressUpstream | null;
  entry: EgressUpstreamAccount | null;
}

export interface ProviderNetworkRule {
  id: string;
  text: string;
  effect: 'allow' | 'deny';
  source: 'rule' | 'hint';
  note: string;
}

const EXIT_LABELS: Record<string, string> = {
  pool: '出口池',
  proxy: '代理地址',
  system: '系统代理',
  direct: '直连',
  ssh: 'SSH 出口'
};

/** 探测结果里的出口形态（账号设置或服务端默认网络）。 */
export function probeExitLabel(exit?: string) {
  return EXIT_LABELS[String(exit || '').trim()] || '默认网络';
}

/** 账号当前出口的一句话；未绑定 = 跟随 OAuth 授权时的默认网络。 */
export function describeRowEgress(row: ProviderNetworkRow): {
  label: string;
  tone: 'success' | 'error' | 'default';
  detail: string;
  bound: boolean;
} {
  if (!row.entry) {
    return { label: '默认', tone: 'default', detail: 'OAuth 授权网络', bound: false };
  }
  if (!row.entry.egress) {
    return { label: '默认', tone: 'default', detail: 'OAuth 授权网络', bound: false };
  }
  const badge = describeAccountEgress(row.entry);
  return {
    label: badge.label,
    tone: badge.tone === 'error' ? 'error' : badge.tone === 'success' ? 'success' : 'default',
    detail: badge.detail,
    bound: true
  };
}

/** 当前网络（出口位置 + 判定）；出口池账号显示车道节点。 */
export function describeRowNetwork(row: ProviderNetworkRow): {
  geoText: string;
  verdictLabel: string;
  verdictTone: 'success' | 'error' | 'processing' | 'default' | 'warning';
  detail: string;
} {
  const entry = row.entry;
  if (!entry) {
    return { geoText: '未知', verdictLabel: '未探测', verdictTone: 'default', detail: '该账号还没有上游主机信息' };
  }
  if (entry.lane) {
    const blocked = String(entry.lane.blocked || '').trim();
    const node = entry.lane.activeLabel || entry.lane.activeNode || '选择中';
    return {
      geoText: node,
      verdictLabel: blocked ? '无可用节点' : '出口池车道',
      verdictTone: blocked ? 'error' : 'success',
      detail: blocked || `可用 ${entry.lane.allowedCount}/${entry.lane.scopeCount} 个节点`
    };
  }
  const network = entry.network;
  if (!network) {
    return { geoText: '未知', verdictLabel: '未探测', verdictTone: 'default', detail: '没有可用的网络出口信息' };
  }
  const verdict = describeVerdict({ status: network.status, source: network.source, soft: false });
  return {
    geoText: network.geoText || (network.exit === 'system' ? '系统代理' : '位置未知'),
    verdictLabel: verdict.label,
    verdictTone: verdict.tone,
    detail: network.detail || ''
  };
}

/** 探测结果一句话（用于结果行/提示）。 */
export function describeProbeResult(result: EgressAccountProbeResult): {
  label: string;
  tone: 'success' | 'error' | 'default';
  detail: string;
} {
  if (result.status === 'reachable') {
    const geo = result.geo ? describeGeo(result.geo) : '';
    return {
      label: '可连通',
      tone: 'success',
      detail: [result.reason, probeExitLabel(result.exit), geo, result.node].filter(Boolean).join(' · ')
    };
  }
  if (result.status === 'blocked') {
    return {
      label: '不可用',
      tone: 'error',
      detail: [result.reason || result.error, probeExitLabel(result.exit), result.node].filter(Boolean).join(' · ')
    };
  }
  return {
    label: '未执行',
    tone: 'default',
    detail: [result.reason || result.error, probeExitLabel(result.exit)].filter(Boolean).join(' · ')
  };
}

/** 该上游对当前 Provider 生效的地区规则与预置提示（规则在前）。 */
export function collectProviderRules(upstream: EgressUpstream): ProviderNetworkRule[] {
  const rules: ProviderNetworkRule[] = [];
  for (const rule of upstream.policy.rules || []) {
    rules.push({ id: `rule:${rule.id}`, text: summarizeRule(rule), effect: rule.effect, source: 'rule', note: rule.note });
  }
  for (const hint of upstream.hints || []) {
    rules.push({ id: `hint:${hint.id}`, text: summarizeRule(hint), effect: hint.effect, source: 'hint', note: hint.note });
  }
  return rules;
}

function summarizeRule(rule: Pick<EgressRule, 'effect' | 'match'>): string {
  const parts: string[] = [];
  const match = rule.match;
  if (match.country?.length) parts.push(`国家/地区 ${match.country.join('、')}`);
  if (match.region?.length) parts.push(`省/州 ${match.region.join('、')}`);
  if (match.city?.length) parts.push(`城市 ${match.city.join('、')}`);
  if (match.asn?.length) parts.push(`ASN ${match.asn.join('、')}`);
  if (match.cidr?.length) parts.push(`IP 段 ${match.cidr.join('、')}`);
  if (match.nodes?.length) parts.push(`节点 ${match.nodes.join('、')}`);
  if (match.groups?.length) parts.push(`分组 ${match.groups.join('、')}`);
  return `${rule.effect === 'allow' ? '允许' : '拒绝'} · ${parts.join(' 且 ') || '（空规则）'}`;
}

/**
 * 合并账号列表与上游视图，得到网络页的行。
 *
 * 账号列表是展示权威（包含尚未出现在上游视图里的账号）；上游视图补充出口/车道/判定。
 * 同一账号若命中多个上游，取账号数最多排序后的第一个，保持与上游面板一致。
 */
export function buildProviderNetworkRows(
  accounts: Account[],
  upstreams: EgressUpstream[],
  provider: string
): ProviderNetworkRow[] {
  const normalized = provider.trim().toLowerCase();
  const entries = new Map<string, { upstream: EgressUpstream; entry: EgressUpstreamAccount }>();
  for (const upstream of upstreams) {
    for (const entry of upstream.accounts || []) {
      if (!entries.has(entry.accountRef)) {
        entries.set(entry.accountRef, { upstream, entry });
      }
    }
  }
  const rows: ProviderNetworkRow[] = [];
  const seen = new Set<string>();
  for (const account of accounts) {
    if (String(account.provider || '').trim().toLowerCase() !== normalized) continue;
    const match = entries.get(account.accountRef);
    seen.add(account.accountRef);
    rows.push({
      accountRef: account.accountRef,
      label: account.displayName || account.email || account.accountRef,
      upstream: match?.upstream || null,
      entry: match?.entry || null
    });
  }
  for (const [accountRef, match] of entries) {
    if (seen.has(accountRef)) continue;
    rows.push({
      accountRef,
      label: match.entry.label || accountRef,
      upstream: match.upstream,
      entry: match.entry
    });
  }
  return rows;
}