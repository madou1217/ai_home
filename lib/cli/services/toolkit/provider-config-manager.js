'use strict';

// Provider 配置文件工作台的服务层。
//
// 职责边界：
// - 路径与文件声明来自 lib/providers/config-files.js（声明式注册表，不认 provider 名）；
// - 字段解释来自 lib/providers/config-schemas（离线官方快照）；
// - 版本快照来自 ./provider-config-history（本机 0600 存储）；
// - 这里只负责“读取 / 校验 / 原子保存 / 恢复 / 脱敏导出 / CLI 版本校对”。
//
// 所有对外 payload 都不带宿主绝对路径（只给 `~` 展示路径），避免 WebUI 泄漏完整家目录。

const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const nodePath = require('node:path');
const { spawnSync: systemSpawnSync } = require('node:child_process');
const {
  listProviderConfigFiles,
  resolveProviderConfigFile,
  displayPath
} = require('../../../providers/config-files');
const {
  getConfigSchema,
  summarizeConfigSchema,
  evaluateConfigFieldCompatibility,
  normalizePath
} = require('../../../providers/config-schemas');
const {
  appendHistoryEntry,
  getHistoryEntry,
  listHistoryEntries,
  MAX_HISTORY_ENTRIES
} = require('./provider-config-history');
const { getBinaryVersion } = require('./app-manager');
const { resolveProviderCliPath } = require('../ai-cli/ensure-native-cli');
const { resolveHostHomeDir } = require('../../../runtime/host-home');
const { resolveAiHomeDir } = require('../../../runtime/aih-home');

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const CLI_VERSION_CACHE_TTL_MS = 60 * 1000;
const MAX_VALIDATION_ERRORS = 20;

const cliVersionCache = new Map();

class ProviderConfigError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProviderConfigError';
    this.code = code;
    if (details && typeof details === 'object') Object.assign(this, details);
  }
}

function resolveContext(options = {}) {
  const fs = options.fs || nodeFs;
  const path = options.path || nodePath;
  const processObj = options.processObj || process;
  const env = options.env || processObj.env || process.env || {};
  const platform = options.platform || processObj.platform || process.platform;
  const hostHomeDir = String(options.hostHomeDir || '').trim() || resolveHostHomeDir({
    env,
    platform,
    os: options.os
  });
  const aiHomeDir = resolveAiHomeDir({
    aiHomeDir: options.aiHomeDir,
    hostHomeDir,
    env,
    path,
    platform,
    os: options.os
  });
  return { fs, path, env, platform, processObj, hostHomeDir, aiHomeDir };
}

function resolverOptions(context) {
  return {
    fs: context.fs,
    path: context.path,
    env: context.env,
    platform: context.platform,
    home: context.hostHomeDir,
    hostHomeDir: context.hostHomeDir
  };
}

function hashContent(content) {
  return crypto.createHash('sha256').update(String(content || ''), 'utf8').digest('hex');
}

function publicFile(file) {
  const schema = file.schemaId ? getConfigSchema(file.schemaId) : null;
  return {
    provider: file.provider,
    id: file.id,
    label: file.label,
    displayPath: file.displayPath,
    exists: file.exists,
    size: file.size,
    modifiedAt: file.modifiedAt,
    format: file.format,
    sensitive: file.sensitive === true,
    editable: file.editable !== false,
    schemaId: file.schemaId || '',
    schemaTitle: schema ? schema.title : '',
    schemaFieldCount: schema ? (schema.fields || []).length : 0,
    schemaVerifiedCliVersion: schema ? schema.verifiedCliVersion || '' : '',
    description: file.description || '',
    docsUrl: file.docsUrl || '',
    canCreate: file.canCreate === true
  };
}

function resolveFile(provider, fileId, context) {
  const resolved = resolveProviderConfigFile(provider, fileId, resolverOptions(context));
  if (!resolved) {
    throw new ProviderConfigError('provider_config_unknown_file', '未登记该 Provider 配置文件');
  }
  return resolved;
}

