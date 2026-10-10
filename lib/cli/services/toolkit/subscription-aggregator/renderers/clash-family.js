'use strict';

const net = require('node:net');
const { compileMihomoProxy, emitYaml } = require('../../proxy-pool/cores/mihomo/proxy-compiler');
const { ruleSetUrl } = require('../catalog');

const MATCH_KEYWORDS = Object.freeze({
  domain: 'DOMAIN',
  'domain-suffix': 'DOMAIN-SUFFIX',
  'domain-keyword': 'DOMAIN-KEYWORD'
});

// HTTP 代理没有 UDP 转发，其余协议都声明 udp: true（Clash 系默认关闭 UDP）。
const NO_UDP_PROTOCOLS = new Set(['http', 'https']);

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

function unsupported(protocol) {
  const error = new Error(`unsupported_proxy_protocol_${protocol}`);
  error.code = error.message;
  return error;
}

/**
 * Clash 系渲染器工厂：mihomo（Clash Meta）、Clash 经典版（Premium 内核）、Stash 共用 Clash YAML，
 * 差别在支持的协议、规则集文件格式（.mrs / .yaml）与内核专属的顶层键。
 * 代理条目由协议插件的 compile.mihomo 生成。
 */
function createClashFamilyRenderer({ id, name, protocols = null, ruleSetFile, ruleSetFormat, extraConfig = {} }) {
  const supported = protocols ? new Set(protocols) : null;
  const providerExtension = ruleSetFile === 'clash-yaml' ? 'yaml' : 'mrs';
  return Object.freeze({
    id,
    name,
    contentType: 'text/yaml; charset=utf-8',
    extension: 'yaml',
    capabilities: Object.freeze({
      rejectInGroups: true,
      groups: true,
      ...(supported ? { protocols: Object.freeze([...supported]) } : {})
    }),
    compileNode(entry) {
      const protocol = String(entry.node.protocol || '').toLowerCase();
      if (supported && !supported.has(protocol)) throw unsupported(protocol);
      const proxy = compileMihomoProxy(entry.node, entry.name);
      if (!NO_UDP_PROTOCOLS.has(protocol)) proxy.udp = true;
      return proxy;
    },
    render(plan, compiledNodes) {
      const ruleProviders = Object.fromEntries(plan.ruleSets.map((ruleSet) => [ruleSet.tag, {
        type: 'http',
        behavior: ruleSet.kind === 'geoip' ? 'ipcidr' : 'domain',
        ...(ruleSetFormat ? { format: ruleSetFormat } : {}),
        url: ruleSetUrl(ruleSet, ruleSetFile),
        path: `./rule-providers/${ruleSet.tag}.${providerExtension}`,
        interval: 86400
      }]));
      const config = {
        'mixed-port': 7890,
        'allow-lan': false,
        mode: 'rule',
        'log-level': 'info',
        ipv6: false,
        ...extraConfig,
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
}

module.exports = {
  createClashFamilyRenderer
};
