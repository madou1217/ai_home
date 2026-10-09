'use strict';

const { compileSingBoxNodeOutbound } = require('../../proxy-pool/cores/sing-box/node-outbound');
const { ruleSetUrl } = require('../catalog');

const DIRECT_TAG = 'direct';
const MATCH_FIELDS = Object.freeze({
  domain: 'domain',
  'domain-suffix': 'domain_suffix',
  'domain-keyword': 'domain_keyword',
  'ip-cidr': 'ip_cidr'
});

function outboundTag(ref) {
  return ref.kind === 'direct' ? DIRECT_TAG : ref.name;
}

function compileGroup(group) {
  const outbounds = group.members.map(outboundTag);
  if (group.type === 'url-test') {
    return {
      type: 'urltest',
      tag: group.name,
      outbounds,
      url: group.testUrl,
      interval: `${group.interval}s`,
      tolerance: 50
    };
  }
  return { type: 'selector', tag: group.name, outbounds, default: outbounds[0] };
}

function compileRule(rule) {
  const { type, value } = rule.match;
  const matcher = type === 'rule-set' ? { rule_set: [value] } : { [MATCH_FIELDS[type]]: [value] };
  return rule.target.kind === 'reject'
    ? { ...matcher, action: 'reject' }
    : { ...matcher, outbound: outboundTag(rule.target) };
}

/**
 * sing-box 完整配置（1.12+ 新 DNS 与规则动作语法；SFM/SFI/SFA 可直接订阅）。
 * 拒绝只能是规则动作，所以规划阶段已把 REJECT 从策略组成员里去掉（rejectInGroups=false）。
 */
module.exports = Object.freeze({
  id: 'sing-box',
  name: 'sing-box',
  contentType: 'application/json; charset=utf-8',
  extension: 'json',
  capabilities: Object.freeze({ rejectInGroups: false, groups: true }),
  compileNode(entry) {
    return compileSingBoxNodeOutbound(entry.node, entry.name);
  },
  render(plan, compiledNodes) {
    const proxyGroupTag = plan.groups[0]?.name;
    const hasCnRuleSet = plan.ruleSets.some((ruleSet) => ruleSet.tag === 'geosite-cn');
    const config = {
      log: { level: 'warn', timestamp: true },
      dns: {
        servers: [
          { type: 'https', tag: 'dns-remote', server: '1.1.1.1', detour: proxyGroupTag },
          { type: 'https', tag: 'dns-direct', server: '223.5.5.5' }
        ],
        rules: hasCnRuleSet ? [{ rule_set: ['geosite-cn'], server: 'dns-direct' }] : [],
        final: 'dns-remote',
        strategy: 'ipv4_only'
      },
      inbounds: [
        { type: 'tun', tag: 'tun-in', address: ['172.19.0.1/30'], auto_route: true, strict_route: true },
        { type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: 2080 }
      ],
      outbounds: [
        ...plan.groups.map(compileGroup),
        ...compiledNodes,
        { type: 'direct', tag: DIRECT_TAG }
      ],
      route: {
        rules: [
          { action: 'sniff' },
          { protocol: 'dns', action: 'hijack-dns' },
          ...plan.rules.map(compileRule)
        ],
        rule_set: plan.ruleSets.map((ruleSet) => ({
          type: 'remote',
          tag: ruleSet.tag,
          format: 'binary',
          url: ruleSetUrl(ruleSet, 'sing-box'),
          download_detour: DIRECT_TAG
        })),
        final: outboundTag(plan.final),
        auto_detect_interface: true,
        default_domain_resolver: 'dns-direct'
      },
      experimental: { cache_file: { enabled: true } }
    };
    return `${JSON.stringify(config, null, 2)}\n`;
  }
});
