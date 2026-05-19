'use strict';

const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');

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

// 需求：事件入口必须校验 provider/accountId，避免坏事件污染账号池或持久态。
function normalizeAccountRuntimeEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const provider = normalizeProvider(event.provider);
  const accountId = String(event.accountId || '').trim();
  if (!provider || !accountId) return null;
  return {
    type: ACCOUNT_RUNTIME_CHANGED,
    provider,
    accountId,
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

module.exports = {
  ACCOUNT_RUNTIME_CHANGED,
  normalizeAccountRuntimeEvent,
  isBlockingRuntimeStatus
};
