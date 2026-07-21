'use strict';

const { isWindowsAbsolutePathEntryName } = require('../../runtime/windows-path-encoding');
const { resolveAccountRuntimeDir } = require('../../runtime/aih-storage-layout');
const { readAccountCredentials } = require('../../server/account-credential-store');
const { requiresProviderAuthProjection } = require('./ai-cli/provider-runtime-env');
const {
  getProviderAuthArtifacts,
  getProviderPrivateArtifacts,
  getProviderProjectionMappings,
  getProviderSharedEntries,
  isProviderPrivateEntryName,
  isProviderPrecreatedDirectory,
  resolveProviderRuntimeHomeRoot
} = require('../../runtime/provider-storage-policy');
const { reconcileSharedData: reconcileOpenCodeSharedData } = require('./ai-cli/launch-profile/opencode-strategy');

const SESSION_PATH_HINTS = ['session', 'history', 'chat', 'conversation', 'project', 'recent', 'archive', 'snapshot'];
const MIGRATION_CONFLICT_DIR = '.aih-migration-conflicts';
const SESSION_STORE_ALLOWLIST = {
  codex: getProviderSharedEntries('codex'),
  claude: getProviderSharedEntries('claude'),
  gemini: getProviderSharedEntries('gemini'),
  agy: getProviderSharedEntries('agy'),
  opencode: getProviderSharedEntries('opencode')
};

const SESSION_STORE_PRESERVE_ON_LINK = {
  codex: ['.tmp', 'cache'],
  agy: ['GEMINI.md']
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
  ])
};

const PROVIDER_LOCAL_ALIAS_ENTRIES = {
  agy: new Set(['cli.log'])
};

const AGY_SHARED_LIBRARY_DIRECTORIES = Object.freeze([
  'Application Support',
  'Caches',
  'Preferences'
]);

function isLikelySessionName(name) {
  const n = String(name || '').toLowerCase();
  return SESSION_PATH_HINTS.some((hint) => n.includes(hint));
}

function isSessionMetadataName(cliName, name) {
  const patterns = SESSION_STORE_METADATA_PATTERNS[cliName] || [];
  return patterns.some((re) => re.test(String(name || '')));
}

function shouldShareToolConfigEntry(cliName, name) {
  const entryName = String(name || '').trim();
  if (!entryName) return false;
  if (entryName === MIGRATION_CONFLICT_DIR) return false;
  if (isWindowsAbsolutePathEntryName(entryName)) return false;
  if (isProviderPrivateEntryName(cliName, entryName)) return false;
  const denylist = ACCOUNT_OWNED_ENTRY_DENYLIST[cliName];
  if (denylist && denylist.has(entryName.toLowerCase())) return false;
  return true;
}

