'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { isAccountRef } = require('../../../account/public-account-ref');
const { readAccountNativeAuth } = require('../../../server/account-credential-store');

const AUTH_COOKIE_NAMES = Object.freeze(['lastActiveOrg', 'sessionKey']);
const COOKIE_COLUMNS = Object.freeze([
  'creation_utc',
  'host_key',
  'top_frame_site_key',
  'name',
  'value',
  'encrypted_value',
  'path',
  'expires_utc',
  'is_secure',
  'is_httponly',
  'last_access_utc',
  'has_expires',
  'is_persistent',
  'priority',
  'samesite',
  'source_scheme',
  'source_port',
  'last_update_utc',
  'source_type',
  'has_cross_site_ancestor'
]);
const CHROMIUM_COOKIE_VERSION = '24';
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_PROFILE_MATCH_FILES = 2500;
const MAX_PROFILE_MATCH_FILE_SIZE = 32 * 1024 * 1024;
const MAX_PROFILE_MATCH_BYTES = 128 * 1024 * 1024;
const SAFE_STORAGE_DESCRIPTORS = Object.freeze({
  chrome: Object.freeze({ service: 'Chrome Safe Storage', account: 'Chrome' }),
  edge: Object.freeze({ service: 'Microsoft Edge Safe Storage', account: 'Microsoft Edge' }),
  claude: Object.freeze({ service: 'Claude Safe Storage', account: 'Claude Key' })
});
const BROWSER_SOURCES = Object.freeze([
  Object.freeze({
    browser: 'chrome',
    rootParts: Object.freeze(['Google', 'Chrome']),
    safeStorage: SAFE_STORAGE_DESCRIPTORS.chrome
  }),
  Object.freeze({
    browser: 'edge',
    rootParts: Object.freeze(['Microsoft Edge']),
    safeStorage: SAFE_STORAGE_DESCRIPTORS.edge
  })
]);

function failure(reason) {
  return { ok: false, status: 'failed', reason, cookieCount: 0 };
}

function createCodedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

function extractClaudeAccountEmail(nativeAuth) {
  const credentials = nativeAuth && nativeAuth.credentials;
  const oauth = credentials && (credentials.claudeAiOauth || credentials.claude_ai_oauth);
  const account = oauth && oauth.account;
  return normalizeEmail(account && (
    account.emailAddress
    || account.email_address
    || account.email
  ));
}

function readJsonFile(fsImpl, filePath) {
  try {
    return JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
  } catch (_error) {
    return null;
  }
}

function isSafeProfileName(profileName, pathImpl) {
  const value = String(profileName || '').trim();
  if (!value || value === '.' || value === '..') return false;
  return pathImpl.basename(value) === value && !value.includes('/') && !value.includes('\\');
}

function setStatementBigInts(statement) {
  if (statement && typeof statement.setReadBigInts === 'function') {
    statement.setReadBigInts(true);
  }
  return statement;
}

function readAuthCookieRows(Database, cookieDbPath) {
  let db = null;
  try {
    db = new Database(cookieDbPath, { readOnly: true });
    const statement = setStatementBigInts(db.prepare(`
      SELECT ${COOKIE_COLUMNS.join(', ')}
      FROM cookies
      WHERE host_key IN ('.claude.ai', 'claude.ai')
        AND name IN ('lastActiveOrg', 'sessionKey')
        AND length(encrypted_value) > 3
      ORDER BY name, last_update_utc DESC
    `));
    const selected = new Map();
    statement.all().forEach((row) => {
      if (!selected.has(row.name)) selected.set(row.name, row);
    });
    return AUTH_COOKIE_NAMES.map((name) => selected.get(name)).filter(Boolean);
  } catch (_error) {
    return [];
  } finally {
    if (db) {
      try { db.close(); } catch (_error) {}
    }
  }
}

function isUnexpiredCookie(row, nowMs) {
  if (!row) return false;
  if (!Number(row.has_expires)) return true;
  try {
    const nowChromium = BigInt(nowMs) * 1000n + 11644473600000000n;
    return BigInt(row.expires_utc) > nowChromium;
  } catch (_error) {
    return false;
  }
}

