'use strict';

const net = require('node:net');
const { compileMihomoProxy, emitYaml } = require('../../proxy-pool/cores/mihomo/proxy-compiler');
const { ruleSetUrl } = require('../catalog');

const MATCH_KEYWORDS = Object.freeze({
  domain: 'DOMAIN',
  'domain-suffix': 'DOMAIN-SUFFIX',
  'domain-keyword': 'DOMAIN-KEYWORD'
});

function targetName(ref) {
  if (ref.kind === 'direct') return 'DIRECT';
  if (ref.kind === 'reject') return 'REJECT';
  return ref.name;
}

function compileGroup(group) {
  const compiled = { name: group.name, type: group.type, proxies: group.members.map(targetName) };
  if (group.type === 'url-test') {
    compiled.url = group.testUrl;
    compiled.interval = group.interval;
    compiled.tolerance = 50;
  }
  return compiled;
}

function compileRule(rule) {
  const target = targetName(rule.target);
  const { type, value } = rule.match;
  if (type === 'rule-set') return `RULE-SET,${value},${target}${rule.noResolve ? ',no-resolve' : ''}`;
  if (type === 'ip-cidr') {
    const keyword = net.isIP(value.split('/')[0]) === 6 ? 'IP-CIDR6' : 'IP-CIDR';
    return `${keyword},${value},${target},no-resolve`;
  }
  return `${MATCH_KEYWORDS[type]},${value},${target}`;
}

/** Clash Meta / mihomo 完整配置（Clash Verge Rev、Mihomo Party、Stash 等可直接订阅）。 */
module.exports = Object.freeze({
  id: 'mihomo',
  name: 'Clash Meta / mihomo',
  contentType: 'text/yaml; charset=utf-8',
  extension: 'yaml',
  capabilities: Object.freeze({ rejectInGroups: true, groups: true }),
  compileNode(entry) {
    return compileMihomoProxy(entry.node, entry.name);
  },
  render(plan, compiledNodes) {
    const ruleProviders = Object.fromEntries(plan.ruleSets.map((ruleSet) => [ruleSet.tag, {
      type: 'http',
      behavior: ruleSet.kind === 'geoip' ? 'ipcidr' : 'domain',
      format: 'mrs',
      url: ruleSetUrl(ruleSet, 'mihomo'),
      path: `./rule-providers/${ruleSet.tag}.mrs`,
      interval: 86400
    }]));
    const config = {
      'mixed-port': 7890,
      'allow-lan': false,
      mode: 'rule',
      'log-level': 'info',
      ipv6: false,
      'unified-delay': true,
      'tcp-concurrent': true,
      dns: {
        enable: true,
        ipv6: false,
        'enhanced-mode': 'fake-ip',
        'fake-ip-range': '198.18.0.1/16',
        'fake-ip-filter': ['*.lan', '+.local', '+.msftconnecttest.com', '+.msftncsi.com'],
        'default-nameserver': ['223.5.5.5', '119.29.29.29'],
        nameserver: ['https://dns.alidns.com/dns-query', 'https://doh.pub/dns-query']
      },
      proxies: compiledNodes,
      'proxy-groups': plan.groups.map(compileGroup),
      'rule-providers': ruleProviders,
      rules: [...plan.rules.map(compileRule), `MATCH,${targetName(plan.final)}`]
    };
    return `${emitYaml(config)}\n`;
  }
});