function isWritableTarget(fs, path, targetPath) {
  const mode = nodeFs.constants.W_OK;
  try {
    if (fs.existsSync(targetPath)) {
      fs.accessSync(targetPath, mode);
      return true;
    }
  } catch (_error) {
    return false;
  }
  let directory = path.dirname(targetPath);
  while (directory) {
    if (fs.existsSync(directory)) {
      try {
        fs.accessSync(directory, mode);
        return true;
      } catch (_error) {
        return false;
      }
    }
    const parent = path.dirname(directory);
    if (!parent || parent === directory) return false;
    directory = parent;
  }
  return false;
}

function readFileContent(context, file) {
  if (!file.exists) return { content: '', revision: '', size: 0, exists: false };
  let stat;
  try {
    stat = context.fs.statSync(file.absolutePath);
  } catch (error) {
    throw new ProviderConfigError('provider_config_read_failed', '读取配置失败', {
      detail: String(error && error.code || '')
    });
  }
  if (stat && stat.size > MAX_CONFIG_BYTES) {
    throw new ProviderConfigError('provider_config_too_large', '配置文件超过 2MB 编辑上限');
  }
  let content;
  try {
    content = String(context.fs.readFileSync(file.absolutePath, 'utf8') || '');
  } catch (error) {
    throw new ProviderConfigError('provider_config_read_failed', '读取配置失败', {
      detail: String(error && error.code || '')
    });
  }
  return {
    content,
    revision: hashContent(content),
    size: Buffer.byteLength(content, 'utf8'),
    exists: true
  };
}

function offsetToPosition(content, offset) {
  const end = Math.max(0, Math.min(Number(offset) || 0, String(content || '').length));
  const before = String(content || '').slice(0, end);
  const lines = before.split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

function jsoncErrorText(code, codeNames) {
  return codeNames[code] || '语法错误';
}

function validateContent(content, format) {
  const text = String(content == null ? '' : content);
  const normalizedFormat = String(format || 'text').toLowerCase();
  if (!text.trim()) return { valid: true, format: normalizedFormat, errors: [], empty: true };
  try {
    if (normalizedFormat === 'json') {
      JSON.parse(text);
      return { valid: true, format: normalizedFormat, errors: [] };
    }
    if (normalizedFormat === 'jsonc') {
      const jsonc = require('jsonc-parser');
      const errors = [];
      jsonc.parse(text, errors, { allowTrailingComma: true, disallowComments: false });
      const codeNames = jsonc.printParseErrorCode;
      return {
        valid: errors.length === 0,
        format: normalizedFormat,
        errors: errors.slice(0, MAX_VALIDATION_ERRORS).map((error) => {
          const position = offsetToPosition(text, error.offset);
          return {
            message: jsoncErrorText(error.error, codeNames),
            line: position.line,
            column: position.column
          };
        })
      };
    }
    if (normalizedFormat === 'toml') {
      const toml = require('smol-toml');
      toml.parse(text);
      return { valid: true, format: normalizedFormat, errors: [] };
    }
    if (normalizedFormat === 'yaml') {
      const yaml = require('yaml');
      const document = yaml.parseDocument(text, { uniqueKeys: true });
      const errors = (document.errors || []).slice(0, MAX_VALIDATION_ERRORS).map((error) => {
        const linePos = Array.isArray(error.linePos) ? error.linePos[0] : null;
        return {
          message: String(error.message || 'YAML 语法错误').split('\n')[0],
          line: linePos ? linePos.line : 0,
          column: linePos ? linePos.col : 0
        };
      });
      return { valid: errors.length === 0, format: normalizedFormat, errors };
    }
  } catch (error) {
    const line = Number(error && error.line) || 0;
    const column = Number(error && error.column) || 0;
    return {
      valid: false,
      format: normalizedFormat,
      errors: [{
        message: String(error && error.message || '语法错误').split('\n')[0],
        line,
        column
      }]
    };
  }
  return { valid: true, format: normalizedFormat, errors: [], skipped: true };
}

function resolveCliInfo(provider, context, options = {}) {
  const resolver = options.resolveCliInfo;
  if (typeof resolver === 'function') return resolver(provider, context);
  const key = `${context.hostHomeDir}|${context.platform}|${provider}`;
  const cached = cliVersionCache.get(key);
  if (cached && Date.now() - cached.at < CLI_VERSION_CACHE_TTL_MS) return cached.value;
  let cliPath = '';
  try {
    cliPath = String(resolveProviderCliPath(provider, {
      hostHomeDir: context.hostHomeDir,
      env: context.env,
      platform: context.platform,
      fs: context.fs,
      path: context.path
    }) || '').trim();
  } catch (_error) {
    cliPath = '';
  }
  let version = '';
  if (cliPath) {
    try {
      version = String(getBinaryVersion(cliPath, {
        spawnSync: options.spawnSync || systemSpawnSync,
        platform: context.platform
      }) || '').trim();
    } catch (_error) {
      version = '';
    }
  }
  const value = {
    installed: Boolean(cliPath),
    version,
    path: cliPath ? displayPath(cliPath, resolverOptions(context)) : ''
  };
  cliVersionCache.set(key, { at: Date.now(), value });
  return value;
}

function schemaVersionStatus(schema, cliInfo) {
  if (!schema) return null;
  const verified = String(schema.verifiedCliVersion || '').trim();
  const installed = String(cliInfo && cliInfo.version || '').trim();
  if (!verified || !installed) {
    return { verified, installed, mismatch: false, message: '' };
  }
  const installedParts = installed.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  const verifiedParts = verified.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!installedParts || !verifiedParts) {
    return { verified, installed, mismatch: false, message: '' };
  }
  const normalize = (match) => [Number(match[1] || 0), Number(match[2] || 0), Number(match[3] || 0)];
  const left = normalize(installedParts);
  const right = normalize(verifiedParts);
  let comparison = 0;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      comparison = left[index] > right[index] ? 1 : -1;
      break;
    }
  }
  if (comparison === 0) return { verified, installed, mismatch: false, message: '' };
  return {
    verified,
    installed,
    mismatch: true,
    installedNewer: comparison > 0,
    message: comparison > 0
      ? `字段说明按 CLI ${verified} 校对，当前安装的是 ${installed}；新版本可能新增或改动字段，未收录的键会回退到父级说明。`
      : `字段说明按 CLI ${verified} 校对，当前安装的是 ${installed}；该说明可能包含当前版本尚未支持的字段。`
  };
}

