'use strict';

const DEFAULT_CODEX_API_BASE_URL = 'https://api.openai.com/v1';
const AIH_CODEX_PROVIDER_KEY = 'aih_server';

function buildCodexProviderArgs(env = {}, options = {}) {
  const apiKey = String(env.OPENAI_API_KEY || '').trim();
  const configuredBaseUrl = String(env.OPENAI_BASE_URL || '').trim();
  if (!apiKey && !configuredBaseUrl && options.force !== true) return [];

  const providerKey = String(options.providerKey || AIH_CODEX_PROVIDER_KEY).trim();
  const baseUrl = configuredBaseUrl || DEFAULT_CODEX_API_BASE_URL;
  const args = [
    '-c suppress_unstable_features_warning=true',
    `-c model_provider=${providerKey}`,
    `-c model_providers.${providerKey}.base_url=${baseUrl}`,
    `-c model_providers.${providerKey}.wire_api=responses`
  ];
  if (apiKey) {
    args.push(`-c model_providers.${providerKey}.env_key=OPENAI_API_KEY`);
  }
  return args;
}

module.exports = {
  AIH_CODEX_PROVIDER_KEY,
  buildCodexProviderArgs
};
