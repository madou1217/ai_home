'use strict';

const path = require('node:path');
const { parse } = require('smol-toml');

// Authentication mode is a deliberate transport choice, not a function of
// gateway availability, quota, or whether an old provider remains registered.
function parseCodexTransportConfig(text, args = []) {
  const root = parse(String(text || ''));
  const overrides = {};
  let profileName = root.profile;
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (arg === '--profile' || arg === '-p') profileName = args[++i];
    else if (arg.startsWith('--profile=')) profileName = arg.slice(10);
    let pair = '';
    if (arg === '-c' || arg === '--config') pair = String(args[++i] || '');
    else if (arg.startsWith('--config=')) pair = arg.slice(9);
    else if (arg.startsWith('-c') && arg.length > 2) pair = arg.slice(2);
    const equals = pair.indexOf('=');
    if (equals < 0) continue;
    const key = pair.slice(0, equals).trim();
    if (!['model_provider', 'preferred_auth_method', 'model', 'profile'].includes(key)) continue;
    const raw = pair.slice(equals + 1).trim();
    try { overrides[key] = parse(`value = ${raw}`).value; }
    catch (_) { overrides[key] = raw; } // Codex also accepts bare -c string values.
  }
  profileName = overrides.profile || profileName;
  const profile = profileName && root.profiles && root.profiles[profileName];
  const config = { ...root, ...(profile && typeof profile === 'object' ? profile : {}), ...overrides };
  const value = key => typeof config[key] === 'string' ? config[key].trim() : '';
  return {
    preferredAuthMethod: value('preferred_auth_method'),
    modelProvider: value('model_provider'),
    model: value('model')
  };
}

function isNativeOAuthConfig(config) {
  return Boolean(config && config.modelProvider === 'openai'
    && config.preferredAuthMethod === 'oauth');
}

function nativeOAuthEnvironment(source) {
  const env = { ...source };
  // Keep network egress (HTTP_PROXY, etc.), but never let inherited relay
  // credentials change the selected upstream/authentication mechanism.
  for (const key of ['OPENAI_API_KEY', 'OPENAI_BASE_URL',
    'AIH_CODEX_GATEWAY_ACCOUNT_REF', 'AIH_CODEX_REMOTE_AUTH_TOKEN']) delete env[key];
  return env;
}

function hasTransportOverride(config) {
  if (!config || typeof config !== 'object') return false;
  return ['model_provider', 'profile', 'preferred_auth_method', 'openai_base_url', 'chatgpt_base_url']
    .some(key => config[key] != null);
}

// Native takeover is restricted to an implicit legacy AIH/OpenAI resume.
// Explicit per-request/project routing belongs to the caller, not set-default.
function hasResumeTransportOverride(fs, payload, cwd, codexHome) {
  const params = payload && payload.params || {};
  if (params.modelProvider || hasTransportOverride(params.config)) return true;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return false;
  const homeConfig = path.resolve(codexHome, 'config.toml');
  let directory = path.resolve(cwd);
  for (let depth = 0; depth < 128; depth += 1) {
    const file = path.join(directory, '.codex', 'config.toml');
    if (file !== homeConfig) {
      try {
        if (fs.existsSync(file)) {
          const doc = parse(fs.readFileSync(file, 'utf8'));
          if (hasTransportOverride(doc)) return true;
        }
      } catch (_) {
        // Let the native client diagnose unreadable/invalid project config.
        return true;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
  return true;
}

module.exports = {
  parseCodexTransportConfig, isNativeOAuthConfig,
  nativeOAuthEnvironment, hasResumeTransportOverride
};
