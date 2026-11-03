'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { buildSharedCacheEnv } = require('./home-redirect-strategy');
const { bootstrapKiroCliDatabase, isBareKiroDatabase } = require('../../../../account/kiro-cli-database-bootstrap');
const { resolveProviderCliPath } = require('../ensure-native-cli');
const { placeKiroPermissionArgs } = require('../../../../runtime/kiro-permission-args');

// Kiro CLI 用真实 HOME：会话写宿主原生的 ~/.kiro，运行时解压在宿主自己的
// Library/Application Support/kiro-cli。账号之间只换凭据库——KIRO_TEST_DB_PATH
// 指向账号目录里的 data.sqlite3。不设 KIRO_HOME，否则会话会被写进账号目录。
function prepare(ctx) {
  const { fs, sandboxDir } = ctx || {};
  if (!fs || !sandboxDir) return;
  fs.mkdirSync(sandboxDir, { recursive: true, mode: 0o700 });
  ensureCliCompatibleDatabase(ctx);
}

/**
 * aih 原生登录写出的是只有 auth_kv 的裸库，kiro-cli 打开时会因迁移冲突报
 * 「table auth_kv already exists」。启动前让 CLI 自己建 schema 再合并凭据
 * （见 kiro-cli-database-bootstrap.js）；只在确认是裸库时才解析 CLI 路径，常规启动零开销。
 */
function ensureCliCompatibleDatabase(ctx, deps = {}) {
  const fs = ctx.fs || nodeFs;
  const path = ctx.path || nodePath;
  const databasePath = path.join(ctx.sandboxDir, 'data.sqlite3');
  if (!isBareKiroDatabase(databasePath, { fs })) return { repaired: false, reason: 'not_bare' };
  const resolveCliPath = deps.resolveProviderCliPath || resolveProviderCliPath;
  const cliPath = resolveCliPath('kiro', { hostHomeDir: ctx.hostHomeDir, fs });
  return (deps.bootstrapKiroCliDatabase || bootstrapKiroCliDatabase)({
    databasePath,
    cliPath,
    hostHomeDir: ctx.hostHomeDir,
    env: ctx.baseEnv
  }, { fs, path });
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

/**
 * 权限旗标（`-a` / `--trust-all-tools`）的落点：它属于 `chat` 子命令，写在别处会被拒
 * （`kiro-cli -a` 退出码 2）。见 runtime/kiro-permission-args。
 */
function placePermissionArgs(args, permissionArgs) {
  return placeKiroPermissionArgs(args, permissionArgs);
}

const kiroStrategy = Object.freeze({
  name: 'kiro-credential-database',
  prepare,
  buildEnvPatch,
  buildRuntimeArgs,
  placePermissionArgs
});

module.exports = { kiroStrategy, prepare, buildEnvPatch, buildRuntimeArgs, ensureCliCompatibleDatabase };
