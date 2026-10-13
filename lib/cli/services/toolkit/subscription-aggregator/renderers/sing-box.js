'use strict';

const { compileSingBoxNodeOutbound, singBoxSectionOf } = require('../../proxy-pool/cores/sing-box/node-outbound');
const { extrasOf } = require('../../proxy-pool/compile-result');
const { ruleSetUrl } = require('../catalog');

const DIRECT_TAG = 'direct';
const MATCH_FIELDS = Object.freeze({
  domain: 'domain',
  'domain-suffix': 'domain_suffix',
  'domain-keyword': 'domain_keyword',
  'ip-cidr': 'ip_cidr'
});

/**
 * 展开编译结果上的附加出站（ShadowTLS 的 shadowtls 出站等），并保证 tag 唯一——sing-box 遇到重复
 * tag 会拒掉整份配置。辅助出站与主出站重名时改名，引用它的 detour 同步改写；辅助出站之间同名
 * （两个 ss 节点共用同一个 ShadowTLS 前置）则共用一条，这正是「去重」要的效果。
 */
function withAuxiliaryOutbounds(compiledNodes) {
  const used = new Set(compiledNodes.map((item) => String(item.tag ?? '')));
  const assigned = new Map();
  const auxiliaries = [];
  const detours = new Map();
  for (const item of compiledNodes) {
    for (const extra of extrasOf(item)) {
      const original = String(extra.tag ?? '');
      let tag = assigned.get(original);
      if (tag === undefined) {
        tag = original;
        for (let attempt = 1; used.has(tag); attempt += 1) tag = `${original}-${attempt}`;
        used.add(tag);
        assigned.set(original, tag);
        auxiliaries.push(tag === original ? extra : { ...extra, tag });
      }
      if (original && String(item.detour ?? '') === original) detours.set(item, tag);
    }
  }
  const outbounds = detours.size === 0
    ? compiledNodes
    : compiledNodes.map((item) => (detours.has(item) ? { ...item, detour: detours.get(item) } : item));
  return { auxiliaries, outbounds };
}

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
      tolerance: group.tolerance ?? 50
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
 * 节点按客户端的内核版本编译（低于协议最低版本的节点跳过，否则整份配置会被拒）；
 * 节点视图只输出出站与 WireGuard 端点（Hiddify / Karing / Husi 只取节点，自己建路由）。
 */
module.exports = Object.freeze({
  id: 'sing-box',
  name: 'sing-box',
  contentType: 'application/json; charset=utf-8',
  extension: 'json',
  // 只有 selector / urltest：故障转移与负载均衡在规划阶段降级成延迟最低。
  capabilities: Object.freeze({ rejectInGroups: false, groups: true, groupTypes: Object.freeze(['select', 'url-test']) }),
  compileNode(entry, context = {}) {
    const client = context.client || {};
    return compileSingBoxNodeOutbound(entry.node, entry.name, {
      version: client.singBoxVersion,
      officialApp: client.officialApp === true
    });
  },
  render(plan, compiledNodes, context = {}) {
    const proxyGroupTag = plan.groups[0]?.name;
    const { auxiliaries, outbounds: resolved } = withAuxiliaryOutbounds(compiledNodes);
    const endpoints = resolved.filter((item) => singBoxSectionOf(item) === 'endpoints');
    if (context.view === 'nodes') {
      const outbounds = resolved.filter((item) => !endpoints.includes(item));
      return `${JSON.stringify({ outbounds: [...outbounds, ...auxiliaries], ...(endpoints.length ? { endpoints } : {}) }, null, 2)}\n`;
    }
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
        ...resolved.filter((item) => !endpoints.includes(item)),
        ...auxiliaries,
        { type: 'direct', tag: DIRECT_TAG }
      ],
      ...(endpoints.length ? { endpoints } : {}),
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
