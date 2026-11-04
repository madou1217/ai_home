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

// zai 的手机号账号把手机号合成内部邮箱 `<phone>@phone.local`（与 kimi 同一约定）。
// 它不是可收信邮箱，展示时必须换成裸手机号，否则账号行会出现一个没有意义的地址。
const PHONE_LOCAL_EMAIL_RE = /^(\d{6,})@phone\.local$/i;

function phoneFromPhoneLocalEmail(email) {
  const match = PHONE_LOCAL_EMAIL_RE.exec(normalizeText(email));
  return match ? match[1] : '';
}

function isPhoneLocalEmail(email) {
  return PHONE_LOCAL_EMAIL_RE.test(normalizeText(email));
}

// 1) BigModel 客户信息接口可能给完整 11 位号码，也可能给**已打码**的 11 位
//    （131****1636）；2) 少数上游会带 +86 / 空格。
//
// 关键：掩码里的 `*` 必须保留。若按非数字剥掉，131****1636 会变成 1311636
// （前三位 + 后四位拼接），既不是完整号码也不是合法掩码 —— 与 codebuddycn 同一坑。
// 中国号统一成 `3 位 + **** + 4 位`；其余形状不猜。
function normalizePhone(value) {
  const raw = normalizeText(value).replace(/[\s-]/g, '');
  if (!raw) return '';
  if (raw.includes('*')) {
    const local = raw.replace(/^\+?86/, '');
    const masked = /^(\d{3})\*+(\d{4})$/.exec(local);
    return masked ? `${masked[1]}****${masked[2]}` : '';
  }
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  const local = digits.length === 13 && digits.startsWith('86') ? digits.slice(2) : digits;
  return /^\d{6,15}$/.test(local) ? local : '';
}

// 手机号账号的 displayName 形如「旅行者0378」（昵称 + 手机尾号）。尾号只是上游
// 用来区分同名账号的提示，不是昵称的一部分；手机号本身会作为独立的 phone 项展示，
// 所以这里把尾号从昵称里去掉。取不到前缀时保持原样，不把名字变成空串。
function stripPhoneSuffixFromDisplayName(displayName, phone) {
  const name = normalizeText(displayName);
  const digits = normalizeText(phone);
  if (!name || digits.length < 4) return name;
  const suffix = digits.slice(-4);
  if (!name.endsWith(suffix)) return name;
  const stripped = name.slice(0, -suffix.length).trim();
  return stripped || name;
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
 * @returns {{email: string, phone: string, displayName: string, userId: string, avatar: string}}
 *   email 在 bigmodel 区可能是上游打码形式（`ma****17@126.com`）—— 那是上游给的
 *   唯一邮箱事实，**原样展示**，不要试图还原（打码是上游的隐私决定）；zai 手机号
 *   账号的 email 是 `<phone>@phone.local`，同时给出裸手机号 phone，展示层应优先用 phone。
 */
function resolveZcodeAccountIdentity(userInfo) {
  const source = userInfo && typeof userInfo === 'object' ? userInfo : {};
  const email = pickByPaths(source, [
    'email',
    'rawProfile.email',
    'user.email',
    'profile.email'
  ]);
  // 手机号来源：BigModel 客户信息接口补进来的 phoneNumber 优先；没有时再从
  // zai 的 `<phone>@phone.local` 合成邮箱里提取。展示名里的手机尾号会同步去掉。
  // email 本身保留原值，让调用方自行决定是否展示（WebUI 会置空）。
  const phone = normalizePhone(pickByPaths(source, [
    'phoneNumber',
    'rawProfile.phoneNumber',
    'phone'
  ])) || phoneFromPhoneLocalEmail(email);
  // 展示名优先 displayName / username（bigmodel 的 app 内名称在 displayName），
  // 再退到 name，最后用邮箱。
  const rawDisplayName = pickByPaths(source, [
    'displayName',
    'username',
    'name',
    'rawProfile.name',
    'rawProfile.displayName',
    'nickname'
  ]);
  const displayName = stripPhoneSuffixFromDisplayName(rawDisplayName, phone);
  const userId = pickByPaths(source, [
    'user_id',
    'userId',
    'id',
    'rawProfile.user_id'
  ]);
  const avatar = pickByPaths(source, ['avatar', 'rawProfile.avatar']);
  return { email, phone, displayName, userId, avatar };
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
  const { email, phone, displayName } = resolveZcodeAccountIdentity(userInfo);
  // 归一化后的 user_info 会把邮箱同时写进 displayName（上游没给名字时），
  // 打码邮箱同样不能当展示名。
  if (displayName && !isMaskedEmail(displayName)) return displayName;
  // 手机号账号没有可读昵称时，直接用完整手机号，绝不把 `@phone.local` 当名字。
  if (phone) return phone;
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
  const { email, phone, displayName, userId } = resolveZcodeAccountIdentity(userInfo);
  // 真实邮箱优先；`@phone.local` 是内部占位地址，改用裸手机号作为账号标识。
  if (email && !isPhoneLocalEmail(email)) return email;
  if (phone) return phone;
  if (displayName) return displayName;
  return userId;
}

module.exports = {
  resolveZcodeAccountIdentity,
  normalizeZcodeUserProfile,
  resolveZcodeDisplayName,
  resolveZcodeAccountLabel,
  isMaskedEmail,
  isPhoneLocalEmail,
  normalizePhone,
  phoneFromPhoneLocalEmail,
  stripPhoneSuffixFromDisplayName,
  // 供其它区域/结构扩展时复用（也是本文件纪律的执行者）。
  pickByPaths,
};
