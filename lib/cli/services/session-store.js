'use strict';

const SESSION_PATH_HINTS = ['session', 'history', 'chat', 'conversation', 'project', 'recent', 'archive', 'snapshot'];
const AUTH_PATH_HINTS = [
  'auth',
  'oauth',
  'token',
  'credential',
  'api_key',
  'apikey',
  'google_accounts',
  'keyring',
  'secret'
];

const SESSION_STORE_ALLOWLIST = {
  codex: [
    'sessions',
    'history.jsonl',
    'archived_sessions',
    'shell_snapshots',
    'config.toml',
    'version.json',
    'models_cache.json',
    '.personality_migration',
    'log',
    'memories',
    'rules',
    'skills',
    'sqlite',
    'prompts',
    'worktrees',
    'automations',
    'backup',
    'vendor_imports',
    'internal_storage.json',
    'AGENTS.md',
    'tmp',
    'session_index.jsonl'
  ],
  claude: ['history.jsonl', 'projects', 'shell-snapshots', '.claude.json'],
  gemini: ['history', 'projects.json', 'tmp']
};

const SESSION_STORE_METADATA_PATTERNS = {
  codex: [
    /^\.codex-global-state\.json$/i,
    /^state_\d+\.sqlite(?:-(?:shm|wal))?$/i
  ]
};

