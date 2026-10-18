'use strict';

// opencode 免费模型的判定 —— 网关里「哪些模型走免费档」的单一来源。
//
// 规则（不写死任何模型名单）：
//   1. 裸模型名以 `-free` 结尾（Zen/Go 两套目录的命名约定）；
//   2. 或者 models.dev 目录里 Zen（`opencode`）provider 给它标的价格是 0 —— opencode 自己
//      在选模型界面标 "Free" 看的也是价格。`big-pickle` 不带后缀但免费：只认后缀时它被当成
//      付费 Go 模型，报 invalid_opencode_go_api_key（2026-10-18）。
// 显式带 Go 命名空间（`opencode-go/`、`go/`）的请求是点名要付费通道，第 2 条不适用。

const { createModelsDevReader } = require('./models-dev-metadata');
const { __private: { stripOpenCodeGoModelPrefix } } = require('./opencode-server-client');

const ZEN_PROVIDER_ID = 'opencode';
const GO_NAMESPACE_RE = /^(opencode-go|go)\//i;

let sharedReader = null;

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getSharedReader() {
  if (!sharedReader) sharedReader = createModelsDevReader();
  return sharedReader;
}

/** 裸模型名（去掉 opencode-go/ opencode/ zen/ go/ 前缀）。 */
function bareOpenCodeModelId(model) {
  return normalizeString(stripOpenCodeGoModelPrefix(normalizeString(model)));
}

function hasZeroZenCost(bare, reader) {
  const metadata = reader.resolveEntry({ id: `${ZEN_PROVIDER_ID}/${bare}`, provider: ZEN_PROVIDER_ID });
  // 只认 Zen provider 自己的条目：基座模型的通用条目不代表它在 Zen 上的价格。
  if (!metadata || metadata.providerId !== ZEN_PROVIDER_ID || !metadata.cost) return false;
  return metadata.cost.input === 0 && metadata.cost.output === 0;
}

function isOpenCodeFreeModelId(model, deps = {}) {
  const raw = normalizeString(model);
  const bare = bareOpenCodeModelId(raw);
  if (!bare) return false;
  if (bare.toLowerCase().endsWith('-free')) return true;
  if (GO_NAMESPACE_RE.test(raw)) return false;
  return hasZeroZenCost(bare, deps.modelsDevReader || getSharedReader());
}

module.exports = {
  bareOpenCodeModelId,
  isOpenCodeFreeModelId
};
