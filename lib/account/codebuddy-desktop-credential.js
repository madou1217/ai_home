'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  codebuddyDesktopUserDataDirs,
  codebuddyDesktopUserDataRoots,
  normalizeFamilyProvider,
  resolveFamilyPathImpl,
  resolveFamilyPlatform
} = require('../runtime/codebuddy-family-layouts');

// IDE 的 SecretStorage 会独立续期，不保证同时更新独立 CLI 的共享 .info。
// 只读官方 Electron 登录仓；站点与身份校验仍由 credential-source 统一负责。
//
// 只有 CodeBuddy IDE 需要这条来源：WorkBuddy 桌面端与它内嵌的 CodeBuddy Code CLI
// 读写的是**同一个共享 .info**（见 provider-storage-policy 的 CODEBUDDY_CN_SHARED_AUTH_PATH
// 注释），不存在"桌面端另续期一份"的问题，因此这里不为 workbuddy / workbuddycn 声明 App 名。
const DESKTOP_NAMES = Object.freeze({ codebuddy: 'CodeBuddy', codebuddycn: 'CodeBuddy CN' });
// 声明的 App 名集合：扫描阶段用它排除"已被某个 Provider 认领"的目录，避免同一次选择里
// 重复读取同一个 state.vscdb（也避免把 A 产品的库算到 B 产品的候选里）。
const DECLARED_DESKTOP_DIR_NAMES = Object.freeze(Object.values(DESKTOP_NAMES));

const AUTH_SECRET_KEY = 'secret://{"extensionId":"tencent-cloud.coding-copilot","key":"planning-genie.new.accessToken"}';
const MAX_SECRET_BYTES = 1024 * 1024;
const STATE_DB_SEGMENTS = Object.freeze(['User', 'globalStorage', 'state.vscdb']);
const MAX_SCAN_DIRS = 256;
// 扫描（枚举整个用户数据根）比按已知 App 名定位贵得多：默认 60s 内复用上次结果，
// 既覆盖"新装/改名"又不会让 5s 一次的同步循环反复打开无关 Electron 应用的 sqlite。
const DEFAULT_SCAN_TTL_MS = 60000;

// Chromium safeStorage 的三平台实现（前缀 `v10` 之后的载荷）：
//   darwin: AES-128-CBC，密钥 = PBKDF2(登录钥匙串里的 "<App> Safe Storage" 密码, 'saltysalt', 1003, sha1)
//   linux : AES-128-CBC，密钥 = PBKDF2('peanuts', 'saltysalt', 1, sha1)（未接钥匙环时的回退）
//           前缀 `v11` 表示密钥在 libsecret，本模块不读钥匙环，会明确报告不可用而不是猜
//   win32 : DPAPI（CryptUnprotectData）——整段就是 DPAPI 密文，没有 AES 层
const SAFE_STORAGE = Object.freeze({
  darwin: Object.freeze({ cipher: 'aes', password: '', iterations: 1003, versions: Object.freeze(['v10']) }),
  linux: Object.freeze({ cipher: 'aes', password: 'peanuts', iterations: 1, versions: Object.freeze(['v10']) }),
  win32: Object.freeze({ cipher: 'dpapi', versions: Object.freeze(['v10']) })
});

// `v11`（libsecret 密钥）在 Linux 上是合法但本模块读不了的形式：单独报告，
// 让上层区分"这台机器没有钥匙环"与"这个平台我们根本不支持"。
const KEYRING_VERSION = 'v11';

const DPAPI_UNPROTECT_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName System.Security',
  '$raw = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())',
  '$plain = [System.Security.Cryptography.ProtectedData]::Unprotect('
    + '$raw, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
  '[Console]::Out.Write([Convert]::ToBase64String($plain))'
].join('; ');

const decryptedCredentials = new Map();
const scanCache = new Map();

