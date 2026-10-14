'use strict';

const nodePath = require('node:path');
const { BaseHostAccountSync } = require('./host-account-sync/base-host-account-sync');
const {
  compareClineCredentialDocuments,
  hasUsableClineCredential,
  resolveClineAccountName,
  sanitizeClineProvidersDocument,
  selectClineOAuthCredential
} = require('./cline-credentials');

/**
 * Cline 本机登录态的**自动入库**。
 *
 * 骨架（快照稳定性、来源缓存、并发 CAS、身份去重、事件队列、生命周期）由
 * `host-account-sync/base-host-account-sync.js` 独占，这里只声明 cline 的差异。
 *
 * 用户在自己的终端里跑 `cline auth`（Cline Pass 或 Cline 账号）登录后，CLI 把凭据写进
 * `<CLINE_DIR>/data/settings/providers.json` —— 这份文档不在 ai_home 的账号库里，
 * 在此之前只能靠手工导入才看得见。本同步器按周期观察**已显式列举**的来源，把新登录 /
 * 新轮换的凭据并进账号库，并由调用方（token-refresh daemon / WebUI 扫描按钮）触发账号池重载。
 *
 * 边界（刻意与 codex 的观察者保持一致）：
 *   - 只认 OAuth 登录态（`selectClineOAuthCredential`）。纯 API Key 文档不自动入库，
 *     免得把宿主环境里顺手写进去的 key 变成账号（API Key 账号走显式添加/导入）。
 *   - 只扫宿主 HOME 与**已登记账号**的投影根，绝不递归发现备份/导出/任意像凭据的文件。
 *   - 身份种子来自 JWT 里的稳定 subject；拿不到身份一律拒绝，不铸 `oauth:cline:<x>` 兜底。
 *   - 入库前先按 cline 槽位收窄（`sanitizeClineProvidersDocument`）：providers.json 是整库
 *     文档，同机其它 provider 的明文密钥绝不进账号记录。
 *   - 代际比较见 `compareClineCredentialDocuments`：比不出来就不动库。
 */
const MAX_CREDENTIAL_DOC_BYTES = 4 * 1024 * 1024;
// <CLINE_DIR>/data/settings/providers.json：宿主是 ~/.cline，账号沙箱是 <runtimeDir>/.cline
// （与 provider-storage-policy 的 cline.authArtifacts、credential-layout 同一条相对路径）。
const CLINE_CREDENTIAL_RELATIVE_PATH = Object.freeze(['.cline', 'data', 'settings', 'providers.json']);
const ACCOUNT_REF_PATTERN = /^acct_[a-f0-9]{20}$/;

function isApiKeyAccount(record) {
  return Boolean(String(record && record.env && record.env.CLINE_API_KEY || '').trim());
}

class ClineHostAccountSync extends BaseHostAccountSync {
  constructor(deps = {}) {
    super(deps);
    const layout = require('../runtime/aih-storage-layout');
    this.resolveRuntimeDir = deps.resolveAccountRuntimeDir || layout.resolveAccountRuntimeDir;
    this.resolveCliRuntimeDir = deps.resolveAccountCliRuntimeDir || layout.resolveAccountCliRuntimeDir;
    this.compareDocuments = deps.compareCredentials || compareClineCredentialDocuments;
  }

  get providers() { return ['cline']; }
  get maxArtifactBytes() { return MAX_CREDENTIAL_DOC_BYTES; }
  /** 观察循环自身的失败（不是某一份文件的失败）用这个原因码上报。 */
  get syncFailureReason() { return 'cline_native_credential_sync_failed'; }

  /** 稳定身份种子：JWT 的稳定 subject；degraded / 非 oauth 一律视为「身份不可验证」。 */
  extractIdentity(doc) {
    const value = this.identify('cline', { auth: doc });
    return value && !value.degraded && value.kind === 'oauth' ? String(value.identitySeed || '') : '';
  }

  /** 整库文档 → 只留 cline 槽位（同机其它 provider 的明文密钥绝不进账号记录）。 */
  inspect(doc) {
    if (!hasUsableClineCredential(doc)) return { usable: false, reason: 'no_cline_credential' };
    if (!selectClineOAuthCredential(doc)) return { usable: false, reason: 'api_key_only_source' };
    return { usable: true, doc: sanitizeClineProvidersDocument(doc) };
  }

