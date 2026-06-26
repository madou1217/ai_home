'use strict';

const { resolveAccountImporter } = require('../ai-cli/importers');
const { collectCredentialRelativePaths } = require('../../../account/credential-layout');
const {
  buildApiKeyIdentity,
  buildOAuthIdentity,
  extractApiKeyConfig,
  flattenImportRecords,
  inferImportProvider,
  normalizeCodexAuthPayload,
  parseManualImportText
} = require('../../../account/transfer-core');
const {
  importStandardAccountRecords,
  parseStandardAccountRecordsFromJson
} = require('../../../account/standard-transfer');

const {
  mapProgressRange,
  formatBytes,
  ensureArchiveExtractedByHash
} = require('../backup/archive-import');

function createUnifiedImportService(options = {}) {
  const {
    fs,
    path,
    os,
    fse,
    execSync,
    spawnImpl,
    processImpl,
    cryptoImpl,
    aiHomeDir,
    cliConfigs,
    getDefaultParallelism = () => 1,
    runGlobalAccountImport,
    importCliproxyapiCodexAuths,
    parseCodexBulkImportArgs,
    importCodexTokensFromOutput,
    getToolAccountIds,
    getProfileDir,
    getToolConfigDir,
    accountArtifactHooks,
    ensureArchiveExtractedByHashImpl = ensureArchiveExtractedByHash
  } = options;

  function directoryExists(targetPath) {
    try {
      return fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory();
    } catch (_error) {
      return false;
    }
  }

  function isZipFile(targetPath) {
    try {
      return fs.existsSync(targetPath) && fs.statSync(targetPath).isFile() && /\.zip$/i.test(String(targetPath || ''));
    } catch (_error) {
      return false;
    }
  }

  function isJsonFile(targetPath) {
    try {
      return fs.existsSync(targetPath) && fs.statSync(targetPath).isFile() && /\.json$/i.test(String(targetPath || ''));
    } catch (_error) {
      return false;
    }
  }

  function isTextImportFile(targetPath) {
    try {
      return fs.existsSync(targetPath) && fs.statSync(targetPath).isFile() && /\.(jsonl|txt)$/i.test(String(targetPath || ''));
    } catch (_error) {
      return false;
    }
  }

  function isTextImportFileName(name) {
    return /\.(jsonl|txt)$/i.test(String(name || ''));
  }

  function listChildDirectories(targetPath) {
    if (!directoryExists(targetPath)) return [];
    try {
      return fs.readdirSync(targetPath, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => String(entry.name || '').trim())
        .filter(Boolean);
    } catch (_error) {
      return [];
    }
  }

  function hasProviderAccountMaterial(targetPath, provider) {
    const safeProvider = String(provider || '').trim().toLowerCase();
    if (!safeProvider || !directoryExists(targetPath)) return false;
    const credentialPaths = collectCredentialRelativePaths(safeProvider);

    if (credentialPaths.some((relFile) => isRegularFile(path.join(targetPath, relFile)))) return true;

    let entries = [];
    try {
      entries = fs.readdirSync(targetPath, { withFileTypes: true });
    } catch (_error) {
      return false;
    }

    return entries.some((entry) => {
      if (!entry.isDirectory()) return false;
      return credentialPaths.some((relFile) => isRegularFile(path.join(targetPath, entry.name, relFile)));
    });
  }

  function normalizeFolderHint(rawValue) {
    const normalized = String(rawValue || '').trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
    if (!normalized) throw new Error('Missing value for -f/--folder');
    if (path.isAbsolute(normalized)) throw new Error('Folder hint must be a relative path inside zip');
    if (normalized.split('/').includes('..')) throw new Error('Folder hint cannot contain ".."');
    return normalized;
  }

  function buildMappingRoot(sourceDir, suffix = '__aih_import_root') {
    const normalized = path.resolve(String(sourceDir || ''));
    const parentDir = path.dirname(normalized);
    const baseName = path.basename(normalized) || 'root';
    return path.join(parentDir, `${baseName}.${suffix}`);
  }

  function mapSourceDirAsProviderRoot(sourceDir, provider) {
    const safeProvider = String(provider || '').trim().toLowerCase();
    const mappedRoot = buildMappingRoot(sourceDir);
    const mappedProviderDir = path.join(mappedRoot, safeProvider);
    if (directoryExists(mappedRoot)) fse.removeSync(mappedRoot);
    fse.ensureDirSync(mappedRoot);
    fse.copySync(sourceDir, mappedProviderDir, { overwrite: true });
    return { sourceRoot: mappedRoot };
  }

  function isProviderToken(value) {
    const key = String(value || '').trim().toLowerCase();
    return !!(key && cliConfigs && cliConfigs[key]);
  }

  function isNumericAccountId(value) {
    return /^\d+$/.test(String(value || '').trim());
  }

  function isRegularFile(filePath) {
    try {
      return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
    } catch (_error) {
      return false;
    }
  }

  function readJsonFileSafe(filePath) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_error) {
      return null;
    }
  }

  function jsonFileHasStandardImportRecords(filePath, provider = '') {
    const payload = readJsonFileSafe(filePath);
    if (!payload) return false;
    const safeProvider = String(provider || '').trim().toLowerCase();
    const records = parseStandardAccountRecordsFromJson(payload)
      .filter((record) => {
        if (!safeProvider) return true;
        return inferImportProvider(record) === safeProvider;
      });
    return records.length > 0;
  }

  function listStandardJsonImportFiles(targetPath, parsed) {
    if (!directoryExists(targetPath)) return [];
    let entries = [];
    try {
      entries = fs.readdirSync(targetPath, { withFileTypes: true });
    } catch (_error) {
      return [];
    }
    return entries
      .filter((entry) => entry.isFile() && /\.json$/i.test(String(entry.name || '')))
      .map((entry) => path.join(targetPath, entry.name))
      .filter((filePath) => jsonFileHasStandardImportRecords(filePath, parsed && parsed.provider))
      .sort((a, b) => a.localeCompare(b));
  }

  function directoryHasProviderLayout(targetPath) {
    if (!directoryExists(targetPath)) return false;
    const accountsDir = path.join(targetPath, 'accounts');
    if (directoryExists(accountsDir) && listChildDirectories(accountsDir).some((name) => isProviderToken(name))) {
      return true;
    }
    return listChildDirectories(targetPath).some((name) => isProviderToken(name));
  }

  function isCodexImportRecord(record) {
    if (!record || typeof record !== 'object' || inferImportProvider(record) !== 'codex') return false;
    const apiKeyConfig = extractApiKeyConfig('codex', record);
    if (buildApiKeyIdentity('codex', apiKeyConfig)) return true;
    const auth = normalizeCodexAuthPayload(record);
    return Boolean(auth && buildOAuthIdentity('codex', auth));
  }

  function jsonFileHasRawCodexImportMaterial(filePath) {
    const payload = readJsonFileSafe(filePath);
    if (!payload) return false;
    const records = flattenImportRecords(payload);
    return records.length > 0 && records.every(isCodexImportRecord);
  }

  function textFileHasImportRecords(filePath) {
    try {
      return parseManualImportText(fs.readFileSync(filePath, 'utf8')).length > 0;
    } catch (_error) {
      return false;
    }
  }

  function directoryHasRawCodexImportMaterial(targetPath, optionsArg = {}) {
    const recursive = !!optionsArg.recursive;
    const maxJsonFiles = Math.max(1, Number(optionsArg.maxJsonFiles) || 128);
    if (!directoryExists(targetPath)) return false;

    const pending = [targetPath];
    let scannedJsonFiles = 0;
    while (pending.length > 0 && scannedJsonFiles < maxJsonFiles) {
      const currentDir = pending.pop();
      let entries = [];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch (_error) {
        continue;
      }
      entries.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
      for (const entry of entries) {
        const entryPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          if (recursive) pending.push(entryPath);
          continue;
        }
        if (!entry.isFile() || !/\.json$/i.test(String(entry.name || ''))) continue;
        scannedJsonFiles += 1;
        if (jsonFileHasRawCodexImportMaterial(entryPath)) return true;
        if (scannedJsonFiles >= maxJsonFiles) break;
      }
    }
    return false;
  }

  function resolveCodexRawImportSourceDir(baseDir) {
    if (directoryHasRawCodexImportMaterial(baseDir)) return baseDir;
    const childMatches = listChildDirectories(baseDir)
      .map((name) => path.join(baseDir, name))
      .filter((dir) => directoryHasRawCodexImportMaterial(dir, { recursive: true }));
    if (childMatches.length === 1) return childMatches[0];
    if (childMatches.length > 1) return baseDir;
    return directoryHasRawCodexImportMaterial(baseDir, { recursive: true }) ? baseDir : '';
  }

  function listImportableProviderNames(sourceRoot) {
    return listChildDirectories(sourceRoot)
      .map((name) => String(name || '').trim().toLowerCase())
      .filter((name) => {
        if (!isProviderToken(name)) return false;
        if (typeof resolveAccountImporter(name) === 'function') return true;
        return hasProviderAccountMaterial(path.join(sourceRoot, name), name);
      });
  }

  function listCredentialAccountDirs(sourceDir) {
    const baseName = path.basename(String(sourceDir || ''));
    if (isNumericAccountId(baseName)) {
      return [{ id: baseName, dir: sourceDir }];
    }
    if (!directoryExists(sourceDir)) return [];
    return fs.readdirSync(sourceDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isNumericAccountId(entry.name))
      .map((entry) => ({
        id: String(entry.name),
        dir: path.join(sourceDir, entry.name)
      }))
      .sort((a, b) => Number(a.id) - Number(b.id));
  }

  function copyCredentialFiles(sourceAccountDir, targetAccountDir, provider, dryRun) {
    const relFiles = collectCredentialRelativePaths(provider)
      .filter((relFile) => isRegularFile(path.join(sourceAccountDir, relFile)));
    if (relFiles.length === 0) return 0;
    if (dryRun) return relFiles.length;
    relFiles.forEach((relFile) => {
      const src = path.join(sourceAccountDir, relFile);
      const dst = path.join(targetAccountDir, relFile);
      fse.ensureDirSync(path.dirname(dst));
      fse.copySync(src, dst, { overwrite: true });
    });
    return relFiles.length;
  }

  function hasGlobPattern(value) {
    return /[*?\[]/.test(String(value || ''));
  }

  function escapeRegexChar(value) {
    return String(value || '').replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }

  function makeGlobSegmentMatcher(segment) {
    const source = String(segment || '');
    let pattern = '^';
    for (let i = 0; i < source.length; i += 1) {
      const char = source[i];
      if (char === '*') {
        pattern += '[^\\\\/]*';
        continue;
      }
      if (char === '?') {
        pattern += '[^\\\\/]';
        continue;
      }
      pattern += escapeRegexChar(char);
    }
    pattern += '$';
    return new RegExp(pattern);
  }

  function expandGlobSource(rawSource) {
    const source = String(rawSource || '').trim();
    if (!source || !hasGlobPattern(source)) return [source];

    const normalized = path.normalize(source);
    const absolute = path.resolve(normalized);
    const parsedPath = path.parse(absolute);
    const root = parsedPath.root || '';
    const relative = absolute.slice(root.length);
    const segments = relative.split(path.sep).filter(Boolean);
    if (segments.length === 0) return [];

    let baseDir = root || path.resolve('.');
    let firstGlobIndex = segments.findIndex((segment) => hasGlobPattern(segment));
    if (firstGlobIndex < 0) return [absolute];
    for (let i = 0; i < firstGlobIndex; i += 1) {
      baseDir = path.join(baseDir, segments[i]);
    }
    if (!directoryExists(baseDir)) return [];

    let candidates = [baseDir];
    for (let index = firstGlobIndex; index < segments.length; index += 1) {
      const matcher = makeGlobSegmentMatcher(segments[index]);
      const isLast = index === segments.length - 1;
      const next = [];
      candidates.forEach((candidateDir) => {
        let entries = [];
        try {
          entries = fs.readdirSync(candidateDir, { withFileTypes: true });
        } catch (_error) {
          return;
        }
        entries.forEach((entry) => {
          if (!matcher.test(String(entry.name || ''))) return;
          const entryPath = path.join(candidateDir, entry.name);
          if (isLast) {
            next.push(entryPath);
            return;
          }
          if (entry.isDirectory()) {
            next.push(entryPath);
          }
        });
      });
      candidates = Array.from(new Set(next.map((item) => path.resolve(item)))).sort((a, b) => a.localeCompare(b));
      if (candidates.length === 0) break;
    }

    return candidates;
  }

  function normalizeJobsValue(rawValue) {
    const text = String(rawValue || '').trim();
    if (!/^\d+$/.test(text)) {
      throw new Error('Invalid jobs value. Usage: -j <number>');
    }
    return Math.max(1, Number(text));
  }

  function createConcurrencyLimiter(maxConcurrency) {
    const limit = Math.max(1, Number(maxConcurrency) || 1);
    let active = 0;
    const queue = [];

    const next = () => {
      if (active >= limit) return;
      const job = queue.shift();
      if (!job) return;
      active += 1;
      Promise.resolve()
        .then(job.run)
        .then(job.resolve, job.reject)
        .finally(() => {
          active -= 1;
          next();
        });
    };

    return {
      run(task) {
        return new Promise((resolve, reject) => {
          queue.push({ run: task, resolve, reject });
          next();
        });
      },
      getActiveCount() {
        return active;
      },
      getPendingCount() {
        return queue.length;
      }
    };
  }

  function computeZipPrepareConcurrency(totalBudget) {
    const budget = Math.max(1, Number(totalBudget) || 1);
    const platform = String(processImpl && processImpl.platform || process.platform || '').toLowerCase();
    if (platform === 'win32') {
      return Math.max(2, Math.min(8, Math.ceil(Math.sqrt(budget))));
    }
    return Math.max(2, Math.min(16, Math.ceil(Math.sqrt(budget * 2))));
  }

  function parseUnifiedImportArgs(rawArgs, fixedProvider = '') {
    const tokens = Array.isArray(rawArgs) ? rawArgs.slice() : [];
    const sources = [];
    let provider = String(fixedProvider || '').trim().toLowerCase();
    let dryRun = false;
    let folder = '';
    let jobs = Math.max(1, Number(getDefaultParallelism()) || 1);

    for (let i = 0; i < tokens.length; i += 1) {
      const arg = String(tokens[i] || '').trim();
      if (!arg) continue;
      if (arg === '--dry-run') {
        dryRun = true;
        continue;
      }
      if (arg === '-f' || arg === '--folder' || arg === '--from') {
        folder = normalizeFolderHint(tokens[i + 1]);
        i += 1;
        continue;
      }
      if (arg === '-j') {
        jobs = normalizeJobsValue(tokens[i + 1]);
        i += 1;
        continue;
      }
      if (/^-j\d+$/.test(arg)) {
        jobs = normalizeJobsValue(arg.slice(2));
        continue;
      }
      if (arg.startsWith('--folder=')) {
        folder = normalizeFolderHint(arg.slice('--folder='.length));
        continue;
      }
      if (arg.startsWith('--from=')) {
        folder = normalizeFolderHint(arg.slice('--from='.length));
        continue;
      }
      if (!provider && isProviderToken(arg) && i + 1 < tokens.length) {
        provider = arg.toLowerCase();
        continue;
      }
      if (arg.startsWith('-')) {
        throw new Error(`Unknown option: ${arg}`);
      }
      sources.push(arg);
    }

    if (sources.length === 0) {
      sources.push('accounts');
    }

    return {
      provider,
      dryRun,
      folder,
      jobs,
      sources
    };
  }

  function resolveImportSourceRoot({ extractDir, provider, folderHint }) {
    const safeProvider = String(provider || '').trim().toLowerCase();
    const providerMode = safeProvider && isProviderToken(safeProvider);
    const hint = String(folderHint || '').trim();
    const baseDir = hint ? path.join(extractDir, hint) : extractDir;

    if (!directoryExists(baseDir)) {
      throw new Error(`Import folder not found: ${hint || baseDir}`);
    }

    if (providerMode) {
      const candidateProviderDirs = [
        path.join(baseDir, 'accounts', safeProvider),
        path.join(baseDir, safeProvider),
        baseDir
      ].filter(Boolean);
      const providerDir = candidateProviderDirs.find((dir) => directoryExists(dir) && hasProviderAccountMaterial(dir, safeProvider));
      if (!providerDir) {
        throw new Error(`Provider folder not found: ${safeProvider}`);
      }

      if (path.basename(providerDir) === safeProvider) {
        return { sourceRoot: path.dirname(providerDir) };
      }

      return mapSourceDirAsProviderRoot(providerDir, safeProvider);
    }

    const candidateRoots = [
      path.join(baseDir, 'accounts'),
      baseDir
    ];
    for (const root of candidateRoots) {
      if (!directoryExists(root)) continue;
      const subdirs = listChildDirectories(root);
      if (subdirs.length === 0) continue;
      if (subdirs.some((name) => isProviderToken(name))) {
        return { sourceRoot: root };
      }
      if (path.basename(root) && isProviderToken(path.basename(root))) {
        return mapSourceDirAsProviderRoot(root, path.basename(root));
      }
    }

    const codexRawSourceDir = resolveCodexRawImportSourceDir(baseDir);
    if (codexRawSourceDir) {
      return mapSourceDirAsProviderRoot(codexRawSourceDir, 'codex');
    }

    throw new Error('Import source does not contain importable provider directories.');
  }

  function isImportableDirectoryRoot(targetPath, provider = '') {
    const safeProvider = String(provider || '').trim().toLowerCase();
    if (!directoryExists(targetPath)) return false;

    if (safeProvider && isProviderToken(safeProvider)) {
      const accountsProviderDir = path.join(targetPath, 'accounts', safeProvider);
      if (directoryExists(accountsProviderDir) && hasProviderAccountMaterial(accountsProviderDir, safeProvider)) return true;
      const nestedProviderDir = path.join(targetPath, safeProvider);
      if (directoryExists(nestedProviderDir) && hasProviderAccountMaterial(nestedProviderDir, safeProvider)) return true;
      if (safeProvider === 'codex' && directoryHasRawCodexImportMaterial(targetPath)) return true;
      return hasProviderAccountMaterial(targetPath, safeProvider);
    }

    const accountsDir = path.join(targetPath, 'accounts');
    if (directoryExists(accountsDir)) {
      const accountProviders = listChildDirectories(accountsDir);
      if (accountProviders.some((name) => isProviderToken(name))) {
        return true;
      }
    }

    const directProviders = listChildDirectories(targetPath);
    if (directProviders.some((name) => isProviderToken(name))) {
      return true;
    }

    if (isProviderToken(path.basename(targetPath).toLowerCase())) return true;
    return directoryHasRawCodexImportMaterial(targetPath);
  }

  function classifySource(rawSource) {
    const source = String(rawSource || '').trim();
    if (!source) throw new Error('Empty import source is not allowed.');
    if (source.toLowerCase() === 'cliproxyapi') {
      return {
        kind: 'cliproxyapi',
        source,
        display: 'cliproxyapi'
      };
    }
    const resolvedPath = path.resolve(source);
    if (isZipFile(resolvedPath)) {
      return { kind: 'zip', source: resolvedPath, display: resolvedPath };
    }
    if (isJsonFile(resolvedPath)) {
      return { kind: 'json', source: resolvedPath, display: resolvedPath };
    }
    if (isTextImportFile(resolvedPath)) {
      return { kind: 'text', source: resolvedPath, display: resolvedPath };
    }
    if (directoryExists(resolvedPath)) {
      return { kind: 'directory', source: resolvedPath, display: resolvedPath };
    }
    throw new Error(`Import source not found: ${source}`);
  }

  function discoverNestedSourcesFromDirectory(rootDir, parsed, onProgress) {
    const rootPath = path.resolve(rootDir);
    if (isImportableDirectoryRoot(rootPath, parsed.provider)) {
      return [{
        kind: 'directory',
        source: rootPath,
        display: rootPath
      }];
    }

    const discovered = [];
    const seenDirs = new Set();
    const seenSources = new Set();
    const pending = [rootPath];
    let scannedDirs = 0;

    const pushSource = (kind, sourcePath) => {
      const normalized = path.resolve(sourcePath);
      const key = `${kind}:${normalized}`;
      if (seenSources.has(key)) return;
      seenSources.add(key);
      discovered.push({
        kind,
        source: normalized,
        display: normalized
      });
    };

    while (pending.length > 0) {
      const currentDir = pending.pop();
      if (seenDirs.has(currentDir)) continue;
      seenDirs.add(currentDir);
      scannedDirs += 1;

      if (currentDir !== rootPath && isImportableDirectoryRoot(currentDir, parsed.provider)) {
        pushSource('directory', currentDir);
        if (typeof onProgress === 'function') {
          onProgress(scannedDirs, scannedDirs + pending.length, `dirs=${scannedDirs} found=${discovered.length}`);
        }
        continue;
      }

      let entries = [];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch (_error) {
        if (typeof onProgress === 'function') {
          onProgress(scannedDirs, scannedDirs + pending.length, `dirs=${scannedDirs} found=${discovered.length}`);
        }
        continue;
      }

      entries.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
      for (const entry of entries) {
        const entryPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          pending.push(entryPath);
          continue;
        }
        if (entry.isFile() && /\.zip$/i.test(String(entry.name || ''))) {
          pushSource('zip', entryPath);
          continue;
        }
        if (entry.isFile() && /\.json$/i.test(String(entry.name || '')) && jsonFileHasStandardImportRecords(entryPath, parsed.provider)) {
          pushSource('json', entryPath);
          continue;
        }
        if (entry.isFile() && isTextImportFileName(entry.name) && textFileHasImportRecords(entryPath)) {
          pushSource('text', entryPath);
        }
      }

      if (typeof onProgress === 'function') {
        onProgress(scannedDirs, scannedDirs + pending.length, `dirs=${scannedDirs} found=${discovered.length}`);
      }
    }

    return discovered.sort((a, b) => a.source.localeCompare(b.source));
  }

  function summarizeGlobalImportResult(result) {
    const out = {
      providers: [],
      imported: 0,
      duplicates: 0,
      invalid: 0,
      failed: 0
    };
    if (!result || typeof result !== 'object') return out;
    out.providers = Array.isArray(result.providers) ? result.providers.slice() : [];
    const providerResults = Array.isArray(result.providerResults) ? result.providerResults : [];
    providerResults.forEach((item) => {
      out.imported += Number(item.imported || 0);
      out.duplicates += Number(item.duplicates || 0);
      out.invalid += Number(item.invalid || 0);
      out.failed += Number(item.failed || 0);
    });
    return out;
  }

  function summarizeDirectImporterResult(provider, result) {
    return {
      providers: [provider],
      imported: Number(result && result.imported || 0),
      duplicates: Number(result && result.duplicates || 0),
      invalid: Number(result && result.invalid || 0),
      failed: Number(result && result.failed || 0)
    };
  }

  function mergeProviderImportResults(results) {
    const providers = new Set();
    const providerResults = [];
    const failedProviders = [];
    (results || []).forEach((result) => {
      if (!result || typeof result !== 'object') return;
      (Array.isArray(result.providers) ? result.providers : []).forEach((provider) => providers.add(provider));
      (Array.isArray(result.providerResults) ? result.providerResults : []).forEach((item) => providerResults.push(item));
      (Array.isArray(result.failedProviders) ? result.failedProviders : []).forEach((provider) => failedProviders.push(provider));
    });
    return {
      providers: Array.from(providers).sort(),
      providerResults,
      failedProviders
    };
  }

  async function importCredentialLayoutProviderSource(sourceDir, provider, parsed, onProgress) {
    const safeProvider = String(provider || '').trim().toLowerCase();
    const dryRun = !!(parsed && parsed.dryRun);
    if (!safeProvider || !isProviderToken(safeProvider)) {
      throw new Error(`Unsupported provider: ${provider || 'unknown'}`);
    }
    if (!aiHomeDir) {
      throw new Error('AI home directory is not configured');
    }

    const accounts = listCredentialAccountDirs(sourceDir);
    let imported = 0;
    let duplicates = 0;
    let invalid = 0;
    let failed = 0;
    let copiedFiles = 0;

    for (let index = 0; index < accounts.length; index += 1) {
      const account = accounts[index];
      const targetAccountDir = path.join(aiHomeDir, 'profiles', safeProvider, account.id);
      try {
        const candidateFiles = collectCredentialRelativePaths(safeProvider)
          .filter((relFile) => isRegularFile(path.join(account.dir, relFile)));
        if (candidateFiles.length === 0) {
          invalid += 1;
        } else if (directoryExists(targetAccountDir)) {
          duplicates += 1;
        } else {
          const copied = copyCredentialFiles(account.dir, targetAccountDir, safeProvider, dryRun);
          copiedFiles += copied;
          imported += 1;
        }
      } catch (_error) {
        failed += 1;
      }
      if (typeof onProgress === 'function') {
        onProgress((index + 1) / Math.max(1, accounts.length), `${safeProvider} credentials ${index + 1}/${Math.max(1, accounts.length)}`);
      }
    }

    return {
      provider: safeProvider,
      sourceDir,
      dryRun,
      parsedLines: accounts.length,
      scannedFiles: copiedFiles,
      imported,
      duplicates,
      invalid,
      failed
    };
  }

  function resolveFixedProviderSourceDir(baseDir, provider) {
    const safeProvider = String(provider || '').trim().toLowerCase();
    const resolvedBaseDir = path.resolve(String(baseDir || ''));
    const candidates = [
      path.join(resolvedBaseDir, 'accounts', safeProvider),
      path.join(resolvedBaseDir, safeProvider),
      resolvedBaseDir
    ];

    const preferred = candidates.find((candidate) => directoryExists(candidate) && candidate !== resolvedBaseDir);
    if (preferred) return preferred;
    if (directoryExists(resolvedBaseDir)) return resolvedBaseDir;
    throw new Error(`Import folder not found: ${resolvedBaseDir}`);
  }

  async function importFixedProviderSource(sourceDir, parsed, importParallel, onProgress, importSession = null) {
    const provider = String(parsed.provider || '').trim().toLowerCase();
    const importer = resolveAccountImporter(provider);
    if (typeof importer !== 'function') {
      const result = await importCredentialLayoutProviderSource(sourceDir, provider, parsed, onProgress);
      return {
        provider,
        sourceDir,
        ...summarizeDirectImporterResult(provider, result)
      };
    }

    const importerArgs = [sourceDir, '--parallel', String(Math.max(1, Number(importParallel) || 1))];
    if (parsed.dryRun) importerArgs.push('--dry-run');

    const result = await importer(importerArgs, {
      parseCodexBulkImportArgs,
      importCodexTokensFromOutput,
      importSession,
      log: () => {},
      error: () => {},
      onProgress: (progress) => {
        const scannedFiles = Number(progress && progress.scannedFiles) || 0;
        const totalFiles = Number(progress && progress.totalFiles) || 1;
        const ratio = totalFiles > 0 ? scannedFiles / totalFiles : 1;
        const status = String(progress && progress.status || 'scan');
        if (typeof onProgress === 'function') {
          onProgress(ratio, `${provider} ${status} ${scannedFiles}/${totalFiles}`);
        }
      }
    });

    return {
      provider,
      sourceDir,
      ...summarizeDirectImporterResult(provider, result)
    };
  }

  async function importGlobalImporterProviders(sourceRoot, parsed, importParallel, onProgress) {
    const result = await runGlobalAccountImport([sourceRoot, ...(parsed.dryRun ? ['--dry-run'] : [])], {
      fs,
      log: () => {},
      error: () => {},
      quiet: true,
      providerLog: false,
      parallel: importParallel,
      parseCodexBulkImportArgs,
      importCodexTokensFromOutput,
      onImporterProgress: (providerName, progress) => {
        const scannedFiles = Number(progress && progress.scannedFiles) || 0;
        const totalFiles = Number(progress && progress.totalFiles) || 1;
        const innerRatio = totalFiles > 0 ? scannedFiles / totalFiles : 1;
        const status = String(progress && progress.status || 'scan');
        if (typeof onProgress === 'function') {
          onProgress(innerRatio, `${providerName} ${status} ${scannedFiles}/${totalFiles}`);
        }
      },
      onProviderProgress: (processedProviders, totalProviders, providerName) => {
        const ratio = totalProviders > 0 ? processedProviders / totalProviders : 1;
        if (typeof onProgress === 'function') {
          onProgress(ratio, `providers ${processedProviders}/${totalProviders} last=${providerName}`);
        }
      }
    });
    return result;
  }

  async function importCredentialLayoutProviders(sourceRoot, parsed, onProgress) {
    const providerNames = listImportableProviderNames(sourceRoot)
      .filter((provider) => typeof resolveAccountImporter(provider) !== 'function');
    const providerResults = [];
    const failedProviders = [];

    for (let index = 0; index < providerNames.length; index += 1) {
      const provider = providerNames[index];
      try {
        const result = await importCredentialLayoutProviderSource(
          path.join(sourceRoot, provider),
          provider,
          parsed,
          (ratio, label) => {
            if (typeof onProgress !== 'function') return;
            const providerRatio = (index + Math.max(0, Math.min(1, Number(ratio) || 0))) / Math.max(1, providerNames.length);
            onProgress(providerRatio, label);
          }
        );
        providerResults.push({ provider, ...result });
      } catch (_error) {
        failedProviders.push(provider);
      }
    }

    return {
      providers: providerResults.map((item) => item.provider),
      providerResults,
      failedProviders
    };
  }

  async function importMixedProviderSourceRoot(sourceRoot, parsed, importParallel, onProgress) {
    const providerNames = listImportableProviderNames(sourceRoot);
    const hasImporterProvider = providerNames.some((provider) => typeof resolveAccountImporter(provider) === 'function');
    const results = [];
    if (hasImporterProvider) {
      results.push(await importGlobalImporterProviders(sourceRoot, parsed, importParallel, onProgress));
    }
    results.push(await importCredentialLayoutProviders(sourceRoot, parsed, onProgress));
    return mergeProviderImportResults(results);
  }

  async function importDirectorySource(sourcePath, parsed, importParallel, onProgress, importSession = null) {
    if (parsed.provider) {
      const sourceDir = resolveFixedProviderSourceDir(sourcePath, parsed.provider);
      const result = await importFixedProviderSource(sourceDir, parsed, importParallel, onProgress, importSession);
      return {
        type: 'directory',
        source: sourcePath,
        imported: result.imported,
        duplicates: result.duplicates,
        invalid: result.invalid,
        failed: result.failed,
        providers: result.providers,
        provider: result.provider,
        sourceDir: result.sourceDir
      };
    }
    const resolved = resolveImportSourceRoot({
      extractDir: sourcePath,
      provider: parsed.provider,
      folderHint: ''
    });
    const result = await importMixedProviderSourceRoot(resolved.sourceRoot, parsed, importParallel, onProgress);
    return {
      type: 'directory',
      source: sourcePath,
      ...summarizeGlobalImportResult(result)
    };
  }

  async function importZipSource(zipPath, parsed, importParallel, onProgress, zipPrepareLimiter = null, importSession = null) {
    const prepareZip = async () => ensureArchiveExtractedByHashImpl({
      fs,
      path,
      os,
      fse,
      execSync,
      processImpl,
      cryptoImpl,
      zipPath,
      aiHomeDir,
      spawnImpl,
      onHashProgress: (processed, total) => {
        const ratio = total > 0 ? processed / total : 1;
        if (typeof onProgress === 'function') {
          onProgress((mapProgressRange(0, 34, ratio) / 100), `hashing ${formatBytes(processed)} / ${formatBytes(total)}`);
        }
      },
      onExtractProgress: (extractPct) => {
        const ratio = Math.max(0, Math.min(1, (Number(extractPct) || 0) / 100));
        if (typeof onProgress === 'function') {
          onProgress((mapProgressRange(35, 86, ratio) / 100), `extracting ${Math.round(ratio * 100)}%`);
        }
      }
    });
    const prepared = zipPrepareLimiter
      ? await zipPrepareLimiter.run(prepareZip)
      : await prepareZip();
    if (typeof onProgress === 'function' && prepared && prepared.cacheHit) {
      const shortHash = String(prepared.hash || '').trim().slice(0, 12);
      onProgress(0.87, `using cached extraction${shortHash ? ` ${shortHash}` : ''}`);
    }
    const baseDir = path.join(prepared.extractDir, parsed.folder || '');
    const flatJsonFiles = listStandardJsonImportFiles(baseDir, parsed);
    const importFlatJsonFiles = async () => importJsonFileSources('zip', zipPath, flatJsonFiles, parsed, (ratio, label) => {
      const mappedRatio = mapProgressRange(87, 99, ratio) / 100;
      if (typeof onProgress === 'function') {
        onProgress(mappedRatio, `importing ${label}`);
      }
    });
    if (parsed.provider) {
      if (flatJsonFiles.length > 0) {
        return importFlatJsonFiles();
      }
      const sourceDir = resolveFixedProviderSourceDir(baseDir, parsed.provider);
      const result = await importFixedProviderSource(sourceDir, parsed, importParallel, (ratio, label) => {
        const mappedRatio = mapProgressRange(87, 99, ratio) / 100;
        if (typeof onProgress === 'function') {
          onProgress(mappedRatio, `importing ${label}`);
        }
      }, importSession);
      return {
        type: 'zip',
        source: zipPath,
        cacheHit: !!prepared.cacheHit,
        imported: result.imported,
        duplicates: result.duplicates,
        invalid: result.invalid,
        failed: result.failed,
        providers: result.providers,
        provider: result.provider,
        sourceDir: result.sourceDir
      };
    }
    if (flatJsonFiles.length > 0 && !directoryHasProviderLayout(baseDir)) {
      return importFlatJsonFiles();
    }
    let resolved = null;
    try {
      resolved = resolveImportSourceRoot({
        extractDir: prepared.extractDir,
        provider: parsed.provider,
        folderHint: parsed.folder
      });
    } catch (error) {
      if (flatJsonFiles.length > 0) {
        return importFlatJsonFiles();
      }
      throw error;
    }
    const result = await importMixedProviderSourceRoot(
      resolved.sourceRoot,
      parsed,
      importParallel,
      (ratio, label) => {
        const mappedRatio = mapProgressRange(87, 99, ratio) / 100;
        if (typeof onProgress === 'function') {
          onProgress(mappedRatio, `importing ${label}`);
        }
      }
    );
    return {
      type: 'zip',
      source: zipPath,
      cacheHit: !!prepared.cacheHit,
      ...summarizeGlobalImportResult(result)
    };
  }

  async function importJsonFileSources(sourceType, sourcePath, jsonFiles, parsed, onProgress) {
    const providers = new Set();
    let imported = 0;
    let duplicates = 0;
    let invalid = 0;
    let failed = 0;
    const files = Array.isArray(jsonFiles) ? jsonFiles : [];
    for (let index = 0; index < files.length; index += 1) {
      const result = await importJsonSource(files[index], parsed, (ratio, label) => {
        if (typeof onProgress !== 'function') return;
        const fileRatio = (index + Math.max(0, Math.min(1, Number(ratio) || 0))) / Math.max(1, files.length);
        onProgress(fileRatio, `json ${index + 1}/${Math.max(1, files.length)} ${label}`);
      });
      (result.providers || []).forEach((provider) => providers.add(provider));
      imported += Number(result.imported || 0);
      duplicates += Number(result.duplicates || 0);
      invalid += Number(result.invalid || 0);
      failed += Number(result.failed || 0);
    }
    return {
      type: sourceType,
      source: sourcePath,
      providers: Array.from(providers).sort(),
      imported,
      duplicates,
      invalid,
      failed
    };
  }

  async function importCliproxyapiSource(parsed, onProgress) {
    if (parsed.provider && !['codex', 'gemini', 'claude'].includes(parsed.provider)) {
      throw new Error(`cliproxyapi source supports codex/gemini/claude only, got: ${parsed.provider}`);
    }
    const result = await importCliproxyapiCodexAuths({
      dryRun: parsed.dryRun,
      apiKeyProviders: parsed.provider ? [parsed.provider] : ['codex', 'gemini', 'claude'],
      onProgress: (progress) => {
        const total = Number(progress && progress.total) || 1;
        const scanned = Number(progress && progress.scanned) || 0;
        const ratio = total > 0 ? scanned / total : 1;
        const email = String(progress && progress.email || progress && progress.fileName || '').trim();
        if (typeof onProgress === 'function') {
          onProgress(ratio, `${String(progress && progress.status || 'scan')} ${scanned}/${total}${email ? ` ${email}` : ''}`);
        }
      }
    });
    return {
      type: 'cliproxyapi',
      source: 'cliproxyapi',
      providers: Array.isArray(result.providers) && result.providers.length > 0 ? result.providers : ['codex'],
      imported: Number(result.imported || 0),
      duplicates: Number(result.duplicates || 0),
      invalid: Number(result.invalid || 0),
      failed: Number(result.failed || 0)
    };
  }

  async function importJsonSource(jsonPath, parsed, onProgress) {
    if (
      typeof getToolAccountIds !== 'function'
      || typeof getProfileDir !== 'function'
      || typeof getToolConfigDir !== 'function'
    ) {
      throw new Error('Standard JSON import is not wired');
    }
    let payload = null;
    try {
      payload = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch (error) {
      throw new Error(`Invalid JSON import source: ${error.message}`);
    }
    const records = parseStandardAccountRecordsFromJson(payload)
      .filter((record) => {
        if (!parsed.provider) return true;
        const provider = inferImportProvider(record);
        return provider === parsed.provider;
      });
    const result = importStandardAccountRecords({
      fs,
      path,
      records,
      getToolAccountIds,
      getProfileDir,
      getToolConfigDir,
      accountArtifactHooks,
      dryRun: parsed.dryRun,
      source: 'unified_json_import'
    });
    if (typeof onProgress === 'function') {
      onProgress(1, `json records ${records.length}`);
    }
    const providers = Array.from(new Set(result.accounts.map((item) => item.provider))).sort();
    return {
      type: 'json',
      source: jsonPath,
      providers,
      imported: result.imported,
      duplicates: result.duplicates,
      invalid: result.invalid,
      failed: result.failed
    };
  }

  async function importTextSource(textPath, parsed, onProgress) {
    if (
      typeof getToolAccountIds !== 'function'
      || typeof getProfileDir !== 'function'
      || typeof getToolConfigDir !== 'function'
    ) {
      throw new Error('Text account import is not wired');
    }
    let records = [];
    try {
      records = parseManualImportText(fs.readFileSync(textPath, 'utf8'));
    } catch (error) {
      throw new Error(`Invalid text import source: ${error.message}`);
    }
    records = records.filter((record) => {
      if (!parsed.provider) return true;
      const provider = inferImportProvider(record);
      return provider === parsed.provider;
    });
    const result = importStandardAccountRecords({
      fs,
      path,
      records,
      getToolAccountIds,
      getProfileDir,
      getToolConfigDir,
      accountArtifactHooks,
      dryRun: parsed.dryRun,
      source: 'unified_text_import'
    });
    if (typeof onProgress === 'function') {
      onProgress(1, `text records ${records.length}`);
    }
    const providers = Array.from(new Set(result.accounts.map((item) => item.provider))).sort();
    return {
      type: 'text',
      source: textPath,
      providers,
      imported: result.imported,
      duplicates: result.duplicates,
      invalid: result.invalid,
      failed: result.failed
    };
  }

  async function runUnifiedImport(rawArgs, runOptions = {}) {
    const log = typeof runOptions.log === 'function' ? runOptions.log : console.log;
    const error = typeof runOptions.error === 'function' ? runOptions.error : console.error;
    const renderStageProgress = typeof runOptions.renderStageProgress === 'function' ? runOptions.renderStageProgress : null;
    const parsed = parseUnifiedImportArgs(rawArgs, runOptions.provider);
    const sourceEntries = [];
    const sourceKeys = new Set();
    const providersTouched = new Set();
    const sourceResults = [];
    const failedSources = [];

    const addSourceEntry = (entry) => {
      const key = `${entry.kind}:${entry.source}`;
      if (sourceKeys.has(key)) return;
      sourceKeys.add(key);
      sourceEntries.push(entry);
    };

    const renderDiscoveryProgress = (current, total, label) => {
      if (!renderStageProgress) return;
      renderStageProgress('[aih import]', current, Math.max(1, total), label);
    };

    const initialSourceEntries = [];
    parsed.sources.forEach((rawSource) => {
      const expandedSources = expandGlobSource(rawSource);
      if (expandedSources.length === 0 && hasGlobPattern(rawSource)) {
        failedSources.push({ source: rawSource, error: 'No import sources matched glob pattern.' });
        error(`\x1b[31m[aih] import source failed (${rawSource}): No import sources matched glob pattern.\x1b[0m`);
        return;
      }
      expandedSources.forEach((expandedSource) => {
        initialSourceEntries.push(classifySource(expandedSource));
      });
    });

    initialSourceEntries.forEach((initialEntry) => {
      if (initialEntry.kind !== 'directory') {
        addSourceEntry(initialEntry);
        return;
      }
      const discovered = discoverNestedSourcesFromDirectory(initialEntry.source, parsed, (current, total, label) => {
        renderDiscoveryProgress(current, total, `discovering ${initialEntry.display} ${label}`);
      });
      if (discovered.length === 0) {
        failedSources.push({ source: initialEntry.display, error: 'No importable zip files or provider folders found under directory.' });
        error(`\x1b[31m[aih] import source failed (${initialEntry.display}): No importable zip files or provider folders found under directory.\x1b[0m`);
        return;
      }
      discovered.forEach(addSourceEntry);
    });

    if (sourceEntries.length === 0) {
      return {
        provider: parsed.provider || '',
        dryRun: parsed.dryRun,
        folder: parsed.folder,
        jobs: parsed.jobs,
        sourceCount: 0,
        providers: [],
        sourceResults: [],
        failedSources
      };
    }

    const totalBudget = Math.max(1, parsed.jobs);
    const workerCount = Math.max(1, Math.min(sourceEntries.length, totalBudget));
    const importParallel = Math.max(1, Math.floor(totalBudget / workerCount));
    const zipPrepareConcurrency = computeZipPrepareConcurrency(totalBudget);
    const zipPrepareLimiter = createConcurrencyLimiter(zipPrepareConcurrency);
    const providerImportSession = parsed.provider ? {
      provider: parsed.provider,
      knownAccountsByIdentity: null,
      nextNumericId: null
    } : null;
    const activeProgressBySource = new Map();
    const activeLabelBySource = new Map();
    const sourceResultsByIndex = new Map();
    let completedWhole = 0;
    let partialProgressSum = 0;
    let inFlight = 0;
    let cursor = 0;

    const renderAggregateProgress = () => {
      if (!renderStageProgress) return;
      const current = Math.min(sourceEntries.length, completedWhole + Math.max(0, partialProgressSum));
      const active = Array.from(activeLabelBySource.entries())
        .map(([index, label]) => {
          const ratio = Number(activeProgressBySource.get(index) || 0);
          if (ratio <= 0) return '';
          return `#${Number(index) + 1} ${label}`;
        })
        .filter(Boolean)
        .slice(0, 2)
        .join(' | ');
      renderStageProgress(
        '[aih import]',
        current,
        sourceEntries.length,
        `${completedWhole}/${sourceEntries.length} in_flight=${inFlight} prep=${zipPrepareLimiter.getActiveCount()}/${zipPrepareConcurrency} queued=${zipPrepareLimiter.getPendingCount()} budget=${totalBudget} per_source=${importParallel}${active ? ` ${active}` : ''}`
      );
    };

    const runSource = async (sourceEntry, sourceIndex) => {
      const onProgress = (ratio, label) => {
        const nextRatio = Math.max(0, Math.min(1, Number(ratio) || 0));
        const prevRatio = Number(activeProgressBySource.get(sourceIndex) || 0);
        partialProgressSum += (nextRatio - prevRatio);
        activeProgressBySource.set(sourceIndex, nextRatio);
        activeLabelBySource.set(sourceIndex, `${sourceEntry.kind} ${label}`);
        renderAggregateProgress();
      };
      if (sourceEntry.kind === 'directory') {
        return importDirectorySource(sourceEntry.source, parsed, importParallel, onProgress, providerImportSession);
      }
      if (sourceEntry.kind === 'zip') {
        return importZipSource(sourceEntry.source, parsed, importParallel, onProgress, zipPrepareLimiter, providerImportSession);
      }
      if (sourceEntry.kind === 'json') {
        return importJsonSource(sourceEntry.source, parsed, onProgress);
      }
      if (sourceEntry.kind === 'text') {
        return importTextSource(sourceEntry.source, parsed, onProgress);
      }
      return importCliproxyapiSource(parsed, onProgress);
    };

    const worker = async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= sourceEntries.length) return;
        const sourceEntry = sourceEntries[index];
        inFlight += 1;
        activeProgressBySource.set(index, 0);
        activeLabelBySource.set(index, `${sourceEntry.kind} ${sourceEntry.display}`);
        renderAggregateProgress();
        try {
          const result = await runSource(sourceEntry, index);
          sourceResultsByIndex.set(index, result);
          (result.providers || []).forEach((provider) => providersTouched.add(provider));
        } catch (sourceError) {
          failedSources.push({ source: sourceEntry.display, error: sourceError.message });
          error(`\x1b[31m[aih] import source failed (${sourceEntry.display}): ${sourceError.message}\x1b[0m`);
        } finally {
          const finalRatio = Number(activeProgressBySource.get(index) || 0);
          partialProgressSum = Math.max(0, partialProgressSum - finalRatio);
          activeProgressBySource.delete(index);
          activeLabelBySource.delete(index);
          completedWhole += 1;
          inFlight -= 1;
          renderAggregateProgress();
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    Array.from(sourceResultsByIndex.keys()).sort((a, b) => a - b).forEach((index) => {
      sourceResults.push(sourceResultsByIndex.get(index));
    });

    log('\x1b[36m[aih]\x1b[0m import summary');
    sourceResults.forEach((item) => {
      log(`  - ${item.type}: source=${item.source} imported=${item.imported} duplicates=${item.duplicates} invalid=${item.invalid} failed=${item.failed}`);
    });

    return {
      provider: parsed.provider || '',
      dryRun: parsed.dryRun,
      folder: parsed.folder,
      jobs: parsed.jobs,
      sourceCount: sourceEntries.length,
      providers: Array.from(providersTouched).sort(),
      sourceResults,
      failedSources
    };
  }

  return {
    parseUnifiedImportArgs,
    runUnifiedImport
  };
}

module.exports = {
  createUnifiedImportService
};
