'use strict';

const { DEFAULT_STRATEGY } = require('./base');

// codex 浏览器登录已固定由 Go 的 account-auth-jobs 承接：PKCE、state、授权码换 token
// 都在 Go 进程里，Node 只负责转发浏览器回调并读 Go 的账号结果。
// 这里保留的是 oauth-device（官方 CLI 设备码）模式需要的登录前环境与启动参数。
const CODEX_STRATEGY = {
  ...DEFAULT_STRATEGY,

  // Codex device-code login (oauth-device) still spawns the CLI and needs its
  // sqlite home pointed at the sandbox; browser login never reaches prepareLogin.
  prepareLogin({ profileDir, envOverrides, deps }) {
    if (!deps.resolveCodexSqliteHome) return;
    const sqliteHome = deps.resolveCodexSqliteHome({
      path: deps.path,
      aiHomeDir: deps.aiHomeDir
    });
    if (sqliteHome) envOverrides.CODEX_SQLITE_HOME = sqliteHome;
  },

  buildLoginArgs({ authMode, baseArgs }) {
    const args = Array.isArray(baseArgs) ? baseArgs.slice() : [];
    if (authMode === 'oauth-device' && !args.includes('--device-auth')) {
      args.push('--device-auth');
    }
    return args;
  }
};

module.exports = {
  CODEX_STRATEGY
};
