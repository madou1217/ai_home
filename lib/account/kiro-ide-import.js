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
const { resolveHostHomeDir } = require('../runtime/host-home');
const { importKiroRefreshToken } = require('./kiro-device-login');

const IDE_TOKEN_RELATIVE_PATH = Object.freeze(['.aws', 'sso', 'cache', 'kiro-auth-token.json']);

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
      auth: imported.auth,
      profileArn: imported.profileArn,
      flavour: imported.flavour,
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
  readKiroIdeTokenFile,
  resolveKiroIdeTokenPath
};
