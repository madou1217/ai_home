'use strict';

// 订阅解析、节点存储和不同代理核心共享的中立协议契约。
// 这里不包含任何运行时或配置格式细节，避免节点领域反向依赖某个具体核心；
// 具体协议由 ./protocols 插件注册表提供。

const SUPPORTED_TRANSPORTS = new Set(['tcp', 'ws', 'grpc']);

function isValidPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

module.exports = {
  SUPPORTED_TRANSPORTS,
  isValidPort
};

// 受支持协议与别名来自协议插件注册表（./protocols）。延迟取值：协议插件引用的
// 内核字段工具又依赖本契约里的传输层定义，顶层 require 会形成初始化环。
Object.defineProperties(module.exports, {
  SUPPORTED_PROTOCOLS: { enumerable: true, get: () => require('./protocols').SUPPORTED_PROTOCOLS },
  normalizeProtocol: { enumerable: true, get: () => require('./protocols').normalizeProtocol }
});
