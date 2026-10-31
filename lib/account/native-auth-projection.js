'use strict';

const nodePath = require('node:path');
const { PRIMARY: CODEBUDDY_PRIMARY, inspectCodebuddyCredential, selectCodebuddyCredential,
  codebuddyProjectionPath, codebuddyCredentialPaths, readCodebuddyCredentialFile, compareCodebuddyCredentials,
  resolveCodebuddyCredentialOwner } = require('./codebuddy-credential-source');
const { adoptCodebuddyCredential } = require('./codebuddy-credential-sync');
const { encodeWorkbuddyCredential } = require('./workbuddy-credential-codec');
const { isDeepStrictEqual } = require('node:util');
const {
  readAccountNativeAuth,
  writeAccountNativeAuth
} = require('../server/account-credential-store');
const {
  isAccountRef,
  listAccountRefRecords,
  resolveAccountRef,
  resolveCliAccountRef
} = require('../server/account-ref-store');
const { resolveNativeAuthIdentitySeed } = require('./account-identity');
const { registerAccountIdentity } = require('./account-registration');
const { readClaudeKeychainCredentials } = require('./claude-keychain');
const {
  buildAgyGeminiOAuthCredentials,
  buildAgyGoogleAccounts
} = require('./agy-auth-metadata');
const { PROVIDER_STORAGE_POLICIES } = require('../runtime/provider-storage-policy');
const { normalizePathString } = require('../runtime/platform-path');
const { matchesKiroCredentialVersion } = require('./kiro-credential-version');
const { readAccountCredentialRecord, compareAndSwapAccountNativeAuth } = require('../server/account-credential-store');
const { insertAccountNativeAuthIfMissing } = require('../server/account-credential-store-insert');
const { getProviderCredentialStrategy } = require('./provider-credentials');
const { readKiroTokenRecord, readKiroDatabaseSnapshot } = require('./kiro-auth-metadata');
const { materializeKiroDatabase } = require('./kiro-database-projection');
const {
  deriveKimiDeviceId,
  hasUsableKimiOAuth,
  readKimiOAuthCredentials,
  resolveKimiOAuthDeviceId
} = require('./kimi-auth');
const {
  hasUsableClineCredential,
  sanitizeClineProvidersDocument
} = require('./cline-credentials');

const PROVIDER_ARTIFACTS = Object.freeze(Object.fromEntries(
  Object.entries(PROVIDER_STORAGE_POLICIES).map(([provider, policy]) => [provider, policy.authArtifacts])
));