  /** 准入复用同一份代际判定：过期凭据 / 无 OAuth 记录在这里就被挡掉（原因码一致）。 */
  admit(doc, ctx) {
    return this.compare(null, doc, ctx);
  }

  describe(doc) {
    return { accountName: resolveClineAccountName(doc) };
  }

  compare(current, candidate, ctx = {}) {
    return this.compareDocuments(current, candidate, { nowMs: ctx.nowMs || this.now() });
  }

  buildPayload(current, snapshot) {
    return {
      ...(current && current.nativeAuth || {}),
      auth: snapshot.doc,
      clineNativeObservation: { capturedAt: this.now(), accountName: snapshot.accountName }
    };
  }

  isPoolableRecord(record) {
    return record.provider === 'cline' && !isApiKeyAccount(record);
  }

  /** 库内记录与本次观察冲突时拒绝写入（身份/模式不一致绝不做「就近覆盖」）。 */
  guardCurrent(current, snapshot) {
    if (current && (current.provider !== 'cline' || isApiKeyAccount(current))) return 'account_mode_conflict';
    const currentDoc = this.recordDocument(current);
    const currentIdentity = this.extractIdentity(currentDoc);
    if (currentIdentity && currentIdentity !== snapshot.identitySeed) return 'account_identity_conflict';
    if (currentDoc && !currentIdentity && Object.keys(currentDoc).length) return 'database_identity_unknown';
    return null;
  }

  /** 宿主 HOME + 已登记账号的投影根；`options.files` 是测试与显式列举入口。 */
  sourceFiles(records, options = {}) {
    if (Array.isArray(options.files)) {
      return [...new Set(options.files.filter(value => typeof value === 'string' && nodePath.isAbsolute(value)))]
        .map(file => ({ file, label: nodePath.basename(file) }));
    }
    const sources = new Map();
    if (this.hostHomeDir) {
      const file = this.path.join(this.hostHomeDir, ...CLINE_CREDENTIAL_RELATIVE_PATH);
      sources.set(file, { file, label: 'host:.cline/data/settings/providers.json' });
    }
    // 只扫已登记账号的运行时根：沙箱里 CLI 自己续期/换登录后，账号库要能跟上。
    for (const record of records) {
      if (!ACCOUNT_REF_PATTERN.test(String(record.accountRef || ''))) continue;
      const roots = new Set([
        this.resolveRuntimeDir(this.aiHomeDir, 'cline', record.accountRef),
        this.resolveCliRuntimeDir(this.aiHomeDir, 'cline', record.accountRef)
      ]);
      for (const root of roots) {
        if (!root) continue;
        const file = this.path.join(root, ...CLINE_CREDENTIAL_RELATIVE_PATH);
        if (!sources.has(file)) sources.set(file, { file, label: `${record.accountRef}:${nodePath.basename(file)}` });
      }
    }
    return [...sources.values()];
  }
}

/**
 * 工厂：保持既有调用点（daemon / WebUI / 测试）的构造方式不变。
 * 返回的实例提供 scan / start / stop / getStats（契约见 BaseHostAccountSync）。
 */
function createClineNativeCredentialSync(deps = {}) {
  return new ClineHostAccountSync(deps);
}

/**
 * 按需扫描一次：本机已经登录过 Cline（含 Cline Pass）、但还没进账号库的账号会被登记进来。
 * 与后台周期同步用的是同一份 `scan()`；参数不全时明确失败，而不是静默当作「没扫到」。
 */
function detectHostClineAccounts(options = {}) {
  const { fs, aiHomeDir, hostHomeDir } = options;
  if (!fs || !aiHomeDir || !hostHomeDir) return { ok: false, error: 'detect_host_accounts_unavailable' };
  const sync = createClineNativeCredentialSync({ fs, aiHomeDir, hostHomeDir });
  const result = sync.scan();
  const store = require('../server/account-credential-store');
  return {
    ok: true,
    scanned: result.scanned,
    updated: result.updated.length,
    reloaded: false,
    registered: result.updated.map(item => ({
      accountRef: item.accountRef || '',
      cliAccountId: item.cliAccountId || '',
      created: item.created === true
    })),
    skipped: result.skipped,
    accounts: { cline: store.listAccountCredentialRecords(fs, aiHomeDir, 'cline').length }
  };
}

module.exports = { ClineHostAccountSync, createClineNativeCredentialSync, detectHostClineAccounts };
