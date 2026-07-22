'use strict';

const childProcess = require('node:child_process');
const nodeFs = require('fs-extra');
const nodeOs = require('node:os');
const nodePath = require('node:path');
const { promisify } = require('node:util');
const { materializeProviderAuth } = require('../account/native-auth-projection');
const { resolveAccountRuntimeDir } = require('../runtime/aih-storage-layout');
const { resolveProviderCliPath } = require('../cli/services/ai-cli/ensure-native-cli');

const execFileAsync = promisify(childProcess.execFile);

const NATIVE_CLI_MODEL_STRATEGIES = Object.freeze({
  qoder: Object.freeze({ args: Object.freeze(['--list-models']) }),
  qodercn: Object.freeze({ args: Object.freeze(['--list-models']) })
});

function normalizeProvider(provider) {
  return String(provider || '').trim().toLowerCase();
}

function supportsNativeCliModelDiscovery(provider) {
  return Boolean(NATIVE_CLI_MODEL_STRATEGIES[normalizeProvider(provider)]);
}

function parseNativeCliModelList(outputRaw) {
  return Array.from(new Set(String(outputRaw || '')
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
  const result = await execFile(cliPath, [...strategy.args, '--config-dir', runtimeDir], {
    timeout: Math.max(1, Number(timeoutMs) || 8000),
    windowsHide: true,
    shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(cliPath)
  });
  return parseNativeCliModelList(result && result.stdout);
}

module.exports = {
  discoverNativeCliModels,
  parseNativeCliModelList,
  supportsNativeCliModelDiscovery
};
