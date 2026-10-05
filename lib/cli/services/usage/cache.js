'use strict';

const { getAppStateDbPath } = require('../../../server/app-state-store');
const {
  readAccountUsageSnapshot,
  writeAccountUsageSnapshot
} = require('../../../account/usage-snapshot-store');
const { isAccountRef } = require('../../../server/account-ref-store');
const {
  USAGE_SNAPSHOT_KINDS,
  USAGE_SOURCE_KIMI,
  USAGE_SOURCE_ZCODE,
  USAGE_SOURCE_CODEBUDDY
} = require('../../../account/usage-remaining');
const { CODEBUDDY_FAMILY_PROVIDERS } = require('../../../account/codebuddy-billing');

const CODEBUDDY_FAMILY_CLI_NAMES = new Set(CODEBUDDY_FAMILY_PROVIDERS);

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

  const trustedClaudeUsageSources = new Set([
    usageSourceClaudeOauth,
    usageSourceClaudeAuthToken
  ]);

  // 各 provider 可信用量快照的 kind / 来源 / 数据形状（entries 或 models）。
  // CodeBuddy 家族四支共用一个 kind / source（同地区 work/code 是同一账号、同一接口）。
  const codebuddyRule = { kind: USAGE_SNAPSHOT_KINDS.codebuddy, sources: new Set([USAGE_SOURCE_CODEBUDDY]), shape: 'entries' };
  const trustedSnapshotRules = new Map([
    ['gemini', { kind: 'gemini_oauth_stats', sources: new Set([usageSourceGemini]) }],
    ['codex', { kind: 'codex_oauth_status', sources: new Set([usageSourceCodex]) }],
    ['claude', { kind: 'claude_oauth_usage', sources: trustedClaudeUsageSources }],
    ['agy', { kind: 'agy_code_assist_quota', sources: new Set([usageSourceAgyCodeAssist || 'agy_fetch_available_models']), shape: 'models' }],
    ['kimi', { kind: USAGE_SNAPSHOT_KINDS.kimi, sources: new Set([USAGE_SOURCE_KIMI]), shape: 'entries' }],
    ['zcode', { kind: USAGE_SNAPSHOT_KINDS.zcode, sources: new Set([USAGE_SOURCE_ZCODE]), shape: 'entries' }],
    ...[...CODEBUDDY_FAMILY_CLI_NAMES].map((provider) => [provider, codebuddyRule])
  ]);

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
    const rule = trustedSnapshotRules.get(cliName);
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
