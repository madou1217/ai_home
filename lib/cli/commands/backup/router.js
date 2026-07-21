'use strict';

const {
  clampPercent,
  mapProgressRange,
  formatBytes,
  resolveBundled7zipPath,
  tryExtractZipWith7z,
  computeFileSha256,
  isArchiveExtractCacheReady,
  ensureArchiveExtractedByHash
} = require('../../services/backup/archive-import');
const { buildFlatAccountExportEntries } = require('../../../account/standard-transfer');
const {
  listCliAccountCredentialRecords
} = require('../../services/account/credential-records');

function isNumericAccountId(name) {
  return /^\d+$/.test(String(name || ''));
}

const KNOWN_IMPORT_PROVIDERS = new Set(['codex', 'gemini', 'claude', 'agy', 'opencode', 'grok', 'qoder', 'qodercn', 'kimi', 'kiro']);
const SUB2API_EXPORT_PROVIDERS = new Set(['codex', 'gemini', 'claude', 'agy', 'grok', 'kimi']);
const STANDARD_EXPORT_FORMATS = new Set(['sub2api', 'antigravity']);
const CLIPROXYAPI_EXPORT_PROVIDERS = new Set(['all', 'codex', 'gemini', 'claude']);
const REMOVED_ANTIGRAVITY_EXPORT_ARGS = new Set(['plugin', 'plugin-v3', 'v3', '--plugin']);

function collectSelectedAccounts({ fs, aiHomeDir, selectors }) {
  const accounts = listCliAccountCredentialRecords(fs, aiHomeDir)
    .filter((record) => isNumericAccountId(record.cliAccountId));
  const byProvider = new Map();
  accounts.forEach((record) => {
    if (!byProvider.has(record.provider)) byProvider.set(record.provider, []);
    byProvider.get(record.provider).push(record);
  });
  const selected = new Map();
  const addAccount = (provider, cliAccountId) => {
    if (!provider || !isNumericAccountId(cliAccountId)) return;
    const key = `${provider}:${cliAccountId}`;
    if (selected.has(key)) return;
    const record = (byProvider.get(provider) || [])
      .find((item) => String(item.cliAccountId) === String(cliAccountId));
    if (!record) return;
    selected.set(key, {
      provider,
      cliAccountId: String(cliAccountId),
      accountRef: record.accountRef
    });
  };

  const addProviderAccounts = (provider) => {
    (byProvider.get(provider) || []).forEach((record) => addAccount(provider, record.cliAccountId));
  };

  const requested = Array.isArray(selectors) ? selectors : [];
  if (requested.length === 0) {
    Array.from(byProvider.keys()).forEach(addProviderAccounts);
    return Array.from(selected.values());
  }

  requested.forEach((raw) => {
    const selector = String(raw || '').trim().toLowerCase();
    if (!selector) return;
    const [provider, rawIds = ''] = selector.split(':', 2);
    if (!provider || !KNOWN_IMPORT_PROVIDERS.has(provider)) return;
    if (!rawIds) {
      addProviderAccounts(provider);
      return;
    }
    rawIds.split(',').map((value) => value.trim()).forEach((cliAccountId) => {
      addAccount(provider, cliAccountId);
    });
  });

  return Array.from(selected.values());
}

async function stageSelectedAccounts({
  fs,
  path,
  fse,
  aiHomeDir,
  selectors,
  stageRoot,
  onProgress = null
}) {
  fse.ensureDirSync(stageRoot);
  const providerSet = new Set();
  let copiedAccounts = 0;
  let copiedFiles = 0;
  let skippedAccounts = 0;

  const selectedAccounts = collectSelectedAccounts({
    fs,
    aiHomeDir,
    selectors
  });

  const emitProgress = (current, total, extra = {}) => {
    if (typeof onProgress !== 'function') return;
    onProgress({
      current,
      total,
      copiedAccounts,
      copiedFiles,
      skippedAccounts,
      ...extra
    });
  };

  emitProgress(0, selectedAccounts.length, { status: 'start' });

  const { entries, skipped } = buildFlatAccountExportEntries({
    fs,
    path,
    aiHomeDir,
    accounts: selectedAccounts
  });
  skippedAccounts = skipped.length;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const dst = path.join(stageRoot, entry.fileName);
    fs.writeFileSync(dst, `${JSON.stringify(entry.payload, null, 2)}\n`, 'utf8');
    copiedAccounts += 1;
    copiedFiles += 1;
    providerSet.add(entry.provider);
    emitProgress(index + 1 + skippedAccounts, selectedAccounts.length, {
      provider: entry.provider,
      accountRef: entry.accountRef,
      fileName: entry.fileName,
      status: 'writing'
    });
  }

  emitProgress(selectedAccounts.length, selectedAccounts.length, { status: 'done' });

  return {
    accountsDir: stageRoot,
    copiedAccounts,
    copiedFiles,
    skippedAccounts,
    providerDirs: Array.from(providerSet).sort()
  };
}

