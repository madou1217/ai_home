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
    // 推理通道：OAuth 计划账号与 API Key 账号都走 HTTP（不依赖本机客户端）。
    // 推理端点是上游客户端配置里的 builtin:zai-coding-plan.baseUrl
    // （见 provider-api-base-url.js 的 ZCODE_PLAN_ANTHROPIC_BASE_URL 与实测对照）。
    //
    // **凭据形态按套餐类型分叉**（逆向桌面端 AccountProviderRequestAuthService 得到）：
    //   planKind === 'start-plan'                 → 直接用 zcodeJwtToken 作 apiKey
    //   planKind === 'individual-coding-plan'     → 用 access_token 换 Project Access Token
    // 用错形态会被上游以「凭据不对」拒绝；若再叠加错误端点，会伪装成 3012 风控。
    // 本描述符只声明「需要按凭据形态解析」，具体形态由 resolver 按套餐判定。
    relay: {
      transport: 'http',
      clientDependent: false,
      auth: {
        kind: 'business_token',
        loginUrl: 'https://api.z.ai/api/auth/z/login',
        // start-plan 用长期 jwt 直通；换取仅对 coding-plan 生效。
        jwtPlanKinds: ['start-plan'],
        // start-plan 的模型请求还需**阿里云无痕验证参数**，否则上游返回
        // 405 code:3012（那是「缺验证参数」，不是风控封禁）。
        // 逆向依据：桌面端 requiresRequestVerification =
        //   access.mode==='start-plan' && captcha.enabled && !captcha.skipModelRequest。
        // 参数由 lib/server/request-verification-provider.js 解算并缓存
        // （与「领臭鸡蛋」共用同一解算器）。
        requestVerification: {
          planKinds: ['start-plan'],
          configUrl: 'https://zcode.z.ai/api/v1/client/configs'
        }
      }
    },
    // 账号出口：地址写进原生 setting.json 的 `httpProxy` 字段，该字段对 socks 的语义未经取证
    // （本机未装 ZCode 可验），只接受 HTTP(S)，保存时就明确报错，不写进一个无法验证的字段。
    egress: {
      proxySchemes: ['http:', 'https:'],
      reason: 'ZCode 原生 setting.json 的 httpProxy 字段只确认支持 HTTP(S) 代理'
    },
    // 模型命名空间前缀：本 provider 的目录登记的是**裸** id（`glm-5.3`），但客户端会用
    // `zcode/glm-5.3` 这种带 provider 前缀的写法（与 `x-provider: zcode` 等价的显式归属）。
    // 声明后该写法被解析成裸 id 并**锁定本 provider**，避开「前缀 id 查不到账号」的 503。
    // 不声明的 provider 行为不变（见 lib/server/provider-model-prefix.js）。
    // aliases 是同一个 provider 的历史/上游别名：Z.ai 侧的代码与账号属地一直叫 zai。
    providerModelPrefix: {
      supported: true,
      aliases: ['zai']
    },
    // 账号活动：周末/试用套餐领取（ZCode「臭鸡蛋」）。活动窗口外 preview 返回空列表，
    // 动作本身仍可执行（结果 = nothing_claimable），由 WebUI / CLI 如实显示。
    activity: {
      supported: true,
      actions: [
        {
          id: 'trial_plan',
          label: '领臭鸡蛋',
          handler: 'zcode-plan-claim',
          description: '活动窗口开放时可领；领取需要本机 Chrome 完成阿里云无痕验证'
        }
      ]
    }
  }
};
