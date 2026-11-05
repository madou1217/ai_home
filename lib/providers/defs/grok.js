'use strict';

// grok 的能力自描述（provider 描述符契约 v1，见 lib/providers/contract.js）。
//
// 新增或修改这个 provider 的能力**只改这个文件**：注册表按能力建倒排索引
// （lib/providers/registry.js），消费方问能力名而不是认 provider 名，
// 因此不存在需要同步维护的 provider 清单。
//
// 额度实现：Go 的 grok_build_billing_api（billing?format=credits + gRPC-Web 兜底）。
// token 由 Node 的 token-refresh-daemon 续期后同步进 Go，Node 不再自行探测额度。
const { goOwnedQuota } = require('../quota-ownership');
const { goOwnedModels } = require('../model-ownership');
const usagePort = require('../../usage/provider-usage/grok');

module.exports = {
  contractVersion: 1,
  id: 'grok',
  capabilities: {
    // 模型发现：**显式回答**该 provider 有没有「不依赖本机客户端」的通道（契约强制）。
    // 没有的话必须写 clientFreeReason 说明原因，否则描述符加载失败（2026-10-15 kiro 教训）。
    // 模型发现：Go 的 /models 探测（API Key）已落 account_models，Node 只读。
    models: goOwnedModels('grok'),
    quota: goOwnedQuota('grok'),
    hooks: {
      supported: true,
      adapter: 'json_hooks',
      // grok 读 ~/.grok/hooks/*.json；这一个文件由 AIH 独占（不像 claude 的共享 settings.json）。
      target: ['.grok', 'hooks', 'aih-session-sync.json']
    },
    usage: usagePort,
    relay: { transport: 'http', clientDependent: false }
  }
};
