'use strict';

// 「新增账号时是否进入别名自动选号池」的唯一应用点。
//
// 账号创建有三条入口——api-key / vertex 立即建账号、OAuth 登录任务（含本机登录态完成登录
// 任务）、本机登录态直接导入——三条都用同一个请求字段 `aliasPoolParticipates`（缺省＝参与），
// 语义与账号级开关（lib/account/alias-pool-store.js）完全一致。
//
// 默认参与时**不写库**：读侧没有记录即默认参与，只在显式 false 时写一条记录，因此正常新增
// 不会给每个账号都留一条冗余配置。
//
// 创建已经成功时偏好写入失败不该把整次创建判失败（账号级「别名选号」弹窗仍可再改），
// 因此这里是 best-effort：返回 error 让调用方决定怎么提示，不抛出。

const { writeAliasPoolConfig } = require('./alias-pool-store');

/** 请求字段 → 偏好。字段缺席或非布尔一律按默认「参与」处理。 */
function readAliasPoolParticipates(payload) {
  return !(payload && payload.aliasPoolParticipates === false);
}

/**
 * 把偏好落到账号记录上。只在显式「不参与」时写库。
 *
 * @returns {{ applied: boolean, error: string }} applied 为真表示真的写入了记录
 */
function applyAliasPoolPreference(fs, aiHomeDir, accountRef, participates) {
  if (participates !== false || !String(accountRef || '').trim()) {
    return { applied: false, error: '' };
  }
  try {
    writeAliasPoolConfig(fs, aiHomeDir, accountRef, { participates: false });
    return { applied: true, error: '' };
  } catch (error) {
    return { applied: false, error: String((error && error.message) || error || 'alias_pool_preference_failed') };
  }
}

module.exports = {
  applyAliasPoolPreference,
  readAliasPoolParticipates
};
