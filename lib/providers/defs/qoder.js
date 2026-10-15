'use strict';

// qoder 的能力自描述（provider 描述符契约 v1，见 lib/providers/contract.js）。
//
// 新增或修改这个 provider 的能力**只改这个文件**：注册表按能力建倒排索引
// （lib/providers/registry.js），消费方问能力名而不是认 provider 名，
// 因此不存在需要同步维护的 provider 清单。
//
// 额度：明确声明不可得（原因写在 quota.reason，账号页据此显示「额度不适用」）。
module.exports = {
  contractVersion: 1,
  id: 'qoder',
  capabilities: {
    quota: {
      supported: false,
      reason: 'Qoder 凭据是 WASM + machineId 加密的本地 blob、请求过 sgsdk 签名，客户端侧没有可复用的额度查询面；配额墙只在推理失败时以 error_code 118 暴露，拿不到剩余百分比。'
    },
    relay: { transport: 'client-cli', clientDependent: true,
      reason: '推理只能经本机 CLI headless（qodercli）执行：没有可直连的 HTTP 通道' }
  }
};