function hasCurrentAuthCookies(rows, nowMs = Date.now()) {
  if (!Array.isArray(rows) || rows.length !== AUTH_COOKIE_NAMES.length) return false;
  return AUTH_COOKIE_NAMES.every((name) => (
    isUnexpiredCookie(rows.find((row) => row.name === name), nowMs)
  ));
}

function profileStorageContainsEmail(fsImpl, pathImpl, profileDir, accountEmail) {
  const needle = Buffer.from(accountEmail);
  const stack = ['IndexedDB', 'Session Storage', 'Local Storage']
    .map((name) => pathImpl.join(profileDir, name))
    .filter((target) => fsImpl.existsSync(target));
  let scannedFiles = 0;
  let scannedBytes = 0;
  try {
    while (stack.length > 0 && scannedFiles < MAX_PROFILE_MATCH_FILES) {
      const target = stack.pop();
      let entries;
      try {
        entries = fsImpl.readdirSync(target, { withFileTypes: true });
      } catch (_error) {
        continue;
      }
      for (const entry of entries) {
        const entryPath = pathImpl.join(target, entry.name);
        if (entry.isDirectory()) {
          stack.push(entryPath);
          continue;
        }
        if (!entry.isFile() || scannedFiles >= MAX_PROFILE_MATCH_FILES) continue;
        let stat;
        try { stat = fsImpl.statSync(entryPath); } catch (_error) { continue; }
        const fileSize = Number(stat.size) || 0;
        if (fileSize <= 0 || fileSize > MAX_PROFILE_MATCH_FILE_SIZE) continue;
        if (scannedBytes + fileSize > MAX_PROFILE_MATCH_BYTES) return false;
        scannedFiles += 1;
        scannedBytes += fileSize;
        let data = null;
        try {
          data = fsImpl.readFileSync(entryPath);
          if (Buffer.isBuffer(data) && data.includes(needle)) return true;
        } catch (_error) {
          // Browser storage may rotate while it is being scanned.
        } finally {
          if (Buffer.isBuffer(data)) data.fill(0);
        }
      }
    }
    return false;
  } finally {
    needle.fill(0);
  }
}

function findBrowserCookieSource(fsImpl, pathImpl, Database, hostHomeDir, accountEmail) {
  for (const browserSource of BROWSER_SOURCES) {
    const browserRoot = pathImpl.join(
      hostHomeDir,
      'Library',
      'Application Support',
      ...browserSource.rootParts
    );
    const localState = readJsonFile(fsImpl, pathImpl.join(browserRoot, 'Local State'));
    const infoCache = localState && localState.profile && localState.profile.info_cache;
    if (!infoCache || typeof infoCache !== 'object' || Array.isArray(infoCache)) continue;
    const profiles = Object.entries(infoCache)
      .filter(([profileName]) => isSafeProfileName(profileName, pathImpl))
      .sort(([left], [right]) => {
        if (left === 'Default') return -1;
        if (right === 'Default') return 1;
        return left.localeCompare(right);
      });
    for (const [profileName, metadata] of profiles) {
      const profileDir = pathImpl.join(browserRoot, profileName);
      const candidates = [
        pathImpl.join(profileDir, 'Cookies'),
        pathImpl.join(profileDir, 'Network', 'Cookies')
      ];
      for (const cookieDbPath of candidates) {
        if (!fsImpl.existsSync(cookieDbPath)) continue;
        const rows = readAuthCookieRows(Database, cookieDbPath);
        if (!hasCurrentAuthCookies(rows)) {
          wipeCookieRows(rows);
          continue;
        }
        const metadataMatches = normalizeEmail(metadata && metadata.user_name) === accountEmail;
        const storageMatches = metadataMatches
          || profileStorageContainsEmail(fsImpl, pathImpl, profileDir, accountEmail);
        if (storageMatches) {
          return {
            browser: browserSource.browser,
            safeStorage: browserSource.safeStorage,
            profileName,
            profileDir,
            cookieDbPath,
            rows
          };
        }
        wipeCookieRows(rows);
      }
    }
  }
  return null;
}

