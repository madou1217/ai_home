'use strict';

const { normalizeCodexHooksFeatureFlag } = require('../../config/codex-feature-flags');
const { buildServerBaseUrl } = require('../../../server/server-defaults');

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
  return normalized;
}

function escapeTomlBasicString(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function getManagedAihProviderBlock(options = {}) {
  const normalized = normalizeCodexConfigSyncOptions(options);
  const bearerToken = String(options.bearerToken || normalized.openaiApiKey || 'dummy').trim() || 'dummy';
  const providerKey = getAihProviderKey(options.accountId);
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

function mergeConfigs(hostConfigText, accountOnlyConfig, accountId, options = {}) {
  const normalized = normalizeCodexConfigSyncOptions(options);
  const lines = [];
  const providerKey = getAihProviderKey(accountId);
  const explicitAihHeader = `[model_providers.${providerKey}]`;
  const managedAihHeaders = getManagedAihProviderHeaders(accountId);
  const managedAihProviderKeys = getManagedAihProviderKeys(accountId);

  const preservedModelProviders = Array.isArray(accountOnlyConfig.model_providers)
    ? accountOnlyConfig.model_providers.slice()
    : [];
  const preservedHeaders = new Set(
    preservedModelProviders
      .map((block) => extractSectionHeader(block))
      .filter(Boolean)
  );
  let effectiveModelProviders = preservedModelProviders;
  const accountModelProvider = extractModelProviderName(accountOnlyConfig.model_provider);
  const hostHasAihProvider = Array.from(managedAihHeaders).some((header) => String(hostConfigText || '').includes(header));
  const preservedHasAihProvider = Array.from(managedAihHeaders).some((header) => preservedHeaders.has(header));
  const shouldUseAihProvider = Boolean(
    normalized.openaiBaseUrl
    || preservedHasAihProvider
    || hostHasAihProvider
    || managedAihProviderKeys.has(accountModelProvider)
  );

  if (normalized.isApiKeyMode && normalized.openaiBaseUrl) {
    effectiveModelProviders = preservedModelProviders.filter(
      (block) => !managedAihHeaders.has(extractSectionHeader(block))
    );
    effectiveModelProviders.push(
      getManagedAihProviderBlock({
        accountId,
        openaiBaseUrl: normalized.openaiBaseUrl,
        openaiApiKey: normalized.openaiApiKey
      })
    );
    managedAihHeaders.forEach((header) => preservedHeaders.add(header));
  }

  let effectiveModelProviderLine = String(accountOnlyConfig.model_provider || '').trim();
  if (normalized.isApiKeyMode && shouldUseAihProvider) {
    effectiveModelProviderLine = `model_provider = "${providerKey}"`;
  }

  lines.push(`# Codex configuration for account ${accountId}`);
  lines.push('# This file is managed by ai-home (aih)');
  lines.push('# Synced from host config (excluding sensitive fields)');
  lines.push('');

  if (accountOnlyConfig.preferred_auth_method) {
    lines.push(accountOnlyConfig.preferred_auth_method);
  }
  if (effectiveModelProviderLine) {
    lines.push(effectiveModelProviderLine);
  }
  if (normalized.isApiKeyMode && !accountOnlyConfig.preferred_auth_method) {
    lines.push('preferred_auth_method = "apikey"');
  }
  if (normalized.isApiKeyMode && !effectiveModelProviderLine) {
    lines.push(`model_provider = "${shouldUseAihProvider ? providerKey : 'openai'}"`);
  }
  if (normalized.sqliteHome) {
    lines.push(`sqlite_home = "${escapeTomlBasicString(normalized.sqliteHome)}"`);
  }
  lines.push('');

  lines.push('# AI Home managed permissions: Full Access');
  lines.push('sandbox_mode = "danger-full-access"');
  lines.push('');

  if (normalized.openaiBaseUrl) {
    lines.push('# API endpoint configuration (migrated from OPENAI_BASE_URL env var)');
    lines.push(`openai_base_url = "${normalized.openaiBaseUrl}"`);
    lines.push('');
  }

  let sanitizedHostConfig = stripNamedSections(hostConfigText, preservedHeaders);
  if (normalized.openaiBaseUrl) {
    sanitizedHostConfig = stripRootKeys(sanitizedHostConfig, ['openai_base_url']);
  }
  if (normalized.sqliteHome) {
    sanitizedHostConfig = stripRootKeys(sanitizedHostConfig, ['sqlite_home']);
  }
  const hostLines = String(sanitizedHostConfig || '').split('\n');
  let hasContent = false;
  for (const line of hostLines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') && (trimmed.includes('Codex configuration') || trimmed.includes('managed by'))) {
      continue;
    }
    if (trimmed || hasContent) {
      lines.push(line);
      if (trimmed) hasContent = true;
    }
  }

  if (Array.isArray(accountOnlyConfig.providers) && accountOnlyConfig.providers.length > 0) {
    lines.push('');
    lines.push('# Account-specific providers');
    accountOnlyConfig.providers.forEach((provider) => {
      lines.push(provider);
    });
  }

  if (effectiveModelProviders.length > 0) {
    lines.push('');
    lines.push('# Account-specific model providers');
    effectiveModelProviders.forEach((providerBlock) => {
      lines.push(providerBlock);
      lines.push('');
    });
  }

  const mergedConfig = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  return hoistModelProviderSections(
    normalizeCodexHooksFeatureFlag(mergedConfig, {
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
  extractAccountOnlyConfig,
  filterHostConfig,
  mergeSharedProjectSections,
  mergeConfigs
};
