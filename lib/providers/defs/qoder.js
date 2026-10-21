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
const { createQoderHttpModelDiscovery } = require('../../account/qoder-model-catalog');

module.exports = {
  contractVersion: 1,
  id: 'qoder',
  capabilities: {
    // 模型发现：**纯 HTTP 策略优先**（`GET /api/v2/model/list?Encode=1`，用账号登录态做
    // WASM 签名，响应是明文 JSON 目录），本地 CLI 保留为兜底。两条策略的输入/输出同构，
    // 失败自动切下一条，attempts 可观察（见 lib/providers/index.js 的策略链）。
    models: {
      supported: true,
      source: 'qoder_model_list_api',
      strategies: [
        {
          id: 'qoder-http-models',
          transport: 'http',
          clientDependent: false,
          discover: (deps) => createQoderHttpModelDiscovery({
            fs: deps && deps.fs,
            aiHomeDir: deps && deps.aiHomeDir,
            path: deps && deps.path,
            hostHomeDir: deps && deps.hostHomeDir,
            // 已绑定账号出口的 fetch（签名/代理都在 transport 外侧，不在这里重造）。
            fetchWithTimeout: deps && (deps.egressFetchWithTimeout || deps.fetchWithTimeout)
          }),
          description: '模型目录接口（WASM 签名 + 明文 JSON，不依赖本机客户端运行）'
        },
        {
          id: 'qoder-native-cli-models',
          transport: 'cli',
          cli: { args: ['--list-models'], configDirFlag: '--config-dir', minTimeoutMs: 20000 },
          clientDependent: true,
          discover: () => null, // 由 native-cli-model-discovery 执行
          description: '本地 CLI / App 内嵌运行时的模型清单（兜底）'
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
    relay: { transport: 'http', clientDependent: false, strategy: 'qoder_http_sse',
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
          description: '每天 10:00 (UTC+8) 重置，领取 100 Credits'
        }
      ]
    }
  }
};
