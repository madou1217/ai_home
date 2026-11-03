'use strict';

// kiro 的**原生登录（不经过本地 CLI / IDE）**：设备码授权（A）与 refreshToken 导入（B）。
//
// 为什么要有这一层：账号进入系统的既有契约是「先有原生凭据投影，再由 registerKiroNativeLogin 注册」
// （lib/account/native-auth-projection.js）。以前这个投影只能由本地 CLI 登录后产生；本模块用纯 API
// 产出**逐字段同构**的投影（`<runtimeDir>/data.sqlite3` 的 auth_kv 两行），因此注册、身份核验、
// 采集、模型清单、推理五条链路一行都不用改。
//
// 两条入口共用同一份凭据模型：
//   A 设备码：registerKiroOidcClient → startKiroDeviceAuthorization → 轮询 pollKiroDeviceToken
//             → 投影里同时写 kirocli:odic:device-registration 与 kirocli:odic:token（口径 oidc）
//   B 刷新令牌：Kiro Desktop / social 只要一个 refresh_token（Kiro IDE 的 kiro-auth-token.json）
//   A′ social 设备码：Google / GitHub 走 Kiro 自己的认证服务（kiro-social-device-flow.js）
//             → B 与 A′ 的产物写进 **kirocli:social:token**（CLI 原生形状）+ aih 私有元数据行；
//               提供方认不出时退回旧行为（kirocli:odic:token + social 标记），不猜。
//               写对槽位的原因：aih 启动原生 kiro-cli 时把这个库交给它（KIRO_TEST_DB_PATH），
//               social token 放在 odic 槽会被 CLI 当成 Builder ID、按 OIDC 刷新而失败。

const nodePath = require('node:path');
const {
  KIRO_AUTH_META_KEY,
  buildKiroSocialSlotRow,
  normalizeKiroSocialProvider,
  pickKiroAuthMeta
} = require('./kiro-auth-metadata');
const {
  KIRO_BUILDER_ID_START_URL,
  pollKiroDeviceToken,
  registerKiroOidcClient,
  startKiroDeviceAuthorization
} = require('./kiro-device-authorization');
const { refreshKiroDesktopGrant } = require('./kiro-desktop-refresh');
const { registerKiroNativeLogin } = require('./kiro-native-login');
const {
  pollKiroSocialDeviceToken,
  startKiroSocialDeviceAuthorization
} = require('./kiro-social-device-flow');

const KEY_DEVICE_REGISTRATION = 'kirocli:odic:device-registration';
const KEY_TOKEN = 'kirocli:odic:token';
const KEY_SOCIAL_TOKEN = 'kirocli:social:token';
const DEFAULT_SOCIAL_AUTH_METHOD = 'social';

/**
 * 一条凭据该写进哪些 auth_kv 行。
 *   * 有 device-registration → OIDC：registration 行 + odic 槽；
 *   * 提供方是 Google / GitHub → social 槽（CLI 原生形状）+ aih 私有元数据行；
 *   * 其余 → odic 槽（历史行为，不猜新口径）。
 */
function buildKiroAuthKvRows(input) {
  const auth = input.auth || {};
  if (input.registration) {
    return [
      [KEY_DEVICE_REGISTRATION, {
        client_id: input.registration.clientId,
        client_secret: input.registration.clientSecret,
        client_secret_expires_at: input.registration.clientSecretExpiresAt || '',
        region: input.registration.region,
        oauth_flow: input.registration.oauthFlow || 'DeviceCode',
        scopes: input.registration.scopes || []
      }],
      [KEY_TOKEN, auth]
    ];
  }
  const socialProvider = normalizeKiroSocialProvider(auth.provider);
  if (!socialProvider) return [[KEY_TOKEN, auth]];
  const rows = [[KEY_SOCIAL_TOKEN, buildKiroSocialSlotRow(auth, socialProvider)]];
  const meta = pickKiroAuthMeta(auth);
  if (meta) rows.push([KIRO_AUTH_META_KEY, meta]);
  return rows;
}

function deviceLoginError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

