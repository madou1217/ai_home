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
          discover: () => null, // 由 provider-model-discovery 的 HTTP 通道执行（见 lib/server/provider-model-strategies.js）
          description: 'API Key 账号走通用 /models 探测；CLI OAuth 账号走本地 CLI'
        }
        ,{
          id: 'grok-native-cli-models',
          transport: 'cli',
          clientDependent: true,
          discover: () => null, // 由 native-cli-model-discovery 兜底执行
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
    usage: usagePort,
    relay: { transport: 'http', clientDependent: false }
  }
};
