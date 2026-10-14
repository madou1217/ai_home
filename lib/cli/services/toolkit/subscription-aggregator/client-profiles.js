'use strict';

// 客户端识别表：按拉取订阅时的 User-Agent 认出具体客户端，决定输出格式与渲染选项。
// UA 依据各客户端源码 / 官方文档（2026-10-12 调研）。表的顺序即优先级：具体应用名在前、
// 通用关键字在后 —— FlClash 的 UA 带 clash-verge，Hiddify 的带 ClashMeta / v2ray / sing-box，
// Karing 允许用户同时勾选多个片段，所以都要先于 Clash / sing-box 的通用匹配。
//
// options：
//   view: 'nodes'       只输出节点（这些客户端只取节点、自己建路由）
//   singBoxVersion      客户端的 sing-box 内核版本（决定能输出哪些协议）
//   officialApp         sing-box 官方 App（带 Cronet 构建，能用 Naive）
//   classicProtocols    这个客户端的内核只认这些协议（Clash Premium 内核），见 clash-premium

// Clash Premium 内核（ClashX、Clash for Windows、Clash for Android 原版）只认这几个协议：
// VLESS / Hysteria / Hysteria2 / TUIC / WireGuard / AnyTLS / SSH 都是 Clash.Meta（mihomo）系才有的。
// clash-classic 目标现在**输出全部协议**（「经典 / Premium」这个格式本身不再按协议挑节点），
// 所以认到这些老客户端时带上这份清单：输出里出现清单外的协议，预览会提醒配置可能加载失败。
const CLASSIC_CLASH_PROTOCOLS = Object.freeze([
  'shadowsocks', 'shadowsocksr', 'vmess', 'trojan', 'snell', 'socks5', 'http', 'https'
]);

function singBoxVersionFrom(ua) {
  const match = /sing-box[ /]v?(\d+\.\d+(?:\.\d+)?)/i.exec(ua);
  return match ? match[1] : undefined;
}

function hiddifyMajor(ua) {
  const match = /^HiddifyNext\/v?(\d+)/i.exec(ua);
  return match ? Number(match[1]) : 0;
}

