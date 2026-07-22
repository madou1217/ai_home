'use strict';

const { AIH_CODEX_PROVIDER_NAME } = require('../pty/codex-config-sync');

const DEFAULT_CODEX_API_BASE_URL = 'https://api.openai.com/v1';
const AIH_CODEX_PROVIDER_KEY = 'aih_server';
const CONFIG_SCOPED_SUBCOMMANDS = new Set(['exec', 'resume', 'app-server']);

function buildCodexProviderArgs(env = {}, options = {}) {
  const apiKey = String(env.OPENAI_API_KEY || '').trim();
  const configuredBaseUrl = String(env.OPENAI_BASE_URL || '').trim();
  if (!apiKey && !configuredBaseUrl && options.force !== true) return [];

  const providerKey = String(options.providerKey || AIH_CODEX_PROVIDER_KEY).trim();
  const baseUrl = configuredBaseUrl || DEFAULT_CODEX_API_BASE_URL;
  const configValues = [
    'suppress_unstable_features_warning=true',
    `model_provider=${providerKey}`,
    `model_providers.${providerKey}.name="${AIH_CODEX_PROVIDER_NAME}"`,
    `model_providers.${providerKey}.base_url=${baseUrl}`,
    `model_providers.${providerKey}.wire_api=responses`
  ];
  if (apiKey) {
    configValues.push(`model_providers.${providerKey}.env_key=OPENAI_API_KEY`);
  }
  return configValues.flatMap((value) => ['-c', value]);
}

function hasCodexModelProviderArg(args = []) {
  return args.some((arg, index) => {
    const value = String(arg || '').trim();
    if (/^--config=model_provider\s*=/.test(value)) return true;
    return (value === '-c' || value === '--config')
      && /^model_provider\s*=/.test(String(args[index + 1] || '').trim());
  });
}

function injectCodexProviderArgs(args = [], providerArgs = []) {
  const result = Array.isArray(args) ? [...args] : [];
  const overrides = Array.isArray(providerArgs) ? providerArgs.filter((arg) => arg != null) : [];
  if (!overrides.length) return result;
  // 三个调用点都在追加 global flags 前注入；只认首 token，避免把 option value 或 prompt
  // 中恰好出现的 exec/resume/app-server 误判为子命令。
  if (!CONFIG_SCOPED_SUBCOMMANDS.has(String(result[0] || '').trim())) {
    return [...overrides, ...result];
  }
  result.splice(1, 0, ...overrides);
  return result;
}

module.exports = {
  AIH_CODEX_PROVIDER_KEY,
  buildCodexProviderArgs,
  hasCodexModelProviderArg,
  injectCodexProviderArgs
};
