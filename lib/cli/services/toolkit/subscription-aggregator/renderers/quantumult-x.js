'use strict';

const net = require('node:net');
const { compileQuantumultXLine } = require('../../proxy-pool/cores/surge/proxy-line');
const { sanitizeSurgeName } = require('../../proxy-pool/protocol-parsers/surge-line');
const { testUrlOf } = require('./surge-family');

const PROTOCOLS = Object.freeze(['shadowsocks', 'shadowsocksr', 'vmess', 'vless', 'trojan', 'socks5', 'http', 'https']);

const MATCH_KEYWORDS = Object.freeze({
  domain: 'host',
  'domain-suffix': 'host-suffix',
  'domain-keyword': 'host-keyword'
});

function unsupported(protocol) {
  const error = new Error(`unsupported_proxy_protocol_${protocol}`);
  error.code = error.message;
  return error;
}

function policyName(ref) {
  if (ref.kind === 'direct') return 'direct';
  if (ref.kind === 'reject') return 'reject';
  return sanitizeSurgeName(ref.name);
}

function compileGroup(group) {
  const name = sanitizeSurgeName(group.name);
  const members = group.members.map(policyName);
  // url-latency-benchmark 只能测节点；没有节点时退成只含 direct 的静态组，配置仍可加载。
  if (group.type === 'url-test' && members.length) {
    return `url-latency-benchmark=${name}, ${members.join(', ')}, check-interval=${group.interval}, tolerance=50, alive-checking=false`;
  }
  return `static=${name}, ${(members.length ? members : ['direct']).join(', ')}`;
}

function compileLocalRule(rule) {
  const target = policyName(rule.target);
  const { type, value } = rule.match;
  if (type === 'ip-cidr') {
    const keyword = net.isIP(value.split('/')[0]) === 6 ? 'ip6-cidr' : 'ip-cidr';
    return `${keyword}, ${value}, ${target}, no-resolve`;
  }
  return `${MATCH_KEYWORDS[type]}, ${value}, ${target}`;
}

/**
 * Quantumult X 配置：节点行由协议插件的 compile['quantumult-x'] 生成；规则集写进 [filter_remote]，
 * 指向 AIH 的转换地址（行内策略由 force-policy 统一覆盖），其余规则与 final 在 [filter_local]。
 */
module.exports = Object.freeze({
  id: 'quantumult-x',
  name: 'Quantumult X',
  contentType: 'text/plain; charset=utf-8',
  extension: 'conf',
  capabilities: Object.freeze({
    rejectInGroups: true,
    groups: true,
    protocols: PROTOCOLS,
    ruleSetFormat: 'quantumult-x',
    sanitizeName: sanitizeSurgeName
  }),
  compileNode(entry) {
    const protocol = String(entry.node.protocol || '').toLowerCase();
    if (!PROTOCOLS.includes(protocol)) throw unsupported(protocol);
    return compileQuantumultXLine(entry.node, entry.name);
  },
  render(plan, lines, context) {
    const ruleSetsByTag = new Map(plan.ruleSets.map((ruleSet) => [ruleSet.tag, ruleSet]));
    const remoteRules = [];
    const localRules = [];
    for (const rule of plan.rules) {
      if (rule.match.type !== 'rule-set') {
        localRules.push(compileLocalRule(rule));
        continue;
      }
      const ruleSet = ruleSetsByTag.get(rule.match.value);
      const url = ruleSet ? context.ruleSetUrl(ruleSet) : '';
      if (url) {
        remoteRules.push(`${url}, tag=${ruleSet.tag}, force-policy=${policyName(rule.target)}, update-interval=86400, opt-parser=false, enabled=true`);
      }
    }
    const testUrl = testUrlOf(plan);
    return [
      '[general]',
      `network_check_url=${testUrl}`,
      `server_check_url=${testUrl}`,
      'server_check_timeout=3000',
      'excluded_routes=192.168.0.0/16, 172.16.0.0/12, 100.64.0.0/10, 10.0.0.0/8',
      '',
      '[dns]',
      'server=223.5.5.5',
      'server=119.29.29.29',
      '',
      '[policy]',
      ...plan.groups.map(compileGroup),
      '',
      '[server_local]',
      ...lines,
      '',
      '[filter_remote]',
      ...remoteRules,
      '',
      '[filter_local]',
      ...localRules,
      `final, ${policyName(plan.final)}`,
      ''
    ].join('\n');
  }
});
