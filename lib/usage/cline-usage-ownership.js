'use strict';

// cline 用量归属：共享会话库下的「哪段对话属于哪个 aih 账号」。
//
// 背景：cline 的会话数据（`~/.cline/data/sessions/**`）被 aih 主动链回宿主
// （lib/runtime/launch-profile/cline-shared-session-store.js），所以文件本身没有账号
// 边界——会话文件里的 provider 是 `cline-pass` 这类原生供应商，不是 aih 账号。
// 归属规则与 kiro 相同，由 registry-scope-ownership.js 统一实现（注册表作用域唯一才归属）。

const { createRegistryScopeOwnership, SCOPE_GRACE_MS } = require('./registry-scope-ownership');

function createClineUsageOwnership(options = {}) {
  return createRegistryScopeOwnership({ ...options, provider: 'cline' });
}

module.exports = {
  createClineUsageOwnership,
  SCOPE_GRACE_MS
};
