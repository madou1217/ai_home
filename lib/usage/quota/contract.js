'use strict';

// 额度（quota / Remaining）插件契约 —— 叶子模块，只做形状校验，无 I/O。
//
// 背景：额度此前是「原生 provider 各写一支探针 + 合同里声明 quota_usage 能力」的形态，
// 没有原生额度接口的 provider（Cline Pass 是第一个）无处安放。现在所有额度都走
// `lib/usage/quota` 这一层抽象：原生 provider 由注册表登记为 native 源，其余一律以
// **插件**形式实现同一份 `probe()` 契约（内置目录 + 用户插件目录）。
//
// 契约（contractVersion = 1）：
//   id             插件身份（小写，与 provider id 同形）
//   contractVersion 必须等于 QUOTA_PLUGIN_CONTRACT_VERSION
//   providers      该插件负责的 provider id 列表（非空、去重）
//   snapshotKind   产出的快照 kind，**必须已在 USAGE_SNAPSHOT_KINDS 登记**：
//                  否则 usage-remaining 提取不出 remainingPct，快照等于废数据
//   source         快照 source 标识（可信快照校验用，写进 snapshot.source）
//   shape          'entries'（时间窗/余额型）或 'models'（按模型型）
//   createProbe(deps) → { probe(accountRef, timeoutMs) → { snapshot } | { error, auth? } }
//
// probe 约定：**不抛异常**；失败返回 `{ error }`（可带 `auth: true` 表示鉴权类失败），
// 由调用方决定缓存回退策略（与 kimi/zcode/codebuddy 探针一致）。

const { USAGE_SNAPSHOT_KINDS } = require('../../account/usage-remaining');

const QUOTA_PLUGIN_CONTRACT_VERSION = 1;
const QUOTA_PROVIDER_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const QUOTA_SNAPSHOT_SHAPES = Object.freeze(['entries', 'models']);
// 条目语义：window = 滚动时间窗（有 window/windowMinutes/remainingPct，可做「5h: 91%」这类展示）；
// bucket = 余额/积分桶（credits 等，展示走另一套口径）；models = 按模型型（shape='models'）。
const QUOTA_ENTRY_SHAPES = Object.freeze(['window', 'bucket', 'models']);
const QUOTA_PLUGIN_ORIGINS = Object.freeze(['builtin', 'external']);

class QuotaPluginError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'QuotaPluginError';
    this.code = code;
    this.detail = String(detail || '');
  }
}

function quotaPluginError(code, detail) {
  return new QuotaPluginError(code, detail);
}

function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

const KNOWN_SNAPSHOT_KINDS = new Set(Object.values(USAGE_SNAPSHOT_KINDS));

/**
 * 校验并冻结一份额度插件定义。
 * 失败抛 QuotaPluginError（调用方负责记录为可观察的加载错误，绝不静默跳过）。
 * @returns {Readonly<object>} 归一化后的插件定义
 */
function validateQuotaPlugin(definition) {
  if (!isPlainObject(definition)) throw quotaPluginError('quota_plugin_definition_invalid');
  const id = normalizeText(definition.id).toLowerCase();
  if (!QUOTA_PROVIDER_ID_PATTERN.test(id)) throw quotaPluginError('quota_plugin_id_invalid', id);
  const contractVersion = Number(definition.contractVersion);
  if (contractVersion !== QUOTA_PLUGIN_CONTRACT_VERSION) {
    throw quotaPluginError('quota_plugin_contract_version_unsupported', String(definition.contractVersion));
  }
  const providers = [...new Set(
    (Array.isArray(definition.providers) ? definition.providers : [])
      .map((provider) => normalizeText(provider).toLowerCase())
      .filter(Boolean)
  )];
  if (providers.length === 0) throw quotaPluginError('quota_plugin_providers_missing', id);
  for (const provider of providers) {
    if (!QUOTA_PROVIDER_ID_PATTERN.test(provider)) {
      throw quotaPluginError('quota_plugin_provider_id_invalid', provider);
    }
  }
  const snapshotKind = normalizeText(definition.snapshotKind);
  if (!snapshotKind) throw quotaPluginError('quota_plugin_snapshot_kind_missing', id);
  if (!KNOWN_SNAPSHOT_KINDS.has(snapshotKind)) {
    throw quotaPluginError('quota_plugin_snapshot_kind_unregistered', snapshotKind);
  }
  const source = normalizeText(definition.source);
  if (!source) throw quotaPluginError('quota_plugin_source_missing', id);
  const shape = normalizeText(definition.shape) || 'entries';
  if (!QUOTA_SNAPSHOT_SHAPES.includes(shape)) throw quotaPluginError('quota_plugin_shape_invalid', shape);
  const entryShape = normalizeText(definition.entryShape) || 'window';
  if (!QUOTA_ENTRY_SHAPES.includes(entryShape)) throw quotaPluginError('quota_plugin_entry_shape_invalid', entryShape);
  if (typeof definition.createProbe !== 'function') throw quotaPluginError('quota_plugin_create_probe_missing', id);
  return Object.freeze({
    id,
    contractVersion,
    providers: Object.freeze(providers),
    snapshotKind,
    source,
    shape,
    entryShape,
    description: normalizeText(definition.description),
    createProbe: definition.createProbe
  });
}

module.exports = {
  QUOTA_PLUGIN_CONTRACT_VERSION,
  QUOTA_PROVIDER_ID_PATTERN,
  QUOTA_SNAPSHOT_SHAPES,
  QUOTA_ENTRY_SHAPES,
  QUOTA_PLUGIN_ORIGINS,
  QuotaPluginError,
  quotaPluginError,
  validateQuotaPlugin,
  __private: { KNOWN_SNAPSHOT_KINDS, isPlainObject, normalizeText }
};
