'use strict';

// 「读 Go 的 account_models」模型发现策略（handler id: go-account-models）。
//
// 背景：模型目录的权威存储已经迁到 Go（account_models），Node 的职责只剩读取。
// 这个 handler 就是描述符里 `handler: 'go-account-models'` 的实现：
//   * 描述符声明 `transport: 'local'` → 在出网解析之前执行，不依赖账号出口；
//   * 派发路径（model-discovery/index.js）不认识任何 Provider 名；
//   * 失败只返回结构化 error，由策略链决定是记失败还是继续下一条。
//
// 读不到的三种情况必须分清（返回不同 error，便于诊断，不用于推理判定）：
//   * 未装配 Go 读取器（Go core 关闭 / 纯 Node 模式）；
//   * Go 端点不可达或响应无效；
//   * Go 里没有该账号的目录（账号尚未同步 / 从未探测）。

const { createGoModelCatalogReader } = require('../go-model-catalog-reader');

function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function createGoAccountModelDiscoverer(deps = {}) {
  return {
    async discover(account) {
      const call = deps.goAccountModels;
      if (typeof call !== 'function') return { error: 'go_model_catalog_reader_missing' };
      const nodeRef = normalizeText(account && account.accountRef);
      if (!nodeRef) return { error: 'go_model_catalog_account_ref_missing' };
      // Node ref 与 Go ref 在同步 rekey 后可能不同；翻译失败时不能拿 Node ref 硬查
      // （会查到一个不存在的账号，看起来像「没有模型」）。
      const resolveGoRef = typeof deps.goAccountRefFor === 'function' ? deps.goAccountRefFor : null;
      const goRef = normalizeText(resolveGoRef ? resolveGoRef(nodeRef) : nodeRef);
      if (!goRef) return { error: 'go_model_catalog_account_ref_unmapped' };
      const reader = createGoModelCatalogReader({ call: (_method, path) => call(path) });
      const result = await reader.read({ account_ref: [goRef] }).catch(() => null);
      if (!result) return { error: 'go_model_catalog_unreachable' };
	      const models = result.byAccount && result.byAccount[goRef];
	      if (!Array.isArray(models)) {
	        // 账号刚登录/刚同步时 Go 还没有 account_models 或探测事实：
	        // 这是「未知」不是「读取失败」。按空目录交给首次探测，
	        // 否则冷启动会被判成 go_model_catalog_unavailable 并卡住整条链路。
	        return { models: [] };
	      }
	      return { models: models.slice() };
    }
  };
}

module.exports = { createGoAccountModelDiscoverer };
