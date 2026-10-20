'use strict';

// `provider.descriptor` 收集器 —— 把插件贡献（host RPC 的 JSON 数据）和内置
// `lib/providers/defs/*.js` 统一成 canonical 描述符，再交给 provider 注册表。
//
// 边界：
//   * 插件只提供**数据**；handler 必须引用宿主已注册的 id（见
//     `lib/providers/handler-registry.js`），不能携带函数/路径/凭据；
//   * 单个 provider 描述符校验失败只拒绝该条，其余条目照常收集（errors 可观察）；
//   * 是否写入注册表由调用方决定：候选代次先 `register:false` 校验，提交成功后再
//     用 `replaceOrigin` 整体替换，避免被拒候选污染运行态。

const nodePath = require('node:path');
const nodeFs = require('node:fs');

const { descriptorError, validateProviderDescriptor } = require('../../providers/contract');
const {
  getProviderHandler,
  listMissingProviderHandlers
} = require('../../providers/handler-registry');
const { BUILTIN_DEFS_DIR, listDefinitionFiles } = require('../../providers/loader');

const BUILTIN_PROVIDER_CONTRIBUTION_ID = 'builtin.provider.descriptors';
const PROVIDER_DESCRIPTOR_CAPABILITY = 'provider.descriptor';

function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 外部描述符只能走 JSON：函数/符号/bigint 会在 RPC 边界丢失，必须显式拒绝。 */
function assertProviderDescriptorSerializable(value, path = 'descriptor') {
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw descriptorError('provider_descriptor_not_serializable', `${path}:${typeof value}`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertProviderDescriptorSerializable(entry, `${path}[${index}]`));
    return value;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      assertProviderDescriptorSerializable(entry, `${path}.${key}`);
    }
  }
  return value;
}

function looksLikeDescriptor(value) {
  return isRecord(value)
    && Object.prototype.hasOwnProperty.call(value, 'contractVersion')
    && Object.prototype.hasOwnProperty.call(value, 'id')
    && Object.prototype.hasOwnProperty.call(value, 'capabilities');
}

function normalizeContributionValues(value, depth = 0) {
  if (depth > 4) throw descriptorError('provider_descriptor_contribution_invalid', 'nesting_too_deep');
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.flatMap((entry) => normalizeContributionValues(entry, depth + 1));
  }
  if (!isRecord(value)) throw descriptorError('provider_descriptor_contribution_invalid', typeof value);
  if (value.kind === PROVIDER_DESCRIPTOR_CAPABILITY && Object.prototype.hasOwnProperty.call(value, 'value')) {
    return normalizeContributionValues(value.value, depth + 1);
  }
  if (Array.isArray(value.items)) {
    return value.items.flatMap((item) => normalizeContributionValues(
      item && Object.prototype.hasOwnProperty.call(item, 'value') ? item.value : item,
      depth + 1
    ));
  }
  if (Array.isArray(value.descriptors)) {
    return value.descriptors.flatMap((entry) => normalizeContributionValues(entry, depth + 1));
  }
  if (value.descriptor !== undefined) return normalizeContributionValues(value.descriptor, depth + 1);
  if (looksLikeDescriptor(value)) return [value];
  throw descriptorError('provider_descriptor_contribution_invalid', 'expected_descriptor_or_descriptors');
}

function normalizeError(error) {
  return {
    code: String(error && error.code || 'provider_descriptor_collect_failed'),
    detail: String(error && error.detail || error && error.message || '').slice(0, 240)
  };
}

/**
 * @param {{
 *   registry?: object,
 *   origin?: string,
 *   resolveHandler?: (id: string) => Function|null,
 *   requireSerializable?: boolean,
 *   fs?: object,
 *   path?: object,
 *   requireFn?: Function,
 *   builtinDir?: string
 * }} options
 */