async function createProviderCredentialExportArchive({
  fs,
  path,
  fse,
  aiHomeDir,
  execSync,
  processImpl,
  ensureAesSuffix,
  defaultExportName,
  renderStageProgress,
  exportArgs,
  consoleImpl
}) {
  const provider = String(exportArgs[1] || '').trim().toLowerCase();
  const tailArgs = exportArgs.slice(2).map((item) => String(item || '').trim()).filter(Boolean);
  if (!KNOWN_IMPORT_PROVIDERS.has(provider)) {
    throw new Error(`Provider-scoped export is currently unsupported for ${provider || 'unknown'}`);
  }
  if (tailArgs.length > 1) {
    throw new Error('Provider export accepts at most one target zip path');
  }

  const targetFile = ensureAesSuffix(tailArgs[0] || defaultExportName());
  const tmpStageDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'aih_provider_export_stage_'));
  try {
    renderStageProgress('[aih export]', 1, 3, `Writing ${provider} account JSON files`);
    const staged = await stageSelectedAccounts({
      fs,
      path,
      fse,
      aiHomeDir,
      selectors: [provider],
      stageRoot: tmpStageDir,
      onProgress: (progress) => {
        const total = Math.max(1, Number(progress && progress.total) || 0);
        const current = Math.min(total, Math.max(0, Number(progress && progress.current) || 0));
        const labelParts = [
          `Writing ${provider} account JSON files ${current}/${total}`,
          `accounts=${Number(progress && progress.copiedAccounts || 0)}`,
          `files=${Number(progress && progress.copiedFiles || 0)}`
        ];
        if (Number(progress && progress.skippedAccounts) > 0) labelParts.push(`skipped=${Number(progress.skippedAccounts)}`);
        if (progress && progress.fileName) labelParts.push(`last=${progress.fileName}`);
        if (progress && progress.id) labelParts.push(`last=${provider}:${progress.id}`);
        renderStageProgress('[aih export]', 1, 3, labelParts.join(' '));
      }
    });
    if (staged.copiedAccounts === 0 || staged.copiedFiles === 0) {
      throw new Error(`No standard account JSON files found for ${provider}`);
    }

    renderStageProgress('[aih export]', 2, 3, 'Building zip archive');
    const outPath = path.resolve(targetFile);
    createZipArchive({
      execSync,
      processImpl,
      stageDir: tmpStageDir,
      outPath
    });
    renderStageProgress('[aih export]', 3, 3, 'Completed');
    consoleImpl.log(`\x1b[90m[aih]\x1b[0m providers=${provider} accounts=${staged.copiedAccounts} files=${staged.copiedFiles}${staged.skippedAccounts ? ` skipped=${staged.skippedAccounts}` : ''}`);
    consoleImpl.log(`\x1b[32m[Success] Backup exported:\x1b[0m ${outPath}`);
    return { outPath, staged };
  } finally {
    if (fs.existsSync(tmpStageDir)) fse.removeSync(tmpStageDir);
  }
}

function summarizeAccountImportResult(result) {
  const out = {
    providers: [],
    accountsTotal: 0,
    parsed: 0,
    imported: 0,
    duplicates: 0,
    invalid: 0,
    failed: 0
  };
  if (!result || typeof result !== 'object') return out;
  out.providers = Array.isArray(result.providers) ? result.providers.slice() : [];
  const providerResults = Array.isArray(result.providerResults) ? result.providerResults : [];
  providerResults.forEach((item) => {
    out.parsed += Number(item.parsedLines || 0);
    out.imported += Number(item.imported || 0);
    out.duplicates += Number(item.duplicates || 0);
    out.invalid += Number(item.invalid || 0);
    out.failed += Number(item.failed || 0);
  });
  const fallbackTotal = out.imported + out.duplicates + out.invalid + out.failed;
  out.accountsTotal = out.parsed > 0 ? out.parsed : fallbackTotal;
  return out;
}

