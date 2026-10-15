'use strict';

// cline 的能力自描述（provider 描述符契约 v1，见 lib/providers/contract.js）。
//
// 新增或修改这个 provider 的能力**只改这个文件**：注册表按能力建倒排索引
// （lib/providers/registry.js），消费方问能力名而不是认 provider 名，
// 因此不存在需要同步维护的 provider 清单。
//
// 额度实现：lib/usage/quota/plugins/cline.js（HTTP，Cline 账号面接口）。
const { createProbe } = require('../../usage/quota/probes/cline');
const usagePort = require('../../usage/provider-usage/cline');

module.exports = {
  contractVersion: 1,
  id: 'cline',
  capabilities: {
    // 模型发现：**显式回答**该 provider 有没有「不依赖本机客户端」的通道（契约强制）。
    // 没有的话必须写 clientFreeReason 说明原因，否则描述符加载失败（2026-10-15 kiro 教训）。
    models: {
      supported: true,
      source: 'cline_static_catalog',
      strategies: [
        {
          id: 'cline-http-models',
          transport: 'http',
          clientDependent: false,
          handler: 'cline-static-catalog', // 实现由组合根注册（lib/server/http-utils.js 的 registerModelDiscoveryHandler）
          description: '静态规范清单（cline-models.js）：不联网、不依赖客户端'
        }
      ]
    },
    quota: {
      supported: true,
      kind: 'cline_pass_usage',
      source: 'cline_plan_usages_api',
      shape: 'entries',
      entryShape: 'window',
      strategies: [
        {
          id: 'cline-plan-usage-limits',
          transport: 'http',
          clientDependent: false,
          probe: (deps) => createProbe(deps),
          description: '/users/me/plan/usage-limits 的服务端 percentUsed + /users/me/plan 的上限（HTTP，不需要本机 cline）'
        }
      ]
    },
    usage: usagePort,
    relay: { transport: 'http', clientDependent: false }
  }
};
