'use strict';

const { listProviderModelIds } = require('./model-capability-index');

/**
 * 模型目录的「知道」与「否定」。
 *
 * 背景：modelHasAvailableProvider 只会返回真/假，于是两件完全不同的事被压成同一个答案：
 *   1. 目录里确实没有这个模型（真正的否定）；
 *   2. 我们手上压根没有目录（缓存被失效、还没扫过、刚重启）——这是无知，不是否定。
 *
 * 别名预检拿第 2 种当第 1 种用时，一个完全正常的别名（gpt-* → claude-opus-5）会被判成
 * 503 alias_target_model_not_in_catalog：模型明明在，账号也在，只是网关自己把目录清空了。
 *
 * 这个模块只回答一个问题：对某个 provider 而言，我们到底有没有目录事实可用。
 * - 有账号却一个模型都不知道 → 无知，不能拿来否定别名；
 * - 根本没有账号 → 不需要知道，不算无知（否则任何未配置的 provider 都会让别名无条件放行）。
 *
 * 只服务于「运行时路由要不要否定这个别名目标」。别名保存校验必须保持严格，
 * 不要把这里的宽松语义带过去。
 */

function normalizeProvider(value) {
  return String(value || '').trim().toLowerCase();
}

function listStateProviderAccounts(state, provider) {
  const accounts = state && state.accounts && state.accounts[provider];
  return Array.isArray(accounts) ? accounts : [];
}

/**
 * 该 provider 名下是否有账号。
 * 优先看 state.accounts（权威），state 不可用时退回索引登记的账号快照
 * （buildModelCapabilityIndex 会为每个账号登记 accountRef，与它有没有模型无关）。
 */
function providerHasAccounts(index, state, provider) {
  const normalized = normalizeProvider(provider);
  if (!normalized) return false;
  if (listStateProviderAccounts(state, normalized).length > 0) return true;
  const accountByRef = index && index.accountByRef instanceof Map ? index.accountByRef : null;
  if (!accountByRef) return false;
  for (const account of accountByRef.values()) {
    if (normalizeProvider(account && account.provider) === normalized) return true;
  }
  return false;
}

/**
 * 该 provider 的目录是否处于「未知」状态：有账号，却一个模型都不知道。
 */
function providerCatalogIsUnknown(index, state, provider) {
  const normalized = normalizeProvider(provider);
  if (!normalized) return false;
  if (!providerHasAccounts(index, state, normalized)) return false;
  return listProviderModelIds(index, normalized).length === 0;
}

/**
 * 别名目标涉及的 provider 里，只要有一个目录未知，就不能断言「目标不在目录里」。
 * 取 some 而不是 every：目标可能正好属于那个未知的 provider，宁可试一次真实请求。
 */
function aliasTargetCatalogIsUnknown(index, state, providers) {
  const list = (Array.isArray(providers) ? providers : [providers])
    .map(normalizeProvider)
    .filter(Boolean);
  if (list.length === 0) return false;
  return list.some((provider) => providerCatalogIsUnknown(index, state, provider));
}

module.exports = {
  aliasTargetCatalogIsUnknown,
  providerCatalogIsUnknown,
  providerHasAccounts
};
