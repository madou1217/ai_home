'use strict';

// 「Go 能不能服务某个 Provider 的推理」的唯一判定 —— 读声明，不持有名单。
//
// 真值来源是 Go 生成的 `contracts/providers/manifest.json` 的 `relayHosts`（每个 Provider
// 自己声明），经门面 `resolveRelayHost('go', provider, entryId)` 消费。**本模块不再有
// Provider 名单** —— 曾经的三条硬编码常量（GO_CANONICAL_INFERENCE_PROVIDERS /
// GO_RELAY_INFERENCE_PROVIDERS / GO_RELAY_INFERENCE_ENTRIES）已删除。
//
// 为什么当初需要那份名单：Go 的推理上游长期只有 codex / claude / agy 三个 canonical
// 适配器加家族透传。路由一旦划给 Go 就没有 Node 回落，所以 Node 必须在转发前知道
// 「Go 服务不了这个 Provider」并交还自己处理。
//
// 为什么名单必须消失：同一件事在三处硬编码（core/inference/protocol.go 的 ProviderID、
// 本模块的常量、go-import-translator 的翻译表），语义各不相同却当同一件事用。
// 2026-10-17 的 cline 事故正是这个结构的产物 —— cline 不在任何一份名单里，没人知道
// 为什么，而用户的 `claude-*` 别名恰好指向 cline 承载的模型，于是请求被转到 Go 后
// 得到 503 no_available_account（实测），连 Claude Code 的权限分类器都被打挂。
//
// 现在的形态：Provider 自己声明 `relayHosts.go = { supported, channel, entries, reason }`，
// 声明缺失或 supported=false 都必须带 reason（Go 侧 validateRelayHosts 强制）。
// 漂移守卫 test/go-core-servable-providers.test.js 另外盯住「声明了必须有实现」。

const { resolveRelayHost } = require('../providers');

// Go 承接推理的通道名。与 Go 侧 core/providers/model.go 的 RelayChannel* 逐字一致。
const GO_INFERENCE_CHANNEL_CANONICAL = 'canonical';
const GO_INFERENCE_CHANNEL_RELAY = 'relay';

/**
 * 返回 Go 在该入口上承接该 Provider 推理的通道；承接不了返回空串。
 *
 * entryId 缺省时只判 Provider 级：透传是**入口感知**的能力（家族四支只挂在
 * chat completions），不知道入口就不能假设它在任何入口上都存在 —— 保守侧与
 * 「Go 服务不了」一致。
 */
function goInferenceChannel(provider, entryId = '') {
  const resolved = resolveRelayHost('go', provider, entryId);
  return resolved.supported ? resolved.channel : '';
}

/** Go 是否能承接该 Provider 在该入口上的推理上游（未知 Provider/入口一律 false）。 */
function goServesInference(provider, entryId = '') {
  return Boolean(goInferenceChannel(provider, entryId));
}

/** 诊断用：Go 服务不了该 Provider 的原因（声明缺失或显式 unsupported）。 */
function goInferenceUnsupportedReason(provider, entryId = '') {
  const resolved = resolveRelayHost('go', provider, entryId);
  return resolved.supported ? '' : resolved.reason;
}

module.exports = {
  GO_INFERENCE_CHANNEL_CANONICAL,
  GO_INFERENCE_CHANNEL_RELAY,
  goInferenceChannel,
  goServesInference,
  goInferenceUnsupportedReason
};