function annotateSchema(schema, cliVersion) {
  if (!schema) return null;
  const fields = (schema.fields || []).map((field) => ({
    ...field,
    compatibility: evaluateConfigFieldCompatibility(field, cliVersion)
  }));
  return {
    ...summarizeConfigSchema(schema),
    fields,
    compatibilityWarnings: fields
      .filter((field) => field.compatibility && field.compatibility.state !== 'ok')
      .slice(0, 50)
      .map((field) => ({
        path: field.path,
        state: field.compatibility.state,
        messages: field.compatibility.messages || []
      }))
  };
}

function buildDetail(provider, fileId, context, options = {}) {
  const { definition, file } = resolveFile(provider, fileId, context);
  const read = readFileContent(context, file);
  const cliInfo = resolveCliInfo(definition.provider, context, options);
  const schema = definition.schemaId ? getConfigSchema(definition.schemaId) : null;
  const writable = isWritableTarget(context.fs, context.path, file.absolutePath);
  const historyEntries = listHistoryEntries(definition.provider, definition.id, {
    fs: context.fs,
    path: context.path,
    aiHomeDir: context.aiHomeDir
  });
  return {
    ok: true,
    provider: definition.provider,
    file: {
      ...publicFile(file),
      writable,
      requiresElevation: !writable
    },
    content: read.content,
    revision: read.revision,
    size: read.size,
    cli: cliInfo,
    schema: annotateSchema(schema, cliInfo.version),
    schemaVersion: schemaVersionStatus(schema, cliInfo),
    historyCount: historyEntries.length,
    historyLimit: MAX_HISTORY_ENTRIES,
    docsUrl: definition.docsUrl || '',
    description: definition.description || ''
  };
}

function listConfigProviders(options = {}) {
  const context = resolveContext(options);
  const providers = listProviderConfigFiles(resolverOptions(context));
  const versions = options.includeCliVersions === true
    ? new Map(providers.map((provider) => [provider.id, resolveCliInfo(provider.id, context, options)]))
    : null;
  return {
    ok: true,
    providers: providers.map((provider) => ({
      id: provider.id,
      label: provider.label,
      cli: versions ? versions.get(provider.id) : null,
      files: provider.files.map(publicFile)
    })),
    total: providers.reduce((count, provider) => count + provider.files.length, 0)
  };
}

