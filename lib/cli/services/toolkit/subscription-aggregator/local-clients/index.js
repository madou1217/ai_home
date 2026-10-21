'use strict';

const clashVerge = require('./clash-verge');
const clashFamily = require('./clash-family');
const surge = require('./surge');
const v2rayn = require('./v2rayn');

// 扫描客户端 = 插件 + 注册表：新增客户端只加一个插件文件、这里登记一行，
// 扫描服务、路由与前端都不动（与协议插件同一套扩展方式）。
const SCANNERS = Object.freeze([clashVerge, clashFamily, surge, v2rayn]);

/** 每个插件只读扫描自己的目录；单个插件异常不影响其它客户端。 */
function scanLocalClientSources(context = {}) {
  const scanContext = {
    ...context,
    platform: context.platform || process.platform
  };
  return SCANNERS.map((scanner) => {
    try {
      const result = scanner.scan(scanContext) || {};
      return {
        id: scanner.id,
        name: scanner.name,
        candidates: Array.isArray(result.candidates) ? result.candidates : [],
        error: ''
      };
    } catch (error) {
      return {
        id: scanner.id,
        name: scanner.name,
        candidates: [],
        error: String((error && error.message) || error || 'scan_failed')
      };
    }
  });
}

function listLocalScanners() {
  return SCANNERS.map(({ id, name }) => ({ id, name }));
}

module.exports = {
  SCANNERS,
  listLocalScanners,
  scanLocalClientSources
};
