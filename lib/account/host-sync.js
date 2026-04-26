'use strict';

const path = require('path');
const { collectSharedToolEntryNames } = require('../cli/services/session-store');
const {
  AIH_CODEX_PROVIDER_KEY,
  AIH_CODEX_PROVIDER_BASE_URL,
  getAihProviderKey,
  getManagedAihProviderBlock
} = require('../cli/services/pty/codex-config-sync');

function createHostConfigSyncer(deps) {
  const {
    fs,
    fse,
    ensureDir,
    getProfileDir,
    hostHomeDir,
    cliConfigs
  } = deps;
  const isolatedAuthFileByCli = {
    codex: 'auth.json',
    claude: '.credentials.json',
    gemini: 'google_accounts.json'
  };
  const codexStopHookScriptName = 'aih-stop-notify.js';

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
    if (cliName === 'codex') {
      try {
        if (fs.existsSync(dstPath) || fs.lstatSync(dstPath).isSymbolicLink()) {
          fs.unlinkSync(dstPath);
        }
      } catch (_error) {
        try {
          fse.removeSync(dstPath);
        } catch (removeError) {
          return {
            updated: false,
            reason: 'unlink-host-auth-failed',
            file: authFileName,
            backup,
            error: String((removeError && removeError.message) || removeError || 'unlink_failed')
          };
        }
      }
      const linked = createSymlinkSafe(srcPath, dstPath, false);
      if (!linked) {
        return { updated: false, reason: 'link-host-auth-failed', file: authFileName, backup };
      }
      return { updated: true, file: authFileName, backup, linked: true };
    }

    fse.copySync(srcPath, dstPath, { overwrite: true, errorOnExist: false });
    return { updated: true, file: authFileName, backup };
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

  function removeTomlSection(content, header) {
    const blockRegex = new RegExp(`(?:^|\\n)${escapeRegExp(header)}[\\s\\S]*?(?=\\n\\[|$)`, 'm');
    return content.replace(blockRegex, '').replace(/\n{3,}/g, '\n\n').trimEnd();
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

  function shouldUseDummyBearerToken(openaiBaseUrl) {
    const normalizedBaseUrl = normalizeBaseUrlForCompare(openaiBaseUrl || AIH_CODEX_PROVIDER_BASE_URL);
    return !normalizedBaseUrl || normalizedBaseUrl === normalizeBaseUrlForCompare(AIH_CODEX_PROVIDER_BASE_URL);
  }

  function patchCodexConfigToml(hostGlobalDir, accountId, apiKeyMode, openaiBaseUrl = '', openaiApiKey = '') {
    const configPath = path.join(hostGlobalDir, 'config.toml');
    if (!fs.existsSync(configPath) && !apiKeyMode) return;
    let content = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
    const providerKey = getAihProviderKey(accountId);
    const currentProviderHeader = `[model_providers.${providerKey}]`;
    const legacyProviderHeader = `[model_providers.${AIH_CODEX_PROVIDER_KEY}]`;

    if (!/^\[features\]\s*$/m.test(content)) {
      content = `${content.trimEnd()}${content.trim() ? '\n\n' : ''}[features]\ncodex_hooks = true\n`;
    } else if (/^codex_hooks\s*=/m.test(content)) {
      content = content.replace(/^codex_hooks\s*=.*$/m, 'codex_hooks = true');
    } else {
      content = content.replace(/^\[features\]\s*$/m, '[features]\ncodex_hooks = true');
    }
    
    if (apiKeyMode) {
      if (/^model_provider\s*=/m.test(content)) {
        content = content.replace(/^model_provider\s*=.*$/m, `model_provider = "${providerKey}"`);
      } else {
        content = `model_provider = "${providerKey}"\n` + content;
      }
      
      if (/^preferred_auth_method\s*=/m.test(content)) {
        content = content.replace(/^preferred_auth_method\s*=.*$/m, `preferred_auth_method = "apikey"`);
      } else {
        content = `preferred_auth_method = "apikey"\n` + content;
      }
      
      const providerBlock = getManagedAihProviderBlock({
        accountId,
        openaiBaseUrl: openaiBaseUrl || AIH_CODEX_PROVIDER_BASE_URL,
        bearerToken: shouldUseDummyBearerToken(openaiBaseUrl) ? 'dummy' : openaiApiKey
      });

      if (providerKey !== AIH_CODEX_PROVIDER_KEY) {
        content = removeTomlSection(content, legacyProviderHeader);
      }
      content = replaceTomlSection(content, currentProviderHeader, providerBlock);
    } else {
      content = content.replace(/^model_provider\s*=\s*"aih(?:_[^"]+)?"\s*$/gm, '# model_provider = "aih"');
      content = content.replace(/^preferred_auth_method\s*=\s*"apikey".*$/gm, `# preferred_auth_method = "apikey"`);
    }
    
    fs.writeFileSync(configPath, content);
  }

  function ensureCodexStopHook(hostGlobalDir) {
    if (process.platform === 'win32') {
      return { updated: false, reason: 'windows_hooks_disabled' };
    }

    const hooksDir = path.join(hostGlobalDir, 'hooks');
    const hookScriptPath = path.join(hooksDir, codexStopHookScriptName);
    const hooksJsonPath = path.join(hostGlobalDir, 'hooks.json');
    ensureDir(hooksDir);

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
    const authSync = syncIsolatedAuthFile(cliName, accountGlobalDir, hostGlobalDir);
    
    if (cliName === 'codex') {
      try {
        const srcPath = path.join(accountGlobalDir, 'auth.json');
        let apiKeyMode = false;
        let openaiBaseUrl = '';
        let openaiApiKey = '';
        if (fs.existsSync(srcPath)) {
          const authData = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
          apiKeyMode = authData.auth_mode === 'api_key' || !!authData.OPENAI_API_KEY;
        }
        if (apiKeyMode) {
          openaiBaseUrl = readCodexApiKeyBaseUrl(accountProfileDir, accountGlobalDir);
          openaiApiKey = readCodexApiKeyToken(accountProfileDir, accountGlobalDir);
        }
        patchCodexConfigToml(hostGlobalDir, id, apiKeyMode, openaiBaseUrl, openaiApiKey);
      } catch (e) {}
    }

    const codexHook = cliName === 'codex'
      ? ensureCodexStopHook(hostGlobalDir)
      : null;

    if (!authSync.updated) {
      return {
        ok: false,
        reason: authSync.reason || 'missing-auth-file',
        accountGlobalDir,
        hostGlobalDir,
        normalized,
        codexHook
      };
    }
    return { ok: true, accountGlobalDir, hostGlobalDir, backup: authSync.backup, normalized, codexHook };
  };
}

module.exports = {
  createHostConfigSyncer
};
