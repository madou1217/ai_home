'use strict';

// OpenCode v2 的宿主登录态观察者：宿主 `opencode.db` 的 `credential` 表 → aih 账号。
//
// 为什么需要（2026-10-29 真机取证）：
//   v2 把 provider 凭据从 `auth.json` **搬进了 SQLite**（`<data>/opencode.db` 的
//   `credential` 表：id / integration_id / label / value / connector_id / method_id /
//   active / time_created / time_updated）。所以 `opencode auth login opencode`（Console
//   登录，方法 `device` / `key`）成功之后：
//     - `opencode auth list` 显示 `OpenCode Console   Default   stored`（凭据在 DB 里）；
//     - 宿主 `auth.json` 里**没有** `opencode` 条目（只有别的 provider 的旧式 api key）；
//     - aih 既没有 opencode 观察者、也读不到 auth.json —— 现象就是「登录成功但 aih 里看不到」。
//   本模块补上这条观察链：把宿主 DB 里 active 的 `opencode` 凭据登记成 aih 账号。
//
// 凭据形状（`opencode auth export` 实测导出，逐字段）：
//   { id: 'cred_…', integrationID: 'opencode', label: 'Default', active: true,
//     value: { type: 'oauth', methodID: 'device',
//              refresh: '<39>', access: '<39>', expires: 1795855790528,
//              metadata: { server: 'https://opencode.ai/console', accountID: 'acc_…',
//                          email: '…@gmail.com', orgID: 'wrk_…', orgName: 'Default' } } }
//   身份种子取 `metadata.accountID`（退到 `email`）—— Console 账号的稳定 id，换 token 不变；
//   拿不到就拒绝入库，绝不铸兜底身份。
//
// 入库形状与旧 `auth.json` 的 opencode 槽位**同形**（`nativeAuth.auth.opencode = value`），
// 下游（`lib/account/opencode-native-auth.js` 的投影桥、额度探针）消费同一份结构。
//
// 边界（与 cline 观察者同口径）：**只认 OAuth 登录态**，纯 API Key 文档不入库；
// 自动观察一律 respectDeletion（用户删掉的账号不会被轮询登记回来）。

const { BaseHostAccountSync } = require('./host-account-sync/base-host-account-sync');

