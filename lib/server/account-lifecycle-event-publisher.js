'use strict';

const {
  ACCOUNT_LIFECYCLE_CHANGED,
  ACCOUNT_LIFECYCLE_ACTIONS,
  normalizeAccountLifecycleEvent
} = require('./account-lifecycle-event-types');

function isAction(action) {
  return ACCOUNT_LIFECYCLE_ACTIONS.includes(String(action || '').trim().toLowerCase());
}

// 发布者只做形状校验与转发：坏事件在入口被丢弃，而不是进入监听者再各自防。
function publishAccountLifecycle(hub, event) {
  if (!hub || typeof hub.emit !== 'function') return [];
  const normalized = normalizeAccountLifecycleEvent(event);
  if (!normalized) return [];
  return hub.emit(ACCOUNT_LIFECYCLE_CHANGED, normalized);
}

function createAccountLifecycleEventPublisher(hub) {
  function publish(action, input = {}) {
    if (!isAction(action)) return [];
    return publishAccountLifecycle(hub, { ...(input || {}), action });
  }

  // 批量导入/扫描：一次请求产生 N 个账号事件时共享 batchId，
  // 监听者据此把 N 次目录重建合并成一次。
  function createBatch(batchId) {
    const id = String(batchId || '').trim();
    return {
      publish(action, input = {}) {
        return publish(action, { ...(input || {}), ...(id ? { batchId: id } : {}) });
      }
    };
  }

  return {
    publish,
    createBatch
  };
}

module.exports = {
  createAccountLifecycleEventPublisher,
  publishAccountLifecycle
};
