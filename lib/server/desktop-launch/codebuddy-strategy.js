'use strict';

const { execFileSync: nodeExecFileSync } = require('node:child_process');
const { resolveHostHomeDir } = require('../../runtime/host-home');
const { createDesktopLaunchStrategy, resolveElectronSpawnPlan } = require('./default-strategy');
const { prepareCodebuddyIdeBridge } = require('../../runtime/codebuddy-ide-bridge');

const SECURITY_COMMAND = '/usr/bin/security';
const KEYCHAIN_ERROR = 'codebuddy_desktop_keychain_unavailable';

function readDefaultKeychain(run, env, path) {
  try {
    const value = JSON.parse(String(run(SECURITY_COMMAND, ['default-keychain', '-d', 'user'], {
      env, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe']
    })).trim());
    return typeof value === 'string' && path.isAbsolute(value) ? value : '';
  } catch (_) {
    return '';
  }
}

function ensurePrivatePreferences(ctx) {
  // security 按 HOME 写入默认钥匙串引用；不能沿旧的目录链接改到宿主偏好设置。
  for (const directory of [ctx.profileDir, ctx.path.join(ctx.profileDir, 'Library'),
    ctx.path.join(ctx.profileDir, 'Library', 'Preferences')]) {
    let stat;
    try { stat = ctx.fs.lstatSync(directory); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('desktop_preferences_not_private');
    ctx.fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
}

function prepareLaunchProfile(ctx) {
  if (ctx.platformKey !== 'macos') return { ready: true };
  const baseEnv = ctx.getBaseEnv();
  const hostHomeDir = resolveHostHomeDir({ env: baseEnv, hostHomeDir: ctx.hostHomeDir, platform: 'darwin' });
  if (!ctx.profileDir || ctx.path.resolve(ctx.profileDir) === ctx.path.resolve(hostHomeDir)) {
    return { ready: false, error: KEYCHAIN_ERROR, reason: 'desktop_home_not_isolated' };
  }
  const run = ctx.deps.execFileSync || nodeExecFileSync;
  const profileEnv = { ...baseEnv, HOME: ctx.profileDir };
  if (readDefaultKeychain(run, profileEnv, ctx.path)) return { ready: true };
  const hostKeychain = readDefaultKeychain(run, { ...baseEnv, HOME: hostHomeDir }, ctx.path);
  if (!hostKeychain) return { ready: false, error: KEYCHAIN_ERROR, reason: 'host_default_keychain_missing' };
  try {
    ensurePrivatePreferences(ctx);
    // 只设置隔离 HOME 的系统加密服务引用。账号令牌仍由独立 user-data 仓加密保存；
    // 不复制/链接钥匙串文件，也不改变真实 HOME 的默认钥匙串。
    run(SECURITY_COMMAND, ['default-keychain', '-d', 'user', '-s', hostKeychain], {
      env: profileEnv, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe']
    });
    if (readDefaultKeychain(run, profileEnv, ctx.path) !== hostKeychain) {
      return { ready: false, error: KEYCHAIN_ERROR, reason: 'desktop_keychain_reference_unavailable' };
    }
    return { ready: true };
  } catch (_) {
    return { ready: false, error: KEYCHAIN_ERROR, reason: 'desktop_keychain_reference_failed' };
  }
}

const codebuddyDesktopLaunchStrategy = createDesktopLaunchStrategy({
  name: 'codebuddy-keychain',
  prepareLaunchProfile,
  prepareResolvedLaunch(resolved, ctx) {
    if (!['codebuddy', 'codebuddycn'].includes(ctx.provider)) return { ready: true, resolved };
    try {
      const prepared = (ctx.deps.prepareCodebuddyIdeBridge || prepareCodebuddyIdeBridge)({
        provider: ctx.provider, accountRef: ctx.accountRef, profileDir: ctx.profileDir,
        aiHomeDir: ctx.aiHomeDir, bundlePath: resolved.bundlePath,
        executablePath: resolved.executablePath
      });
      return { ...prepared, resolved: { ...resolved,
        ...(prepared.extensionsDir ? { codebuddyExtensionsDir: prepared.extensionsDir } : {}) } };
    } catch (error) {
      return { ready: false, error: error.code || 'codebuddy_ide_bridge_prepare_failed' };
    }
  },
  resolveSpawnPlan(resolved, ctx) {
    const plan = resolveElectronSpawnPlan(resolved, ctx);
    if (resolved.codebuddyExtensionsDir) plan.args.push(`--extensions-dir=${resolved.codebuddyExtensionsDir}`);
    return plan;
  }
});

module.exports = { codebuddyDesktopLaunchStrategy, prepareLaunchProfile };
