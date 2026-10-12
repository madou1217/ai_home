'use strict';

const net = require('node:net');
const { compileSurgeFamilyLine } = require('../../proxy-pool/cores/surge/proxy-line');
const { sanitizeSurgeName } = require('../../proxy-pool/protocol-parsers/surge-line');
const { DEFAULT_TEST_URL } = require('../catalog');

const MATCH_KEYWORDS = Object.freeze({
  domain: 'DOMAIN',
  'domain-suffix': 'DOMAIN-SUFFIX',
  'domain-keyword': 'DOMAIN-KEYWORD'
});

const SKIP_PROXY = '127.0.0.1, 192.168.0.0/16, 10.0.0.0/8, 172.16.0.0/12, 100.64.0.0/10, localhost, *.local';

function policyName(ref) {
  if (ref.kind === 'direct') return 'DIRECT';
  if (ref.kind === 'reject') return 'REJECT';
  return sanitizeSurgeName(ref.name);
}

function compileGroup(group) {
  const members = group.members.map(policyName);
  // Surge 系客户端不接受空策略组：没有节点时用 DIRECT 占位，配置仍可加载。
  const list = (members.length ? members : ['DIRECT']).join(', ');
  const name = sanitizeSurgeName(group.name);
  return group.type === 'url-test'
    ? `${name} = url-test, ${list}, url=${group.testUrl}, interval=${group.interval}, tolerance=50`
    : `${name} = select, ${list}`;
}

/** 非规则集的单条规则（DOMAIN / DOMAIN-SUFFIX / DOMAIN-KEYWORD / IP-CIDR）。 */
function compileMatchRule(rule) {
  const target = policyName(rule.target);
  const { type, value } = rule.match;
  if (type === 'ip-cidr') {
    const keyword = net.isIP(value.split('/')[0]) === 6 ? 'IP-CIDR6' : 'IP-CIDR';
    return `${keyword},${value},${target},no-resolve`;
  }
  return `${MATCH_KEYWORDS[type]},${value},${target}`;
}

function compileRule(rule, ruleSetsByTag, context) {
  if (rule.match.type !== 'rule-set') return compileMatchRule(rule);
  const ruleSet = ruleSetsByTag.get(rule.match.value);
  const url = ruleSet ? context.ruleSetUrl(ruleSet) : '';
  if (!url) return null;
  const target = policyName(rule.target);
  // 域名表走 DOMAIN-SET（体积小、匹配快），IP 表走 RULE-SET。
  return ruleSet.kind === 'geoip' ? `RULE-SET,${url},${target},no-resolve` : `DOMAIN-SET,${url},${target}`;
}

function testUrlOf(plan) {
  return plan.groups.find((group) => group.type === 'url-test')?.testUrl || DEFAULT_TEST_URL;
}

/**
 * Surge 系渲染器工厂（Surge、Surfboard 语法同源，差别在支持的协议与 [General] 键）。
 * 代理行由协议插件的 compile.surge 生成；规则集指向 AIH 的转换地址（DOMAIN-SET / RULE-SET 语法）。
 */
function createSurgeFamilyRenderer({ id, name, protocols, general, finalSuffix = '' }) {
  const supported = new Set(protocols);
  return Object.freeze({
    id,
    name,
    contentType: 'text/plain; charset=utf-8',
    extension: 'conf',
    capabilities: Object.freeze({
      rejectInGroups: true,
      groups: true,
      protocols: Object.freeze([...supported]),
      ruleSetFormat: 'domain-set',
      sanitizeName: sanitizeSurgeName
    }),
    compileNode(entry) {
      const protocol = String(entry.node.protocol || '').toLowerCase();
      if (!supported.has(protocol)) {
        const error = new Error(`unsupported_proxy_protocol_${protocol}`);
        error.code = error.message;
        throw error;
      }
      return compileSurgeFamilyLine('surge', entry.node, entry.name);
    },
    render(plan, lines, context) {
      // 节点视图：只有代理行，可作 Surge 的 policy-path（外部策略组）。
      if (context.view === 'nodes') return lines.length ? `${lines.join('\n')}\n` : '';
      const ruleSetsByTag = new Map(plan.ruleSets.map((ruleSet) => [ruleSet.tag, ruleSet]));
      const output = [];
      if (context.subscriptionUrl) {
        output.push(`#!MANAGED-CONFIG ${context.subscriptionUrl} interval=${context.updateIntervalSeconds} strict=false`, '');
      }
      output.push(
        '[General]',
        ...general(testUrlOf(plan)),
        '',
        '[Proxy]',
        ...lines,
        '',
        '[Proxy Group]',
        ...plan.groups.map(compileGroup),
        '',
        '[Rule]',
        ...plan.rules.map((rule) => compileRule(rule, ruleSetsByTag, context)).filter(Boolean),
        `FINAL,${policyName(plan.final)}${finalSuffix}`,
        ''
      );
      return output.join('\n');
    }
  });
}

module.exports = {
  SKIP_PROXY,
  compileGroup,
  compileMatchRule,
  createSurgeFamilyRenderer,
  policyName,
  testUrlOf
};
