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
    // ❌ 移除 config.toml - 每个账号应该有独立的配置,不应该软链接到全局
    // 'config.toml',
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
    '.tmp',
    'cache',
    'tmp',
    'session_index.jsonl'
  ],
  claude: ['history.jsonl', 'projects', 'shell-snapshots', '.claude.json'],
  gemini: ['history', 'projects.json', 'tmp']
};

const SESSION_STORE_PRESERVE_ON_LINK = {
  codex: ['.tmp', 'cache']
};

const SESSION_STORE_METADATA_PATTERNS = {
  codex: [
    /^\.codex-global-state\.json$/i,
    /^state_\d+\.sqlite(?:-(?:shm|wal))?$/i
  ]
};

const ACCOUNT_OWNED_ENTRY_DENYLIST = {
  codex: new Set(['config.toml', 'auth.json']),
  claude: new Set(['.credentials.json']),
  gemini: new Set(['google_accounts.json'])
};

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

function shouldShareToolConfigEntry(cliName, name) {
  const entryName = String(name || '').trim();
  if (!entryName) return false;
  if (isSensitiveName(entryName)) return false;
  const denylist = ACCOUNT_OWNED_ENTRY_DENYLIST[cliName];
  if (denylist && denylist.has(entryName)) return false;
  return true;
}

function safeReadDirEntries(fsImpl, dirPath) {
  if (!fsImpl || !dirPath || !fsImpl.existsSync(dirPath)) return [];
  try {
    return fsImpl.readdirSync(dirPath, { withFileTypes: true }).map((entry) => entry.name);
  } catch (_error) {
    return [];
  }
}

function collectSharedToolEntryNames(fsImpl, cliName, dirPaths = []) {
  const allowlist = SESSION_STORE_ALLOWLIST[cliName] || [];
  const shareAllDetectedEntries = cliName === 'codex';
  const candidates = new Set(
    allowlist.filter((name) => shouldShareToolConfigEntry(cliName, name))
  );

  for (const dirPath of Array.isArray(dirPaths) ? dirPaths : []) {
    for (const name of safeReadDirEntries(fsImpl, dirPath)) {
      if (!shouldShareToolConfigEntry(cliName, name)) continue;
      if (
        shareAllDetectedEntries
        || allowlist.includes(name)
        || isLikelySessionName(name)
        || isSessionMetadataName(cliName, name)
      ) {
        candidates.add(name);
      }
    }
  }

  return Array.from(candidates);
}

