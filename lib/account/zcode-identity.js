'use strict';

// zcode 账号身份的**唯一解析点** —— 两个区域的 user_info 结构不同，必须在这里收敛。
//
// 实测（2026-10-26，真机凭据）：
//
//   zai 区（扁平）：
//     { "user_id": "be3d750d-…", "email": "madou1217@126.com", "name": "Deo Mea",
//       "avatar": "https://…" }
//
//   bigmodel 区（嵌套，且邮箱被上游**打码**）：
//     { "id": "23701694489963901", "username": "MeaDeo", "displayName": "MeaDeo",
//       "rawProfile": { "user_id": "23701694489963901", "email": "ma****17@126.com",
//                       "name": "MeaDeo", "zcodeProfileSchemaVersion": 2 } }
//
// 此前调用方一律读 `userInfo.email` / `userInfo.name`，于是 bigmodel 账号这两个字段
// 都在嵌套层里取不到，界面只剩泛型的「ZCode OAuth」——真机表现就是「少了邮箱」。
//
// 纪律：调用方**不要**再自己 `userInfo.email` 兜底，一律走这里；新增区域只在本文件
// 加一条候选路径，不在业务代码里加分支。

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 从任意深度的对象里按候选路径取第一个非空字符串。
 * @param {object} source
 * @param {string[]} paths 点分路径，如 'rawProfile.email'
 */
function pickByPaths(source, paths) {
  for (const path of paths) {
    let cursor = source;
    for (const segment of String(path).split('.')) {
      if (!cursor || typeof cursor !== 'object') { cursor = null; break; }
      cursor = cursor[segment];
    }
    const value = normalizeText(cursor);
    if (value) return value;
  }
  return '';
}

/**
 * 解析 zcode 账号身份（区域无关）。
 *
 * @param {object} userInfo 凭据里的 user_info 对象（两种结构都接受）
 * @returns {{email: string, displayName: string, userId: string, avatar: string}}
 *   email 在 bigmodel 区可能是上游打码形式（`ma****17@126.com`）—— 那是上游给的
 *   唯一邮箱事实，**原样展示**，不要试图还原（打码是上游的隐私决定）。
 */
function resolveZcodeAccountIdentity(userInfo) {
  const source = userInfo && typeof userInfo === 'object' ? userInfo : {};
  const email = pickByPaths(source, [
    'email',
    'rawProfile.email',
    'user.email',
    'profile.email'
  ]);
  // 展示名优先 displayName / username（bigmodel 的 app 内名称在 displayName），
  // 再退到 name，最后用邮箱。
  const displayName = pickByPaths(source, [
    'displayName',
    'username',
    'name',
    'rawProfile.name',
    'rawProfile.displayName',
    'nickname'
  ]);
  const userId = pickByPaths(source, [
    'user_id',
    'userId',
    'id',
    'rawProfile.user_id'
  ]);
  const avatar = pickByPaths(source, ['avatar', 'rawProfile.avatar']);
  return { email, displayName, userId, avatar };
}

/**
 * 把上游 user_info 归一化成 ZCode 桌面端认识的形状。
 *
 * 桌面端 `OAuthCredentialRepo.loadUserProfileFromKey` 只认
 * `{id, username, displayName}` 三个**字符串**字段；zai 另有一条旧格式兜底
 * （`toOAuthUserProfileFromRawZaiUser`，读 user_id/name/email/avatar），bigmodel
 * **没有**兜底。aih 以前把上游 user_info 原样写盘，bigmodel 的
 * `{user_id,email,avatar,name}` 于是被解析成 null →
 * `resolveCurrentAccountAccess` 返回 null → providerCount 0 → 界面「请先登录」
 * （2026-11-03 真机：登录明明成功，打开桌面端却要求重新登录）。
 *
 * 字段优先级与桌面端自己的 BigModel 适配器一致：id 取 customerNumber/user_id，
 * 展示名取 customerName/nickName/name，再退到邮箱、最后 id。`rawProfile` 原样
 * 保留（桌面端会把它当作缓存原文，zai 的旧格式解析也依赖它）。
 *
 * @param {object} user 上游 user_info（两种区域结构都接受）
 * @param {{region?: string}} [options]
 * @returns {{id: string, username: string, displayName: string, avatarUrl?: string, rawProfile: object}|null}
 *   无法得出 id 或展示名时返回 null（调用方应保持原样，不要写半截身份）。
 */
function normalizeZcodeUserProfile(user, options = {}) {
  if (!user || typeof user !== 'object' || Array.isArray(user)) return null;
  const id = pickByPaths(user, ['customerNumber', 'user_id', 'userId', 'id', 'sub']);
  const name = pickByPaths(user, ['customerName', 'nickName', 'name', 'username', 'display_name']);
  const email = pickByPaths(user, ['email']);
  const label = name || email || id;
  if (!id || !label) return null;
  const avatar = pickByPaths(user, ['avatar', 'avatarUrl', 'avatar_url', 'picture']);
  const rawProfile = options.region === 'bigmodel'
    // 桌面端用这个版本号判断「缓存的 BigModel 身份是否需要重新拉取」；写进去
    // 就表示这份已经是归一化后的 v2 形状，启动时不再多打一次上游。
    ? { ...user, zcodeProfileSchemaVersion: 2 }
    : { ...user };
  return {
    id,
    username: label,
    displayName: label,
    ...(avatar ? { avatarUrl: avatar } : {}),
    rawProfile
  };
}

/**
 * 账号记录用的展示名。
 *
 * 刻意**不用打码邮箱**兜底：`ma****17@126.com` 对用户没有辨识价值，用它当显示名
 * 反而比一个干净的名字更差。优先 displayName，其次完整（未打码）邮箱，最后泛型。
 */
function resolveZcodeDisplayName(userInfo, fallback = 'ZCode OAuth') {
  const { email, displayName } = resolveZcodeAccountIdentity(userInfo);
  // 归一化后的 user_info 会把邮箱同时写进 displayName（上游没给名字时），
  // 打码邮箱同样不能当展示名。
  if (displayName && !isMaskedEmail(displayName)) return displayName;
  if (email && !isMaskedEmail(email)) return email;
  return normalizeText(fallback) || 'ZCode OAuth';
}

/** 上游打码邮箱形如 `ma****17@126.com`（本地部分含 *）。 */
function isMaskedEmail(email) {
  const value = normalizeText(email);
  if (!value || !value.includes('@')) return false;
  return value.slice(0, value.lastIndexOf('@')).includes('*');
}

/** 账号标识（进账号记录 email 字段）：有邮箱用邮箱，否则用用户名/数字 id。 */
function resolveZcodeAccountLabel(userInfo) {
  const { email, displayName, userId } = resolveZcodeAccountIdentity(userInfo);
  if (email) return email;
  if (displayName) return displayName;
  return userId;
}

module.exports = {
  resolveZcodeAccountIdentity,
  normalizeZcodeUserProfile,
  resolveZcodeDisplayName,
  resolveZcodeAccountLabel,
  isMaskedEmail,
  // 供其它区域/结构扩展时复用（也是本文件纪律的执行者）。
  pickByPaths,
};
