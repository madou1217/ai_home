'use strict';

// 模型目录归属的**唯一真值源**（与 lib/providers/quota-ownership.js 同构）。
//
// 迁移期每把一个 Provider 的模型发现搬到 Go，就要删掉它的 Node 探测策略；如果
// 各家描述符各写一份「读 Go」策略，形状会漂移（有人写 transport:http、有人忘了
// 声明 handler），守卫也无从校验。收敛到这里后：
//   * 新增 Go 接管的 Provider 只改 GO_MODEL_OWNERS 一处；
//   * descriptor 用 goOwnedModels(id) 派生整份 models 能力，不手写策略；
//   * test/model-ownership.test.js 双向校验（表 ↔ descriptor），并锁住
//     「Go 接管 = 没有任何出网/CLI 探测策略」。
//
// 注意：这里声明的是**归属**，不是 supported:false。模型目录仍然可发现（由 Go 发现），
// 所以 supported 保持 true；变化的是唯一策略变成「读 Go 的 account_models」。

/** Go 已接管的模型目录 Provider → Go 适配器（只用于可读文案）。 */
const GO_MODEL_OWNERS = Object.freeze({
  opencode: 'adapters/opencode/modelcatalog（Zen + Go 双腿并集）',
  cline: 'adapters/cline/modelcatalog（静态规范清单）',
  codebuddy: 'adapters/codebuddyfamily/modelcatalog（云端 /v3/config）',
  codebuddycn: 'adapters/codebuddyfamily/modelcatalog（云端 /v3/config）',
  workbuddy: 'adapters/codebuddyfamily/modelcatalog（云端 /v3/config）',
  workbuddycn: 'adapters/codebuddyfamily/modelcatalog（云端 /v3/config）',
  kiro: 'adapters/kiro/modelcatalog（ListAvailableModels V3/V2）',
  qoder: 'adapters/qoder/modelcatalog（WASM 签名 + /api/v2/model/list）',
  qodercn: 'adapters/qoder/modelcatalog（WASM 签名 + /api/v2/model/list）',
  agy: 'adapters/agy/codeassist（fetchAvailableModels）',
  kimi: 'adapters/openaicompat/modelcatalog（/models）',
  grok: 'adapters/openaicompat/modelcatalog（/models，仅 API Key）',
  gemini: 'adapters/gemini/modelcatalog（/v1/models）',
  zcode: 'adapters/zcode/modelcatalog（plan 计费接口）',
  codex: 'adapters/codex/responses（原生 /models）',
  claude: 'adapters/claude/messages（/v1/models）'
});

function normalizeProviderID(id) {
  return String(id || '').trim().toLowerCase();
}

/** 该 Provider 的模型目录是否由 Go 发现。 */
function isGoOwnedModels(providerID) {
  return Object.prototype.hasOwnProperty.call(GO_MODEL_OWNERS, normalizeProviderID(providerID));
}

/**
 * descriptor 的 models 能力：Go 已接管时返回「只读 Go」的单策略链。
 *
 * 不在表里的 Provider 调用它会直接抛错一一把这些 Provider 写成「读 Go」是漏登记，
 * 必须先在表里声明归属。
 */
function goOwnedModels(providerID) {
  const id = normalizeProviderID(providerID);
  const source = GO_MODEL_OWNERS[id];
  if (!source) {
    throw new Error('provider ' + providerID + ' 的模型目录不是 Go 发现，不能用 goOwnedModels');
  }
  return Object.freeze({
    supported: true,
    source: 'go_account_models',
    strategies: Object.freeze([
      Object.freeze({
        // transport 必须是 'local'：Go 是本机服务，这份目录既不出网也不依赖客户端。
        // 门面会让 local 策略在出网解析之前执行，账号出口配置异常也不该拖垮目录读取。
        // 策略 id 必须全局唯一（test/design-pattern-guard.test.js），按 Provider 前缀区分。
        id: id + '-go-account-models',
        transport: 'local',
        clientDependent: false,
        handler: 'go-account-models',
        description: '读 Go 的 account_models（' + id + ' 由 ' + source + ' 发现）；Node 不再探测上游'
      })
    ])
  });
}

module.exports = { GO_MODEL_OWNERS, goOwnedModels, isGoOwnedModels };
