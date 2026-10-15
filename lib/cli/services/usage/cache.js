'use strict';

const { getAppStateDbPath } = require('../../../server/app-state-store');
const {
  readAccountUsageSnapshot,
  writeAccountUsageSnapshot
} = require('../../../account/usage-snapshot-store');
const { isAccountRef } = require('../../../server/account-ref-store');
const { resolveQuotaTrustRule } = require('../../../usage/quota');

function createUsageCacheService(options = {}) {
  const {
    fs,
    aiHomeDir,
    usageSnapshotSchemaVersion,
    usageSourceGemini,
    usageSourceCodex,
    usageSourceClaudeOauth,
    usageSourceClaudeAuthToken,
    usageSourceAgyCodeAssist
  } = options;

  // 可信快照规则（kind / source / 数据形状）由 provider 自己的描述符给出
  // （lib/providers/defs/<id>.js 的 quota 能力）——这里不再维护第二份 provider 名单，
  // 也不再从装配参数传 source 常量（事实只有一个来源）。

  function getUsageCachePath(_cliName, accountRef) {
    return isAccountRef(accountRef) ? getAppStateDbPath(aiHomeDir) : '';
  }

  function writeUsageCache(_cliName, accountRef, payload) {
    try {
      writeAccountUsageSnapshot(fs, aiHomeDir, accountRef, payload);
    } catch (_error) {
      // best effort cache
    }
  }

  function isTrustedUsageSnapshot(cliName, snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return false;
    if (snapshot.schemaVersion !== usageSnapshotSchemaVersion) return false;
    if (!snapshot.capturedAt || !Number.isFinite(Number(snapshot.capturedAt))) return false;

    // 只有登记了来源规则的 provider 才有可信的剩余额度快照；kind、来源与数据形状必须同时匹配。
    const rule = resolveQuotaTrustRule(cliName);
    if (!rule) return false;
    if (snapshot.kind !== rule.kind || !rule.sources.has(snapshot.source)) return false;
    return !rule.shape || Array.isArray(snapshot[rule.shape]);
  }

  function readUsageCache(cliName, accountRef) {
    try {
      const parsed = readAccountUsageSnapshot(fs, aiHomeDir, accountRef);
      if (!isTrustedUsageSnapshot(cliName, parsed)) return null;
      return parsed;
    } catch (_error) {
      return null;
    }
  }

  return {
    getUsageCachePath,
    writeUsageCache,
    readUsageCache,
    isTrustedUsageSnapshot
  };
}

module.exports = {
  createUsageCacheService
};
