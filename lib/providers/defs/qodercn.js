'use strict';

// qodercn 的能力自描述（provider 描述符契约 v1，见 lib/providers/contract.js）。
//
// 新增或修改这个 provider 的能力**只改这个文件**：注册表按能力建倒排索引
// （lib/providers/registry.js），消费方问能力名而不是认 provider 名，
// 因此不存在需要同步维护的 provider 清单。
//
// 额度：明确声明不可得（原因写在 quota.reason，账号页据此显示「额度不适用」）。
// 额度实现已迁到 Go（internal/adapters/qoder/usage，国内站 openapi.qoder.com.cn）；
// Node 侧只保留 lib/usage/quota/probes/qoder-family.js 给签到等其它链路复用 token 解析。
const { createQoderHttpModelDiscovery } = require('../../account/qoder-model-catalog');

module.exports = {
  contractVersion: 1,
  id: 'qodercn',
  capabilities: {
    // 模型发现：与全球站同一条接口，只是区域主机不同（HTTP 优先、本地 CLI 兜底）。
    models: {
      supported: true,
      source: 'qoder_model_list_api',
      strategies: [
        {
          id: 'qodercn-http-models',
          transport: 'http',
          clientDependent: false,
          discover: (deps) => createQoderHttpModelDiscovery({
            fs: deps && deps.fs,
            aiHomeDir: deps && deps.aiHomeDir,
            path: deps && deps.path,
            hostHomeDir: deps && deps.hostHomeDir,
            fetchWithTimeout: deps && (deps.egressFetchWithTimeout || deps.fetchWithTimeout)
          }),
          description: '模型目录接口（WASM 签名 + 明文 JSON，不依赖本机客户端运行）'
        },
        {
          id: 'qodercn-native-cli-models',
          transport: 'cli',
          cli: { args: ['--list-models'], configDirFlag: '--config-dir', minTimeoutMs: 20000 },
          clientDependent: true,
          discover: () => null, // 由 native-cli-model-discovery 执行
          description: '本地 CLI / App 内嵌运行时的模型清单（兜底）'
        }
      ]
    },
    // 额度：与 qoder 同一条账号面接口，只是区域主机不同（openapi.qoder.com.cn）。
    quota: {
      // 额度采集已迁到 Go（qoder/usage）。Node 只读 Go 文档，不再走策略链探测。
      supported: false,
      reason: 'qoder 额度由 Go 采集（/api/v2/quota/usage）；Node 不再走策略链探测。'
    },
    relay: { transport: 'http', clientDependent: false, strategy: 'qoder_http_sse',
      reason: 'HTTP 直连优先（WASM 签名；凭据取自账号投影），失败自动回落本机 CLI headless' },
    // 账号活动：与全球站同一条签到接口，只是区域主机不同。
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
