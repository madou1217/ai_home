'use strict';

// Node 账号级模型开关 -> Go 人工模型策略（account_models.manual_policy）的对账规划。
//
// Node 的 model-catalog-settings 是用户关闭/手动添加模型的写入口；Go 路由只认 aih.db。
// 不同步时 Go 会把用户关掉的模型继续路由到该账号，自动刷新目录后更会把新发现的模型
// 以 inherit 放进账号池。映射规则：
//   enabled=false            -> force_disable
//   enabled=true + manual    -> force_enable
//   其余                     -> 不强制；仅当该覆盖由本同步写入过时才还原为 inherit，
//                               从不改写 Go 侧自行设置的人工策略。
// 纯函数规划（Strategy 输入 -> 写计划），执行与状态持久化留给调用方的对账循环。

const FORCE_DISABLE = 'force_disable';
const FORCE_ENABLE = 'force_enable';
const INHERIT = 'inherit';

function policyKey(goRef, modelId) {
  return `${goRef}\u0000${modelId}`;
}

function desiredPolicy(record) {
  if (record.enabled === false) return FORCE_DISABLE;
  if (record.manual === true) return FORCE_ENABLE;
  return '';
}

// primaryByGoRef: goRef -> Node 主账号记录（与启停同步同一主从规则）。
// pushedKeys: 本同步此前写入过的非 inherit 覆盖键。
function planModelPolicySync({ settings, primaryByGoRef, goModelPolicies, pushedKeys }) {
  const goRefByNodeRef = new Map();
  for (const [goRef, record] of primaryByGoRef) goRefByNodeRef.set(record.accountRef, goRef);

  const desired = new Map();
  for (const record of (settings && settings.accountModels) || []) {
    const goRef = goRefByNodeRef.get(record && record.accountRef);
    const policy = goRef ? desiredPolicy(record) : '';
    if (!policy || !record.id) continue;
    desired.set(policyKey(goRef, record.id), { accountRef: goRef, modelId: record.id, manualPolicy: policy });
  }

  const current = new Map();
  for (const row of goModelPolicies || []) current.set(policyKey(row.accountRef, row.modelId), row.manualPolicy);

  const writes = [];
  for (const [key, target] of desired) {
    if (current.get(key) !== target.manualPolicy) writes.push(target);
  }
  for (const key of pushedKeys || []) {
    if (desired.has(key) || !current.has(key)) continue;
    const [accountRef, modelId] = key.split('\u0000');
    if (!primaryByGoRef.has(accountRef)) continue;
    writes.push({ accountRef, modelId, manualPolicy: INHERIT });
  }
  return { writes, desiredKeys: Array.from(desired.keys()) };
}

module.exports = {
  planModelPolicySync,
  policyKey
};
