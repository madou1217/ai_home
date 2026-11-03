'use strict';

// plan 分类：把上游的 plan 实例归到描述符声明的「类型」上。
//
// 为什么需要这一层：zcode 的服务端**没有 type 字段**，只有 plan_id / name /
// priority / status / starts_at / ends_at。而「ZCODE WEEKEND BUILD」与早期的
// 「ZCode Start Plan」是同一族（`zcode-v3-start-plan-*`）的不同实例：
// `zcode-v3-start-plan-1030-wk` 的 name 才是 ZCODE WEEKEND BUILD。
// 更关键的是营销投放通道只下发 plan_id、没有 name，所以**判据必须优先 plan_id**。
//
// 规则是数据（描述符的 action.kinds），求值器只有这一份。谓词白名单由
// lib/providers/contract.js 保证，未知谓词在这里 fail-closed 返回不匹配。

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function planIdOf(plan) {
  return normalizeText(plan && (plan.planId || plan.plan_id));
}

function planNameOf(plan) {
  return normalizeText(plan && plan.name);
}

function matchesPredicate(predicate, expected, planId, name) {
  if (!expected) return false;
  if (predicate === 'planIdPrefix') return planId.startsWith(expected);
  if (predicate === 'planIdSuffix') return planId.endsWith(expected);
  if (predicate === 'planIdContains') return planId.includes(expected);
  if (predicate === 'nameContains') return name.includes(expected);
  // 契约已把未知谓词拒在加载期；这里再兜一层，避免手工构造的 kinds 静默命中。
  return false;
}

/** 命中第一个 kind（规则有序）；都不命中返回空串。 */
function classifyPlan(plan, kinds) {
  const planId = planIdOf(plan);
  const name = planNameOf(plan);
  if (!planId && !name) return '';
  for (const kind of Array.isArray(kinds) ? kinds : []) {
    const when = kind && kind.when && typeof kind.when === 'object' ? kind.when : null;
    if (!when) continue;
    const predicates = Object.entries(when);
    if (predicates.length === 0) continue;
    if (predicates.every(([predicate, expected]) => matchesPredicate(predicate, expected, planId, name))) {
      return normalizeText(kind.id);
    }
  }
  return '';
}

/**
 * 把探测到的 plan 列表折算成「类型目录」，给前端下拉框与结果展示共用。
 *
 * **每个 plan 只归一个类型**（按声明顺序首个命中）：`start_plan` 的前缀规则是
 * `zcode-v3-start-plan`，它会匹配到周末活动那个 plan —— 若逐个 kind 独立求值，
 * 同一个 plan 会同时出现在两个类型下，「这次领的是哪种」就失去意义。
 */
function describePlanKinds(kinds, plans) {
  const list = Array.isArray(kinds) ? kinds : [];
  const hasPlans = Array.isArray(plans);
  const matchedByKind = new Map();
  for (const kind of list) matchedByKind.set(normalizeText(kind.id), []);
  if (hasPlans) {
    for (const plan of plans) {
      const kindId = classifyPlan(plan, list);
      if (!kindId) continue;
      const bucket = matchedByKind.get(kindId);
      if (bucket) bucket.push(plan);
    }
  }
  return list.map((kind) => {
    const id = normalizeText(kind.id);
    const matched = matchedByKind.get(id) || [];
    return {
      id,
      label: normalizeText(kind.label),
      description: normalizeText(kind.description),
      ...(hasPlans ? { claimable: matched.length > 0 } : {}),
      planIds: [...new Set(matched.map(planIdOf).filter(Boolean))]
    };
  });
}

module.exports = {
  classifyPlan,
  describePlanKinds
};
