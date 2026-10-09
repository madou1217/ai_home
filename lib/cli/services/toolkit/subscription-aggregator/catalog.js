'use strict';

/**
 * 订阅聚合器的静态目录：地区策略组、分流规则预设与规则集地址。
 * 渲染器只认这里的中立描述（geosite/geoip 规则集名），各自翻译成 mihomo / sing-box 语法。
 */

// 策略目标：内置组 + 直连/拒绝；地区、订阅源、预设组用 `<kind>:<id>` 引用。
const POLICY_PROXY = 'proxy';
const POLICY_AUTO = 'auto';
const POLICY_DIRECT = 'direct';
const POLICY_REJECT = 'reject';
const BUILTIN_POLICIES = Object.freeze([POLICY_PROXY, POLICY_AUTO, POLICY_DIRECT, POLICY_REJECT]);

const GROUP_NAMES = Object.freeze({
  [POLICY_PROXY]: '🚀 节点选择',
  [POLICY_AUTO]: '♻️ 自动选择',
  final: '🐟 漏网之鱼'
});

// 地区识别优先看名称里的国旗 emoji，其次按名称关键字（英文缩写两侧不能紧贴字母，避免 RUS/AUS 误判）。
const REGIONS = Object.freeze([
  { id: 'hk', code: 'HK', name: '香港', flag: '🇭🇰', pattern: /香港|港|(?<![A-Za-z])HK(?![A-Za-z])|Hong\s*Kong/i },
  { id: 'tw', code: 'TW', name: '台湾', flag: '🇹🇼', pattern: /台湾|台灣|台北|(?<![A-Za-z])TW(?![A-Za-z])|Taiwan/i },
  { id: 'jp', code: 'JP', name: '日本', flag: '🇯🇵', pattern: /日本|东京|大阪|(?<![A-Za-z])JP(?![A-Za-z])|Japan|Tokyo|Osaka/i },
  { id: 'sg', code: 'SG', name: '新加坡', flag: '🇸🇬', pattern: /新加坡|狮城|(?<![A-Za-z])SG(?![A-Za-z])|Singapore/i },
  { id: 'us', code: 'US', name: '美国', flag: '🇺🇸', pattern: /美国|美國|洛杉矶|硅谷|纽约|西雅图|(?<![A-Za-z])USA?(?![A-Za-z])|United\s*States|America/i },
  { id: 'kr', code: 'KR', name: '韩国', flag: '🇰🇷', pattern: /韩国|韓國|首尔|(?<![A-Za-z])KR(?![A-Za-z])|Korea|Seoul/i },
  { id: 'gb', code: 'GB', name: '英国', flag: '🇬🇧', pattern: /英国|伦敦|(?<![A-Za-z])(?:UK|GB)(?![A-Za-z])|United\s*Kingdom|London/i },
  { id: 'de', code: 'DE', name: '德国', flag: '🇩🇪', pattern: /德国|法兰克福|(?<![A-Za-z])DE(?![A-Za-z])|Germany|Frankfurt/i }
]);

const REGION_BY_ID = new Map(REGIONS.map((region) => [region.id, region]));
const REGION_BY_CODE = new Map(REGIONS.map((region) => [region.code, region]));

/**
 * 分流规则预设：每个预设在客户端里是一个可切换的策略组，defaultPolicy 是组内默认选项。
 * ruleSets 只写规则集名（MetaCubeX/meta-rules-dat 的 geosite / geoip），noResolve 用于 IP 类规则。
 */
