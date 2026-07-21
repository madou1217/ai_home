'use strict';

const nodePath = require('path');
const {
  AIH_CODEX_PROVIDER_BASE_URL,
  getAihProviderKey,
  getManagedAihProviderBlock,
  hoistModelProviderSections
} = require('../cli/services/pty/codex-config-sync');
const { enableCodexHooksFeatureFlag } = require('../cli/config/codex-feature-flags');
const {
  createManagedCodexStopHookGroup,
  hasManagedCodexStopHook,
  normalizeManagedCodexStopHooks
} = require('../server/codex-stop-hook-config');
const { buildServerBaseUrl } = require('../server/server-defaults');
const { readAccountCredentialRecord } = require('../server/account-credential-store');

function createHostConfigSyncer(deps) {
  const {
    fs,
    fse,
    ensureDir,
    aiHomeDir,
    hostHomeDir,
    cliConfigs,
    codexVersion,
    enableCodexStopHook,
    readServerConfig,
    path: pathImpl = nodePath,
    processObj = process
  } = deps;
  const path = pathImpl;
  const codexStopHookScriptName = 'aih-stop-notify.js';

  function isEnabledEnvValue(value) {
    return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
  }

  function shouldInstallCodexStopHook() {
    if (enableCodexStopHook === true) return true;
    const env = processObj.env || {};
    return isEnabledEnvValue(env.AIH_CODEX_ENABLE_STOP_NOTIFY_HOOK)
      || isEnabledEnvValue(env.AIH_CODEX_STOP_NOTIFY_HOOK);
  }

  function removeManagedCodexStopHook(hooksConfig) {
    if (!hooksConfig || typeof hooksConfig !== 'object') return false;
    if (!hooksConfig.hooks || typeof hooksConfig.hooks !== 'object') return false;
    const stopHooks = Array.isArray(hooksConfig.hooks.Stop) ? hooksConfig.hooks.Stop : [];
    let changed = false;
    const nextStopHooks = [];

    stopHooks.forEach((group) => {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) {
        nextStopHooks.push(group);
        return;
      }
      const nextHooks = group.hooks.filter((hook) => {
        const isManaged = String(hook && hook.command || '').includes(codexStopHookScriptName);
        if (isManaged) changed = true;
        return !isManaged;
      });
      if (nextHooks.length > 0) {
        nextStopHooks.push({ ...group, hooks: nextHooks });
      } else if (group.hooks.length > 0) {
        changed = true;
      }
    });

    if (!changed) return false;
    if (nextStopHooks.length > 0) {
      hooksConfig.hooks.Stop = nextStopHooks;
    } else {
      delete hooksConfig.hooks.Stop;
    }
    return true;
  }

  function pruneBackupFiles(filePaths, keep = 3) {
    const sorted = (filePaths || [])
      .filter((p) => fs.existsSync(p))
      .map((p) => {
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(p).mtimeMs || 0;
        } catch (e) {}
        return { path: p, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    if (sorted.length <= keep) return 0;
    const toDelete = sorted.slice(keep);
    let deleted = 0;
    toDelete.forEach((entry) => {
      try {
        fs.unlinkSync(entry.path);
        deleted += 1;
      } catch (e) {}
    });
    return deleted;
  }

  function backupHostGlobalConfig(cliName, hostGlobalDir, maxBackups = 3) {
    const backupFileByCli = {
      codex: 'auth.json',
      claude: '.credentials.json',
      gemini: 'google_accounts.json'
    };
    const baseName = backupFileByCli[cliName];
    if (!baseName) return { created: false };

    const target = path.join(hostGlobalDir, baseName);
    if (!fs.existsSync(target)) return { created: false };

    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const backupPath = path.join(hostGlobalDir, `${baseName}.aih.bak.${stamp}`);
    fse.copySync(target, backupPath, { overwrite: true, errorOnExist: false });

    let removed = 0;
    try {
      const names = fs.readdirSync(hostGlobalDir);
      const backupCandidates = names
        .filter((n) => n.startsWith(`${baseName}.aih.bak.`) || n.startsWith(`${baseName}.bak.`))
        .map((n) => path.join(hostGlobalDir, n));
      removed = pruneBackupFiles(backupCandidates, maxBackups);
    } catch (e) {}

    return { created: true, backupPath, removed };
  }

  function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function replaceTomlSection(content, header, block) {
    const blockRegex = new RegExp(`${escapeRegExp(header)}[\\s\\S]*?(?=\\n\\[|$)`);
    if (blockRegex.test(content)) {
      return content.replace(blockRegex, block);
    }
    return `${content.trimEnd()}${content.trim() ? '\n\n' : ''}${block}\n`;
  }

  function readCodexApiKeyBaseUrl(credentialRecord) {
    const credentials = credentialRecord && credentialRecord.env || {};
    return String(credentials.OPENAI_BASE_URL || '').trim();
  }

  function readCodexApiKeyToken(credentialRecord) {
    const credentials = credentialRecord && credentialRecord.env || {};
    return String(credentials.OPENAI_API_KEY || '').trim();
  }

  function normalizeBaseUrlForCompare(baseUrl) {
    return String(baseUrl || '').trim().replace(/\/+$/, '');
  }

  function resolveDefaultAihProviderBaseUrl() {
    if (typeof readServerConfig !== 'function') return AIH_CODEX_PROVIDER_BASE_URL;
    try {
      return buildServerBaseUrl(readServerConfig() || {});
    } catch (_error) {
      return AIH_CODEX_PROVIDER_BASE_URL;
    }
  }

  function shouldUseDummyBearerToken(openaiBaseUrl) {
    const defaultBaseUrl = resolveDefaultAihProviderBaseUrl();
    const normalizedBaseUrl = normalizeBaseUrlForCompare(openaiBaseUrl || defaultBaseUrl);
    return !normalizedBaseUrl || normalizedBaseUrl === normalizeBaseUrlForCompare(defaultBaseUrl);
  }

  function patchCodexConfigToml(hostGlobalDir, apiKeyMode, openaiBaseUrl = '', openaiApiKey = '') {
    const configPath = path.join(hostGlobalDir, 'config.toml');
    let content = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
    const providerKey = getAihProviderKey();
    const currentProviderHeader = `[model_providers.${providerKey}]`;

    content = enableCodexHooksFeatureFlag(content, { codexVersion }).content;

    if (/^model_provider\s*=/m.test(content)) {
      content = content.replace(/^model_provider\s*=.*$/m, `model_provider = "${apiKeyMode ? providerKey : 'openai'}"`);
    } else {
      content = `model_provider = "${apiKeyMode ? providerKey : 'openai'}"\n` + content;
    }

    if (/^preferred_auth_method\s*=/m.test(content)) {
      content = content.replace(/^preferred_auth_method\s*=.*$/m, `preferred_auth_method = "${apiKeyMode ? 'apikey' : 'oauth'}"`);
    } else {
      content = `preferred_auth_method = "${apiKeyMode ? 'apikey' : 'oauth'}"\n` + content;
    }

    if (apiKeyMode) {
      const defaultBaseUrl = resolveDefaultAihProviderBaseUrl();
      const useDummyBearerToken = shouldUseDummyBearerToken(openaiBaseUrl);
      const providerBlock = getManagedAihProviderBlock({
        openaiBaseUrl: openaiBaseUrl || defaultBaseUrl,
        openaiApiKey: useDummyBearerToken ? '' : openaiApiKey
      });
      content = replaceTomlSection(content, currentProviderHeader, providerBlock);
    }

    fs.writeFileSync(configPath, hoistModelProviderSections(content));
  }

  function ensureCodexStopHook(hostGlobalDir) {
    if (processObj.platform === 'win32') {
      return { updated: false, reason: 'windows_hooks_disabled' };
    }

    const hooksDir = path.join(hostGlobalDir, 'hooks');
    const hookScriptPath = path.join(hooksDir, codexStopHookScriptName);
    const hooksJsonPath = path.join(hostGlobalDir, 'hooks.json');
    ensureDir(hooksDir);

    let hooksConfig = {};
    try {
      hooksConfig = fs.existsSync(hooksJsonPath)
        ? JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'))
        : {};
    } catch (_error) {
      hooksConfig = {};
    }

    if (!hooksConfig || typeof hooksConfig !== 'object') hooksConfig = {};
    if (!hooksConfig.hooks || typeof hooksConfig.hooks !== 'object') hooksConfig.hooks = {};

    if (!shouldInstallCodexStopHook()) {
      const removed = removeManagedCodexStopHook(hooksConfig);
      if (removed) {
        fs.writeFileSync(hooksJsonPath, JSON.stringify(hooksConfig, null, 2) + '\n', 'utf8');
      }
      return { updated: removed, hookScriptPath, hooksJsonPath, reason: 'stop_hook_disabled' };
    }

    const scriptContent = `#!/usr/bin/env node
'use strict';
const { spawnSync } = require('node:child_process');

function readPayload() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch (_error) {
        resolve({});
      }
    });
    process.stdin.resume();
  });
}

function trySpawn(command, args) {
  try {
    const result = spawnSync(command, args, { stdio: 'ignore' });
    return result.status === 0;
  } catch (_error) {
    return false;
  }
}

function notify() {
  if (process.platform === 'darwin') {
    if (trySpawn('osascript', ['-e', 'beep 1'])) return;
  } else if (process.platform === 'linux') {
    if (trySpawn('sh', ['-lc', 'command -v canberra-gtk-play >/dev/null 2>&1 && canberra-gtk-play -i complete'])) return;
    if (trySpawn('sh', ['-lc', 'command -v paplay >/dev/null 2>&1 && paplay /usr/share/sounds/freedesktop/stereo/complete.oga'])) return;
  }
}

(async () => {
  const payload = await readPayload();
  if (!String(payload.last_assistant_message || '').trim()) process.exit(0);
  notify();
  process.exit(0);
})();
`;

    fs.writeFileSync(hookScriptPath, scriptContent, 'utf8');
    try {
      fs.chmodSync(hookScriptPath, 0o755);
    } catch (_error) {}
    const stopHooks = Array.isArray(hooksConfig.hooks.Stop) ? hooksConfig.hooks.Stop : [];
    const commandValue = `/usr/bin/env node "${hookScriptPath}"`;
    const normalized = normalizeManagedCodexStopHooks(stopHooks, codexStopHookScriptName);
    const effectiveStopHooks = normalized.hooks;
    const hasExisting = hasManagedCodexStopHook(stopHooks, codexStopHookScriptName);

    if (!hasExisting) {
      effectiveStopHooks.push(createManagedCodexStopHookGroup(commandValue));
      hooksConfig.hooks.Stop = effectiveStopHooks;
      fs.writeFileSync(hooksJsonPath, JSON.stringify(hooksConfig, null, 2) + '\n', 'utf8');
      return { updated: true, hookScriptPath, hooksJsonPath };
    }

    if (normalized.changed) {
      hooksConfig.hooks.Stop = effectiveStopHooks;
      fs.writeFileSync(hooksJsonPath, JSON.stringify(hooksConfig, null, 2) + '\n', 'utf8');
      return { updated: true, hookScriptPath, hooksJsonPath, reason: 'normalized_existing' };
    }

    return { updated: false, hookScriptPath, hooksJsonPath, reason: 'already_present' };
  }

  function writePrivateFile(filePath, content) {
    ensureDir(path.dirname(filePath));
    try {
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink()) fs.unlinkSync(filePath);
    } catch (_error) {}

    const tempPath = `${filePath}.aih-tmp-${processObj.pid || process.pid}-${Date.now()}`;
    let renamed = false;
    try {
      fs.writeFileSync(tempPath, String(content || ''), 'utf8');
      if (typeof fs.chmodSync === 'function') {
        try { fs.chmodSync(tempPath, 0o600); } catch (_chmodError) {}
      }
      try {
        fs.renameSync(tempPath, filePath);
      } catch (error) {
        if (!error || !['EEXIST', 'EPERM'].includes(error.code)) throw error;
        fs.unlinkSync(filePath);
        fs.renameSync(tempPath, filePath);
      }
      renamed = true;
    } finally {
      if (!renamed) {
        try { fs.unlinkSync(tempPath); } catch (_cleanupError) {}
      }
    }
  }

  function writePrivateJson(filePath, value) {
    writePrivateFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  function syncNativeAuthToHost(cliName, record, hostGlobalDir) {
    const nativeAuth = record && record.nativeAuth || {};
    if (cliName === 'codex' && nativeAuth.auth) {
      const backup = backupHostGlobalConfig('codex', hostGlobalDir, 3);
      writePrivateJson(path.join(hostGlobalDir, 'auth.json'), nativeAuth.auth);
      return { updated: true, file: 'auth.json', backup };
    }
    if (cliName === 'claude' && nativeAuth.credentials) {
      const backup = backupHostGlobalConfig('claude', hostGlobalDir, 3);
      writePrivateJson(path.join(hostGlobalDir, '.credentials.json'), nativeAuth.credentials);
      return { updated: true, file: '.credentials.json', backup };
    }
    if (cliName === 'gemini' && nativeAuth.oauthCreds) {
      const backup = backupHostGlobalConfig('gemini', hostGlobalDir, 3);
      writePrivateJson(path.join(hostGlobalDir, 'oauth_creds.json'), nativeAuth.oauthCreds);
      if (nativeAuth.googleAccounts) {
        writePrivateJson(path.join(hostGlobalDir, 'google_accounts.json'), nativeAuth.googleAccounts);
      }
      return { updated: true, file: 'oauth_creds.json', backup };
    }
    if (cliName === 'agy' && nativeAuth.oauthToken) {
      const authDir = path.join(hostHomeDir, '.gemini', 'antigravity-cli');
      writePrivateJson(path.join(authDir, 'antigravity-oauth-token'), nativeAuth.oauthToken);
      if (nativeAuth.email) {
        writePrivateFile(path.join(authDir, 'email.cache'), String(nativeAuth.email));
      }
      return { updated: true, file: 'antigravity-oauth-token' };
    }
    if (cliName === 'opencode' && nativeAuth.auth) {
      const authPath = path.join(hostHomeDir, '.local', 'share', 'opencode', 'auth.json');
      writePrivateJson(authPath, nativeAuth.auth);
      return { updated: true, file: authPath };
    }
    return { updated: false, reason: 'missing-native-auth' };
  }

  return function syncGlobalConfigToHost(cliName, accountRef) {
    const cfg = cliConfigs[cliName];
    if (!cfg || !cfg.globalDir) {
      return { ok: false, reason: 'unsupported-cli' };
    }

    const credentialRecord = readAccountCredentialRecord(fs, aiHomeDir, accountRef);
    if (!credentialRecord || credentialRecord.provider !== cliName) {
      return { ok: false, reason: 'unknown-account-ref' };
    }

    const hostGlobalDir = path.join(hostHomeDir, cfg.globalDir);
    ensureDir(hostGlobalDir);
    const authSync = syncNativeAuthToHost(cliName, credentialRecord, hostGlobalDir);

    if (cliName === 'codex') {
      try {
        const openaiBaseUrl = readCodexApiKeyBaseUrl(credentialRecord);
        const openaiApiKey = readCodexApiKeyToken(credentialRecord);
        const apiKeyMode = Boolean(openaiApiKey);
        patchCodexConfigToml(hostGlobalDir, apiKeyMode, openaiBaseUrl, openaiApiKey);
      } catch (e) {}
    }

    const codexHook = cliName === 'codex'
      ? ensureCodexStopHook(hostGlobalDir)
      : null;

    if (cliName !== 'codex' && !authSync.updated) {
      return {
        ok: false,
        reason: authSync.reason || 'missing-auth-file',
        hostGlobalDir,
        codexHook
      };
    }
    return { ok: true, hostGlobalDir, backup: authSync.backup, authSync, codexHook };
  };
}

module.exports = {
  createHostConfigSyncer
};
