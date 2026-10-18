'use strict';

// zcode 的能力自描述（provider 描述符契约 v1，见 lib/providers/contract.js）。
//
// 新增或修改这个 provider 的能力**只改这个文件**：注册表按能力建倒排索引
// （lib/providers/registry.js），消费方问能力名而不是认 provider 名，
// 因此不存在需要同步维护的 provider 清单。
//
// 额度实现：zcode-quota-probe（探针工厂，HTTP）。
// 展示端口：lib/usage/provider-usage/zcode.js（套餐名进账号记录）。
const { createZcodeQuotaProbe } = require('../../cli/services/usage/zcode-quota-probe');
const usagePort = require('../../usage/provider-usage/zcode');

module.exports = {
  contractVersion: 1,
  id: 'zcode',
  capabilities: {
    // 模型发现：**显式回答**该 provider 有没有「不依赖本机客户端」的通道（契约强制）。
    // 没有的话必须写 clientFreeReason 说明原因，否则描述符加载失败（2026-10-15 kiro 教训）。
    models: {
      supported: true,
      source: 'zcode_models_api',
      strategies: [
        {
          modes: ['login'], // 登录态账号
          id: 'zcode-http-models',
          transport: 'http',
          clientDependent: false,
          handler: 'zcode-plan-models', // 实现由组合根注册（lib/server/http-utils.js 的 registerModelDiscoveryHandler）
          description: 'plan balance / paas 目录（zcodeJwtToken，长期凭据）'
        },
        {
          // 模式差异：上面的策略只适用于登录态账号；API Key / 第三方端点账号走通用 /models 探测。
          // 模式不适用时 handler 返回 not_applicable_*，链自动切到这一条（不是 if/else 分支）。
          modes: ['api-key'], // API Key / 第三方端点账号
          id: 'zcode-generic-models',
          transport: 'http',
          clientDependent: false,
          handler: 'generic-models-probe',
          description: '通用 OpenAI/Anthropic 兼容 /models 探测（API Key 模式）'
        }
      ]
    },
    quota: {
      supported: true,
      kind: 'zcode_plan_balance',
      source: 'zcode_plan_billing_balance_api',
      shape: 'entries',
      entryShape: 'bucket',
      strategies: [
        {
          id: 'zcode-http',
          transport: 'http',
          clientDependent: false,
          probe: (deps) => createZcodeQuotaProbe(deps),
          description: 'Coding Plan 余额接口（HTTP，需登录态 zcodeJwtToken；API Key 账号返回不适用）'
        }
      ]
    },
    // 展示端口（plan badge / 套餐元数据 / 按需刷新）：快照 account.planType 进账号记录。
    usage: usagePort,
    relay: { transport: 'http', clientDependent: false },
    // 账号出口：地址写进原生 setting.json 的 `httpProxy` 字段，该字段对 socks 的语义未经取证
    // （本机未装 ZCode 可验），只接受 HTTP(S)，保存时就明确报错，不写进一个无法验证的字段。
    egress: {
      proxySchemes: ['http:', 'https:'],
      reason: 'ZCode 原生 setting.json 的 httpProxy 字段只确认支持 HTTP(S) 代理'
    }
  }
};
