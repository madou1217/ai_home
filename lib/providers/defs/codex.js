'use strict';

const REGION_POLICIES = require('./_shared/region-policies');
const { goOwnedModels } = require('../model-ownership');

// codex 的能力自描述（provider 描述符契约 v1，见 lib/providers/contract.js）。
//
// 新增或修改这个 provider 的能力**只改这个文件**：注册表按能力建倒排索引
// （lib/providers/registry.js），消费方问能力名而不是认 provider 名，
// 因此不存在需要同步维护的 provider 清单。
//
// 额度实现：原生 handler `codex`（组合根提供）；展示端口：lib/usage/provider-usage/codex.js。
const usagePort = require('../../usage/provider-usage/codex');

module.exports = {
  contractVersion: 1,
  id: 'codex',
  capabilities: {
    // 模型发现：**显式回答**该 provider 有没有「不依赖本机客户端」的通道（契约强制）。
    // 没有的话必须写 clientFreeReason 说明原因，否则描述符加载失败（2026-10-15 kiro 教训）。
    // 模型发现：codex 原生 /models 目录由 Go 产出（adapters/codex/responses），Node 只读。
    models: goOwnedModels('codex'),
    quota: {
      supported: true,
      kind: 'codex_oauth_status',
      source: 'codex_app_server',
      shape: 'entries',
      entryShape: 'window',
      strategies: [
        {
          id: 'codex-http',
          transport: 'http',
          clientDependent: false,
          clientOptional: true,
          handler: 'codex',
          description: '直连 HTTP 优先，失败才回退本机 codex app-server（阶梯在 handler 内，故可能读客户端版本）'
        }
      ]
    },
    hooks: {
      supported: true,
      adapter: 'json_hooks',
      target: ['.codex', 'hooks.json'],
      // codex 的 SessionStart matcher 只在会话真正开始/恢复时才触发。
      eventMatchers: { SessionStart: 'startup|resume|clear|compact' },
      // codex 的 hooks 还要在 config.toml 里打开特性开关（其它 provider 没有这一步）。
      featureFlag: true
    },
    usage: usagePort,
    relay: { transport: 'http', clientDependent: false },
    // 官方上游的地区策略：只是提示，实测可推翻（数据与出处见 _shared/region-policies.js）。
    egress: { regionPolicy: REGION_POLICIES.OPENAI }
  }
};
