'use strict';

// grok 的能力自描述（provider 描述符契约 v1，见 lib/providers/contract.js）。
//
// 新增或修改这个 provider 的能力**只改这个文件**：注册表按能力建倒排索引
// （lib/providers/registry.js），消费方问能力名而不是认 provider 名，
// 因此不存在需要同步维护的 provider 清单。
//
// 额度实现：grok-quota-probe（探针工厂，HTTP）。
const { createGrokQuotaProbe } = require('../../cli/services/usage/grok-quota-probe');
const usagePort = require('../../usage/provider-usage/grok');

module.exports = {
  contractVersion: 1,
  id: 'grok',
  capabilities: {
    // 模型发现：**显式回答**该 provider 有没有「不依赖本机客户端」的通道（契约强制）。
    // 没有的话必须写 clientFreeReason 说明原因，否则描述符加载失败（2026-10-15 kiro 教训）。
    models: {
      supported: true,
      source: 'xai_models_api',
      strategies: [
        {
          id: 'grok-http-models',
          transport: 'http',
          clientDependent: false,
          handler: 'generic-models-probe', // 实现由组合根注册（lib/server/http-utils.js 的 registerModelDiscoveryHandler）
          description: 'API Key 账号走通用 /models 探测；CLI OAuth 账号走本地 CLI'
        }
        ,{
          id: 'grok-native-cli-models',
          transport: 'cli',
          cli: { args: ['models'], format: 'grok-lines', minTimeoutMs: 20000 },
          clientDependent: true,
          handler: 'native-cli', // 本地 CLI 执行器（lib/server/native-cli-model-discovery.js）
          description: '本地 CLI 的模型清单（兜底）'
        }
      ]
    },
    quota: {
      supported: true,
      kind: 'grok_credit_usage',
      source: 'grok_build_billing_api',
      shape: 'entries',
      entryShape: 'bucket',
      strategies: [
        {
          id: 'grok-http',
          transport: 'http',
          clientDependent: false,
          probe: (deps) => createGrokQuotaProbe(deps),
          description: 'grok build 账单接口（HTTP）'
        }
      ]
    },
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