function createProviderDescriptorCollector(options = {}) {
  const origin = normalizeText(options.origin) || 'plugin';
  const resolveHandler = typeof options.resolveHandler === 'function'
    ? options.resolveHandler
    : getProviderHandler;
  const requireSerializable = options.requireSerializable === true || origin !== 'builtin';

  /**
   * 校验贡献项，不写注册表。
   * @returns {Promise<{descriptors: object[], accepted: object[], attempts: object[], errors: object[], origin: string}>}
   */
  async function collect(contributions, collectOptions = {}) {
    const list = Array.isArray(contributions) ? contributions : [contributions].filter(Boolean);
    const descriptors = [];
    const accepted = [];
    const attempts = [];
    const errors = [];
    const seen = new Map();
    for (const contribution of list) {
      const instanceId = normalizeText(contribution && contribution.instanceId)
        || normalizeText(contribution && contribution.owner)
        || '';
      const contributionId = normalizeText(contribution && contribution.id)
        || normalizeText(contribution && contribution.contributionId)
        || '';
      const attempt = { instanceId, id: contributionId, ok: false, descriptors: 0 };
      try {
        let value = contribution;
        if (contribution && typeof contribution.collect === 'function') {
          value = await contribution.collect();
        } else if (contribution && Object.prototype.hasOwnProperty.call(contribution, 'value')) {
          value = contribution.value;
        } else if (contribution && Object.prototype.hasOwnProperty.call(contribution, 'descriptors')) {
          value = { descriptors: contribution.descriptors };
        }
        const rawDescriptors = normalizeContributionValues(value);
        for (const raw of rawDescriptors) {
          if (requireSerializable) assertProviderDescriptorSerializable(raw);
          const descriptor = validateProviderDescriptor(raw);
          const duplicate = seen.get(descriptor.id);
          if (duplicate) {
            throw descriptorError(
              'provider_descriptor_duplicate',
              `${descriptor.id} (already declared by ${duplicate.instanceId || duplicate.id || 'another contribution'})`
            );
          }
          const missing = listMissingProviderHandlers(descriptor, resolveHandler);
          if (missing.length > 0) {
            throw descriptorError('provider_descriptor_handler_unavailable', `${descriptor.id}: ${missing.join(', ')}`);
          }
          seen.set(descriptor.id, { instanceId, id: contributionId });
          descriptors.push(descriptor);
          accepted.push({ descriptor, instanceId, contributionId, origin });
        }
        attempt.ok = true;
        attempt.descriptors = rawDescriptors.length;
      } catch (error) {
        attempt.error = normalizeError(error).code;
        errors.push({
          ...normalizeError(error),
          instanceId,
          contributionId
        });
      }
      attempts.push(attempt);
    }
    const result = { origin, descriptors, accepted, attempts, errors };
    if (options.registry && collectOptions.register !== false) {
      const replaced = options.registry.replaceOrigin(origin, descriptors, {
        onError: (error) => errors.push({ ...error, instanceId: '', contributionId: '' })
      });
      result.registered = replaced.registered;
    }
    return result;
  }

  return { origin, collect };
}

/** 内置 defs 作为「内置 provider 插件」的贡献项（数据形状与外部插件一致）。 */
function collectBuiltinProviderDescriptors(options = {}) {
  const fs = options.fs || nodeFs;
  const path = options.path || nodePath;
  const requireFn = typeof options.requireFn === 'function' ? options.requireFn : require;
  const builtinDir = options.builtinDir || BUILTIN_DEFS_DIR;
  const descriptors = [];
  const errors = [];
  for (const file of listDefinitionFiles(builtinDir, fs)) {
    try {
      let value = requireFn(file);
      if (value && typeof value === 'object' && value.default) value = value.default;
      const entries = Array.isArray(value) ? value : [value];
      for (const raw of entries) {
        descriptors.push(validateProviderDescriptor(raw));
      }
    } catch (error) {
      errors.push({ ...normalizeError(error), target: path.basename(file) });
    }
  }
  return { descriptors, errors };
}

/** 可直接交给 `collect()` / host RPC 的内置贡献项（只含数据，不含 handler 实现）。 */
function createBuiltinProviderDescriptorContribution(options = {}) {
  const collected = collectBuiltinProviderDescriptors(options);
  return {
    id: BUILTIN_PROVIDER_CONTRIBUTION_ID,
    instanceId: 'builtin.providers',
    capability: PROVIDER_DESCRIPTOR_CAPABILITY,
    origin: 'builtin',
    descriptors: collected.descriptors,
    errors: collected.errors
  };
}

module.exports = {
  BUILTIN_PROVIDER_CONTRIBUTION_ID,
  PROVIDER_DESCRIPTOR_CAPABILITY,
  assertProviderDescriptorSerializable,
  normalizeContributionValues,
  createProviderDescriptorCollector,
  collectBuiltinProviderDescriptors,
  createBuiltinProviderDescriptorContribution,
  __private: { looksLikeDescriptor }
};
