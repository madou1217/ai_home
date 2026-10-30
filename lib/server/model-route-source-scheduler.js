'use strict';

const { selectionWeight } = require('./account-selection-load');

/**
 * 别名路线与原生路线共用一个账号池的「先走哪条」决策。
 *
 * 一个请求模型可能同时有两条来源：原生（claude 账号直接服务 claude-opus-5-5）与别名
 * （claude-* → kiro claude-opus-5.5）。两边的账号属于同一个池，应按同一个选号策略
 * （account-selector / account-selection-load）分配，而不是按来源对半轮转：对半轮转下
 * 1 个原生账号会和 10 个 kiro 账号平分首选流量。
 *
 * 做法：把两边可调度账号合起来，按选号器同一个权重（剩余额度 / 在途压力）抽一个，
 * 抽中的账号属于哪条路线就先走哪条；该路线内部仍由原有选号器挑具体账号，失败后照旧
 * 换到另一条路线。每条路线各自带上游模型名，所以「同一池、不同上游名」不需要改请求链。
 *
 * 显式 round-robin 策略下按账号数加权轮转，保持「轮转」语义但不再对半分。
 */
function orderModelRouteSources(input = {}) {
  const hasAlias = Boolean(input.hasAlias);
  const hasNative = Boolean(input.hasNative);
  if (!hasAlias) return hasNative ? ['native'] : [];
  if (!hasNative) return ['alias'];

  const aliasAccounts = Array.isArray(input.aliasAccounts) ? input.aliasAccounts : [];
  const nativeAccounts = Array.isArray(input.nativeAccounts) ? input.nativeAccounts : [];
  if (aliasAccounts.length < 1 && nativeAccounts.length < 1) return legacyAlternate(input);
  if (aliasAccounts.length < 1) return ['native', 'alias'];
  if (nativeAccounts.length < 1) return ['alias', 'native'];

  const strategy = String(input.strategy || 'random').trim().toLowerCase();
  if (strategy === 'round-robin') return roundRobinByAccountCount(input, aliasAccounts.length, nativeAccounts.length);

  const random = typeof input.random === 'function' ? input.random : Math.random;
  const weigh = (entry) => selectionWeight(entry.account, input.accountActivity, entry.provider);
  const aliasWeight = aliasAccounts.reduce((sum, entry) => sum + weigh(entry), 0);
  const nativeWeight = nativeAccounts.reduce((sum, entry) => sum + weigh(entry), 0);
  const total = aliasWeight + nativeWeight;
  if (!Number.isFinite(total) || total <= 0) return roundRobinByAccountCount(input, aliasAccounts.length, nativeAccounts.length);
  return random() * total < aliasWeight ? ['alias', 'native'] : ['native', 'alias'];
}

function readCursor(input) {
  const cursors = input.cursors && typeof input.cursors === 'object' ? input.cursors : {};
  const cursorKey = String(input.cursorKey || 'alias-native').trim() || 'alias-native';
  const cursor = Math.max(0, Number(cursors[cursorKey]) || 0);
  return { cursors, cursorKey, cursor };
}

// 账号数加权轮转：每 (alias + native) 次里，别名先走 alias 次，原生先走 native 次。
function roundRobinByAccountCount(input, aliasCount, nativeCount) {
  const { cursors, cursorKey, cursor } = readCursor(input);
  const period = aliasCount + nativeCount;
  cursors[cursorKey] = (cursor + 1) % period;
  return (cursor % period) < aliasCount ? ['alias', 'native'] : ['native', 'alias'];
}

// 两边都没有账号快照（冷启动 / 调用方未传）：保持旧的交替行为，不凭空偏向某一边。
function legacyAlternate(input) {
  const { cursors, cursorKey, cursor } = readCursor(input);
  cursors[cursorKey] = (cursor + 1) % 2;
  return cursor % 2 === 0 ? ['alias', 'native'] : ['native', 'alias'];
}

module.exports = {
  orderModelRouteSources
};
