'use strict';

const { goOwnedQuota } = require('../quota-ownership');
const { goOwnedModels } = require('../model-ownership');

const REGION_POLICIES = require('./_shared/region-policies');

// agy 的能力自描述（provider 描述符契约 v1，见 lib/providers/contract.js）。
//
// 新增或修改这个 provider 的能力**只改这个文件**：注册表按能力建倒排索引
// （lib/providers/registry.js），消费方问能力名而不是认 provider 名，
// 因此不存在需要同步维护的 provider 清单。
//
// 额度实现：原生 handler `agy`（组合根提供）；展示端口：lib/usage/provider-usage/agy.js。
const usagePort = require('../../usage/provider-usage/agy');

module.exports = {
  contractVersion: 1,
  id: 'agy',
  capabilities: {
    // 模型发现：**显式回答**该 provider 有没有「不依赖本机客户端」的通道（契约强制）。
    // 没有的话必须写 clientFreeReason 说明原因，否则描述符加载失败（2026-10-15 kiro 教训）。
    // 模型发现：code-assist 目录由 Go 产出（adapters/agy/codeassist），Node 只读。
    models: goOwnedModels('agy'),
    quota: goOwnedQuota('agy'),
    hooks: {
      supported: true,
      adapter: 'agy_named_hooks',
      target: ['.gemini', 'config', 'hooks.json']
    },
    usage: usagePort,
    relay: { transport: 'http', clientDependent: false },
    // 官方上游的地区策略：只是提示，实测可推翻（数据与出处见 _shared/region-policies.js）。
    egress: { regionPolicy: REGION_POLICIES.GOOGLE }
  }
};
