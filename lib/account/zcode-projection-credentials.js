'use strict';

// 投影凭据里 user_info 的**就地归一化**（存量账号的修复路径）。
//
// 背景（2026-11-03 真机）：aih 的登录写入器过去把上游 user_info 原样存进
// `oauth:<region>:user_info`。bigmodel 的上游结构是 `{user_id,email,avatar,name}`，
// 而 ZCode 桌面端 `loadUserProfile` 只认 `{id,username,displayName}` 三个字符串
// （zai 有旧格式兜底，bigmodel 没有）→ 解析成 null → `resolveCurrentAccountAccess`
// 返回 null → providerCount 0 → 界面「请先登录或配置 API Key」。
//
// 写入器已经改成落盘前归一化（lib/server/zcode-credential-writer.js），但**已经登录过
// 的账号**快照里仍是旧形状。每次启动前把投影文件就地修一遍，用户不必重新登录；
// 归一化后的形状与桌面端自己写的一致，因此修复是幂等的（第二次读到的已经是目标形状）。
//
// 只动 user_info 一个键：token、refresh_token、project-key-location 一律原样保留。

const nodePath = require('node:path');
const {
  decryptZcodeCredentialValue,
  encryptZcodeCredentialValue,
  isEncryptedZcodeCredentialValue
} = require('./zcode-credential');
const { normalizeZcodeUserProfile } = require('./zcode-identity');

const ZCODE_USER_INFO_KEY_PATTERN = /^oauth:([^:]+):user_info$/;

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** 桌面端 loadUserProfile 的准入条件：三个字段都是字符串。 */
function hasDesktopProfileShape(value) {
  return Boolean(value)
    && typeof value.id === 'string'
    && typeof value.username === 'string'
    && typeof value.displayName === 'string';
}

/**
 * 就地修复 `<sandbox>/.zcode/v2/credentials.json` 里的 user_info。
 *
 * @param {{fs?: any, path?: any, sandboxDir: string}} input
 * @returns {{repaired: string[], skipped: string[], errors: string[]}}
 */
function repairZcodeProjectionCredentialProfile(input = {}) {
  const fs = (input && input.fs) || require('node:fs');
  const path = (input && input.path) || nodePath;
  const sandboxDir = normalizeText(input && input.sandboxDir);
  const result = { repaired: [], skipped: [], errors: [] };
  if (!sandboxDir) return result;

  const credentialsPath = path.join(sandboxDir, '.zcode', 'v2', 'credentials.json');
  let raw;
  try {
    raw = fs.readFileSync(credentialsPath, 'utf8');
  } catch (error) {
    // 还没登录（或账号刚建）时文件不存在，属于正常路径。
    if (error && error.code === 'ENOENT') return result;
    result.errors.push(`read:${(error && error.code) || 'error'}`);
    return result;
  }

  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch (_error) {
    result.errors.push('parse:invalid_json');
    return result;
  }
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
    result.errors.push('parse:not_object');
    return result;
  }

  let changed = false;
  for (const key of Object.keys(credentials)) {
    const match = ZCODE_USER_INFO_KEY_PATTERN.exec(key);
    if (!match) continue;
    const stored = credentials[key];
    // 老投影里 zai 的 user_info 可能是**明文 JSON**（历史写入路径没加密）。
    // 保持原有存储形态：明文就地改明文、密文就地改密文，不要顺手改变加密契约。
    const encrypted = isEncryptedZcodeCredentialValue(stored);
    const plain = encrypted ? decryptZcodeCredentialValue(stored) : stored;
    if (!plain || typeof plain !== 'string') {
      result.skipped.push(key);
      continue;
    }
    let user;
    try {
      user = JSON.parse(plain);
    } catch (_error) {
      result.skipped.push(key);
      continue;
    }
    if (hasDesktopProfileShape(user)) {
      result.skipped.push(key);
      continue;
    }
    const profile = normalizeZcodeUserProfile(user, { region: match[1] });
    if (!profile) {
      result.skipped.push(key);
      continue;
    }
    credentials[key] = encrypted
      ? encryptZcodeCredentialValue(JSON.stringify(profile))
      : JSON.stringify(profile);
    result.repaired.push(key);
    changed = true;
  }

  if (!changed) return result;
  try {
    fs.writeFileSync(credentialsPath, JSON.stringify(credentials, null, 2));
  } catch (error) {
    result.errors.push(`write:${(error && error.code) || 'error'}`);
  }
  return result;
}

module.exports = {
  repairZcodeProjectionCredentialProfile,
  hasDesktopProfileShape
};