function readConfigFile(provider, fileId, options = {}) {
  const context = resolveContext(options);
  return buildDetail(provider, fileId, context, options);
}

function assertWritable(context, file) {
  if (!isWritableTarget(context.fs, context.path, file.absolutePath)) {
    throw new ProviderConfigError('provider_config_not_writable', '当前用户没有写入该配置文件的权限');
  }
}

function writeAtomicContent(context, file, content) {
  const fs = context.fs;
  const path = context.path;
  const target = file.absolutePath;
  let mode = 0o600;
  try {
    const stat = fs.statSync(target);
    if (stat && Number.isFinite(stat.mode)) mode = stat.mode & 0o777;
  } catch (_error) {
    mode = file.sensitive ? 0o600 : 0o644;
  }
  const directory = path.dirname(target);
  try {
    fs.mkdirSync(directory, { recursive: true, mode: file.sensitive ? 0o700 : 0o755 });
  } catch (error) {
    throw new ProviderConfigError('provider_config_save_failed', '创建配置目录失败', {
      detail: String(error && error.code || '')
    });
  }
  const temp = `${target}.aih-provider-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`;
  let renamed = false;
  try {
    fs.writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try { fs.chmodSync(temp, mode); } catch (_error) {}
    fs.renameSync(temp, target);
    renamed = true;
    try { fs.chmodSync(target, mode); } catch (_error) {}
  } catch (error) {
    throw new ProviderConfigError('provider_config_save_failed', '保存配置失败', {
      detail: String(error && error.code || '')
    });
  } finally {
    if (!renamed) {
      try { fs.unlinkSync(temp); } catch (_error) {}
    }
  }
  return mode;
}

function hasSecretsInFile(file, schema) {
  if (file.sensitive) return true;
  if (schema && schema.sensitive === true) return true;
  return Boolean(schema && (schema.fields || []).some((field) => field.secret === true));
}

function saveConfigFile(provider, fileId, content, options = {}) {
  const context = resolveContext(options);
  const { definition, file } = resolveFile(provider, fileId, context);
  const value = String(content == null ? '' : content);
  if (Buffer.byteLength(value, 'utf8') > MAX_CONFIG_BYTES) {
    throw new ProviderConfigError('provider_config_too_large', '配置文件超过 2MB 编辑上限');
  }
  const validation = validateContent(value, definition.format);
  if (!validation.valid) {
    throw new ProviderConfigError('provider_config_validation_failed', '配置语法不合法，未写入文件', {
      validation
    });
  }
  assertWritable(context, file);

  const current = readFileContent(context, file);
  const expectedRevision = String(options.expectedRevision || '').trim();
  if (expectedRevision && expectedRevision !== current.revision) {
    throw new ProviderConfigError(
      'provider_config_conflict',
      '配置文件在编辑期间已被其他进程修改，请重新读取后再保存'
    );
  }
  const revision = hashContent(value);
  const schema = definition.schemaId ? getConfigSchema(definition.schemaId) : null;
  const containsSecrets = hasSecretsInFile(file, schema);
  let historyEntry = null;
  if (!current.exists || current.content !== value) {
    const historyOptions = {
      fs: context.fs,
      path: context.path,
      aiHomeDir: context.aiHomeDir
    };
    if (current.exists && current.content && listHistoryEntries(provider, definition.id, historyOptions).length === 0) {
      appendHistoryEntry(provider, definition.id, {
        revision: current.revision,
        content: current.content,
        reason: 'baseline',
        note: '首次通过 AIH 保存前的原始内容',
        containsSecrets
      }, historyOptions);
    }
    writeAtomicContent(context, file, value);
    historyEntry = appendHistoryEntry(provider, definition.id, {
      revision,
      content: value,
      reason: options.reason === 'restore' ? 'restore' : 'save',
      note: options.note || '',
      containsSecrets
    }, historyOptions);
  }
  return {
    ok: true,
    provider,
    fileId: definition.id,
    revision,
    size: Buffer.byteLength(value, 'utf8'),
    savedAt: Date.now(),
    changed: !current.exists || current.content !== value,
    historyEntry,
    validation
  };
}

