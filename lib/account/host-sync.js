'use strict';

const path = require('path');
const { collectSharedToolEntryNames } = require('../cli/services/session-store');
const {
  AIH_CODEX_PROVIDER_BASE_URL,
  getAihProviderKey,
  getManagedAihProviderBlock,
  hoistModelProviderSections
} = require('../cli/services/pty/codex-config-sync');
const { enableCodexHooksFeatureFlag } = require('../cli/config/codex-feature-flags');
const { buildServerBaseUrl } = require('../server/server-defaults');

function createHostConfigSyncer(deps) {
  const {
    fs,
    fse,
    ensureDir,
    getProfileDir,
    hostHomeDir,
    cliConfigs,
    codexVersion,
    enableCodexStopHook,
    readServerConfig,
    processObj = process
  } = deps;
  const isolatedAuthFileByCli = {
    codex: 'auth.json',
    claude: '.credentials.json',
    gemini: 'google_accounts.json'
  };
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

  function createSymlinkSafe(targetPath, linkPath, isDir) {
    try {
      if (fs.existsSync(linkPath)) return false;
      if (process.platform === 'win32') {
        fs.symlinkSync(targetPath, linkPath, isDir ? 'junction' : 'file');
      } else {
        fs.symlinkSync(targetPath, linkPath, isDir ? 'dir' : 'file');
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  function normalizeSharedEntries(cliName, accountGlobalDir, hostGlobalDir) {
    const sharedEntries = collectSharedToolEntryNames(fs, cliName, [
      accountGlobalDir,
      hostGlobalDir
    ]);
    ensureDir(hostGlobalDir);
    let removed = 0;
    let linked = 0;

    sharedEntries.forEach((entryName) => {
      const accountPath = path.join(accountGlobalDir, entryName);
      const hostPath = path.join(hostGlobalDir, entryName);
      if (fs.existsSync(accountPath)) {
        try {
          const st = fs.lstatSync(accountPath);
          if (st.isSymbolicLink()) {
            const real = path.resolve(path.dirname(accountPath), fs.readlinkSync(accountPath));
            if (path.resolve(real) === path.resolve(hostPath)) {
              linked += 1;
              return;
            }
            fs.unlinkSync(accountPath);
            removed += 1;
          } else {
            fse.removeSync(accountPath);
            removed += 1;
          }
        } catch (e) {
          return;
        }
      }
      if (fs.existsSync(hostPath)) {
        let isDir = false;
        try {
          isDir = fs.lstatSync(hostPath).isDirectory();
        } catch (e) {
          return;
        }
        if (createSymlinkSafe(hostPath, accountPath, isDir)) linked += 1;
      }
    });

    return { removed, linked };
  }

  function syncIsolatedAuthFile(cliName, accountGlobalDir, hostGlobalDir) {
    const authFileName = isolatedAuthFileByCli[cliName];
    if (!authFileName) return { updated: false, reason: 'unsupported-cli' };

    const srcPath = path.join(accountGlobalDir, authFileName);
    const dstPath = path.join(hostGlobalDir, authFileName);
    if (!fs.existsSync(srcPath)) {
      return { updated: false, reason: 'missing-auth-file', file: authFileName };
    }

    const backup = backupHostGlobalConfig(cliName, hostGlobalDir, 3);
    fse.copySync(srcPath, dstPath, { overwrite: true, errorOnExist: false });
    return { updated: true, file: authFileName, backup };
  }

  function syncIndependentCodexHostAuthFile(accountGlobalDir, hostGlobalDir) {
    const authFileName = isolatedAuthFileByCli.codex;
    const srcPath = path.join(accountGlobalDir, authFileName);
    const dstPath = path.join(hostGlobalDir, authFileName);
    if (!fs.existsSync(srcPath)) {
      return { updated: false, reason: 'missing-auth-file', file: authFileName };
    }

    const backup = backupHostGlobalConfig('codex', hostGlobalDir, 3);
    let stat = null;
    try {
      stat = fs.lstatSync(dstPath);
    } catch (_error) {
      stat = null;
    }
    if (stat && stat.isSymbolicLink()) {
      try {
        fs.unlinkSync(dstPath);
      } catch (_error) {
        return { updated: false, reason: 'unlink-host-auth-link-failed', file: authFileName };
      }
    }

    try {
      fse.copySync(srcPath, dstPath, { overwrite: true, errorOnExist: false });
      if (typeof fs.chmodSync === 'function') {
        try { fs.chmodSync(dstPath, 0o600); } catch (_chmodError) {}
      }
      return { updated: true, reason: 'copied-codex-auth-snapshot', file: authFileName, backup };
    } catch (error) {
      return {
        updated: false,
        reason: 'copy-codex-auth-failed',
        file: authFileName,
        backup,
        error: String((error && error.message) || error || 'copy_failed')
      };
    }
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

  function readCodexApiKeyBaseUrl(accountProfileDir, accountGlobalDir) {
    const envPath = path.join(accountProfileDir, '.aih_env.json');
    if (fs.existsSync(envPath)) {
      try {
        const envData = JSON.parse(fs.readFileSync(envPath, 'utf8'));
        const envBaseUrl = String(envData && envData.OPENAI_BASE_URL || '').trim();
        if (envBaseUrl) return envBaseUrl;
      } catch (e) {}
    }

    const accountConfigPath = path.join(accountGlobalDir, 'config.toml');
    if (fs.existsSync(accountConfigPath)) {
      try {
        const configText = fs.readFileSync(accountConfigPath, 'utf8');
        const match = configText.match(/^openai_base_url\s*=\s*"([^"]+)"\s*$/m);
        if (match && String(match[1] || '').trim()) {
          return String(match[1] || '').trim();
        }
      } catch (e) {}
    }

    return '';
  }

  function readCodexApiKeyToken(accountProfileDir, accountGlobalDir) {
    const envPath = path.join(accountProfileDir, '.aih_env.json');
    if (fs.existsSync(envPath)) {
      try {
        const envData = JSON.parse(fs.readFileSync(envPath, 'utf8'));
        const envApiKey = String(envData && envData.OPENAI_API_KEY || '').trim();
        if (envApiKey) return envApiKey;
      } catch (e) {}
    }

    const authPath = path.join(accountGlobalDir, 'auth.json');
    if (fs.existsSync(authPath)) {
      try {
        const authData = JSON.parse(fs.readFileSync(authPath, 'utf8'));
        const authApiKey = String(authData && authData.OPENAI_API_KEY || '').trim();
        if (authApiKey) return authApiKey;
      } catch (e) {}
    }

    return '';
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

  function patchCodexConfigToml(hostGlobalDir, accountId, apiKeyMode, openaiBaseUrl = '', openaiApiKey = '') {
    const configPath = path.join(hostGlobalDir, 'config.toml');
    let content = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
    const providerKey = getAihProviderKey(accountId);
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
      const providerBlock = getManagedAihProviderBlock({
        accountId,
        openaiBaseUrl: openaiBaseUrl || defaultBaseUrl,
        bearerToken: shouldUseDummyBearerToken(openaiBaseUrl) ? 'dummy' : (openaiApiKey || 'dummy')
      });
      content = replaceTomlSection(content, currentProviderHeader, providerBlock);
    }

    fs.writeFileSync(configPath, hoistModelProviderSections(content));
  }

  function ensureCodexStopHook(hostGlobalDir) {
    if (process.platform === 'win32') {
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
    const hasExisting = stopHooks.some((group) =>
      Array.isArray(group && group.hooks)
      && group.hooks.some((hook) => String(hook && hook.command || '').includes(codexStopHookScriptName))
    );

    if (!hasExisting) {
      stopHooks.push({
        hooks: [
          {
            type: 'command',
            command: commandValue,
            timeout: 10,
            statusMessage: 'AI Home completion notification'
          }
        ]
      });
      hooksConfig.hooks.Stop = stopHooks;
      fs.writeFileSync(hooksJsonPath, JSON.stringify(hooksConfig, null, 2) + '\n', 'utf8');
      return { updated: true, hookScriptPath, hooksJsonPath };
    }

    return { updated: false, hookScriptPath, hooksJsonPath, reason: 'already_present' };
  }

  return function syncGlobalConfigToHost(cliName, id) {
    const cfg = cliConfigs[cliName];
    if (!cfg || !cfg.globalDir) {
      return { ok: false, reason: 'unsupported-cli' };
    }

    const accountProfileDir = getProfileDir(cliName, id);
    const accountGlobalDir = path.join(accountProfileDir, cfg.globalDir);
    if (!fs.existsSync(accountGlobalDir)) {
      return { ok: false, reason: 'missing-account-global-dir', accountGlobalDir };
    }

    const hostGlobalDir = path.join(hostHomeDir, cfg.globalDir);
    ensureDir(hostGlobalDir);
    const normalized = normalizeSharedEntries(cliName, accountGlobalDir, hostGlobalDir);
    const authSync = cliName === 'codex'
      ? syncIndependentCodexHostAuthFile(accountGlobalDir, hostGlobalDir)
      : syncIsolatedAuthFile(cliName, accountGlobalDir, hostGlobalDir);

    if (cliName === 'codex') {
      try {
        const openaiBaseUrl = readCodexApiKeyBaseUrl(accountProfileDir, accountGlobalDir);
        const openaiApiKey = readCodexApiKeyToken(accountProfileDir, accountGlobalDir);
        const apiKeyMode = Boolean(openaiApiKey);
        patchCodexConfigToml(hostGlobalDir, id, apiKeyMode, openaiBaseUrl, openaiApiKey);
      } catch (e) {}
    }

    const codexHook = cliName === 'codex'
      ? ensureCodexStopHook(hostGlobalDir)
      : null;

    if (cliName !== 'codex' && !authSync.updated) {
      return {
        ok: false,
        reason: authSync.reason || 'missing-auth-file',
        accountGlobalDir,
        hostGlobalDir,
        normalized,
        codexHook
      };
    }
    return { ok: true, accountGlobalDir, hostGlobalDir, backup: authSync.backup, normalized, authSync, codexHook };
  };
}

module.exports = {
  createHostConfigSyncer
};