const RULE_PRESETS = Object.freeze([
  {
    id: 'ads',
    name: '🛑 广告拦截',
    description: '常见广告与追踪域名',
    defaultPolicy: POLICY_REJECT,
    enabledByDefault: false,
    ruleSets: [{ kind: 'geosite', name: 'category-ads-all' }]
  },
  {
    id: 'ai',
    name: '🤖 AI 服务',
    description: 'OpenAI、Anthropic、Gemini 等海外 AI 服务',
    defaultPolicy: POLICY_PROXY,
    enabledByDefault: true,
    ruleSets: [{ kind: 'geosite', name: 'category-ai-!cn' }]
  },
  {
    id: 'github',
    name: '🐙 GitHub',
    description: 'GitHub 及其静态资源',
    defaultPolicy: POLICY_PROXY,
    enabledByDefault: true,
    ruleSets: [{ kind: 'geosite', name: 'github' }]
  },
  {
    id: 'google',
    name: '🔍 Google',
    description: 'Google 搜索与服务',
    defaultPolicy: POLICY_PROXY,
    enabledByDefault: true,
    ruleSets: [{ kind: 'geosite', name: 'google' }, { kind: 'geoip', name: 'google', noResolve: true }]
  },
  {
    id: 'telegram',
    name: '✈️ Telegram',
    description: 'Telegram 域名与 IP 段',
    defaultPolicy: POLICY_PROXY,
    enabledByDefault: true,
    ruleSets: [{ kind: 'geosite', name: 'telegram' }, { kind: 'geoip', name: 'telegram', noResolve: true }]
  },
  {
    id: 'youtube',
    name: '📹 YouTube',
    description: 'YouTube 视频',
    defaultPolicy: POLICY_PROXY,
    enabledByDefault: true,
    ruleSets: [{ kind: 'geosite', name: 'youtube' }]
  },
  {
    id: 'netflix',
    name: '🎬 Netflix',
    description: 'Netflix 域名与 IP 段',
    defaultPolicy: POLICY_PROXY,
    enabledByDefault: false,
    ruleSets: [{ kind: 'geosite', name: 'netflix' }, { kind: 'geoip', name: 'netflix', noResolve: true }]
  },
  {
    id: 'microsoft',
    name: 'Ⓜ️ 微软服务',
    description: 'Microsoft / Office / OneDrive',
    defaultPolicy: POLICY_DIRECT,
    enabledByDefault: true,
    ruleSets: [{ kind: 'geosite', name: 'microsoft' }]
  },
  {
    id: 'apple',
    name: '🍎 苹果服务',
    description: 'Apple 服务与 CDN',
    defaultPolicy: POLICY_DIRECT,
    enabledByDefault: true,
    ruleSets: [{ kind: 'geosite', name: 'apple' }]
  },
  {
    id: 'global',
    name: '🌍 国外网站',
    description: '非中国大陆域名（geolocation-!cn）',
    defaultPolicy: POLICY_PROXY,
    enabledByDefault: true,
    ruleSets: [{ kind: 'geosite', name: 'geolocation-!cn' }]
  },
  {
    id: 'cn',
    name: '🎯 国内直连',
    description: '中国大陆域名与 IP',
    defaultPolicy: POLICY_DIRECT,
    enabledByDefault: true,
    ruleSets: [{ kind: 'geosite', name: 'cn' }, { kind: 'geoip', name: 'cn', noResolve: true }]
  }
]);

const RULE_PRESET_BY_ID = new Map(RULE_PRESETS.map((preset) => [preset.id, preset]));

// 局域网/保留地址永远直连且排在最前，不作为可切换预设。
const PRIVATE_RULE_SETS = Object.freeze([
  { kind: 'geosite', name: 'private' },
  { kind: 'geoip', name: 'private', noResolve: true }
]);

const RULE_SET_CDN = 'https://cdn.jsdelivr.net/gh/MetaCubeX/meta-rules-dat';

// 规则集名里的 ! 不进标签（规则行与缓存路径里更稳），geolocation-!cn → geosite-geolocation-not-cn。
function ruleSetTag(ruleSet) {
  return `${ruleSet.kind}-${String(ruleSet.name).replace(/!/g, 'not-')}`;
}

/** 规则集下载地址：mihomo 用 meta 分支的 .mrs，sing-box 用 sing 分支的 .srs。 */
function ruleSetUrl(ruleSet, target) {
  const branch = target === 'sing-box' ? 'sing' : 'meta';
  const extension = target === 'sing-box' ? 'srs' : 'mrs';
  return `${RULE_SET_CDN}@${branch}/geo/${ruleSet.kind}/${ruleSet.name}.${extension}`;
}

// 机场常把流量、到期时间、官网写成假节点，新建聚合时默认排除。
const DEFAULT_EXCLUDE_PATTERN = '剩余|到期|重置|流量|官网|过期|套餐|Expire|Traffic';

const DEFAULT_TEST_URL = 'https://www.gstatic.com/generate_204';

module.exports = {
  BUILTIN_POLICIES,
  DEFAULT_EXCLUDE_PATTERN,
  DEFAULT_TEST_URL,
  GROUP_NAMES,
  POLICY_AUTO,
  POLICY_DIRECT,
  POLICY_PROXY,
  POLICY_REJECT,
  PRIVATE_RULE_SETS,
  REGIONS,
  REGION_BY_CODE,
  REGION_BY_ID,
  RULE_PRESETS,
  RULE_PRESET_BY_ID,
  ruleSetTag,
  ruleSetUrl
};
