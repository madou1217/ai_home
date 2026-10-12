import type { AggregatorGroupTypeInfo, AggregatorPresetInfo, AggregatorRouteTrace, AggregatorRuleType } from './types';

const MATCH_LABELS: Record<string, string> = {
  domain: '完整域名',
  'domain-suffix': '域名及子域名',
  'domain-keyword': '域名关键字',
  'ip-cidr': 'IP 段',
  geosite: 'GEOSITE',
  geoip: 'GEOIP'
};

const MAX_END_MEMBERS = 6;

/** 命中的规则：来源（内置 / 第几条自定义规则 / 哪个规则组）加匹配方式。 */
export function describeTraceRule(rule: AggregatorRouteTrace['rule'], presets: Array<Pick<AggregatorPresetInfo, 'id' | 'name'>>) {
  const origin = rule.origin;
  if (!origin || origin.kind === 'final') return '没有规则命中，走漏网之鱼';
  const match = `${MATCH_LABELS[rule.type] || rule.type} ${rule.value}`;
  if (origin.kind === 'private') return `内置：局域网与保留地址（${match}）`;
  if (origin.kind === 'custom') return `自定义规则第 ${origin.index + 1} 条（${match}）`;
  const preset = presets.find((item) => item.id === origin.id);
  return `规则组「${preset?.name || origin.id}」（${match}）`;
}

/** 走过的组：手动选择的组注明「默认第一项」（客户端里可以切换），会自动选的组写策略名。 */
export function describeTraceGroups(
  groups: AggregatorRouteTrace['groups'],
  groupTypes: Array<Pick<AggregatorGroupTypeInfo, 'id' | 'name'>>
) {
  return groups.map((group) => {
    if (group.type === 'select') return `${group.name}（手动选择，默认第一项）`;
    return `${group.name}（${groupTypes.find((type) => type.id === group.type)?.name || group.type}）`;
  });
}

/** 最终去向：直连 / 拒绝 / 某个节点，或在最后那个会自动选的组的成员里选。 */
export function describeTraceEnd(trace: Pick<AggregatorRouteTrace, 'end' | 'groups'>) {
  if (trace.end) {
    if (trace.end.kind === 'direct') return '直连 DIRECT';
    if (trace.end.kind === 'reject') return '拒绝 REJECT';
    return `节点 ${trace.end.name}`;
  }
  const last = trace.groups[trace.groups.length - 1];
  if (!last) return '';
  const names = last.members.slice(0, MAX_END_MEMBERS).join('、');
  return `在 ${last.memberCount} 个成员里自动选：${names}${last.memberCount > MAX_END_MEMBERS ? ' 等' : ''}`;
}

// 二级公共后缀（bbc.co.uk、sina.com.cn）：默认规则要多带一级，不能只写 co.uk。
const SECOND_LEVEL_LABELS = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac']);

/**
 * 「为它添加规则」的候选：IP 给单个地址的 IP 段；域名给自身及各级上级域名（至少两级），
 * defaultIndex 指向主域名（www.youtube.com → youtube.com，news.bbc.co.uk → bbc.co.uk）。
 */
export function traceRuleCandidates(target: AggregatorRouteTrace['target']) {
  if (target.kind === 'ip') {
    const rule = { type: 'IP-CIDR' as AggregatorRuleType, value: `${target.value}/${target.value.includes(':') ? 128 : 32}` };
    return { candidates: [rule], defaultIndex: 0 };
  }
  const labels = target.value.split('.');
  if (labels.length < 2) return { candidates: [{ type: 'DOMAIN-SUFFIX' as AggregatorRuleType, value: target.value }], defaultIndex: 0 };
  const candidates = labels.slice(0, -1).map((_label, start) => ({ type: 'DOMAIN-SUFFIX' as AggregatorRuleType, value: labels.slice(start).join('.') }));
  const tld = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  const keep = tld.length === 2 && SECOND_LEVEL_LABELS.has(second) && labels.length >= 3 ? 3 : 2;
  return { candidates, defaultIndex: candidates.length - (keep - 1) };
}
