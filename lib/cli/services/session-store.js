'use strict';

const { isWindowsAbsolutePathEntryName } = require('../../runtime/windows-path-encoding');
const { readAccountCredentials } = require('../../server/account-credential-store');
const { requiresProviderAuthProjection } = require('./ai-cli/provider-runtime-env');

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
  gemini: ['history', 'projects.json', 'tmp'],
  opencode: []
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
  gemini: new Set(['google_accounts.json', 'oauth_creds.json']),
  agy: new Set([
    'antigravity-oauth-token',
    'antigravity-oauth-token.corrupted.bak',
    'email.cache',
    'email.cache.corrupted.bak'
  ]),
  opencode: new Set(['opencode.json', 'opencode.jsonc', 'package.json', 'bun.lock'])
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
  if (isWindowsAbsolutePathEntryName(entryName)) return false;
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
  const shareAllDetectedEntries = cliName !== 'opencode';
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
    aiHomeDir,
    hostHomeDir,
    cliConfigs,
    getProfileDir,
    ensureDir
  } = options;
  function getToolConfigDir(cliName, id, runtime = {}) {
    if (cliName === 'claude') return getGlobalToolConfigRoot(cliName);
    const config = cliConfigs[cliName] || {};
    const globalFolder = config.globalDir || `.${cliName}`;
    const configSubDir = String(config.configSubDir || '').trim();
    return configSubDir
      ? path.join(getProfileDir(cliName, id, runtime), globalFolder, configSubDir)
      : path.join(getProfileDir(cliName, id, runtime), globalFolder);
  }

  function getGlobalToolConfigRoot(cliName) {
    const config = cliConfigs[cliName] || {};
    const globalFolder = config.globalDir || `.${cliName}`;
    const configSubDir = String(config.configSubDir || '').trim();
    return configSubDir
      ? path.join(hostHomeDir, globalFolder, configSubDir)
      : path.join(hostHomeDir, globalFolder);
  }

  function getSessionStoreRoot(cliName) {
    return getGlobalToolConfigRoot(cliName);
  }

  function getAiHomeDir() {
    return String(aiHomeDir || '').trim();
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

  function normalizePathForLinkCompare(value) {
    const resolved = path.resolve(String(value || ''));
    return processObj.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  function isSameFilesystemEntry(leftPath, rightPath) {
    try {
      const leftStat = fs.statSync(leftPath);
      const rightStat = fs.statSync(rightPath);
      return Number(leftStat.dev) === Number(rightStat.dev)
        && Number(leftStat.ino) === Number(rightStat.ino)
        && Number(leftStat.ino) !== 0;
    } catch (_error) {
      return false;
    }
  }

  function safeLstat(targetPath) {
    try {
      return fs.lstatSync(targetPath);
    } catch (_error) {
      return null;
    }
  }

  function safeStat(targetPath) {
    try {
      return fs.statSync(targetPath);
    } catch (_error) {
      return null;
    }
  }

  function pathExistsByLstat(targetPath) {
    return !!safeLstat(targetPath);
  }

  function isDirectoryPath(targetPath) {
    const stat = safeStat(targetPath);
    if (stat) return stat.isDirectory();
    const lstat = safeLstat(targetPath);
    return !!(lstat && lstat.isDirectory());
  }

  function isLinkUsableForTarget(linkPath, targetPath) {
    const targetStat = safeStat(targetPath);
    const linkStat = safeStat(linkPath);
    if (!targetStat || !linkStat) return false;
    return targetStat.isDirectory() === linkStat.isDirectory();
  }

  function ensureToolConfigDir(toolConfigDir) {
    if (!toolConfigDir) return false;
    const stat = safeStat(toolConfigDir);
    if (stat && stat.isDirectory()) return true;

    const lstat = safeLstat(toolConfigDir);
    if (lstat) {
      try {
        if (lstat.isSymbolicLink()) {
          fs.unlinkSync(toolConfigDir);
        } else {
          const backupPath = `${toolConfigDir}.aih-invalid-${Date.now()}`;
          if (fse && typeof fse.moveSync === 'function') {
            fse.moveSync(toolConfigDir, backupPath, { overwrite: false });
          } else if (typeof fs.renameSync === 'function') {
            fs.renameSync(toolConfigDir, backupPath);
          } else {
            return false;
          }
        }
      } catch (_error) {
        return false;
      }
    }

    try {
      ensureDir(toolConfigDir);
      return isDirectoryPath(toolConfigDir);
    } catch (_error) {
      return false;
    }
  }

  function createManagedLinkSafe(targetPath, linkPath, isDir) {
    try {
      ensureDir(path.dirname(linkPath));
      if (processObj.platform === 'win32') {
        if (isDir) {
          fs.symlinkSync(targetPath, linkPath, 'junction');
          return true;
        }
        try {
          fs.symlinkSync(targetPath, linkPath, 'file');
          return true;
        } catch (_error) {
          if (typeof fs.linkSync !== 'function') return false;
          fs.linkSync(targetPath, linkPath);
          return true;
        }
      } else {
        fs.symlinkSync(targetPath, linkPath, isDir ? 'dir' : 'file');
        return true;
      }
    } catch (_error) {
      return false;
    }
  }

  function isManagedLink(linkPath, targetPath) {
    try {
      if (!fs.existsSync(linkPath)) return false;
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink()) {
        const real = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
        return normalizePathForLinkCompare(real) === normalizePathForLinkCompare(targetPath)
          && isLinkUsableForTarget(linkPath, targetPath);
      }
      if (processObj.platform === 'win32' && !stat.isDirectory()) {
        return isSameFilesystemEntry(linkPath, targetPath);
      }
      return false;
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
      if (isManagedLink(srcPath, storePath)) {
        return { migrated, linked: 1 };
      }

      if (pathExistsByLstat(srcPath)) {
        const srcStat = fs.lstatSync(srcPath);
        if (srcStat.isSymbolicLink()) {
          fs.unlinkSync(srcPath);
          migrated += 1;
        } else if (fs.existsSync(srcPath)) {
          migrated += mergeEntryIntoStore(cliName, entryName, srcPath, storePath);
        }
      }

      if (fs.existsSync(storePath) && !fs.existsSync(srcPath)) {
        if (createManagedLinkSafe(storePath, srcPath, isDirectoryPath(storePath))) linked += 1;
      }
    } catch (_error) {
      return { migrated, linked };
    }

    return { migrated, linked };
  }

  function ensureConfigDirSessionStoreLinks(cliName, toolConfigDir, storeRoot, entryNames = null) {
    const summary = { migrated: 0, linked: 0 };
    const entries = Array.isArray(entryNames)
      ? entryNames
      : getSessionEntriesForStore(cliName, toolConfigDir);

    entries.forEach((entryName) => {
      if (!shouldShareToolConfigEntry(cliName, entryName)) return;
      const srcPath = path.join(toolConfigDir, entryName);
      const storePath = path.join(storeRoot, entryName);
      const res = migrateAndLinkSessionEntry(cliName, entryName, srcPath, storePath);
      summary.migrated += res.migrated;
      summary.linked += res.linked;
    });

    return summary;
  }

  function detachAccountOwnedEntry(srcPath, storePath) {
    const srcStat = safeLstat(srcPath);
    if (!srcStat) return 0;
    const isSharedLink = srcStat.isSymbolicLink();
    const isSharedHardLink = !isSharedLink
      && storePath
      && fs.existsSync(storePath)
      && isSameFilesystemEntry(srcPath, storePath);

    if (!isSharedLink && !isSharedHardLink) return 0;

    try {
      if (srcStat.isSymbolicLink()) {
        const targetStat = safeStat(srcPath);
        if (targetStat && targetStat.isDirectory()) {
          const realTarget = fs.realpathSync(srcPath);
          const tempPath = `${srcPath}.aih-detached-${Date.now()}`;
          fse.copySync(realTarget, tempPath, { overwrite: false, errorOnExist: true });
          fs.unlinkSync(srcPath);
          fse.moveSync(tempPath, srcPath, { overwrite: false });
          return 1;
        }
      }

      const content = fs.readFileSync(srcPath);
      fs.unlinkSync(srcPath);
      ensureDir(path.dirname(srcPath));
      fs.writeFileSync(srcPath, content);
      return 1;
    } catch (_error) {
      try {
        if (srcStat.isSymbolicLink()) {
          fs.unlinkSync(srcPath);
        }
      } catch (_unlinkError) {}
      return 0;
    }
  }

  function detachAccountOwnedEntries(cliName, toolConfigDir, storeRoot) {
    const denylist = ACCOUNT_OWNED_ENTRY_DENYLIST[cliName];
    if (!denylist || !toolConfigDir) return 0;

    let detached = 0;
    for (const entryName of denylist) {
      detached += detachAccountOwnedEntry(
        path.join(toolConfigDir, entryName),
        storeRoot ? path.join(storeRoot, entryName) : ''
      );
    }
    return detached;
  }

  function listCodexDesktopRuntimeHomes() {
    const aiHomeDir = getAiHomeDir();
    const runtimeRoot = aiHomeDir ? path.join(aiHomeDir, 'run', 'codex-desktop') : '';
    if (!runtimeRoot || !fs.existsSync(runtimeRoot)) return [];
    let entries = [];
    try {
      entries = fs.readdirSync(runtimeRoot, { withFileTypes: true });
    } catch (_error) {
      return [];
    }
    return entries
      .filter((entry) => entry && entry.isDirectory() && /^acct_[a-f0-9]{20}$/.test(entry.name))
      .map((entry) => path.join(runtimeRoot, entry.name));
  }

  function ensureCodexDesktopRuntimeStoreLinks() {
    const summary = { migrated: 0, linked: 0 };
    const storeRoot = getSessionStoreRoot('codex');
    ensureDir(storeRoot);

    listCodexDesktopRuntimeHomes().forEach((runtimeHome) => {
      const entries = getSessionEntriesForStore('codex', runtimeHome);
      entries.forEach((entryName) => {
        const srcPath = path.join(runtimeHome, entryName);
        const storePath = path.join(storeRoot, entryName);
        const res = migrateAndLinkSessionEntry('codex', entryName, srcPath, storePath);
        summary.migrated += res.migrated;
        summary.linked += res.linked;
      });
    });

    return summary;
  }

  function ensureSessionStoreLinks(cliName, accountRef) {
    // Claude has one state root: host ~/.claude. Normal launches never use a
    // per-account config directory, so linking or migrating Claude state here
    // would recreate the split-brain topology this service must prevent.
    if (cliName === 'claude') return { migrated: 0, linked: 0 };
    try {
      const accountEnv = readAccountCredentials(fs, getAiHomeDir(), accountRef);
      if (!requiresProviderAuthProjection(cliName, accountEnv)) {
        return { migrated: 0, linked: 0 };
      }
    } catch (_error) {
      // Missing DB credentials fall through to native-auth projection setup.
    }
    const toolConfigDir = getToolConfigDir(cliName, accountRef);
    if (!ensureToolConfigDir(toolConfigDir)) return { migrated: 0, linked: 0 };
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
    migrated += detachAccountOwnedEntries(cliName, toolConfigDir, storeRoot);

    if (processObj.platform === 'darwin' && hostHomeDir) {
      const guestProfileDir = getProfileDir(cliName, accountRef);
      const guestLibraryDir = path.join(guestProfileDir, 'Library');
      ensureDir(guestLibraryDir);

      // Clean up existing Keychains symlink for agy to ensure keyring isolation
      if (cliName === 'agy') {
        const guestKeychainsPath = path.join(guestLibraryDir, 'Keychains');
        if (fs.existsSync(guestKeychainsPath) || pathExistsByLstat(guestKeychainsPath)) {
          try {
            const stat = fs.lstatSync(guestKeychainsPath);
            if (stat.isSymbolicLink()) {
              fs.unlinkSync(guestKeychainsPath);
            } else {
              fse.removeSync(guestKeychainsPath);
            }
          } catch (_e) {}
        }
      }

      const items = cliName === 'agy' ? ['Preferences'] : ['Keychains', 'Preferences'];
      items.forEach((item) => {
        const guestPath = path.join(guestLibraryDir, item);
        const hostPath = path.join(hostHomeDir, 'Library', item);
        if (fs.existsSync(hostPath)) {
          if (!isManagedLink(guestPath, hostPath)) {
            try {
              fse.removeSync(guestPath);
            } catch (_e) {}
            createManagedLinkSafe(hostPath, guestPath, true);
          }
        }
      });
    }

    if (cliName === 'codex') {
      const runtimeResult = ensureCodexDesktopRuntimeStoreLinks();
      migrated += runtimeResult.migrated;
      linked += runtimeResult.linked;
    }
    if (cliName === 'agy') {
      const parentToolConfigDir = path.join(getProfileDir(cliName, accountRef), '.gemini');
      const parentStoreRoot = path.join(hostHomeDir, '.gemini');
      const guestConfigDir = path.join(parentToolConfigDir, 'config');
      const hostConfigDir = path.join(parentStoreRoot, 'config');
      if (fs.existsSync(parentToolConfigDir)) {
        ensureDir(hostConfigDir);
        ensureDir(guestConfigDir);
        const res = migrateAndLinkSessionEntry(cliName, 'config', guestConfigDir, hostConfigDir);
        migrated += res.migrated;
        linked += res.linked;
      }
    }
    const mainResult = ensureConfigDirSessionStoreLinks(cliName, toolConfigDir, storeRoot);
    migrated += mainResult.migrated;
    linked += mainResult.linked;

    return { migrated, linked };
  }

  return {
    getToolConfigDir,
    ensureSessionStoreLinks
  };
}

module.exports = {
  SESSION_STORE_ALLOWLIST,
  collectSharedToolEntryNames,
  shouldShareToolConfigEntry,
  createSessionStoreService
};
