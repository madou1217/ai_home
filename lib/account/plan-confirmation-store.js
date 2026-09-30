'use strict';

// 套餐实时确认记录：额度接口在某个时间确认过某个套餐（planType + confirmedAtMs）。
//
// 它和额度快照分开存，是因为同一份快照会被不同版本的进程写：长期运行的终端会话
// 用启动时加载的旧代码每分钟刷新一次额度，写出的快照不带确认时间，会把新代码刚记下的
// 确认冲掉。单独的键旧进程不会碰；读取时只在套餐一致时合并回快照，套餐变了就不作数。

const { readJsonValue, writeJsonValue } = require('../server/app-state-store');

function buildPlanConfirmationKey(accountRef) {
  return `account:plan-confirmed:${accountRef}`;
}

function recordPlanConfirmation(fs, aiHomeDir, accountRef, snapshot) {
  const account = snapshot && snapshot.account;
  const planType = String(account && account.planType || '').trim();
  const confirmedAtMs = Number(account && account.planConfirmedAtMs) || 0;
  if (!accountRef || !planType || !confirmedAtMs) return false;
  const key = buildPlanConfirmationKey(accountRef);
  const current = readJsonValue(fs, aiHomeDir, key);
  if (current && Number(current.confirmedAtMs) >= confirmedAtMs && current.planType === planType) return false;
  return writeJsonValue(fs, aiHomeDir, key, { planType, confirmedAtMs });
}

// 把确认记录合并进快照：只在套餐一致、且比快照自带的确认更新时生效。
function withPlanConfirmation(fs, aiHomeDir, accountRef, snapshot) {
  const account = snapshot && snapshot.account;
  if (!account || typeof account !== 'object') return snapshot;
  const stored = readJsonValue(fs, aiHomeDir, buildPlanConfirmationKey(accountRef));
  const storedAt = Number(stored && stored.confirmedAtMs) || 0;
  if (!storedAt || String(stored.planType || '') !== String(account.planType || '').trim()) return snapshot;
  if (storedAt <= (Number(account.planConfirmedAtMs) || 0)) return snapshot;
  return { ...snapshot, account: { ...account, planConfirmedAtMs: storedAt } };
}

module.exports = {
  buildPlanConfirmationKey,
  recordPlanConfirmation,
  withPlanConfirmation
};
