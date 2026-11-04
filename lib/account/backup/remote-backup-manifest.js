'use strict';

// 远程账号备份的增量清单。
//
// 远端布局：
//   manifest.json
//   accounts/<provider>/<accountRef>.json
//
// 增量判断的唯一依据是**账号内容哈希**，不是文件时间戳：凭据刷新、启用状态变化
// 都会改变哈希；同一个账号重复备份（内容没变）不会重复上传。
//
// 账号文件就是 aih 原生导入格式的单账号文档，可以直接 `aih import`：
//   { kind: 'aih-accounts', version: 1, accounts: [record] }
// 刻意不写 exportedAt/source：同样的账号内容必须得到同样的字节，否则每次备份都会
// 产生一个「新文件」，增量就失效了。

const crypto = require('node:crypto');

const MANIFEST_KIND = 'aih-account-backup';
const MANIFEST_VERSION = 1;
const MANIFEST_FILE = 'manifest.json';
const ACCOUNTS_DIR = 'accounts';
const ACCOUNT_DOCUMENT_KIND = 'aih-accounts';
const ACCOUNT_DOCUMENT_VERSION = 1;

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function hashAccount(record) {
  return crypto.createHash('sha256').update(stableStringify(record)).digest('hex');
}

function accountRelativePath(provider, accountRef) {
  const providerId = String(provider || '').trim();
  const ref = String(accountRef || '').trim();
  // 远端路径由 provider/accountRef 拼成；这两个值必须来自受控词汇表，
  // 否则恶意清单/损坏数据可以用 ../ 把文件写到备份目录之外。
  if (!/^[a-z0-9._-]{1,64}$/.test(providerId)) throw new Error('invalid_backup_provider');
  if (!/^acct_[a-f0-9]{20}$/.test(ref)) throw new Error('invalid_backup_account_ref');
  return `${ACCOUNTS_DIR}/${providerId}/${ref}.json`;
}

function buildAccountDocument(record) {
  return {
    kind: ACCOUNT_DOCUMENT_KIND,
    version: ACCOUNT_DOCUMENT_VERSION,
    accounts: [record]
  };
}

function serializeAccountDocument(record) {
  return `${JSON.stringify(buildAccountDocument(record), null, 2)}\n`;
}

function emptyManifest(options = {}) {
  return {
    kind: MANIFEST_KIND,
    version: MANIFEST_VERSION,
    source: { host: String(options.hostName || '').trim() },
    revision: 0,
    accounts: {}
  };
}

function normalizeManifest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (raw.kind !== MANIFEST_KIND || Number(raw.version) !== MANIFEST_VERSION) return null;
  const accounts = raw.accounts && typeof raw.accounts === 'object' && !Array.isArray(raw.accounts)
    ? raw.accounts
    : {};
  const normalized = {};
  for (const [accountRef, entry] of Object.entries(accounts)) {
    if (!/^acct_[a-f0-9]{20}$/.test(accountRef)) continue;
    if (!entry || typeof entry !== 'object') continue;
    const provider = String(entry.provider || '').trim();
    const sha256 = String(entry.sha256 || '').trim().toLowerCase();
    if (!provider || !/^[a-f0-9]{64}$/.test(sha256)) continue;
    normalized[accountRef] = {
      provider,
      sha256,
      bytes: Number(entry.bytes) || 0,
      ...(entry.deleted ? { deleted: true } : {})
    };
  }
  return {
    kind: MANIFEST_KIND,
    version: MANIFEST_VERSION,
    source: { host: String(raw.source && raw.source.host || '').trim() },
    revision: Number(raw.revision) || 0,
    accounts: normalized
  };
}

function parseManifest(text) {
  if (!text) return null;
  try {
    return normalizeManifest(JSON.parse(String(text).replace(/^﻿/, '')));
  } catch (_error) {
    return null;
  }
}

/**
 * 计算这次要上传什么。
 *
 * @param {{accounts: Array<object>, manifest?: object|null, full?: boolean, hostName?: string}} options
 * @returns {{uploads: Array<object>, deleted: string[], unchanged: number, manifest: object, changed: boolean}}
 */
function buildBackupPlan(options = {}) {
  const accounts = Array.isArray(options.accounts) ? options.accounts : [];
  const previous = options.manifest || null;
  const previousAccounts = previous && previous.accounts ? previous.accounts : {};
  const full = Boolean(options.full);
  const nextAccounts = {};
  const uploads = [];
  let unchanged = 0;

  for (const record of accounts) {
    if (!record || !record.accountRef || !record.provider) continue;
    const accountRef = String(record.accountRef);
    const provider = String(record.provider);
    const content = serializeAccountDocument(record);
    const sha256 = hashAccount(record);
    const prior = previousAccounts[accountRef];
    const isUnchanged = !full && prior && !prior.deleted && prior.sha256 === sha256;
    if (isUnchanged) unchanged += 1;
    else {
      uploads.push({
        accountRef,
        provider,
        path: accountRelativePath(provider, accountRef),
        content,
        sha256,
        bytes: Buffer.byteLength(content)
      });
    }
    nextAccounts[accountRef] = {
      provider,
      sha256,
      bytes: Buffer.byteLength(content)
    };
  }

  // 本地已删除的账号：保留远端文件（不销毁历史），只在清单里打 tombstone。
  // 恢复时 tombstone 不参与导入；用户仍可在远端手工找回旧文件。
  const deleted = [];
  for (const accountRef of Object.keys(previousAccounts).sort()) {
    if (nextAccounts[accountRef]) continue;
    const prior = previousAccounts[accountRef];
    nextAccounts[accountRef] = {
      provider: prior.provider,
      sha256: prior.sha256,
      bytes: prior.bytes,
      deleted: true
    };
    if (!prior.deleted) deleted.push(accountRef);
  }

  const orderedAccounts = {};
  for (const accountRef of Object.keys(nextAccounts).sort()) orderedAccounts[accountRef] = nextAccounts[accountRef];

  const previousComparable = stableStringify(previousAccounts);
  const nextComparable = stableStringify(orderedAccounts);
  const changed = uploads.length > 0 || previousComparable !== nextComparable;
  const manifest = {
    kind: MANIFEST_KIND,
    version: MANIFEST_VERSION,
    source: { host: String(options.hostName || (previous && previous.source && previous.source.host) || '').trim() },
    revision: (Number(previous && previous.revision) || 0) + (changed ? 1 : 0),
    accounts: orderedAccounts
  };

  return { uploads, deleted, unchanged, manifest, changed };
}

/** 远端账号文件路径（恢复时按清单里的 provider + ref 拼）。 */
function manifestAccountPath(accountRef, entry) {
  return accountRelativePath(String(entry && entry.provider || ''), accountRef);
}

module.exports = {
  ACCOUNTS_DIR,
  ACCOUNT_DOCUMENT_KIND,
  ACCOUNT_DOCUMENT_VERSION,
  MANIFEST_FILE,
  MANIFEST_KIND,
  MANIFEST_VERSION,
  accountRelativePath,
  buildAccountDocument,
  buildBackupPlan,
  emptyManifest,
  hashAccount,
  manifestAccountPath,
  normalizeManifest,
  parseManifest,
  serializeAccountDocument,
  stableStringify
};
