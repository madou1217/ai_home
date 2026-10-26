'use strict';

// zcode 账号的**区域标识**（zai / bigmodel）— 界面区分同邮箱账号的唯一依据。
//
// 为什么需要：同一个用户可能在两个区域各有账号，邮箱相同或近似（真机：zai 侧
// `madou1217@126.com`、bigmodel 侧 `ma****17@126.com` 被上游打码），账号列表里
// 两者只差一个泛型 planType，**分不出谁是谁**。区域是凭据里的一事实
// （`oauth:active_provider`），把它带给界面即可。
//
// 纪律：区域名与展示签的唯一来源是 lib/server/zcode-region.js 的区域表；
// 本模块只做「从凭据对象取 region id」与「渲染标签」两件事，不重复护区域名单。

const { resolveZcodeRegion } = require('../server/zcode-region');

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 从已解析的 oauth 凭据对象取区域 id（'zai' / 'bigmodel'）。
 * 未知/缺失时返回 ''（而不是回落到默认区域）—— 展示层需要区分「未判定」与
 * 「确实是 zai」，回落会把未知账号误标成 zai。
 */
function resolveZcodeAccountRegion(oauth) {
  const provider = normalizeText(oauth && oauth.activeProvider).toLowerCase();
  if (!provider) return '';
  // 走区域表校验：只有表里登记的区域才算「已判定」。
  const region = resolveZcodeRegion(provider);
  return region && region.provider === provider ? region.provider : '';
}

/**
 * 区域展示标签。取值同样来自区域表（新增区域只改表）。
 * 返回 '' 表示未判定，调用方不渲染标签。
 */
function zcodeRegionLabel(regionId) {
  const id = normalizeText(regionId).toLowerCase();
  if (!id) return '';
  const region = resolveZcodeRegion(id);
  if (!region || region.provider !== id) return '';
  // 区域表里的 label 形如「Z.AI（国际站）」「BigModel（国内站）」——已经是人读文案，
  // 直接复用，避免这里再维护第二份别名。
  return normalizeText(region.label);
}

module.exports = {
  resolveZcodeAccountRegion,
  zcodeRegionLabel
};
