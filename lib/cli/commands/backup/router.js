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

function isNumericAccountId(name) {
  return /^\d+$/.test(String(name || ''));
}

const KNOWN_IMPORT_PROVIDERS = new Set(['codex', 'gemini', 'claude']);

function collectCredentialRelativePaths(provider) {
  const hiddenDir = `.${String(provider || '').trim()}`;
  return [
    '.aih_env.json',
    `${hiddenDir}/auth.json`,
    `${hiddenDir}/oauth_creds.json`,
    `${hiddenDir}/oauth.json`,
    `${hiddenDir}/token.json`,
    `${hiddenDir}/tokens.json`,
    `${hiddenDir}/credentials.json`,
    `${hiddenDir}/.credentials.json`,
    `${hiddenDir}/settings.json`,
    `${hiddenDir}/google_accounts.json`
  ];
}

function collectSelectedAccountDirs({ fs, path, aiHomeDir, targetPaths }) {
  const profilesRoot = path.join(aiHomeDir, 'profiles');
  if (!fs.existsSync(profilesRoot) || !fs.statSync(profilesRoot).isDirectory()) return [];

  const selected = new Map();
  const addAccount = (provider, id, profileDirOverride = '') => {
    if (!provider || !isNumericAccountId(id)) return;
    const key = `${provider}:${id}`;
    if (selected.has(key)) return;
    const profileDir = profileDirOverride || path.join(profilesRoot, provider, String(id));
    if (!profileDirOverride && (!fs.existsSync(profileDir) || !fs.statSync(profileDir).isDirectory())) return;
    selected.set(key, { provider, id: String(id), profileDir });
  };

  const addProviderAccounts = (provider) => {
    const providerDir = path.join(profilesRoot, provider);
    if (!fs.existsSync(providerDir) || !fs.statSync(providerDir).isDirectory()) return;
    fs.readdirSync(providerDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isNumericAccountId(entry.name))
      .forEach((entry) => addAccount(provider, entry.name, path.join(providerDir, String(entry.name))));
  };

  const seen = new Set(Array.isArray(targetPaths) ? targetPaths : []);
  if (seen.has('profiles')) {
    fs.readdirSync(profilesRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .forEach((entry) => addProviderAccounts(entry.name));
    return Array.from(selected.values());
  }

  Array.from(seen).forEach((raw) => {
    const rel = String(raw || '').trim();
    if (!rel || !rel.startsWith('profiles/')) return;
    const parts = rel.split('/').filter(Boolean);
    if (parts.length < 2) return;

    const provider = parts[1];
    if (parts.length === 2) {
      addProviderAccounts(provider);
      return;
    }

    addAccount(provider, parts[2]);
  });

  return Array.from(selected.values());
}

function resolveExportParallelism(getDefaultParallelism) {
  const raw = typeof getDefaultParallelism === 'function' ? Number(getDefaultParallelism()) : 1;
  const normalized = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1;
  return Math.max(1, Math.min(16, normalized));
}

async function stageSelectedProfilesAsAccounts({
  fs,
  path,
  fse,
  aiHomeDir,
  targetPaths,
  stageRoot,
  onProgress = null,
  getDefaultParallelism = null
}) {
  const accountsDir = path.join(stageRoot, 'accounts');
  fse.ensureDirSync(accountsDir);
  const providerSet = new Set();
  let copiedAccounts = 0;
  let copiedFiles = 0;

  const selectedAccounts = collectSelectedAccountDirs({
    fs,
    path,
    aiHomeDir,
    targetPaths
  });

  const emitProgress = (current, total, extra = {}) => {
    if (typeof onProgress !== 'function') return;
    onProgress({
      current,
      total,
      copiedAccounts,
      copiedFiles,
      ...extra
    });
  };

  emitProgress(0, selectedAccounts.length, { status: 'start' });

  const totalAccounts = selectedAccounts.length;
  const workerCount = Math.min(totalAccounts, resolveExportParallelism(getDefaultParallelism));
  let processedAccounts = 0;
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= totalAccounts) return;
      const account = selectedAccounts[index];
      const relFiles = collectCredentialRelativePaths(account.provider);
      const providerHiddenDir = `.${String(account.provider || '').trim()}`;
      let rootEntries = [];
      let hiddenEntries = [];
      try {
        rootEntries = await fs.promises.readdir(account.profileDir, { withFileTypes: true });
      } catch (_error) {}
      try {
        hiddenEntries = await fs.promises.readdir(path.join(account.profileDir, providerHiddenDir), { withFileTypes: true });
      } catch (_error) {}
      const rootFiles = new Set(
        rootEntries
          .filter((entry) => entry.isFile())
          .map((entry) => String(entry.name || ''))
      );
      const hiddenFiles = new Set(
        hiddenEntries
          .filter((entry) => entry.isFile())
          .map((entry) => String(entry.name || ''))
      );
      let accountCopied = false;
      for (const relFile of relFiles) {
        const segments = String(relFile || '').split('/').filter(Boolean);
        const fileName = segments[segments.length - 1] || '';
        const exists = segments.length === 1
          ? rootFiles.has(fileName)
          : (segments[0] === providerHiddenDir && hiddenFiles.has(fileName));
        if (!exists) continue;
        const src = path.join(account.profileDir, relFile);
        const dst = path.join(accountsDir, account.provider, account.id, relFile);
        await fse.ensureDir(path.dirname(dst));
        await fse.copy(src, dst, { overwrite: true });
        copiedFiles += 1;
        accountCopied = true;
      }

      if (accountCopied) {
        copiedAccounts += 1;
        providerSet.add(account.provider);
      }
      processedAccounts += 1;
      if (processedAccounts === totalAccounts || processedAccounts % 50 === 0) {
        emitProgress(processedAccounts, totalAccounts, {
          provider: account.provider,
          id: account.id,
          status: 'scanning',
          workerCount
        });
      }
    }
  };

  const workers = [];
  for (let i = 0; i < workerCount; i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);

  emitProgress(totalAccounts, totalAccounts, { status: 'done', workerCount });

  return {
    accountsDir,
    copiedAccounts,
    copiedFiles,
    providerDirs: Array.from(providerSet).sort()
  };
}

