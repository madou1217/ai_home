'use strict';

const { goOwnedQuota } = require('../quota-ownership');
const { goOwnedModels } = require('../model-ownership');

// qoder 的能力自描述（provider 描述符契约 v1，见 lib/providers/contract.js）。
//
// 新增或修改这个 provider 的能力**只改这个文件**：注册表按能力建倒排索引
// （lib/providers/registry.js），消费方问能力名而不是认 provider 名，
// 因此不存在需要同步维护的 provider 清单。
//
// 额度：明确声明不可得（原因写在 quota.reason，账号页据此显示「额度不适用」）。
// 额度实现已迁到 Go（internal/adapters/qoder/usage，全球站 openapi.qoder.sh）；
// Node 侧只保留 lib/usage/quota/probes/qoder-family.js 给签到等其它链路复用 token 解析。

module.exports = {
  contractVersion: 1,
  id: 'qoder',
  capabilities: {
    // 模型发现：目录由 Go 发现（WASM 签名 + 明文 JSON，落 account_models），Node 只读。
    // HTTP 与本地 CLI 两条探测链均已退役。
    models: goOwnedModels('qoder'),
    // 额度：**HTTP 账号面**（不依赖本机客户端）。旧结论「客户端侧没有可复用的额度查询面」
    // 只看了推理面与本地 CLI；2026-10-16 实测账号面 `/api/v2/quota/usage`（Bearer = 登录态里的
    // security_oauth_token）直接给 credits 池与到期时间，另有 `/api/v2/user/plan`（套餐档）与
    // `/api/v3/user/status`（配额/重置时间）。token 由本机 CLI 登录态解密得到（PAT 账号走 env）。
    quota: goOwnedQuota('qoder'),
    relay: { transport: 'http', clientDependent: false,
      reason: 'HTTP 直连优先（WASM 签名；凭据取自账号投影），失败自动回落本机 CLI headless' },
    // 账号活动：每日签到领 100 Credits。实现由组合根注册为 handler
    // `qoder-daily-checkin`（lib/account/activity-claim/index.js），这里只声明可执行动作。
    activity: {
      supported: true,
      actions: [
        {
          id: 'daily_checkin',
          label: '签到',
          handler: 'qoder-daily-checkin',
          description: '每天 10:00 (UTC+8) 重置，领取 100 Credits',
          // 对外提供定时调度；签到一天一次，1 小时内重复触发只执行一次。
          schedulable: true,
          scheduleDebounceMs: 60 * 60 * 1000
        }
      ]
    }
  }
};
