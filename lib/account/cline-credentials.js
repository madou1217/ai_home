'use strict';

/**
 * Cline CLI（`@cline/cli` 的 `cline` 二进制）把**所有 provider 的登录态**写在一份文档里：
 *
 *   <CLINE_DIR>/data/settings/providers.json
 *   { version, lastUsedProvider, providers: { <providerId>: { settings, updatedAt, tokenSource } } }
 *
 * 其中 cline 自己有两种凭据形态，且 Cline Pass 订阅会**同时**写两个槽位：
 *
 *   providers['cline'].settings.auth        = { accessToken: 'workos:<JWT>', refreshToken, expiresAt, accountId, metadata }
 *   providers['cline-pass'].settings.auth   = 同上（Cline Pass 订阅登录）
 *   providers['cline'].settings.apiKey      = '<key>'（API Key 账号；CLI 会把环境变量里的 key 迁移进来）
 *
 * 这份文档还装着**其它** provider 的明文密钥（anthropic / openrouter / gemini …），所以
 * 任何持久化与投影都必须先按槽位收窄：账号库里只留 cline 自己的槽位，沙箱里只覆盖 cline
 * 自己的槽位，绝不搬运别人的密钥（避免跨账号串号）。
 *
 * 本模块只做纯数据变换（无 I/O）：磁盘格式、前缀剥离、时间归一、槽位选择与合并规则
 * 集中在这里，供凭据端口、原生 auth 投影、启动策略、服务端账号装载与刷新策略共用。
 */

const CLINE_PROVIDER_ID = 'cline';
const CLINE_PASS_PROVIDER_ID = 'cline-pass';
// Cline Pass 订阅与 API Key 账号的槽位；顺序即「同代凭据优先取谁」的顺序。
const CLINE_SLOT_IDS = Object.freeze([CLINE_PROVIDER_ID, CLINE_PASS_PROVIDER_ID]);
// accessToken 在磁盘上带 WorkOS 签发标记前缀（`workos:<JWT>`），**这个前缀是 wire
// 格式的一部分**：2026-10-14 在本机实测 `Authorization: Bearer workos:<JWT>` → HTTP 200
// （正常返回 choices），裸 JWT → HTTP 401
// `{"error":"Unauthorized: Please make sure you're using the latest version of Cline and re-authenticate your Cline account."}`
// （`/models` 是公开端点，四种写法都 200，不能用它判定）。因此：
//   - 出网鉴权与持久化都保留前缀（credential.accessToken）；
//   - 只有「解 JWT 声明」这类纯本地计算才剥前缀（bareAccessToken / decodeClineJwtPayload）。
const CLINE_ACCESS_TOKEN_PREFIX = 'workos:';
// 文档版本号：**必须是数字**。CLI 会按自己的 schema 校验整份文档，`version: "1"`（字符串）
// 会让它把账号判成未登录 → `Unauthorized … re-authenticate`（2026-10-15 单变量实测）。
const CLINE_DOCUMENT_VERSION = 1;
const CLINE_USER_INFO_KEYS = Object.freeze(['name', 'email', 'clineUserId', 'userId', 'accountId', 'subject']);
const CLINE_ACCOUNT_ID_KEYS = Object.freeze(['accountId', 'clineUserId', 'userId']);

