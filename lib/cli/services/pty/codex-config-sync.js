'use strict';

const { normalizeCodexHooksFeatureFlag } = require('../../config/codex-feature-flags');
const { buildServerBaseUrl } = require('../../../server/server-defaults');
const { normalizeWindowsPathForCodexConfig } = require('../../../runtime/windows-path-encoding');

const AIH_CODEX_PROVIDER_KEY = 'aih';
const AIH_CODEX_PROVIDER_NAME = 'aih codex';
const AIH_CODEX_PROVIDER_BASE_URL = buildServerBaseUrl();
const AIH_CODEX_PROVIDER_WIRE_API = 'responses';

function getAihProviderKey(accountId = '') {
  const normalizedAccountId = String(accountId || '').trim();
  if (!normalizedAccountId) return AIH_CODEX_PROVIDER_KEY;
  const safeAccountId = normalizedAccountId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${AIH_CODEX_PROVIDER_KEY}_${safeAccountId}`;
}

function getManagedAihProviderKeys(accountId = '') {
  const keys = new Set([AIH_CODEX_PROVIDER_KEY]);
  const accountProviderKey = getAihProviderKey(accountId);
  if (accountProviderKey) keys.add(accountProviderKey);
  return keys;
}

function getManagedAihProviderHeaders(accountId = '') {
  return new Set(
    Array.from(getManagedAihProviderKeys(accountId)).map((key) => `[model_providers.${key}]`)
  );
}

function extractModelProviderName(modelProviderLine) {
  const match = String(modelProviderLine || '').trim().match(/^model_provider\s*=\s*"([^"]+)"\s*$/);
  return match ? String(match[1] || '').trim() : '';
}

function isAihManagedProviderKey(providerKey) {
  const normalized = String(providerKey || '').trim();
  return normalized === AIH_CODEX_PROVIDER_KEY || normalized.startsWith(`${AIH_CODEX_PROVIDER_KEY}_`);
}

function extractModelProviderKeyFromHeader(header) {
  const match = String(header || '').trim().match(/^\[model_providers\.([^\]]+)\]\s*$/);
  return match ? String(match[1] || '').trim() : '';
}

function isAihManagedScaffoldComment(line) {
  const trimmed = String(line || '').trim();
  return trimmed === '# This file is managed by ai-home (aih)'
    || trimmed === '# Synced from host config (excluding sensitive fields)'
    || trimmed === '# AI Home managed permissions: Full Access'
    || trimmed === '# API endpoint configuration (migrated from OPENAI_BASE_URL env var)'
    || /^# Codex configuration for account\b/.test(trimmed);
}

function normalizeCodexConfigSyncOptions(options = {}) {
  const normalized = {
    ...options
  };
  const isApiKeyMode = Boolean(options.isApiKeyMode);
  const openaiBaseUrl = String(options.openaiBaseUrl || '').trim();
  normalized.isApiKeyMode = isApiKeyMode;
  normalized.openaiApiKey = String(options.openaiApiKey || '').trim();
  normalized.openaiBaseUrl = openaiBaseUrl;
  normalized.sqliteHome = String(options.sqliteHome || '').trim();
  normalized.codexVersion = String(options.codexVersion || '').trim();
  normalized.forceAihProvider = Boolean(options.forceAihProvider);
  normalized.providerKeyOverride = isAihManagedProviderKey(options.providerKeyOverride)
    ? String(options.providerKeyOverride || '').trim()
    : '';
  return normalized;
}

function getEffectiveAihProviderKey(accountId = '', options = {}) {
  const normalized = normalizeCodexConfigSyncOptions(options);
  return normalized.providerKeyOverride || getAihProviderKey(accountId);
}

function escapeTomlBasicString(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function getManagedAihProviderBlock(options = {}) {
  const normalized = normalizeCodexConfigSyncOptions(options);
  const bearerToken = String(options.bearerToken || normalized.openaiApiKey || 'dummy').trim() || 'dummy';
  const providerKey = getEffectiveAihProviderKey(options.accountId, options);
  return [
    `[model_providers.${providerKey}]`,
    `name = "${AIH_CODEX_PROVIDER_NAME}"`,
    `base_url = "${normalized.openaiBaseUrl || AIH_CODEX_PROVIDER_BASE_URL}"`,
    `bearer_token = "${bearerToken}"`,
    `wire_api = "${AIH_CODEX_PROVIDER_WIRE_API}"`
  ].join('\n');
}

function isModelProviderHeader(line) {
  return /^\[model_providers\.[^\]]+\]\s*$/.test(String(line || '').trim());
}

function isProjectHeader(line) {
  return /^\[projects\.[^\]]+\]\s*$/.test(String(line || '').trim());
}

function extractSectionHeader(block) {
  const lines = String(block || '').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceTomlSection(content, header, block) {
  const source = String(content || '');
  const blockRegex = new RegExp(`(?:^|\\n)${escapeRegExp(header)}[\\s\\S]*?(?=\\n\\[|(?![\\s\\S]))`);
  if (blockRegex.test(source)) {
    return source.replace(blockRegex, (match) => {
      const prefix = match.startsWith('\n') ? '\n' : '';
      return `${prefix}${block}`;
    });
  }
  return `${source.trimEnd()}${source.trim() ? '\n\n' : ''}${block}\n`;
}

function upsertRootKeyLine(configText, key, line) {
  const lines = String(configText || '').split('\n');
  const keyPattern = new RegExp(`^${escapeRegExp(key)}\\s*=`);
  let firstSectionIndex = lines.findIndex((candidate) => candidate.trim().startsWith('['));
  if (firstSectionIndex === -1) firstSectionIndex = lines.length;

  let replaced = false;
  const nextLines = [];
  lines.forEach((candidate, index) => {
    const trimmed = candidate.trim();
    if (index < firstSectionIndex && keyPattern.test(trimmed)) {
      if (!replaced) {
        nextLines.push(line);
        replaced = true;
      }
      return;
    }
    nextLines.push(candidate);
  });

  if (!replaced) {
    const insertAt = firstSectionIndex;
    nextLines.splice(insertAt, 0, line);
  }

  return nextLines.join('\n');
}

function hasOwnOption(options, key) {
  return Object.prototype.hasOwnProperty.call(options || {}, key);
}

function buildPreferredAuthMethodLine(accountOnlyConfig, options = {}) {
  const normalized = normalizeCodexConfigSyncOptions(options);
  if (normalized.forceAihProvider || normalized.isApiKeyMode) {
    return 'preferred_auth_method = "apikey"';
  }
  if (hasOwnOption(options, 'isApiKeyMode') && !normalized.isApiKeyMode) {
    return 'preferred_auth_method = "oauth"';
  }
  return accountOnlyConfig && accountOnlyConfig.preferred_auth_method
    ? String(accountOnlyConfig.preferred_auth_method).trim()
    : '';
}

function buildModelProviderLine(accountOnlyConfig, accountId, options = {}) {
  const normalized = normalizeCodexConfigSyncOptions(options);
  if (normalized.forceAihProvider || normalized.isApiKeyMode) {
    return `model_provider = "${getEffectiveAihProviderKey(accountId, options)}"`;
  }
  if (hasOwnOption(options, 'isApiKeyMode') && !normalized.isApiKeyMode) {
    return 'model_provider = "openai"';
  }
  return accountOnlyConfig && accountOnlyConfig.model_provider
    ? String(accountOnlyConfig.model_provider).trim()
    : '';
}

function extractAccountOnlyConfig(configText) {
  const result = {
    preferred_auth_method: null,
    model_provider: null,
    providers: [],
    model_providers: []
  };

  const lines = String(configText || '').split('\n');
  let activeType = null;
  let activeLines = [];

  const flushActive = () => {
    if (!activeType || activeLines.length === 0) {
      activeType = null;
      activeLines = [];
      return;
    }
    if (activeType === 'providers') {
      result.providers.push(activeLines.join('\n'));
    } else if (activeType === 'model_providers') {
      result.model_providers.push(activeLines.join('\n'));
    }
    activeType = null;
    activeLines = [];
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (activeType) {
      const startsNewProviders = trimmed === '[[providers]]';
      const startsNewModelProvider = isModelProviderHeader(trimmed);
      const startsOtherSection = trimmed.startsWith('[') && !startsNewProviders && !startsNewModelProvider;

      if (startsNewProviders || startsNewModelProvider || startsOtherSection) {
        flushActive();
      }
    }

    if (!activeType && trimmed.startsWith('preferred_auth_method')) {
      result.preferred_auth_method = trimmed;
      continue;
    }

    if (!activeType && trimmed.startsWith('model_provider')) {
      result.model_provider = trimmed;
      continue;
    }

    if (trimmed === '[[providers]]') {
      activeType = 'providers';
      activeLines = [rawLine];
      continue;
    }

    if (isModelProviderHeader(trimmed)) {
      activeType = 'model_providers';
      activeLines = [rawLine];
      continue;
    }

    if (activeType) {
      activeLines.push(rawLine);
    }
  }

  flushActive();
  return result;
}

function filterHostConfig(configText, options = {}) {
  const lines = String(configText || '').split('\n');
  const filtered = [];
  let skipUntilNextSection = false;
  let inModelProviders = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (skipUntilNextSection) {
      if (trimmed.startsWith('[')) {
        skipUntilNextSection = false;
      } else {
        continue;
      }
    }

    if (options.excludeAccountOnly) {
      if (trimmed.startsWith('preferred_auth_method') || trimmed.startsWith('model_provider')) {
        continue;
      }
      if (trimmed === '[[providers]]') {
        skipUntilNextSection = true;
        continue;
      }
    }

    if (options.excludeSensitive) {
      if (isModelProviderHeader(trimmed)) {
        inModelProviders = true;
        filtered.push(line);
        continue;
      }

      if (inModelProviders && trimmed.startsWith('[') && !isModelProviderHeader(trimmed)) {
        inModelProviders = false;
      }

      if (inModelProviders) {
        if (
          trimmed.startsWith('bearer_token')
          || trimmed.startsWith('api_key')
          || trimmed.includes('_token =')
          || trimmed.includes('_key =')
        ) {
          continue;
        }
      }
    }

    if (trimmed.startsWith('sandbox_mode')) {
      continue;
    }
    if (isAihManagedScaffoldComment(trimmed)) {
      continue;
    }

    filtered.push(line);
  }

  return filtered.join('\n');
}

function stripNamedSections(configText, headers) {
  const headerSet = headers instanceof Set ? headers : new Set(headers || []);
  if (headerSet.size === 0) return String(configText || '');

  const lines = String(configText || '').split('\n');
  const nextLines = [];
  let skipping = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      skipping = headerSet.has(trimmed);
      if (skipping) continue;
    }
    if (!skipping) {
      nextLines.push(line);
    }
  }

  return nextLines.join('\n');
}

function extractSections(configText, predicate) {
  const sections = [];
  const lines = String(configText || '').split('\n');
  let active = null;

  const flush = () => {
    if (!active) return;
    sections.push(active.lines.join('\n').trimEnd());
    active = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      flush();
      if (predicate(trimmed)) {
        active = { header: trimmed, lines: [line] };
      }
      continue;
    }
    if (active) active.lines.push(line);
  }

  flush();
  return sections.filter((section) => String(section || '').trim());
}

function mergeSharedProjectSections(baseConfigText, sharedConfigText) {
  const baseText = String(baseConfigText || '');
  const baseHeaders = new Set(extractSections(baseText, isProjectHeader).map(extractSectionHeader));
  const missingSharedProjects = extractSections(sharedConfigText, isProjectHeader)
    .filter((section) => !baseHeaders.has(extractSectionHeader(section)));
  if (missingSharedProjects.length === 0) return baseText;
  return [
    baseText.trimEnd(),
    ...missingSharedProjects
  ].filter((block) => String(block || '').trim()).join('\n\n') + '\n';
}

function stripRootKeys(configText, keys) {
  const keySet = keys instanceof Set ? keys : new Set(keys || []);
  if (keySet.size === 0) return String(configText || '');

  const lines = String(configText || '').split('\n');
  const nextLines = [];
  let inSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inSection = true;
      nextLines.push(line);
      continue;
    }
    if (!inSection) {
      const match = trimmed.match(/^([A-Za-z0-9_-]+)\s*=/);
      if (match && keySet.has(match[1])) continue;
    }
    nextLines.push(line);
  }

  return nextLines.join('\n');
}

function hoistModelProviderSections(configText) {
  const lines = String(configText || '').split('\n');
  const rootLines = [];
  const providerSections = [];
  const otherSections = [];
  let activeSection = null;

  const flushSection = () => {
    if (!activeSection) return;
    const target = isModelProviderHeader(activeSection.header)
      ? providerSections
      : otherSections;
    target.push(activeSection.lines.join('\n').trimEnd());
    activeSection = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      flushSection();
      activeSection = {
        header: trimmed,
        lines: [line]
      };
      continue;
    }

    if (activeSection) {
      activeSection.lines.push(line);
    } else {
      rootLines.push(line);
    }
  }

  flushSection();

  return [
    rootLines.join('\n').trimEnd(),
    ...providerSections.filter(Boolean),
    ...otherSections.filter(Boolean)
  ]
    .filter((block) => String(block || '').trim())
    .join('\n\n') + '\n';
}

function scopeAccountOnlyConfig(accountOnlyConfig, accountId, options = {}) {
  const normalized = normalizeCodexConfigSyncOptions(options);
  const providerKey = getEffectiveAihProviderKey(accountId, options);
  const accountModelProvider = extractModelProviderName(accountOnlyConfig && accountOnlyConfig.model_provider);
  const shouldUseAihProvider = Boolean(
    normalized.forceAihProvider
    || normalized.openaiBaseUrl
    || isAihManagedProviderKey(accountModelProvider)
  );
  const scoped = {
    preferred_auth_method: accountOnlyConfig && accountOnlyConfig.preferred_auth_method
      ? accountOnlyConfig.preferred_auth_method
      : null,
    model_provider: accountOnlyConfig && accountOnlyConfig.model_provider
      ? accountOnlyConfig.model_provider
      : null,
    providers: Array.isArray(accountOnlyConfig && accountOnlyConfig.providers)
      ? accountOnlyConfig.providers.slice()
      : [],
    model_providers: []
  };

  if (shouldUseAihProvider) {
    scoped.preferred_auth_method = 'preferred_auth_method = "apikey"';
    scoped.model_provider = `model_provider = "${providerKey}"`;
  }

  const activeModelProvider = extractModelProviderName(scoped.model_provider);
  const modelProviders = Array.isArray(accountOnlyConfig && accountOnlyConfig.model_providers)
    ? accountOnlyConfig.model_providers
    : [];
  scoped.model_providers = modelProviders.filter((block) => {
    const key = extractModelProviderKeyFromHeader(extractSectionHeader(block));
    if (!key) return false;
    if (key === providerKey) return true;
    if (key === activeModelProvider && !isAihManagedProviderKey(key)) return true;
    return false;
  });

  return scoped;
}

function mergeConfigs(hostConfigText, accountOnlyConfig, accountId, options = {}) {
  const normalized = normalizeCodexConfigSyncOptions(options);
  const providerKey = getEffectiveAihProviderKey(accountId, options);
  let mergedConfig = String(hostConfigText || '').trimEnd();

  const preferredAuthMethodLine = buildPreferredAuthMethodLine(accountOnlyConfig, options);
  if (preferredAuthMethodLine) {
    mergedConfig = upsertRootKeyLine(mergedConfig, 'preferred_auth_method', preferredAuthMethodLine);
  }

  const modelProviderLine = buildModelProviderLine(accountOnlyConfig, accountId, options);
  if (modelProviderLine) {
    mergedConfig = upsertRootKeyLine(mergedConfig, 'model_provider', modelProviderLine);
  }

  if (normalized.sqliteHome) {
    const sqliteHome = normalizeWindowsPathForCodexConfig(normalized.sqliteHome);
    mergedConfig = upsertRootKeyLine(
      mergedConfig,
      'sqlite_home',
      `sqlite_home = "${escapeTomlBasicString(sqliteHome)}"`
    );
  }

  if (normalized.forceAihProvider || normalized.isApiKeyMode) {
    const providerBlock = getManagedAihProviderBlock({
      accountId,
      openaiBaseUrl: normalized.openaiBaseUrl,
      bearerToken: normalized.openaiBaseUrl ? (normalized.openaiApiKey || 'dummy') : 'dummy',
      providerKeyOverride: normalized.providerKeyOverride
    });
    mergedConfig = replaceTomlSection(mergedConfig, `[model_providers.${providerKey}]`, providerBlock);
  }

  return hoistModelProviderSections(
    normalizeCodexHooksFeatureFlag(`${mergedConfig.trimEnd()}\n`, {
      codexVersion: normalized.codexVersion
    }).content
  );
}

module.exports = {
  AIH_CODEX_PROVIDER_KEY,
  AIH_CODEX_PROVIDER_NAME,
  AIH_CODEX_PROVIDER_BASE_URL,
  AIH_CODEX_PROVIDER_WIRE_API,
  getAihProviderKey,
  getManagedAihProviderKeys,
  getManagedAihProviderHeaders,
  normalizeCodexConfigSyncOptions,
  escapeTomlBasicString,
  getManagedAihProviderBlock,
  hoistModelProviderSections,
  extractModelProviderName,
  extractModelProviderKeyFromHeader,
  isAihManagedProviderKey,
  scopeAccountOnlyConfig,
  extractAccountOnlyConfig,
  filterHostConfig,
  mergeSharedProjectSections,
  mergeConfigs
};
