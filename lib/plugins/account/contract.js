'use strict';

// 账号插件的数据合同。
//
// 账号插件只交换 JSON（来源、登录状态、凭据投影文件、刷新结果），
// accountRef / 判重 / 入库 / 沙箱写入 / 任务生命周期都由宿主执行。
// 任何函数、路径穿越、绝对路径、凭据直写数据库的字段都在这里 fail closed。

const path = require('node:path');
const { PluginError, requireCondition } = require('../sdk/errors');
const { safeRelativePath } = require('../sdk/manifest');

const ACCOUNT_SCHEMA_VERSION = 1;
const ACCOUNT_SOURCE_KINDS = new Set(['local', 'remote']);
const LOGIN_STATUSES = new Set(['waiting_user', 'success', 'failed']);
const MAX_SOURCES = 32;
const MAX_FILES = 64;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

function normalizeText(value) {
  return String(value === undefined || value === null ? '' : value).trim();
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function jsonClone(value, code) {
  let text;
  try { text = JSON.stringify(value); } catch (_error) {
    throw new PluginError(code, '返回值不是可序列化的 JSON');
  }
  requireCondition(text.length <= MAX_RESULT_BYTES, code, '返回值超过大小上限');
  return JSON.parse(text);
}

function normalizeProvider(value) {
  const provider = normalizeText(value).toLowerCase();
  requireCondition(PROVIDER_PATTERN.test(provider), 'account_plugin_provider_invalid', `非法 provider：${provider}`);
  return provider;
}

function normalizeCallbackUrl(value, field) {
  const text = normalizeText(value);
  if (!text) return '';
  let url;
  try { url = new URL(text); } catch (_error) { url = null; }
  requireCondition(url && (url.protocol === 'https:' || url.protocol === 'http:'), 'account_plugin_url_invalid',
    `${field} 必须是 http(s) URL`);
  return url.toString();
}

function normalizeAccountSource(input, meta = {}) {
  requireCondition(isRecord(input), 'account_plugin_source_invalid');
  const id = normalizeText(input.id);
  requireCondition(SOURCE_ID_PATTERN.test(id), 'account_plugin_source_id_invalid', `非法来源 id：${id}`);
  const kind = normalizeText(input.kind).toLowerCase();
  requireCondition(ACCOUNT_SOURCE_KINDS.has(kind), 'account_plugin_source_kind_invalid', `来源 ${id} 的 kind 非法`);
  const authMode = normalizeText(input.authMode).toLowerCase();
  requireCondition(authMode, 'account_plugin_source_auth_mode_invalid', `来源 ${id} 缺少 authMode`);
  requireCondition(typeof input.clientDependent === 'boolean', 'account_plugin_source_invalid',
    `来源 ${id} 必须声明 clientDependent`);
  const requiresApp = normalizeText(input.requiresApp || (input.requires && input.requires.app) || input.app);
  const directImport = input.directImport === true;
  const available = input.available !== false;
  const identity = input.identity === undefined || input.identity === null
    ? null
    : jsonClone(input.identity, 'account_plugin_source_identity_invalid');
  const credential = input.credential === undefined || input.credential === null
    ? null
    : jsonClone(input.credential, 'account_plugin_source_credential_invalid');
  // directImport 只是「这个来源可以不经交互任务直接入库」的声明；投影文件允许在
  // account.source 的 import 调用里才生成，不能要求列表阶段就带 credential。
  return Object.freeze({
    schemaVersion: ACCOUNT_SCHEMA_VERSION,
    id,
    kind,
    authMode,
    clientDependent: input.clientDependent,
    requiresApp,
    directImport,
    available,
    description: normalizeText(input.description),
    identity,
    credential,
    projectionId: normalizeText(input.projectionId),
    loginContribution: normalizeText(input.loginContribution),
    pluginInstanceId: normalizeText(meta.instanceId),
    pluginContributionId: normalizeText(meta.contributionId),
    provider: normalizeText(meta.provider).toLowerCase()
  });
}

function normalizeSourceListResult(result, meta = {}) {
  const value = Array.isArray(result) ? { sources: result } : (isRecord(result) ? result : {});
  const sources = value.sources === undefined ? [] : value.sources;
  requireCondition(Array.isArray(sources), 'account_plugin_sources_invalid');
  requireCondition(sources.length <= MAX_SOURCES, 'account_plugin_sources_too_many');
  const seen = new Set();
  return sources.map((source) => {
    const normalized = normalizeAccountSource(source, meta);
    requireCondition(!seen.has(normalized.id), 'account_plugin_source_duplicate', `来源 id 重复：${normalized.id}`);
    seen.add(normalized.id);
    return normalized;
  });
}

function normalizeProjectionFile(input) {
  requireCondition(isRecord(input), 'account_plugin_file_invalid');
  const file = normalizeText(input.path).replace(/\\/g, '/');
  requireCondition(safeRelativePath(file), 'account_plugin_file_path_invalid', `非法文件路径：${file}`);
  const encoding = normalizeText(input.encoding || 'utf8').toLowerCase();
  requireCondition(encoding === 'utf8' || encoding === 'base64', 'account_plugin_file_encoding_invalid');
  const content = String(input.content === undefined || input.content === null ? '' : input.content);
  const bytes = encoding === 'base64'
    ? Math.floor((content.replace(/=+$/, '').length * 3) / 4)
    : Buffer.byteLength(content, 'utf8');
  requireCondition(bytes <= MAX_FILE_BYTES, 'account_plugin_file_too_large', `文件 ${file} 超过 4MB`);
  return Object.freeze({ path: file, encoding, content, mode: input.mode === 0o600 ? 0o600 : 0o600 });
}

function normalizeProjectionFiles(value, field = 'files') {
  const files = value === undefined ? [] : value;
  requireCondition(Array.isArray(files), 'account_plugin_files_invalid', `${field} 必须是数组`);
  requireCondition(files.length <= MAX_FILES, 'account_plugin_files_too_many');
  const seen = new Set();
  return files.map((file) => {
    const normalized = normalizeProjectionFile(file);
    requireCondition(!seen.has(normalized.path.toLowerCase()), 'account_plugin_file_duplicate', `文件重复：${normalized.path}`);
    seen.add(normalized.path.toLowerCase());
    return normalized;
  });
}

function normalizeLoginResult(result) {
  const value = jsonClone(isRecord(result) ? result : {}, 'account_plugin_login_result_invalid');
  const status = normalizeText(value.status).toLowerCase();
  requireCondition(LOGIN_STATUSES.has(status), 'account_plugin_login_status_invalid');
  const expiresAt = Number(value.expiresAt);
  return Object.freeze({
    status,
    jobId: normalizeText(value.jobId),
    message: normalizeText(value.message),
    verificationUri: normalizeCallbackUrl(value.verificationUri, 'verificationUri'),
    verificationUriComplete: normalizeCallbackUrl(value.verificationUriComplete, 'verificationUriComplete'),
    userCode: normalizeText(value.userCode).slice(0, 128),
    authorizationUrl: normalizeCallbackUrl(value.authorizationUrl, 'authorizationUrl'),
    redirectUri: normalizeCallbackUrl(value.redirectUri, 'redirectUri'),
    expiresAt: Number.isFinite(expiresAt) && expiresAt > 0 ? Math.round(expiresAt) : 0,
    intervalMs: Math.max(1000, Number(value.intervalMs) || 5000),
    files: normalizeProjectionFiles(value.files),
    credential: isRecord(value.credential) ? jsonClone(value.credential, 'account_plugin_login_credential_invalid') : null,
    rotated: value.rotated === true,
    metadata: isRecord(value.metadata) ? jsonClone(value.metadata, 'account_plugin_login_metadata_invalid') : null
  });
}

function normalizeRefreshResult(result) {
  if (result === null || result === undefined) return null;
  const value = jsonClone(isRecord(result) ? result : {}, 'account_plugin_refresh_result_invalid');
  return Object.freeze({
    handled: value.handled === true,
    files: normalizeProjectionFiles(value.files),
    credential: isRecord(value.credential) ? jsonClone(value.credential, 'account_plugin_refresh_credential_invalid') : null,
    rotated: value.rotated === true,
    expiresAt: Number(value.expiresAt) > 0 ? Math.round(Number(value.expiresAt)) : 0,
    refreshedAt: Number(value.refreshedAt) > 0 ? Math.round(Number(value.refreshedAt)) : Date.now(),
    metadata: isRecord(value.metadata) ? jsonClone(value.metadata, 'account_plugin_refresh_metadata_invalid') : null
  });
}

function normalizeMaterializeResult(result) {
  const value = jsonClone(isRecord(result) ? result : {}, 'account_plugin_materialize_result_invalid');
  return Object.freeze({
    handled: value.handled !== false,
    files: normalizeProjectionFiles(value.files),
    removed: Array.isArray(value.removed)
      ? value.removed.map((item) => {
        const file = normalizeText(item).replace(/\\/g, '/');
        requireCondition(safeRelativePath(file), 'account_plugin_file_path_invalid', `非法移除路径：${file}`);
        return file;
      })
      : []
  });
}

function writeProjectionFiles(fs, runtimeDir, files, options = {}) {
  const root = path.resolve(String(runtimeDir || ''));
  requireCondition(root && fs.existsSync(root), 'account_plugin_runtime_dir_missing');
  const written = [];
  for (const file of files) {
    const target = path.join(root, ...file.path.split('/'));
    const relative = path.relative(root, target);
    requireCondition(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'account_plugin_file_path_invalid');
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const data = file.encoding === 'base64'
      ? Buffer.from(file.content, 'base64')
      : Buffer.from(file.content, 'utf8');
    const temp = `${target}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    fs.writeFileSync(temp, data, { mode: file.mode || 0o600 });
    fs.renameSync(temp, target);
    try { fs.chmodSync(target, file.mode || 0o600); } catch (_error) { /* Windows 不支持时忽略 */ }
    written.push(file.path);
  }
  if (options.remove && options.remove.length) {
    for (const item of options.remove) {
      const target = path.join(root, ...String(item).split('/'));
      const relative = path.relative(root, target);
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) fs.rmSync(target, { force: true });
    }
  }
  return written;
}

module.exports = {
  ACCOUNT_SCHEMA_VERSION,
  normalizeAccountSource,
  normalizeLoginResult,
  normalizeMaterializeResult,
  normalizeProjectionFiles,
  normalizeProvider,
  normalizeRefreshResult,
  normalizeSourceListResult,
  writeProjectionFiles
};
