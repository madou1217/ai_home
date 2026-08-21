'use strict';

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const { readAccountCredentialRecord } = require('../account-credential-store');
const { readDesktopSession, writeDesktopSession } = require('../kimi-desktop-session');
const {
  seedKimiDesktopTokenStore,
  adoptKimiDesktopTokensFromProfile,
  hasKimiDesktopTokenStore
} = require('../kimi-desktop-injector');
const { createDesktopLaunchStrategy } = require('./default-strategy');

const SESSION_REQUIRED_ERROR = 'kimi_desktop_session_required';
const SESSION_SEED_FAILED_ERROR = 'kimi_desktop_session_seed_failed';
const RESTART_FAILED_ERROR = 'kimi_desktop_restart_failed';

// 依赖全部走 ctx.deps 覆写 + 模块默认，保持启动器对 kimi 实现零知识，
// 同时让测试可以只注入 token 仓这一层。
function resolveDeps(ctx) {
  const deps = (ctx && ctx.deps) || {};
  return {
    fsImpl: ctx.fs || nodeFs,
    pathImpl: ctx.path || nodePath,
    aiHomeDir: ctx.aiHomeDir,
    readCredentialRecord: deps.readAccountCredentialRecord || readAccountCredentialRecord,
    seedTokenStore: deps.seedKimiDesktopTokenStore || seedKimiDesktopTokenStore,
    adoptTokens: deps.adoptKimiDesktopTokensFromProfile || adoptKimiDesktopTokensFromProfile,
    hasTokenStore: deps.hasKimiDesktopTokenStore || hasKimiDesktopTokenStore
  };
}

// 凭证库读取失败（DB 缺失/损坏）不阻塞启动，仅跳过托管注入。
function tryReadDesktopSession(impl, accountRef) {
  try {
    return readDesktopSession(impl.readCredentialRecord(impl.fsImpl, impl.aiHomeDir, accountRef));
  } catch (_error) {
    return null;
  }
}

// kimi 桌面托管登录：webUI 扫码一次拿到 web session 后长期托管。每次启动前
// 把 session 离线写进隔离 profile 的 token 仓（safeStorage v10 格式，App 拒绝
// 一切调试开关，CDP 注入不可行）；App 启动后自行用 refresh_token 续期并轮换，
// 因此 seed 前先从 profile 回读上一轮轮换出的新 token 采纳回托管存储。
// 未找到可用 Desktop session 时失败关闭，由 WebUI 进入托管扫码；
// 不允许先启动一个未登录的空实例再让用户自行处理。
function prepareLaunchSession(ctx) {
  const accountRef = String((ctx && ctx.accountRef) || '').trim();
  if (!accountRef) return { ready: true };
  const impl = resolveDeps(ctx);
  const { userDataDir, platformKey } = ctx;
  try {
    let session = tryReadDesktopSession(impl, accountRef);
    const adopted = impl.adoptTokens(userDataDir);
    if (adopted && adopted.refreshToken) {
      if (!session || adopted.refreshToken !== session.refreshToken) {
        writeDesktopSession(impl.fsImpl, impl.aiHomeDir, accountRef, { ...(session || {}), ...adopted });
      }
      session = { ...(session || {}), ...adopted };
    }
    const hasExistingStore = impl.hasTokenStore(userDataDir, { fs: impl.fsImpl, path: impl.pathImpl });
    // macOS 的密文只能由 Kimi 自己通过 Keychain 解开；存在结构有效的 store
    // 时直接沿用，避免后台 Server 用旧 refresh_token 覆盖 App 已轮换的新链。
    // Windows adopt 成功同样证明现有 store 可用，无需重复写盘。
    if (hasExistingStore && (adopted || platformKey === 'macos')) {
      return { ready: true, source: 'profile' };
    }
    if (!session) {
      return hasExistingStore
        ? { ready: true, source: 'profile' }
        : { ready: false, error: SESSION_REQUIRED_ERROR };
    }
    const seeded = impl.seedTokenStore({
      userDataDir,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      userId: session.userId
    });
    // Kimi 的 token 仓只在主进程启动时读取。这次刚把托管 session 写入 profile
    // 时必须重启该账号的旧实例；已有可用 profile 则保持单实例，不做无意义重启。
    if (seeded && seeded.seeded) return { ready: true, source: 'managed', requiresRestart: true };
    if (hasExistingStore) {
      return { ready: true, source: 'profile', reason: seeded && seeded.reason };
    }
    return {
      ready: false,
      error: SESSION_SEED_FAILED_ERROR,
      reason: String((seeded && seeded.reason) || 'unknown')
    };
  } catch (error) {
    return {
      ready: false,
      error: SESSION_SEED_FAILED_ERROR,
      reason: String((error && error.message) || error || 'unknown').slice(0, 120)
    };
  }
}

const kimiDesktopLaunchStrategy = createDesktopLaunchStrategy({
  name: 'kimi',
  // 已有实例也必须先跑托管 session 准备：新种入的 token 仓只有重启才会被读取。
  reuseRunningInstance: false,
  restartFailedError: RESTART_FAILED_ERROR,
  prepareLaunchSession
});

module.exports = { kimiDesktopLaunchStrategy };
