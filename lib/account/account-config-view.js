'use strict';

// 账号级配置文件查看（只读）。
//
// 一个账号的“配置”分散在两处：
//   1. app-state.db 的 account_credentials（env_json + native_auth_json）——账号真相；
//   2. 运行时投影目录 run/auth-projections/<provider>/<accountRef>/ 下由 CLI 读写的原生文件。
// 这里把两处统一成若干只读“文件”交给 WebUI 展示。候选路径全部由服务端声明，
// 用户无法传入任意路径；默认脱敏，raw 模式才返回原值。
//
// Kiro 的 nativeAuth.database 是一整份 base64 的 kiro-cli SQLite，这里额外解码成
// auth_kv / state 两张表的 JSON 视图，不然用户只能看到一大段 base64。

const nodePath = require('node:path');
const nodeOs = require('node:os');
const { readAccountCredentialRecord } = require('../server/account-credential-store');
const { collectCredentialRelativePaths } = require('./credential-layout');
const { getProviderCLIConfig } = require('../provider-catalog');
const { redactConfigContent } = require('../cli/services/toolkit/provider-config-manager');

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SQLITE_BYTES = 32 * 1024 * 1024;
const MAX_SQLITE_ROWS = 500;
const SQLITE_EXTENSIONS = new Set(['.sqlite', '.sqlite3', '.db']);
const TEXT_FORMAT_BY_EXTENSION = Object.freeze({
  '.json': 'json',
  '.jsonc': 'jsonc',
  '.toml': 'toml',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.ini': 'ini',
  '.conf': 'ini'
});

// 各 provider 在投影目录里额外值得展示的原生文件（相对投影根）。
// 通用候选来自 credential-layout 与合同里的 cli.configFile，这里只补它们覆盖不到的。
const EXTRA_PROJECTION_FILES = Object.freeze({
  kiro: ['.kiro/settings/cli.json', '.aih-kiro-auth-binding', 'data.sqlite3']
});

class AccountConfigViewError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

// SQLite 里很多值本身是 JSON 字符串；展开后脱敏才能按键名命中 token 等字段。
function parseMaybeJson(value) {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text || !/^[[{"]/.test(text)) return value;
  try {
    return JSON.parse(text);
  } catch (_error) {
    return value;
  }
}

function sqliteValueToJson(value) {
  if (value instanceof Uint8Array) {
    const text = Buffer.from(value).toString('utf8');
    return parseMaybeJson(text);
  }
  return parseMaybeJson(value);
}

/**
 * 把一份 SQLite 文件里所有 key/value 形态的表导出为 { table: { key: value } }，
 * 其它表只给行数。只读打开，不修改源文件。
 */
function dumpKeyValueSqlite(databasePath) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
      .map((row) => String(row.name || ''))
      .filter((name) => name && !name.startsWith('sqlite_'));
    const out = {};
    const quote = (name) => `"${name.replace(/"/g, '""')}"`;
    for (const table of tables) {
      const columns = db.prepare(`PRAGMA table_info(${quote(table)})`).all().map((col) => String(col.name));
      const count = Number(db.prepare(`SELECT COUNT(*) AS c FROM ${quote(table)}`).get().c) || 0;
      if (columns.includes('key') && columns.includes('value')) {
        const entries = {};
        const rows = db.prepare(`SELECT key, value FROM ${quote(table)} LIMIT ${MAX_SQLITE_ROWS}`).all();
        for (const row of rows) entries[String(row.key)] = sqliteValueToJson(row.value);
        out[table] = entries;
      } else {
        out[table] = { '<rows>': count };
      }
    }
    return out;
  } finally {
    try { db.close(); } catch (_error) {}
  }
}

function decodeSqliteBase64(base64, options = {}) {
  const fs = options.fs;
  const os = options.os || nodeOs;
  const buffer = Buffer.from(String(base64 || ''), 'base64');
  if (!buffer.length) return null;
  if (buffer.length > MAX_SQLITE_BYTES) return { '<error>': `数据库过大（${buffer.length} 字节），未解码` };
  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'aih-account-config-'));
  try {
    const file = nodePath.join(dir, 'view.sqlite3');
    fs.writeFileSync(file, buffer, { mode: 0o600 });
    return dumpKeyValueSqlite(file);
  } catch (error) {
    return { '<error>': `数据库解码失败：${String(error && error.message || error)}` };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_error) {}
  }
}

function renderJson(value, mode) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (mode === 'raw') return { content, redactedFields: [] };
  const redacted = redactConfigContent(content, 'json');
  return { content: redacted.content, redactedFields: redacted.fields };
}

function renderText(content, format, mode) {
  if (mode === 'raw') return { content, redactedFields: [] };
  const redacted = redactConfigContent(content, format);
  return { content: redacted.content, redactedFields: redacted.fields };
}

