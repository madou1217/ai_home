'use strict';

// Claude 额度响应里的「模型族周额度」与「套餐」推导。
//
// 两件事都必须与 Go 侧 internal/adapters/claude/usage 同口径：
//   * 模型族不写死族名——任何 seven_day_<family> 键都是一族（fable 之前被丢掉）；
//   * 套餐不写死档位——organization_type 去掉 claude_ 前缀就是档位名。

// 模型族周额度的键前缀（seven_day_opus / seven_day_fable…）。
const MODEL_FAMILY_BUCKET_PREFIX = 'seven_day_';

// 同样以 seven_day_ 开头、但不属于模型族的账号级键。
const NON_FAMILY_BUCKETS = new Set(['seven_day', 'seven_day_oauth_apps']);

// 与 Go usagecore 的 scope_key 约束一致：小写标识符，最长 128。
const FAMILY_PATTERN = /^[a-z0-9_.:-]{1,128}$/;

/**
 * 从 usage 响应里列出模型族额度，按族名排序（与 Go 的条目顺序一致）。
 *
 * 只认对象形状且带数值 utilization 的键：形状不认识的族直接跳过，
 * 不让一个上游新增的怪键拖垮整次采集。
 *
 * @param {object} payload /api/oauth/usage 的响应体
 * @returns {Array<{bucket: string, family: string, utilization: number, resetAt: string}>}
 */
function listModelFamilyBuckets(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const buckets = [];
  for (const key of Object.keys(payload)) {
    if (!key.startsWith(MODEL_FAMILY_BUCKET_PREFIX) || NON_FAMILY_BUCKETS.has(key)) continue;
    const family = key.slice(MODEL_FAMILY_BUCKET_PREFIX.length);
    if (!FAMILY_PATTERN.test(family)) continue;
    const raw = payload[key];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const utilization = Number(raw.utilization);
    if (!Number.isFinite(utilization)) continue;
    buckets.push({
      bucket: key,
      family,
      utilization,
      resetAt: raw.resets_at || raw.resetsAt || null
    });
  }
  return buckets.sort((left, right) => left.family.localeCompare(right.family));
}

// 与 Go usagecore.IsPlanToken 同集合：这些值不是套餐。
const NON_PLAN_VALUES = new Set([
  '', 'oauth', 'oauth_browser', 'oauth_device', 'api_key', 'apikey', 'pending', 'unknown'
]);

/**
 * 从 /api/oauth/profile 推导套餐名。
 *
 * has_claude_max / has_claude_pro 是上游自己的布尔结论，优先于组织类型；
 * 其余取 organization_type 去掉 claude_ 前缀（claude_team → team、
 * claude_fable → fable），上游新增档位不需要改代码。
 *
 * @param {object} profile /api/oauth/profile 的响应体
 * @returns {string} 归一后的套餐名；未知返回空串
 */
function claudePlanType(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return '';
  const account = profile.account && typeof profile.account === 'object' ? profile.account : null;
  if (account && account.has_claude_max === true) return 'max';
  if (account && account.has_claude_pro === true) return 'pro';
  const organization = profile.organization && typeof profile.organization === 'object'
    ? profile.organization
    : null;
  const organizationType = String(organization && organization.organization_type || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/^claude_/, '');
  return NON_PLAN_VALUES.has(organizationType) ? '' : organizationType;
}

module.exports = {
  MODEL_FAMILY_BUCKET_PREFIX,
  listModelFamilyBuckets,
  claudePlanType
};
