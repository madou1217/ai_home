'use strict';

// kiro 的能力自描述（provider 描述符契约 v1，见 lib/providers/contract.js）。
//
// 新增或修改这个 provider 的能力**只改这个文件**：注册表按能力建倒排索引
// （lib/providers/registry.js），消费方问能力名而不是认 provider 名，
// 因此不存在需要同步维护的 provider 清单。
//
// 额度实现：kiro-quota-probe（探针工厂，HTTP）。
//
// **两条策略 = 「不依赖 CLI」与「CLI 兜底」**（策略链按 clientDependent=false 优先自动抉择，
// 失败自动切下一条，attempts 可观察，见 lib/usage/quota/strategies.js）：
//   1. kiro-http-refresh（纯 API）：用凭据里内嵌的 device-registration + refresh_token 走
//      AWS SSO OIDC CreateToken 自刷新，再打 GetUsageLimits。**不需要本地 CLI / 桌面 App。**
//   2. kiro-cli-capture（兜底）：从本地 CLI 的 sqlite 抄它刚刷新的 grant 再探测。
//      仅在拿不到 registration（很老的导入形态）或 OIDC 刷新被拒时才会用到。
const { CREDENTIAL_SOURCES, createKiroQuotaProbe } = require('../../cli/services/usage/kiro-quota-probe');
const { createKiroHttpModelDiscovery } = require('../../account/kiro-model-discovery');
const usagePort = require('../../usage/provider-usage/kiro');

module.exports = {
  contractVersion: 1,
  id: 'kiro',
  capabilities: {
    // 模型发现策略链：HTTP 优先（不装 CLI 也能列出模型），本地 CLI 兜底。
    models: {
      supported: true,
      source: 'codewhisperer_list_available_models_api',
      strategies: [
        {
          id: 'kiro-http-models',
          transport: 'http',
          clientDependent: false,
          discover: (deps) => createKiroHttpModelDiscovery(deps),
          description: 'ListAvailableModels（纯 HTTP，OIDC 自刷新，不依赖本地 CLI）'
        },
        {
          id: 'kiro-native-cli-models',
          transport: 'cli',
          clientDependent: true,
          discover: () => null, // 由 native-cli-model-discovery 兜底执行（见 lib/server/http-utils.js）
          description: '本地 kiro CLI 的 --list-models（兜底）'
        }
      ]
    },
    quota: {
      supported: true,
      kind: 'kiro_credit_usage',
      source: 'kiro_get_usage_limits_api',
      shape: 'entries',
      entryShape: 'bucket',
      strategies: [
        {
          id: 'kiro-http-refresh',
          transport: 'http',
          clientDependent: false,
          probe: (deps) => createKiroQuotaProbe({ ...deps, credentialSource: CREDENTIAL_SOURCES.HTTP_REFRESH }),
          description: 'OIDC 自刷新 + get-usage-limits（纯 HTTP，不依赖本地 CLI）'
        },
        {
          id: 'kiro-cli-capture',
          // 兜底策略的凭据来源是本地 CLI 的 sqlite，因此 transport 是 client-cli（不是 http），
          // 契约据此校验「非 http 通道必须声明 clientDependent」。
          transport: 'client-cli',
          clientDependent: true,
          probe: (deps) => createKiroQuotaProbe({ ...deps, credentialSource: CREDENTIAL_SOURCES.CLI_CAPTURE }),
          description: '抄本地 CLI 刷新后的 grant 再打 get-usage-limits（兜底）'
        }
      ]
    },
    usage: usagePort,
    relay: { transport: 'http', clientDependent: false }
  }
};
