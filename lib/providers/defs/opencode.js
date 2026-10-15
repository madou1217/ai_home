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
    quota: {
      supported: false,
      reason: 'OpenCode 官方没有额度/剩余百分比接口：Go/Zen 用量只能从会话统计侧计算（属于 usage_scan 能力，不是额度）。'
    },
    relay: { transport: 'http', clientDependent: false }
  }
};
