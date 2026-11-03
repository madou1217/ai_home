'use strict';

// 模型发现的 **Handler Registry（注册表）** —— 策略实现按 id 注册，门面按 id 解析。
//
// 与额度策略同一条设计（lib/usage/quota/strategies.js 的 `handler` 型策略）：描述符只声明
// 「用哪个 handler」，实现由组合根注入。这样：
//   * 新增 provider 的模型发现 = 描述符里加一条策略 + 注册一个 handler，**不动派发代码**；
//   * 派发路径里不再出现 `if (provider === '…')`（provider 名只存在于描述符数据里）；
//   * handler 缺失是可观察错误（`handler_unavailable`），不会静默返回空清单。

const handlers = new Map();

/** 注册一个 handler（同一 id 重复注册视为冲突，显式报错而不是静默覆盖）。 */
function registerModelDiscoveryHandler(id, factory) {
  const key = String(id || '').trim();
  if (!key) throw new Error('model_discovery_handler_id_required');
  if (typeof factory !== 'function') throw new Error('model_discovery_handler_factory_required');
  if (handlers.has(key)) throw new Error(`model_discovery_handler_duplicate:${key}`);
  handlers.set(key, factory);
  return key;
}

/** 测试/热重载用：清空注册表。 */
function resetModelDiscoveryHandlers() {
  handlers.clear();
}

function getModelDiscoveryHandler(id) {
  const key = String(id || '').trim();
  if (!key) return null;
  return handlers.get(key) || null;
}

function listModelDiscoveryHandlers() {
  return [...handlers.keys()].sort();
}

module.exports = {
  registerModelDiscoveryHandler,
  resetModelDiscoveryHandlers,
  getModelDiscoveryHandler,
  listModelDiscoveryHandlers
};
