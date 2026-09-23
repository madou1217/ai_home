'use strict';

const crypto = require('node:crypto');
const { applyEdits, modify, parse: parseJsonc } = require('jsonc-parser');
const { parse: parseToml } = require('smol-toml');
const { buildAihServerBaseUrl } = require('./self-relay-account');
const { resolveHealthyGatewayModels } = require('../cli/services/ai-cli/launch-profile/opencode-strategy');

const KIMI_START = '# ai-home managed AIH Server profile';
const KIMI_END = '# end ai-home managed AIH Server profile';
const KIMI_MODEL = 'aih-server/kimi-for-coding';
const MANAGED_STATE_FILE = '.aih-server-default-state.json';
const OPENCODE_SCHEMA_URL = 'https://opencode.ai/config.json';

function readRegularHostFile(fs, filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('host_config_not_regular_file');
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function contentHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function readManagedState(fs, statePath, fileName) {
  const raw = readRegularHostFile(fs, statePath);
  if (raw === null) return null;
  const state = JSON.parse(raw);
  if (!state || state.fileName !== fileName || typeof state.active !== 'boolean'
    || (state.active && (typeof state.original !== 'string'
      || typeof state.originalExisted !== 'boolean'
      || !/^[a-f0-9]{64}$/.test(state.managedHash || '')))) {
    throw new Error('invalid_gateway_default_state');
  }
  return state;
}

function inspectManagedHostConfig(fs, path, hostGlobalDir, fileName) {
  const statePath = path.join(hostGlobalDir, MANAGED_STATE_FILE);
  const state = readManagedState(fs, statePath, fileName);
  const configPath = path.join(hostGlobalDir, fileName);
  const current = readRegularHostFile(fs, configPath);
  if (state && state.active) {
    const matchesManaged = current !== null && contentHash(current) === state.managedHash;
    const matchesOriginal = state.originalExisted ? current === state.original : current === null;
    if (!matchesManaged && !matchesOriginal) throw new Error('gateway_default_host_config_changed');
    return { state, current, matchesManaged, configPath, statePath };
  }
  return { state, current, matchesManaged: false, configPath, statePath };
}

function selectHostGatewayProfile({ fs, path, hostGlobalDir, fileName, buildContent, writePrivateFile, writePrivateJson }) {
  const { configPath, statePath, current, state } = inspectManagedHostConfig(fs, path, hostGlobalDir, fileName);
  const nextContent = buildContent(current || '');
  const nextState = {
    fileName,
    active: true,
    originalExisted: state && state.active ? state.originalExisted : current !== null,
    original: state && state.active ? state.original : current || '',
    managedHash: contentHash(nextContent)
  };
  writePrivateJson(statePath, nextState);
  writePrivateFile(configPath, nextContent);
  return { configPath };
}

function restoreHostGatewayProfile({ fs, path, hostGlobalDir, fileName, writePrivateFile, writePrivateJson }) {
  const { statePath, configPath, state, matchesManaged } = inspectManagedHostConfig(fs, path, hostGlobalDir, fileName);
  if (!state || !state.active) return { restored: false };
  if (matchesManaged) {
    if (state.originalExisted) writePrivateFile(configPath, state.original);
    else fs.unlinkSync(configPath);
  }
  writePrivateJson(statePath, { fileName, active: false });
  return { restored: true };
}

function verifyHostGatewayRestore({ fs, path, hostGlobalDir, fileName }) {
  inspectManagedHostConfig(fs, path, hostGlobalDir, fileName);
}

function buildOpenCodeGatewayConfig(rawConfig, serverConfig, context = {}) {
  const parseErrors = [];
  const config = rawConfig.trim()
    ? parseJsonc(rawConfig, parseErrors, { allowTrailingComma: true })
    : {};
  if (parseErrors.length > 0) throw new Error('invalid_opencode_config');
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || (config.provider && (typeof config.provider !== 'object' || Array.isArray(config.provider)))) {
    throw new Error('invalid_opencode_config');
  }
  const existing = config.provider && config.provider.aih;
  if (existing && existing.name !== 'AI Home Gateway') {
    throw new Error('opencode_gateway_provider_conflict');
  }
  const models = resolveHealthyGatewayModels(context);
  if (models.length === 0) throw new Error('opencode_gateway_models_unavailable');
  const defaultModel = models.includes('claude-sonnet-4-6') ? 'claude-sonnet-4-6' : models[0];
  return {
    $schema: Object.hasOwn(config, '$schema') ? config.$schema : OPENCODE_SCHEMA_URL,
    ...config,
    model: `aih/${defaultModel}`,
    provider: {
      ...(config.provider || {}),
      aih: {
        npm: '@ai-sdk/openai-compatible',
        name: 'AI Home Gateway',
        options: {
          baseURL: buildAihServerBaseUrl(serverConfig),
          apiKey: String(serverConfig.apiKey || serverConfig.clientKey || '').trim() || 'dummy'
        },
        models: Object.fromEntries(models.map((model) => [model, { name: `${model} (AIH)` }]))
      }
    }
  };
}

