'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isAccountRef } = require('../../../account/public-account-ref');
const { buildAihServerRootUrl } = require('../../../account/self-relay-account');

const CLAUDE_DESKTOP_MODES = Object.freeze(['web', 'api']);
const CONFIG_LIBRARY_DIR = 'configLibrary';
const CONFIG_LIBRARY_META_FILE = '_meta.json';
const DESKTOP_CONFIG_FILE = 'claude_desktop_config.json';
const DEVELOPER_SETTINGS_FILE = 'developer_settings.json';
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const CONFIG_ID_RE = /^[a-f0-9-]{36}$/;
const CONFIG_NAMES = Object.freeze({
  api: 'ai-home API',
  web: 'ai-home Web'
});
const AIH_GATEWAY_FALLBACK_MODELS = Object.freeze([
  Object.freeze({
    name: 'claude-sonnet-4-6',
    anthropicFamilyTier: 'sonnet',
    isFamilyDefault: true
  }),
  Object.freeze({
    name: 'claude-opus-4-8',
    anthropicFamilyTier: 'opus',
    isFamilyDefault: true
  })
]);

function failure(reason) {
  return { ok: false, status: 'failed', reason };
}

function readJsonObject(fsImpl, filePath, fallback) {
  if (!fsImpl.existsSync(filePath)) return fallback;
  const parsed = JSON.parse(fsImpl.readFileSync(filePath, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('json_object_required');
  }
  return parsed;
}

function writePrivateJson(fsImpl, filePath, value) {
  fsImpl.mkdirSync(path.dirname(filePath), { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const tempPath = `${filePath}.aih-tmp-${process.pid}-${crypto.randomUUID()}`;
  let renamed = false;
  try {
    fsImpl.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: PRIVATE_FILE_MODE,
      flag: 'wx'
    });
    if (typeof fsImpl.chmodSync === 'function') fsImpl.chmodSync(tempPath, PRIVATE_FILE_MODE);
    fsImpl.renameSync(tempPath, filePath);
    renamed = true;
  } finally {
    if (!renamed && typeof fsImpl.rmSync === 'function') {
      try { fsImpl.rmSync(tempPath, { force: true }); } catch (_error) {}
    }
  }
}

function validateProfileScope(profileDir, accountRef) {
  const normalizedProfile = path.resolve(String(profileDir || ''));
  const normalizedRef = String(accountRef || '').trim();
  return Boolean(
    isAccountRef(normalizedRef)
    && path.basename(normalizedProfile) === normalizedRef
    && path.basename(path.dirname(normalizedProfile)) === 'claude'
    && path.basename(path.dirname(path.dirname(normalizedProfile))) === 'desktop-clients'
  );
}

function readConfigLibraryMeta(fsImpl, metaPath) {
  const meta = readJsonObject(fsImpl, metaPath, { appliedId: '', entries: [] });
  if (!Array.isArray(meta.entries)) throw new Error('config_library_entries_invalid');
  const entries = meta.entries.map((entry) => {
    const id = String(entry && entry.id || '').trim();
    const name = String(entry && entry.name || '').trim();
    if (!CONFIG_ID_RE.test(id) || !name) throw new Error('config_library_entry_invalid');
    return { ...entry, id, name };
  });
  return { ...meta, entries };
}

function resolveConfigEntry(meta, mode) {
  const name = CONFIG_NAMES[mode];
  const existing = meta.entries.find((entry) => entry.name === name);
  if (existing) return existing;
  return { id: crypto.randomUUID(), name };
}

function buildApiConfig(serverConfig, credentialHelperPath) {
  return {
    inferenceProvider: 'gateway',
    inferenceCredentialKind: 'helper-script',
    inferenceGatewayBaseUrl: buildAihServerRootUrl(serverConfig),
    inferenceGatewayAuthScheme: 'bearer',
    inferenceCredentialHelper: credentialHelperPath,
    modelDiscoveryEnabled: true,
    inferenceModels: AIH_GATEWAY_FALLBACK_MODELS.map((model) => ({ ...model }))
  };
}

function resolveDefaultCredentialHelperPath() {
  return path.resolve(__dirname, '../../../../bin/claude-desktop-credential.js');
}

function configureClaudeDesktopMode(options = {}) {
  const fsImpl = options.fs || fs;
  const mode = String(options.mode || '').trim().toLowerCase();
  const profileDir = String(options.profileDir || '').trim();
  const accountRef = String(options.accountRef || '').trim();
  if (!CLAUDE_DESKTOP_MODES.includes(mode)) return failure('invalid_desktop_mode');
  if (!validateProfileScope(profileDir, accountRef)) return failure('invalid_account_scope');

  const credentialHelperPath = path.resolve(
    String(options.credentialHelperPath || resolveDefaultCredentialHelperPath())
  );
  if (mode === 'api' && !fsImpl.existsSync(credentialHelperPath)) {
    return failure('credential_helper_missing');
  }

  try {
    fsImpl.mkdirSync(profileDir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    if (typeof fsImpl.chmodSync === 'function') fsImpl.chmodSync(profileDir, PRIVATE_DIRECTORY_MODE);

    const libraryDir = path.join(profileDir, CONFIG_LIBRARY_DIR);
    const metaPath = path.join(libraryDir, CONFIG_LIBRARY_META_FILE);
    const meta = readConfigLibraryMeta(fsImpl, metaPath);
    const entry = resolveConfigEntry(meta, mode);
    const nextEntries = meta.entries.some((item) => item.id === entry.id)
      ? meta.entries
      : [...meta.entries, entry];
    const config = mode === 'api'
      ? buildApiConfig(options.serverConfig || {}, credentialHelperPath)
      : {};

    writePrivateJson(fsImpl, path.join(libraryDir, `${entry.id}.json`), config);
    writePrivateJson(fsImpl, metaPath, {
      ...meta,
      appliedId: entry.id,
      entries: nextEntries
    });

    if (mode === 'api') {
      const developerSettingsPath = path.join(profileDir, DEVELOPER_SETTINGS_FILE);
      const developerSettings = readJsonObject(fsImpl, developerSettingsPath, {});
      developerSettings.allowDevTools = true;
      writePrivateJson(fsImpl, developerSettingsPath, developerSettings);
    }

    // deploymentMode is the activation switch. Write it last so a failed
    // supporting-file update never leaves Claude starting in a partial mode.
    const desktopConfigPath = path.join(profileDir, DESKTOP_CONFIG_FILE);
    const desktopConfig = readJsonObject(fsImpl, desktopConfigPath, {});
    desktopConfig.deploymentMode = mode === 'api' ? '3p' : '1p';
    delete desktopConfig.awaitingSignIn;
    writePrivateJson(fsImpl, desktopConfigPath, desktopConfig);

    return {
      ok: true,
      status: mode === 'api' ? 'api_configured' : 'web_configured',
      mode,
      profileDir,
      configId: entry.id,
      gatewayBaseUrl: mode === 'api' ? config.inferenceGatewayBaseUrl : ''
    };
  } catch (error) {
    return failure(String(error && error.message || 'desktop_mode_configuration_failed'));
  }
}

module.exports = {
  AIH_GATEWAY_FALLBACK_MODELS,
  CLAUDE_DESKTOP_MODES,
  configureClaudeDesktopMode,
  resolveDefaultCredentialHelperPath,
  validateProfileScope
};