function normalizeProvider(provider) {
  const value = String(provider || '').trim().toLowerCase();
  return PROVIDER_ARTIFACTS[value] ? value : '';
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasProjectionData(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  return isPlainObject(value) && Object.keys(value).length > 0;
}

function resolveProjectionContext(runtimeDir, provider) {
  const normalizedProvider = normalizeProvider(provider);
  const normalizedRuntimeDir = normalizePathString(runtimeDir);
  if (!normalizedProvider || !normalizedRuntimeDir) return null;
  return {
    artifacts: PROVIDER_ARTIFACTS[normalizedProvider],
    provider: normalizedProvider,
    runtimeDir: normalizedRuntimeDir
  };
}

function resolveArtifactPath(context, artifact, path, options = {}) {
  let relativePath = Array.isArray(artifact && artifact.path)
    ? artifact.path
    : [];
  if (options.nativeHome === true) {
    const policy = PROVIDER_STORAGE_POLICIES[context.provider];
    const nativeRoot = policy && Array.isArray(policy.nativeRoot)
      ? policy.nativeRoot
      : [];
    const isNativeArtifact = nativeRoot.length > 0
      && relativePath.length >= nativeRoot.length
      && nativeRoot.every((segment, index) => relativePath[index] === segment);
    if (!isNativeArtifact) return '';
    relativePath = relativePath.slice(nativeRoot.length);
  }
  return path.join(context.runtimeDir, ...relativePath);
}

function resolveStorageContext(fs, provider, options = {}) {
  const aiHomeDir = normalizePathString(options.aiHomeDir);
  const accountRef = String(options.accountRef || '').trim();
  if (!aiHomeDir || !isAccountRef(accountRef)) return null;
  const account = resolveAccountRef(fs, aiHomeDir, accountRef, { bestEffort: true });
  if (!account || account.provider !== provider) return null;
  return { aiHomeDir, accountRef: account.accountRef };
}

function readArtifact(fs, artifactPath, format) {
  try {
    if (!fs.existsSync(artifactPath)) return null;
    if (format === 'binary-base64') {
      const raw = fs.readFileSync(artifactPath);
      if (!raw || !raw.length) return null;
      return Buffer.from(raw).toString('base64');
    }
    const raw = fs.readFileSync(artifactPath, 'utf8');
    if (format === 'text') return String(raw || '').trim();
    const parsed = JSON.parse(String(raw || ''));
    return isPlainObject(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function writeArtifactAtomic(fs, path, artifactPath, format, value) {
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  const tempPath = `${artifactPath}.aih-tmp-${process.pid}-${Date.now()}`;
  let renamed = false;
  try {
    if (format === 'binary-base64') {
      let bytes = null;
      if (Buffer.isBuffer(value)) bytes = value;
      else {
        const text = String(value || '').trim();
        if (!text) return;
        bytes = Buffer.from(text, 'base64');
      }
      fs.writeFileSync(tempPath, bytes);
    } else {
      const content = format === 'text'
        ? String(value || '').trim()
        : `${JSON.stringify(value, null, 2)}\n`;
      fs.writeFileSync(tempPath, content, 'utf8');
    }
    if (typeof fs.chmodSync === 'function') {
      try { fs.chmodSync(tempPath, 0o600); } catch (_chmodError) {}
    }
    try {
      fs.renameSync(tempPath, artifactPath);
    } catch (error) {
      if (!error || !['EEXIST', 'EPERM'].includes(error.code)) throw error;
      fs.unlinkSync(artifactPath);
      fs.renameSync(tempPath, artifactPath);
    }
    renamed = true;
    if (typeof fs.chmodSync === 'function') {
      try { fs.chmodSync(artifactPath, 0o600); } catch (_chmodError) {}
    }
  } finally {
    if (!renamed) {
      try { fs.unlinkSync(tempPath); } catch (_cleanupError) {}
    }
  }
}

function removeArtifact(fs, artifactPath) {
  try {
    if (!fs.existsSync(artifactPath)) return false;
    fs.unlinkSync(artifactPath);
    return true;
  } catch (_error) {
    return false;
  }
}

function hasRequiredProjectionData(artifacts, source) {
  return artifacts
    .filter((artifact) => !artifact.optional)
    .every((artifact) => hasProjectionData(source && source[artifact.field]));
}

function resolveProjectionSource(provider, source) {
  if (provider === 'agy' && isPlainObject(source)) {
    const projection = { ...source };
    if (hasProjectionData(source.oauthToken)) {
      projection.desktopOauthToken = source.oauthToken;
    }
    const oauthCreds = buildAgyGeminiOAuthCredentials(source.oauthToken);
    const googleAccounts = buildAgyGoogleAccounts(source.email);
    if (oauthCreds) projection.oauthCreds = oauthCreds;
    else delete projection.oauthCreds;
    if (googleAccounts) projection.googleAccounts = googleAccounts;
    else delete projection.googleAccounts;
    return projection;
  }
  if (provider === 'cline' && isPlainObject(source)) {
    // 写进沙箱的文档必须是 **CLI 自己的落盘形态**：只留 cline 槽位，且 `expiresAt` 为毫秒数字。
    // 字符串会让 CLI 把账号判成未登录（`Unauthorized … re-authenticate`，2026-10-15 单变量实测），
    // 所以投影前统一归一化 —— 历史记录与外部导入都可能带字符串。
    return { ...source, auth: sanitizeClineProvidersDocument(source.auth) };
  }
  if (provider !== 'kimi' || !isPlainObject(source)) return source;
  return {
    ...source,
    credentials: readKimiOAuthCredentials(source)
  };
}

function hasUsableProviderProjection(provider, artifacts, source) {
  const projectionSource = resolveProjectionSource(provider, source);
  if (!hasRequiredProjectionData(artifacts, projectionSource)) return false;
  if (CODEBUDDY_PRIMARY[provider]) return inspectCodebuddyCredential(projectionSource.credentials, provider).ok;
  if (provider === 'kimi') return hasUsableKimiOAuth(projectionSource.credentials);
  // cline 的 artifact 是**整库** providers.json（同机其它 provider 的密钥也在里面）：
  // 「文件存在」不等于「有 cline 凭据」，必须按 cline 槽位判定，否则一份只含
  // anthropic 的文档会被当成本账号的登录态投影进沙箱。
  if (provider === 'cline') return hasUsableClineCredential(projectionSource.auth);
  return true;
}

function mergeProviderAuthProjection(provider, current, projection) {
  if (provider === 'agy') {
    const next = { ...current };
    if (projection && Object.prototype.hasOwnProperty.call(projection, 'oauthToken')) {
      next.oauthToken = projection.oauthToken;
    }
    if (projection && Object.prototype.hasOwnProperty.call(projection, 'email')) {
      next.email = projection.email;
    }
    return next;
  }
  const next = { ...current, ...projection };
  if (provider === 'kimi' && hasUsableKimiOAuth(projection && projection.credentials)) {
    const deviceId = resolveKimiOAuthDeviceId(projection, current && current.deviceId);
    if (deviceId) next.deviceId = deviceId;
    delete next.auth;
  }
  // cline 的 artifact 是整库 providers.json：账号库里只留 cline 自己的槽位，
  // 绝不把同机其它 provider（anthropic / openrouter / gemini …）的明文密钥抄进账号记录。
  if (provider === 'cline') {
    const sanitized = sanitizeClineProvidersDocument(next.auth);
    if (hasUsableClineCredential(sanitized)) next.auth = sanitized;
    else delete next.auth;
  }
  // 凭据来源槽 → 显式 flavor：由**凭据策略**归一（见 provider-credentials 的 normalizeFlavor），
  // 不在这里写 provider 名分支。
  const normalizeFlavor = getProviderCredentialStrategy(provider).normalizeFlavor;
  if (typeof normalizeFlavor === 'function') {
    const normalized = normalizeFlavor(next);
    if (normalized && typeof normalized === 'object') return normalized;
  }
  return next;
}

function readProviderAuthProjection(fs, runtimeDir, provider, options = {}) {
  const path = options.path || nodePath;
  const context = resolveProjectionContext(runtimeDir, provider);
  if (!context) return {};
  if (CODEBUDDY_PRIMARY[context.provider]) {
    if (options.nativeHome === true) return {};
    const selected = selectCodebuddyCredential(fs, context.runtimeDir, context.provider, options);
    return selected.ok ? { credentials: selected.credential, codebuddyCredentialHostId: selected.hostId } : {};
  }
  const output = {};
  context.artifacts.forEach((artifact) => {
    const artifactPath = resolveArtifactPath(context, artifact, path, options);
    if (!artifactPath) return;
    if (context.provider === 'kiro' && artifact.field === 'database') {
      const snapshot = readKiroDatabaseSnapshot(artifactPath, {
        fs, path, DatabaseSync: options.DatabaseSync, os: options.os
      });
      if (snapshot) {
        Object.assign(output, snapshot);
      }
      return;
    }
    const value = readArtifact(fs, artifactPath, artifact.format);
    if (hasProjectionData(value)) output[artifact.field] = value;
  });
  if (context.provider === 'claude') {
    const credentials = readClaudeKeychainCredentials({
      processObj: options.processObj || process,
      execFileSync: options.execFileSync,
      configDir: path.join(context.runtimeDir, '.claude'),
      includeDefaultService: false
    });
    if (hasProjectionData(credentials)) output.credentials = credentials;
  }
  if (context.provider === 'kiro' && !output.auth) {
    const databaseArtifact = context.artifacts.find((artifact) => artifact.field === 'database');
    const databasePath = databaseArtifact
      ? path.join(context.runtimeDir, ...databaseArtifact.path)
      : '';
    const record = readKiroTokenRecord(databasePath, options);
    if (record && hasProjectionData(record.token)) {
      output.auth = record.token;
      output.authSlot = record.slot;
    }
  }
  return output;
}

// liveStore artifact（客户端会**原地续期**同一份文件）的代际判定：磁盘那份存在、可解析出
// 数据、且 mtime 晚于账号快照时，它就是更新的那一代，投影不得用旧快照覆盖它。其余情况
// （文件缺失/空对象/损坏/不新于快照）都必须用快照写回——这正是「客户端把库清成 `{}` 后
// 下次投影自愈」的路径。mtime 取不到时按「不新」处理，即宁可写回快照（快照至少可用）。
function isFresherLiveStore(fs, artifactPath, artifact, accountSnapshotUpdatedAt) {
  if (!accountSnapshotUpdatedAt) return false;
  let stat = null;
  try {
    stat = fs.statSync(artifactPath);
  } catch (_statError) {
    return false;
  }
  if (!stat || (typeof stat.isFile === 'function' && !stat.isFile())) return false;
  const liveMtimeMs = Number(stat.mtimeMs) || 0;
  if (!(liveMtimeMs > 0 && liveMtimeMs > accountSnapshotUpdatedAt)) return false;
  // 只认「确实读得出数据」的活文件：客户端清库后留下的 `{}` 虽有新 mtime，也必须
  // 让快照写回去自愈，否则空文件会一直盖住可用的账号快照。
  return hasProjectionData(readArtifact(fs, artifactPath, artifact.format));
}

function materializeProviderAuth(fs, runtimeDir, provider, options = {}) {
  const path = options.path || nodePath;
  const context = resolveProjectionContext(runtimeDir, provider);
  if (!context) {
    return { materialized: 0, removed: 0, missing: true, reason: 'invalid_projection_context' };
  }
  const storage = resolveStorageContext(fs, context.provider, options);
  if (!storage) {
    return { materialized: 0, removed: 0, missing: true, reason: 'unknown_account_ref' };
  }
  let nativeAuth = readAccountNativeAuth(fs, storage.aiHomeDir, storage.accountRef);
  let familyTargets = null;
  const familyEncryptedTargets = new Map();
  if (CODEBUDDY_PRIMARY[context.provider]) {
    // CN CodeBuddy can launch either the standalone CLI or WorkBuddy's bundled
    // CLI. They read different fixed host IDs even for the same authorized grant.
    // Both files here are derived, account-isolated projections, not host writes
    // or independent credential authorities. Capture always chooses by generation.
    familyTargets = context.provider === 'codebuddycn'
      ? codebuddyCredentialPaths(context.runtimeDir, context.provider)
      : [codebuddyProjectionPath(context.runtimeDir, context.provider, nativeAuth.codebuddyCredentialHostId)];
    for (const target of familyTargets) {
      const existing = readCodebuddyCredentialFile(fs, target, context.provider, Date.now(), options);
      if (existing.ok) {
        if (existing.encrypted) familyEncryptedTargets.set(target, existing);
        const decision = compareCodebuddyCredentials(nativeAuth.credentials, existing.credential, context.provider);
        if (!decision.adopt && !['unchanged', 'older_credential', 'candidate_credential_expired'].includes(decision.reason)) {
          return { materialized: 0, removed: 0, missing: true, reason: decision.reason };
        }
        if (decision.adopt) {
          const adopted = adoptCodebuddyCredential(fs, storage.aiHomeDir, context.provider, existing.credential,
            { accountRef: storage.accountRef, hostId: existing.hostId });
          if (!adopted.updated) return { materialized: 0, removed: 0, missing: true, reason: adopted.reason };
          nativeAuth = readAccountNativeAuth(fs, storage.aiHomeDir, storage.accountRef);
        }
      } else if (existing.reason !== 'credential_file_missing') {
        return { materialized: 0, removed: 0, missing: true, reason: existing.reason };
      }
    }
    if (!inspectCodebuddyCredential(nativeAuth.credentials, context.provider).ok) {
      return { materialized: 0, removed: 0, missing: true, reason: 'stored_credential_unverifiable' };
    }
  }

  // live-store 类 artifact（原生客户端会**原地续期**它，见 provider-storage-policy 的
  // zcode 声明）以磁盘那份为准，所以这里先取账号快照的更新时间作为代际基准。
  const accountSnapshotUpdatedAt = Number(
    (readAccountCredentialRecord(fs, storage.aiHomeDir, storage.accountRef) || {}).nativeAuthUpdatedAt
  ) || 0;
  let materialized = 0;
  let removed = 0;
  let projectionSource = resolveProjectionSource(context.provider, nativeAuth);
  const hasRequiredData = isPlainObject(nativeAuth)
    && hasUsableProviderProjection(context.provider, context.artifacts, nativeAuth);
  if (context.provider === 'kimi' && hasRequiredData) {
    const deviceId = resolveKimiOAuthDeviceId(nativeAuth)
      || deriveKimiDeviceId(projectionSource.credentials);
    if (deviceId && deviceId !== String(nativeAuth.deviceId || '').trim()) {
      nativeAuth = { ...nativeAuth, deviceId };
      writeAccountNativeAuth(fs, storage.aiHomeDir, storage.accountRef, nativeAuth);
      projectionSource = resolveProjectionSource(context.provider, nativeAuth);
    }
  }
  context.artifacts.forEach((artifact) => {
    const targets = familyTargets || [path.join(context.runtimeDir, ...artifact.path)];
    const value = projectionSource[artifact.field];
    for (const artifactPath of targets) {
      // 客户端原地续期过的活凭据比账号快照新：保留磁盘那份，不用旧快照盖回去。
      // 只在 artifact 声明 liveStore 时生效（见 provider-storage-policy），不写 provider 名分支。
      if (artifact.liveStore === true && hasRequiredData
        && isFresherLiveStore(fs, artifactPath, artifact, accountSnapshotUpdatedAt)) {
        // 但**快照里独有的键必须补进去**：客户端只写它自己那部分。真机（2026-10-28 账号 11）：
        // zcode CLI 登录只往 credentials.json 写 standalone 的 `account-provider:*` 键，
        // OAuth 令牌只落在账号快照里 → 桌面端读投影时拿不到令牌，弹
        // "Your session has expired. To keep your account secure, please sign in again."
        // 补键**不改写磁盘已有的值**，活凭据的续期结果不受影响（同名键仍以磁盘为准）。
        const live = readArtifact(fs, artifactPath, artifact.format);
        if (isPlainObject(live) && isPlainObject(value)) {
          const merged = { ...value, ...live };
          if (Object.keys(merged).length !== Object.keys(live).length) {
            writeArtifactAtomic(fs, path, artifactPath, artifact.format, merged);
          }
        }
        materialized += 1;
        continue;
      }
      if (!hasRequiredData || !hasProjectionData(value)) {
        if (removeArtifact(fs, artifactPath)) removed += 1;
        continue;
      }
      if (context.provider === 'kiro' && artifact.field === 'database') {
        materializeKiroDatabase(fs, path, artifactPath, projectionSource, () => {
          writeArtifactAtomic(fs, path, artifactPath, artifact.format, value);
        });
        materialized += 1;
        continue;
      }
      const encrypted = familyEncryptedTargets.get(artifactPath);
      const output = encrypted
        ? isDeepStrictEqual(value, encrypted.credential) ? encrypted.rawCredential
          : encodeWorkbuddyCredential(value, context.provider, { ...options, fs })
        : value;
      writeArtifactAtomic(fs, path, artifactPath, artifact.format, output);
      materialized += 1;
    }
  });
  return { materialized, removed, missing: !hasRequiredData };
}

function captureProviderAuth(fs, runtimeDir, provider, options = {}) {
  const context = resolveProjectionContext(runtimeDir, provider);
  if (!context) return { captured: false, reason: 'unsupported_provider' };
  const storage = resolveStorageContext(fs, context.provider, options);
  if (!storage) return { captured: false, reason: 'unknown_account' };
  const projection = readProviderAuthProjection(fs, runtimeDir, context.provider, options);
  if (context.provider === 'kiro' && options.projectionMetadata?.identityEvidence) {
    projection.identityEvidence = options.projectionMetadata.identityEvidence;
  }
  if (!hasUsableProviderProjection(context.provider, context.artifacts, projection)) {
    return { captured: false, reason: 'missing_projection' };
  }
  if (CODEBUDDY_PRIMARY[context.provider]) {
    const outcome = adoptCodebuddyCredential(fs, storage.aiHomeDir, context.provider, projection.credentials,
      { accountRef: storage.accountRef, hostId: projection.codebuddyCredentialHostId });
    return { captured: outcome.updated === true, reason: outcome.reason,
      nativeAuth: readAccountNativeAuth(fs, storage.aiHomeDir, storage.accountRef) };
  }
  const current = readAccountNativeAuth(fs, storage.aiHomeDir, storage.accountRef);
  if (getProviderCredentialStrategy(context.provider).dedupeByNativeIdentity) {
    const before = resolveNativeAuthIdentitySeed(context.provider, current);
    const after = resolveNativeAuthIdentitySeed(context.provider, projection);
    if (before.degraded || after.degraded || !before.identitySeed || before.identitySeed !== after.identitySeed) {
      return { captured: false, reason: 'account_identity_mismatch' };
    }
  }
  const next = mergeProviderAuthProjection(context.provider, current, projection);
  if (isDeepStrictEqual(current, next)) {
    return { captured: false, reason: 'unchanged', nativeAuth: current };
  }
  if (context.provider === 'kiro') {
    const record = readAccountCredentialRecord(fs, storage.aiHomeDir, storage.accountRef);
    if (!matchesKiroCredentialVersion(record, options.expectedKiroVersions)
      || !compareAndSwapAccountNativeAuth(fs, storage.aiHomeDir, storage.accountRef, record, next)) {
      return { captured: false, reason: 'concurrent_credential_update' };
    }
  } else writeAccountNativeAuth(fs, storage.aiHomeDir, storage.accountRef, next);
  return { captured: true, reason: 'updated', nativeAuth: next };
}

function findExistingAccountByNativeAuthIdentity(fs, aiHomeDir, provider, nativeAuth) {
  const normalizedProvider = normalizeProvider(provider);
  const identity = resolveNativeAuthIdentitySeed(normalizedProvider, nativeAuth);
  if (!normalizedProvider || !identity.identitySeed || identity.degraded) return null;

  const records = listAccountRefRecords(fs, aiHomeDir, normalizedProvider, { bestEffort: true });
  let match = null;
  for (const record of records) {
    const current = readAccountNativeAuth(fs, aiHomeDir, record.accountRef);
    const currentIdentity = resolveNativeAuthIdentitySeed(normalizedProvider, current);
    if (!currentIdentity.identitySeed || currentIdentity.degraded) continue;
    if (currentIdentity.identitySeed !== identity.identitySeed) continue;
    const alias = resolveCliAccountRef(fs, aiHomeDir, record.accountRef, { bestEffort: true });
    if (match) return { ambiguous: true };
    match = {
      accountRef: record.accountRef,
      cliAccountId: alias && alias.cliAccountId || ''
    };
  }
  return match;
}

function registerProviderAuthProjection(fs, runtimeDir, provider, options = {}) {
  let context = resolveProjectionContext(runtimeDir, provider);
  const aiHomeDir = normalizePathString(options.aiHomeDir);
  const requestedCliAccountId = String(options.cliAccountId || '').trim();
  if (!context || !aiHomeDir || (requestedCliAccountId && !/^\d+$/.test(requestedCliAccountId))) {
    return { registered: false, reason: 'invalid_registration_context' };
  }
  // CodeBuddy 家族：**站点真值只在 token 里**。同一支 CLI 首启会让用户选国内站 /
  // 国际站 / 企业域名，所以「用户敲的是 aih codebuddy 还是 aih codebuddycn」不能决定
  // 这次登录落在哪个 Provider。先按 realm 换到真正的家族 Provider，再读投影 ——
  // 否则国内站登录会被国际站的 realm 校验判成 missing_projection（2026-10-31 真机）。
  let familyOwnerReason = '';
  if (CODEBUDDY_PRIMARY[context.provider]) {
    const owner = resolveCodebuddyCredentialOwner(fs, context.runtimeDir, context.provider, options);
    if (owner.ok) {
      if (owner.provider !== context.provider) {
        context = resolveProjectionContext(runtimeDir, owner.provider) || context;
      }
    } else {
      familyOwnerReason = owner.reason;
    }
  }
  const projection = readProviderAuthProjection(fs, runtimeDir, context.provider, options);
  if (!hasUsableProviderProjection(context.provider, context.artifacts, projection)) {
    return { registered: false, reason: familyOwnerReason || 'missing_projection' };
  }
  const projectionMetadata = isPlainObject(options.projectionMetadata)
    ? options.projectionMetadata
    : {};
  const persistedProjection = { ...projection, ...projectionMetadata };
  // 凭据本身不可读的 provider（如 qoder 的 opaque `.auth/user`）由**凭据策略**补
  // 「展示身份」：策略声明的 projectionMetadata 只用于账号记录/展示（summarize*Auth 读它），
  // 不参与身份推导——身份仍只来自 resolveNativeAuthIdentitySeed。
  const credentialStrategy = getProviderCredentialStrategy(context.provider);
  const strategyMetadata = credentialStrategy && typeof credentialStrategy.projectionMetadata === 'function'
    ? (credentialStrategy.projectionMetadata(persistedProjection) || null)
    : null;
  const recordedProjection = isPlainObject(strategyMetadata)
    ? { ...persistedProjection, ...strategyMetadata }
    : persistedProjection;
  const identity = resolveNativeAuthIdentitySeed(context.provider, recordedProjection);
  if (!identity.identitySeed || identity.degraded) {
    return { registered: false, reason: 'missing_stable_identity' };
  }

  if (CODEBUDDY_PRIMARY[context.provider]) {
    // Explicit registration resolves this login's identity rather than copying
    // it into an unrelated previous reauthentication target.
    const adopted = adoptCodebuddyCredential(fs, aiHomeDir, context.provider, projection.credentials,
      { cliAccountId: requestedCliAccountId, hostId: projection.codebuddyCredentialHostId });
    // provider 回给调用方：realm 可能把这次登录改档到另一支家族 Provider（国内站/国际站），
    // 调用方据此决定提示文案与随后启动哪支 CLI，而不是继续用用户敲的那个别名。
    return { ...adopted, provider: context.provider };
  }

  // Kimi 与 ZCode 共用一个「同身份重复登录刷新既有账号」的去重安全网：
  // - Kimi 的历史账号以 refresh-token 哈希为键，原生 token 现在暴露稳定的
  //   user_id/sub，重新导入/重登匹配到同一用户时沿用旧 accountRef。
  // - ZCode 桌面端只有一份共享 credentials.json（last login wins），同一上游
  //   用户重复登录时若不刷新既有账号，旧账号的 JWT 会被上游作废、永久 401。
  // 两种情况都只认「身份种子匹配」：reauth 目标账号的种子与新投影不同则视为
  // 另一个用户，绝不覆盖其凭据。
  let existing = null;
  if (getProviderCredentialStrategy(context.provider).dedupeByNativeIdentity) {
    const requestedAccountRef = String(options.accountRef || '').trim();
    if (isAccountRef(requestedAccountRef)) {
      const requested = resolveAccountRef(fs, aiHomeDir, requestedAccountRef, { bestEffort: true });
      if (requested && requested.provider === context.provider) {
        const current = readAccountNativeAuth(fs, aiHomeDir, requestedAccountRef);
        const currentIdentity = resolveNativeAuthIdentitySeed(context.provider, current);
        // A reauth target is only a routing hint. Never let a successful OAuth
        // flow for another user overwrite that account's credentials.
        if (currentIdentity.identitySeed && !currentIdentity.degraded
          && currentIdentity.identitySeed === identity.identitySeed) {
          const alias = resolveCliAccountRef(fs, aiHomeDir, requestedAccountRef, { bestEffort: true });
          existing = {
            accountRef: requestedAccountRef,
            cliAccountId: alias && alias.cliAccountId || ''
          };
        }
      }
    }
    if (!existing) {
      existing = findExistingAccountByNativeAuthIdentity(
        fs,
        aiHomeDir,
        context.provider,
        recordedProjection
      );
    }
  }
  if (existing && existing.ambiguous) return { registered: false, reason: 'ambiguous_existing_identity' };
  // 自动观察（宿主扫描）只**新增**账号：库里已有同身份账号时一律不写——宿主那份与库内那份
  // 谁更新比不出来，比不出来就不动库（库内凭据可能已被沙箱续期成更新的一代）。
  const insertOnly = options.insertOnly === true;
  if (existing && insertOnly) {
    return { registered: false, reason: 'existing_account_unchanged', accountRef: existing.accountRef };
  }
  if (existing) {
    const current = readAccountNativeAuth(fs, aiHomeDir, existing.accountRef);
    const next = mergeProviderAuthProjection(context.provider, current, recordedProjection);
    if (context.provider === 'kiro') {
      const record = readAccountCredentialRecord(fs, aiHomeDir, existing.accountRef);
      if (!matchesKiroCredentialVersion(record, options.expectedKiroVersions)
        || !compareAndSwapAccountNativeAuth(fs, aiHomeDir, existing.accountRef, record, next)) {
        return { registered: false, reason: 'concurrent_credential_update' };
      }
    } else writeAccountNativeAuth(fs, aiHomeDir, existing.accountRef, next);
    return {
      registered: true,
      reason: 'existing_account',
      accountRef: existing.accountRef,
      cliAccountId: existing.cliAccountId,
      provider: context.provider
    };
  }

  let registration;
  try {
    registration = registerAccountIdentity(fs, aiHomeDir, {
      provider: context.provider,
      identitySeed: identity.identitySeed,
      cliAccountId: requestedCliAccountId,
      // 自动观察不等于用户显式登记：用户删掉的账号（墓碑）不能被扫回来。
      ...(options.respectDeletion === true ? { respectDeletion: true } : {})
    });
  } catch (error) {
    if (error && error.code === 'account_deleted_by_user') {
      return { registered: false, reason: 'account_deleted_by_user' };
    }
    return { registered: false, reason: 'account_ref_registration_failed' };
  }
  const accountRef = registration.accountRef;
  const current = readAccountNativeAuth(fs, aiHomeDir, accountRef);
  // 账号行已存在且已有凭据：同上，比不出代际就不覆盖（只补「登记了但凭据没落地」的空账号）。
  if (insertOnly && !registration.created && isPlainObject(current) && Object.keys(current).length > 0) {
    return { registered: false, reason: 'existing_account_unchanged', accountRef };
  }
  const next = mergeProviderAuthProjection(context.provider, current, recordedProjection);
  if (context.provider === 'kiro') {
    if (!(options.expectedKiroVersions instanceof Map)
      || !insertAccountNativeAuthIfMissing(fs, aiHomeDir, accountRef, next)) {
      return { registered: false, reason: 'concurrent_credential_update' };
    }
  } else writeAccountNativeAuth(fs, aiHomeDir, accountRef, next);
  return {
    registered: true,
    reason: registration.created ? 'created' : 'existing_account',
    accountRef,
    cliAccountId: registration.cliAccountId,
    provider: context.provider
  };
}

module.exports = {
  PROVIDER_ARTIFACTS,
  captureProviderAuth,
  materializeProviderAuth,
  readProviderAuthProjection,
  findExistingAccountByNativeAuthIdentity,
  registerProviderAuthProjection
};