/** grant（access/refresh/expiresAtMs）→ auth_kv 的 token 行形态（与 CLI 落盘一致）。 */
function buildKiroAuthRow(grant, extra = {}) {
  return {
    access_token: grant.accessToken,
    refresh_token: grant.refreshToken,
    expires_at: new Date(grant.expiresAtMs).toISOString(),
    region: grant.region,
    ...extra
  };
}

/** 把一条凭据写成 CLI 同构的 auth_kv 投影（0600，先写临时文件再原子改名）。 */
function writeKiroCredentialDatabase(fs, databasePath, input = {}) {
  const { DatabaseSync } = require('node:sqlite');
  const rows = buildKiroAuthKvRows(input);

  const directory = nodePath.dirname(databasePath);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = `${databasePath}.aih-tmp-${process.pid}`;
  let database = null;
  try {
    database = new DatabaseSync(tempPath);
    database.exec('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)');
    const insert = database.prepare('INSERT INTO auth_kv (key, value) VALUES (?, ?)');
    for (const [key, value] of rows) insert.run(key, JSON.stringify(value));
    database.close();
    database = null;
    fs.chmodSync(tempPath, 0o600);
    fs.renameSync(tempPath, databasePath);
    return { ok: true, keys: rows.map(([key]) => key) };
  } catch (error) {
    try { database?.close(); } catch (_error) { /* ignore */ }
    try { fs.rmSync(tempPath, { force: true }); } catch (_error) { /* ignore */ }
    throw deviceLoginError(`kiro_credential_database_write_failed:${error && error.message || error}`);
  }
}

/** A：开始设备码登录（第一步）—— 返回给用户看的 code 与验证地址，以及后续轮询所需状态。 */
async function beginKiroDeviceLogin(options = {}) {
  const registration = options.registration
    || await registerKiroOidcClient({ region: options.region, clientName: options.clientName,
      issuerUrl: options.issuerUrl }, options);
  const startUrl = String(options.startUrl || KIRO_BUILDER_ID_START_URL).trim();
  const started = await startKiroDeviceAuthorization({ registration, startUrl }, options);
  return {
    registration,
    startUrl,
    deviceCode: started.deviceCode,
    userCode: started.userCode,
    verificationUri: started.verificationUri,
    verificationUriComplete: started.verificationUriComplete,
    intervalSeconds: started.intervalSeconds,
    expiresAtMs: Date.now() + started.expiresInSeconds * 1000
  };
}

/**
 * A′：开始 **social 设备码**登录（Google / GitHub）—— 与 Builder ID 是两套协议。
 *
 * 为什么需要它：social 账号的浏览器 PKCE 流程要求 localhost 回调（`--use-device-flow` 只对
 * Builder ID / IdC 生效），在远程机器上回调打不通 —— 用户遇到的「换台电脑就报错」正是这个。
 * 设备流没有回调，任意机器都能完成授权。
 *
 * @returns {Promise<{loginProvider, clientId, deviceCode, userCode, verificationUri, verificationUriComplete, intervalSeconds, expiresAtMs}>}
 */
async function beginKiroSocialDeviceLogin(options = {}) {
  const started = await startKiroSocialDeviceAuthorization({
    loginProvider: options.loginProvider || options.provider,
    clientId: options.clientId,
    region: options.region,
    request: options.request,
    timeoutMs: options.timeoutMs
  }, options);
  return {
    loginProvider: started.loginProvider,
    clientId: started.clientId,
    deviceCode: started.deviceCode,
    userCode: started.userCode,
    verificationUri: started.verificationUri,
    verificationUriComplete: started.verificationUriComplete,
    intervalSeconds: started.intervalSeconds,
    expiresAtMs: Date.now() + started.expiresInSeconds * 1000
  };
}

/**
 * A′：轮询一次 social 设备码（第二步）。pending / expired 是状态不是错误。
 *
 * 授权成功后返回的 auth 行与 importKiroRefreshToken **同构**（authMethod='social' + provider +
 * profileArn），因此判型走 desktop 口径、采集与推理一行都不用改。
 */
