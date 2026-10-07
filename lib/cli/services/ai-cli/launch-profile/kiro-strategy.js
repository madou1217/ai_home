'use strict';

const { buildSharedCacheEnv } = require('./home-redirect-strategy');

// Kiro CLI 用真实 HOME：会话写宿主原生的 ~/.kiro，运行时解压在宿主自己的
// Library/Application Support/kiro-cli。账号之间只换凭据库——KIRO_TEST_DB_PATH
// 指向账号目录里的 data.sqlite3。不设 KIRO_HOME，否则会话会被写进账号目录。
function prepare(ctx) {
  const { fs, sandboxDir } = ctx || {};
  if (!fs || !sandboxDir) return;
  fs.mkdirSync(sandboxDir, { recursive: true, mode: 0o700 });
}

function buildEnvPatch(ctx) {
  const { hostHomeDir, path, sandboxDir } = ctx || {};
  const set = {
    KIRO_TEST_DB_PATH: path.join(sandboxDir, 'data.sqlite3')
  };
  if (hostHomeDir) {
    Object.assign(set, {
      HOME: hostHomeDir,
      USERPROFILE: hostHomeDir,
      ...buildSharedCacheEnv(hostHomeDir, path)
    });
  }
  return { set, unset: ['KIRO_API_KEY', 'KIRO_HOME'] };
}

// The umbrella `kiro-cli` binary owns the desktop/shell-integration bootstrap
// and can open Kiro CLI.app when invoked without a subcommand. AIH's interactive
// lane is a terminal chat, so an empty provider invocation must select the chat
// subcommand explicitly. Login keeps its declared `login ...` arguments.
function buildRuntimeArgs(ctx = {}) {
  const args = Array.isArray(ctx.args) ? ctx.args.slice() : [];
  return ctx.isLogin || args.length > 0 ? args : ['chat'];
}

const kiroStrategy = Object.freeze({
  name: 'kiro-credential-database',
  prepare,
  buildEnvPatch,
  buildRuntimeArgs
});

module.exports = { kiroStrategy, prepare, buildEnvPatch, buildRuntimeArgs };
