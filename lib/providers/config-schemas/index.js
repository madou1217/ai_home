'use strict';

// Provider 配置文件字段说明（离线快照）。
//
// 这里的数据来自各 CLI 的官方文档 / 官方 JSON Schema，生成时记录 sourceUrl 与
// verifiedCliVersion。字段语义会随 CLI 版本变化，所以每条记录都带来源与校对版本；
// WebUI 只展示这里声明过的事实，未收录的键回退到父级说明并给出官方文档链接。
//
// 数据文件在 ./data 下，按 schemaId 一一对应；新增文件说明 = 加一个 JSON + 在下面的
// CATALOG 里登记一行，消费方（路由 / UI）不需要知道 provider 名单。

const CATALOG = Object.freeze({
  'codex.config': require('./data/codex.config.json'),
  'codex.auth': require('./data/codex.auth.json'),
  'claude.settings': require('./data/claude.settings.json'),
  'claude.credentials': require('./data/claude.credentials.json'),
  'opencode.config': require('./data/opencode.config.json'),
  'opencode.auth': require('./data/opencode.auth.json'),
  'gemini.settings': require('./data/gemini.settings.json'),
  'gemini.oauth': require('./data/gemini.oauth.json'),
  'grok.config': require('./data/grok.config.json'),
  'agy.settings': require('./data/agy.settings.json')
});

const FIELD_INDEX_CACHE = new Map();

function normalizePath(value) {
  return String(value || '')
    .trim()
    .replace(/^\[+|\]+$/g, '')
    .replace(/^\.+|\.+$/g, '')
    .replace(/\s+/g, '');
}

function fieldIndexFor(schema) {
  const key = schema && schema.id;
  if (!key) return new Map();
  if (FIELD_INDEX_CACHE.has(key)) return FIELD_INDEX_CACHE.get(key);
  const index = new Map();
  for (const field of schema.fields || []) {
    const path = normalizePath(field.path);
    if (!path || index.has(path)) continue;
    index.set(path, field);
  }
  FIELD_INDEX_CACHE.set(key, index);
  return index;
}

function getConfigSchema(schemaId) {
  const schema = CATALOG[String(schemaId || '').trim()];
  if (!schema) return null;
  return {
    ...schema,
    fieldCount: (schema.fields || []).length
  };
}

function listConfigSchemaSummaries() {
  return Object.values(CATALOG).map((schema) => ({
    id: schema.id,
    title: schema.title,
    source: schema.source,
    sourceUrl: schema.sourceUrl || '',
    verifiedAt: schema.verifiedAt || '',
    verifiedCliVersion: schema.verifiedCliVersion || '',
    fieldCount: (schema.fields || []).length
  }));
}

/**
 * 把编辑器里的键路径映射到字段说明：先精确匹配，再逐级回退到父路径。
 * 例如 `model_providers.aih.name` 在只声明了 `model_providers.<id>` 时回退到它。
 */
function matchConfigSchemaField(schema, keyPath) {
  if (!schema) return null;
  const index = fieldIndexFor(schema);
  let current = normalizePath(keyPath);
  while (current) {
    if (index.has(current)) return index.get(current);
    const dot = current.lastIndexOf('.');
    current = dot > 0 ? current.slice(0, dot) : '';
  }
  return null;
}

function parseVersionParts(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return null;
  return [Number(match[1] || 0), Number(match[2] || 0), Number(match[3] || 0)];
}

function compareVersions(left, right) {
  const a = parseVersionParts(left);
  const b = parseVersionParts(right);
  if (!a || !b) return null;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

/**
 * 字段与当前安装 CLI 版本的兼容性提示。
 * `since` / `removedIn` 是可选字段，只有文档给出明确版本边界时才填写。
 */
function evaluateConfigFieldCompatibility(field, cliVersion) {
  const fieldValue = field || {};
  const result = { state: 'ok', messages: [] };
  if (fieldValue.deprecated) {
    result.state = 'deprecated';
    result.messages.push('该配置已被标记为弃用，新版本可能不再生效。');
  }
  const installed = String(cliVersion || '').trim();
  if (installed) {
    if (fieldValue.removedIn && compareVersions(installed, fieldValue.removedIn) >= 0) {
      return {
        state: 'unsupported',
        messages: [`当前 CLI ${installed} 已移除该配置（removedIn ${fieldValue.removedIn}）。`]
      };
    }
    if (fieldValue.since && compareVersions(installed, fieldValue.since) < 0) {
      return {
        state: 'unsupported',
        messages: [`该配置从 CLI ${fieldValue.since} 起才支持，当前为 ${installed}。`]
      };
    }
  }
  return result;
}

function summarizeConfigSchema(schema) {
  if (!schema) return null;
  return {
    id: schema.id,
    title: schema.title,
    source: schema.source,
    sourceUrl: schema.sourceUrl || '',
    docsUrl: schema.docsUrl || schema.sourceUrl || '',
    verifiedAt: schema.verifiedAt || '',
    verifiedCliVersion: schema.verifiedCliVersion || '',
    sensitive: schema.sensitive === true,
    fieldCount: (schema.fields || []).length,
    fields: schema.fields || []
  };
}

module.exports = {
  CATALOG,
  compareVersions,
  evaluateConfigFieldCompatibility,
  getConfigSchema,
  listConfigSchemaSummaries,
  matchConfigSchemaField,
  normalizePath,
  summarizeConfigSchema
};