function escapePowerShellPath(value) {
  return String(value || '').replace(/'/g, "''");
}

function directoryExists(fs, targetPath) {
  try {
    return fs.existsSync(targetPath) && fs.statSync(targetPath).isDirectory();
  } catch (_error) {
    return false;
  }
}

function listChildDirectories(fs, targetPath) {
  if (!directoryExists(fs, targetPath)) return [];
  try {
    return fs.readdirSync(targetPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => String(entry.name || '').trim())
      .filter(Boolean);
  } catch (_error) {
    return [];
  }
}

function createZipArchive({ execSync, processImpl, stageDir, outPath }) {
  if (processImpl.platform === 'win32') {
    const src = escapePowerShellPath(stageDir);
    const dst = escapePowerShellPath(outPath);
    execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${src}\\*' -DestinationPath '${dst}' -Force"`, {
      stdio: 'ignore'
    });
    return;
  }
  execSync(`cd "${stageDir}" && zip -rq "${outPath}" .`, { stdio: 'ignore' });
}

function defaultStandardExportName(format) {
  const safeFormat = String(format || '').trim().toLowerCase();
  if (safeFormat === 'antigravity') return 'antigravity-accounts.json';
  if (safeFormat === 'cliproxyapi') return 'cliproxyapi-data.json';
  return 'sub2api-data.json';
}

function parseStandardExportArgs(exportArgs) {
  const format = String(exportArgs[0] || '').trim().toLowerCase();
  const tail = exportArgs.slice(1).map((item) => String(item || '').trim()).filter(Boolean);
  let providers = [];
  let targetFile = '';
  for (const item of tail) {
    const normalized = item.toLowerCase();
    if (format === 'antigravity' && REMOVED_ANTIGRAVITY_EXPORT_ARGS.has(normalized)) {
      throw new Error('Antigravity export supports Manager JSON only');
    }
    if (KNOWN_IMPORT_PROVIDERS.has(normalized)) {
      if (format === 'sub2api' && !SUB2API_EXPORT_PROVIDERS.has(normalized)) {
        throw new Error(`sub2api export does not support ${normalized} accounts`);
      }
      if (providers.length > 0) {
        throw new Error(`Invalid ${format} export syntax`);
      }
      providers = [normalized];
      continue;
    }
    if (targetFile) {
      throw new Error(`Invalid ${format} export syntax`);
    }
    targetFile = item;
  }
  if (format === 'antigravity' && providers.length > 0 && providers[0] !== 'agy') {
    throw new Error('Antigravity Manager export supports agy accounts only');
  }
  return {
    format,
    providers,
    targetFile: targetFile || defaultStandardExportName(format)
  };
}

function parseCliproxyapiDataExportArgs(exportArgs) {
  const tail = exportArgs.slice(1).map((item) => String(item || '').trim()).filter(Boolean);
  let provider = 'all';
  let targetFile = '';
  for (const item of tail) {
    const normalized = item.toLowerCase();
    if (CLIPROXYAPI_EXPORT_PROVIDERS.has(normalized)) {
      if (provider !== 'all') throw new Error('Invalid CLIProxyAPI data export syntax');
      provider = normalized;
      continue;
    }
    if (targetFile) throw new Error('Invalid CLIProxyAPI data export syntax');
    targetFile = item;
  }
  const apiKeyProviders = provider === 'all'
    ? ['codex', 'gemini', 'claude']
    : [provider];
  return {
    provider,
    apiKeyProviders,
    targetFile: targetFile || defaultStandardExportName('cliproxyapi')
  };
}

function buildMappingRoot(path, sourceDir, suffix = '__aih_import_root') {
  const normalized = path.resolve(String(sourceDir || ''));
  const parentDir = path.dirname(normalized);
  const baseName = path.basename(normalized) || 'root';
  return path.join(parentDir, `${baseName}.${suffix}`);
}

