'use strict';

const net = require('node:net');

// 规则测试：按聚合规划里的规则顺序判断一个域名或 IP 命中哪条规则、落到哪个策略组，
// 再顺着「手动选择」组的默认成员往下走，直到会自动选节点的组、直连 / 拒绝或某个节点。
// GEOSITE / GEOIP 的内容取 MetaCubeX 的 .list（与规则集转换共用缓存）。规划里的 IP 规则都带
// no-resolve：域名不会先解析成 IP 再去匹配 IP 规则，与客户端的实际行为一致。

const MAX_TARGET_LENGTH = 253;
const MAX_LISTED_MEMBERS = 50;
const DOMAIN_PATTERN = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/;

function routeError(code) {
  return Object.assign(new Error(code), { code });
}

/** 输入可以是网址、主机名或 IP（IPv6 可带方括号与端口）；返回 { kind: 'domain' | 'ip', value }。 */
function parseRouteTarget(input) {
  let text = String(input ?? '').trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .replace(/^[^@]*@/, '');
  const bracketed = text.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketed) text = bracketed[1];
  else if (!net.isIP(text)) text = text.replace(/:\d+$/, '');
  text = text.toLowerCase().replace(/\.$/, '');
  if (!text || text.length > MAX_TARGET_LENGTH) throw routeError('invalid_route_target');
  if (net.isIP(text)) return { kind: 'ip', value: text };
  if (!DOMAIN_PATTERN.test(text)) throw routeError('invalid_route_target');
  return { kind: 'domain', value: text };
}

function matchesSuffix(domain, suffix) {
  return domain === suffix || domain.endsWith(`.${suffix}`);
}

function ipType(address) {
  return net.isIP(address) === 6 ? 'ipv6' : 'ipv4';
}

function addCidr(list, cidr) {
  const [address, prefixText] = String(cidr).split('/');
  const family = net.isIP(address);
  if (!family) return;
  const prefix = prefixText === undefined ? (family === 6 ? 128 : 32) : Number(prefixText);
  try {
    list.addSubnet(address, prefix, family === 6 ? 'ipv6' : 'ipv4');
  } catch (_error) {
    // 前缀越界等写错的条目跳过，不影响其余条目。
  }
}

// 规则集条目按数组身份缓存成查询结构：缓存刷新会换成新数组，旧的随之回收。
const domainIndexes = new WeakMap();
const ipIndexes = new WeakMap();

function domainIndex(entries) {
  if (!domainIndexes.has(entries)) {
    const suffixes = new Set();
    const exact = new Set();
    for (const entry of entries) (entry.type === 'suffix' ? suffixes : exact).add(String(entry.value).toLowerCase());
    domainIndexes.set(entries, { suffixes, exact });
  }
  return domainIndexes.get(entries);
}

function domainInRuleSet(domain, entries) {
  const { suffixes, exact } = domainIndex(entries);
  if (exact.has(domain)) return true;
  // 逐级去掉最左边的标签，看任一后缀是否在表里（a.b.example.com → b.example.com → example.com → com）。
  for (let current = domain; current; current = current.slice(current.indexOf('.') + 1)) {
    if (suffixes.has(current)) return true;
    if (!current.includes('.')) break;
  }
  return false;
}

function ipInRuleSet(address, entries) {
  if (!ipIndexes.has(entries)) {
    const list = new net.BlockList();
    for (const entry of entries) if (entry.type === 'ip4' || entry.type === 'ip6') addCidr(list, entry.value);
    ipIndexes.set(entries, list);
  }
  return ipIndexes.get(entries).check(address, ipType(address));
}

function ipInCidr(address, cidr) {
  const list = new net.BlockList();
  addCidr(list, cidr);
  return list.check(address, ipType(address));
}

function matchesPlainRule(match, target) {
  if (target.kind === 'domain') {
    if (match.type === 'domain') return target.value === match.value;
    if (match.type === 'domain-suffix') return matchesSuffix(target.value, match.value);
    if (match.type === 'domain-keyword') return target.value.includes(match.value);
    return false;
  }
  return match.type === 'ip-cidr' && ipInCidr(target.value, match.value);
}

