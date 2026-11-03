'use strict';

// opencode 网关 profile 的默认模型挑选规则（唯一实现；启动 overlay 与宿主配置共用）。
//
// 不写死具体型号（型号随上游上下线）：只从运行时探测到的模型里挑。
// 规则：按家族优先级（sonnet > opus > haiku > 其余）选，同家族取**版本号最大**的，
// 不靠字母序（`claude-3-7` 会排在 `claude-opus-5` 前面，选出几年前的老模型）。
const PREFERRED_FAMILIES = Object.freeze(['sonnet', 'opus', 'haiku']);

// 取 id 里第一段数字（`claude-opus-4-5-20251101` → 4），次段作平局（→ 5）。
// 8 位纯数字是发布日期快照（`-20250514`），不是版本号：计入会让 `claude-sonnet-4-20250514`
// （[4, 20250514]）压过 `claude-sonnet-4-6`（[4, 6]），所以排除在版本段之外，只作最后的平局。
const DATE_SNAPSHOT_PATTERN = /^\d{8}$/;

function versionScore(name) {
  const groups = String(name).match(/\d+/g) || [];
  const parts = groups.filter((group) => !DATE_SNAPSHOT_PATTERN.test(group));
  const date = groups.find((group) => DATE_SNAPSHOT_PATTERN.test(group));
  return [Number(parts[0]) || 0, Number(parts[1]) || 0, Number(date) || 0];
}

function newest(list) {
  return list.slice().sort((a, b) => {
    const [a1, a2, a3] = versionScore(a);
    const [b1, b2, b3] = versionScore(b);
    return b1 - a1 || b2 - a2 || b3 - a3 || String(b).localeCompare(String(a));
  })[0] || '';
}

/** 从 claude 家族模型名里挑默认模型；列表为空返回 ''。 */
function pickPreferredClaudeModel(names) {
  const list = (Array.isArray(names) ? names : []).filter((n) => typeof n === 'string' && n);
  if (list.length === 0) return '';
  for (const family of PREFERRED_FAMILIES) {
    const members = list.filter((n) => n.includes(`-${family}`));
    if (members.length > 0) return newest(members);
  }
  return newest(list);
}

module.exports = {
  pickPreferredClaudeModel
};