const CLIENT_PROFILES = Object.freeze([
  { id: 'stash', name: 'Stash', pattern: /^Stash\//i, target: 'stash' },
  // Hiddify 的 Xray 模式用 Xray 内核读分享链接（xhttp / encryption 都在链接里）。
  { id: 'hiddify-xray', name: 'Hiddify（Xray 内核）', pattern: /^HiddifyNextX\//i, target: 'base64' },
  {
    id: 'hiddify',
    name: 'Hiddify',
    pattern: /^HiddifyNext\//i,
    // 4.x 内置 sing-box 1.13 分支，只取出站与端点；更老的内核未知，给逐条解析的分享链接最稳。
    target: 'sing-box',
    options: () => ({ view: 'nodes', singBoxVersion: '1.13.0' }),
    resolve: (ua) => (ua && hiddifyMajor(ua) < 4 ? { target: 'base64', options: {} } : null)
  },
  {
    id: 'karing',
    name: 'Karing',
    pattern: /^Karing\//i,
    target: 'sing-box',
    options: (ua) => ({ view: 'nodes', singBoxVersion: singBoxVersionFrom(ua) })
  },
  { id: 'nekobox', name: 'NekoBox', pattern: /\bNeko(?:Box|Ray)\//i, target: 'mihomo' },
  {
    id: 'husi',
    name: 'Husi',
    pattern: /^husi\//i,
    target: 'sing-box',
    options: (ua) => ({ view: 'nodes', singBoxVersion: singBoxVersionFrom(ua) })
  },
  {
    id: 'sing-box',
    name: 'sing-box（SFA / SFI / SFM / SFT）',
    pattern: /^SF[AIMT](?:[/ (]|$)/i,
    target: 'sing-box',
    options: (ua) => ({ singBoxVersion: singBoxVersionFrom(ua), officialApp: true })
  },
  { id: 'flclash', name: 'FlClash', pattern: /\bFlClash\//i, target: 'mihomo' },
  { id: 'clash-verge', name: 'Clash Verge Rev', pattern: /^clash-verge\//i, target: 'mihomo' },
  { id: 'clash-meta-android', name: 'Clash Meta for Android', pattern: /\bClashMetaForAndroid\//i, target: 'mihomo' },
  { id: 'clash-party', name: 'Clash Party（Mihomo Party）', pattern: /\bmihomo\.party\//i, target: 'mihomo' },
  { id: 'clash-nyanpasu', name: 'Clash Nyanpasu', pattern: /\bclash-nyanpasu\//i, target: 'mihomo' },
  { id: 'clashx-meta', name: 'ClashX Meta', pattern: /^ClashX\b.*(?:meta|metacubex)/i, target: 'mihomo' },
  // Premium 内核的老客户端：UA 上看不出用户有没有换成 Meta 内核，所以照旧给 clash-classic，
  // 但把内核能认的协议带上，让预览能提醒「这份配置它可能加载不了」。
  {
    id: 'clash-premium',
    name: 'ClashX / Clash for Windows / Clash for Android',
    pattern: /^(?:ClashX|ClashforWindows|Clash for Windows|ClashForAndroid)\b/i,
    target: 'clash-classic',
    options: () => ({ classicProtocols: CLASSIC_CLASH_PROTOCOLS })
  },
  { id: 'surfboard', name: 'Surfboard', pattern: /\bsurfboard\b/i, target: 'surfboard' },
  { id: 'surge', name: 'Surge', pattern: /\bsurge\b/i, target: 'surge' },
  { id: 'loon', name: 'Loon', pattern: /\bloon\b/i, target: 'loon' },
  { id: 'quantumult-x', name: 'Quantumult X', pattern: /\bquantumult\b/i, target: 'quantumult-x' },
  { id: 'egern', name: 'Egern', pattern: /\begern\b/i, target: 'egern' },
  { id: 'shadowrocket', name: 'Shadowrocket', pattern: /^Shadowrocket\//i, target: 'base64' },
  { id: 'v2rayng', name: 'v2rayNG', pattern: /^v2rayNG\//i, target: 'base64' },
  { id: 'v2rayn', name: 'v2rayN', pattern: /^v2rayN\//i, target: 'base64' },
  { id: 'v2raya', name: 'v2rayA', pattern: /^v2rayA\//i, target: 'base64' },
  { id: 'streisand', name: 'Streisand', pattern: /^Streisand\//i, target: 'base64' },
  { id: 'v2box', name: 'V2Box', pattern: /^V2Box\b/i, target: 'base64' },
  { id: 'foxray', name: 'FoXray', pattern: /^FoXray\b/i, target: 'base64' },
  { id: 'happ', name: 'Happ', pattern: /^Happ\//i, target: 'base64' },
  { id: 'passwall', name: 'PassWall / SSR Plus', pattern: /\b(?:passwall|ssrplus|ssr-plus)\b/i, target: 'base64' },
  // 通用匹配：其它 sing-box / v2ray 系 / Clash 系客户端，以及 mihomo 内核拉 proxy-providers（clash.meta/…）。
  {
    id: 'sing-box-generic',
    name: 'sing-box 系（其它）',
    pattern: /\bsing-box\b/i,
    target: 'sing-box',
    options: (ua) => ({ singBoxVersion: singBoxVersionFrom(ua) }),
    generic: true
  },
  { id: 'v2ray-generic', name: 'v2ray / Xray 系（其它）', pattern: /\b(?:v2ray|xray)/i, target: 'base64', generic: true },
  { id: 'clash-generic', name: 'Clash 系（其它）', pattern: /clash\.meta|\bmihomo\b|\bclash\b/i, target: 'mihomo', generic: true }
]);

const PROFILE_BY_ID = new Map(CLIENT_PROFILES.map((profile) => [profile.id, profile]));

// 认不出时给 mihomo：已发出的订阅链接、自定义 UA 的 Clash 系客户端与脚本都按原样工作。
const UNKNOWN_CLIENT = Object.freeze({ id: 'unknown', name: '未识别的客户端', target: 'mihomo' });

function clientResult(profile, ua) {
  const options = { ...(typeof profile.options === 'function' ? profile.options(ua) : {}) };
  const base = { id: profile.id, name: profile.name, target: profile.target, options };
  const override = typeof profile.resolve === 'function' ? profile.resolve(ua) : null;
  const result = override ? { ...base, ...override } : base;
  result.options = Object.fromEntries(Object.entries(result.options).filter(([, value]) => value !== undefined));
  return result;
}

/** User-Agent → { id, name, target, options }；先把 %20 还原（Quantumult%20X、ClashX%20Meta）。 */
function detectClient(userAgent) {
  const ua = String(userAgent || '').replace(/%20/g, ' ').trim();
  const profile = ua ? CLIENT_PROFILES.find((candidate) => candidate.pattern.test(ua)) : null;
  return profile ? clientResult(profile, ua) : clientResult(UNKNOWN_CLIENT, ua);
}

/** 按 id 取客户端的默认表现（预览时模拟某个客户端用，没有 UA 可解析）。 */
function clientById(id) {
  const profile = PROFILE_BY_ID.get(String(id || ''));
  return profile ? clientResult(profile, '') : null;
}

/** 给前端的已适配客户端列表（不含通用匹配）。 */
function describeClients() {
  return CLIENT_PROFILES
    .filter((profile) => !profile.generic)
    .map((profile) => ({ id: profile.id, name: profile.name, format: profile.target }));
}

module.exports = {
  CLASSIC_CLASH_PROTOCOLS,
  CLIENT_PROFILES,
  UNKNOWN_CLIENT,
  clientById,
  describeClients,
  detectClient
};
