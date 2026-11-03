'use strict';

// 会话级模型改写（`--model-alias`）里的**路由钉选**：目标写成 `provider.model` 或
// `provider.账号.model` 时，请求必须落到那个 Provider / 账号，而不只是换个模型名。
//
// 抽成独立模块是因为它需要读一次账号库（CLI 编号 → 持久 accountRef），而 v1-router 的
// 请求处理很难被单测直接驱动；钉选规则本身必须能被穷举覆盖。
//
// 账号位两种写法：
//   kiro.1.glm-5        → kiro 的 CLI 账号 #1（与 `aih kiro 1` 同一个编号空间）
//   kiro.acct_xxx.glm-5 → 直接给持久 accountRef
// 解析不到时**报错**而不是悄悄换号：显式指定账号是用户的明确指令。

const { isAccountRef, resolveAccountRefByCliId } = require('./account-ref-store');

/**
 * @returns {null | {provider: string, accountRef: string, error?: string, account?: string}}
 */
function resolveSessionModelAliasPin(input = {}) {
  const rule = input.rule;
  if (!rule || typeof rule !== 'object') return null;
  const provider = String(rule.provider || '').trim().toLowerCase();
  const account = String(rule.account || '').trim();
  if (!provider && !account) return null;
  if (!account) return { provider, accountRef: '' };
  if (isAccountRef(account)) return { provider, accountRef: account };
  const record = resolveAccountRefByCliId(
    input.fs,
    input.aiHomeDir,
    provider,
    account,
    { bestEffort: true }
  );
  if (!record || !record.accountRef) {
    return { provider, accountRef: '', account, error: 'model_alias_account_not_found' };
  }
  return { provider, accountRef: record.accountRef };
}

module.exports = { resolveSessionModelAliasPin };
