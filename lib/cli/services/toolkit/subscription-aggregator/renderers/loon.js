'use strict';

const { compileSurgeFamilyLine } = require('../../proxy-pool/cores/surge/proxy-line');
const { sanitizeSurgeName } = require('../../proxy-pool/protocol-parsers/surge-line');
const { compileGroup, compileMatchRule, policyName, testUrlOf } = require('./surge-family');

const PROTOCOLS = Object.freeze(['shadowsocks', 'shadowsocksr', 'vmess', 'vless', 'trojan', 'hysteria2', 'socks5', 'http', 'https']);
const BYPASS_TUN = '10.0.0.0/8,100.64.0.0/10,127.0.0.0/8,169.254.0.0/16,172.16.0.0/12,192.168.0.0/16,224.0.0.0/4,255.255.255.255/32';

function unsupported(protocol) {
  const error = new Error(`unsupported_proxy_protocol_${protocol}`);
  error.code = error.message;
  return error;
}

/**
 * Loon 配置：代理行由协议插件的 compile.loon 生成（凭据作为带引号的位置参数），
 * 规则集写进 [Remote Rule] 并指向 AIH 的转换地址（Loon RULE-SET 语法），其余规则在 [Rule]。
 */
module.exports = Object.freeze({
  id: 'loon',
  name: 'Loon',
  contentType: 'text/plain; charset=utf-8',
  extension: 'conf',
  capabilities: Object.freeze({
    rejectInGroups: true,
    groups: true,
    protocols: PROTOCOLS,
    ruleSetFormat: 'rule-set',
    sanitizeName: sanitizeSurgeName
  }),
  compileNode(entry) {
    const protocol = String(entry.node.protocol || '').toLowerCase();
    if (!PROTOCOLS.includes(protocol)) throw unsupported(protocol);
    return compileSurgeFamilyLine('loon', entry.node, entry.name);
  },
  render(plan, lines, context) {
    // 节点视图：只有代理行，可作 Loon 的节点订阅（nodelist）。
    if (context.view === 'nodes') return lines.length ? `${lines.join('\n')}\n` : '';
    const ruleSetsByTag = new Map(plan.ruleSets.map((ruleSet) => [ruleSet.tag, ruleSet]));
    const remoteRules = [];
    const localRules = [];
    for (const rule of plan.rules) {
      if (rule.match.type !== 'rule-set') {
        localRules.push(compileMatchRule(rule));
        continue;
      }
      const ruleSet = ruleSetsByTag.get(rule.match.value);
      const url = ruleSet ? context.ruleSetUrl(ruleSet) : '';
      if (url) remoteRules.push(`${url}, policy=${policyName(rule.target)}, tag=${ruleSet.tag}, enabled=true`);
    }
    return [
      '[General]',
      'ip-mode = dual',
      'dns-server = system,223.5.5.5,119.29.29.29',
      'skip-proxy = 192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,localhost,*.local',
      `bypass-tun = ${BYPASS_TUN}`,
      `proxy-test-url = ${testUrlOf(plan)}`,
      'internet-test-url = http://www.gstatic.com/generate_204',
      'test-timeout = 5',
      '',
      '[Proxy]',
      ...lines,
      '',
      '[Proxy Group]',
      ...plan.groups.map(compileGroup),
      '',
      '[Remote Rule]',
      ...remoteRules,
      '',
      '[Rule]',
      ...localRules,
      `FINAL,${policyName(plan.final)}`,
      ''
    ].join('\n');
  }
});
