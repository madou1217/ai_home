'use strict';

const childProcess = require('node:child_process');
const nodeFs = require('fs-extra');
const nodeOs = require('node:os');
const nodePath = require('node:path');
const { promisify } = require('node:util');
const { materializeProviderAuth } = require('../account/native-auth-projection');
const { resolveAccountRuntimeDir } = require('../runtime/aih-storage-layout');
const { resolveProviderCliPath } = require('../cli/services/ai-cli/ensure-native-cli');
const { buildSharedCacheEnv } = require('../cli/services/ai-cli/launch-profile/home-redirect-strategy');

const execFileAsync = promisify(childProcess.execFile);

const NATIVE_CLI_MODEL_STRATEGIES = Object.freeze({
  qoder: Object.freeze({ args: Object.freeze(['--list-models']), configDirFlag: '--config-dir', minTimeoutMs: 20000 }),
  qodercn: Object.freeze({ args: Object.freeze(['--list-models']), configDirFlag: '--config-dir', minTimeoutMs: 20000 }),
  grok: Object.freeze({ args: Object.freeze(['models']), minTimeoutMs: 20000, format: 'grok-lines' }),
  kiro: Object.freeze({
    args: Object.freeze(['chat', '--list-models', '--format', 'json']),
    minTimeoutMs: 60000,
    format: 'kiro-json'
  })
});

function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

function supportsNativeCliModelDiscovery(provider) {
  return Boolean(NATIVE_CLI_MODEL_STRATEGIES[normalizeProvider(provider)]);
}

function parseNativeCliModelList(outputRaw, format = 'lines') {
  const output = String(outputRaw || '');
  if (format === 'kiro-json') {
    const parsed = JSON.parse(output);
    return Array.from(new Set((Array.isArray(parsed && parsed.models) ? parsed.models : [])
      .map((model) => String(model && (model.model_id || model.model_name) || '').trim())
      .filter(Boolean)));
  }
  if (format === 'grok-lines') {
    return Array.from(new Set(output
      .split(/\r?\n/)
      .map((line) => {
        const match = line.match(/^\s*\*\s+([^\s(]+)(?:\s+\([^)]*\))?\s*$/);
        return match ? match[1].trim() : '';
      })
      .filter(Boolean)));
  }
  return Array.from(new Set(output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && line.toUpperCase() !== 'MODEL')));
}

async function discoverNativeCliModels(options = {}, account = {}, timeoutMs = 8000) {
  const provider = normalizeProvider(account.provider);
  const strategy = NATIVE_CLI_MODEL_STRATEGIES[provider];
  if (!strategy) return null;
  const accountRef = String(account.accountRef || '').trim();
  if (!accountRef) throw new Error('native_cli_model_discovery_missing_account_ref');

  const fs = options.fs || nodeFs;
  const path = options.path || nodePath;
  const aiHomeDir = String(options.aiHomeDir || path.join(nodeOs.homedir(), '.ai_home')).trim();
  const runtimeDir = resolveAccountRuntimeDir(aiHomeDir, provider, accountRef);
  const materialized = materializeProviderAuth(fs, runtimeDir, provider, {
    path,
    aiHomeDir,
    accountRef
  });
  if (materialized.missing) throw new Error('native_cli_model_discovery_missing_auth');

  const cliPath = String((options.resolveProviderCliPath || resolveProviderCliPath)(provider) || '').trim();
  if (!cliPath) throw new Error('native_cli_model_discovery_cli_not_found');
  const execFile = options.execFile || execFileAsync;
  const hostHomeDir = String(options.hostHomeDir || path.dirname(aiHomeDir)).trim();
  const runtimeEnv = {
    ...(options.env || process.env),
    HOME: hostHomeDir,
    USERPROFILE: hostHomeDir,
    ...buildSharedCacheEnv(hostHomeDir, path),
    AIH_QODER_PROVIDER: provider
  };
  const proxyUrl = String(options.proxyUrl || '').trim();
  const noProxy = String(options.noProxy || '').trim();
  if (proxyUrl) {
    runtimeEnv.HTTP_PROXY = proxyUrl;
    runtimeEnv.HTTPS_PROXY = proxyUrl;
    runtimeEnv.http_proxy = proxyUrl;
    runtimeEnv.https_proxy = proxyUrl;
  }
  if (noProxy) {
    runtimeEnv.NO_PROXY = noProxy;
    runtimeEnv.no_proxy = noProxy;
  }
  if (provider === 'grok') {
    runtimeEnv.GROK_HOME = path.join(runtimeDir, '.grok');
    delete runtimeEnv.XAI_API_KEY;
  }
  if (provider === 'kiro') {
    runtimeEnv.KIRO_HOME = path.join(runtimeDir, '.kiro');
    runtimeEnv.KIRO_TEST_DB_PATH = path.join(runtimeDir, 'data.sqlite3');
    delete runtimeEnv.KIRO_API_KEY;
  }
  if (account.apiKeyMode && account.accessToken) {
    runtimeEnv.QODER_PERSONAL_ACCESS_TOKEN = account.accessToken;
  } else {
    delete runtimeEnv.QODER_PERSONAL_ACCESS_TOKEN;
  }
  const cliArgs = [...strategy.args];
  if (strategy.configDirFlag) cliArgs.push(strategy.configDirFlag, runtimeDir);
  const result = await execFile(cliPath, cliArgs, {
    timeout: Math.max(strategy.minTimeoutMs || 1, Number(timeoutMs) || 8000),
    windowsHide: true,
    shell: (options.platform || process.platform) === 'win32' && /\.(?:cmd|bat)$/i.test(cliPath),
    env: runtimeEnv
  });
  return parseNativeCliModelList(result && result.stdout, strategy.format);
}

module.exports = {
  discoverNativeCliModels,
  parseNativeCliModelList,
  supportsNativeCliModelDiscovery
};