async function pollKiroSocialDeviceLogin(flow, options = {}) {
  if (!flow || !flow.deviceCode) throw deviceLoginError('kiro_social_flow_missing_state');
  if (Number.isFinite(flow.expiresAtMs) && Date.now() > flow.expiresAtMs) return { status: 'expired' };
  const polled = await pollKiroSocialDeviceToken({
    clientId: flow.clientId,
    deviceCode: flow.deviceCode,
    region: options.region
  }, { ...options, region: options.region || flow.region });
  if (polled.status !== 'authorized') return polled;
  const provider = polled.provider || flow.loginProvider || '';
  return {
    status: 'authorized',
    registration: null,
    profileArn: polled.profileArn,
    auth: buildKiroAuthRow(polled.grant, {
      // social 标记：判型据此走 desktop 口径（没有 device-registration 也不会被误判成 oidc）。
      authMethod: DEFAULT_SOCIAL_AUTH_METHOD,
      ...(provider ? { provider } : {}),
      ...(polled.profileArn ? { profileArn: polled.profileArn } : {})
    })
  };
}

/**
 * A：轮询一次（第二步）。pending / slow_down 是状态不是错误，调用方据此继续等。
 * 授权成功后返回可直接落盘的 grant。
 */
async function pollKiroDeviceLogin(flow, options = {}) {
  if (!flow || !flow.registration || !flow.deviceCode) throw deviceLoginError('kiro_device_flow_missing_state');
  if (Number.isFinite(flow.expiresAtMs) && Date.now() > flow.expiresAtMs) return { status: 'expired' };
  return pollKiroDeviceToken({ registration: flow.registration, deviceCode: flow.deviceCode }, options);
}

/**
 * B：用 Kiro Desktop / social 的 refresh_token 换一份可用凭据。
 * 先真刷一次再落库 —— 不把没验证过的 token 写进账号。
 *
 * @returns {Promise<{flavour: string, profileArn: string, auth: object}>}
 */
async function importKiroRefreshToken(options = {}) {
  const refreshToken = String(options.refreshToken || '').trim();
  if (!refreshToken) throw deviceLoginError('kiro_desktop_refresh_missing_refresh_token');
  const grant = await refreshKiroDesktopGrant({ refreshToken, region: options.region }, options);
  const profileArn = grant.profileArn || String(options.profileArn || '').trim();
  return {
    flavour: 'desktop',
    profileArn,
    auth: buildKiroAuthRow(grant, {
      // social 标记：判型据此走 desktop 口径（没有 device-registration 也不会被误判成 oidc）。
      authMethod: DEFAULT_SOCIAL_AUTH_METHOD,
      provider: String(options.provider || '').trim(),
      ...(profileArn ? { profileArn } : {})
    })
  };
}

/**
 * 把凭据投影写进 runtimeDir，并按既有契约注册账号（身份核验仍走 GetUsageLimits，不跳过）。
 *
 * @returns {Promise<{ok: boolean, reason?: string, accountRef?: string, cliAccountId?: string, databasePath: string}>}
 */
async function commitKiroCredential(fs, options = {}) {
  const runtimeDir = String(options.runtimeDir || '').trim();
  if (!runtimeDir) throw deviceLoginError('kiro_login_runtime_missing');
  const databasePath = nodePath.join(runtimeDir, 'data.sqlite3');
  writeKiroCredentialDatabase(fs, databasePath, { registration: options.registration, auth: options.auth });

  const register = options.registerKiroNativeLogin || registerKiroNativeLogin;
  const registered = await register(fs, runtimeDir, {
    aiHomeDir: options.aiHomeDir,
    // 身份核验（GetUsageLimits）用真实 fetch；调用方可以注入替身做单测。
    request: options.request || globalThis.fetch,
    fs,
    ...(options.accountRef ? { accountRef: options.accountRef } : {})
  });
  if (!registered || !registered.registered) {
    return { ok: false, reason: (registered && registered.reason) || 'kiro_identity_unverifiable', databasePath };
  }
  return { ok: true, accountRef: registered.accountRef, cliAccountId: registered.cliAccountId, databasePath };
}

module.exports = {
  KEY_DEVICE_REGISTRATION,
  KEY_SOCIAL_TOKEN,
  KEY_TOKEN,
  beginKiroDeviceLogin,
  beginKiroSocialDeviceLogin,
  buildKiroAuthRow,
  commitKiroCredential,
  importKiroRefreshToken,
  pollKiroDeviceLogin,
  pollKiroSocialDeviceLogin,
  writeKiroCredentialDatabase
};
