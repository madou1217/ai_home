'use strict';

const nodePath = require('node:path');
const { BaseHostAccountSync } = require('./host-account-sync/base-host-account-sync');
const {
  inspectCodexCredential,
  compareCodexCredentialSnapshots,
  codexCredentialFingerprint
} = require('./codex-credential-freshness');

/**
 * Codex 本机登录态（`<CODEX_HOME>/auth.json`）的**自动入库**。
 *
 * 骨架（快照稳定性、来源缓存、并发 CAS、身份去重、事件队列、生命周期）由
 * `host-account-sync/base-host-account-sync.js` 独占，这里只声明 codex 的差异。
 *
 * 用户在自己的终端里 `codex login` 之后，凭据落在宿主 `~/.codex/auth.json` 或某个账号的
 * 运行时投影里；本同步器观察**已显式列举**的来源，把新登录 / 新轮换的凭据并进账号库。
 * 边界：只认 OAuth 登录态（API Key 账号走显式添加）、只扫宿主 HOME 与已登记账号的运行时根、
 * 拿不到稳定身份就拒绝、代际比不出来就不动库。
 */
const MAX_AUTH_BYTES = 1024 * 1024;
const ACCOUNT_REF_PATTERN = /^acct_[a-f0-9]{20}$/;

class CodexHostAccountSync extends BaseHostAccountSync {
  get providers() { return ['codex']; }
  get maxArtifactBytes() { return MAX_AUTH_BYTES; }
  get missingReason() { return 'auth_file_missing'; }
  get unreadableReason() { return 'auth_file_unreadable'; }
  get unsupportedReason() { return 'unsupported_auth_file'; }
  get changedDuringReadReason() { return 'auth_file_changed_during_read'; }
  get tooLargeReason() { return 'auth_file_too_large'; }
  /** 观察循环自身的失败（不是某一份文件的失败）用这个原因码上报。 */
  get syncFailureReason() { return 'native_credential_sync_failed'; }

  /** 稳定身份种子：JWT 的稳定 subject；degraded / 非 oauth 一律视为「身份不可验证」。 */
  extractIdentity(auth) {
    const value = this.identify('codex', { auth });
    return value && !value.degraded && value.kind === 'oauth' ? String(value.identitySeed || '') : '';
  }

  /** 这份 auth.json 算不算「可用的登录态」（格式 / 过期 / 结构）。 */
  inspect(auth) {
    const inspection = inspectCodexCredential(auth, this.now());
    return inspection.usable ? { usable: true } : { usable: false, reason: inspection.reason };
  }

  compare(currentAuth, candidateAuth, ctx = {}) {
    return compareCodexCredentialSnapshots(currentAuth, candidateAuth, { nowMs: ctx.nowMs || this.now() });
  }

  buildPayload(current, snapshot) {
    return {
      ...(current && current.nativeAuth || {}),
      auth: snapshot.doc,
      codexNativeObservation: { capturedAt: this.now(), fingerprint: codexCredentialFingerprint(snapshot.doc) }
    };
  }

  isPoolableRecord(record) {
    return record.provider === 'codex' && !String(record.env && record.env.OPENAI_API_KEY || '').trim();
  }

  /** 库内记录与本次观察冲突时拒绝写入（身份/模式不一致绝不做「就近覆盖」）。 */
  guardCurrent(current, snapshot) {
    if (current && (current.provider !== 'codex' || String(current.env && current.env.OPENAI_API_KEY || '').trim())) {
      return 'account_mode_conflict';
    }
    const currentAuth = this.recordDocument(current);
    const currentIdentity = this.extractIdentity(currentAuth);
    if (currentIdentity && currentIdentity !== snapshot.identitySeed) return 'account_identity_conflict';
    if (currentAuth && !currentIdentity && Object.keys(currentAuth).length) return 'database_identity_unknown';
    return null;
  }

  /** 宿主 `~/.codex/auth.json`（可用 nativeCodexHome 覆盖）+ 已登记账号的运行时投影。 */
  sourceFiles(records, options = {}) {
    if (Array.isArray(options.files)) {
      return [...new Set(options.files.filter(value => typeof value === 'string' && this.path.isAbsolute(value)))]
        .map(file => ({ file, label: this.path.basename(file) }));
    }
    const files = [];
    const explicitHome = String(this.deps.nativeCodexHome || '').trim();
    if (explicitHome && this.path.isAbsolute(explicitHome)) files.push(this.path.join(explicitHome, 'auth.json'));
    else if (this.hostHomeDir) files.push(this.path.join(this.hostHomeDir, '.codex', 'auth.json'));
    // 只扫已登记账号的运行时根：绝不递归发现备份、导出、会话记录或任意像凭据的文件。
    for (const record of records) {
      if (!ACCOUNT_REF_PATTERN.test(String(record.accountRef || ''))) continue;
      files.push(this.path.join(this.aiHomeDir, 'run', 'codex-desktop', record.accountRef, 'auth.json'));
      files.push(this.path.join(this.aiHomeDir, 'run', 'accounts', 'codex', record.accountRef, '.codex', 'auth.json'));
    }
    return [...new Set(files)].map(file => ({ file, label: nodePath.basename(file) }));
  }

  /** nativeCodexHome 也是合法来源，缺了它不能把「没来源」伪装成「扫了没结果」。 */
  isEnabled(options = {}) {
    if (!this.fs || !this.aiHomeDir) return false;
    return Boolean(this.hostHomeDir)
      || Boolean(String(this.deps.nativeCodexHome || '').trim())
      || Array.isArray(options.files);
  }
}

/**
 * 工厂：保持既有调用点（daemon / 测试）的构造方式不变。
 * 返回的实例提供 scan / start / stop / getStats（契约见 BaseHostAccountSync）。
 */
function createCodexNativeCredentialSync(deps = {}) {
  return new CodexHostAccountSync(deps);
}

module.exports = { CodexHostAccountSync, createCodexNativeCredentialSync };