function resolveImportSourceRoot({
  fs,
  path,
  fse,
  extractDir,
  provider,
  folderHint
}) {
  const safeProvider = String(provider || '').trim().toLowerCase();
  const providerMode = safeProvider && KNOWN_IMPORT_PROVIDERS.has(safeProvider);
  const hint = String(folderHint || '').trim();
  const baseDir = hint ? path.join(extractDir, hint) : extractDir;

  if (!directoryExists(fs, baseDir)) {
    throw new Error(`Import folder not found in zip: ${hint}`);
  }

  if (providerMode) {
    const candidateProviderDirs = [
      path.join(baseDir, 'accounts', safeProvider),
      path.join(baseDir, safeProvider),
      baseDir
    ];
    const providerDir = candidateProviderDirs.find((dir) => directoryExists(fs, dir));
    if (!providerDir) {
      throw new Error(`Provider folder not found in zip: ${safeProvider}`);
    }

    if (path.basename(providerDir) === safeProvider) {
      return { sourceRoot: path.dirname(providerDir) };
    }

    const mappedRoot = buildMappingRoot(path, providerDir);
    const mappedProviderDir = path.join(mappedRoot, safeProvider);
    if (directoryExists(fs, mappedRoot)) fse.removeSync(mappedRoot);
    fse.ensureDirSync(mappedRoot);
    fse.copySync(providerDir, mappedProviderDir, { overwrite: true });
    return { sourceRoot: mappedRoot };
  }

  const candidateRoots = [
    path.join(baseDir, 'accounts'),
    baseDir
  ];
  for (const root of candidateRoots) {
    if (!directoryExists(fs, root)) continue;
    const subdirs = listChildDirectories(fs, root);
    if (subdirs.length === 0) continue;
    return { sourceRoot: root };
  }

  throw new Error('Backup zip does not contain importable provider directories.');
}

