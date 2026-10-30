'use strict';

const { publishAccountLifecycle } = require('./account-lifecycle-event-publisher');

// 账号生命周期事件的进程内总线入口。
//
// 发布点位于账号的**权威原语**（注册、删除、启停）而不是路由层：
//   路由层只负责把用户意图变成一次原语调用，原语提交成功后发布事实。
// 这样新增监听者（模型投影刷新、WebUI 推送、统计……）不需要回头修改任何调用点。
//
// CLI 进程没有装配 hub：publish 变成 no-op，原语行为与之前逐字节一致。
let activeHub = null;

function setAccountLifecycleHub(hub) {
  activeHub = hub && typeof hub.emit === 'function' ? hub : null;
  return activeHub;
}

function getAccountLifecycleHub() {
  return activeHub;
}

// 发布绝不允许打断已经成功的写操作：hub 内部按监听者隔离异常，
// 这里再兜一层，保证注册/删除/启停的返回值不受事件层影响。
function publishAccountLifecycleEvent(action, event) {
  if (!activeHub) return [];
  try {
    return publishAccountLifecycle(activeHub, { ...(event || {}), action });
  } catch (_error) {
    return [];
  }
}

module.exports = {
  getAccountLifecycleHub,
  publishAccountLifecycleEvent,
  setAccountLifecycleHub
};
