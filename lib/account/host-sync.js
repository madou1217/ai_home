'use strict';

const path = require('path');
const { SESSION_STORE_ALLOWLIST } = require('../cli/services/session-store');

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
    const sharedEntries = SESSION_STORE_ALLOWLIST[cliName] || [];
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

  return function syncGlobalConfigToHost(cliName, id) {
    const cfg = cliConfigs[cliName];
    if (!cfg || !cfg.globalDir) {
      return { ok: false, reason: 'unsupported-cli' };
    }

    const accountGlobalDir = path.join(getProfileDir(cliName, id), cfg.globalDir);
    if (!fs.existsSync(accountGlobalDir)) {
      return { ok: false, reason: 'missing-account-global-dir', accountGlobalDir };
    }

    const hostGlobalDir = path.join(hostHomeDir, cfg.globalDir);
    ensureDir(hostGlobalDir);
    const normalized = normalizeSharedEntries(cliName, accountGlobalDir, hostGlobalDir);
    const authSync = syncIsolatedAuthFile(cliName, accountGlobalDir, hostGlobalDir);
    if (!authSync.updated) {
      return {
        ok: false,
        reason: authSync.reason || 'missing-auth-file',
        accountGlobalDir,
        hostGlobalDir,
        normalized
      };
    }
    return { ok: true, accountGlobalDir, hostGlobalDir, backup: authSync.backup, normalized };
  };
}

module.exports = {
  createHostConfigSyncer
};