function createSessionStoreService(options = {}) {
  const {
    fs,
    fse,
    path,
    processObj,
    profilesDir,
    hostHomeDir,
    cliConfigs,
    getProfileDir,
    ensureDir
  } = options;
  const autoAlignedCliNames = new Set();

  function getToolConfigDir(cliName, id) {
    const globalFolder = cliConfigs[cliName] ? cliConfigs[cliName].globalDir : `.${cliName}`;
    return path.join(getProfileDir(cliName, id), globalFolder);
  }

  function getGlobalToolConfigRoot(cliName) {
    const globalFolder = cliConfigs[cliName] ? cliConfigs[cliName].globalDir : `.${cliName}`;
    return path.join(hostHomeDir, globalFolder);
  }

  function getSessionStoreRoot(cliName) {
    return getGlobalToolConfigRoot(cliName);
  }

  function getSessionEntriesForStore(cliName, toolConfigDir) {
    return collectSharedToolEntryNames(fs, cliName, [
      toolConfigDir,
      getSessionStoreRoot(cliName)
    ]);
  }

  function shouldPreserveEntryOnLink(cliName, entryName) {
    const keepList = SESSION_STORE_PRESERVE_ON_LINK[cliName] || [];
    return keepList.includes(String(entryName || ''));
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

  function isManagedSymlink(linkPath, targetPath) {
    try {
      if (!fs.existsSync(linkPath)) return false;
      const stat = fs.lstatSync(linkPath);
      if (!stat.isSymbolicLink()) return false;
      const real = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
      return path.resolve(real) === path.resolve(targetPath);
    } catch (_error) {
      return false;
    }
  }

  function safeReadJsonFile(filePath) {
    try {
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_error) {
      return null;
    }
  }

  function writeJsonFile(filePath, value) {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
  }

  function readCodexSessionIndexEntries(filePath) {
    const entries = new Map();
    if (!fs.existsSync(filePath)) return entries;
    let content = '';
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (_error) {
      return entries;
    }

    content.split(/\r?\n/).forEach((line) => {
      const trimmed = String(line || '').trim();
      if (!trimmed) return;
      try {
        const parsed = JSON.parse(trimmed);
        const id = String(parsed && parsed.id || '').trim();
        if (!id) return;
        const existing = entries.get(id);
        const nextUpdatedAt = Date.parse(parsed.updated_at || '') || 0;
        const existingUpdatedAt = Date.parse(existing && existing.updated_at || '') || 0;
        if (!existing || nextUpdatedAt >= existingUpdatedAt) {
          entries.set(id, parsed);
        }
      } catch (_error) {}
    });

    return entries;
  }

  function writeCodexSessionIndexEntries(filePath, entries) {
    const sorted = Array.from(entries.values()).sort((left, right) => {
      const leftUpdatedAt = Date.parse(left && left.updated_at || '') || 0;
      const rightUpdatedAt = Date.parse(right && right.updated_at || '') || 0;
      if (leftUpdatedAt !== rightUpdatedAt) return leftUpdatedAt - rightUpdatedAt;
      return String(left && left.id || '').localeCompare(String(right && right.id || ''));
    });
    ensureDir(path.dirname(filePath));
    const content = sorted.map((entry) => JSON.stringify(entry)).join('\n');
    fs.writeFileSync(filePath, content ? `${content}\n` : '', 'utf8');
  }

  function mergeUniqueStrings(targetList, sourceList) {
    const merged = [];
    const seen = new Set();
    [targetList, sourceList].forEach((items) => {
      (Array.isArray(items) ? items : []).forEach((item) => {
        const normalized = String(item || '').trim();
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        merged.push(normalized);
      });
    });
    return merged;
  }

  function mergeStringMaps(targetValue, sourceValue) {
    const merged = {};
    if (targetValue && typeof targetValue === 'object' && !Array.isArray(targetValue)) {
      Object.keys(targetValue).forEach((key) => {
        merged[key] = targetValue[key];
      });
    }
    if (sourceValue && typeof sourceValue === 'object' && !Array.isArray(sourceValue)) {
      Object.keys(sourceValue).forEach((key) => {
        const normalizedKey = String(key || '').trim();
        const normalizedValue = String(sourceValue[key] || '').trim();
        if (!normalizedKey || !normalizedValue) return;
        if (!merged[normalizedKey]) {
          merged[normalizedKey] = normalizedValue;
        }
      });
    }
    return merged;
  }

  function mergeCodexGlobalState(storePath, srcPath) {
    const storeState = safeReadJsonFile(storePath);
    const srcState = safeReadJsonFile(srcPath);
    if (!storeState && !srcState) return false;
    if (!storeState && srcState) {
      writeJsonFile(storePath, srcState);
      return true;
    }
    if (!srcState) return false;

    const merged = {
      ...srcState,
      ...storeState
    };
    [
      'electron-saved-workspace-roots',
      'active-workspace-roots',
      'project-order'
    ].forEach((key) => {
      merged[key] = mergeUniqueStrings(storeState && storeState[key], srcState && srcState[key]);
    });
    merged['thread-workspace-root-hints'] = mergeStringMaps(
      storeState && storeState['thread-workspace-root-hints'],
      srcState && srcState['thread-workspace-root-hints']
    );

    if (
      JSON.stringify(merged) === JSON.stringify(storeState)
      && fs.existsSync(storePath)
    ) {
      return false;
    }
    writeJsonFile(storePath, merged);
    return true;
  }

  function mergeCodexSessionIndex(storePath, srcPath) {
    const storeEntries = readCodexSessionIndexEntries(storePath);
    const srcEntries = readCodexSessionIndexEntries(srcPath);
    let changed = false;

    srcEntries.forEach((entry, id) => {
      const existing = storeEntries.get(id);
      const nextUpdatedAt = Date.parse(entry && entry.updated_at || '') || 0;
      const existingUpdatedAt = Date.parse(existing && existing.updated_at || '') || 0;
      if (!existing || nextUpdatedAt >= existingUpdatedAt) {
        storeEntries.set(id, entry);
        changed = true;
      }
    });

    if (!changed && fs.existsSync(storePath)) return false;
    writeCodexSessionIndexEntries(storePath, storeEntries);
    return true;
  }

  function shouldReplaceExistingFile(srcPath, storePath) {
    try {
      if (!fs.existsSync(storePath)) return true;
      const srcStat = fs.statSync(srcPath);
      const dstStat = fs.statSync(storePath);
      if (srcStat.size !== dstStat.size) return srcStat.size > dstStat.size;
      return srcStat.mtimeMs > dstStat.mtimeMs;
    } catch (_error) {
      return false;
    }
  }

  function mergeDirectoryIntoStore(cliName, srcDir, storeDir) {
    if (!fs.existsSync(srcDir)) return 0;
    ensureDir(storeDir);
    let migrated = 0;
    let entries = [];
    try {
      entries = fs.readdirSync(srcDir, { withFileTypes: true });
    } catch (_error) {
      return 0;
    }

    entries.forEach((entry) => {
      const entryName = entry && entry.name;
      if (!entryName) return;
      const nestedSrcPath = path.join(srcDir, entryName);
      const nestedStorePath = path.join(storeDir, entryName);
      try {
        if (entry.isDirectory()) {
          migrated += mergeDirectoryIntoStore(cliName, nestedSrcPath, nestedStorePath);
          if (fs.existsSync(nestedSrcPath)) {
            const remaining = safeReadDirEntries(fs, nestedSrcPath);
            if (remaining.length === 0) {
              fse.removeSync(nestedSrcPath);
              migrated += 1;
            }
          }
          return;
        }

        if (entry.isSymbolicLink()) {
          const stat = fs.statSync(nestedSrcPath);
          if (stat.isDirectory()) {
            migrated += mergeDirectoryIntoStore(cliName, nestedSrcPath, nestedStorePath);
          } else if (!fs.existsSync(nestedStorePath) || shouldReplaceExistingFile(nestedSrcPath, nestedStorePath)) {
            ensureDir(path.dirname(nestedStorePath));
            fse.copySync(nestedSrcPath, nestedStorePath, { overwrite: true, errorOnExist: false });
            migrated += 1;
          }
          fse.removeSync(nestedSrcPath);
          migrated += 1;
          return;
        }

        if (!fs.existsSync(nestedStorePath) || shouldReplaceExistingFile(nestedSrcPath, nestedStorePath)) {
          ensureDir(path.dirname(nestedStorePath));
          fse.moveSync(nestedSrcPath, nestedStorePath, { overwrite: true });
          migrated += 1;
          return;
        }

        fse.removeSync(nestedSrcPath);
        migrated += 1;
      } catch (_error) {}
    });

    return migrated;
  }

  function mergeEntryIntoStore(cliName, entryName, srcPath, storePath) {
    if (!fs.existsSync(srcPath)) return 0;
    const preserveOnLink = shouldPreserveEntryOnLink(cliName, entryName);
    try {
      const srcStat = fs.lstatSync(srcPath);
      if (!fs.existsSync(storePath)) {
        ensureDir(path.dirname(storePath));
        fse.moveSync(srcPath, storePath, { overwrite: false });
        return 1;
      }

      if (cliName === 'codex' && entryName === '.codex-global-state.json') {
        const changed = mergeCodexGlobalState(storePath, srcPath);
        fse.removeSync(srcPath);
        return changed ? 2 : 1;
      }

      if (cliName === 'codex' && entryName === 'session_index.jsonl') {
        const changed = mergeCodexSessionIndex(storePath, srcPath);
        fse.removeSync(srcPath);
        return changed ? 2 : 1;
      }

      if (srcStat.isDirectory()) {
        const migrated = mergeDirectoryIntoStore(cliName, srcPath, storePath);
        if (fs.existsSync(srcPath)) {
          fse.removeSync(srcPath);
        }
        return migrated + 1;
      }

      if (preserveOnLink && shouldReplaceExistingFile(srcPath, storePath)) {
        ensureDir(path.dirname(storePath));
        fse.copySync(srcPath, storePath, { overwrite: true, errorOnExist: false });
        fse.removeSync(srcPath);
        return 2;
      }

      fse.removeSync(srcPath);
      return 1;
    } catch (_error) {
      return 0;
    }
  }

  function migrateAndLinkSessionEntry(cliName, entryName, srcPath, storePath) {
    let migrated = 0;
    let linked = 0;

    try {
      if (isManagedSymlink(srcPath, storePath)) {
        return { migrated, linked: 1 };
      }

      if (fs.existsSync(srcPath)) {
        const srcStat = fs.lstatSync(srcPath);
        if (srcStat.isSymbolicLink()) {
          fs.unlinkSync(srcPath);
          migrated += 1;
        } else {
          migrated += mergeEntryIntoStore(cliName, entryName, srcPath, storePath);
        }
      }

      if (fs.existsSync(storePath) && !fs.existsSync(srcPath)) {
        const dstStat = fs.lstatSync(storePath);
        if (createSymlinkSafe(storePath, srcPath, dstStat.isDirectory())) linked += 1;
      }
    } catch (_error) {
      return { migrated, linked };
    }

    return { migrated, linked };
  }

  function listToolAccountIds(cliName) {
    if (!profilesDir) return [];
    const cliRoot = path.join(profilesDir, cliName);
    let entries = [];
    try {
      entries = fs.readdirSync(cliRoot, { withFileTypes: true });
    } catch (_error) {
      return [];
    }
    return entries
      .filter((entry) => entry && entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((left, right) => Number(left) - Number(right));
  }

  function ensureAllSessionStoreLinks(cliName) {
    const ids = listToolAccountIds(cliName);
    const summary = {
      scannedAccounts: 0,
      migrated: 0,
      linked: 0
    };

    ids.forEach((id) => {
      summary.scannedAccounts += 1;
      const result = ensureSessionStoreLinks(cliName, id, { skipAutoAlign: true });
      summary.migrated += Number(result && result.migrated) || 0;
      summary.linked += Number(result && result.linked) || 0;
    });

    return summary;
  }

  function ensureSessionStoreLinks(cliName, id, options = {}) {
    if (cliName === 'codex' && !options.skipAutoAlign && !autoAlignedCliNames.has(cliName)) {
      autoAlignedCliNames.add(cliName);
      try {
        ensureAllSessionStoreLinks(cliName);
      } catch (_error) {
        autoAlignedCliNames.delete(cliName);
      }
    }
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
      const res = migrateAndLinkSessionEntry(cliName, entryName, srcPath, storePath);
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
    ensureAllSessionStoreLinks,
    importLegacySessionsToTarget
  };
}

module.exports = {
  SESSION_STORE_ALLOWLIST,
  collectSharedToolEntryNames,
  shouldShareToolConfigEntry,
  createSessionStoreService
};
