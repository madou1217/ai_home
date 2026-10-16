'use strict';

// Go Core 能承接**推理上游**的 Provider/入口表（两条通道）。
//
//  - canonical：Go 有完整上游适配器（codex / claude / agy），模型还必须出现在 Go 的
//    路由目录里（交还判定另外检查）。真值来源是 Go 的 `core/inference/protocol.go`
//    的 ProviderID 常量；漂移守卫 test/go-core-servable-providers.test.js 会解析比对。
//  - relay：Go 的家族透传通道（internal/transport/http/codebuddyfamilyrelay，
//    CodeBuddy / WorkBuddy 四支），按账号原生登录态直连家族官方端点，不依赖 Go 的
//    canonical 路由目录。透传只挂在 chat completions 一个入口上（Go 的 router.go
//    挂载点，守卫测试盯着这个挂载），所以家族的能力判定必须带 entryId。
//
// 其余 Provider（gemini / opencode / grok / kimi / kiro / zcode / cline / qoder /
// qodercn 等）在 Go 侧**没有上游**：路由一旦划给 Go 就没有 Node 回落，请求只会失败。
//
// 为什么需要显式声明，而不是继续靠「模型不在 Go 目录里」兜：那是**偶然保护**。
// Go 的 /v1/models 只由它的 catalog source 组成，别的 Provider 的模型今天恰好不在
// 集合里 → 命中 model_not_routable 交还 Node。一旦 Go 的目录来源变化，这层保护会
// **静默消失**，而故障表现是「部分模型突然 503」——不是配置报错，排查成本极高。
const GO_CANONICAL_INFERENCE_PROVIDERS = Object.freeze(['codex', 'claude', 'agy']);

// 家族透传通道当前唯一挂载的入口。新增挂载点时必须同步这里，否则 Node 会把它当
// 「Go 服务不了」而整体交还（安全侧），或反过来在没挂载的入口上误转发。
const GO_RELAY_INFERENCE_ENTRIES = Object.freeze(['gateway.openai.chat_completions']);

const { FAMILY_PROVIDERS } = require('../runtime/codebuddy-family-layouts');

// 家族透传集合直接派生自唯一的家族名单（lib/runtime/codebuddy-family-layouts.js）；
// 漂移守卫 test/codebuddy-family-identity.test.js 禁止 lib/ 下出现第二份家族名单
// （名单手写在这里会被判红），test/go-core-servable-providers.test.js 另外盯住它与
// Go 的 codebuddyfamilyrelay.FamilyProviders 逐项一致。
const GO_RELAY_INFERENCE_PROVIDERS = Object.freeze([...FAMILY_PROVIDERS]);

const GO_CANONICAL_INFERENCE_PROVIDER_SET = new Set(GO_CANONICAL_INFERENCE_PROVIDERS);
const GO_RELAY_INFERENCE_PROVIDER_SET = new Set(GO_RELAY_INFERENCE_PROVIDERS);
const GO_RELAY_INFERENCE_ENTRY_SET = new Set(GO_RELAY_INFERENCE_ENTRIES);

// Go 承接推理的通道名（交还判定按通道分流：透传不看 Go 目录，canonical 要看）。
const GO_INFERENCE_CHANNEL_CANONICAL = 'canonical';
const GO_INFERENCE_CHANNEL_RELAY = 'relay';

/**
 * 返回 Go 在该入口上承接该 Provider 推理的通道；承接不了返回空串。
 *
 * entryId 缺省时只按 canonical 判定：透传是入口感知的能力，不知道入口就不能假设它
 * 在任何入口上都存在（保守侧与「Go 服务不了」一致）。
 */
function goInferenceChannel(provider, entryId = '') {
  const normalized = String(provider || '').trim().toLowerCase();
  if (GO_CANONICAL_INFERENCE_PROVIDER_SET.has(normalized)) {
    return GO_INFERENCE_CHANNEL_CANONICAL;
  }
  const entry = String(entryId || '').trim();
  if (GO_RELAY_INFERENCE_PROVIDER_SET.has(normalized) && GO_RELAY_INFERENCE_ENTRY_SET.has(entry)) {
    return GO_INFERENCE_CHANNEL_RELAY;
  }
  return '';
}

/** Go 是否能承接该 Provider 在该入口上的推理上游（未知 Provider/入口一律 false）。 */
function goServesInference(provider, entryId = '') {
  return Boolean(goInferenceChannel(provider, entryId));
}

module.exports = {
  GO_CANONICAL_INFERENCE_PROVIDERS,
  GO_RELAY_INFERENCE_PROVIDERS,
  GO_RELAY_INFERENCE_ENTRIES,
  GO_INFERENCE_CHANNEL_CANONICAL,
  GO_INFERENCE_CHANNEL_RELAY,
  goInferenceChannel,
  goServesInference
};
