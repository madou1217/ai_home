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
 * 账号记录用的展示名。
 *
 * 刻意**不用打码邮箱**兜底：`ma****17@126.com` 对用户没有辨识价值，用它当显示名
 * 反而比一个干净的名字更差。优先 displayName，其次完整（未打码）邮箱，最后泛型。
 */
function resolveZcodeDisplayName(userInfo, fallback = 'ZCode OAuth') {
  const { email, displayName } = resolveZcodeAccountIdentity(userInfo);
  if (displayName) return displayName;
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
  resolveZcodeDisplayName,
  resolveZcodeAccountLabel,
  isMaskedEmail,
  // 供其它区域/结构扩展时复用（也是本文件纪律的执行者）。
  pickByPaths,
};
