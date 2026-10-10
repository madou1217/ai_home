'use strict';

const crypto = require('node:crypto');
const { applyEdits, modify, parse: parseJsonc } = require('jsonc-parser');
const { parse: parseToml } = require('smol-toml');
const { buildAihServerBaseUrl } = require('./self-relay-account');
const { normalizeAnthropicSdkBaseUrl } = require('./anthropic-endpoint');
const { resolveHealthyGatewayModels } = require('../cli/services/ai-cli/launch-profile/opencode-strategy');
const { PINNED_ACCOUNT_HEADER } = require('../cli/services/ai-cli/claude-account-relay');

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
    || (state.ownership !== undefined && !Object.hasOwn(OWNERSHIP_STRATEGIES, state.ownership))
    || (state.active && (typeof state.original !== 'string'
      || typeof state.originalExisted !== 'boolean'
      || !/^[a-f0-9]{64}$/.test(state.managedHash || '')))) {
    throw new Error('invalid_gateway_default_state');
  }
  return state;
}

function resolveOwnership(ownership) {
  return OWNERSHIP_STRATEGIES[ownership || 'file'] || OWNERSHIP_STRATEGIES.file;
}

function inspectManagedHostConfig(fs, path, hostGlobalDir, fileName, ownership) {
  const strategy = resolveOwnership(ownership);
  const statePath = path.join(hostGlobalDir, MANAGED_STATE_FILE);
  const state = readManagedState(fs, statePath, fileName);
  const configPath = path.join(hostGlobalDir, fileName);
  const current = readRegularHostFile(fs, configPath);
  if (state && state.active) {
    const matchesManaged = strategy.matchesManaged(current, state);
    const matchesOriginal = strategy.matchesOriginal(current, state);
    if (!matchesManaged && !matchesOriginal) throw new Error('gateway_default_host_config_changed');
    return { state, current, matchesManaged, configPath, statePath, strategy };
  }
  return { state, current, matchesManaged: false, configPath, statePath, strategy };
}

function selectHostGatewayProfile({ fs, path, hostGlobalDir, fileName, ownership, buildContent, writePrivateFile, writePrivateJson }) {
  const { configPath, statePath, current, state, strategy } = inspectManagedHostConfig(fs, path, hostGlobalDir, fileName, ownership);
  const nextContent = buildContent(current || '');
  const nextState = {
    fileName,
    active: true,
    ...(strategy.id === 'file' ? {} : { ownership: strategy.id }),
    originalExisted: state && state.active ? state.originalExisted : current !== null,
    original: state && state.active ? state.original : current || '',
    managedHash: strategy.managedHash(nextContent)
  };
  writePrivateJson(statePath, nextState);
  writePrivateFile(configPath, nextContent);
  return { configPath };
}

function restoreHostGatewayProfile({ fs, path, hostGlobalDir, fileName, ownership, writePrivateFile, writePrivateJson }) {
  const { statePath, configPath, state, current, matchesManaged, strategy } = inspectManagedHostConfig(fs, path, hostGlobalDir, fileName, ownership);
  if (!state || !state.active) return { restored: false };
  if (matchesManaged) {
    const restored = strategy.restoredContent(current, state);
    if (restored !== null) writePrivateFile(configPath, restored);
    else if (current !== null) fs.unlinkSync(configPath);
  }
  writePrivateJson(statePath, { fileName, active: false });
  return { restored: true };
}

function verifyHostGatewayRestore({ fs, path, hostGlobalDir, fileName, ownership }) {
  inspectManagedHostConfig(fs, path, hostGlobalDir, fileName, ownership);
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

const CLAUDE_CREDENTIAL_ENV_KEYS = Object.freeze(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']);
const CLAUDE_CUSTOM_HEADERS_ENV = 'ANTHROPIC_CUSTOM_HEADERS';

function splitHeaderLines(value) {
  return String(value || '').split('\n').map((line) => line.trim()).filter(Boolean);
}

// 账号钉选头归 AIH 管：每次投影先去掉旧的钉选行，再按本次投影加回；用户自己的其它头保留。
function mergeClaudeCustomHeaders(existing, projected) {
  const pinPrefix = `${PINNED_ACCOUNT_HEADER}:`;
  const kept = splitHeaderLines(existing).filter((line) => !line.toLowerCase().startsWith(pinPrefix));
  return [...kept, ...splitHeaderLines(projected)].join('\n');
}

function parseClaudeSettings(rawSettings) {
  const settings = String(rawSettings || '').trim() ? JSON.parse(rawSettings) : {};
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)
    || (settings.env && (typeof settings.env !== 'object' || Array.isArray(settings.env)))) {
    throw new Error('invalid_claude_settings');
  }
  return settings;
}

// 旧凭据整组清掉再写：只换 token 不清 BASE_URL 会把新 key 发到上一个账号的端点。
function buildClaudeSettingsContent(rawSettings, credentialEnv) {
  const settings = parseClaudeSettings(rawSettings);
  const env = { ...(settings.env || {}) };
  for (const key of CLAUDE_CREDENTIAL_ENV_KEYS) delete env[key];
  const customHeaders = mergeClaudeCustomHeaders(env[CLAUDE_CUSTOM_HEADERS_ENV], credentialEnv[CLAUDE_CUSTOM_HEADERS_ENV]);
  const nextEnv = { ...env, ...credentialEnv };
  if (customHeaders) nextEnv[CLAUDE_CUSTOM_HEADERS_ENV] = customHeaders;
  else delete nextEnv[CLAUDE_CUSTOM_HEADERS_ENV];
  // 宿主裸跑 Claude 同样由 SDK 追加 /v1/messages，必须与 AIH 启动链共用规范化。
  if (nextEnv.ANTHROPIC_BASE_URL) {
    nextEnv.ANTHROPIC_BASE_URL = normalizeAnthropicSdkBaseUrl(nextEnv.ANTHROPIC_BASE_URL);
  }
  return `${JSON.stringify({ ...settings, env: nextEnv }, null, 2)}\n`;
}

