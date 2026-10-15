'use strict';

// Go Core 能承接**推理上游**的 Provider 集合。
//
// 真值来源是 Go 的 `core/inference/protocol.go`：那里只有三个 ProviderID 常量
// （codex / claude / agy），上游适配器也只有这三个
// （internal/adapters/{codex/responses, claude/messages, agy/codeassist}）。
// 其余 Provider（gemini / opencode / grok / kimi / kiro / zcode / cline / qoder /
// qodercn / codebuddy 家族四支）在 Go 侧**没有上游**：路由一旦划给 Go 就没有 Node
// 回落，请求只会失败。
//
// 为什么需要显式声明，而不是继续靠「模型不在 Go 目录里」兜：那是**偶然保护**。
// Go 的 /v1/models 只由这三个适配器的 catalog source 组成
// （internal/host/aihserver/composition.go 的 newModelCatalogSources），所以别的
// Provider 的模型今天恰好不在集合里 → 命中 model_not_routable 交还 Node。一旦 Go 的
// 目录来源变化（例如开始同步账号库里的全部模型），这层保护会**静默消失**，而故障
// 表现是「部分模型突然 503」——不是配置报错，排查成本极高。
//
// 漂移守卫：test/go-core-servable-providers.test.js 直接解析 Go 源码里的 ProviderID
// 常量并断言与本集合一致 —— Go 加了第四个 Provider 而这里没跟上，测试会红。
const GO_INFERENCE_PROVIDERS = Object.freeze(['codex', 'claude', 'agy']);

const GO_INFERENCE_PROVIDER_SET = new Set(GO_INFERENCE_PROVIDERS);

/** Go 是否能承接该 Provider 的推理上游（未知 Provider 一律 false）。 */
function goServesInference(provider) {
  return GO_INFERENCE_PROVIDER_SET.has(String(provider || '').trim().toLowerCase());
}

module.exports = {
  GO_INFERENCE_PROVIDERS,
  goServesInference
};
