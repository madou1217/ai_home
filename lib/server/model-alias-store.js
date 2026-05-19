const path = require('path');
const crypto = require('crypto');
const {
  SUPPORTED_SERVER_PROVIDERS,
  inferProviderFromModel,
  isSupportedProvider
} = require('./providers');

const ALIASES_FILE = 'model-aliases.json';
const ALIAS_SCOPE_PROVIDERS = Object.freeze(['all', ...SUPPORTED_SERVER_PROVIDERS]);
const ALIAS_TARGET_PROVIDER_AUTO = 'auto';
const ALIAS_TARGET_PROVIDERS = Object.freeze([ALIAS_TARGET_PROVIDER_AUTO, ...SUPPORTED_SERVER_PROVIDERS]);

function generateAliasId() {
  return crypto.randomBytes(4).toString('hex');
}

function normalizeAliasScopeProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  return ALIAS_SCOPE_PROVIDERS.includes(provider) ? provider : 'all';
}

function normalizeAliasTargetProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  if (!provider) return ALIAS_TARGET_PROVIDER_AUTO;
  return ALIAS_TARGET_PROVIDERS.includes(provider) ? provider : ALIAS_TARGET_PROVIDER_AUTO;
}

function normalizeRequestProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  return isSupportedProvider(provider) ? provider : '';
}

function normalizeAliasRecord(value, fallback = {}) {
  const source = {
    ...(fallback || {}),
    ...(value || {})
  };
  return {
    id: String(source.id || '').trim(),
    alias: String(source.alias || '').trim(),
    target: String(source.target || '').trim(),
    provider: normalizeAliasScopeProvider(source.provider),
    targetProvider: normalizeAliasTargetProvider(source.targetProvider),
    enabled: source.enabled !== false,
    description: String(source.description || '').trim()
  };
}

function normalizeAliasData(data) {
  const aliases = Array.isArray(data && data.aliases)
    ? data.aliases.map((item) => normalizeAliasRecord(item)).filter((item) => item.alias && item.target)
    : [];
  return { aliases };
}

async function loadAliases(fs, aiHomeDir) {
  const filePath = path.join(aiHomeDir, ALIASES_FILE);
  try {
    const data = await fs.promises.readFile(filePath, 'utf8');
    const parsed = JSON.parse(data);
    if (!parsed || !Array.isArray(parsed.aliases)) {
      return { aliases: [] };
    }
    return normalizeAliasData(parsed);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { aliases: [] };
    }
    throw error;
  }
}

async function saveAliases(fs, aiHomeDir, data) {
  const filePath = path.join(aiHomeDir, ALIASES_FILE);
  await fs.promises.writeFile(filePath, JSON.stringify(normalizeAliasData(data), null, 2), 'utf8');
}

/**
 * Resolves a model alias.
 * @param {Array} aliases - The list of alias objects.
 * @param {string} model - The requested model name.
 * @param {string} provider - The provider (e.g., 'claude', 'codex', 'gemini').
 * @returns {{target: string, id: string, provider: string, targetProvider: string}|null} - The resolved alias, or null if no match.
 */
function resolveAlias(aliases, model, provider) {
  if (!aliases || !Array.isArray(aliases)) return null;

  const requestProvider = normalizeRequestProvider(provider);
  const activeAliases = aliases
    .map((item) => normalizeAliasRecord(item))
    .filter((a) => a.enabled !== false && (a.provider === 'all' || a.provider === requestProvider));

  // 1. Exact match
  const exactMatch = activeAliases.find(a => a.alias === model);
  if (exactMatch) {
    return {
      target: exactMatch.target,
      id: exactMatch.id,
      provider: exactMatch.provider,
      targetProvider: exactMatch.targetProvider
    };
  }

  // 2. Wildcard match (find longest prefix)
  let bestWildcardMatch = null;
  let maxPrefixLength = -1;

  for (const a of activeAliases) {
    if (a.alias.endsWith('*')) {
      const prefix = a.alias.slice(0, -1);
      if (model.startsWith(prefix)) {
        if (prefix.length > maxPrefixLength) {
          maxPrefixLength = prefix.length;
          bestWildcardMatch = a;
        }
      }
    }
  }

  if (bestWildcardMatch) {
    return {
      target: bestWildcardMatch.target,
      id: bestWildcardMatch.id,
      provider: bestWildcardMatch.provider,
      targetProvider: bestWildcardMatch.targetProvider
    };
  }

  return null;
}

function resolveAliasUpstreamProvider(alias) {
  const normalized = normalizeAliasRecord(alias);
  if (!normalized.target) return '';
  if (isSupportedProvider(normalized.targetProvider)) return normalized.targetProvider;
  return inferProviderFromModel(normalized.target);
}

module.exports = {
  ALIAS_SCOPE_PROVIDERS,
  ALIAS_TARGET_PROVIDERS,
  generateAliasId,
  loadAliases,
  normalizeAliasRecord,
  normalizeAliasScopeProvider,
  normalizeAliasTargetProvider,
  resolveAliasUpstreamProvider,
  saveAliases,
  resolveAlias
};
