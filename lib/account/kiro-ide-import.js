'use strict';

// Kiro IDE 登录态的**本机导入**（不需要用户自己去拷文件）。
//
// Kiro IDE（桌面版）把自己的登录态写在宿主家目录：
//   ~/.aws/sso/cache/kiro-auth-token.json
//   { accessToken, refreshToken, expiresAt, authMethod: 'social', provider: 'Google'|'Github', profileArn }
// 这与 Kiro Desktop / social 的 refresh_token 口径是**同一份凭据**，所以导入直接复用
// importKiroRefreshToken —— 它会真刷一次（顺带验证 token 有效、并带回 profileArn），
// 不把没验证过的 token 写进账号。
//
// 宿主家目录必须走 resolveHostHomeDir（尊重 AIH_HOST_HOME），否则在投影/沙箱环境里会读错人。

const nodePath = require('node:path');
const crypto = require('node:crypto');
const { resolveHostHomeDir } = require('../runtime/host-home');
const { importKiroRefreshToken } = require('./kiro-device-login');

const IDE_TOKEN_RELATIVE_PATH = Object.freeze(['.aws', 'sso', 'cache', 'kiro-auth-token.json']);

/**
 * 本机登录态与已入库账号的**同源指纹**（离线可比，不打网络）。
 *
 * 只对 refresh_token 取哈希：它是这段登录态里唯一稳定、且与账号一一对应的标识
 * （access_token 会轮换，profileArn 对 Builder ID 账号为空）。因此
 * 「本机来源的指纹」与「已入库账号的指纹」用同一个函数算，就能回答
 * 「这台机器上这份登录态是不是已经在账号池里了」。
 */
function kiroLocalIdentity(refreshToken) {
  const value = String(refreshToken || '').trim();
  if (!value) return '';
  return `kiro-oauth-refresh:${crypto.createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

/** 已入库账号的指纹（账号侧，供 auth-sources 去重）。 */
function kiroAccountIdentity(nativeAuth) {
  const auth = nativeAuth && nativeAuth.auth;
  if (!auth) return '';
  // 优先用**导入时记录的本机指纹**：上游刷新可能轮换 refresh_token，
  // 只比 token 哈希会在下一次刷新后失配、把已入库的登录态又显示成可导入。
  const recorded = String(auth.authSourceFingerprint || '').trim();
  if (recorded) return recorded;
  // 老账号（没有记录过本机指纹）回落到 refresh_token 哈希。
  return kiroLocalIdentity(auth.refresh_token || auth.refreshToken);
}

/** 本机来源的指纹（本机侧）；读不到登录态时返回 ''（调用方据此不做去重判断）。 */
function kiroIdeLocalIdentity(options = {}) {
  const read = readKiroIdeTokenFile(options);
  return read.ok ? kiroLocalIdentity(read.refreshToken) : '';
}

function resolveKiroIdeTokenPath(options = {}) {
  const explicit = String(options.hostHomeDir || '').trim();
  const hostHomeDir = explicit || resolveHostHomeDir({
    hostHomeDir: explicit,
    env: options.env,
    platform: options.platform
  });
  if (!hostHomeDir) return '';
  return nodePath.join(hostHomeDir, ...IDE_TOKEN_RELATIVE_PATH);
}

/** 只读地探测 IDE 登录态文件；任何异常都归一成带原因的失败对象（不抛）。 */
function readKiroIdeTokenFile(options = {}) {
  const fs = options.fs || require('node:fs');
  const tokenPath = resolveKiroIdeTokenPath(options);
  if (!tokenPath) return { ok: false, reason: 'host_home_unavailable', tokenPath: '' };
  let raw = '';
  try {
    raw = fs.readFileSync(tokenPath, 'utf8');
  } catch (error) {
    return {
      ok: false,
      reason: error && error.code === 'ENOENT' ? 'ide_token_file_missing' : 'ide_token_file_unreadable',
      tokenPath
    };
  }
  let document = null;
  try {
    document = JSON.parse(raw);
  } catch (_error) {
    return { ok: false, reason: 'ide_token_file_invalid_json', tokenPath };
  }
  const refreshToken = String((document && document.refreshToken) || '').trim();
  if (!refreshToken) return { ok: false, reason: 'ide_token_missing_refresh_token', tokenPath };
  return {
    ok: true,
    tokenPath,
    refreshToken,
    profileArn: String((document && document.profileArn) || '').trim(),
    provider: String((document && document.provider) || '').trim(),
    authMethod: String((document && document.authMethod) || '').trim()
  };
}

/**
 * 从本机 Kiro IDE 登录态导入凭据（真刷一次再返回，失败带原因）。
 * @returns {Promise<{ok: boolean, auth?: object, profileArn?: string, source?: string, reason?: string}>}
 */
async function importKiroIdeLogin(options = {}) {
  const read = readKiroIdeTokenFile(options);
  if (!read.ok) return { ok: false, reason: read.reason };
  const importToken = options.importKiroRefreshToken || importKiroRefreshToken;
  const sourceFingerprint = kiroLocalIdentity(read.refreshToken);
  try {
    const imported = await importToken({
      refreshToken: read.refreshToken,
      profileArn: read.profileArn,
      provider: read.provider,
      region: options.region,
      request: options.request
    });
    return {
      ok: true,
      source: 'kiro-ide',
      // 把「这份本机登录态」的指纹记在凭据上：下次解析认证来源时据此判定「已入库」，
      // 于是不会重复显示导入入口（上游刷新轮换 token 也不影响）。
      auth: { ...imported.auth, authSourceFingerprint: sourceFingerprint },
      profileArn: imported.profileArn,
      flavour: imported.flavour,
      sourceFingerprint,
      tokenPath: read.tokenPath
    };
  } catch (error) {
    return { ok: false, reason: (error && error.code) || 'kiro_ide_import_failed' };
  }
}

/** 认证来源工厂（与 quota/models 的策略工厂同形：deps → 实现对象）。 */
function createKiroIdeAuthSource(deps = {}) {
  return {
    id: 'kiro-ide-local',
    import: async (options = {}) => importKiroIdeLogin({ ...deps, ...options })
  };
}

module.exports = {
  IDE_TOKEN_RELATIVE_PATH,
  createKiroIdeAuthSource,
  importKiroIdeLogin,
  kiroAccountIdentity,
  kiroIdeLocalIdentity,
  kiroLocalIdentity,
  readKiroIdeTokenFile,
  resolveKiroIdeTokenPath
};
