'use strict';

// kimi 桌面版 session 离线种植器。
// 桌面 App 明确拒绝一切调试开关（--remote-debugging-port / --remote-debugging-pipe
// 启动即 exit 1，stderr: "[kimi] refusing to start with debug switch present"），
// CDP 注入不可行。实测登录态由主进程 token 仓决定：
//   <userDataDir>/bridge-store/token-store.json
//   { "encryption": "safeStorage.v1", "data": "<base64>" }
// Windows data 是 Chromium v10 AES-256-GCM，密钥来自 profile 的 Local State
// 并由 DPAPI(CurrentUser) 保护。macOS 后台 Server 无法无交互读取 Login
// Keychain；Kimi 3.2.0 自身兼容旧版明文 { origin, tokens }，启动后会立刻用
// Electron safeStorage 迁移为上述密文格式，因此 macOS 只写 0600 的一次性
// bootstrap 文件，把系统密钥环访问留在 Kimi 自己的签名进程内完成。
// 流程：首次 webUI 扫码拿到 web session → 启动前 seed 进隔离 profile →
// App 自行用 refresh_token 续期并轮换 → 下次启动先 adopt 回读 profile 里
// 轮换后的新 token 再 seed，托管链随 App 自愈（90 天 refresh TTL）。

const nodeCrypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const TOKEN_STORE_RELATIVE = ['bridge-store', 'token-store.json'];
const REGION_STATE_RELATIVE = ['bridge-store', 'region.json'];
const LOCAL_STATE_FILE = 'Local State';
const TOKEN_ORIGIN = 'https://www.kimi.com';
const ENCRYPTION_TAG = 'safeStorage.v1';
const V10_PREFIX = Buffer.from('v10', 'latin1');
const DPAPI_PREFIX = 'DPAPI';
// safeStorage 加密空 token map 后仍会产生非空 data（macOS 实测约 50 bytes）。
// 中国区 access token 本身是完整 JWT，连同 refresh token 的密文远大于该值；
// 用结构下限区分“有密文文件”和“有可用登录凭据”，无需后台读取 Keychain。
const MIN_ENCRYPTED_TOKEN_STORE_BYTES = 128;

function dpapiPsScript(direction) {
  // direction=protect: env AIH_DPAPI_PLAIN(base64) -> stdout base64 blob
  // direction=unprotect: env AIH_DPAPI_BLOB(base64, 可带 DPAPI 前缀) -> stdout base64 plain
  const body = direction === 'protect'
    ? '$plain=[Convert]::FromBase64String($env:AIH_DPAPI_PLAIN);' +
      '$blob=[System.Security.Cryptography.ProtectedData]::Protect($plain,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);'
    : '$blob=[Convert]::FromBase64String($env:AIH_DPAPI_BLOB);' +
      `if ($blob.Length -gt 5 -and [Text.Encoding]::ASCII.GetString($blob[0..4]) -eq '${DPAPI_PREFIX}') { $blob = $blob[5..($blob.Length-1)] };` +
      '$plain=[System.Security.Cryptography.ProtectedData]::Unprotect($blob,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);';
  return `Add-Type -AssemblyName System.Security;${body}[Console]::Out.Write([Convert]::ToBase64String(${direction === 'protect' ? '$blob' : '$plain'}))`;
}

function runPowerShell(script, envExtra, deps = {}) {
  const execFileSyncImpl = deps.execFileSync || execFileSync;
  const out = execFileSyncImpl('powershell', ['-NoProfile', '-Command', script], {
    env: { ...(deps.env || process.env), ...envExtra },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000
  });
  return String(out || '').trim();
}

// Windows 上 Electron safeStorage = Chromium OSCrypt：Local State 的 encrypted_key
// 经 DPAPI(CurrentUser) 保护。仅 win32 支持；其他平台 safeStorage 走系统密钥环，
// 格式不同，直接跳过（seed 返回 unsupported_platform）。
function dpapiProtectBase64(plainBase64, deps = {}) {
  return runPowerShell(dpapiPsScript('protect'), { AIH_DPAPI_PLAIN: plainBase64 }, deps);
}

function dpapiUnprotectBase64(blobBase64, deps = {}) {
  return runPowerShell(dpapiPsScript('unprotect'), { AIH_DPAPI_BLOB: blobBase64 }, deps);
}

function encryptV10(aesKey, plaintext, cryptoImpl = nodeCrypto) {
  const nonce = cryptoImpl.randomBytes(12);
  const cipher = cryptoImpl.createCipheriv('aes-256-gcm', aesKey, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.from(String(plaintext), 'utf8')), cipher.final()]);
  return Buffer.concat([V10_PREFIX, nonce, ct, cipher.getAuthTag()]);
}

