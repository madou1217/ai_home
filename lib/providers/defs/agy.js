'use strict';

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
    models: {
      supported: true,
      source: 'code_assist_models_api',
      strategies: [
        {
          modes: ['login'], // 登录态账号
          id: 'agy-http-models',
          transport: 'http',
          clientDependent: false,
          handler: 'code-assist-models', // 实现由组合根注册（lib/server/http-utils.js 的 registerModelDiscoveryHandler）
          description: '同 gemini：code-assist 目录 + 通用探测兜底'
        },
        {
          // 模式差异：上面的策略只适用于登录态账号；API Key / 第三方端点账号走通用 /models 探测。
          // 模式不适用时 handler 返回 not_applicable_*，链自动切到这一条（不是 if/else 分支）。
          modes: ['api-key'], // API Key / 第三方端点账号
          id: 'agy-generic-models',
          transport: 'http',
          clientDependent: false,
          handler: 'generic-models-probe',
          description: '通用 OpenAI/Anthropic 兼容 /models 探测（API Key 模式）'
        }
      ]
    },
    quota: {
      supported: true,
      kind: 'agy_code_assist_quota',
      source: 'agy_fetch_available_models',
      shape: 'models',
      entryShape: 'models',
      strategies: [
        {
          id: 'agy-http',
          transport: 'http',
          clientDependent: false,
          clientOptional: true,
          handler: 'agy',
          description: 'code-assist 配额（HTTP）；token 可能来自系统 keyring，缺失时需显式 AGY_ACCESS_TOKEN'
        }
      ]
    },
    usage: usagePort,
    relay: { transport: 'http', clientDependent: false }
  }
};
