'use strict';

// qodercn 的能力自描述（provider 描述符契约 v1，见 lib/providers/contract.js）。
//
// 新增或修改这个 provider 的能力**只改这个文件**：注册表按能力建倒排索引
// （lib/providers/registry.js），消费方问能力名而不是认 provider 名，
// 因此不存在需要同步维护的 provider 清单。
//
// 额度：明确声明不可得（原因写在 quota.reason，账号页据此显示「额度不适用」）。
module.exports = {
  contractVersion: 1,
  id: 'qodercn',
  capabilities: {
    // 模型发现：只有依赖本机客户端的通道 → 必须写清为什么（契约强制 clientFreeReason）。
    models: {
      supported: true,
      clientFreeReason: '同 qoder（国内站）：凭据与签名都在客户端内，没有可直连的模型目录接口，只能问本地 qodercli。',
      strategies: [
        {
          id: 'qodercn-native-cli-models',
          transport: 'cli',
          cli: { args: ['--list-models'], configDirFlag: '--config-dir', minTimeoutMs: 20000 },
          clientDependent: true,
          discover: () => null, // 由 native-cli-model-discovery 执行
          description: '本地 CLI / App 内嵌运行时的模型清单'
        }
      ]
    },
    quota: {
      supported: false,
      reason: '同 qoder（国内站）：凭据与签名都在客户端内，没有可复用的额度查询面。'
    },
    relay: { transport: 'client-cli', clientDependent: true,
      reason: '推理只能经本机 CLI headless（qodercli）执行：没有可直连的 HTTP 通道' }
  }
};