/** 版本号归一化成数字（CLI schema 要求）；无法解析时回落 CLINE_DOCUMENT_VERSION。 */
function normalizeClineDocumentVersion(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const numeric = Number(normalizeText(value));
  return Number.isFinite(numeric) && numeric > 0 ? numeric : CLINE_DOCUMENT_VERSION;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

/** 剥掉 `workos:` 标记，只用于解 JWT 声明（本地计算）；出网与持久化必须保留前缀。 */
function stripClineAccessTokenPrefix(value) {
  const text = normalizeText(value);
  if (!text) return '';
  return text.startsWith(CLINE_ACCESS_TOKEN_PREFIX)
    ? text.slice(CLINE_ACCESS_TOKEN_PREFIX.length).trim()
    : text;
}

/**
 * 出网/落盘形态：**必须**带 `workos:` 标记。刷新接口（`POST /api/v1/auth/refresh`）
 * 返回的是裸 JWT（实测响应里 `data.accessToken` 以 `eyJ` 开头），而同一个 token 加前缀
 * 后请求 200、不加前缀 401——所以写回磁盘前统一补前缀，磁盘上的旧值原样保留。
 */
function ensureClineAccessTokenPrefix(value) {
  const text = normalizeText(value);
  if (!text) return '';
  return text.startsWith(CLINE_ACCESS_TOKEN_PREFIX)
    ? text
    : `${CLINE_ACCESS_TOKEN_PREFIX}${text}`;
}

/**
 * `expiresAt` 在磁盘上是**毫秒时间戳字符串**（`"1791963322000"`），刷新接口返回 ISO 串。
 * 两种都归一到 epoch ms；无法解析返回 0（调用方按「未知」处理，不做乐观判断）。
 */
function normalizeClineExpiresAtMs(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // 秒级与毫秒级时间戳都出现过；1e12 以下按秒处理。
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  const text = normalizeText(value);
  if (!text) return 0;
  if (/^\d+$/.test(text)) return normalizeClineExpiresAtMs(Number(text));
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function decodeClineJwtPayload(token) {
  const text = stripClineAccessTokenPrefix(token);
  const parts = text.split('.');
  if (parts.length < 2) return null;
  try {
    const rawPayload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const parsed = JSON.parse(Buffer.from(rawPayload, 'base64').toString('utf8'));
    return isPlainObject(parsed) ? parsed : null;
  } catch (_error) {
    return null;
  }
}

function readClineSlotSettings(doc, slotId) {
  if (!isPlainObject(doc) || !isPlainObject(doc.providers)) return null;
  const slot = doc.providers[slotId];
  return isPlainObject(slot) && isPlainObject(slot.settings) ? slot.settings : null;
}

function readClineSlotAuth(doc, slotId) {
  const settings = readClineSlotSettings(doc, slotId);
  return settings && isPlainObject(settings.auth) ? settings.auth : null;
}

/** 该槽位的 API Key（Cline 的 API Key 账号形态；不是 OAuth 记录）。 */
function readClineSlotApiKey(doc, slotId) {
  const settings = readClineSlotSettings(doc, slotId);
  return settings ? normalizeText(settings.apiKey) : '';
}

function readClineApiKey(doc) {
  for (const slotId of CLINE_SLOT_IDS) {
    const apiKey = readClineSlotApiKey(doc, slotId);
    if (apiKey) return apiKey;
  }
  return '';
}

function toClineCredential(doc, slotId) {
  const auth = readClineSlotAuth(doc, slotId);
  if (!auth) return null;
  // wire 形态：保留 `workos:` 前缀（见 CLINE_ACCESS_TOKEN_PREFIX 的实测说明）；
  // 磁盘上万一存了裸 JWT，这里补前缀，出网侧永远看到合法形态。
  const accessToken = ensureClineAccessTokenPrefix(auth.accessToken || auth.access_token);
  const refreshToken = normalizeText(auth.refreshToken || auth.refresh_token);
  if (!accessToken && !refreshToken) return null;
  return {
    slotId,
    accessToken,
    // 解声明用的裸 JWT（身份/展示名），绝不出现在 Authorization 头里。
    bareAccessToken: stripClineAccessTokenPrefix(accessToken),
    refreshToken,
    expiresAt: normalizeClineExpiresAtMs(auth.expiresAt || auth.expires_at),
    accountId: normalizeText(auth.accountId),
    userInfo: isPlainObject(auth.metadata) && isPlainObject(auth.metadata.userInfo)
      ? auth.metadata.userInfo
      : {},
    // 原始记录（保留 metadata）：身份种子与写回都用它。
    raw: auth
  };
}

/**
 * Cline Pass 登录会同时写 `cline` 与 `cline-pass` 两个槽位，两者各自续期、有效期不同。
 * 取剩余有效期更长的那一条；同有效期时按 CLINE_SLOT_IDS 的顺序取（`cline` 优先）。
 */
function selectClineOAuthCredential(doc) {
  let selected = null;
  for (const slotId of CLINE_SLOT_IDS) {
    const candidate = toClineCredential(doc, slotId);
    if (!candidate) continue;
    if (!selected || candidate.expiresAt > selected.expiresAt) selected = candidate;
  }
  return selected;
}

/**
 * 「这份文档里有可用的 cline 凭据」——OAuth 记录或 API Key 都算。
 * 投影/捕获的准入门槛：Cline 的 providers.json 里通常还装着别的 provider，
 * 只看「文件存在」会把一份不含 cline 凭据的文档当成本账号的凭据。
 */
function hasUsableClineCredential(doc) {
  return Boolean(readClineApiKey(doc) || selectClineOAuthCredential(doc));
}

function readClineAccessToken(doc) {
  const credential = selectClineOAuthCredential(doc);
  return credential ? credential.accessToken : '';
}

function readClineRefreshToken(doc) {
  const credential = selectClineOAuthCredential(doc);
  return credential ? credential.refreshToken : '';
}

function readClineTokenExpiryMs(doc) {
  const credential = selectClineOAuthCredential(doc);
  return credential ? credential.expiresAt : 0;
}

/**
 * access token 的 JWT `iat`（签发时间，epoch ms）。**代际比较用它，不用 expiresAt**：
 * 旧 grant 也可能有更长的有效期（同 codex 的既有结论），而 `iat` 每次签发都会前进。
 * 解不出来返回 0（调用方按「未知」处理，不做乐观判断）。
 */
function readClineTokenIssuedAtMs(doc) {
  const credential = selectClineOAuthCredential(doc);
  if (!credential) return 0;
  const payload = decodeClineJwtPayload(credential.accessToken);
  const issuedAt = payload ? Number(payload.iat) : 0;
  return Number.isFinite(issuedAt) && issuedAt > 0 ? Math.round(issuedAt * 1000) : 0;
}

function readClineAccountId(doc) {
  const credential = selectClineOAuthCredential(doc);
  if (credential) {
    for (const key of CLINE_ACCOUNT_ID_KEYS) {
      const value = normalizeText(credential.userInfo[key] || (key === 'accountId' ? credential.accountId : ''));
      if (value) return value;
    }
  }
  const payload = decodeClineJwtPayload(readClineAccessToken(doc));
  return payload ? normalizeText(payload.external_id || payload.externalId) : '';
}

/** 展示名：优先账号名/邮箱（来自 auth.metadata.userInfo，或 JWT 声明兜底）。 */
function resolveClineAccountName(doc, fallback = '') {
  const credential = selectClineOAuthCredential(doc);
  if (credential) {
    for (const key of CLINE_USER_INFO_KEYS) {
      const value = normalizeText(credential.userInfo[key]);
      if (value) return value;
    }
    if (credential.accountId) return credential.accountId;
  }
  const payload = decodeClineJwtPayload(readClineAccessToken(doc));
  if (payload) {
    for (const key of ['email', 'name', 'external_id']) {
      const value = normalizeText(payload[key]);
      if (value) return value;
    }
  }
  return normalizeText(fallback);
}

/**
 * 账号库里只保留 cline 自己的槽位：providers.json 是宿主/沙箱里所有 provider 的
 * 明文密钥集合，整份入库等于把别人的密钥抄进本账号记录。
 */
function sanitizeClineProvidersDocument(doc) {
  const source = isPlainObject(doc) ? doc : {};
  const sourceProviders = isPlainObject(source.providers) ? source.providers : {};
  const providers = {};
  for (const slotId of CLINE_SLOT_IDS) {
    const slot = sourceProviders[slotId];
    if (!isPlainObject(slot)) continue;
    // 归一化到 CLI 的落盘形态：`expiresAt` 必须是毫秒**数字**（字符串会被 CLI 当成未登录，
    // 见 applyClineCredentialToDocument 的实测说明）。历史记录与外部导入都可能带字符串。
    const settings = isPlainObject(slot.settings) ? slot.settings : null;
    const auth = settings && isPlainObject(settings.auth) ? settings.auth : null;
    if (!auth || auth.expiresAt === undefined || auth.expiresAt === null) {
      providers[slotId] = slot;
      continue;
    }
    const numericExpiry = normalizeClineExpiresAtMs(auth.expiresAt);
    providers[slotId] = numericExpiry > 0 && typeof auth.expiresAt !== 'number'
      ? { ...slot, settings: { ...settings, auth: { ...auth, expiresAt: numericExpiry } } }
      : slot;
  }
  const lastUsed = CLINE_SLOT_IDS.includes(normalizeText(source.lastUsedProvider))
    ? normalizeText(source.lastUsedProvider)
    : (providers[CLINE_PASS_PROVIDER_ID] ? CLINE_PASS_PROVIDER_ID : CLINE_PROVIDER_ID);
  const next = {
    version: normalizeClineDocumentVersion(source.version),
    lastUsedProvider: lastUsed,
    providers
  };
  // `modes` 是 CLI 自己的会话模式书签（非凭据）：保留，避免投影回沙箱时被清掉。
  if (isPlainObject(source.modes)) next.modes = source.modes;
  return next;
}

/**
 * 「要不要把 incoming 这份文档并进账号库」的判定（**纯函数**，宿主发现/沙箱投影共用）。
 *
 * 代际顺序（与 codex 同构，最后一步才退到 expiresAt）：
 *   1. incoming 没有 OAuth 记录 / 已过期 → 不采纳（API Key 形态不参与自动入库）；
 *   2. 库里没有 OAuth 记录 → 采纳（首次发现本机登录态）；
 *   3. access/refresh 都相同 → `unchanged`（幂等，避免每 3s 重复写库）；
 *   4. 两边都有 JWT `iat` 且不同 → 按签发时间比（旧 grant 也可能有效期更长）；
 *   5. 退到 `expiresAt`：更大 → 采纳；相等但 token 不同 = 同代轮换 → 采纳（与
 *      mergeClineSlot 的 `>=` 取新一致）；更小 → 不采纳（绝不用旧凭据降级新凭据）；
 *   6. 两边时间都不可比 → 不动库（`credential_time_ambiguous`，宁可漏采不可误采）。
 */
function compareClineCredentialDocuments(storedDoc, incomingDoc, options = {}) {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const incoming = selectClineOAuthCredential(incomingDoc);
  if (!incoming) return { adopt: false, reason: 'no_oauth_credential' };
  if (incoming.expiresAt > 0 && incoming.expiresAt <= nowMs) return { adopt: false, reason: 'credential_expired' };
  const stored = selectClineOAuthCredential(storedDoc);
  if (!stored) return { adopt: true, reason: 'database_credentials_missing' };
  if (stored.accessToken === incoming.accessToken && stored.refreshToken === incoming.refreshToken) {
    return { adopt: false, reason: 'unchanged' };
  }
  const storedIssuedAt = readClineTokenIssuedAtMs(storedDoc);
  const incomingIssuedAt = readClineTokenIssuedAtMs(incomingDoc);
  if (storedIssuedAt && incomingIssuedAt && storedIssuedAt !== incomingIssuedAt) {
    return incomingIssuedAt > storedIssuedAt
      ? { adopt: true, reason: 'newer_token_issued_at' }
      : { adopt: false, reason: 'older_token_issued_at' };
  }
  if (incoming.expiresAt > 0 && incoming.expiresAt !== stored.expiresAt) {
    return incoming.expiresAt > stored.expiresAt
      ? { adopt: true, reason: 'newer_expires_at' }
      : { adopt: false, reason: 'older_expires_at' };
  }
  if (incoming.expiresAt > 0 && incoming.expiresAt === stored.expiresAt) {
    // 同一有效期但 token 变了：同一秒内完成的轮换，取新（与 mergeClineSlot 的 >= 一致）。
    return { adopt: true, reason: 'same_expiry_rotated' };
  }
  return { adopt: false, reason: 'credential_time_ambiguous' };
}

/**
 * 单个槽位的合并。`auth` 默认按 `expiresAt` **取新**——宿主/沙箱里 CLI 刚轮换过的
 * 新凭据不能被账号库里的旧凭据降级（旧 refresh grant 可能已被消费）；账号库里存的
 * API Key 是权威（沙箱里的 key 可能是别的账号/宿主环境变量迁移进来的）。
 *
 * `options.preferStored` 用于「显式选定账号」的写回（set-default）：用户刚点名要用的
 * 账号必须成为生效凭据，不能因为宿主那份有效期更晚就被顶回去（同 claude 的
 * selectedExplicitly 语义）。
 */
function mergeClineSlot(onDiskSlot, storedSlot, options = {}) {
  const diskSlot = isPlainObject(onDiskSlot) ? onDiskSlot : null;
  const storedSlotRecord = isPlainObject(storedSlot) ? storedSlot : null;
  if (!diskSlot) return storedSlotRecord ? { ...storedSlotRecord } : null;
  if (!storedSlotRecord) return { ...diskSlot };

  const diskSettings = isPlainObject(diskSlot.settings) ? diskSlot.settings : {};
  const storedSettings = isPlainObject(storedSlotRecord.settings) ? storedSlotRecord.settings : {};
  const diskAuth = isPlainObject(diskSettings.auth) ? diskSettings.auth : null;
  const storedAuth = isPlainObject(storedSettings.auth) ? storedSettings.auth : null;
  let auth = diskAuth;
  if (storedAuth) {
    auth = diskAuth
      ? (options.preferStored === true
        ? storedAuth
        : (normalizeClineExpiresAtMs(diskAuth.expiresAt || diskAuth.expires_at)
          >= normalizeClineExpiresAtMs(storedAuth.expiresAt || storedAuth.expires_at)
          ? diskAuth
          : storedAuth))
      : storedAuth;
  }

  const settings = { ...storedSettings, ...diskSettings };
  if (auth) settings.auth = auth;
  else delete settings.auth;
  const apiKey = normalizeText(storedSettings.apiKey) || normalizeText(diskSettings.apiKey);
  if (apiKey) settings.apiKey = apiKey;
  else delete settings.apiKey;

  return { ...storedSlotRecord, ...diskSlot, settings };
}

/**
 * 把账号库里的 cline 槽位合并进一份**已有的** providers.json，其它 provider 的条目
 * 原样保留。当前唯一调用方是写回宿主（`host-sync` 的 cline 分支）：宿主那份文档还装着
 * 用户自己的 anthropic / openrouter / gemini 配置，整文件覆盖等于替用户删配置。
 *
 * 沙箱方向不走这里：投影写入是整文件原子替换（native-auth-projection 的通用语义），
 * 入库前的收窄由 sanitizeClineProvidersDocument 负责。
 */
function mergeClineProvidersDocument(existing, stored, options = {}) {
  const base = isPlainObject(existing) ? existing : {};
  const incoming = isPlainObject(stored) ? stored : {};
  const baseProviders = isPlainObject(base.providers) ? base.providers : {};
  const incomingProviders = isPlainObject(incoming.providers) ? incoming.providers : {};
  const providers = { ...baseProviders };
  for (const slotId of CLINE_SLOT_IDS) {
    const merged = mergeClineSlot(baseProviders[slotId], incomingProviders[slotId], options);
    if (merged) providers[slotId] = merged;
    else delete providers[slotId];
  }
  const incomingLastUsed = normalizeText(incoming.lastUsedProvider);
  const baseLastUsed = normalizeText(base.lastUsedProvider);
  const lastUsed = CLINE_SLOT_IDS.includes(incomingLastUsed)
    ? incomingLastUsed
    : CLINE_SLOT_IDS.includes(baseLastUsed)
      ? baseLastUsed
      : CLINE_PROVIDER_ID;
  return {
    ...base,
    version: normalizeClineDocumentVersion(base.version || incoming.version),
    lastUsedProvider: lastUsed,
    providers
  };
}

/**
 * 刷新成功后把新凭据写回**每一个 cline 槽位**：CLI 自己就是两个槽位同步的（实测
 * `cline` 与 `cline-pass` 的 accessToken/refreshToken 完全相同），只更新其中一个
 * 会让另一个持有已被消费的 grant，CLI 下次续期就会把自己的凭据文件判成失效。
 * 各槽位自己的 `model`/`reasoning` 等设置原样保留。
 */
function applyClineCredentialToDocument(doc, credential, nowMs = Date.now()) {
  const source = isPlainObject(doc) ? doc : {};
  const providers = isPlainObject(source.providers) ? { ...source.providers } : {};
  const accessToken = normalizeText(credential && credential.accessToken);
  const refreshToken = normalizeText(credential && credential.refreshToken);
  const expiresAt = normalizeClineExpiresAtMs(credential && credential.expiresAt);
  if (!accessToken && !refreshToken) return sanitizeClineProvidersDocument(source);

  let touched = false;
  for (const slotId of CLINE_SLOT_IDS) {
    const slot = providers[slotId];
    if (!isPlainObject(slot)) continue;
    const settings = isPlainObject(slot.settings) ? slot.settings : {};
    const auth = isPlainObject(settings.auth) ? settings.auth : {};
    const nextAuth = { ...auth };
    if (accessToken) nextAuth.accessToken = accessToken;
    if (refreshToken) nextAuth.refreshToken = refreshToken;
    // **必须是数字**：Cline CLI 落盘的就是毫秒数字（`1792029657000`），写字符串会让它
    // 把账号判成未登录 → `Unauthorized … re-authenticate`（2026-10-15 单变量实测：
    // 把宿主那份可用文档的 expiresAt 改成字符串即复现 401）。
    if (expiresAt > 0) nextAuth.expiresAt = expiresAt;
    providers[slotId] = {
      ...slot,
      settings: { ...settings, auth: nextAuth },
      updatedAt: new Date(nowMs).toISOString()
    };
    touched = true;
  }
  if (!touched) return sanitizeClineProvidersDocument(source);
  return { ...source, providers };
}

module.exports = {
  CLINE_PROVIDER_ID,
  CLINE_PASS_PROVIDER_ID,
  CLINE_SLOT_IDS,
  CLINE_ACCESS_TOKEN_PREFIX,
  CLINE_DOCUMENT_VERSION,
  applyClineCredentialToDocument,
  compareClineCredentialDocuments,
  ensureClineAccessTokenPrefix,
  hasUsableClineCredential,
  mergeClineProvidersDocument,
  normalizeClineExpiresAtMs,
  readClineAccessToken,
  readClineAccountId,
  readClineApiKey,
  readClineRefreshToken,
  readClineSlotApiKey,
  readClineSlotAuth,
  readClineTokenExpiryMs,
  readClineTokenIssuedAtMs,
  resolveClineAccountName,
  sanitizeClineProvidersDocument,
  selectClineOAuthCredential,
  stripClineAccessTokenPrefix
};

