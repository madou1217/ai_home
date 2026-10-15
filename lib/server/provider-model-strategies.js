'use strict';

// 兼容层：模型发现策略链的**唯一实现**在 lib/server/model-discovery/index.js（门面）。
// 本文件只做转发，避免出现两套「按 clientDependent 排序 + 失败切换 + attempts」的实现。
// 新代码请直接 require('./model-discovery')。

const {
  listModelDiscoveryStrategies,
  discoverProviderModelsViaStrategies,
  summarizeModelStrategyAttempts
} = require('./model-discovery');

module.exports = {
  // 旧名字保留为别名（避免破坏既有调用点/测试）
  runProviderModelStrategies: discoverProviderModelsViaStrategies,
  listModelDiscoveryStrategies,
  discoverProviderModelsViaStrategies,
  summarizeModelStrategyAttempts
};