async function runBackupCommand(cmd, args, deps = {}) {
  if (cmd !== 'export' && cmd !== 'import') return false;

  const {
    fs,
    path,
    os,
    fse,
    execSync,
    readline,
    consoleImpl,
    processImpl,
    ensureAesSuffix,
    defaultExportName,
    parseExportArgs,
    parseImportArgs,
    renderStageProgress,
    exportCliproxyapiData,
    exportSub2ApiData,
    exportAntigravityManagerAccounts,
    runGlobalAccountImport,
    parseCodexBulkImportArgs,
    importCodexTokensFromOutput,
    aiHomeDir,
    crypto: cryptoImpl
  } = deps;

  if (cmd === 'export') {
    const exportArgs = args.slice(1).map((item) => String(item || '').trim()).filter(Boolean);
    if (exportArgs[0] === '__provider__') {
      let exitCode = 0;
      try {
        await createProviderCredentialExportArchive({
          fs,
          path,
          fse,
          aiHomeDir,
          execSync,
          processImpl,
          ensureAesSuffix,
          defaultExportName,
          renderStageProgress,
          exportArgs,
          consoleImpl
        });
      } catch (error) {
        exitCode = 1;
        consoleImpl.error(`\n\x1b[31m[Error] Failed to export: ${error.message}\x1b[0m`);
      }
      processImpl.exit(exitCode);
      return true;
    }
    if (exportArgs[0] === 'cliproxyapi') {
      let exitCode = 0;
      try {
        if (typeof exportCliproxyapiData !== 'function') {
          throw new Error('CLIProxyAPI data export is not wired');
        }
        const parsed = parseCliproxyapiDataExportArgs(exportArgs);
        const result = exportCliproxyapiData({
          outPath: path.resolve(parsed.targetFile),
          apiKeyProviders: parsed.apiKeyProviders
        });
        consoleImpl.log(`\x1b[36m[aih]\x1b[0m Exported ${parsed.provider} CLIProxyAPI account data`);
        consoleImpl.log(`\x1b[90m[aih]\x1b[0m file=${result.outPath}`);
        consoleImpl.log(`\x1b[90m[aih]\x1b[0m accounts=${result.accounts} oauth=${result.oauthAccounts} api_keys=${result.apiKeys}`);
      } catch (error) {
        exitCode = 1;
        consoleImpl.error(`\x1b[31m[aih] Failed to export CLIProxyAPI account data: ${error.message}\x1b[0m`);
      }
      processImpl.exit(exitCode);
      return true;
    }
    if (STANDARD_EXPORT_FORMATS.has(exportArgs[0])) {
      let exitCode = 0;
      try {
        const parsed = parseStandardExportArgs(exportArgs);
        const outPath = path.resolve(parsed.targetFile);
        const result = parsed.format === 'sub2api'
          ? exportSub2ApiData({ outPath, providers: parsed.providers })
          : exportAntigravityManagerAccounts({ outPath });
        consoleImpl.log(`\x1b[36m[aih]\x1b[0m Exported ${parsed.format} account data`);
        consoleImpl.log(`\x1b[90m[aih]\x1b[0m file=${result.outPath}`);
        consoleImpl.log(`\x1b[90m[aih]\x1b[0m accounts=${result.accounts}${result.proxies != null ? ` proxies=${result.proxies}` : ''}${result.variant ? ` variant=${result.variant}` : ''}`);
      } catch (error) {
        exitCode = 1;
        consoleImpl.error(`\x1b[31m[aih] Failed to export standard account data: ${error.message}\x1b[0m`);
      }
      processImpl.exit(exitCode);
      return true;
    }
    const { targetFile: parsedTargetFile, selectors } = parseExportArgs(args.slice(1));
    const targetFile = ensureAesSuffix(parsedTargetFile || defaultExportName());
    consoleImpl.log(selectors.length > 0
      ? `\x1b[36m[aih]\x1b[0m Preparing account selectors:\n  - ${selectors.join('\n  - ')}`
      : '\x1b[36m[aih]\x1b[0m Exporting flat account JSON files (provider_email.json / provider_url_ref.json).');

    const tmpStageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih_export_stage_'));
    let exitCode = 0;
    try {
      const exportStages = 3;
      renderStageProgress('[aih export]', 1, exportStages, 'Writing account JSON files');
      const staged = await stageSelectedAccounts({
        fs,
        path,
        fse,
        aiHomeDir: deps.aiHomeDir,
        selectors,
        stageRoot: tmpStageDir,
        onProgress: (progress) => {
          const total = Math.max(1, Number(progress && progress.total) || 0);
          const current = Math.min(total, Math.max(0, Number(progress && progress.current) || 0));
          const labelParts = [
            `Writing account JSON files ${current}/${total}`,
            `accounts=${Number(progress && progress.copiedAccounts || 0)}`,
            `files=${Number(progress && progress.copiedFiles || 0)}`
          ];
          if (Number(progress && progress.skippedAccounts) > 0) labelParts.push(`skipped=${Number(progress.skippedAccounts)}`);
          if (progress && progress.fileName) labelParts.push(`last=${progress.fileName}`);
          if (progress && progress.accountRef) {
            labelParts.push(`last=${progress.accountRef}`);
          }
          renderStageProgress('[aih export]', 1, exportStages, labelParts.join(' '));
        }
      });
      if (staged.copiedAccounts === 0 || staged.copiedFiles === 0) {
        throw new Error('No standard account JSON files found in selected accounts.');
      }

      renderStageProgress('[aih export]', 2, exportStages, 'Building zip archive');
      const outPath = path.resolve(targetFile);
      createZipArchive({
        execSync,
        processImpl,
        stageDir: tmpStageDir,
        outPath
      });

      renderStageProgress('[aih export]', 3, exportStages, 'Completed');
      consoleImpl.log(`\x1b[90m[aih]\x1b[0m providers=${staged.providerDirs.join(', ')} accounts=${staged.copiedAccounts} files=${staged.copiedFiles}${staged.skippedAccounts ? ` skipped=${staged.skippedAccounts}` : ''}`);
      consoleImpl.log(`\x1b[32m[Success] Backup exported:\x1b[0m ${outPath}`);
    } catch (error) {
      exitCode = 1;
      consoleImpl.error(`\n\x1b[31m[Error] Failed to export: ${error.message}\x1b[0m`);
    } finally {
      if (fs.existsSync(tmpStageDir)) fse.removeSync(tmpStageDir);
    }

    processImpl.exit(exitCode);
    return true;
  }

  if (typeof deps.runUnifiedImport === 'function') {
    let exitCode = 0;
    try {
      const result = await deps.runUnifiedImport(args.slice(1), {
        log: (line) => consoleImpl.log(line),
        error: (line) => consoleImpl.error(line),
        renderStageProgress
      });
      if (result.failedSources.length > 0) {
        exitCode = 1;
      }
    } catch (error) {
      exitCode = 1;
      consoleImpl.error(`\n\x1b[31m[Error] Failed to import: ${error.message}\x1b[0m`);
    }
    processImpl.exit(exitCode);
    return true;
  }

  let targetFile = '';
  let provider = '';
  let folderHint = '';
  try {
    const parsed = parseImportArgs(args.slice(1));
    targetFile = parsed.targetFile;
    provider = String(parsed.provider || '').trim().toLowerCase();
    folderHint = String(parsed.folder || '').trim();
    if (parsed.overwrite) {
      consoleImpl.log('\x1b[90m[aih]\x1b[0m -o/--overwrite ignored for zip import.');
    }
  } catch (error) {
    consoleImpl.error('\x1b[31m[aih] '
      + `${error.message}. Usage: aih import [provider] <file.zip> [-f <folder>]\x1b[0m`);
    processImpl.exit(1);
    return true;
  }

  if (!targetFile || !fs.existsSync(targetFile)) {
    consoleImpl.error('\x1b[31m[aih] File not found. Usage: aih import [provider] <file.zip> [-f <folder>]\x1b[0m');
    processImpl.exit(1);
    return true;
  }

  const targetPath = path.resolve(targetFile);
  let exitCode = 0;

  try {
    const renderImportProgress = (percent, label) => {
      renderStageProgress('[aih import]', clampPercent(percent), 100, label);
    };
    const hashStart = 1;
    const hashEnd = 34;
    const extractStart = 35;
    const extractEnd = 86;
    const importStart = 87;
    const importEnd = 99;

    renderImportProgress(hashStart, 'Hashing archive');
    const prepared = await ensureArchiveExtractedByHash({
      fs,
      path,
      os,
      fse,
      execSync,
      processImpl,
      zipPath: targetPath,
      cryptoImpl,
      aiHomeDir,
      spawnImpl: deps.spawnImpl,
      onHashProgress: (processed, total) => {
        const ratio = total > 0 ? processed / total : 1;
        const pct = mapProgressRange(hashStart, hashEnd, ratio);
        renderImportProgress(pct, `Hashing archive ${formatBytes(processed)} / ${formatBytes(total)}`);
      },
      onExtractProgress: (extractPct) => {
        const pct = mapProgressRange(extractStart, extractEnd, (Number(extractPct) || 0) / 100);
        renderImportProgress(pct, `Extracting zip archive (${clampPercent(extractPct)}%)`);
      }
    });
    if (prepared.cacheHit) {
      renderImportProgress(extractEnd, `Using cached extraction (${prepared.hash.slice(0, 12)})`);
    } else {
      renderImportProgress(extractEnd, `Extracting zip archive done (${prepared.hash.slice(0, 12)})`);
    }

    const resolved = resolveImportSourceRoot({
      fs,
      path,
      fse,
      extractDir: prepared.extractDir,
      provider,
      folderHint
    });

    renderImportProgress(importStart, 'Running import');
    const importResult = await runGlobalAccountImport([resolved.sourceRoot], {
      fs,
      log: (line) => consoleImpl.log(line),
      error: (line) => consoleImpl.error(line),
      parseCodexBulkImportArgs,
      importCodexTokensFromOutput,
      quiet: true,
      providerLog: false,
      onProviderProgress: (processedProviders, totalProviders, providerName) => {
        const ratio = totalProviders > 0 ? processedProviders / totalProviders : 1;
        const pct = mapProgressRange(importStart, importEnd, ratio);
        const safeProvider = String(providerName || '').trim() || 'provider';
        renderImportProgress(pct, `Importing ${safeProvider} (${processedProviders}/${totalProviders})`);
      }
    });

    const summary = summarizeAccountImportResult(importResult);
    renderImportProgress(100, 'Completed');
    consoleImpl.log(
      `\x1b[32m[Success] Import completed!\x1b[0m providers=${summary.providers.join(', ') || 'none'} `
      + `accounts_total=${summary.accountsTotal} imported=${summary.imported}, duplicates=${summary.duplicates}, invalid=${summary.invalid}, failed=${summary.failed}`
    );
  } catch (error) {
    exitCode = 1;
    consoleImpl.error(`\n\x1b[31m[Error] Failed to import: ${error.message}\x1b[0m`);
  }

  processImpl.exit(exitCode);
  return true;
}

module.exports = {
  runBackupCommand,
  __private: {
    resolveImportSourceRoot,
    resolveBundled7zipPath,
    tryExtractZipWith7z,
    directoryExists,
    listChildDirectories,
    computeFileSha256,
    ensureArchiveExtractedByHash,
    isArchiveExtractCacheReady
  }
};
