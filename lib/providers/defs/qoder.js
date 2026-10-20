'use strict';

// qoder 的能力自描述（provider 描述符契约 v1，见 lib/providers/contract.js）。
//
// 新增或修改这个 provider 的能力**只改这个文件**：注册表按能力建倒排索引
// （lib/providers/registry.js），消费方问能力名而不是认 provider 名，
// 因此不存在需要同步维护的 provider 清单。
//
// 额度：明确声明不可得（原因写在 quota.reason，账号页据此显示「额度不适用」）。
// 额度实现：lib/usage/quota/probes/qoder-family.js（HTTP 账号面，全球站 openapi.qoder.sh）。
const { createProbe: createQoderQuotaProbe } = require('../../usage/quota/probes/qoder-family');

module.exports = {
  contractVersion: 1,
  id: 'qoder',
  capabilities: {
    // 模型发现：只有依赖本机客户端的通道 → 必须写清为什么（契约强制 clientFreeReason）。
    models: {
      supported: true,
      clientFreeReason: 'Qoder 的凭据是 WASM 用 machineId 加密的本地 blob、模型请求还要过 Cosy/sgsdk 签名，官方没有可直连的模型目录接口；模型清单只能问本地 qodercli（--list-models）。',
      strategies: [
        {
          id: 'qoder-native-cli-models',
          transport: 'cli',
          cli: { args: ['--list-models'], configDirFlag: '--config-dir', minTimeoutMs: 20000 },
          clientDependent: true,
          discover: () => null, // 由 native-cli-model-discovery 执行
          description: '本地 CLI / App 内嵌运行时的模型清单'
        }
      ]
    },
    // 额度：**HTTP 账号面**（不依赖本机客户端）。旧结论「客户端侧没有可复用的额度查询面」
    // 只看了推理面与本地 CLI；2026-10-16 实测账号面 `/api/v2/quota/usage`（Bearer = 登录态里的
    // security_oauth_token）直接给 credits 池与到期时间，另有 `/api/v2/user/plan`（套餐档）与
    // `/api/v3/user/status`（配额/重置时间）。token 由本机 CLI 登录态解密得到（PAT 账号走 env）。
    quota: {
      supported: true,
      kind: 'qoder_credit_usage',
      source: 'qoder_quota_usage_api',
      shape: 'entries',
      entryShape: 'window',
      strategies: [
        {
          id: 'qoder-http-quota',
          transport: 'http',
          clientDependent: false,
          probe: (deps) => createQoderQuotaProbe(deps),
          description: 'Qoder 账号面额度接口（HTTP）'
        }
      ]
    },
    relay: { transport: 'client-cli', clientDependent: true,
      reason: '推理只能经本机 CLI headless（qodercli）执行：没有可直连的 HTTP 通道' },
    // 账号活动：每日签到领 100 Credits。实现由组合根注册为 handler
    // `qoder-daily-checkin`（lib/account/activity-claim/index.js），这里只声明可执行动作。
    activity: {
      supported: true,
      actions: [
        {
          id: 'daily_checkin',
          label: '每日签到',
          handler: 'qoder-daily-checkin',
          description: '每天 10:00 (UTC+8) 重置，领取 100 Credits'
        }
      ]
    }
  }
};
