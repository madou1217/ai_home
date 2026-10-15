'use strict';

// opencode 的能力自描述（provider 描述符契约 v1，见 lib/providers/contract.js）。
//
// 新增或修改这个 provider 的能力**只改这个文件**：注册表按能力建倒排索引
// （lib/providers/registry.js），消费方问能力名而不是认 provider 名，
// 因此不存在需要同步维护的 provider 清单。
//
// 额度：明确声明不可得（原因写在 quota.reason，账号页据此显示「额度不适用」）。
module.exports = {
  contractVersion: 1,
  id: 'opencode',
  capabilities: {
    // 模型发现：**显式回答**该 provider 有没有「不依赖本机客户端」的通道（契约强制）。
    // 没有的话必须写 clientFreeReason 说明原因，否则描述符加载失败（2026-10-15 kiro 教训）。
    models: {
      supported: true,
      source: 'opencode_models_api',
      strategies: [
        {
          id: 'opencode-http-models',
          transport: 'http',
          clientDependent: false,
          handler: 'opencode-models', // 实现由组合根注册（lib/server/http-utils.js 的 registerModelDiscoveryHandler）
          description: 'fetchOpenCodeModels（Zen / Go 目录）'
        }
      ]
    },
    quota: {
      supported: false,
      reason: 'OpenCode 官方没有额度/剩余百分比接口：Go/Zen 用量只能从会话统计侧计算（属于 usage_scan 能力，不是额度）。'
    },
    hooks: {
      supported: true,
      adapter: 'opencode_plugin',
      // 插件桥没有 JSON 事件清单，目标路径由适配器解析（插件目录）。
      target: []
    },
    relay: { transport: 'http', clientDependent: false }
  }
};