function readEncryptedCredential(fs, file, DatabaseSync, versions) {
  let db;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    db = new DatabaseSync(file, { readOnly: true });
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ? AND length(value) <= ?')
      .get(AUTH_SECRET_KEY, MAX_SECRET_BYTES);
    const value = row && JSON.parse(String(row.value));
    if (value?.type !== 'Buffer' || !Array.isArray(value.data) || value.data.length > MAX_SECRET_BYTES) return null;
    if (!value.data.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255)) return null;
    const blob = Buffer.from(value.data);
    if (blob.length <= 3) return null;
    const version = blob.subarray(0, 3).toString('latin1');
    if (!versions.includes(version) && version !== KEYRING_VERSION) return null;
    return { blob, version };
  } catch (_) {
    return null;
  } finally {
    try { db?.close(); } catch (_) {}
  }
}

function readKeychainPassword(service, run) {
  const output = run('/usr/bin/security', ['find-generic-password', '-w', '-s', service], {
    encoding: null, timeout: 5000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'ignore']
  });
  const buffer = Buffer.isBuffer(output) ? output : Buffer.from(output || '');
  let end = buffer.length;
  while (end > 0 && (buffer[end - 1] === 10 || buffer[end - 1] === 13)) end -= 1;
  return end ? Buffer.from(buffer.subarray(0, end)) : null;
}

function aesDecrypt(payload, password, iterations) {
  const key = crypto.pbkdf2Sync(password, 'saltysalt', iterations, 16, 'sha1');
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    return Buffer.concat([decipher.update(payload), decipher.final()]);
  } finally {
    key.fill(0);
  }
}

function dpapiUnprotect(payload, run, options) {
  const shell = options.powershellPath || 'powershell.exe';
  const output = run(shell, ['-NoProfile', '-NonInteractive', '-Command', DPAPI_UNPROTECT_SCRIPT], {
    input: payload.toString('base64'), encoding: 'utf8', timeout: 5000,
    maxBuffer: MAX_SECRET_BYTES * 2, stdio: ['pipe', 'pipe', 'ignore']
  });
  const encoded = String(output || '').trim();
  return encoded ? Buffer.from(encoded, 'base64') : null;
}

function parseCredentialPayload(plaintext) {
  const value = JSON.parse(plaintext.toString('utf8'));
  if (!value?.account || !value?.auth) return null;
  return { account: value.account, auth: value.auth, ...(Array.isArray(value.accounts) ? { accounts: value.accounts } : {}) };
}

// 返回值语义：`{ credential }` 成功；`{ reason }` 明确失败原因（上层用于区分
// "这台机器没有该凭据" 与 "有但读不了"）；null 表示这个目录不是家族凭据来源。
function decryptCredential(entry, platform, service, run, options) {
  const spec = SAFE_STORAGE[platform];
  if (!spec) return { reason: 'desktop_credential_unsupported_platform' };
  if (entry.version === KEYRING_VERSION) return { reason: 'desktop_credential_keyring_unavailable' };
  if (!spec.versions.includes(entry.version)) return { reason: 'desktop_credential_unsupported_format' };
  let plaintext = null;
  try {
    if (spec.cipher === 'dpapi') {
      plaintext = dpapiUnprotect(entry.blob.subarray(3), run, options);
    } else {
      const password = spec.password ? Buffer.from(spec.password, 'utf8') : readKeychainPassword(service, run);
      if (password) plaintext = aesDecrypt(entry.blob.subarray(3), password, spec.iterations);
    }
    if (!plaintext) return { reason: 'desktop_credential_unreadable' };
    const credential = parseCredentialPayload(plaintext);
    return credential ? { credential } : { reason: 'desktop_credential_unreadable' };
  } catch (_) {
    return { reason: 'desktop_credential_unreadable' };
  } finally {
    if (plaintext) plaintext.fill(0);
  }
}

/**
 * 枚举"未被任何 Provider 声明认领"的 userData 目录。它们只可能是改名/未知 App 名的
 * 家族客户端（比如从安装包里直接打开、或应用被重命名），归属仍由扩展 ID 特征决定。
 * 结果按根缓存，避免 5s 一次的同步循环反复枚举。
 */
