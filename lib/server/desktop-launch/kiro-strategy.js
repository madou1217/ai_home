'use strict';

const { normalizeProviderAccountRef } = require('../../runtime/provider-session-context');
const { prepareKiroRuntimeHome } = require('../../runtime/kiro-runtime-home');
const { buildSharedCacheEnv } = require('../../cli/services/ai-cli/launch-profile/home-redirect-strategy');
const { createDesktopLaunchStrategy, resolveElectronSpawnPlan } = require('./default-strategy');

const INSTANCE_PREFIX = 'aih-kiro_cli_desktop-';

function resolveInstanceName(ctx) {
  const accountRef = normalizeProviderAccountRef(ctx && ctx.accountRef);
  return accountRef ? INSTANCE_PREFIX + accountRef : '';
}

function parseInstanceName(commandLine) {
  const token = String(commandLine || '').trim().match(/^(?:"([^"]+)"|'([^']+)'|(\S+))/);
  const executable = String(token && (token[1] || token[2] || token[3]) || '').split(/[\\/]/).pop();
  const match = executable.match(/^aih-kiro_cli_desktop-(acct_[0-9a-f]{20})$/i);
  return match ? INSTANCE_PREFIX + match[1].toLowerCase() : '';
}

function isNativeGui(resolved, ctx) {
  return ctx.platformKey === 'macos' && ctx.path.basename(resolved.executablePath) === 'kiro_cli_desktop';
}

function prepareResolvedLaunch(resolved, ctx) {
  if (!isNativeGui(resolved, ctx)) return { ready: true, resolved };
  try {
    prepareKiroRuntimeHome({
      fs: ctx.fs, path: ctx.path, sandboxDir: ctx.profileDir,
      hostHomeDir: ctx.hostHomeDir, platform: 'darwin'
    });
    return { ready: true, resolved };
  } catch (error) {
    return { ready: false, error: 'kiro_desktop_profile_unavailable', reason: error.message };
  }
}

// 桌面 GUI 不认 KIRO_TEST_DB_PATH，只能把 HOME 指到账号目录，凭据库才分得开。
// CLI 不需要这样做（见 launch-profile/kiro-strategy.js）。
function decorateResolvedLaunchEnv(env, resolved, ctx) {
  if (!isNativeGui(resolved, ctx)) return;
  const { path, profileDir, hostHomeDir } = ctx;
  Object.assign(env, {
    HOME: profileDir,
    USERPROFILE: profileDir,
    // 会话写宿主原生 ~/.kiro：账号之间只有凭据库不同。
    KIRO_HOME: path.join(hostHomeDir || profileDir, '.kiro'),
    KIRO_TEST_DB_PATH: path.join(profileDir, 'data.sqlite3'),
    TMPDIR: path.join(profileDir, 'tmp') + path.sep,
    XDG_CONFIG_HOME: path.join(profileDir, '.config'),
    XDG_DATA_HOME: path.join(profileDir, '.local', 'share'),
    XDG_STATE_HOME: path.join(profileDir, '.local', 'state'),
    ...buildSharedCacheEnv(hostHomeDir, path)
  });
  delete env.KIRO_API_KEY;
}

function resolveSpawnPlan(resolved, ctx) {
  if (!isNativeGui(resolved, ctx)) return resolveElectronSpawnPlan(resolved, ctx);
  // Keep the signed bundle executable intact. exec -a gives ps a stable account
  // marker, while current_exe still locates the app's own resources. Arguments
  // remain separate argv values, including installation paths with spaces.
  return {
    file: '/bin/bash',
    args: ['-c', 'exec -a "$0" "$@"', resolveInstanceName(ctx), resolved.executablePath, '--allow-multiple']
  };
}

const kiroDesktopLaunchStrategy = createDesktopLaunchStrategy({
  name: 'kiro-native-gui',
  resolveInstanceName,
  parseInstanceName,
  prepareResolvedLaunch,
  decorateResolvedLaunchEnv,
  resolveSpawnPlan
});

module.exports = { kiroDesktopLaunchStrategy };