function decryptV10(aesKey, raw, cryptoImpl = nodeCrypto) {
  if (!Buffer.isBuffer(raw) || raw.length < 3 + 12 + 16) return null;
  if (!raw.slice(0, 3).equals(V10_PREFIX)) return null;
  try {
    const decipher = cryptoImpl.createDecipheriv('aes-256-gcm', aesKey, raw.slice(3, 15));
    decipher.setAuthTag(raw.slice(raw.length - 16));
    return Buffer.concat([decipher.update(raw.slice(15, raw.length - 16)), decipher.final()]).toString('utf8');
  } catch (_error) {
    return null;
  }
}

// 读取 profile 的 AES key；Local State 缺失时生成新 key 并预写（Chromium 接受
// 预置的 os_crypt.encrypted_key，缺失字段运行时补齐）。
function ensureProfileAesKey(fsImpl, pathImpl, userDataDir, deps) {
  const localStatePath = pathImpl.join(userDataDir, LOCAL_STATE_FILE);
  let localState = {};
  try {
    localState = JSON.parse(String(fsImpl.readFileSync(localStatePath, 'utf8')));
  } catch (_error) {}
  const existing = localState && localState.os_crypt && localState.os_crypt.encrypted_key;
  if (existing) {
    const key = dpapiUnprotectBase64(String(existing), deps);
    const buf = Buffer.from(key, 'base64');
    if (buf.length === 32) return buf;
    return null;
  }
  const cryptoImpl = deps.crypto || nodeCrypto;
  const key = cryptoImpl.randomBytes(32);
  const protectedKey = dpapiProtectBase64(key.toString('base64'), deps);
  if (!protectedKey) return null;
  // Chromium 格式：encrypted_key = base64('DPAPI' + 二进制 blob)
  const wrapped = Buffer.concat([
    Buffer.from(DPAPI_PREFIX, 'latin1'),
    Buffer.from(protectedKey, 'base64')
  ]).toString('base64');
  localState.os_crypt = {
    ...(localState.os_crypt && typeof localState.os_crypt === 'object' ? localState.os_crypt : {}),
    encrypted_key: wrapped
  };
  fsImpl.mkdirSync(userDataDir, { recursive: true });
  fsImpl.writeFileSync(localStatePath, JSON.stringify(localState), 'utf8');
  return key;
}

function buildTokenStorePayload({ accessToken, refreshToken, userId }) {
  return JSON.stringify({
    origin: TOKEN_ORIGIN,
    tokens: {
      refresh_token: String(refreshToken || ''),
      access_token: String(accessToken || ''),
      msh_user_id: String(userId || '')
    }
  });
}

function parseTokenStorePlaintext(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || ''));
  } catch (_error) {
    return null;
  }
  const tokens = parsed && parsed.tokens;
  if (!tokens || typeof tokens !== 'object') return null;
  const refreshToken = String(tokens.refresh_token || '').trim();
  const accessToken = String(tokens.access_token || '').trim();
  if (!refreshToken && !accessToken) return null;
  return {
    accessToken,
    refreshToken,
    userId: String(tokens.msh_user_id || '').trim()
  };
}

