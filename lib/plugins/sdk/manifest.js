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
  return freezeJson(JSON.parse(JSON.stringify(input)));
}

function validateConfiguration(manifest, configuration = {}, secrets = {}) {
  for (const [schemaValue, value] of [[manifest.configSchema, configuration], [manifest.secretsSchema, secrets]]) {
    requireCondition(value && typeof value === 'object' && !Array.isArray(value), 'plugin_config_invalid');
    if (schemaValue) requireCondition(ajv.compile(schemaValue)(value), 'plugin_config_invalid', '插件配置不符合其 schema');
    else requireCondition(Object.keys(value).length === 0, 'plugin_config_unsupported');
  }
  return freezeJson(JSON.parse(JSON.stringify({ configuration, secrets })));
}

module.exports = { capabilities, freezeJson, safeRelativePath, validateConfiguration, validateManifest };
