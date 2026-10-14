'use strict';

// 「窗口激活」的领域持久化层：记住每个账号是否开启、自定义间隔，以及上次探测时间。
//
// 背景见 lib/server/window-activation-scheduler.js：对 5 小时滚动窗口类账号定期发一个
// 极小探测以推进窗口。本文件只做读写与形状校验，不解析窗口、不触发探测、不碰启动流程。
//
// 存储沿用 account:usage:<accountRef> / account:egress:<accountRef> 的既有命名惯例，
// 落在 app_kv（lib/server/app-state-store.js）。
//   account:window-activation:<ref>        配置：{ enabled, intervalMs, updatedAt }
//   account:window-activation-state:<ref>  状态：{ lastProbeAt, lastOutcome, updatedAt }

const {
  deleteJsonValue,
  readJsonValue,
  writeJsonValue
} = require('../server/app-state-store');
const {
  isAccountRef,
  resolveAccountRef
} = require('../server/account-ref-store');
const { isKnownProvider } = require('../provider-catalog');

function normalizeAccountRef(accountRef) {
  const value = String(accountRef || '').trim();
  return isAccountRef(value) ? value : '';
}

function buildWindowActivationConfigKey(accountRef) {
  const normalizedRef = normalizeAccountRef(accountRef);
  return normalizedRef ? `account:window-activation:${normalizedRef}` : '';
}

function buildWindowActivationStateKey(accountRef) {
  const normalizedRef = normalizeAccountRef(accountRef);
  return normalizedRef ? `account:window-activation-state:${normalizedRef}` : '';
}

function normalizeUpdatedAt(value) {
  const updatedAt = Number(value);
  return Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0;
}

function normalizePositiveMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : null;
}

/**
 * 归一化配置记录。缺省（未配置）时上层按「关闭 + 全局默认间隔」处理；这里只把
 * 显式存下来的形状理清，intervalMs 为 null 表示「跟随全局默认」。
 *
 * @returns {{enabled: boolean, intervalMs: number|null, updatedAt: number}|null}
 */
function normalizeWindowActivationConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return {
    enabled: raw.enabled === true,
    intervalMs: normalizePositiveMs(raw.intervalMs),
    updatedAt: normalizeUpdatedAt(raw.updatedAt)
  };
}

/**
 * @returns {{lastProbeAt: number, lastOutcome: string, updatedAt: number}|null}
 */
function normalizeWindowActivationState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const lastProbeAt = Number(raw.lastProbeAt);
  return {
    lastProbeAt: Number.isFinite(lastProbeAt) && lastProbeAt > 0 ? Math.floor(lastProbeAt) : 0,
    lastOutcome: typeof raw.lastOutcome === 'string' ? raw.lastOutcome.trim() : '',
    updatedAt: normalizeUpdatedAt(raw.updatedAt)
  };
}

/**
 * @returns {config|null} 仅在确实没有记录时返回 null；损坏记录必须抛错，
 *   让上层把账号当「未配置」而不是静默当成默认值。
 */
function readWindowActivationConfig(fs, aiHomeDir, accountRef) {
  const key = buildWindowActivationConfigKey(accountRef);
  if (!key) return null;
  const stored = readJsonValue(fs, aiHomeDir, key, { strict: true });
  if (stored === null) return null;
  const config = normalizeWindowActivationConfig(stored);
  if (!config) throw new Error('invalid_window_activation_config_record');
  return config;
}

/**
 * 写入配置；config 为 null 时删除（等价于恢复默认）。
 * 非空非法记录必须拒绝，不能把调用方错误静默解释为删除。
 *
 * @returns {boolean} true 表示已写入或已删除
 */
function writeWindowActivationConfig(fs, aiHomeDir, accountRef, config, now = Date.now()) {
  const normalizedRef = normalizeAccountRef(accountRef);
  const account = normalizedRef
    ? resolveAccountRef(fs, aiHomeDir, normalizedRef, { bestEffort: true })
    : null;
  if (!account || !isKnownProvider(account.provider)) {
    throw new Error('invalid_window_activation_account');
  }
  const key = buildWindowActivationConfigKey(normalizedRef);
  if (config === null || config === undefined) {
    deleteJsonValue(fs, aiHomeDir, key);
    return true;
  }
  const normalized = normalizeWindowActivationConfig(config);
  if (!normalized) throw new Error('invalid_window_activation_config');
  if (!writeJsonValue(fs, aiHomeDir, key, { ...normalized, updatedAt: now })) {
    throw new Error('window_activation_config_write_failed');
  }
  return true;
}

function readWindowActivationState(fs, aiHomeDir, accountRef) {
  const key = buildWindowActivationStateKey(accountRef);
  if (!key) return null;
  const stored = readJsonValue(fs, aiHomeDir, key, { strict: true });
  if (stored === null) return null;
  return normalizeWindowActivationState(stored);
}

/**
 * 写入状态（上次探测时间）。状态是尽力而为的诊断/防抖数据，损坏时读侧返回 null，
 * 这里仍要求形状合法，避免把垃圾写进去。
 */
function writeWindowActivationState(fs, aiHomeDir, accountRef, state, now = Date.now()) {
  const key = buildWindowActivationStateKey(accountRef);
  if (!key) return false;
  const normalized = normalizeWindowActivationState(state);
  if (!normalized) throw new Error('invalid_window_activation_state');
  return writeJsonValue(fs, aiHomeDir, key, { ...normalized, updatedAt: now });
}

function deleteWindowActivationConfig(fs, aiHomeDir, accountRef) {
  const key = buildWindowActivationConfigKey(accountRef);
  return key ? deleteJsonValue(fs, aiHomeDir, key) : false;
}

module.exports = {
  buildWindowActivationConfigKey,
  buildWindowActivationStateKey,
  deleteWindowActivationConfig,
  normalizeWindowActivationConfig,
  normalizeWindowActivationState,
  readWindowActivationConfig,
  readWindowActivationState,
  writeWindowActivationConfig,
  writeWindowActivationState
};
