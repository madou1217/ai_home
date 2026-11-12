'use strict';

// 账号活动的「展示身份」解析：任务队列与 SSE 事件只允许展示这些值。
//
// 为什么不在队列里显示 accountRef：acct_xxx 是内部主键，用户无法从它认出账号；
// 账号页已经有 displayNames（邮箱 / 手机号 / 昵称 / CLI ID 轮播），队列必须同口径。
//
// 事实来源（按优先级）：
//   1. 运行池账号（state.accounts[provider]）—— 有 displayName / email / phone；
//   2. 凭据探针 readFastAccountPresence() —— zcode / 家族这类凭据里带身份，
//      运行池里没有的账号也能给出邮箱、手机号、昵称；
//   3. 记录上的 displayName / email（兜底）；
//   4. 最后才用 CLI 数字 ID（aih <provider> <id> 的参照），绝不用 acct_xxx。

const { buildAccountDisplayNames } = require('./account-display-identity');
const { readFastAccountPresence } = require('./account-presence-probes');

function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function findRuntimeAccount(state, provider, accountRef) {
  const pool = state && state.accounts && state.accounts[provider];
  if (!Array.isArray(pool) || !accountRef) return null;
  return pool.find((account) => normalizeText(account && account.accountRef) === accountRef) || null;
}

function resolveActivityAccountIdentity(ctx, provider, accountRef, record) {
  const normalizedProvider = normalizeText(provider).toLowerCase();
  const normalizedRef = normalizeText(accountRef);
  const runtimeAccount = findRuntimeAccount(ctx && ctx.state, normalizedProvider, normalizedRef);
  let presence = {};
  try {
    presence = readFastAccountPresence(normalizedProvider, record) || {};
  } catch (_error) {
    presence = {};
  }

  const displayName = normalizeText(
    presence.displayName
    || (runtimeAccount && runtimeAccount.displayName)
    || (record && record.displayName)
  );
  const email = normalizeText(
    presence.email
    || (runtimeAccount && runtimeAccount.email)
    || (record && record.email)
  );
  const phone = normalizeText(
    presence.phone
    || (runtimeAccount && runtimeAccount.phone)
  );
  const apiKeyMode = Boolean(
    presence.apiKeyMode
    || (runtimeAccount && runtimeAccount.apiKeyMode)
  );
  const displayNames = buildAccountDisplayNames({
    provider: normalizedProvider,
    displayName,
    nickname: presence.nickname,
    phone,
    email,
    apiKeyMode
  });

  const displayId = normalizeText(
    (runtimeAccount && runtimeAccount.cliAccountId)
    || (record && record.cliAccountId)
  );

  if (displayNames.length > 0) {
    return { provider: normalizedProvider, displayId, displayNames };
  }
  if (displayId) {
    return {
      provider: normalizedProvider,
      displayId,
      displayNames: [{ type: 'name', value: `#${displayId}` }]
    };
  }
  // 连展示身份都没有：只给 Provider，不泄漏内部 ref。队列仍能看出「在跑哪个平台」。
  return {
    provider: normalizedProvider,
    displayId: '',
    displayNames: normalizedProvider ? [{ type: 'name', value: normalizedProvider.toUpperCase() }] : []
  };
}

/** 单个账号的主展示名（用于 label / 日志）；没有 displayNames 时返回空串。 */
function primaryActivityAccountLabel(identity) {
  const names = identity && Array.isArray(identity.displayNames) ? identity.displayNames : [];
  return normalizeText(names[0] && names[0].value);
}

/**
 * 给每个 target 附加 identity。targets 的形状是 { provider, record, missing? }，
 * 由路由层在 start 前一次解析，后续事件与任务快照直接复用。
 */
function attachActivityTargetIdentities(ctx, targets) {
  return (Array.isArray(targets) ? targets : []).map((target) => {
    const provider = normalizeText(target && target.provider).toLowerCase();
    const record = target && target.record && typeof target.record === 'object' ? target.record : {};
    return {
      ...target,
      identity: resolveActivityAccountIdentity(ctx, provider, record.accountRef, record)
    };
  });
}

module.exports = {
  attachActivityTargetIdentities,
  findRuntimeAccount,
  primaryActivityAccountLabel,
  resolveActivityAccountIdentity
};