// AIH 在 Claude settings.json 里托管的字段：三个凭据变量与钉选头那一行。
// 文件无法解析时返回 null（归属未知，调用方失败关闭）；文件不存在或为空视为 {}。
function claudeOwnedProjection(content) {
  if (content === null || content === undefined || !String(content).trim()) return {};
  let settings;
  try {
    settings = parseClaudeSettings(content);
  } catch {
    return null;
  }
  const env = settings.env || {};
  const projection = {};
  for (const key of CLAUDE_CREDENTIAL_ENV_KEYS) {
    if (Object.hasOwn(env, key)) projection[key] = String(env[key]);
  }
  const pinPrefix = `${PINNED_ACCOUNT_HEADER}:`;
  const pin = splitHeaderLines(env[CLAUDE_CUSTOM_HEADERS_ENV]).find((line) => line.toLowerCase().startsWith(pinPrefix));
  if (pin) projection.pin = pin;
  return projection;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sameProjection(left, right) {
  return Boolean(left) && Boolean(right) && canonicalJson(left) === canonicalJson(right);
}

function originalContentOf(state) {
  return state.originalExisted ? state.original : '';
}

// 把托管字段恢复成接管前的值，其余内容（Claude Code 之后写入的权限等）原样保留。
function restoreClaudeOwnedEnv(currentContent, originalContent) {
  const settings = parseClaudeSettings(currentContent);
  const original = claudeOwnedProjection(originalContent) || {};
  const env = { ...(settings.env || {}) };
  for (const key of CLAUDE_CREDENTIAL_ENV_KEYS) {
    if (Object.hasOwn(original, key)) env[key] = original[key];
    else delete env[key];
  }
  const customHeaders = mergeClaudeCustomHeaders(env[CLAUDE_CUSTOM_HEADERS_ENV], original.pin || '');
  if (customHeaders) env[CLAUDE_CUSTOM_HEADERS_ENV] = customHeaders;
  else delete env[CLAUDE_CUSTOM_HEADERS_ENV];
  const next = { ...settings };
  if (Object.keys(env).length > 0) next.env = env;
  else delete next.env;
  return next;
}

/**
 * 受管宿主文件的归属策略（策略模式）。file：整文件归 AIH，任何外部改动都失败关闭（opencode、
 * kimi）。claude-env：Claude Code 会自己改写 settings.json（权限规则等），按整文件判断会让一次
 * 权限确认就卡死后续的默认账号切换；这里只认 AIH 写入的凭据字段，归属判定与还原都按字段进行。
 */
const OWNERSHIP_STRATEGIES = Object.freeze({
  file: Object.freeze({
    id: 'file',
    managedHash: (content) => contentHash(content),
    matchesManaged: (current, state) => current !== null && contentHash(current) === state.managedHash,
    matchesOriginal: (current, state) => (state.originalExisted ? current === state.original : current === null),
    restoredContent: (_current, state) => (state.originalExisted ? state.original : null)
  }),
  'claude-env': Object.freeze({
    id: 'claude-env',
    managedHash: (content) => contentHash(canonicalJson(claudeOwnedProjection(content))),
    matchesManaged(current, state) {
      const projection = claudeOwnedProjection(current);
      if (!projection) return false;
      if (state.ownership === 'claude-env') return contentHash(canonicalJson(projection)) === state.managedHash;
      // 旧版状态按整文件哈希记录，Claude Code 改过权限后必然对不上。凭据字段只由 AIH 写入：
      // 只要它们已不同于接管前的原值，就按 AIH 托管处理，下次写入时升级为按字段记录。
      return contentHash(current) === state.managedHash
        || !sameProjection(projection, claudeOwnedProjection(originalContentOf(state)));
    },
    matchesOriginal: (current, state) => sameProjection(
      claudeOwnedProjection(current),
      claudeOwnedProjection(originalContentOf(state))
    ),
    restoredContent(current, state) {
      const restored = restoreClaudeOwnedEnv(current || '', originalContentOf(state));
      // 除托管字段外没有别的改动时，原样写回接管前的字节（原文件不存在则删除）。
      let original = {};
      try {
        original = originalContentOf(state).trim() ? JSON.parse(originalContentOf(state)) : {};
      } catch {
        original = null;
      }
      if (original && canonicalJson(restored) === canonicalJson(original)) {
        return state.originalExisted ? state.original : null;
      }
      return `${JSON.stringify(restored, null, 2)}\n`;
    }
  })
});

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
  CLAUDE_SETTINGS_OWNERSHIP: 'claude-env',
  buildClaudeSettingsContent,
  buildOpenCodeGatewayConfig,
  buildOpenCodeGatewayContent,
  buildKimiGatewayConfig,
  restoreHostGatewayProfile,
  selectHostGatewayProfile,
  verifyHostGatewayRestore
};
