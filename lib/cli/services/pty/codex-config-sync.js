'use strict';

const AIH_CODEX_PROVIDER_KEY = 'aih';
const AIH_CODEX_PROVIDER_NAME = 'aih codex';
const AIH_CODEX_PROVIDER_BASE_URL = 'http://127.0.0.1:8317/v1';
const AIH_CODEX_PROVIDER_WIRE_API = 'responses';

function normalizeCodexConfigSyncOptions(options = {}) {
  const normalized = {
    ...options
  };
  const isApiKeyMode = Boolean(options.isApiKeyMode);
  const openaiBaseUrl = String(options.openaiBaseUrl || '').trim();
  normalized.isApiKeyMode = isApiKeyMode;
  normalized.openaiApiKey = String(options.openaiApiKey || '').trim();
  normalized.openaiBaseUrl = openaiBaseUrl;
  return normalized;
}

function getManagedAihProviderBlock(options = {}) {
  const normalized = normalizeCodexConfigSyncOptions(options);
  const bearerToken = String(options.bearerToken || normalized.openaiApiKey || 'dummy').trim() || 'dummy';
  return [
    `[model_providers.${AIH_CODEX_PROVIDER_KEY}]`,
    `name = "${AIH_CODEX_PROVIDER_NAME}"`,
    `base_url = "${normalized.openaiBaseUrl || AIH_CODEX_PROVIDER_BASE_URL}"`,
    `bearer_token = "${bearerToken}"`,
    `wire_api = "${AIH_CODEX_PROVIDER_WIRE_API}"`
  ].join('\n');
}

function isModelProviderHeader(line) {
  return /^\[model_providers\.[^\]]+\]\s*$/.test(String(line || '').trim());
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

function mergeConfigs(hostConfigText, accountOnlyConfig, accountId, options = {}) {
  const normalized = normalizeCodexConfigSyncOptions(options);
  const lines = [];
  const explicitAihHeader = `[model_providers.${AIH_CODEX_PROVIDER_KEY}]`;

  const preservedModelProviders = Array.isArray(accountOnlyConfig.model_providers)
    ? accountOnlyConfig.model_providers.slice()
    : [];
  const preservedHeaders = new Set(
    preservedModelProviders
      .map((block) => extractSectionHeader(block))
      .filter(Boolean)
  );
  let effectiveModelProviders = preservedModelProviders;
  const accountModelProvider = String(accountOnlyConfig.model_provider || '').trim();
  const hostHasAihProvider = String(hostConfigText || '').includes(explicitAihHeader);
  const preservedHasAihProvider = preservedHeaders.has(explicitAihHeader);
  const shouldUseAihProvider = Boolean(
    normalized.openaiBaseUrl
    || preservedHasAihProvider
    || hostHasAihProvider
    || accountModelProvider === `model_provider = "${AIH_CODEX_PROVIDER_KEY}"`
  );

  if (normalized.isApiKeyMode && normalized.openaiBaseUrl) {
    effectiveModelProviders = preservedModelProviders.filter(
      (block) => extractSectionHeader(block) !== explicitAihHeader
    );
    effectiveModelProviders.push(
      getManagedAihProviderBlock({
        openaiBaseUrl: normalized.openaiBaseUrl,
        openaiApiKey: normalized.openaiApiKey
      })
    );
    preservedHeaders.add(explicitAihHeader);
  }

  lines.push(`# Codex configuration for account ${accountId}`);
  lines.push('# This file is managed by ai-home (aih)');
  lines.push('# Synced from host config (excluding sensitive fields)');
  lines.push('');

  if (accountOnlyConfig.preferred_auth_method) {
    lines.push(accountOnlyConfig.preferred_auth_method);
  }
  if (accountOnlyConfig.model_provider) {
    lines.push(accountOnlyConfig.model_provider);
  }
  if (normalized.isApiKeyMode && !accountOnlyConfig.preferred_auth_method) {
    lines.push('preferred_auth_method = "apikey"');
  }
  if (normalized.isApiKeyMode && !accountOnlyConfig.model_provider) {
    lines.push(`model_provider = "${shouldUseAihProvider ? AIH_CODEX_PROVIDER_KEY : 'openai'}"`);
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

  const sanitizedHostConfig = stripNamedSections(hostConfigText, preservedHeaders);
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

  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

module.exports = {
  AIH_CODEX_PROVIDER_KEY,
  AIH_CODEX_PROVIDER_NAME,
  AIH_CODEX_PROVIDER_BASE_URL,
  AIH_CODEX_PROVIDER_WIRE_API,
  normalizeCodexConfigSyncOptions,
  getManagedAihProviderBlock,
  extractAccountOnlyConfig,
  filterHostConfig,
  mergeConfigs
};
