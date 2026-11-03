'use strict';

// opencode「工具类轮次」的免费模型代答：账号没有付费凭据时，opencode 自己发起的内部轮次
// （标题 / 摘要）改由一个免费模型回答。
//
// 为什么需要（2026-10-19 真机）：用户在 opencode 里选的是免费模型，但 opencode 生成会话
// 标题等内部任务时会自动挑 Zen 目录里的「小模型」（实测 `gpt-6-luna`，付费：0.1/0.5）。
// 免费账号没有 Zen/Go 付费 key，这类请求在付费通道上必然失败（invalid_opencode_go_api_key，
// 一天 97 次），会话标题因此永远生成不出来，日志里也全是假的「账号失败」。
//
// 判定刻意收窄，只覆盖「模型不是用户点名的」那一类：
//   - 请求来自真实 opencode 客户端（opencode-native-client）；
//   - 请求不带工具 —— opencode 的主对话轮次总带 read/edit 等工具，工具类内部轮次不带；
//   - 请求的模型不是免费模型；
//   - 该账号解析不到付费凭据（有付费 key 时照常走付费通道，行为不变）。
// 用户自己点名的付费模型（带工具的主对话轮次）不会被偷换，照常报缺凭据。
// 代答时在响应头 `x-aih-model-fallback` 与请求日志里留痕（见免费 HTTP transport）。

const { isOpenCodeFreeModelId } = require('./opencode-free-models');
const { __private: { resolveOpenCodeGoApiKey } } = require('./opencode-server-client');

function hasTools(requestJson) {
  return Array.isArray(requestJson && requestJson.tools) && requestJson.tools.length > 0;
}

function isOpenCodeUtilityTurnWithoutPaidCredential(ctx = {}, deps = {}) {
  if (String(ctx.provider || '').trim().toLowerCase() !== 'opencode') return false;
  if (!(ctx.requestMeta && ctx.requestMeta.openCodeNativeClient)) return false;
  const requestJson = ctx.requestJson || {};
  const model = String(requestJson.model || '').trim();
  if (!model || hasTools(requestJson)) return false;
  const isFree = typeof deps.isFreeModel === 'function' ? deps.isFreeModel : isOpenCodeFreeModelId;
  if (isFree(model)) return false;
  const resolveKey = typeof deps.resolvePaidKey === 'function' ? deps.resolvePaidKey : resolveOpenCodeGoApiKey;
  const options = ctx.options || {};
  const key = resolveKey(options, ctx.account || {}, {
    fs: deps.fs,
    aiHomeDir: (ctx.deps && ctx.deps.aiHomeDir) || options.aiHomeDir
  });
  return !key;
}

module.exports = {
  isOpenCodeUtilityTurnWithoutPaidCredential
};
