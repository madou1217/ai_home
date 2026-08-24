'use strict';

// ZCode 账号出口绑定的领域持久化层。
//
// 背景：客户端会把 code 1005 映射成「今日免费计划额度已用完」，但余额快照并不能
// 解释该拒绝。外部使用经验表明更换出口 IP 可以解除部分同类故障，因此提供账号级
// 出口作为独立的第二层验证/规避手段；这不把 IP 维度冒充成已经证明的唯一根因。
// 本模块只负责记住「ZCode 账号 → 出口」绑定。
//
// 存储沿用 account:usage:<accountRef> 的既有命名惯例，落在 app_kv。
// 本文件只做读写与形状校验，不解析代理、不碰启动流程。

const {
  deleteJsonValue,
  readJsonValue,
  writeJsonValue
} = require('../server/app-state-store');
const {
  isAccountRef,
  resolveAccountRef
} = require('../server/account-ref-store');

const EGRESS_MODE_URL = 'url';
const EGRESS_MODE_SYSTEM = 'system';
const EGRESS_MODE_TUN = 'tun';
const EGRESS_MODE_NODE = 'node';
const EGRESS_MODE_GROUP = 'group';
// 仅用于读取历史记录和兼容旧调用方；新记录统一写成 node。
const EGRESS_MODE_POOL = 'pool';
const EGRESS_MODES = new Set([
  EGRESS_MODE_SYSTEM,
  EGRESS_MODE_TUN,
  EGRESS_MODE_URL,
  EGRESS_MODE_NODE,
  EGRESS_MODE_GROUP
]);

function normalizeAccountRef(accountRef) {
  const value = String(accountRef || '').trim();
  return isAccountRef(value) ? value : '';
}

function buildEgressBindingKey(accountRef) {
  const normalizedRef = normalizeAccountRef(accountRef);
  return normalizedRef ? `account:egress:${normalizedRef}` : '';
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 归一化绑定记录。各模式都保留其它目标字段：用户在 WebUI 切换来源时不丢输入。
 * 历史 pool 模式在读边界迁移为 node，避免把具体协议核心泄漏到账号领域。
 *
 * @param {any} raw
 * @returns {{mode: string, proxyUrl: string, nodeId: string, groupId: string, updatedAt: number}|null}
 */
function normalizeEgressBinding(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const proxyUrl = normalizeText(raw.proxyUrl);
  const nodeId = normalizeText(raw.nodeId);
  const groupId = normalizeText(raw.groupId);
  const rawMode = normalizeText(raw.mode).toLowerCase();
  const declaredMode = rawMode === EGRESS_MODE_POOL ? EGRESS_MODE_NODE : rawMode;
  if (declaredMode && !EGRESS_MODES.has(declaredMode)) return null;
  const mode = declaredMode || (proxyUrl
    ? EGRESS_MODE_URL
    : (nodeId ? EGRESS_MODE_NODE : (groupId ? EGRESS_MODE_GROUP : '')));
  if (!mode) return null;
  if (mode === EGRESS_MODE_URL && !proxyUrl) return null;
  if (mode === EGRESS_MODE_NODE && !nodeId) return null;
  if (mode === EGRESS_MODE_GROUP && !groupId) return null;
  const updatedAt = Number(raw.updatedAt);
  return {
    mode,
    proxyUrl,
    nodeId,
    groupId,
    updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : 0
  };
}

/**
 * @returns {{mode: string, proxyUrl: string, nodeId: string, updatedAt: number}|null}
 *   仅在确实没有记录时返回 null；损坏记录必须抛错，让启动链保留现有原生设置。
 */
function readAccountEgressBinding(fs, aiHomeDir, accountRef) {
  const key = buildEgressBindingKey(accountRef);
  if (!key) return null;
  const stored = readJsonValue(fs, aiHomeDir, key, { strict: true });
  if (stored === null) return null;
  const binding = normalizeEgressBinding(stored);
  if (!binding) throw new Error('invalid_account_egress_binding_record');
  return binding;
}

/**
 * 写入绑定；只有 binding 为空时删除该账号的绑定（等价于解绑）。非空非法记录
 * 必须拒绝，不能把调用方错误静默解释为删除。
 *
 * @returns {boolean} true 表示已写入或已删除
 */
function writeAccountEgressBinding(fs, aiHomeDir, accountRef, binding, now = Date.now()) {
  const normalizedRef = normalizeAccountRef(accountRef);
  const account = normalizedRef
    ? resolveAccountRef(fs, aiHomeDir, normalizedRef, { bestEffort: true })
    : null;
  if (!account || String(account.provider || '').trim().toLowerCase() !== 'zcode') {
    throw new Error('invalid_zcode_egress_account');
  }
  const key = buildEgressBindingKey(normalizedRef);
  if (binding === null || binding === undefined) {
    deleteJsonValue(fs, aiHomeDir, key);
    return true;
  }
  const normalized = normalizeEgressBinding(binding);
  if (!normalized) throw new Error('invalid_account_egress_binding');
  if (!writeJsonValue(fs, aiHomeDir, key, { ...normalized, updatedAt: now })) {
    throw new Error('account_egress_binding_write_failed');
  }
  return true;
}

function deleteAccountEgressBinding(fs, aiHomeDir, accountRef) {
  const key = buildEgressBindingKey(accountRef);
  return key ? deleteJsonValue(fs, aiHomeDir, key) : false;
}

module.exports = {
  EGRESS_MODE_GROUP,
  EGRESS_MODE_NODE,
  EGRESS_MODE_POOL,
  EGRESS_MODE_SYSTEM,
  EGRESS_MODE_TUN,
  EGRESS_MODE_URL,
  buildEgressBindingKey,
  deleteAccountEgressBinding,
  normalizeEgressBinding,
  readAccountEgressBinding,
  writeAccountEgressBinding
};