function readSafeStoragePassword(descriptor, options = {}) {
  const run = options.execFileSync || execFileSync;
  let output = null;
  try {
    output = run('/usr/bin/security', [
      'find-generic-password',
      '-w',
      '-s', descriptor.service,
      '-a', descriptor.account
    ], {
      encoding: null,
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'ignore']
    });
    const buffer = Buffer.isBuffer(output) ? output : Buffer.from(output || '');
    let end = buffer.length;
    while (end > 0 && (buffer[end - 1] === 0x0a || buffer[end - 1] === 0x0d)) end -= 1;
    const password = Buffer.from(buffer.subarray(0, end));
    buffer.fill(0);
    if (password.length === 0) {
      password.fill(0);
      return null;
    }
    return password;
  } catch (_error) {
    if (Buffer.isBuffer(output)) output.fill(0);
    return null;
  }
}

function deriveChromiumKey(password) {
  return crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
}

function decryptCookieValue(row, key) {
  const encrypted = Buffer.from(row.encrypted_value || []);
  if (encrypted.length <= 3 || !encrypted.subarray(0, 3).equals(Buffer.from('v10'))) {
    encrypted.fill(0);
    throw createCodedError('unsupported_cookie_encryption');
  }
  let plaintext = null;
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    plaintext = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
    const hostHash = crypto.createHash('sha256').update(String(row.host_key || '')).digest();
    const validHostBinding = plaintext.length > hostHash.length
      && crypto.timingSafeEqual(plaintext.subarray(0, hostHash.length), hostHash);
    hostHash.fill(0);
    if (!validHostBinding) throw createCodedError('cookie_host_binding_invalid');
    return Buffer.from(plaintext.subarray(32));
  } finally {
    encrypted.fill(0);
    if (plaintext) plaintext.fill(0);
  }
}

function isUuidBuffer(value) {
  if (!Buffer.isBuffer(value) || value.length !== 36) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (index === 8 || index === 13 || index === 18 || index === 23) {
      if (value[index] !== 0x2d) return false;
      continue;
    }
    const byte = value[index];
    const isHex = (byte >= 0x30 && byte <= 0x39)
      || (byte >= 0x61 && byte <= 0x66)
      || (byte >= 0x41 && byte <= 0x46);
    if (!isHex) return false;
  }
  return true;
}

function validateCookieValue(name, value) {
  if (name === 'sessionKey') {
    return value.length > 10 && value.subarray(0, 10).equals(Buffer.from('sk-ant-sid'));
  }
  return name === 'lastActiveOrg' && isUuidBuffer(value);
}

function encryptCookieValue(hostKey, value, key) {
  const hostHash = crypto.createHash('sha256').update(String(hostKey || '')).digest();
  const plaintext = Buffer.concat([hostHash, value]);
  try {
    const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    const payload = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([Buffer.from('v10'), payload]);
  } finally {
    hostHash.fill(0);
    plaintext.fill(0);
  }
}

function transformCookieRows(rows, sourceKey, targetKey) {
  return rows.map((row) => {
    const value = decryptCookieValue(row, sourceKey);
    try {
      if (!validateCookieValue(row.name, value)) {
        throw createCodedError('browser_session_shape_invalid');
      }
      return {
        ...row,
        value: '',
        encrypted_value: encryptCookieValue(row.host_key, value, targetKey)
      };
    } finally {
      value.fill(0);
    }
  });
}

