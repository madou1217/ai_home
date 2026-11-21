'use strict';

const path = require('node:path');
const Ajv = require('ajv');
const semver = require('semver');
const contract = require('./contract.generated.json');
const schema = require('./manifest.schema.generated.json');
const { PluginError, requireCondition } = require('./errors');

const ajv = new Ajv({ allErrors: true, strict: true });
const validate = ajv.compile(schema);
const capabilities = new Map(contract.capabilities.map((item) => [item.id, item]));
const ACCOUNT_CAPABILITIES = Object.freeze([
  'account.source',
  'account.login',
  'account.refresh',
  'account.materialize'
]);
const ACCOUNT_CAPABILITY_SET = new Set(ACCOUNT_CAPABILITIES);
const FILESYSTEM_SCOPES = new Set(['state']);

function safeRelativePath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && !value.includes('\\') && !value.includes('\0') && !value.includes(':')
    && !path.posix.isAbsolute(value)
    && value.split('/').every((part) => part && part !== '.' && part !== '..');
}

function freezeJson(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function normalizePermissions(permissions) {
  if (!permissions) return null;
  return {
    network: [...permissions.network],
    filesystem: {
      read: [...permissions.filesystem.read],
      write: [...permissions.filesystem.write]
    },
    secrets: [...permissions.secrets],
    environment: [...(permissions.environment || [])]
  };
}

function validatePermissions(manifest) {
  const contributesAccount = (manifest.contributes || []).some((entry) => ACCOUNT_CAPABILITY_SET.has(entry.capability));
  const permissions = manifest.permissions || null;
  if (contributesAccount) {
    requireCondition(permissions, 'plugin_permissions_required',
      '账号插件必须显式声明 permissions（network / filesystem / secrets）');
  }
  if (!permissions) return;
  for (const value of permissions.network || []) {
    let url = null;
    try { url = new URL(value); } catch (_error) { url = null; }
    // 网络授权必须是可核对的 https 源：不接受通配、用户信息、查询串或片段，
    // 否则「授权 api.example.com」会静默变成「授权任意路径/任意凭据」。
    requireCondition(url && url.protocol === 'https:' && url.hostname
      && !url.username && !url.password && !url.search && !url.hash
      && (url.pathname === '/' || url.pathname === ''),
    'plugin_permission_network_invalid', `网络权限必须是 https 源：${value}`);
  }
  for (const direction of ['read', 'write']) {
    for (const scope of permissions.filesystem[direction] || []) {
      requireCondition(FILESYSTEM_SCOPES.has(scope), 'plugin_permission_filesystem_invalid',
        `文件系统权限只允许 state（插件私有状态），不允许 ${scope}`);
    }
  }
}

function validateManifest(input, options = {}) {
  requireCondition(validate(input), 'plugin_manifest_invalid', '插件清单不符合公开合同');
  requireCondition(safeRelativePath(input.entry), 'plugin_entry_invalid', '插件入口必须为包内相对路径');
  requireCondition(semver.valid(input.version), 'plugin_version_invalid');
  const host = options.hostVersion || '1.0.0';
  requireCondition(semver.validRange(input.engines.aih) && semver.satisfies(host, input.engines.aih), 'plugin_host_incompatible');
  if (input.engines.node) {
    requireCondition(semver.validRange(input.engines.node)
      && semver.satisfies(options.nodeVersion || process.versions.node, input.engines.node), 'plugin_node_incompatible');
  }
  const target = options.target || process.platform + '-' + process.arch;
  requireCondition(!input.targets?.length || input.targets.includes('any') || input.targets.includes(target), 'plugin_platform_incompatible');
  const ids = new Set();
  for (const contribution of input.contributes) {
    const capability = capabilities.get(contribution.capability);
    requireCondition(capability?.version === contribution.version, 'plugin_capability_incompatible');
    requireCondition(!ids.has(contribution.id), 'plugin_contribution_duplicate');
    ids.add(contribution.id);
  }
  const names = new Set();
  for (const service of input.provides || []) {
    requireCondition(service.name !== 'aih' && !names.has(service.name), 'plugin_service_duplicate');
    requireCondition(semver.valid(service.version), 'plugin_service_version_invalid');
    names.add(service.name);
  }
  const required = new Set();
  for (const service of input.requires || []) {
    requireCondition(!required.has(service.name), 'plugin_requirement_duplicate');
    requireCondition(semver.validRange(service.versionRange), 'plugin_service_version_invalid');
    required.add(service.name);
  }
  for (const configSchema of [input.configSchema, input.secretsSchema].filter(Boolean)) {
    requireCondition(ajv.validateSchema(configSchema), 'plugin_config_schema_invalid');
    try { ajv.compile(configSchema); } catch (_error) { throw new PluginError('plugin_config_schema_invalid'); }
  }
  validatePermissions(input);
  const normalized = JSON.parse(JSON.stringify(input));
  if (normalized.permissions) normalized.permissions = normalizePermissions(normalized.permissions);
  return freezeJson(normalized);
}

function validateConfiguration(manifest, configuration = {}, secrets = {}) {
  for (const [schemaValue, value] of [[manifest.configSchema, configuration], [manifest.secretsSchema, secrets]]) {
    requireCondition(value && typeof value === 'object' && !Array.isArray(value), 'plugin_config_invalid');
    if (schemaValue) requireCondition(ajv.compile(schemaValue)(value), 'plugin_config_invalid', '插件配置不符合其 schema');
    else requireCondition(Object.keys(value).length === 0, 'plugin_config_unsupported');
  }
  return freezeJson(JSON.parse(JSON.stringify({ configuration, secrets })));
}

module.exports = {
  ACCOUNT_CAPABILITIES,
  capabilities,
  freezeJson,
  normalizePermissions,
  safeRelativePath,
  validateConfiguration,
  validateManifest,
  validatePermissions
};