function scannedUserDataDirs(fs, home, platform, options) {
  const pathImpl = resolveFamilyPathImpl(platform, options.path);
  const ttl = Number.isFinite(options.scanCacheTtlMs) ? Math.max(0, options.scanCacheTtlMs) : DEFAULT_SCAN_TTL_MS;
  const now = Date.now();
  const dirs = [];
  for (const root of codebuddyDesktopUserDataRoots(home, { ...options, platform, path: pathImpl })) {
    const cached = scanCache.get(root);
    if (ttl > 0 && cached && now - cached.at < ttl) {
      dirs.push(...cached.dirs);
      continue;
    }
    const found = [];
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { entries = []; }
    for (const entry of entries) {
      if (found.length >= MAX_SCAN_DIRS) break;
      if (!entry.isDirectory() || DECLARED_DESKTOP_DIR_NAMES.includes(entry.name)) continue;
      const dir = pathImpl.join(root, entry.name);
      try { if (!fs.existsSync(pathImpl.join(dir, ...STATE_DB_SEGMENTS))) continue; } catch (_) { continue; }
      found.push(dir);
    }
    scanCache.set(root, { at: now, dirs: found });
    dirs.push(...found);
  }
  return Array.from(new Set(dirs));
}

/**
 * 读凭据时会依次尝试的 state.vscdb 路径（与 readCodebuddyDesktopCredential 同一顺序）。
 * 只做路径解析、不解密，供同步循环用 stat 判断「输入是否变了」。
 */
function listCodebuddyDesktopStateDbPaths(fs, home, provider, options = {}) {
  const platform = resolveFamilyPlatform(options.platform);
  const name = DESKTOP_NAMES[normalizeFamilyProvider(provider)];
  if (!name || !home || !platform) return [];
  const pathImpl = resolveFamilyPathImpl(platform, options.path);
  const dirs = codebuddyDesktopUserDataDirs(home, provider, { ...options, platform, path: pathImpl })
    .concat(scannedUserDataDirs(fs, home, platform, options));
  return dirs.map(dir => pathImpl.join(dir, ...STATE_DB_SEGMENTS));
}

function readCodebuddyDesktopCredential(fs, home, provider, options = {}) {
  const platform = resolveFamilyPlatform(options.platform);
  const name = DESKTOP_NAMES[normalizeFamilyProvider(provider)];
  if (!name || !home || !platform) return null;
  let DatabaseSync;
  try { DatabaseSync = options.DatabaseSync || require('node:sqlite').DatabaseSync; } catch (_) { return null; }
  const run = options.execFileSync || execFileSync;
  const pathImpl = resolveFamilyPathImpl(platform, options.path);
  const versions = SAFE_STORAGE[platform].versions;

  // 有序尝试：契约声明的环境变量 → aih 沙箱投影 → 官方 App 名目录 → 未认领目录扫描。
  // 命中即返回（首个能解出凭据的目录胜出），扫描只在前面全部落空时才发生。
  const attempts = codebuddyDesktopUserDataDirs(home, provider, { ...options, platform, path: pathImpl })
    .map(dir => ({ dir, services: [name] }));
  for (const dir of scannedUserDataDirs(fs, home, platform, options)) {
    attempts.push({ dir, services: [pathImpl.basename(dir), name] });
  }
  for (const attempt of attempts) {
    const file = pathImpl.join(attempt.dir, ...STATE_DB_SEGMENTS);
    const entry = readEncryptedCredential(fs, file, DatabaseSync, versions);
    if (!entry) continue;
    try {
      const fingerprint = crypto.createHash('sha256').update(entry.blob).digest('hex');
      const cached = decryptedCredentials.get(file);
      if (cached?.fingerprint === fingerprint && cached.run === run) return cached.credential;
      // 同一个库可能属于不同 App 名（重命名场景），逐个服务名试；全部失败再试下一个目录。
      for (const service of Array.from(new Set(attempt.services))) {
        const result = decryptCredential(entry, platform, `${service} Safe Storage`, run, options);
        if (!result.credential) continue;
        decryptedCredentials.delete(file);
        decryptedCredentials.set(file, { fingerprint, run, credential: result.credential });
        if (decryptedCredentials.size > 32) decryptedCredentials.delete(decryptedCredentials.keys().next().value);
        return result.credential;
      }
    } finally {
      entry.blob.fill(0);
    }
  }
  return null;
}

module.exports = {
  DECLARED_DESKTOP_DIR_NAMES,
  DESKTOP_NAMES,
  SAFE_STORAGE,
  listCodebuddyDesktopStateDbPaths,
  readCodebuddyDesktopCredential
};
