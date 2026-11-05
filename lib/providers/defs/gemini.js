'use strict';

const { goOwnedQuota } = require('../quota-ownership');
const { goOwnedModels } = require('../model-ownership');

const REGION_POLICIES = require('./_shared/region-policies');

// gemini 的能力自描述（provider 描述符契约 v1，见 lib/providers/contract.js）。
//
// 新增或修改这个 provider 的能力**只改这个文件**：注册表按能力建倒排索引
// （lib/providers/registry.js），消费方问能力名而不是认 provider 名，
// 因此不存在需要同步维护的 provider 清单。
//
// 额度实现：原生 handler `gemini`（组合根提供）；展示端口：lib/usage/provider-usage/gemini.js。
const usagePort = require('../../usage/provider-usage/gemini');

module.exports = {
  contractVersion: 1,
  id: 'gemini',
  capabilities: {
    // 模型发现：**显式回答**该 provider 有没有「不依赖本机客户端」的通道（契约强制）。
    // 没有的话必须写 clientFreeReason 说明原因，否则描述符加载失败（2026-10-15 kiro 教训）。
    // 模型发现：code-assist 目录由 Go 产出，Node 只读。
    models: goOwnedModels('gemini'),
    quota: goOwnedQuota('gemini'),
    hooks: {
      supported: true,
      adapter: 'json_hooks',
      target: ['.gemini', 'settings.json'],
      // gemini 的 hook timeout 单位是毫秒（其余 provider 是秒）。
      timeoutUnit: 'ms'
    },
    usage: usagePort,
    relay: { transport: 'http', clientDependent: false },
    // 官方上游的地区策略：只是提示，实测可推翻（数据与出处见 _shared/region-policies.js）。
    egress: { regionPolicy: REGION_POLICIES.GOOGLE }
  }
};