function readCookieSchema(Database, templatePath) {
  let db = null;
  try {
    db = new Database(templatePath, { readOnly: true });
    const columns = db.prepare('PRAGMA table_info(cookies)').all().map((row) => row.name);
    if (columns.length !== COOKIE_COLUMNS.length
      || columns.some((column, index) => column !== COOKIE_COLUMNS[index])) {
      throw createCodedError('cookie_schema_invalid');
    }
    const version = db.prepare("SELECT value FROM meta WHERE key = 'version'").get();
    const compatible = db.prepare("SELECT value FROM meta WHERE key = 'last_compatible_version'").get();
    if (String(version && version.value || '') !== CHROMIUM_COOKIE_VERSION
      || String(compatible && compatible.value || '') !== CHROMIUM_COOKIE_VERSION) {
      throw createCodedError('cookie_schema_version_unsupported');
    }
    const records = db.prepare(`
      SELECT type, name, sql
      FROM sqlite_schema
      WHERE sql IS NOT NULL
        AND (name IN ('meta', 'cookies') OR tbl_name = 'cookies')
      ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name
    `).all();
    const requiredNames = new Set(records.map((record) => record.name));
    if (!requiredNames.has('meta') || !requiredNames.has('cookies')) {
      throw createCodedError('cookie_schema_invalid');
    }
    return {
      statements: records.map((record) => String(record.sql || '').trim()).filter(Boolean),
      meta: [
        ['version', CHROMIUM_COOKIE_VERSION],
        ['last_compatible_version', CHROMIUM_COOKIE_VERSION]
      ]
    };
  } finally {
    if (db) db.close();
  }
}

function insertCookieRows(db, rows) {
  const placeholders = COOKIE_COLUMNS.map(() => '?').join(', ');
  const statement = db.prepare(`
    INSERT INTO cookies (${COOKIE_COLUMNS.join(', ')})
    VALUES (${placeholders})
  `);
  rows.forEach((row) => {
    statement.run(...COOKIE_COLUMNS.map((column) => row[column]));
  });
}

function runTransaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    operation();
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_error) {}
    throw error;
  }
}

function writeNewCookieDatabase(options) {
  const {
    Database,
    fsImpl,
    targetPath,
    templatePath,
    rows,
    processObj,
    pathImpl
  } = options;
  const schema = readCookieSchema(Database, templatePath);
  const temporaryPath = pathImpl.join(
    pathImpl.dirname(targetPath),
    `.Cookies.${Number(processObj && processObj.pid) || 0}.${Date.now()}.tmp`
  );
  let db = null;
  try {
    db = new Database(temporaryPath);
    runTransaction(db, () => {
      schema.statements.forEach((statement) => db.exec(statement));
      const insertMeta = db.prepare('INSERT INTO meta(key, value) VALUES (?, ?)');
      schema.meta.forEach(([key, value]) => insertMeta.run(key, value));
      insertCookieRows(db, rows);
    });
    db.close();
    db = null;
    fsImpl.chmodSync(temporaryPath, PRIVATE_FILE_MODE);
    fsImpl.renameSync(temporaryPath, targetPath);
  } finally {
    if (db) {
      try { db.close(); } catch (_error) {}
    }
    if (fsImpl.existsSync(temporaryPath)) {
      try { fsImpl.rmSync(temporaryPath, { force: true }); } catch (_error) {}
    }
  }
}

function updateCookieDatabase(Database, fsImpl, targetPath, rows) {
  let db = null;
  try {
    readCookieSchema(Database, targetPath);
    db = new Database(targetPath);
    runTransaction(db, () => {
      db.exec(`
        DELETE FROM cookies
        WHERE host_key IN ('.claude.ai', 'claude.ai')
          AND name IN ('lastActiveOrg', 'sessionKey')
      `);
      insertCookieRows(db, rows);
    });
  } finally {
    if (db) db.close();
  }
  fsImpl.chmodSync(targetPath, PRIVATE_FILE_MODE);
}

function wipeCookieRows(rows) {
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const encryptedValue = row && row.encrypted_value;
    if (Buffer.isBuffer(encryptedValue) || encryptedValue instanceof Uint8Array) {
      encryptedValue.fill(0);
    }
  });
}

