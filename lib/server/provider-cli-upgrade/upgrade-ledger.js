'use strict';

// 自动升级的状态账本：~/.ai_home/run/provider-cli-upgrade.json。
//
// server 进程本身已由 acquireServerInstanceLock 保证唯一，所以这里不需要额外的锁文件，
// 只要保证「写」是原子的，崩在半路不会留下半截 JSON。仓库内既有约定是内联 tmp + rename
// （见 server.js:1330-1335），照此办理，不新造抽象。
//
// knownGoodRollbackable 必须单列，不能用 knownGoodVersion 是否存在来推断：
// 一个版本「验证通过」不等于「回得去」——它可能已被 unpublish，或者当前渠道根本不支持
// 钉版本。这个标志为 false 时该 provider 只能降级为 check-only，否则「只从已验证基线升级」
// 这条规则仍会把机器卡在无路可退的位置。

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const { resolveAihRunPath } = require('../../runtime/aih-storage-layout');

const LEDGER_FILE = 'provider-cli-upgrade.json';
const SCHEMA_VERSION = 1;
const HISTORY_LIMIT = 20;

const DEFAULT_PROVIDER_RECORD = Object.freeze({
  state: 'unknown',
  channel: '',
  ownerPath: '',
  resolvedPath: '',
  installedVersion: '',
  latestVersion: '',
  targetVersion: '',
  knownGoodVersion: '',
  knownGoodRollbackable: false,
  baselineHealthy: null,
  userPin: '',
  enabled: true,
  disabledReason: '',
  blockedVersions: [],
  shadowedNpmInstall: false,
  lastCheckAt: 0,
  lastCheckError: '',
  soakUnknownCount: 0,
  lastApplyAt: 0,
  lastApplyError: '',
  consecutiveFailures: 0,
  consecutiveDefers: 0,
  consecutiveQuiescentTicks: 0,
  lastDeferReason: '',
  history: []
});

function ledgerPath(aiHomeDir) {
  return resolveAihRunPath(aiHomeDir, LEDGER_FILE);
}

function emptyLedger() {
  return { schemaVersion: SCHEMA_VERSION, global: { enabled: true, disabledReason: '' }, providers: {} };
}

function readLedger(aiHomeDir, options = {}) {
  const fsImpl = options.fs || nodeFs;
  const target = ledgerPath(aiHomeDir);
  if (!target) return emptyLedger();
  try {
    const parsed = JSON.parse(fsImpl.readFileSync(target, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyLedger();
    // 未来版本写的账本不要强行解读，宁可从空白重来也不要按错误的语义动手升级。
    if (Number(parsed.schemaVersion) !== SCHEMA_VERSION) return emptyLedger();
    return {
      schemaVersion: SCHEMA_VERSION,
      global: { ...emptyLedger().global, ...(parsed.global || {}) },
      providers: (parsed.providers && typeof parsed.providers === 'object') ? parsed.providers : {}
    };
  } catch (_error) {
    // 损坏/不存在一律回落默认值，绝不抛——账本读不出来不该拖垮 server 启动。
    return emptyLedger();
  }
}

function writeLedger(aiHomeDir, ledger, options = {}) {
  const fsImpl = options.fs || nodeFs;
  const pathImpl = options.path || nodePath;
  const target = ledgerPath(aiHomeDir);
  if (!target) return false;
  try {
    fsImpl.mkdirSync(pathImpl.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    fsImpl.writeFileSync(tmp, JSON.stringify({ ...ledger, schemaVersion: SCHEMA_VERSION }, null, 2), { mode: 0o600 });
    fsImpl.renameSync(tmp, target);
    return true;
  } catch (_error) {
    return false;
  }
}

function readProviderRecord(ledger, provider) {
  const record = (ledger && ledger.providers && ledger.providers[provider]) || {};
  return {
    ...DEFAULT_PROVIDER_RECORD,
    ...record,
    blockedVersions: Array.isArray(record.blockedVersions) ? record.blockedVersions.slice() : [],
    history: Array.isArray(record.history) ? record.history.slice() : []
  };
}

function writeProviderRecord(ledger, provider, patch = {}) {
  const next = { ...readProviderRecord(ledger, provider), ...patch };
  if (Array.isArray(next.history) && next.history.length > HISTORY_LIMIT) {
    next.history = next.history.slice(-HISTORY_LIMIT);
  }
  return {
    ...ledger,
    providers: { ...(ledger.providers || {}), [provider]: next }
  };
}

function appendHistory(record, entry) {
  const history = Array.isArray(record.history) ? record.history.slice() : [];
  history.push(entry);
  return history.length > HISTORY_LIMIT ? history.slice(-HISTORY_LIMIT) : history;
}

module.exports = {
  LEDGER_FILE,
  SCHEMA_VERSION,
  HISTORY_LIMIT,
  DEFAULT_PROVIDER_RECORD,
  ledgerPath,
  emptyLedger,
  readLedger,
  writeLedger,
  readProviderRecord,
  writeProviderRecord,
  appendHistory
};
