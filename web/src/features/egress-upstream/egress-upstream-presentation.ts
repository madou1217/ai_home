// 上游地区策略的纯展示逻辑（被 PoolScopePicker / EgressUpstreamPanel / 账号出口弹窗共用）。

import type {
  EgressCatalogGroup,
  EgressGeo,
  EgressMatchField,
  EgressNodeVerdict,
  EgressPoolScope,
  EgressRule,
  EgressUpstream,
  EgressUpstreamAccount,
  EgressUpstreamNode,
  EgressVerdictStatus
} from './types';

export const MATCH_FIELD_LABELS: Record<EgressMatchField, string> = {
  country: '国家/地区',
  region: '省/州',
  city: '城市',
  asn: 'ASN',
  cidr: 'IP 段',
  nodes: '节点',
  groups: '自建分组'
};

export const EDITABLE_MATCH_FIELDS: EgressMatchField[] = ['country', 'region', 'city', 'asn', 'cidr'];

export type VerdictTone = 'success' | 'error' | 'processing' | 'default' | 'warning';

/** 判定 → 标签文字 + 色调。soft = 依据只是预置提示 / 位置推断，可被实测推翻。 */
export function describeVerdict(verdict: Pick<EgressNodeVerdict, 'status' | 'source' | 'soft'> | null | undefined): { label: string; tone: VerdictTone } {
  if (!verdict) return { label: '未知', tone: 'default' };
  const { status, source } = verdict;
  if (status === 'pending') return { label: '查询位置中', tone: 'processing' };
  if (status === 'denied') {
    if (source === 'rule') return { label: '规则拒绝', tone: 'error' };
    if (source === 'evidence') return { label: '实测被拒', tone: 'error' };
    return { label: '提示拒绝', tone: 'warning' };
  }
  if (status === 'allowed') {
    if (source === 'rule') return { label: '规则允许', tone: 'success' };
    if (source === 'evidence') return { label: verdict.soft ? '可连通' : '实测可用', tone: 'success' };
    return { label: '位置允许', tone: 'success' };
  }
  return { label: '未知', tone: 'default' };
}

export function isUsable(status: EgressVerdictStatus) {
  return status === 'allowed' || status === 'unknown';
}

/** 「🇺🇸 US」：国家码 → 旗帜 + 码；没有国家码返回 ''。 */
export function countryFlag(code?: string | null) {
  const value = String(code || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(value)) return '';
  return String.fromCodePoint(...[...value].map((char) => 0x1f1a5 + char.charCodeAt(0)));
}

export function describeGeo(geo?: EgressGeo | null) {
  if (!geo || !geo.country) return '位置未知';
  return [`${countryFlag(geo.country)} ${geo.country}`, geo.region, geo.city !== geo.region ? geo.city : ''].filter(Boolean).join(' · ');
}

/** 规则一句话：「拒绝 · 国家/地区 HK、MO · 城市 hong kong」。 */
export function summarizeRule(rule: Pick<EgressRule, 'effect' | 'match'>) {
  const parts = (Object.keys(MATCH_FIELD_LABELS) as EgressMatchField[])
    .filter((field) => rule.match[field] && rule.match[field].length)
    .map((field) => `${MATCH_FIELD_LABELS[field]} ${rule.match[field].join('、')}`);
  return `${rule.effect === 'allow' ? '允许' : '拒绝'} · ${parts.join(' 且 ') || '（空规则）'}`;
}

export function emptyMatch() {
  return { country: [], region: [], city: [], asn: [], cidr: [], nodes: [], groups: [] };
}

/** 有效期：「7 天」「12 小时」「30 分钟」。 */
export function formatTtl(ms: number) {
  const value = Number(ms) || 0;
  const day = 24 * 60 * 60 * 1000;
  const hour = 60 * 60 * 1000;
  if (value >= day && value % day === 0) return `${value / day} 天`;
  if (value >= hour && value % hour === 0) return `${value / hour} 小时`;
  return `${Math.max(1, Math.round(value / 60000))} 分钟`;
}

/** 节点在范围内吗（scope.nodes 是出口身份，groups 是自建分组 id）。 */
export function nodeInScope(node: Pick<EgressUpstreamNode, 'identity' | 'groups'>, scope: EgressPoolScope) {
  if (scope.kind === 'nodes') return scope.nodes.includes(node.identity);
  if (scope.kind === 'groups') return node.groups.some((group) => scope.groups.includes(group));
  return true;
}