function createSessionStoreService(options = {}) {
  const {
    fs,
    fse,
    path,
    processObj,
    hostHomeDir,
    cliConfigs,
    getProfileDir,
    ensureDir
  } = options;

  function getToolConfigDir(cliName, id) {
    const globalFolder = cliConfigs[cliName] ? cliConfigs[cliName].globalDir : `.${cliName}`;
    return path.join(getProfileDir(cliName, id), globalFolder);
  }

  function isLikelySessionName(name) {
    const n = String(name || '').toLowerCase();
    return SESSION_PATH_HINTS.some((hint) => n.includes(hint));
  }

  function isSensitiveName(name) {
    const n = String(name || '').toLowerCase();
    return AUTH_PATH_HINTS.some((hint) => n.includes(hint));
  }

  function isSessionMetadataName(cliName, name) {
    const patterns = SESSION_STORE_METADATA_PATTERNS[cliName] || [];
    return patterns.some((re) => re.test(String(name || '')));
  }

  function getGlobalToolConfigRoot(cliName) {
    const globalFolder = cliConfigs[cliName] ? cliConfigs[cliName].globalDir : `.${cliName}`;
    return path.join(hostHomeDir, globalFolder);
  }

  function getSessionStoreRoot(cliName) {
    return getGlobalToolConfigRoot(cliName);
  }

  function getDirEntriesSafe(dirPath) {
    if (!fs.existsSync(dirPath)) return [];
    try {
      return fs.readdirSync(dirPath, { withFileTypes: true }).map((x) => x.name);
    } catch (_error) {
      return [];
    }
  }

  function getSessionEntriesForStore(cliName, toolConfigDir) {
    const allowlist = SESSION_STORE_ALLOWLIST[cliName] || [];
    const candidates = new Set(allowlist);
    getDirEntriesSafe(toolConfigDir).forEach((name) => {
      if ((isLikelySessionName(name) || isSessionMetadataName(cliName, name)) && !isSensitiveName(name)) {
        candidates.add(name);
      }
    });
    getDirEntriesSafe(getSessionStoreRoot(cliName)).forEach((name) => {
      if ((allowlist.includes(name) || isLikelySessionName(name) || isSessionMetadataName(cliName, name)) && !isSensitiveName(name)) {
        candidates.add(name);
      }
    });
    return Array.from(candidates).filter((name) => !isSensitiveName(name));
  }

  function shouldCopyFileIntoSessionStore(srcPath, storePath) {
    try {
      if (!fs.existsSync(storePath)) return true;
      const srcStat = fs.statSync(srcPath);
      const dstStat = fs.statSync(storePath);
      if (srcStat.mtimeMs > dstStat.mtimeMs) return true;
      if (srcStat.mtimeMs === dstStat.mtimeMs && srcStat.size > dstStat.size) return true;
      return false;
    } catch (_error) {
      return true;
    }
  }

  function createSymlinkSafe(targetPath, linkPath, isDir) {
    try {
      ensureDir(path.dirname(linkPath));
      if (processObj.platform === 'win32') {
        fs.symlinkSync(targetPath, linkPath, isDir ? 'junction' : 'file');
      } else {
        fs.symlinkSync(targetPath, linkPath, isDir ? 'dir' : 'file');
      }
      return true;
    } catch (_error) {
      return false;
    }
  }

  function migrateAndLinkSessionEntry(srcPath, storePath) {
    let removed = 0;
    let linked = 0;
    let isDir = false;

    try {
      if (fs.existsSync(srcPath)) {
        const st = fs.lstatSync(srcPath);
        if (st.isSymbolicLink()) {
          const real = path.resolve(path.dirname(srcPath), fs.readlinkSync(srcPath));
          if (path.resolve(real) !== path.resolve(storePath)) {
            fs.unlinkSync(srcPath);
            removed += 1;
          } else {
            return { migrated: removed, linked: 1 };
          }
        } else {
          isDir = st.isDirectory();
          if (st.isDirectory()) fse.removeSync(srcPath);
          else fs.unlinkSync(srcPath);
          removed += 1;
        }
      }

      if (fs.existsSync(storePath) && !fs.existsSync(srcPath)) {
        const dstStat = fs.lstatSync(storePath);
        isDir = dstStat.isDirectory();
        if (createSymlinkSafe(storePath, srcPath, isDir)) linked += 1;
      }
    } catch (_error) {
      return { migrated: removed, linked };
    }

    return { migrated: removed, linked };
  }

  function ensureSessionStoreLinks(cliName, id) {
    const toolConfigDir = getToolConfigDir(cliName, id);
    if (!fs.existsSync(toolConfigDir)) return { migrated: 0, linked: 0 };
    const storeRoot = getSessionStoreRoot(cliName);
    try {
      const resolvedTool = path.resolve(fs.realpathSync(toolConfigDir));
      const resolvedStore = path.resolve(fs.realpathSync(storeRoot));
      if (resolvedTool === resolvedStore) {
        return { migrated: 0, linked: 0 };
      }
    } catch (_error) {}
    ensureDir(storeRoot);

    let migrated = 0;
    let linked = 0;
    const entries = getSessionEntriesForStore(cliName, toolConfigDir);
    entries.forEach((entryName) => {
      const srcPath = path.join(toolConfigDir, entryName);
      const storePath = path.join(storeRoot, entryName);
      const res = migrateAndLinkSessionEntry(srcPath, storePath);
      migrated += res.migrated;
      linked += res.linked;
    });

    return { migrated, linked };
  }

  function importLegacySessionsToTarget(cliName, sourceConfigDir, targetConfigDir) {
    if (!fs.existsSync(sourceConfigDir)) return 0;
    if (!targetConfigDir) return 0;
    ensureDir(targetConfigDir);
    let imported = 0;

    const entries = getSessionEntriesForStore(cliName, sourceConfigDir);
    entries.forEach((entryName) => {
      const srcPath = path.join(sourceConfigDir, entryName);
      if (!fs.existsSync(srcPath)) return;
      const targetPath = path.join(targetConfigDir, entryName);
      try {
        fse.copySync(srcPath, targetPath, { overwrite: true, errorOnExist: false });
        imported += 1;
      } catch (_error) {}
    });
    return imported;
  }

  return {
    getToolConfigDir,
    ensureSessionStoreLinks,
    importLegacySessionsToTarget
  };
}

module.exports = {
  SESSION_STORE_ALLOWLIST,
  createSessionStoreService
};