function createProviderFlatExportArchive({
  fs,
  path,
  fse,
  execSync,
  processImpl,
  ensureAesSuffix,
  defaultExportName,
  exportCliproxyapiCodexAuths,
  renderStageProgress,
  exportArgs,
  consoleImpl
}) {
  const provider = String(exportArgs[1] || '').trim().toLowerCase();
  const tailArgs = exportArgs.slice(2).map((item) => String(item || '').trim()).filter(Boolean);
  if (provider !== 'codex') {
    throw new Error(`Provider-scoped export is currently unsupported for ${provider || 'unknown'}`);
  }
  if (tailArgs.length > 1) {
    throw new Error('Provider export accepts at most one target zip path');
  }
  if (typeof exportCliproxyapiCodexAuths !== 'function') {
    throw new Error('codex flat export service is not wired');
  }

  const targetFile = ensureAesSuffix(tailArgs[0] || defaultExportName());
  const tmpStageDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'aih_provider_export_stage_'));
  try {
    const accountsProviderDir = path.join(tmpStageDir, 'accounts', provider);
    fse.ensureDirSync(accountsProviderDir);
    renderStageProgress('[aih export]', 1, 3, `Collecting ${provider} credential files`);
    const result = exportCliproxyapiCodexAuths({
      authDirOverride: accountsProviderDir,
      onProgress: (progress) => {
        const total = Math.max(1, Number(progress && progress.total) || 0);
        const scanned = Math.min(total, Math.max(0, Number(progress && progress.scanned) || 0));
        const labelParts = [
          `Collecting ${provider} oauth ${scanned}/${total}`,
          `ok=${Number(progress && progress.exported || 0)}`,
          `missing=${Number(progress && progress.skippedMissing || 0)}`,
          `invalid=${Number(progress && progress.skippedInvalid || 0)}`
        ];
        if (progress && progress.email) labelParts.push(`last=${progress.email}`);
        renderStageProgress('[aih export]', 1, 3, labelParts.join(' '));
      }
    });
    if (!result || Number(result.exported) <= 0) {
      throw new Error(`No exportable ${provider} OAuth credentials found`);
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
    consoleImpl.log(`\x1b[90m[aih]\x1b[0m providers=${provider} files=${Number(result.exported)}`);
    consoleImpl.log(`\x1b[32m[Success] Backup exported:\x1b[0m ${outPath}`);
    return { outPath, result };
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
    execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${src}\\accounts' -DestinationPath '${dst}' -Force"`, {
      stdio: 'ignore'
    });
    return;
  }
  execSync(`cd "${stageDir}" && zip -rq "${outPath}" "accounts"`, { stdio: 'ignore' });
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
    expandSelectorsToPaths,
    renderStageProgress,
    exportCliproxyapiCodexAuths,
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
        createProviderFlatExportArchive({
          fs,
          path,
          fse,
          execSync,
          processImpl,
          ensureAesSuffix,
          defaultExportName,
          exportCliproxyapiCodexAuths,
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
    if (exportArgs[0] === 'cliproxyapi' && exportArgs[1] === 'codex' && exportArgs.length !== 2) {
      consoleImpl.error('\x1b[31m[aih] Invalid CLIProxyAPI export syntax. Use exactly: aih export cliproxyapi codex\x1b[0m');
      processImpl.exit(1);
      return true;
    }
    if (exportArgs.length === 2 && exportArgs[0] === 'cliproxyapi' && exportArgs[1] === 'codex') {
      let exitCode = 0;
      try {
        if (typeof exportCliproxyapiCodexAuths !== 'function') {
          throw new Error('CLIProxyAPI codex export is not wired');
        }
        const result = exportCliproxyapiCodexAuths({
          onProgress: (progress) => {
            const phase = String(progress && progress.phase || '').trim() || 'scan';
            const total = Number(progress && progress.total) > 0 ? Number(progress.total) : 1;
            const scanned = Math.min(total, Math.max(0, Number(progress && progress.scanned) || 0));
            const applyTotal = Number(progress && progress.applyTotal) > 0 ? Number(progress.applyTotal) : 0;
            const applyProcessed = applyTotal > 0
              ? Math.min(applyTotal, Math.max(0, Number(progress && progress.applyProcessed) || 0))
              : 0;
            const status = String(progress && progress.status || '').trim() || 'scan';
            const labelParts = [
              phase === 'apply'
                ? `sync ${applyProcessed}/${Math.max(1, applyTotal)}`
                : `oauth ${scanned}/${total}`,
              `ok=${Number(progress && progress.exported || 0)}`,
              `missing=${Number(progress && progress.skippedMissing || 0)}`,
              `invalid=${Number(progress && progress.skippedInvalid || 0)}`
            ];
            if (status === 'exported' && progress.email) {
              labelParts.push(`last=${progress.email}`);
            } else if (status === 'deduped_target_keep') {
              labelParts.push('keep-better-target');
            } else if (progress.id) {
              labelParts.push(`last=#${progress.id} ${status}`);
            } else {
              labelParts.push(status);
            }
            renderStageProgress(
              '[aih export]',
              phase === 'apply' ? applyProcessed : scanned,
              phase === 'apply' ? Math.max(1, applyTotal) : total,
              labelParts.join(' ')
            );
          }
        });
        consoleImpl.log(`\x1b[36m[aih]\x1b[0m Exported codex OAuth auth files for CLIProxyAPI`);
        consoleImpl.log(`\x1b[90m[aih]\x1b[0m auth-dir=${result.authDir}`);
        if (result.configPath) {
          consoleImpl.log(`\x1b[90m[aih]\x1b[0m config=${result.configPath}`);
        }
        consoleImpl.log(
          `\x1b[90m[aih]\x1b[0m scanned=${result.scanned}`
          + ` exported=${result.exported}`
          + ` missing=${result.skippedMissing}`
          + ` invalid=${result.skippedInvalid}`
          + ` deduped_source=${Number(result.dedupedSource || 0)}`
          + ` deduped_target=${Number(result.dedupedTarget || 0)}`
        );
      } catch (error) {
        exitCode = 1;
        consoleImpl.error(`\x1b[31m[aih] Failed to export CLIProxyAPI codex auths: ${error.message}\x1b[0m`);
      }
      processImpl.exit(exitCode);
      return true;
    }

    const { targetFile: parsedTargetFile, selectors } = parseExportArgs(args.slice(1));
    const targetFile = ensureAesSuffix(parsedTargetFile || defaultExportName());
    const targetPaths = expandSelectorsToPaths(selectors);

    if (selectors.length > 0) {
      if (targetPaths.length === 0) {
        consoleImpl.error('\x1b[31m[aih] No matching profiles found for the given selectors.\x1b[0m');
        processImpl.exit(1);
        return true;
      }
      consoleImpl.log(`\x1b[36m[aih]\x1b[0m Preparing export targets:\n  - ${targetPaths.join('\n  - ')}`);
    } else {
      consoleImpl.log('\x1b[36m[aih]\x1b[0m Exporting credential JSON files only (accounts/<provider>/<id>/...).');
    }

    const tmpStageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aih_export_stage_'));
    let exitCode = 0;
    try {
      const exportStages = 3;
      renderStageProgress('[aih export]', 1, exportStages, 'Collecting credential files');
      const staged = await stageSelectedProfilesAsAccounts({
        fs,
        path,
        fse,
        aiHomeDir: deps.aiHomeDir,
        targetPaths,
        stageRoot: tmpStageDir,
        getDefaultParallelism: deps.getDefaultParallelism,
        onProgress: (progress) => {
          const total = Math.max(1, Number(progress && progress.total) || 0);
          const current = Math.min(total, Math.max(0, Number(progress && progress.current) || 0));
          const labelParts = [
            `Collecting credential files ${current}/${total}`,
            `accounts=${Number(progress && progress.copiedAccounts || 0)}`,
            `files=${Number(progress && progress.copiedFiles || 0)}`
          ];
          if (Number(progress && progress.workerCount) > 1) {
            labelParts.push(`workers=${Number(progress.workerCount)}`);
          }
          if (progress && progress.provider && progress.id) {
            labelParts.push(`last=${progress.provider}:${progress.id}`);
          }
          renderStageProgress('[aih export]', 1, exportStages, labelParts.join(' '));
        }
      });
      if (staged.copiedAccounts === 0 || staged.copiedFiles === 0) {
        throw new Error('No credential files found in selected accounts.');
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
      consoleImpl.log(`\x1b[90m[aih]\x1b[0m providers=${staged.providerDirs.join(', ')} accounts=${staged.copiedAccounts} files=${staged.copiedFiles}`);
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