function validateConfigFile(provider, fileId, content, options = {}) {
  const context = resolveContext(options);
  const { definition } = resolveFile(provider, fileId, context);
  return {
    ok: true,
    provider,
    fileId: definition.id,
    format: definition.format,
    ...validateContent(content, definition.format)
  };
}

function listConfigHistory(provider, fileId, options = {}) {
  const context = resolveContext(options);
  const { definition } = resolveFile(provider, fileId, context);
  const entries = listHistoryEntries(provider, definition.id, {
    fs: context.fs,
    path: context.path,
    aiHomeDir: context.aiHomeDir
  });
  return { ok: true, provider, fileId: definition.id, entries, limit: MAX_HISTORY_ENTRIES };
}

function readConfigHistoryEntry(provider, fileId, entryId, options = {}) {
  const context = resolveContext(options);
  const { definition } = resolveFile(provider, fileId, context);
  const entry = getHistoryEntry(provider, definition.id, entryId, {
    fs: context.fs,
    path: context.path,
    aiHomeDir: context.aiHomeDir
  });
  if (!entry) {
    throw new ProviderConfigError('provider_config_history_entry_not_found', '版本记录不存在或已被清理');
  }
  return { ok: true, provider, fileId: definition.id, entry };
}

function restoreConfigHistoryEntry(provider, fileId, entryId, options = {}) {
  const context = resolveContext(options);
  const { definition, file } = resolveFile(provider, fileId, context);
  const historyOptions = {
    fs: context.fs,
    path: context.path,
    aiHomeDir: context.aiHomeDir
  };
  const entry = getHistoryEntry(provider, definition.id, entryId, historyOptions);
  if (!entry) {
    throw new ProviderConfigError('provider_config_history_entry_not_found', '版本记录不存在或已被清理');
  }
  const current = readFileContent(context, file);
  return saveConfigFile(provider, fileId, entry.content, {
    ...options,
    expectedRevision: current.revision,
    reason: 'restore',
    note: `恢复 ${new Date(Number(entry.savedAt) || Date.now()).toISOString()} 的版本`
  });
}

const SECRET_KEY_PATTERN = /(api[_-]?key|apikey|access[_-]?key|secret|token|password|passwd|credential|private[_-]?key|client[_-]?secret|cookie|session[_-]?key|bearer)/i;
const SENSITIVE_SAFE_KEYS = new Set([
  'type', 'mode', 'kind', 'provider', 'plan', 'region', 'scope', 'scopes',
  'token_type', 'auth_type', 'endpoint', 'base_url', 'baseurl', 'expires'
]);

function secretFieldPaths(schema) {
  const paths = new Set();
  for (const field of (schema && schema.fields) || []) {
    if (field && field.secret === true) paths.add(normalizePath(field.path));
  }
  return paths;
}

function pathIsSecret(pathText, secretPaths, key, sensitiveFile, isStringLeaf) {
  const normalizedKey = String(key || '').toLowerCase();
  if (sensitiveFile && isStringLeaf) {
    return !SENSITIVE_SAFE_KEYS.has(normalizedKey);
  }
  if (SECRET_KEY_PATTERN.test(normalizedKey)) return true;
  const normalized = normalizePath(pathText);
  if (!normalized) return false;
  for (const secretPath of secretPaths) {
    if (normalized === secretPath || normalized.startsWith(`${secretPath}.`)) return true;
  }
  return false;
}

function walkRedacted(value, options, pathParts = [], key = '', output = { fields: [] }) {
  if (Array.isArray(value)) {
    return value.map((entry, index) => walkRedacted(entry, options, [...pathParts, '*'], key, output));
  }
  if (value && typeof value === 'object') {
    const result = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      result[childKey] = walkRedacted(childValue, options, [...pathParts, childKey], childKey, output);
    }
    return result;
  }
  if (typeof value === 'string' && value) {
    const pathText = pathParts.join('.');
    if (pathIsSecret(pathText, options.secretPaths, key, options.sensitiveFile, true)) {
      if (output.fields.length < 200) output.fields.push(pathText);
      return '<redacted>';
    }
  }
  return value;
}

