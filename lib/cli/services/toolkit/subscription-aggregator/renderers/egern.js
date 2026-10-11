'use strict';

const net = require('node:net');
const { emitYaml } = require('../../proxy-pool/cores/mihomo/proxy-compiler');
const { compileEgernProxy, egernProtocols } = require('../../proxy-pool/cores/egern/proxy-entry');
const { testUrlOf } = require('./surge-family');

const MATCH_TYPES = Object.freeze({
  domain: 'domain',
  'domain-suffix': 'domain_suffix',
  'domain-keyword': 'domain_keyword'
});

function policyName(ref) {
  if (ref.kind === 'direct') return 'DIRECT';
  if (ref.kind === 'reject') return 'REJECT';
  return ref.name;
}

function compileGroup(group) {
  // 空组用 DIRECT 占位，配置仍可加载。
  const policies = group.members.length ? group.members.map(policyName) : ['DIRECT'];
  if (group.type === 'url-test') {
    return {
      auto_test: {
        name: group.name,
        policies,
        interval: group.interval,
        tolerance: 50,
        latency_test_url: group.testUrl
      }
    };
  }
  return { select: { name: group.name, policies } };
}

function compileRule(rule, ruleSetsByTag, context) {
  const policy = policyName(rule.target);
  const { type, value } = rule.match;
  if (type === 'rule-set') {
    const ruleSet = ruleSetsByTag.get(value);
    const url = ruleSet ? context.ruleSetUrl(ruleSet) : '';
    return url ? { rule_set: { match: url, policy, update_interval: 86400 } } : null;
  }
  if (type === 'ip-cidr') {
    const key = net.isIP(value.split('/')[0]) === 6 ? 'ip_cidr6' : 'ip_cidr';
    return { [key]: { match: value, policy, no_resolve: true } };
  }
  return { [MATCH_TYPES[type]]: { match: value, policy } };
}

/**
 * Egern（iOS）配置（实验性，字段按官方文档 egernapp.com/docs/configuration 编写，需真机导入验证）：
 * 代理条目由协议插件的 compile.egern 生成；规则集指向 AIH 的转换地址（Egern 自己的 YAML 规则集）；
 * auto_update 让 Egern 按订阅地址定时更新整份配置。
 */
module.exports = Object.freeze({
  id: 'egern',
  name: 'Egern（实验）',
  contentType: 'text/yaml; charset=utf-8',
  extension: 'yaml',
  capabilities: Object.freeze({
    rejectInGroups: true,
    groups: true,
    protocols: Object.freeze(egernProtocols()),
    ruleSetFormat: 'egern'
  }),
  compileNode(entry) {
    return compileEgernProxy(entry.node, entry.name);
  },
  render(plan, proxies, context) {
    const ruleSetsByTag = new Map(plan.ruleSets.map((ruleSet) => [ruleSet.tag, ruleSet]));
    const config = {
      ...(context.subscriptionUrl
        ? { auto_update: { url: context.subscriptionUrl, interval: context.updateIntervalSeconds } }
        : {}),
      proxy_latency_test_url: testUrlOf(plan),
      proxies,
      policy_groups: plan.groups.map(compileGroup),
      rules: [
        ...plan.rules.map((rule) => compileRule(rule, ruleSetsByTag, context)).filter(Boolean),
        { default: { policy: policyName(plan.final) } }
      ]
    };
    return `${emitYaml(config)}\n`;
  }
});