/** 范围 × 判定的汇总（弹窗里的「将使用 N 个节点」）。 */
export function summarizeScope(nodes: EgressUpstreamNode[], scope: EgressPoolScope) {
  const inScope = nodes.filter((node) => nodeInScope(node, scope));
  const usable = inScope.filter((node) => isUsable(node.verdict.status));
  const denied = inScope.filter((node) => node.verdict.status === 'denied');
  const pending = inScope.filter((node) => node.verdict.status === 'pending');
  return { inScope: inScope.length, usable: usable.length, denied: denied.length, pending: pending.length };
}

export function describeScopeSummary(summary: ReturnType<typeof summarizeScope>) {
  if (summary.inScope === 0) return { tone: 'error' as const, text: '所选范围里没有节点' };
  if (summary.usable === 0) {
    return summary.pending > 0
      ? { tone: 'warning' as const, text: `正在查询 ${summary.pending} 个节点的位置，查到后才会放行` }
      : { tone: 'error' as const, text: `所选 ${summary.inScope} 个节点都被该上游拒绝，账号将无法出网` };
  }
  const extra = [
    summary.denied ? `排除 ${summary.denied} 个被拒` : '',
    summary.pending ? `${summary.pending} 个待查位置` : ''
  ].filter(Boolean).join('，');
  return { tone: 'success' as const, text: `将使用 ${summary.usable} 个节点${extra ? `（${extra}）` : ''}` };
}

/** 节点里出现过的国家（地区筛选芯片），按数量降序。 */
export function countriesOf(nodes: EgressUpstreamNode[]) {
  const counts = new Map<string, number>();
  nodes.forEach((node) => {
    const country = node.geo?.country || '';
    if (country) counts.set(country, (counts.get(country) || 0) + 1);
  });
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([code, count]) => ({ code, count }));
}

export function groupLabel(group: EgressCatalogGroup) {
  return `${group.name} · ${group.profileName}（${group.size}）`;
}

/** 同上游里还没设置出口的其它账号（保存后提示「一起设置」）。 */
export function sameUpstreamUnbound(upstream: EgressUpstream | null | undefined, accountRef: string): EgressUpstreamAccount[] {
  if (!upstream) return [];
  return upstream.accounts.filter((account) => account.accountRef !== accountRef && !account.egress);
}

/** 账号的出口一句话（账号列表徽标 / 上游面板）。 */
export function describeAccountEgress(account: EgressUpstreamAccount) {
  if (account.network && account.network.status === 'denied') {
    return { tone: 'error' as const, label: '网络被拒', detail: account.network.detail };
  }
  if (!account.egress) return { tone: 'default' as const, label: '未设置', detail: '使用默认网络' };
  if (account.egress.mode === 'pool') {
    if (account.lane && account.lane.blocked) return { tone: 'error' as const, label: '出口池无可用节点', detail: account.lane.blocked };
    const strategy = account.egress.strategy === 'sticky' ? '独占' : account.egress.strategy === 'session' ? '会话独占' : '共享';
    return {
      tone: 'success' as const,
      label: `出口池 · ${strategy}`,
      detail: account.lane ? `${account.lane.activeLabel || account.lane.activeNode || '选择中'} · 可用 ${account.lane.allowedCount}/${account.lane.scopeCount}` : ''
    };
  }
  const labels: Record<string, string> = { url: '代理地址', system: '系统代理', tun: '外部 TUN' };
  return { tone: 'success' as const, label: labels[account.egress.mode] || account.egress.mode, detail: account.network?.geoText || '' };
}

export type BulkQuickSelect = 'unbound' | 'denied' | 'none';

/** 批量设置的快捷选择：未设置出口的 / 当前网络被拒的。 */
export function quickSelectAccounts(upstreams: EgressUpstream[], kind: BulkQuickSelect) {
  if (kind === 'none') return [];
  return upstreams.flatMap((upstream) => upstream.accounts
    .filter((account) => (kind === 'unbound'
      ? !account.egress
      : account.network?.status === 'denied'))
    .map((account) => account.accountRef));
}

/** 所选账号是否属于同一个上游（是 → 弹窗可以显示该上游的节点判定）。 */
export function commonUpstream(upstreams: EgressUpstream[], accountRefs: string[]) {
  if (accountRefs.length === 0) return null;
  const owners = new Set(accountRefs.map((ref) => upstreams.find((upstream) => upstream.accounts.some((account) => account.accountRef === ref))?.id || ''));
  if (owners.size !== 1) return null;
  const [id] = [...owners];
  return upstreams.find((upstream) => upstream.id === id) || null;
}