function parseForExport(content, format) {
  const text = String(content || '');
  if (!text.trim()) return { ok: true, value: format === 'json' || format === 'jsonc' ? {} : {} };
  try {
    if (format === 'json') return { ok: true, value: JSON.parse(text) };
    if (format === 'jsonc') {
      const jsonc = require('jsonc-parser');
      const errors = [];
      const value = jsonc.parse(text, errors, { allowTrailingComma: true, disallowComments: false });
      if (errors.length) return { ok: false, value: null };
      return { ok: true, value };
    }
    if (format === 'toml') {
      const toml = require('smol-toml');
      return { ok: true, value: toml.parse(text) };
    }
    if (format === 'yaml') {
      const yaml = require('yaml');
      const document = yaml.parseDocument(text);
      if ((document.errors || []).length) return { ok: false, value: null };
      return { ok: true, value: document.toJS() };
    }
  } catch (_error) {
    return { ok: false, value: null };
  }
  return { ok: false, value: null };
}

function stringifyForExport(value, format) {
  if (format === 'toml') {
    const toml = require('smol-toml');
    return `${toml.stringify(value)}\n`;
  }
  if (format === 'yaml') {
    const yaml = require('yaml');
    return yaml.stringify(value);
  }
  return `${JSON.stringify(value, null, 2)}\n`;
}

function redactLineBased(content) {
  const fields = [];
  const lines = String(content || '').split('\n').map((line) => {
    const match = line.match(/^(\s*(?:"[^"]*"|'[^']*'|[A-Za-z0-9_.-]+)\s*[:=]\s*)(.+?)(,?)$/);
    if (!match) return line;
    const key = match[1].replace(/["':=\s]/g, '');
    if (!SECRET_KEY_PATTERN.test(key)) return line;
    fields.push(key);
    const quote = /^\s*"/.test(match[2]) ? '"' : '';
    return `${match[1]}${quote}<redacted>${quote}${match[3]}`;
  });
  return { content: lines.join('\n'), fields };
}

function redactConfigContent(content, format, options = {}) {
  const schema = options.schema || null;
  const sensitiveFile = options.sensitiveFile === true;
  const secretPaths = secretFieldPaths(schema);
  const parsed = parseForExport(content, format);
  if (parsed.ok) {
    const output = { fields: [] };
    const redacted = walkRedacted(parsed.value, { secretPaths, sensitiveFile }, [], '', output);
    return {
      content: stringifyForExport(redacted, format === 'jsonc' ? 'json' : format),
      fields: output.fields,
      parsed: true
    };
  }
  const fallback = redactLineBased(content);
  return { content: fallback.content, fields: fallback.fields, parsed: false };
}

function exportConfigFile(provider, fileId, mode, options = {}) {
  const context = resolveContext(options);
  const { definition, file } = resolveFile(provider, fileId, context);
  const detail = buildDetail(provider, fileId, context, options);
  const exportMode = String(mode || 'redacted').toLowerCase() === 'raw' ? 'raw' : 'redacted';
  const baseName = definition.label.replace(/\.[^.]+$/, '');
  const extension = (definition.label.match(/\.[^.]+$/) || [''])[0];
  if (exportMode === 'raw') {
    return {
      ok: true,
      provider,
      fileId: definition.id,
      mode: 'raw',
      filename: definition.label,
      content: detail.content,
      redactedFields: [],
      sensitive: file.sensitive === true,
      warning: file.sensitive ? '原文件包含凭据，请只发送给可信对象。' : ''
    };
  }
  const redacted = redactConfigContent(detail.content, definition.format, {
    schema: definition.schemaId ? getConfigSchema(definition.schemaId) : null,
    sensitiveFile: file.sensitive === true
  });
  return {
    ok: true,
    provider,
    fileId: definition.id,
    mode: 'redacted',
    filename: `${baseName}.redacted${extension}`,
    content: redacted.content,
    redactedFields: redacted.fields,
    parsed: redacted.parsed,
    sensitive: file.sensitive === true,
    warning: ''
  };
}

module.exports = {
  CLI_VERSION_CACHE_TTL_MS,
  MAX_CONFIG_BYTES,
  MAX_HISTORY_ENTRIES,
  ProviderConfigError,
  exportConfigFile,
  listConfigHistory,
  listConfigProviders,
  readConfigFile,
  readConfigHistoryEntry,
  redactConfigContent,
  restoreConfigHistoryEntry,
  saveConfigFile,
  validateConfigFile,
  validateContent
};