function credentialStoreFiles(provider, record, mode, options) {
  if (!record) return [];
  const files = [];
  const nativeAuth = isPlainObject(record.nativeAuth) ? { ...record.nativeAuth } : {};
  let decodedDatabase = null;
  if (typeof nativeAuth.database === 'string' && nativeAuth.database) {
    const bytes = Buffer.byteLength(nativeAuth.database, 'base64');
    decodedDatabase = decodeSqliteBase64(nativeAuth.database, options);
    nativeAuth.database = `<sqlite ${bytes} 字节，解码内容见「凭据数据库」>`;
  }
  const storeView = {
    env: record.env || {},
    nativeAuth,
    envUpdatedAt: record.envUpdatedAt ? new Date(record.envUpdatedAt).toISOString() : null,
    nativeAuthUpdatedAt: record.nativeAuthUpdatedAt ? new Date(record.nativeAuthUpdatedAt).toISOString() : null
  };
  files.push({
    id: 'store:credentials',
    label: '账号凭据记录',
    source: 'store',
    location: 'app-state.db · account_credentials',
    format: 'json',
    updatedAt: Number(record.updatedAt) || 0,
    ...renderJson(storeView, mode)
  });
  if (decodedDatabase) {
    files.push({
      id: 'store:database',
      label: provider === 'kiro' ? '凭据数据库（kiro-cli data.sqlite3）' : '凭据数据库',
      source: 'store',
      location: 'account_credentials.native_auth_json.database',
      format: 'json',
      updatedAt: Number(record.nativeAuthUpdatedAt) || 0,
      ...renderJson(decodedDatabase, mode)
    });
  }
  return files;
}

function projectionCandidates(provider) {
  const candidates = [...collectCredentialRelativePaths(provider)];
  const cli = getProviderCLIConfig(provider) || {};
  if (cli.configFile) {
    // 合同里 globalDir 以 `.config/...` 开头时，投影目录同样保留这段相对路径。
    const parts = [cli.globalDir || `.${provider}`, cli.configSubDir, cli.configFile].filter(Boolean);
    candidates.push(parts.join('/'));
  }
  candidates.push(...(EXTRA_PROJECTION_FILES[provider] || []));
  return Array.from(new Set(candidates.map((item) => String(item).replace(/\\/g, '/').replace(/^\/+/, ''))))
    .filter((item) => item && !item.split('/').includes('..'));
}

function projectionFiles(provider, runtimeDir, mode, options) {
  const fs = options.fs;
  if (!runtimeDir || !fs.existsSync(runtimeDir)) return [];
  const root = nodePath.resolve(runtimeDir);
  const files = [];
  for (const relativePath of projectionCandidates(provider)) {
    const absolute = nodePath.resolve(root, ...relativePath.split('/'));
    if (!absolute.startsWith(`${root}${nodePath.sep}`)) continue;
    let stat;
    try {
      stat = fs.statSync(absolute);
    } catch (_error) {
      continue;
    }
    if (!stat.isFile()) continue;
    const extension = nodePath.extname(relativePath).toLowerCase();
    const base = {
      id: `projection:${relativePath}`,
      label: relativePath,
      source: 'projection',
      location: `运行时投影 · ${relativePath}`,
      updatedAt: Number(stat.mtimeMs) || 0,
      size: Number(stat.size) || 0
    };
    if (SQLITE_EXTENSIONS.has(extension)) {
      if (stat.size > MAX_SQLITE_BYTES) continue;
      let dumped;
      try {
        dumped = dumpKeyValueSqlite(absolute);
      } catch (error) {
        dumped = { '<error>': `数据库读取失败：${String(error && error.message || error)}` };
      }
      files.push({ ...base, format: 'json', ...renderJson(dumped, mode) });
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) {
      files.push({ ...base, format: 'text', content: `<文件过大（${stat.size} 字节），未读取>\n`, redactedFields: [] });
      continue;
    }
    let content;
    try {
      content = fs.readFileSync(absolute, 'utf8');
    } catch (_error) {
      continue;
    }
    const format = TEXT_FORMAT_BY_EXTENSION[extension]
      || (/^\s*[[{]/.test(content) ? 'json' : 'text');
    files.push({ ...base, format, ...renderText(content, format, mode) });
  }
  return files;
}

/**
 * 读取账号的全部可查看配置。
 * @returns {{ ok: true, provider, accountRef, mode, runtimeDirExists, files: Array }}
 */
function readAccountConfigFiles(provider, accountRef, options = {}) {
  const fs = options.fs || require('node:fs');
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  const mode = String(options.mode || 'redacted').toLowerCase() === 'raw' ? 'raw' : 'redacted';
  const context = { ...options, fs };
  const record = readAccountCredentialRecord(fs, options.aiHomeDir, accountRef);
  if (record && record.provider && record.provider !== normalizedProvider) {
    throw new AccountConfigViewError('account_provider_mismatch', `账号 ${accountRef} 不属于 ${normalizedProvider}`);
  }
  const runtimeDir = typeof options.getProfileDir === 'function'
    ? String(options.getProfileDir(normalizedProvider, accountRef) || '').trim()
    : '';
  // claude 等 provider 的 getProfileDir 指向宿主 home（网关模式），那不是账号自己的目录，不展示。
  const hostHome = String(options.hostHomeDir || '').trim();
  const accountOwnedDir = runtimeDir && (!hostHome || nodePath.resolve(runtimeDir) !== nodePath.resolve(hostHome))
    ? runtimeDir
    : '';
  const files = [
    ...credentialStoreFiles(normalizedProvider, record, mode, context),
    ...projectionFiles(normalizedProvider, accountOwnedDir, mode, context)
  ];
  return {
    ok: true,
    provider: normalizedProvider,
    accountRef,
    mode,
    runtimeDirExists: Boolean(accountOwnedDir && fs.existsSync(accountOwnedDir)),
    files
  };
}

module.exports = {
  AccountConfigViewError,
  dumpKeyValueSqlite,
  projectionCandidates,
  readAccountConfigFiles
};