function safeReadDirEntries(fsImpl, dirPath) {
  if (!fsImpl || !dirPath) return [];
  try {
    return fsImpl.readdirSync(dirPath, { withFileTypes: true }).map((entry) => entry.name);
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
}

function readDirEntries(fsImpl, dirPath) {
  if (!fsImpl || !dirPath) return [];
  try {
    return fsImpl.readdirSync(dirPath, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
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
    return getProjectionToolConfigDir(cliName, id, runtime);
  }

  function getProjectionRoot(cliName, id, runtime = {}) {
    const explicitRoot = String(runtime && runtime.projectionRoot || '').trim();
    if (explicitRoot) return explicitRoot;
    return resolveAccountRuntimeDir(getAiHomeDir(), cliName, id)
      || getProfileDir(cliName, id, runtime);
  }

  function getProjectionToolConfigDir(cliName, id, runtime = {}) {
    const config = cliConfigs[cliName] || {};
    const globalFolder = config.globalDir || `.${cliName}`;
    const configSubDir = String(config.configSubDir || '').trim();
    const projectionDir = getProjectionRoot(cliName, id, runtime);
    return configSubDir
      ? path.join(projectionDir, globalFolder, configSubDir)
      : path.join(projectionDir, globalFolder);
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
    } catch (error) {
      if (error && error.code === 'ENOENT') return false;
      throw error;
    }
  }

  function lstatIfExists(targetPath) {
    try {
      return fs.lstatSync(targetPath);
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  function statIfExists(targetPath) {
    try {
      return fs.statSync(targetPath);
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  function pathExistsByLstat(targetPath) {
    return !!lstatIfExists(targetPath);
  }

  function isDirectoryPath(targetPath) {
    const stat = statIfExists(targetPath);
    if (stat) return stat.isDirectory();
    const lstat = lstatIfExists(targetPath);
    return !!(lstat && lstat.isDirectory());
  }

  function isLinkUsableForTarget(linkPath, targetPath) {
    const targetStat = statIfExists(targetPath);
    const linkStat = statIfExists(linkPath);
    if (!targetStat || !linkStat) return false;
    return targetStat.isDirectory() === linkStat.isDirectory();
  }

  function createProjectionPathError(code, targetPath) {
    const error = new Error(code);
    error.code = code;
    error.path = targetPath;
    return error;
  }

  function assertProjectionPathHasNoSymlinks(projectionRoot, targetPath) {
    const rawRoot = String(projectionRoot || '').trim();
    const rawTarget = String(targetPath || '').trim();
    if (!rawRoot || !rawTarget) {
      throw createProjectionPathError('provider_projection_path_outside_root', targetPath);
    }
    const rootPath = path.resolve(rawRoot);
    const resolvedTarget = path.resolve(rawTarget);
    const relativePath = path.relative(rootPath, resolvedTarget);
    if (
      path.isAbsolute(relativePath)
      || relativePath === '..'
      || relativePath.startsWith(`..${path.sep}`)
    ) {
      throw createProjectionPathError('provider_projection_path_outside_root', targetPath);
    }

    const segments = relativePath ? relativePath.split(path.sep).filter(Boolean) : [];
    const candidates = [rootPath];
    segments.forEach((segment) => {
      candidates.push(path.join(candidates[candidates.length - 1], segment));
    });

    candidates.forEach((candidatePath, index) => {
      const stat = lstatIfExists(candidatePath);
      if (!stat) return;
      if (stat.isSymbolicLink()) {
        throw createProjectionPathError('provider_projection_path_symlink', candidatePath);
      }
      if (index < candidates.length - 1 && !stat.isDirectory()) {
        throw createProjectionPathError('provider_projection_parent_not_directory', candidatePath);
      }
    });
  }

  function ensureProjectionDirectory(projectionRoot, directoryPath) {
    assertProjectionPathHasNoSymlinks(projectionRoot, directoryPath);
    ensureDir(directoryPath);
    assertProjectionPathHasNoSymlinks(projectionRoot, directoryPath);
    const stat = lstatIfExists(directoryPath);
    if (!stat || !stat.isDirectory()) {
      throw createProjectionPathError('provider_projection_directory_unavailable', directoryPath);
    }
  }

  function ensureToolConfigDir(projectionRoot, toolConfigDir) {
    if (!toolConfigDir) return false;
    assertProjectionPathHasNoSymlinks(projectionRoot, toolConfigDir);
    const directStat = lstatIfExists(toolConfigDir);
    if (directStat && directStat.isDirectory()) return true;

    if (directStat) {
      const backupPath = `${toolConfigDir}.aih-invalid-${Date.now()}`;
      if (fse && typeof fse.moveSync === 'function') {
        fse.moveSync(toolConfigDir, backupPath, { overwrite: false });
      } else if (typeof fs.renameSync === 'function') {
        fs.renameSync(toolConfigDir, backupPath);
      } else {
        throw new Error('provider_projection_invalid_path_unmovable');
      }
    }

    ensureProjectionDirectory(projectionRoot, toolConfigDir);
    if (!isDirectoryPath(toolConfigDir)) {
      throw new Error('provider_projection_directory_unavailable');
    }
    return true;
  }

  function createManagedLinkSafe(targetPath, linkPath, isDir) {
    ensureDir(path.dirname(linkPath));
    if (processObj.platform === 'win32') {
      if (isDir) {
        fs.symlinkSync(targetPath, linkPath, 'junction');
        return true;
      }
      try {
        fs.symlinkSync(targetPath, linkPath, 'file');
        return true;
      } catch (error) {
        if (typeof fs.linkSync !== 'function') throw error;
        fs.linkSync(targetPath, linkPath);
        return true;
      }
    }
    fs.symlinkSync(targetPath, linkPath, isDir ? 'dir' : 'file');
    return true;
  }

  function isManagedLink(linkPath, targetPath) {
    const stat = lstatIfExists(linkPath);
    if (!stat) return false;
    if (stat.isSymbolicLink()) {
      if (!pointsToManagedTarget(linkPath, targetPath)) return false;
      // SQLite -wal/-shm and similar ephemeral targets legitimately disappear
      // while their projection alias remains. An exact target is still a safe,
      // canonical alias and must not block account cleanup.
      if (!statIfExists(targetPath)) return true;
      return isLinkUsableForTarget(linkPath, targetPath);
    }
    if (processObj.platform === 'win32' && !stat.isDirectory()) {
      return isSameFilesystemEntry(linkPath, targetPath);
    }
    return false;
  }

  function pointsToManagedTarget(linkPath, targetPath) {
    const stat = lstatIfExists(linkPath);
    if (!stat || !stat.isSymbolicLink()) return false;
    const real = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
    return normalizePathForLinkCompare(real) === normalizePathForLinkCompare(targetPath);
  }

  function isProviderLocalManagedAlias(cliName, entryName, linkPath, targetPath) {
    const aliases = PROVIDER_LOCAL_ALIAS_ENTRIES[cliName];
    if (!aliases || !aliases.has(String(entryName || ''))) return false;
    const linkStat = lstatIfExists(linkPath);
    if (!linkStat || !linkStat.isSymbolicLink()) return false;
    try {
      const managedRoot = fs.realpathSync(path.dirname(targetPath));
      const linkTarget = fs.realpathSync(linkPath);
      const relativeTarget = path.relative(managedRoot, linkTarget);
      return relativeTarget === '' || (
        !path.isAbsolute(relativeTarget)
        && relativeTarget !== '..'
        && !relativeTarget.startsWith(`..${path.sep}`)
      );
    } catch (error) {
      if (error && error.code === 'ENOENT') return false;
      throw error;
    }
  }

  function safeReadJsonFile(filePath) {
    try {
      if (!pathExistsByLstat(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  function removeDirectoryIfEmpty(dirPath) {
    if (!pathExistsByLstat(dirPath)) return 0;
    if (safeReadDirEntries(fs, dirPath).length > 0) return 0;
    fse.removeSync(dirPath);
    return 1;
  }

  function writeJsonFile(filePath, value) {
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
  }

  function readCodexSessionIndexEntries(filePath) {
    const entries = new Map();
    if (!pathExistsByLstat(filePath)) return entries;
    const content = fs.readFileSync(filePath, 'utf8');

    content.split(/\r?\n/).forEach((line) => {
      const trimmed = String(line || '').trim();
      if (!trimmed) return;
      const parsed = JSON.parse(trimmed);
      const id = String(parsed && parsed.id || '').trim();
      if (!id) return;
      const existing = entries.get(id);
      const nextUpdatedAt = Date.parse(parsed.updated_at || '') || 0;
      const existingUpdatedAt = Date.parse(existing && existing.updated_at || '') || 0;
      if (!existing || nextUpdatedAt >= existingUpdatedAt) {
        entries.set(id, parsed);
      }
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
      && pathExistsByLstat(storePath)
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

    if (!changed && pathExistsByLstat(storePath)) return false;
    writeCodexSessionIndexEntries(storePath, storeEntries);
    return true;
  }

  function filesHaveSameContent(leftPath, rightPath) {
    const leftStat = fs.statSync(leftPath);
    const rightStat = fs.statSync(rightPath);
    if (!leftStat.isFile() || !rightStat.isFile() || leftStat.size !== rightStat.size) return false;
    // Large equal-looking files stay unresolved instead of being loaded into
    // memory during an account deletion safety check.
    if (leftStat.size > 16 * 1024 * 1024) return false;
    return fs.readFileSync(leftPath).equals(fs.readFileSync(rightPath));
  }

  function resolveConflictPath(conflictRoot, relativePath) {
    if (!conflictRoot) return '';
    const candidate = path.join(conflictRoot, relativePath);
    if (!pathExistsByLstat(candidate)) return candidate;
    let suffix = 2;
    while (pathExistsByLstat(`${candidate}.${suffix}`)) suffix += 1;
    return `${candidate}.${suffix}`;
  }

  function preserveConflictingEntry(srcPath, options = {}) {
    const conflictPath = resolveConflictPath(options.conflictRoot, options.relativePath);
    if (!conflictPath) return 0;
    ensureDir(path.dirname(conflictPath));
    fse.moveSync(srcPath, conflictPath, { overwrite: false });
    return 1;
  }

  function mergeDirectoryIntoStore(cliName, srcDir, storeDir, options = {}) {
    const entries = readDirEntries(fs, srcDir);
    if (entries.length === 0 && !pathExistsByLstat(srcDir)) return 0;
    ensureDir(storeDir);
    let migrated = 0;

    entries.forEach((entry) => {
      const entryName = entry && entry.name;
      if (!entryName) return;
      const nestedSrcPath = path.join(srcDir, entryName);
      const nestedStorePath = path.join(storeDir, entryName);
      if (entry.isDirectory()) {
        const nestedRelativePath = path.join(options.relativePath || '', entryName);
        const nestedStoreStat = lstatIfExists(nestedStorePath);
        if (nestedStoreStat && !statIfExists(nestedStorePath)?.isDirectory()) {
          migrated += preserveConflictingEntry(nestedSrcPath, {
            ...options,
            relativePath: nestedRelativePath
          });
          return;
        }
        migrated += mergeDirectoryIntoStore(cliName, nestedSrcPath, nestedStorePath, {
          ...options,
          relativePath: nestedRelativePath
        });
        migrated += removeDirectoryIfEmpty(nestedSrcPath);
        return;
      }

      if (entry.isSymbolicLink()) {
        // Never recurse through or copy an untrusted nested link. Leaving it
        // in the projection keeps the enclosing entry unresolved, so account
        // deletion fails closed without touching the external target.
        return;
      }

      if (!pathExistsByLstat(nestedStorePath)) {
        ensureDir(path.dirname(nestedStorePath));
        fse.moveSync(nestedSrcPath, nestedStorePath, { overwrite: true });
        migrated += 1;
        return;
      }

      if (filesHaveSameContent(nestedSrcPath, nestedStorePath)) {
        fse.removeSync(nestedSrcPath);
        migrated += 1;
        return;
      }
      migrated += preserveConflictingEntry(nestedSrcPath, {
        ...options,
        relativePath: path.join(options.relativePath || '', entryName)
      });
    });

    return migrated;
  }

  function mergeEntryIntoStore(cliName, entryName, srcPath, storePath, options = {}) {
    if (!pathExistsByLstat(srcPath)) return 0;
    const preserveOnLink = shouldPreserveEntryOnLink(cliName, entryName);
    const srcStat = fs.lstatSync(srcPath);
    if (!pathExistsByLstat(storePath)) {
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
      const storeStat = statIfExists(storePath);
      if (!storeStat || !storeStat.isDirectory()) {
        return preserveConflictingEntry(srcPath, options);
      }
      const migrated = mergeDirectoryIntoStore(cliName, srcPath, storePath, options);
      let removed = 0;
      if (pathExistsByLstat(srcPath) && safeReadDirEntries(fs, srcPath).length === 0) {
        fse.removeSync(srcPath);
        removed = 1;
      }
      return migrated + removed;
    }

    if (preserveOnLink && fs.statSync(storePath).size === 0 && fs.statSync(srcPath).size > 0) {
      ensureDir(path.dirname(storePath));
      fse.copySync(srcPath, storePath, { overwrite: true, errorOnExist: false });
      fse.removeSync(srcPath);
      return 2;
    }

    if (filesHaveSameContent(srcPath, storePath)) {
      fse.removeSync(srcPath);
      return 1;
    }
    return preserveConflictingEntry(srcPath, options);
  }

  function migrateAndLinkSessionEntry(cliName, entryName, srcPath, storePath, options = {}) {
    let migrated = 0;
    let linked = 0;

    if (
      isManagedLink(srcPath, storePath)
      || isProviderLocalManagedAlias(cliName, entryName, srcPath, storePath)
    ) {
      return { migrated, linked: 1 };
    }

    if (pathExistsByLstat(srcPath)) {
      const srcStat = fs.lstatSync(srcPath);
      if (srcStat.isSymbolicLink()) {
        if (!pointsToManagedTarget(srcPath, storePath)) {
          return { migrated, linked, unresolved: true };
        }
        fs.unlinkSync(srcPath);
        migrated += 1;
      }
      if (!srcStat.isSymbolicLink()) {
        migrated += mergeEntryIntoStore(cliName, entryName, srcPath, storePath, options);
      }
    }

    // Known durable directories must exist before the provider's first run.
    // Otherwise a clean host creates them inside the disposable auth
    // projection and deleting that account can lose the first session.
    if (!pathExistsByLstat(srcPath) && !pathExistsByLstat(storePath)
      && isProviderPrecreatedDirectory(cliName, entryName)) {
      ensureDir(storePath);
    }

    if (pathExistsByLstat(storePath) && !pathExistsByLstat(srcPath)) {
      createManagedLinkSafe(storePath, srcPath, isDirectoryPath(storePath));
      linked += 1;
    }

    return { migrated, linked };
  }

  function normalizeProjectionSegments(segments) {
    return (Array.isArray(segments) ? segments : [])
      .map((segment) => String(segment || '').trim().toLowerCase())
      .filter(Boolean);
  }

  function isProjectionPrefix(candidate, expected) {
    if (candidate.length > expected.length) return false;
    return candidate.every((segment, index) => segment === expected[index]);
  }

  function classifyPrivateProjectionPath(cliName, relativeSegments) {
    const candidate = normalizeProjectionSegments(relativeSegments);
    const privatePaths = [
      ...getProviderAuthArtifacts(cliName),
      ...getProviderPrivateArtifacts(cliName)
    ].map((artifact) => normalizeProjectionSegments(artifact.path));
    const isPrivate = privatePaths.some((expected) => {
      if (candidate.length < expected.length) return false;
      return expected.every((segment, index) => {
        const actual = candidate[index];
        if (index < expected.length - 1) return actual === segment;
        return actual === segment || actual.startsWith(`${segment}.`);
      });
    });
    const containsPrivate = !isPrivate && privatePaths.some((expected) => (
      candidate.length < expected.length && isProjectionPrefix(candidate, expected)
    ));
    return { isPrivate, containsPrivate };
  }

  function resolveProjectionStorePath(cliName, relativeSegments) {
    const candidate = normalizeProjectionSegments(relativeSegments);
    const mapping = getProviderProjectionMappings(cliName).find((item) => {
      const from = normalizeProjectionSegments(item && item.from);
      return isProjectionPrefix(from, candidate);
    });
    if (!mapping) return '';
    const from = normalizeProjectionSegments(mapping.from);
    return path.join(hostHomeDir, ...mapping.to, ...relativeSegments.slice(from.length));
  }

  function containsProjectionMapping(cliName, relativeSegments) {
    const candidate = normalizeProjectionSegments(relativeSegments);
    return getProviderProjectionMappings(cliName).some((item) => {
      const from = normalizeProjectionSegments(item && item.from);
      return from.length > candidate.length && isProjectionPrefix(candidate, from);
    });
  }

  function classifyNonFallbackProjectionMapping(cliName, relativeSegments) {
    const candidate = normalizeProjectionSegments(relativeSegments);
    let containsMapping = false;
    let ownedByMapping = false;
    getProviderProjectionMappings(cliName).forEach((item) => {
      const from = normalizeProjectionSegments(item && item.from);
      if (from.length === 0) return;
      if (candidate.length < from.length && isProjectionPrefix(candidate, from)) {
        containsMapping = true;
      } else if (isProjectionPrefix(from, candidate)) {
        ownedByMapping = true;
      }
    });
    return { containsMapping, ownedByMapping };
  }

  function projectProviderFallbackEntries(
    cliName,
    projectionRoot,
    migrationOptions = {}
  ) {
    const summary = { migrated: 0, linked: 0, unresolved: [] };
    const fallback = getProviderProjectionMappings(cliName).find((item) => (
      normalizeProjectionSegments(item && item.from).length === 0
    ));
    if (!fallback) return summary;
    const storeRoot = path.join(hostHomeDir, ...fallback.to);
    if (!pathExistsByLstat(storeRoot)) return summary;

    const visit = (storeDirectory, sourceDirectory, relativeSegments) => {
      for (const entry of readDirEntries(fs, storeDirectory)) {
        const name = String(entry && entry.name || '').trim();
        if (!name) continue;
        const nextSegments = [...relativeSegments, name];
        const mapping = classifyNonFallbackProjectionMapping(cliName, nextSegments);
        if (mapping.ownedByMapping) continue;

        const classification = classifyPrivateProjectionPath(cliName, nextSegments);
        if (classification.isPrivate) continue;
        const storePath = path.join(storeDirectory, name);
        const sourcePath = path.join(sourceDirectory, name);
        const relativePath = path.join(...nextSegments);

        if (classification.containsPrivate || mapping.containsMapping) {
          if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
          ensureProjectionDirectory(projectionRoot, sourcePath);
          visit(storePath, sourcePath, nextSegments);
          continue;
        }

        const result = migrateAndLinkSessionEntry(cliName, name, sourcePath, storePath, {
          ...migrationOptions,
          relativePath: path.join('projection-fallback', relativePath)
        });
        summary.migrated += result.migrated;
        summary.linked += result.linked;
        addUnresolvedEntry(summary.unresolved, relativePath, sourcePath, storePath);
      }
    };

    visit(storeRoot, projectionRoot, []);
    summary.unresolved = Array.from(new Set(summary.unresolved.filter(Boolean)));
    return summary;
  }

  function reconcileProjectionResources(cliName, accountRef, migrationOptions = {}, runtime = {}) {
    const projectionRoot = getProjectionRoot(cliName, accountRef, runtime);
    const summary = { migrated: 0, linked: 0, unresolved: [] };
    if (!projectionRoot) return summary;
    const config = cliConfigs[cliName] || {};
    const handledToolRoot = normalizeProjectionSegments([
      config.globalDir || `.${cliName}`,
      config.configSubDir
    ]);

    const visit = (directoryPath, relativeSegments) => {
      for (const entry of readDirEntries(fs, directoryPath)) {
        const name = String(entry && entry.name || '').trim();
        if (!name) continue;
        const nextSegments = [...relativeSegments, name];
        const relativePath = path.join(...nextSegments);
        const srcPath = path.join(directoryPath, name);
        if (
          cliName !== 'opencode'
          && handledToolRoot.length > 0
          && normalizeProjectionSegments(nextSegments).length === handledToolRoot.length
          && isProjectionPrefix(normalizeProjectionSegments(nextSegments), handledToolRoot)
        ) {
          continue;
        }
        const classification = classifyPrivateProjectionPath(cliName, nextSegments);
        if (classification.isPrivate) continue;

        if (classification.containsPrivate || containsProjectionMapping(cliName, nextSegments)) {
          if (entry.isSymbolicLink() || !entry.isDirectory()) {
            summary.unresolved.push(relativePath);
          } else {
            visit(srcPath, nextSegments);
          }
          continue;
        }

        const storePath = resolveProjectionStorePath(cliName, nextSegments);
        if (!storePath) {
          summary.unresolved.push(relativePath);
          continue;
        }
        if (entry.isSymbolicLink() && !isManagedLink(srcPath, storePath)) {
          summary.unresolved.push(relativePath);
          continue;
        }
        const result = migrateAndLinkSessionEntry(cliName, name, srcPath, storePath, {
          ...migrationOptions,
          relativePath: path.join('projection-root', relativePath)
        });
        summary.migrated += result.migrated;
        summary.linked += result.linked;
        addUnresolvedEntry(summary.unresolved, relativePath, srcPath, storePath);
      }
    };

    visit(projectionRoot, []);
    const fallbackResult = projectProviderFallbackEntries(
      cliName,
      projectionRoot,
      migrationOptions
    );
    summary.migrated += fallbackResult.migrated;
    summary.linked += fallbackResult.linked;
    summary.unresolved.push(...fallbackResult.unresolved);
    summary.unresolved = Array.from(new Set(summary.unresolved.filter(Boolean)));
    return summary;
  }

  function ensureConfigDirSessionStoreLinks(cliName, toolConfigDir, storeRoot, entryNames = null, options = {}) {
    const summary = { migrated: 0, linked: 0 };
    const entries = Array.isArray(entryNames)
      ? entryNames
      : getSessionEntriesForStore(cliName, toolConfigDir);

    entries.forEach((entryName) => {
      if (!shouldShareToolConfigEntry(cliName, entryName)) return;
      const srcPath = path.join(toolConfigDir, entryName);
      const storePath = path.join(storeRoot, entryName);
      const res = migrateAndLinkSessionEntry(cliName, entryName, srcPath, storePath, {
        ...options,
        relativePath: entryName
      });
      summary.migrated += res.migrated;
      summary.linked += res.linked;
    });

    return summary;
  }

  function collectUnresolvedSessionEntries(cliName, toolConfigDir, storeRoot) {
    return getSessionEntriesForStore(cliName, toolConfigDir)
      .filter((entryName) => shouldShareToolConfigEntry(cliName, entryName))
      .filter((entryName) => {
        const srcPath = path.join(toolConfigDir, entryName);
        if (!pathExistsByLstat(srcPath)) return false;
        const storePath = path.join(storeRoot, entryName);
        return !isManagedLink(srcPath, storePath)
          && !isProviderLocalManagedAlias(cliName, entryName, srcPath, storePath);
      });
  }

  function addUnresolvedEntry(unresolved, label, srcPath, storePath) {
    if (!pathExistsByLstat(srcPath) || isManagedLink(srcPath, storePath)) return;
    unresolved.push(label);
  }

  function resolveLinkTarget(linkPath) {
    return path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
  }

  function migrateLegacyHostLibraryAlias(
    projectionRoot,
    runtimeHome,
    entryName,
    summary
  ) {
    const sourcePath = path.join(projectionRoot, 'Library', entryName);
    const sourceStat = lstatIfExists(sourcePath);
    if (!sourceStat || !sourceStat.isSymbolicLink()) return;

    const targetPath = path.join(runtimeHome, 'Library', entryName);
    if (isManagedLink(sourcePath, targetPath)) return;
    const legacyTarget = path.join(hostHomeDir, 'Library', entryName);
    if (normalizePathForLinkCompare(resolveLinkTarget(sourcePath)) !== normalizePathForLinkCompare(legacyTarget)) {
      summary.unresolved.push(path.join('Library', entryName));
      return;
    }

    ensureDir(targetPath);
    if (statIfExists(legacyTarget)?.isDirectory()) {
      // Older releases linked the whole host Preferences directory into every
      // fake HOME. Copy that snapshot once before replacing the alias: nothing
      // is removed from the host, and historical provider reads remain valid.
      fse.copySync(legacyTarget, targetPath, {
        overwrite: false,
        errorOnExist: false,
        dereference: false
      });
      summary.migrated += 1;
    }
    fs.unlinkSync(sourcePath);
    createManagedLinkSafe(targetPath, sourcePath, true);
    summary.linked += 1;
  }

  function detachLegacyPrivateLibraryAlias(projectionRoot, entryName, summary) {
    const sourcePath = path.join(projectionRoot, 'Library', entryName);
    const sourceStat = lstatIfExists(sourcePath);
    if (!sourceStat || !sourceStat.isSymbolicLink()) return;
    const legacyTarget = path.join(hostHomeDir, 'Library', entryName);
    if (normalizePathForLinkCompare(resolveLinkTarget(sourcePath)) !== normalizePathForLinkCompare(legacyTarget)) {
      summary.unresolved.push(path.join('Library', entryName));
      return;
    }
    fs.unlinkSync(sourcePath);
    summary.migrated += 1;
  }

  function prepareProviderRuntimeHome(cliName, accountRef, migrationOptions, runtime = {}) {
    const summary = { migrated: 0, linked: 0, unresolved: [] };
    const projectionRoot = getProjectionRoot(cliName, accountRef, runtime);
    const runtimeHome = resolveProviderRuntimeHomeRoot(hostHomeDir, cliName, path);
    if (!projectionRoot || !runtimeHome) {
      summary.unresolved.push('runtime-home');
      return summary;
    }
    assertProjectionPathHasNoSymlinks(
      projectionRoot,
      path.join(projectionRoot, 'Library')
    );
    ensureDir(runtimeHome);
    if (cliName === 'agy') {
      ['config', 'data', 'state', 'cache'].forEach((name) => {
        ensureDir(path.join(runtimeHome, 'xdg', name));
      });
      AGY_SHARED_LIBRARY_DIRECTORIES.forEach((name) => {
        ensureDir(path.join(runtimeHome, 'Library', name));
      });
      ensureDir(path.join(runtimeHome, 'AppData', 'Roaming'));
      ensureDir(path.join(runtimeHome, 'AppData', 'Local'));
    }

    migrateLegacyHostLibraryAlias(
      projectionRoot,
      runtimeHome,
      'Preferences',
      summary
    );
    detachLegacyPrivateLibraryAlias(projectionRoot, 'Keychains', summary);
    if (cliName === 'agy') {
      const projectionLibraryRoot = path.join(projectionRoot, 'Library');
      ensureProjectionDirectory(projectionRoot, projectionLibraryRoot);
      AGY_SHARED_LIBRARY_DIRECTORIES.forEach((entryName) => {
        const sourcePath = path.join(projectionLibraryRoot, entryName);
        const targetPath = path.join(runtimeHome, 'Library', entryName);
        const result = migrateAndLinkSessionEntry(
          cliName,
          entryName,
          sourcePath,
          targetPath,
          {
            ...migrationOptions,
            relativePath: path.join('runtime-home', 'Library', entryName)
          }
        );
        summary.migrated += result.migrated;
        summary.linked += result.linked;
        if (result.unresolved) summary.unresolved.push(path.join('Library', entryName));
      });
    }

    return summary;
  }

  function detachAccountOwnedEntry(srcPath, storePath) {
    const srcStat = lstatIfExists(srcPath);
    if (!srcStat) return 0;
    const isSharedLink = srcStat.isSymbolicLink();
    const isSharedHardLink = !isSharedLink
      && storePath
      && pathExistsByLstat(storePath)
      && isSameFilesystemEntry(srcPath, storePath);

    if (!isSharedLink && !isSharedHardLink) return 0;

    if (srcStat.isSymbolicLink()) {
      const targetStat = statIfExists(srcPath);
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

  function listCodexDesktopRuntimeHomes(accountRef = '') {
    const aiHomeDir = getAiHomeDir();
    const expectedAccountRef = String(accountRef || '').trim();
    const runtimeRoot = aiHomeDir ? path.join(aiHomeDir, 'run', 'codex-desktop') : '';
    if (!runtimeRoot) return [];
    const entries = readDirEntries(fs, runtimeRoot);
    return entries
      .filter((entry) => entry && entry.isDirectory() && /^acct_[a-f0-9]{20}$/.test(entry.name))
      .filter((entry) => !expectedAccountRef || entry.name === expectedAccountRef)
      .map((entry) => path.join(runtimeRoot, entry.name));
  }

  function ensureCodexDesktopRuntimeStoreLinks(accountRef) {
    const summary = { migrated: 0, linked: 0, unresolved: [] };
    const storeRoot = getSessionStoreRoot('codex');
    ensureDir(storeRoot);

    listCodexDesktopRuntimeHomes(accountRef).forEach((runtimeHome) => {
      const entries = getSessionEntriesForStore('codex', runtimeHome);
      const migrationOptions = {
        conflictRoot: path.join(
          storeRoot,
          MIGRATION_CONFLICT_DIR,
          'codex-desktop',
          path.basename(runtimeHome)
        )
      };
      entries.forEach((entryName) => {
        const srcPath = path.join(runtimeHome, entryName);
        const storePath = path.join(storeRoot, entryName);
        const res = migrateAndLinkSessionEntry('codex', entryName, srcPath, storePath, {
          ...migrationOptions,
          relativePath: entryName
        });
        summary.migrated += res.migrated;
        summary.linked += res.linked;
      });
      collectUnresolvedSessionEntries('codex', runtimeHome, storeRoot).forEach((entryName) => {
        summary.unresolved.push(`codex-desktop/${entryName}`);
      });
    });

    return summary;
  }

  function ensureSessionStoreLinks(cliName, accountRef, runtime = {}) {
    const projectionRoot = getProjectionRoot(cliName, accountRef, runtime);
    const toolConfigDir = getProjectionToolConfigDir(cliName, accountRef, runtime);
    const explicitProjection = Boolean(String(runtime && runtime.projectionRoot || '').trim());
    const projectionExists = projectionRoot && pathExistsByLstat(projectionRoot);

    if (!projectionExists && !explicitProjection) {
      if (cliName === 'claude') return { migrated: 0, linked: 0 };
      try {
        const accountEnv = readAccountCredentials(fs, getAiHomeDir(), accountRef);
        if (!requiresProviderAuthProjection(cliName, accountEnv)) {
          return { migrated: 0, linked: 0 };
        }
      } catch (_error) {
        // Missing DB credentials fall through to native-auth projection setup.
      }
    }

    ensureProjectionDirectory(projectionRoot, projectionRoot);
    const storeRoot = getSessionStoreRoot(cliName);
    ensureDir(storeRoot);
    const conflictLabel = String(accountRef || '').trim() || 'unknown-projection';
    const migrationOptions = {
      conflictRoot: path.join(storeRoot, MIGRATION_CONFLICT_DIR, conflictLabel)
    };
    let migrated = 0;
    let linked = 0;
    const conflicts = [];
    const unresolved = [];

    const runtimeHomeResult = prepareProviderRuntimeHome(
      cliName,
      accountRef,
      migrationOptions,
      runtime
    );
    migrated += runtimeHomeResult.migrated;
    linked += runtimeHomeResult.linked;
    unresolved.push(...runtimeHomeResult.unresolved);

    if (cliName === 'opencode') {
      const result = reconcileOpenCodeSharedData({
        fs,
        path,
        sandboxDir: projectionRoot,
        hostHomeDir
      });
      migrated += Number(result && result.migrated) || 0;
      linked += Number(result && result.linked) || 0;
      if (Array.isArray(result && result.conflicts)) conflicts.push(...result.conflicts);
      if (Array.isArray(result && result.unresolved)) unresolved.push(...result.unresolved);
    } else {
      ensureToolConfigDir(projectionRoot, toolConfigDir);
      let toolConfigIsStoreRoot = false;
      try {
        toolConfigIsStoreRoot = normalizePathForLinkCompare(fs.realpathSync(toolConfigDir))
          === normalizePathForLinkCompare(fs.realpathSync(storeRoot));
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error;
      }

      if (!toolConfigIsStoreRoot) {
        migrated += detachAccountOwnedEntries(cliName, toolConfigDir, storeRoot);
        const mainResult = ensureConfigDirSessionStoreLinks(
          cliName,
          toolConfigDir,
          storeRoot,
          null,
          migrationOptions
        );
        migrated += mainResult.migrated;
        linked += mainResult.linked;
        unresolved.push(...collectUnresolvedSessionEntries(cliName, toolConfigDir, storeRoot));
      }

      if (cliName === 'codex' && !explicitProjection) {
        const desktopResult = ensureCodexDesktopRuntimeStoreLinks(accountRef);
        migrated += desktopResult.migrated;
        linked += desktopResult.linked;
        unresolved.push(...desktopResult.unresolved);
      }

      if (cliName === 'agy') {
        const parentToolConfigDir = path.join(projectionRoot, '.gemini');
        const parentStoreRoot = path.join(hostHomeDir, '.gemini');
        const guestConfigDir = path.join(parentToolConfigDir, 'config');
        const hostConfigDir = path.join(parentStoreRoot, 'config');
        ensureDir(hostConfigDir);
        ensureDir(guestConfigDir);
        const configResult = migrateAndLinkSessionEntry(
          cliName,
          'config',
          guestConfigDir,
          hostConfigDir,
          {
            ...migrationOptions,
            relativePath: path.join('parent-gemini', 'config')
          }
        );
        migrated += configResult.migrated;
        linked += configResult.linked;

        // AGY reads $HOME/.gemini/GEMINI.md while HOME remains account-scoped
        // for OAuth isolation. Keep the instruction file provider-shared and
        // expose only a link from the disposable projection.
        const guestInstructionPath = path.join(parentToolConfigDir, 'GEMINI.md');
        const hostInstructionPath = path.join(parentStoreRoot, 'GEMINI.md');
        if (!pathExistsByLstat(guestInstructionPath) && !pathExistsByLstat(hostInstructionPath)) {
          fs.writeFileSync(hostInstructionPath, '', 'utf8');
        }
        const instructionResult = migrateAndLinkSessionEntry(
          cliName,
          'GEMINI.md',
          guestInstructionPath,
          hostInstructionPath,
          {
            ...migrationOptions,
            relativePath: path.join('parent-gemini', 'GEMINI.md')
          }
        );
        migrated += instructionResult.migrated;
        linked += instructionResult.linked;
      }
    }

    const projectionResult = reconcileProjectionResources(
      cliName,
      accountRef,
      migrationOptions,
      runtime
    );
    migrated += projectionResult.migrated;
    linked += projectionResult.linked;
    unresolved.push(...projectionResult.unresolved);

    const result = { migrated, linked };
    if (conflicts.length > 0) result.conflicts = Array.from(new Set(conflicts));
    if (unresolved.length > 0) result.unresolved = Array.from(new Set(unresolved.filter(Boolean)));
    return result;
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