function buildOpenCodeGatewayContent(rawConfig, serverConfig, context = {}, jsonc = false) {
  const config = buildOpenCodeGatewayConfig(rawConfig, serverConfig, context);
  if (!jsonc) return `${JSON.stringify(config, null, 2)}\n`;
  let content = rawConfig.trim() ? rawConfig : '{}\n';
  const options = {
    formattingOptions: { tabSize: 2, insertSpaces: true },
    getInsertionIndex: () => 0
  };
  const edits = [
    [['model'], config.model],
    [['provider', 'aih'], config.provider.aih]
  ];
  if (!Object.hasOwn(parseJsonc(content), '$schema')) {
    edits.unshift([['$schema'], config.$schema]);
  }
  for (const [targetPath, value] of edits) {
    content = applyEdits(content, modify(content, targetPath, value, options));
  }
  const errors = [];
  parseJsonc(content, errors, { allowTrailingComma: true });
  if (errors.length > 0) throw new Error('invalid_opencode_config_after_edit');
  return content.endsWith('\n') ? content : `${content}\n`;
}

function buildKimiGatewayConfig(rawConfig, serverConfig) {
  const source = String(rawConfig || '');
  const start = source.indexOf(KIMI_START);
  const end = source.indexOf(KIMI_END);
  if ((start === -1) !== (end === -1) || (start !== -1 && (end < start || source.indexOf(KIMI_START, start + 1) !== -1))) {
    throw new Error('invalid_kimi_gateway_block');
  }
  const clean = start === -1
    ? source
    : `${source.slice(0, start)}${source.slice(end + KIMI_END.length)}`;
  const parsed = clean.trim() ? parseToml(clean) : {};
  if (parsed.providers && Object.hasOwn(parsed.providers, 'aih-server')
    || parsed.models && Object.hasOwn(parsed.models, KIMI_MODEL)) {
    throw new Error('kimi_gateway_provider_conflict');
  }
  const firstTable = clean.search(/^\s*\[/m);
  const root = firstTable < 0 ? clean : clean.slice(0, firstTable);
  const rest = firstTable < 0 ? '' : clean.slice(firstTable);
  const selected = /^default_model\s*=/m.test(root)
    ? root.replace(/^default_model\s*=.*$/m, `default_model = "${KIMI_MODEL}"`)
    : `default_model = "${KIMI_MODEL}"\n${root}`;
  const apiKey = String(serverConfig.apiKey || serverConfig.clientKey || '').trim() || 'dummy';
  const block = [
    KIMI_START,
    '[providers."aih-server"]',
    'type = "kimi"',
    `api_key = ${JSON.stringify(apiKey)}`,
    `base_url = ${JSON.stringify(buildAihServerBaseUrl(serverConfig))}`,
    '',
    `[models."${KIMI_MODEL}"]`,
    'provider = "aih-server"',
    'model = "kimi-for-coding"',
    'max_context_size = 262144',
    KIMI_END
  ].join('\n');
  const result = `${selected.trimEnd()}\n${rest.trimEnd()}\n\n${block}\n`;
  parseToml(result);
  return result;
}

module.exports = {
  buildOpenCodeGatewayConfig,
  buildOpenCodeGatewayContent,
  buildKimiGatewayConfig,
  restoreHostGatewayProfile,
  selectHostGatewayProfile,
  verifyHostGatewayRestore
};
