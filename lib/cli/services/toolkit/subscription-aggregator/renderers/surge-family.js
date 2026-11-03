'use strict';

const net = require('node:net');
const { compileSurgeFamilyEntry } = require('../../proxy-pool/cores/surge/proxy-line');
const { collectLines } = require('../../proxy-pool/compile-result');
const { formatSurgeLine, sanitizeSurgeName } = require('../../proxy-pool/protocol-parsers/surge-line');
const { compileRelaySurgeProxy, relayEndpointFor } = require('../relay/relay-fallback');
const { DEFAULT_TEST_URL } = require('../catalog');
const { flattenGroupMembers } = require('../aggregation-plan');

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

// 负载均衡：Loon 用 algorithm（PCC 即按目标一致性哈希），Surge 用 persistent=true 让同一目标固定节点。
const LOON_ALGORITHMS = Object.freeze({ 'consistent-hashing': 'PCC', 'round-robin': 'Round-Robin' });

/**
 * 策略组行（Surge / Surfboard / Loon 共用，dialect 区分个别参数）。会测速的组只放节点：
 * 引用的其它组逐层展开（这几个客户端的测速组是否接受嵌套组没有把握）。
 */
function compileGroup(group, groups = [], dialect = 'surge') {
  const tested = group.type !== 'select';
  const members = (tested ? flattenGroupMembers(groups, group) : group.members).map(policyName);
  // Surge 系客户端不接受空策略组：没有节点时用 DIRECT 占位，配置仍可加载。
  const list = (members.length ? members : ['DIRECT']).join(', ');
  const name = sanitizeSurgeName(group.name);
  const probe = `url=${group.testUrl}, interval=${group.interval}`;
  if (group.type === 'url-test') return `${name} = url-test, ${list}, ${probe}, tolerance=${group.tolerance ?? 50}`;
  if (group.type === 'fallback') {
    return `${name} = fallback, ${list}, ${probe}, ${dialect === 'loon' ? 'max-timeout=3000' : 'timeout=5'}`;
  }
  if (group.type === 'load-balance') {
    const strategy = group.strategy || 'consistent-hashing';
    if (dialect === 'loon') return `${name} = load-balance, ${list}, ${probe}, algorithm=${LOON_ALGORITHMS[strategy]}`;
    return `${name} = load-balance, ${list}, ${probe}${strategy === 'consistent-hashing' ? ', persistent=true' : ''}`;
  }
  return `${name} = select, ${list}`;
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
 * 代理行由协议插件的 compile.<target> 生成（Surfboard 缺自己的钩子时回落到 surge）；规则集指向
 * AIH 的转换地址（DOMAIN-SET / RULE-SET 语法）。WireGuard 这类要另起段落的协议，段落由
 * compileSurgeFamilyEntry 挂在编译结果上，渲染时统一展开（见 proxy-pool/compile-result）。
 *
 * relayFallback：格式本身表达不了的协议（Surge 没有 VLESS）在**同机**拉起 sing-box 边车时改写成
 * 本地 socks5 入口（见 relay/），于是这份订阅在 Surge 里也有节点可点。capabilities.coreProtocols
 * 就是「这个格式能直连的协议集」，其余交给边车；边车没在跑时一律照原样跳过（fail-closed）。
 * Surfboard 不开这个回退：它跑在手机上，本机的 127.0.0.1 不是 AIH 所在的机器。
 */
function createSurgeFamilyRenderer({
  id, name, protocols, general, finalSuffix = '', compileTarget = 'surge', proxyChain = '', relayFallback = false
}) {
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
      ...(relayFallback ? { relayFallback: true, coreProtocols: Object.freeze([...supported]) } : {}),
      ruleSetFormat: 'domain-set',
      sanitizeName: sanitizeSurgeName,
      ...(proxyChain ? { proxyChain } : {})
    }),
    compileNode(entry, context = {}) {
      const protocol = String(entry.node.protocol || '').toLowerCase();
      // 本机中转：这个节点这次由边车代拨，配置里只留一个本地 socks5 入口。
      // 这里**不能**再写 underlying-proxy —— 链式关系已经落在边车的配置里（出站 detour），
      // 再写一次会让前置去连「本机的 127.0.0.1:<port>」，远端前置只会连到它自己的回环地址。
      const relayEndpoint = relayFallback ? relayEndpointFor(context, entry.node.id) : null;
      if (relayEndpoint) return { line: formatSurgeLine(entry.name, compileRelaySurgeProxy(relayEndpoint)) };
      if (!supported.has(protocol)) {
        const error = new Error(`unsupported_proxy_protocol_${protocol}`);
        error.code = error.message;
        throw error;
      }
      // 链式代理：Surge 系用 underlying-proxy 指定经由哪个策略 / 节点建立连接。
      return compileSurgeFamilyEntry(compileTarget, entry.node, entry.name,
        context.chain ? { [proxyChain]: context.chain } : null);
    },
    render(plan, compiledNodes, context) {
      const { lines, sections } = collectLines(compiledNodes);
      // 节点视图：代理行 + 段落，可作 Surge 的 policy-path（WireGuard 的段不能少）。
      if (context.view === 'nodes') return lines.length ? `${[...lines, '', ...sections].join('\n')}\n` : '';
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
        ...sections,
        '[Proxy Group]',
        ...plan.groups.map((group) => compileGroup(group, plan.groups)),
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