const INTEGRATION_ID = 'opencode';
const CREDENTIAL_RELATIVE_PATH = Object.freeze(['.local', 'share', 'opencode', 'opencode.db']);
const SOURCE_KEY = 'opencodeCredentialSource';

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function safeParseJson(value) {
  try {
    const parsed = JSON.parse(String(value == null ? '' : value));
    return isPlainObject(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function loadDatabaseSync(deps = {}) {
  if (typeof deps.DatabaseSync === 'function') return deps.DatabaseSync;
  try {
    return require('node:sqlite').DatabaseSync;
  } catch (_error) {
    return null;
  }
}

function isApiKeyAccount(record) {
  return Boolean(normalizeText(record && record.env && record.env.OPENCODE_API_KEY));
}

class OpenCodeHostAccountSync extends BaseHostAccountSync {
  constructor(deps = {}) {
    super(deps);
    this.DatabaseSync = loadDatabaseSync(deps);
  }

  get providers() { return ['opencode']; }
  get syncFailureReason() { return 'opencode_native_credential_sync_failed'; }

  /** 宿主数据根下的 DB；已登记账号投影里那份通常是它的符号链接，因此只扫宿主一处。 */
  sourceFiles(_records, options = {}) {
    if (Array.isArray(options.files)) {
      return [...new Set(options.files.filter((value) => typeof value === 'string' && this.path.isAbsolute(value)))]
        .map((file) => ({ file, label: this.path.basename(file) }));
    }
    if (!this.hostHomeDir) return [];
    const file = this.path.join(this.hostHomeDir, ...CREDENTIAL_RELATIVE_PATH);
    return [{ file, label: 'host:.local/share/opencode/opencode.db#credential' }];
  }

  /** 非文件来源：读 DB 的 `credential` 表（read-only），只取 opencode 集成。 */
  readSourceDocument(source) {
    const DatabaseSync = this.DatabaseSync;
    if (typeof DatabaseSync !== 'function') return { skip: true, reason: 'opencode_credential_store_unsupported' };
    let db = null;
    try {
      db = new DatabaseSync(source.file, { readOnly: true });
      db.exec('PRAGMA query_only = ON;');
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'credential'").get();
      if (!table) return { skip: true, reason: 'opencode_credential_store_missing' };
      const rows = db.prepare(
        'SELECT id, integration_id, label, value, method_id, active FROM credential'
        + ' WHERE integration_id = ? ORDER BY active DESC, time_updated DESC'
      ).all(INTEGRATION_ID);
      for (const row of rows) {
        const value = safeParseJson(row && row.value);
        if (!value) continue;
        return {
          doc: {
            [INTEGRATION_ID]: value,
            [SOURCE_KEY]: {
              credentialId: normalizeText(row.id),
              label: normalizeText(row.label),
              methodId: normalizeText(row.method_id || value.methodID),
              active: Number(row.active) === 1
            }
          }
        };
      }
      return { skip: true, reason: 'opencode_credential_missing' };
    } catch (_error) {
      return { skip: true, reason: 'opencode_credential_store_unreadable' };
    } finally {
      try { if (db && typeof db.close === 'function') db.close(); } catch (_error) { /* 忽略 */ }
    }
  }

  /** 可用性：oauth 要有 access + refresh；key 要有 key。 */
  inspect(doc) {
    const value = doc && doc[INTEGRATION_ID];
    if (!isPlainObject(value)) return { usable: false, reason: 'opencode_credential_missing' };
    const usable = value.type === 'oauth'
      ? Boolean(normalizeText(value.access) && normalizeText(value.refresh))
      : Boolean(normalizeText(value.key));
    if (!usable) return { usable: false, reason: 'opencode_credential_incomplete' };
    return {
      usable: true,
      doc: {
        [INTEGRATION_ID]: value,
        ...(isPlainObject(doc[SOURCE_KEY]) ? { [SOURCE_KEY]: doc[SOURCE_KEY] } : {})
      }
    };
  }

  /** 只认 OAuth 登录态：纯 API Key 文档不入库（与 cline 观察者同口径）。 */
  admit(doc) {
    const value = doc && doc[INTEGRATION_ID];
    if (!value || value.type !== 'oauth') return { adopt: false, reason: 'api_key_only_source' };
    return { adopt: true };
  }

  extractIdentity(doc) {
    const value = (doc && doc[INTEGRATION_ID]) || {};
    const metadata = isPlainObject(value.metadata) ? value.metadata : {};
    return normalizeText(metadata.accountID) || normalizeText(metadata.email);
  }

  describe(doc) {
    const value = (doc && doc[INTEGRATION_ID]) || {};
    const metadata = isPlainObject(value.metadata) ? value.metadata : {};
    const accountName = normalizeText(metadata.email) || normalizeText(metadata.orgName);
    return accountName ? { accountName } : null;
  }

  /** 代际比较：密钥没变 → unchanged；换了且 expires 更晚 → 采纳；比不出来就不动库。 */
  compare(current, candidate) {
    const next = candidate && candidate[INTEGRATION_ID];
    if (!isPlainObject(next)) return { adopt: false, reason: 'credential_not_newer' };
    const prev = current && current[INTEGRATION_ID];
    if (!isPlainObject(prev)) return { adopt: true, reason: 'credential_adopted' };
    const sameSecret = normalizeText(prev.access) === normalizeText(next.access)
      && normalizeText(prev.refresh) === normalizeText(next.refresh);
    if (sameSecret && normalizeText(prev.methodID) === normalizeText(next.methodID)) {
      return { adopt: false, reason: 'unchanged' };
    }
    const prevExpires = Number(prev.expires) || 0;
    const nextExpires = Number(next.expires) || 0;
    if (nextExpires > prevExpires) return { adopt: true, reason: 'credential_rotated' };
    return { adopt: false, reason: 'credential_not_newer' };
  }

  buildPayload(current, snapshot) {
    const previous = (current && current.nativeAuth) || {};
    const previousAuth = isPlainObject(previous.auth) ? previous.auth : {};
    const value = snapshot.doc[INTEGRATION_ID];
    const source = isPlainObject(snapshot.doc[SOURCE_KEY]) ? snapshot.doc[SOURCE_KEY] : {};
    const metadata = isPlainObject(value.metadata) ? value.metadata : {};
    return {
      ...previous,
      auth: { ...previousAuth, [INTEGRATION_ID]: value },
      opencodeNativeObservation: {
        capturedAt: this.now(),
        credentialId: normalizeText(source.credentialId),
        label: normalizeText(source.label),
        methodId: normalizeText(source.methodId),
        email: normalizeText(metadata.email),
        orgID: normalizeText(metadata.orgID),
        server: normalizeText(metadata.server)
      }
    };
  }

  isPoolableRecord(record) {
    return record.provider === 'opencode' && !isApiKeyAccount(record);
  }

  guardCurrent(current, snapshot) {
    if (current && (current.provider !== 'opencode' || isApiKeyAccount(current))) return 'account_mode_conflict';
    const currentDoc = this.recordDocument(current);
    const currentIdentity = this.extractIdentity(currentDoc);
    if (currentIdentity && currentIdentity !== snapshot.identitySeed) return 'account_identity_conflict';
    return null;
  }
}

function createOpenCodeNativeCredentialSync(deps = {}) {
  return new OpenCodeHostAccountSync(deps);
}

module.exports = { OpenCodeHostAccountSync, createOpenCodeNativeCredentialSync, INTEGRATION_ID };
