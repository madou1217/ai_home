'use strict';

const { isAccountRef } = require('./public-account-ref');

const GATEWAY_RUNTIME_SCOPE = 'gateway';

// 会话/运行目标的网关作用域标记：不是账号，代表「由网关在该 provider 的账号池里挑号」。
// 落在 execution_account_ref 这类 NOT NULL 列里时用的就是它（见 resolveRuntimeTarget）。
// 允许带 provider 后缀（`gateway:opencode`）：provider 本身以会话列为准，后缀只让前端
// 的选中态能按同一个字符串匹配（同一个 provider 组里不会出现第二个网关条目）。
const GATEWAY_RUNTIME_SCOPE_PATTERN = /^gateway(?::[a-z0-9][a-z0-9-]*)?$/i;

function isGatewayRuntimeScope(value) {
  return GATEWAY_RUNTIME_SCOPE_PATTERN.test(String(value || '').trim());
}

function resolveRuntimeTarget(input = {}) {
  if (input.gateway === true) {
    return {
      gateway: true,
      accountRef: '',
      runtimeScope: GATEWAY_RUNTIME_SCOPE
    };
  }
  const accountRef = String(input.accountRef || '').trim();
  // 会话列里存的就是网关作用域字符串（`gateway` / `gateway:<provider>`）：它同样是
  // 「不钉账号」的目标，必须在这里认出来，否则调用方（codex app-server / 原生会话）
  // 会把它当成非法 accountRef 而拒绝整轮。runtimeScope 去冒号（tmux 会话名与文件名
  // 都不允许 ':'），并保留 provider 后缀以免不同 provider 共用同一个常驻 app-server。
  if (isGatewayRuntimeScope(accountRef)) {
    return {
      gateway: true,
      accountRef: '',
      runtimeScope: accountRef.replace(/[^a-zA-Z0-9._-]/g, '-')
    };
  }
  if (!isAccountRef(accountRef)) return null;
  return {
    gateway: false,
    accountRef,
    runtimeScope: accountRef
  };
}

function serializeRuntimeTarget(target) {
  if (!target) return {};
  return target.gateway
    ? { gateway: true }
    : { accountRef: target.accountRef };
}

module.exports = {
  GATEWAY_RUNTIME_SCOPE,
  isGatewayRuntimeScope,
  resolveRuntimeTarget,
  serializeRuntimeTarget
};
