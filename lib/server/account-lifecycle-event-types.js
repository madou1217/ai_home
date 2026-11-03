'use strict';

const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');
const { isAccountRef } = require('./account-ref-store');

// 账号生命周期事件：只描述「配置层发生了什么」这一事实，不携带命令语义。
// 运行态（auth_invalid / rate_limited / 恢复）继续走 ACCOUNT_RUNTIME_CHANGED，
// 两者刻意分开：运行态会自行恢复，生命周期动作由人或导入流程发起。
const ACCOUNT_LIFECYCLE_CHANGED = 'account.lifecycle.changed';
const ACCOUNT_LIFECYCLE_ACTIONS = Object.freeze([
  'added',
  'imported',
  'updated',
  'deleted',
  'enabled',
  'disabled'
]);
const ACCOUNT_LIFECYCLE_ACTION_SET = new Set(ACCOUNT_LIFECYCLE_ACTIONS);

function normalizeProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  return SUPPORTED_SERVER_PROVIDERS.includes(provider) ? provider : '';
}

function normalizeText(value) {
  return String(value == null ? '' : value).trim();
}

// 事件会流经所有监听者，包括将来的 WebUI 推送与日志；只放白名单字段，
// 任何凭据/令牌/账号密文都不允许进入事件对象。
function sanitizeAccountSnapshot(value) {
  if (!value || typeof value !== 'object') return {};
  const snapshot = {};
  if (typeof value.enabled === 'boolean') snapshot.enabled = value.enabled;
  const status = normalizeText(value.status);
  if (status) snapshot.status = status;
  const authMode = normalizeText(value.authMode);
  if (authMode) snapshot.authMode = authMode;
  const modelCount = Number(value.modelCount);
  if (Number.isFinite(modelCount) && modelCount >= 0) snapshot.modelCount = Math.trunc(modelCount);
  return snapshot;
}

function normalizeAccountLifecycleEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const provider = normalizeProvider(event.provider);
  const accountRef = normalizeText(event.accountRef);
  const action = normalizeText(event.action).toLowerCase();
  if (!provider || !isAccountRef(accountRef) || !ACCOUNT_LIFECYCLE_ACTION_SET.has(action)) {
    return null;
  }
  const batchId = normalizeText(event.batchId);
  return {
    type: ACCOUNT_LIFECYCLE_CHANGED,
    action,
    provider,
    accountRef,
    source: normalizeText(event.source) || 'unknown',
    reason: normalizeText(event.reason),
    before: sanitizeAccountSnapshot(event.before),
    after: sanitizeAccountSnapshot(event.after),
    ...(batchId ? { batchId } : {}),
    happenedAt: Number.isFinite(Number(event.happenedAt)) ? Number(event.happenedAt) : Date.now()
  };
}

// 从运行态/配置态提炼「这个账号现在是否参与调度」，供监听者做去抖与目录口径判断。
function isLifecycleEventForAction(event, actions) {
  if (!event || event.type !== ACCOUNT_LIFECYCLE_CHANGED) return false;
  if (!actions) return true;
  const allowed = Array.isArray(actions) ? actions : [actions];
  return allowed.includes(event.action);
}

module.exports = {
  ACCOUNT_LIFECYCLE_ACTIONS,
  ACCOUNT_LIFECYCLE_CHANGED,
  isLifecycleEventForAction,
  normalizeAccountLifecycleEvent,
  sanitizeAccountSnapshot
};
