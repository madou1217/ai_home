'use strict';

// CLI 交互协调与派发已统一由 Go Core Runtime（internal/runtime/chatruntime/cli_interactions.go）
// 与反代路由（/v0/webui/session-events/provider-hook、/v0/webui/chat/sessions/:id/commands）承接。
// 保留无状态 fail-closed 壳导出，彻底解除对 Node chatRuntimeService 与 chat-runtime/* 的耦合。
function createCliInteractionUnavailableError(message) {
  const error = new Error(message);
  error.code = 'cli_interaction_unavailable';
  error.statusCode = 503;
  return error;
}

function createCliInteractionCoordinator() {
  async function sync() {
    throw createCliInteractionUnavailableError(
      'CLI 交互协调已迁移至 Go Core Runtime，请通过 /v0/webui/session-events/provider-hook 调用'
    );
  }

  async function dispatch() {
    throw createCliInteractionUnavailableError(
      'CLI 交互派发已迁移至 Go Core Runtime，请通过 /v0/webui/chat/sessions/:id/commands 调用'
    );
  }

  return { sync, dispatch };
}

module.exports = { createCliInteractionCoordinator };
