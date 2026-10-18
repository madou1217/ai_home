'use strict';

// 宿主账号扫描的**通用检测器**（注册表倒排，不维护 provider 名单）：
//
//   * `host-auth-projection`：认证来源能力里声明了 `scan` 钩子的 provider（宿主登录态是完整投影，
//     由 host-auth-import 的 createHostAuthSources 默认注入）→ OAuth / 原生登录态入库；
//   * `host-api-key`：凭据端口模块声明了 `hostApiKeySlots` 的 provider → API Key 账号入库。
//
// 两者都返回检测器注册表的统一形状（`{ ok, scanned, updated, reloaded, registered, skipped, accounts }`），
// 由 host-account-detectors.js 的 runHostAccountDetectors 合并；后台观察由
// host-account-sync/generic-host-account-sync.js 复用同一个 run()。

function listScanSources(options = {}) {
  const { listProviders, getProviderCapability } = options.providers || require('../providers');
  const entries = [];
  for (const provider of listProviders('authSources')) {
    const capability = getProviderCapability(provider, 'authSources');
    const sources = capability && Array.isArray(capability.sources) ? capability.sources : [];
    for (const source of sources) {
      if (typeof source.scan === 'function') entries.push({ provider, sourceId: source.id, scan: source.scan });
    }
  }
  return entries;
}

function listProjectionProviders(options = {}) {
  return [...new Set(listScanSources(options).map((entry) => entry.provider))];
}

function listApiKeyProviders() {
  return require('./host-api-key-scan').listHostApiKeyStrategies().map((strategy) => strategy.id);
}

function collectScanOutcomes(outcomes, options) {
  const store = require('../server/account-credential-store');
  const result = { ok: true, scanned: 0, updated: 0, reloaded: false, registered: [], skipped: [], accounts: {} };
  const providers = new Set();
  for (const outcome of outcomes) {
    providers.add(outcome.provider);
    if (outcome.status === 'absent') continue;
    result.scanned += 1;
    if (outcome.status === 'registered') {
      result.updated += 1;
      result.registered.push({
        provider: outcome.provider,
        accountRef: outcome.accountRef || '',
        cliAccountId: outcome.cliAccountId || '',
        created: outcome.created === true
      });
    } else if (outcome.status === 'skipped') {
      result.skipped.push({ reason: outcome.reason, provider: outcome.provider, source: outcome.source || '' });
    }
  }
  for (const provider of providers) {
    try {
      result.accounts[provider] = store.listAccountCredentialRecords(options.fs, options.aiHomeDir, provider).length;
    } catch (_error) {
      result.accounts[provider] = 0;
    }
  }
  return result;
}

function buildScanDeps(options) {
  const { createSelfWriteGuard } = require('./host-self-write-guard');
  return {
    fs: options.fs,
    aiHomeDir: options.aiHomeDir,
    hostHomeDir: options.hostHomeDir,
    guard: options.guard || createSelfWriteGuard({
      fs: options.fs,
      aiHomeDir: options.aiHomeDir,
      readServerConfig: options.readServerConfig
    })
  };
}

function isRunnable(options) {
  return Boolean(options && options.fs && options.aiHomeDir && options.hostHomeDir);
}

/** OAuth / 原生登录态扫描（每个声明了 scan 的来源跑一次；单个来源抛错只记 skip）。 */
function detectHostProjectionAccounts(options = {}) {
  if (!isRunnable(options)) return { ok: false, error: 'detect_host_accounts_unavailable' };
  const deps = buildScanDeps(options);
  const outcomes = listScanSources(options).map((entry) => {
    try {
      return { source: entry.sourceId, ...entry.scan(deps) };
    } catch (_error) {
      return { status: 'skipped', reason: 'host_auth_scan_failed', provider: entry.provider, source: entry.sourceId };
    }
  });
  return collectScanOutcomes(outcomes, options);
}

/** 宿主 API Key 槽位扫描。 */
function detectHostApiKeyAccounts(options = {}) {
  if (!isRunnable(options)) return { ok: false, error: 'detect_host_accounts_unavailable' };
  const { listHostApiKeyStrategies, scanHostApiKeys } = require('./host-api-key-scan');
  const deps = buildScanDeps(options);
  const outcomes = [];
  for (const strategy of listHostApiKeyStrategies()) {
    try {
      outcomes.push(...scanHostApiKeys(strategy, deps).map((outcome) => ({ source: `${strategy.id}-host-api-key`, ...outcome })));
    } catch (_error) {
      outcomes.push({ status: 'skipped', reason: 'host_api_key_scan_failed', provider: strategy.id, source: `${strategy.id}-host-api-key` });
    }
  }
  return collectScanOutcomes(outcomes, options);
}

module.exports = {
  detectHostApiKeyAccounts,
  detectHostProjectionAccounts,
  listApiKeyProviders,
  listProjectionProviders,
  listScanSources
};
