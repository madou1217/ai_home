'use strict';

const { scanLocalClientSources } = require('./local-clients');
const { subscriptionUrlKey } = require('./local-clients/scanner-kit');

/**
 * 扫描本机代理客户端配置（门面）：调所有客户端插件、跨客户端按订阅地址去重。
 * 只读 —— 不改任何客户端配置；是否已导入由 markImportedSources 对照现有订阅源标记。
 */
class LocalClientConfigScanner {
  constructor(options = {}) {
    this.scan = options.scan || scanLocalClientSources;
  }

  scanSources({ platform = process.platform, hostHomeDir = '', env = process.env, fs } = {}) {
    const clients = this.scan({ platform, hostHomeDir, env, fs });
    const seen = new Set();
    const candidates = [];
    for (const client of clients) {
      for (const candidate of client.candidates) {
        // 同一订阅被多个客户端缓存时只列一次（先扫到的客户端赢）。
        const key = subscriptionUrlKey(candidate.url);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        candidates.push(candidate);
      }
    }
    return {
      platform,
      clients: clients.map((client) => ({
        id: client.id,
        name: client.name,
        found: client.candidates.length,
        error: client.error || ''
      })),
      candidates
    };
  }
}

/**
 * 订阅地址相同即视为已导入。比较用规范化键（查询参数顺序、末尾斜杠、主机大小写都不算差异），
 * 不比较名称：同一机场在不同客户端里可能叫不同名字。
 */
function markImportedSources(candidates, sources) {
  const existingByKey = new Map();
  for (const source of Array.isArray(sources) ? sources : []) {
    if (!source || source.kind === 'local' || !source.url) continue;
    const key = subscriptionUrlKey(source.url);
    if (key && !existingByKey.has(key)) existingByKey.set(key, source);
  }
  return candidates.map((candidate) => {
    const existing = existingByKey.get(subscriptionUrlKey(candidate.url));
    return {
      ...candidate,
      imported: Boolean(existing),
      importedSourceId: existing ? existing.id : '',
      importedSourceName: existing ? existing.name : ''
    };
  });
}

module.exports = {
  LocalClientConfigScanner,
  markImportedSources
};
