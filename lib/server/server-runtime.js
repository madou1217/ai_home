'use strict';
const { SUPPORTED_SERVER_PROVIDERS } = require('./providers');

function createProxyServerState(options, deps) {
  const {
    loadServerRuntimeAccounts,
    initProxyMetrics,
    createProviderExecutor,
    initModelRegistry,
    fs,
    aiHomeDir,
    getToolAccountIds,
    getToolConfigDir,
    getProfileDir,
    checkStatus
  } = deps;

  const runtimeAccounts = loadServerRuntimeAccounts({ fs, aiHomeDir, getToolAccountIds, getToolConfigDir, getProfileDir, checkStatus });
  const sessionAffinityTtlMs = Math.max(30_000, Number(options.sessionAffinityTtlMs) || 30 * 60 * 1000);
  const sessionAffinityMaxEntries = Math.max(100, Number(options.sessionAffinityMaxEntries) || 10_000);
  const accounts = {};
  const cursors = {};
  const sessionAffinity = {
    ttlMs: sessionAffinityTtlMs,
    maxEntries: sessionAffinityMaxEntries
  };
  const executors = {};
  SUPPORTED_SERVER_PROVIDERS.forEach((provider) => {
    accounts[provider] = Array.isArray(runtimeAccounts[provider]) ? runtimeAccounts[provider] : [];
    cursors[provider] = 0;
    sessionAffinity[provider] = new Map();
  });
  executors.codex = createProviderExecutor('codex', options.codexMaxConcurrency, options.queueLimit);
  executors.gemini = createProviderExecutor('gemini', options.geminiMaxConcurrency, options.queueLimit);
  executors.claude = createProviderExecutor('claude', options.claudeMaxConcurrency, options.queueLimit);
  return {
    strategy: options.strategy,
    cursors,
    accounts,
    startedAt: Date.now(),
    metrics: initProxyMetrics(),
    executors,
    sessionAffinity,
    modelRegistry: initModelRegistry(),
    modelsCache: {
      updatedAt: 0,
      ids: [],
      byAccount: {},
      sourceCount: 0
    }
  };
}

function printProxyServeStartup(options, state, requiredClientKey, requiredManagementKey) {
  console.log(`\x1b[36m[aih]\x1b[0m server serve started`);
  console.log(`  listen: http://${options.host}:${options.port}`);
  if (options.codexBaseUrl) {
    console.log(`  codex_base_url: ${options.codexBaseUrl}`);
  }
  if (options.geminiBaseUrl) {
    console.log(`  gemini_base_url: ${options.geminiBaseUrl}`);
  }
  if (options.claudeBaseUrl) {
    console.log(`  claude_base_url: ${options.claudeBaseUrl}`);
  }
  if (options.proxyUrl) {
    console.log(`  upstream_proxy: ${options.proxyUrl}`);
    if (options.noProxy) console.log(`  no_proxy: ${options.noProxy}`);
  } else {
    console.log('  upstream_proxy: disabled');
  }
  console.log(`  backend: ${options.backend}`);
  console.log(`  provider_mode: ${options.provider}`);
  console.log(`  strategy: ${options.strategy}`);
  const providerCountText = SUPPORTED_SERVER_PROVIDERS
    .map((provider) => `${provider}=${(state.accounts[provider] || []).length}`)
    .join(', ');
  console.log(`  accounts: ${providerCountText}`);
  if (requiredClientKey) {
    console.log('  client_auth: enabled (Bearer key required)');
  } else {
    console.log('  client_auth: disabled');
  }
  if (requiredManagementKey) {
    console.log('  management_auth: enabled (Bearer key required)');
  } else {
    console.log('  management_auth: disabled');
  }
  console.log('  management: /v0/management/status');
  console.log('  metrics: /v0/management/metrics');
  console.log('  gateway: /v1/*');
  console.log('  openai_base_url: ' + `http://${options.host}:${options.port}/v1`);
  console.log('  tip: export OPENAI_BASE_URL=' + `"http://${options.host}:${options.port}/v1"`);
  console.log('  tip: export OPENAI_API_KEY="dummy"');
}

module.exports = {
  createProxyServerState,
  printProxyServeStartup
};
