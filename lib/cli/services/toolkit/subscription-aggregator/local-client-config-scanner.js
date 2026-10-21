'use strict';

// 把 local-clients/ 插件注册表包装成 aggregator-service 需要的接口：
//   LocalClientConfigScanner.scanSources(ctx) → { platform, clients, candidates }
//   markImportedSources(candidates, existingSources) → 带 imported 标记的候选数组
//
// 新增客户端 = 在 local-clients/ 加一个插件，这里不动。

const { scanLocalClientSources } = require('./local-clients');
const { subscriptionUrlKey } = require('./local-clients/scanner-kit');

class LocalClientConfigScanner {
  /**
   * 扫描本机所有已注册的代理客户端配置目录，返回扁平化的候选订阅列表。
   * @param {object} context - { platform, env, hostHomeDir }
   * @returns {{ platform: string, clients: object[], candidates: object[] }}
   */
  scanSources(context = {}) {
    const platform = context.platform || process.platform;
    const results = scanLocalClientSources({ ...context, platform });
    const clients = results.map(({ id, name, candidates, error }) => ({
      id,
      name,
      count: candidates.length,
      error: error || ''
    }));
    // 去重：同一订阅地址可能同时出现在多个客户端（用户两边都配了同一个机场）。
    const seen = new Set();
    const candidates = [];
    for (const result of results) {
      for (const candidate of result.candidates) {
        const key = candidate.url ? subscriptionUrlKey(candidate.url) : candidate.id;
        if (!key || seen.has(key)) continue;
        seen.add(key);
        candidates.push(candidate);
      }
    }
    return { platform, clients, candidates };
  }
}

/**
 * 把已经存在于订阅源库里的候选标记为 imported，界面据此灰掉、避免重复导入。
 * @param {object[]} candidates - scanSources 返回的候选列表
 * @param {object[]} existingSources - sources.listSources() 的结果
 * @returns {object[]} 带 imported 布尔字段的候选列表（浅拷贝）
 */
function markImportedSources(candidates, existingSources) {
  const existingKeys = new Set(
    (existingSources || [])
      .map((source) => subscriptionUrlKey(source.url))
      .filter(Boolean)
  );
  return (candidates || []).map((candidate) => ({
    ...candidate,
    imported: existingKeys.has(subscriptionUrlKey(candidate.url))
  }));
}

module.exports = { LocalClientConfigScanner, markImportedSources };
