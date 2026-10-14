'use strict';

const nodePath = require('node:path');
const {
  compareClineCredentialDocuments,
  hasUsableClineCredential,
  resolveClineAccountName,
  sanitizeClineProvidersDocument,
  selectClineOAuthCredential
} = require('./cline-credentials');

/**
 * Cline 本机登录态的**自动入库**（与 codex-native-credential-sync / codebuddy 家族同构的第三块）。
 *
 * 用户在自己的终端里跑 `cline auth`（Cline Pass 或 Cline 账号）登录后，CLI 把凭据写进
 * `<CLINE_DIR>/data/settings/providers.json` —— 这份文档不在 ai_home 的账号库里，
 * 在此之前只能靠手工导入才看得见。本模块按周期观察**已显式列举**的来源，把新登录 /
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
const DEFAULT_INTERVAL_MS = 3000;
// <CLINE_DIR>/data/settings/providers.json：宿主是 ~/.cline，账号沙箱是 <runtimeDir>/.cline
// （与 provider-storage-policy 的 cline.authArtifacts、credential-layout 同一条相对路径）。
const CLINE_CREDENTIAL_RELATIVE_PATH = Object.freeze(['.cline', 'data', 'settings', 'providers.json']);
const ACCOUNT_REF_PATTERN = /^acct_[a-f0-9]{20}$/;

function createClineNativeCredentialSync(deps = {}) {
  const fs = deps.fs;
  const path = deps.path || nodePath;
  const aiHomeDir = String(deps.aiHomeDir || '').trim();
  const hostHomeDir = String(deps.hostHomeDir || '').trim();
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const store = deps.store || require('../server/account-credential-store');
  const identify = deps.resolveIdentity || require('./account-identity').resolveNativeAuthIdentitySeed;
  const register = deps.registerIdentity || require('./account-registration').registerAccountIdentity;
  const insert = deps.insertIfMissing || require('../server/account-credential-store-insert').insertAccountNativeAuthIfMissing;
  const compare = deps.compareCredentials || compareClineCredentialDocuments;
  const layout = require('../runtime/aih-storage-layout');
  const resolveRuntimeDir = deps.resolveAccountRuntimeDir || layout.resolveAccountRuntimeDir;
  const resolveCliRuntimeDir = deps.resolveAccountCliRuntimeDir || layout.resolveAccountCliRuntimeDir;
  const resolveAlias = deps.resolveCliAccountRef
    || require('../server/account-ref-store').resolveCliAccountRef;
  const setIntervalImpl = deps.setInterval || setInterval;
  const clearIntervalImpl = deps.clearInterval || clearInterval;
  let timer = null;
  let running = false;
  let stopped = false;
  let lastScan = { updated: [], skipped: [], scanned: 0 };
  const pending = new Map();
  const sourceCache = new Map();

  function identityOf(doc) {
    const value = identify('cline', { auth: doc });
    return value && !value.degraded && value.kind === 'oauth' ? String(value.identitySeed || '') : '';
  }
  function isApiKeyAccount(record) {
    return Boolean(String(record && record.env && record.env.CLINE_API_KEY || '').trim());
  }
  function readSnapshot(source) {
    const filePath = source.file;
    try {
      const before = fs.lstatSync(filePath);
      if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_CREDENTIAL_DOC_BYTES) {
        return { reason: 'unsupported_credential_file' };
      }
      const stamp = [before.ino, before.size, before.mtimeMs, before.ctimeMs].join(':');
      const cached = sourceCache.get(filePath);
      if (cached && cached.stamp === stamp) return cached.snapshot;
      const raw = fs.readFileSync(filePath, 'utf8');
      const after = fs.lstatSync(filePath);
      if (before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        return { reason: 'credential_file_changed_during_read' };
      }
      if (Buffer.byteLength(raw) > MAX_CREDENTIAL_DOC_BYTES) return { reason: 'credential_file_too_large' };
      const parsed = JSON.parse(raw);
      if (!hasUsableClineCredential(parsed)) return { reason: 'no_cline_credential' };
      if (!selectClineOAuthCredential(parsed)) return { reason: 'api_key_only_source' };
      const doc = sanitizeClineProvidersDocument(parsed);
      // 准入复用同一份代际判定：过期凭据 / 无 OAuth 记录在这里就被挡掉（原因码一致）。
      const admission = compare(null, doc, { nowMs: now() });
      if (!admission.adopt) return { reason: admission.reason };
      const identitySeed = identityOf(doc);
      if (!identitySeed) return { reason: 'stable_identity_unavailable' };
      const snapshot = { doc, identitySeed, accountName: resolveClineAccountName(doc) };
      sourceCache.set(filePath, { stamp, snapshot });
      return snapshot;
    } catch (error) {
      sourceCache.delete(filePath);
      return { reason: error && error.code === 'ENOENT' ? 'credential_file_missing' : 'credential_file_unreadable' };
    }
  }
  function sourcePaths(records, options) {
    if (Array.isArray(options.files)) {
      return [...new Set(options.files.filter(value => typeof value === 'string' && path.isAbsolute(value)))]
        .map(file => ({ file, label: path.basename(file) }));
    }
    const sources = new Map();
    if (hostHomeDir) {
      const file = path.join(hostHomeDir, ...CLINE_CREDENTIAL_RELATIVE_PATH);
      sources.set(file, { file, label: 'host:.cline/data/settings/providers.json' });
    }
    // 只扫已登记账号的运行时根：沙箱里 CLI 自己续期/换登录后，账号库要能跟上。
    for (const record of records) {
      if (!ACCOUNT_REF_PATTERN.test(String(record.accountRef || ''))) continue;
      const roots = new Set([
        resolveRuntimeDir(aiHomeDir, 'cline', record.accountRef),
        resolveCliRuntimeDir(aiHomeDir, 'cline', record.accountRef)
      ]);
      for (const root of roots) {
        if (!root) continue;
        const file = path.join(root, ...CLINE_CREDENTIAL_RELATIVE_PATH);
        if (!sources.has(file)) sources.set(file, { file, label: `${record.accountRef}:${path.basename(file)}` });
      }
    }
    return [...sources.values()];
  }
  function ingest(snapshot, matches) {
    if (matches.length > 1) return { reason: 'ambiguous_existing_identity' };
    const registration = matches.length ? { accountRef: matches[0].accountRef, created: false }
      : register(fs, aiHomeDir, {
        provider: 'cline',
        identitySeed: snapshot.identitySeed,
        respectDeletion: true
      });
    const accountRef = registration.accountRef;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = store.readAccountCredentialRecord(fs, aiHomeDir, accountRef);
      if (current && (current.provider !== 'cline' || isApiKeyAccount(current))) {
        return { reason: 'account_mode_conflict' };
      }
      const currentDoc = current && current.nativeAuth && current.nativeAuth.auth;
      const currentIdentity = identityOf(currentDoc);
      if (currentIdentity && currentIdentity !== snapshot.identitySeed) return { reason: 'account_identity_conflict' };
      if (currentDoc && !currentIdentity && Object.keys(currentDoc).length) return { reason: 'database_identity_unknown' };
      const decision = compare(currentDoc, snapshot.doc, { nowMs: now() });
      if (!decision.adopt) return { accountRef, reason: decision.reason };
      const next = {
        ...(current && current.nativeAuth || {}),
        auth: snapshot.doc,
        clineNativeObservation: { capturedAt: now(), accountName: snapshot.accountName }
      };
      const saved = current
        ? store.compareAndSwapAccountNativeAuth(fs, aiHomeDir, accountRef, current, next)
        : insert(fs, aiHomeDir, accountRef, next);
      if (saved) {
        const alias = resolveAlias(fs, aiHomeDir, accountRef, { bestEffort: true });
        return {
          accountRef,
          updated: true,
          created: registration.created === true,
          cliAccountId: alias && alias.cliAccountId || '',
          reason: decision.reason
        };
      }
      // 并发的登录/续期赢了这一轮：重读再判定，不做无条件覆盖（可能盖掉更新的一代）。
    }
    return { accountRef, reason: 'concurrent_credential_update' };
  }
  function scan(options = {}) {
    const result = { updated: [], skipped: [], scanned: 0 };
    if (!fs || !aiHomeDir || (!hostHomeDir && !Array.isArray(options.files))) return result;
    let records;
    try {
      records = store.listAccountCredentialRecords(fs, aiHomeDir, 'cline');
    } catch (_) {
      return { ...result, skipped: [{ reason: 'credential_store_unavailable', provider: 'cline' }] };
    }
    const identities = new Map();
    for (const record of records) {
      if (record.provider !== 'cline' || isApiKeyAccount(record)) continue;
      const identity = identityOf(record.nativeAuth && record.nativeAuth.auth);
      if (identity) identities.set(identity, [...(identities.get(identity) || []), record]);
    }
    const sources = sourcePaths(records, options);
    const paths = sources.map(source => source.file);
    for (const cachedPath of sourceCache.keys()) if (!paths.includes(cachedPath)) sourceCache.delete(cachedPath);
    for (const source of sources) {
      result.scanned += 1;
      const snapshot = readSnapshot(source);
      if (!snapshot.doc) {
        if (snapshot.reason !== 'credential_file_missing') {
          result.skipped.push({ reason: snapshot.reason, provider: 'cline', source: source.label });
        }
        continue;
      }
      try {
        const outcome = ingest(snapshot, identities.get(snapshot.identitySeed) || []);
        if (outcome.updated) {
          result.updated.push(outcome);
          pending.set(outcome.accountRef, outcome);
          // 同一轮里后续来源（同一账号的沙箱投影）按新身份参与比较。
          identities.set(snapshot.identitySeed, [{ accountRef: outcome.accountRef }]);
        } else if (outcome.reason !== 'unchanged') {
          result.skipped.push({ reason: outcome.reason, provider: 'cline', source: source.label, accountRef: outcome.accountRef });
        }
      } catch (error) {
        result.skipped.push({
          reason: error && error.code === 'account_deleted_by_user' ? 'account_deleted_by_user' : 'credential_adoption_failed',
          provider: 'cline',
          source: source.label
        });
      }
    }
    lastScan = result;
    return result;
  }
  function start(options = {}) {
    if (timer) return;
    stopped = false;
    const tick = () => {
      if (running || stopped) return;
      running = true;
      try {
        scan();
        if (pending.size && typeof options.onUpdated === 'function') {
          const events = [...pending.values()];
          // 同步回调是契约（账号池重载是同步的）；重载抛错时通知继续排队，不吞掉事件。
          options.onUpdated(events);
          for (const event of events) pending.delete(event.accountRef);
        }
      } catch (_) {
        if (typeof options.onError === 'function') options.onError('cline_native_credential_sync_failed');
      } finally { running = false; }
    };
    tick();
    timer = setIntervalImpl(tick, Math.max(1000, Number(options.intervalMs) || DEFAULT_INTERVAL_MS));
    if (timer && typeof timer.unref === 'function') timer.unref();
  }
  function stop() {
    stopped = true;
    if (timer) clearIntervalImpl(timer);
    timer = null;
  }
  return {
    scan,
    start,
    stop,
    getStats: () => ({ scanned: lastScan.scanned, updated: lastScan.updated.length, skipped: lastScan.skipped, pending: pending.size })
  };
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

module.exports = { createClineNativeCredentialSync, detectHostClineAccounts };

