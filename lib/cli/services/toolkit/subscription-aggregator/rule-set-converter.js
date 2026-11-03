'use strict';

// Surge / Surfboard / Loon / Quantumult X / Egern 读不了 mihomo 的 .mrs 规则集。AIH 取 MetaCubeX
// meta-rules-dat 的 .list 文本（geosite：`+.域名` 是后缀、其余是精确域名；geoip：CIDR），
// 转换成目标客户端的规则集语法。原文按规则集缓存 12 小时，并发请求合并成一次拉取。

const { emitYaml } = require('../proxy-pool/cores/mihomo/proxy-compiler');

const RULE_LIST_CDN = 'https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@meta/geo';
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 64;
const MAX_LIST_BYTES = 16 * 1024 * 1024;

const CIDR_PATTERN = /^[0-9A-Fa-f:.]+\/\d{1,3}$/;
const DOMAIN_PATTERN = /^[A-Za-z0-9_.-]+$/;

function ruleListUrl(ruleSet) {
  return `${RULE_LIST_CDN}/${ruleSet.kind}/${encodeURIComponent(ruleSet.name)}.list`;
}

/** .list 文本 → [{ type: 'suffix' | 'domain' | 'ip4' | 'ip6', value }]；认不出的行跳过。 */
function parseRuleList(text, kind) {
  const entries = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (kind === 'geoip') {
      if (CIDR_PATTERN.test(line)) entries.push({ type: line.includes(':') ? 'ip6' : 'ip4', value: line });
      continue;
    }
    if (line.startsWith('+.') && DOMAIN_PATTERN.test(line.slice(2))) entries.push({ type: 'suffix', value: line.slice(2) });
    else if (DOMAIN_PATTERN.test(line)) entries.push({ type: 'domain', value: line });
  }
  return entries;
}

const SURGE_IP = (entry) => `${entry.type === 'ip6' ? 'IP-CIDR6' : 'IP-CIDR'},${entry.value},no-resolve`;

/** 逐行格式：domain / ip 各自把一条规则写成一行。 */
function lineFormat({ domain, ip }) {
  return Object.freeze({
    render(entries, kind) {
      const lines = entries.map((entry) => (kind === 'geoip' ? ip(entry) : domain(entry)));
      return lines.length ? `${lines.join('\n')}\n` : '';
    }
  });
}

// Egern：YAML 规则集，按类型分成 *_set 列表（组内为「或」）；IP 表整体不触发 DNS 解析。
const EGERN_SET_KEYS = Object.freeze({ domain: 'domain_set', suffix: 'domain_suffix_set', ip4: 'ip_cidr_set', ip6: 'ip_cidr6_set' });

function egernRuleSet(entries, kind) {
  const document = kind === 'geoip' ? { no_resolve: true } : {};
  for (const entry of entries) {
    const key = EGERN_SET_KEYS[entry.type];
    (document[key] ||= []).push(entry.value);
  }
  return `${emitYaml(document)}\n`;
}

// 规则集语法（策略模式）：每种格式把条目渲染成整份规则集文本。
const RULE_SET_FORMATS = Object.freeze({
  // Surge / Surfboard：域名表作 DOMAIN-SET（前导点表示后缀），IP 表作 RULE-SET。
  'domain-set': lineFormat({
    domain: (entry) => (entry.type === 'suffix' ? `.${entry.value}` : entry.value),
    ip: SURGE_IP
  }),
  // Loon：远程规则只认 RULE-SET 行。
  'rule-set': lineFormat({
    domain: (entry) => `${entry.type === 'suffix' ? 'DOMAIN-SUFFIX' : 'DOMAIN'},${entry.value}`,
    ip: SURGE_IP
  }),
  // Quantumult X：行内必须带策略，由 filter_remote 的 force-policy 统一覆盖。
  'quantumult-x': lineFormat({
    domain: (entry) => `${entry.type === 'suffix' ? 'host-suffix' : 'host'}, ${entry.value}, proxy`,
    ip: (entry) => `${entry.type === 'ip6' ? 'ip6-cidr' : 'ip-cidr'}, ${entry.value}, proxy, no-resolve`
  }),
  egern: Object.freeze({ render: egernRuleSet })
});

function formatRuleSet(entries, kind, format) {
  const formatter = RULE_SET_FORMATS[format];
  if (!formatter) throw Object.assign(new Error('unsupported_rule_set_format'), { code: 'unsupported_rule_set_format' });
  return formatter.render(entries, kind);
}

class RuleSetConverter {
  constructor(options = {}) {
    this.fetcher = options.fetcher || null;
    this.now = options.now || Date.now;
    this.cache = new Map();
    this.inFlight = new Map();
  }

  getFetcher() {
    if (!this.fetcher) {
      const { SubscriptionFetcher } = require('../proxy-pool/subscription-fetcher');
      this.fetcher = new SubscriptionFetcher({ maxResponseBytes: MAX_LIST_BYTES });
    }
    return this.fetcher;
  }

  async loadEntries(ruleSet) {
    const key = `${ruleSet.kind}:${ruleSet.name}`;
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.entries;
    if (!this.inFlight.has(key)) {
      const pending = this.getFetcher().fetch(ruleListUrl(ruleSet))
        .then((result) => {
          const entries = parseRuleList(result.content, ruleSet.kind);
          this.cache.delete(key);
          this.cache.set(key, { fetchedAt: this.now(), entries });
          while (this.cache.size > MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value);
          return entries;
        })
        .finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, pending);
    }
    return this.inFlight.get(key);
  }

  async render(ruleSet, format) {
    return formatRuleSet(await this.loadEntries(ruleSet), ruleSet.kind, format);
  }
}

module.exports = {
  CACHE_TTL_MS,
  RULE_SET_FORMATS,
  RuleSetConverter,
  formatRuleSet,
  parseRuleList,
  ruleListUrl
};
