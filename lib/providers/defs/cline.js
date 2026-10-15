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