function syncClaudeDesktopWebSession(options = {}) {
  const fsImpl = options.fs || fs;
  const pathImpl = options.path || path;
  const processObj = options.processObj || process;
  const Database = options.DatabaseSync || DatabaseSync;
  const accountRef = String(options.accountRef || '').trim();
  const profileDir = String(options.profileDir || '').trim();
  const hostHomeDir = String(options.hostHomeDir || '').trim();
  const validProfileScope = isAccountRef(accountRef)
    && profileDir
    && pathImpl.basename(profileDir) === accountRef
    && pathImpl.basename(pathImpl.dirname(profileDir)) === 'claude';
  if (!validProfileScope) return failure('invalid_account_scope');

  try {
    fsImpl.mkdirSync(profileDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    fsImpl.chmodSync(profileDir, PRIVATE_DIRECTORY_MODE);
  } catch (_error) {
    return failure('profile_directory_unavailable');
  }

  const targetPath = pathImpl.join(profileDir, 'Cookies');
  if (fsImpl.existsSync(targetPath)) {
    const existingRows = readAuthCookieRows(Database, targetPath);
    const existingSessionCurrent = hasCurrentAuthCookies(existingRows);
    wipeCookieRows(existingRows);
    if (existingSessionCurrent) {
      try { fsImpl.chmodSync(targetPath, PRIVATE_FILE_MODE); } catch (_error) {}
      return { ok: true, status: 'existing', cookieCount: AUTH_COOKIE_NAMES.length };
    }
  }

  if (processObj.platform !== 'darwin') {
    return {
      ok: true,
      status: 'login_required',
      reason: 'browser_session_migration_unsupported',
      cookieCount: 0
    };
  }

  const readNativeAuth = options.readAccountNativeAuth || readAccountNativeAuth;
  const nativeAuth = readNativeAuth(fsImpl, options.aiHomeDir, accountRef);
  const accountEmail = extractClaudeAccountEmail(nativeAuth);
  if (!accountEmail) return failure('account_email_unavailable');

  const source = findBrowserCookieSource(
    fsImpl,
    pathImpl,
    Database,
    hostHomeDir,
    accountEmail
  );
  if (!source) {
    return {
      ok: true,
      status: 'login_required',
      reason: 'matching_browser_session_not_found',
      cookieCount: 0
    };
  }

  const passwordReader = options.readSafeStoragePassword || ((descriptor) => (
    readSafeStoragePassword(descriptor, { execFileSync: options.execFileSync })
  ));
  let sourcePassword = null;
  let claudePassword = null;
  let sourceKey = null;
  let targetKey = null;
  let transformedRows = [];
  try {
    sourcePassword = passwordReader(source.safeStorage);
    if (!Buffer.isBuffer(sourcePassword) || sourcePassword.length === 0) {
      throw createCodedError('browser_safe_storage_unavailable');
    }
    claudePassword = passwordReader(SAFE_STORAGE_DESCRIPTORS.claude);
    if (!Buffer.isBuffer(claudePassword) || claudePassword.length === 0) {
      throw createCodedError('claude_safe_storage_unavailable');
    }
    sourceKey = deriveChromiumKey(sourcePassword);
    targetKey = deriveChromiumKey(claudePassword);
    transformedRows = transformCookieRows(source.rows, sourceKey, targetKey);

    const templatePath = pathImpl.join(
      hostHomeDir,
      'Library',
      'Application Support',
      'Claude',
      'Cookies'
    );
    if (!fsImpl.existsSync(templatePath)) throw createCodedError('claude_cookie_template_missing');
    if (fsImpl.existsSync(targetPath)) {
      updateCookieDatabase(Database, fsImpl, targetPath, transformedRows);
    } else {
      writeNewCookieDatabase({
        Database,
        fsImpl,
        targetPath,
        templatePath,
        rows: transformedRows,
        processObj,
        pathImpl
      });
    }
    return {
      ok: true,
      status: 'migrated',
      sourceBrowser: source.browser,
      sourceProfile: source.profileName,
      cookieCount: AUTH_COOKIE_NAMES.length
    };
  } catch (error) {
    return failure(String(error && error.code || 'desktop_session_sync_failed'));
  } finally {
    wipeCookieRows(source.rows);
    wipeCookieRows(transformedRows);
    if (sourcePassword) sourcePassword.fill(0);
    if (claudePassword) claudePassword.fill(0);
    if (sourceKey) sourceKey.fill(0);
    if (targetKey) targetKey.fill(0);
  }
}

module.exports = {
  extractClaudeAccountEmail,
  syncClaudeDesktopWebSession
};