function writePrivateTokenStore(fsImpl, pathImpl, userDataDir, value) {
  const storeDir = pathImpl.join(userDataDir, TOKEN_STORE_RELATIVE[0]);
  const storePath = pathImpl.join(storeDir, TOKEN_STORE_RELATIVE[1]);
  fsImpl.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  fsImpl.writeFileSync(storePath, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
  if (typeof fsImpl.chmodSync === 'function') fsImpl.chmodSync(storePath, 0o600);
}

// Kimi Desktop 自己维护的实际生效区域。只接受官方当前写入的两个稳定值，
// 不把 manual/geoip 推断当成已经生效的账号区域。
function readKimiDesktopRegion(userDataDir, deps = {}) {
  const fsImpl = deps.fs || require('node:fs');
  const pathImpl = deps.path || require('node:path');
  const dir = String(userDataDir || '').trim();
  if (!dir) return '';
  try {
    const regionPath = pathImpl.join(dir, REGION_STATE_RELATIVE[0], REGION_STATE_RELATIVE[1]);
    const region = String(JSON.parse(String(fsImpl.readFileSync(regionPath, 'utf8'))).lastEffective || '')
      .trim()
      .toLowerCase();
    return region === 'china' || region === 'overseas' ? region : '';
  } catch (_error) {
    return '';
  }
}

// 当前托管扫码固定走 auth.kimi.com / www.kimi.com，得到的是中国区 session。
// Kimi 会优先沿用 profile 里的 region.json；若该 profile 曾以 overseas 启动，
// 中国区 token 会被发往 www.kimi.ai 并以 401 清空。seed 时重置为自动中国区，
// 不保留冲突的 manual 覆盖，后续 App 可根据已登录账号资料继续维护区域。
function writeManagedRegionState(fsImpl, pathImpl, userDataDir) {
  const storeDir = pathImpl.join(userDataDir, REGION_STATE_RELATIVE[0]);
  const regionPath = pathImpl.join(storeDir, REGION_STATE_RELATIVE[1]);
  fsImpl.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  fsImpl.writeFileSync(regionPath, JSON.stringify({ lastEffective: 'china' }), {
    encoding: 'utf8',
    mode: 0o600
  });
  if (typeof fsImpl.chmodSync === 'function') fsImpl.chmodSync(regionPath, 0o600);
}

// seed：启动前把托管 session 写进隔离 profile 的 token 仓。
// 返回 { seeded, reason? }；函数本身不抛错，是否阻断启动由上层流程决定。
function seedKimiDesktopTokenStore(options = {}, deps = {}) {
  const fsImpl = deps.fs || require('node:fs');
  const pathImpl = deps.path || require('node:path');
  const platform = deps.platform || process.platform;
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const userDataDir = String(options.userDataDir || '').trim();
  const accessToken = String(options.accessToken || '').trim();
  const refreshToken = String(options.refreshToken || '').trim();
  if (!userDataDir || !accessToken || !refreshToken) return { seeded: false, reason: 'missing_params' };
  try {
    const payload = buildTokenStorePayload(options);
    if (platform === 'win32') {
      const aesKey = ensureProfileAesKey(fsImpl, pathImpl, userDataDir, deps);
      if (!aesKey) return { seeded: false, reason: 'profile_key_unavailable' };
      const encrypted = encryptV10(aesKey, payload, deps.crypto || nodeCrypto);
      writePrivateTokenStore(fsImpl, pathImpl, userDataDir, {
        encryption: ENCRYPTION_TAG,
        data: encrypted.toString('base64')
      });
    } else if (platform === 'darwin') {
      writePrivateTokenStore(fsImpl, pathImpl, userDataDir, JSON.parse(payload));
    } else {
      return { seeded: false, reason: 'unsupported_platform' };
    }
    writeManagedRegionState(fsImpl, pathImpl, userDataDir);
    return { seeded: true };
  } catch (error) {
    log(`kimi desktop seed failed: ${String(error && error.message || error).slice(0, 120)}`);
    return { seeded: false, reason: 'seed_failed' };
  }
}

// adopt：App 运行后会用 refresh_token 续期并轮换，profile 里的 token 仓比
// 托管副本新。下次启动先回读 profile 仓，把轮换后的 token 采纳回托管存储。
// 返回 null（无可用 profile 仓）或 { accessToken, refreshToken, userId }。
function adoptKimiDesktopTokensFromProfile(userDataDir, deps = {}) {
  const fsImpl = deps.fs || require('node:fs');
  const pathImpl = deps.path || require('node:path');
  const platform = deps.platform || process.platform;
  if (platform !== 'win32' && platform !== 'darwin') return null;
  const dir = String(userDataDir || '').trim();
  if (!dir) return null;
  try {
    const storePath = pathImpl.join(dir, TOKEN_STORE_RELATIVE[0], TOKEN_STORE_RELATIVE[1]);
    const store = JSON.parse(String(fsImpl.readFileSync(storePath, 'utf8')));
    if (!store || typeof store !== 'object') return null;
    if (store.encryption !== ENCRYPTION_TAG) {
      return parseTokenStorePlaintext(JSON.stringify(store));
    }
    if (!store.data || platform !== 'win32') return null;
    const aesKey = ensureProfileAesKey(fsImpl, pathImpl, dir, deps);
    if (!aesKey) return null;
    const plain = decryptV10(
      aesKey,
      Buffer.from(String(store.data), 'base64'),
      deps.crypto || nodeCrypto
    );
    return parseTokenStorePlaintext(plain);
  } catch (_error) {
    return null;
  }
}

function hasKimiDesktopTokenStore(userDataDir, deps = {}) {
  const fsImpl = deps.fs || require('node:fs');
  const pathImpl = deps.path || require('node:path');
  const dir = String(userDataDir || '').trim();
  if (!dir) return false;
  try {
    const store = JSON.parse(String(fsImpl.readFileSync(pathImpl.join(
      dir,
      TOKEN_STORE_RELATIVE[0],
      TOKEN_STORE_RELATIVE[1]
    ), 'utf8')));
    if (store && store.encryption === ENCRYPTION_TAG) {
      if (typeof store.data !== 'string' || !store.data) return false;
      try {
        return Buffer.from(store.data, 'base64').length >= MIN_ENCRYPTED_TOKEN_STORE_BYTES;
      } catch (_error) {
        return false;
      }
    }
    return Boolean(parseTokenStorePlaintext(JSON.stringify(store)));
  } catch (_error) {
    return false;
  }
}

module.exports = {
  seedKimiDesktopTokenStore,
  adoptKimiDesktopTokensFromProfile,
  hasKimiDesktopTokenStore,
  readKimiDesktopRegion,
  buildTokenStorePayload,
  parseTokenStorePlaintext,
  encryptV10,
  decryptV10,
  __private: {
    dpapiProtectBase64,
    dpapiUnprotectBase64,
    ensureProfileAesKey,
    writePrivateTokenStore,
    writeManagedRegionState
  }
};
