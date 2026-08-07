'use strict';

const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');
const { isAccountRef } = require('./account-ref-store');

const ACCOUNT_RUNTIME_CHANGED = 'account.runtime.changed';
const BLOCKING_RUNTIME_STATUSES = new Set([
  'auth_invalid',
  'rate_limited',
  'overloaded',
  'transient_network',
  'service_unavailable',
  'upstream_error',
  'cooling_down'
]);

function normalizeProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  return SUPPORTED_SERVER_PROVIDERS.includes(provider) ? provider : '';
}

// 需求：事件入口必须校验 provider/accountRef，避免坏事件污染账号池或持久态。
function normalizeAccountRuntimeEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const provider = normalizeProvider(event.provider);
  const accountRef = String(event.accountRef || '').trim();
  if (!provider || !isAccountRef(accountRef)) return null;
  return {
    type: ACCOUNT_RUNTIME_CHANGED,
    provider,
    accountRef,
    previousStatus: String(event.previousStatus || '').trim() || 'unknown',
    nextStatus: String(event.nextStatus || '').trim() || 'unknown',
    reason: String(event.reason || '').trim(),
    source: String(event.source || '').trim() || 'unknown',
    runtimeState: event.runtimeState == null ? null : event.runtimeState,
    baseState: event.baseState && typeof event.baseState === 'object' ? event.baseState : {},
    reloadPool: event.reloadPool === true,
    happenedAt: Number.isFinite(Number(event.happenedAt)) ? Number(event.happenedAt) : Date.now()
  };
}

// 需求：集中定义哪些运行态会让账号暂时离开可调度池，避免各 listener 自己发明判断。
function isBlockingRuntimeStatus(status) {
  return BLOCKING_RUNTIME_STATUSES.has(String(status || '').trim());
}

// 「暂时不可调度」和「模型目录不可信」是两回事：
// 限流/过载/网络抖动只说明现在别打这个账号，它有哪些模型一个字都没变；
// 只有认证失效才可能真的改变账号能看到的模型目录，值得把目录作废重扫。
// 混为一谈的代价：一次 429 清空全量模型目录，别名预检随后把正常目标判成
// alias_target_model_not_in_catalog，客户端拿到一个凭空捏造的 503。
const CATALOG_INVALIDATING_RUNTIME_STATUSES = new Set(['auth_invalid']);

function isCatalogInvalidatingRuntimeStatus(status) {
  return CATALOG_INVALIDATING_RUNTIME_STATUSES.has(String(status || '').trim());
}

module.exports = {
  ACCOUNT_RUNTIME_CHANGED,
  normalizeAccountRuntimeEvent,
  isBlockingRuntimeStatus,
  isCatalogInvalidatingRuntimeStatus
};
