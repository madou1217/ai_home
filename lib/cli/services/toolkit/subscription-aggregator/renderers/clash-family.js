'use strict';

const net = require('node:net');
const { compileMihomoProxy, emitYaml } = require('../../proxy-pool/cores/mihomo/proxy-compiler');
const { supportsUdpRelay } = require('../../proxy-pool/protocols');
const { ruleSetUrl } = require('../catalog');
const { compileRelayProxyEntry, relayEndpointFor } = require('../relay/relay-fallback');

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

// 会定时测速的策略：延迟最低 / 故障转移 / 负载均衡。
const TESTED_GROUP_TYPES = new Set(['url-test', 'fallback', 'load-balance']);

function compileGroup(group) {
  const compiled = { name: group.name, type: group.type, proxies: group.members.map(targetName) };
  if (TESTED_GROUP_TYPES.has(group.type)) {
    compiled.url = group.testUrl;
    compiled.interval = group.interval;
  }
  if (group.type === 'url-test') compiled.tolerance = group.tolerance ?? 50;
  if (group.type === 'load-balance') compiled.strategy = group.strategy || 'consistent-hashing';
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
 * 差别在支持的协议、规则集文件格式（.mrs / .yaml）、内核专属的顶层键与个别代理键名（adaptProxy）。
 * 代理条目由协议插件的 compile.mihomo 生成。
 * proxyChain 声明本目标写链式前置的字段名（mihomo 系是 dialer-proxy），空表示不支持。
 * relayFallback 打开「本机中转」回退：内核认不出的协议改写成 socks5 本地入口（只有经典版需要）。
 */
function createClashFamilyRenderer({
  id, name, note = '', protocols = null, ruleSetFile, ruleSetFormat, extraConfig = {},
  adaptProxy = (proxy) => proxy, proxyChain = '', relayFallback = false
}) {
  const supported = protocols ? new Set(protocols) : null;
  const providerExtension = ruleSetFile === 'clash-yaml' ? 'yaml' : 'mrs';
  return Object.freeze({
    id,
    name,
    note,
    contentType: 'text/yaml; charset=utf-8',
    extension: 'yaml',
    capabilities: Object.freeze({
      rejectInGroups: true,
      groups: true,
      ...(supported ? { protocols: Object.freeze([...supported]) } : {}),
      ...(proxyChain ? { proxyChain } : {}),
      ...(relayFallback ? { relayFallback: true } : {})
    }),
    compileNode(entry, context = {}) {
      const protocol = String(entry.node.protocol || '').toLowerCase();
      if (supported && !supported.has(protocol)) throw unsupported(protocol);
      // 本机中转：这个节点这次由边车代拨，配置里只留一个本地 socks5 入口。
      // 这里**不能**再写 dialer-proxy —— 链式关系已经落在边车的配置里（出站 detour），
      // 再写一次会让前置去连「本机的 127.0.0.1:<port>」，远端前置只会连到它自己的回环地址。
      const relayEndpoint = relayFallback ? relayEndpointFor(context, entry.node.id) : null;
      if (relayEndpoint) return compileRelayProxyEntry(entry, relayEndpoint);
      const proxy = compileMihomoProxy(entry.node, entry.name, { target: id });
      // Clash 系默认关闭 UDP：能转发 UDP 的协议都显式打开（HTTP、Snell v1/v2 不能）。
      if (supportsUdpRelay(entry.node)) proxy.udp = true;
      const compiled = adaptProxy(proxy, entry.node);
      // 链式代理：当前节点经由该代理（或策略组）建立连接，多级链靠前置节点自己也带 dialer-proxy。
      if (context.chain) compiled['dialer-proxy'] = context.chain;
      return compiled;
    },
    render(plan, compiledNodes, context = {}) {
      // 节点视图：只有 proxies，可直接作 proxy-providers。
      if (context.view === 'nodes') return `${emitYaml({ proxies: compiledNodes })}\n`;
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