function refLabel(ref) {
  if (ref.kind === 'direct') return 'DIRECT';
  if (ref.kind === 'reject') return 'REJECT';
  return ref.name;
}

/**
 * 从规则的目标出发：手动选择的组在客户端里默认用第一个成员，顺着它往下走；
 * 会自动选的组（延迟最低 / 故障转移 / 负载均衡）到此为止，列出它的成员。
 */
function followDefaults(plan, destination) {
  const byName = new Map(plan.groups.map((group) => [group.name, group]));
  const groups = [];
  const seen = new Set();
  let current = destination;
  while (current && current.kind === 'group' && !seen.has(current.name)) {
    seen.add(current.name);
    const group = byName.get(current.name);
    if (!group) break;
    groups.push({
      name: group.name,
      type: group.type,
      members: group.members.slice(0, MAX_LISTED_MEMBERS).map(refLabel),
      memberCount: group.members.length
    });
    current = group.type === 'select' ? group.members[0] : null;
  }
  return { groups, end: current && current.kind !== 'group' ? { kind: current.kind, name: refLabel(current) } : null };
}

function describeRule(rule, ruleSetsByTag) {
  if (rule.match.type !== 'rule-set') return { origin: rule.origin || null, type: rule.match.type, value: rule.match.value };
  const ruleSet = ruleSetsByTag.get(rule.match.value);
  return { origin: rule.origin || null, type: ruleSet.kind, value: ruleSet.name };
}

/**
 * 判断 input 的去向。loadEntries(ruleSet) 返回规则集条目（见 rule-set-converter）；拉取失败的规则集
 * 记进 unavailable 并跳过，结果仍然给出（界面提示可能不准）。
 */
async function traceRoute(plan, input, { loadEntries }) {
  const target = parseRouteTarget(input);
  const ruleSetsByTag = new Map(plan.ruleSets.map((ruleSet) => [ruleSet.tag, ruleSet]));
  const wantedKind = target.kind === 'ip' ? 'geoip' : 'geosite';
  const relevant = (rule) => rule.match.type !== 'rule-set' || ruleSetsByTag.get(rule.match.value)?.kind === wantedKind;

  // 用得到的规则集先一起拉取，再按顺序判断；前面的规则命中时，其余结果只是进了缓存。
  const pending = new Map();
  for (const rule of plan.rules) {
    if (rule.match.type !== 'rule-set' || !relevant(rule) || pending.has(rule.match.value)) continue;
    const ruleSet = ruleSetsByTag.get(rule.match.value);
    pending.set(ruleSet.tag, Promise.resolve()
      .then(() => loadEntries(ruleSet))
      .then((entries) => ({ entries }), (error) => ({ error: error.code || error.message || 'rule_set_fetch_failed' })));
  }

  const unavailable = [];
  let checked = 0;
  for (const rule of plan.rules) {
    if (!relevant(rule)) continue;
    checked += 1;
    let hit;
    if (rule.match.type === 'rule-set') {
      const loaded = await pending.get(rule.match.value);
      if (loaded.error) {
        const ruleSet = ruleSetsByTag.get(rule.match.value);
        unavailable.push(`${ruleSet.kind}:${ruleSet.name}`);
        continue;
      }
      hit = target.kind === 'ip' ? ipInRuleSet(target.value, loaded.entries) : domainInRuleSet(target.value, loaded.entries);
    } else {
      hit = matchesPlainRule(rule.match, target);
    }
    if (hit) {
      return { target, rule: describeRule(rule, ruleSetsByTag), checked, unavailable: [...new Set(unavailable)], ...followDefaults(plan, rule.target) };
    }
  }
  return {
    target,
    rule: { origin: { kind: 'final' }, type: 'final', value: '' },
    checked,
    unavailable: [...new Set(unavailable)],
    ...followDefaults(plan, plan.final)
  };
}

module.exports = {
  parseRouteTarget,
  traceRoute
};
