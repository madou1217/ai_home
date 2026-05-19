'use strict';

const path = require('node:path');
const { resolveAccountImporter, listImporterSupportedAiClis } = require('./importers');
const { getDefaultParallelism } = require('../../../runtime/parallelism');

function parseGlobalAccountImportArgs(rawArgs) {
  let sourceRoot = 'accounts';
  let dryRun = false;
  const tokens = Array.isArray(rawArgs) ? rawArgs.slice() : [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = String(tokens[i] || '').trim();
    if (!token) continue;
    if (token === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (!token.startsWith('-') && sourceRoot === 'accounts') {
      sourceRoot = token;
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }
  return {
    sourceRoot,
    dryRun
  };
}

async function runGlobalAccountImport(rawArgs, deps = {}) {
  const fs = deps.fs;
  const log = deps.log || console.log;
  const error = deps.error || console.error;
  const onProviderProgress = deps.onProviderProgress;
  const onImporterProgress = deps.onImporterProgress;
  const quiet = !!deps.quiet;
  const providerLogEnabled = deps.providerLog === undefined ? !quiet : !!deps.providerLog;
  const parseCodexBulkImportArgs = deps.parseCodexBulkImportArgs;
  const importCodexTokensFromOutput = deps.importCodexTokensFromOutput;

  const parsed = parseGlobalAccountImportArgs(rawArgs);
  const requestedParallel = Number(deps.parallel);
  const autoParallel = Number.isFinite(requestedParallel) && requestedParallel > 0
    ? Math.max(1, Math.floor(requestedParallel))
    : Math.max(1, getDefaultParallelism());
  const rootDir = path.resolve(parsed.sourceRoot);
  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    throw new Error(`Account source root not found: ${rootDir}`);
  }

  const entries = fs.readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  if (entries.length === 0) {
    throw new Error(`No provider directories found under ${rootDir}`);
  }

  const supported = [];
  const unsupported = [];
  for (const provider of entries) {
    if (resolveAccountImporter(provider)) {
      supported.push(provider);
    } else {
      unsupported.push(provider);
    }
  }

  if (supported.length === 0) {
    const supportedList = listImporterSupportedAiClis().join(', ') || 'none';
    throw new Error(`No supported importers found under ${rootDir}. supported_importers=${supportedList}`);
  }

  if (!quiet && unsupported.length > 0) {
    log(`\x1b[90m[aih]\x1b[0m skipped unsupported provider dirs: ${unsupported.join(', ')}`);
  }

  if (!quiet) {
    log(`\x1b[36m[aih]\x1b[0m import providers: ${supported.join(', ')}`);
  }

  const failures = [];
  const providerResults = [];
  for (let idx = 0; idx < supported.length; idx += 1) {
    const provider = supported[idx];
    const importer = resolveAccountImporter(provider);
    const providerSourceDir = path.join(rootDir, provider);
    let exitCode = 0;
    const importerArgs = [providerSourceDir, '--parallel', String(autoParallel)];
    if (parsed.dryRun) importerArgs.push('--dry-run');
    // Reuse provider-level importer contract while keeping global flow in-process.
    const providerResult = await importer(importerArgs, {
      parseCodexBulkImportArgs,
      importCodexTokensFromOutput,
      onProgress: (progress) => {
        if (typeof onImporterProgress === 'function') {
          onImporterProgress(provider, progress);
        }
      },
      log: (line) => {
        if (!providerLogEnabled) return;
        log(`[${provider}] ${line}`);
      },
      error: (line) => {
        if (!providerLogEnabled) return;
        error(`[${provider}] ${line}`);
      },
      exit: (code) => { exitCode = Number(code) || 0; }
    });
    if (providerResult && typeof providerResult === 'object') {
      providerResults.push({ provider, ...providerResult });
    } else {
      providerResults.push({ provider });
    }
    if (exitCode !== 0) {
      failures.push(provider);
    }
    if (typeof onProviderProgress === 'function') {
      onProviderProgress(idx + 1, supported.length, provider);
    }
  }

  if (!quiet) {
    log('\x1b[36m[aih]\x1b[0m import summary');
    providerResults.forEach((item) => {
      const mode = item.dryRun ? 'dry-run' : 'write';
      log(`  - ${item.provider}: mode=${mode}, imported=${item.imported ?? 0}, duplicates=${item.duplicates ?? 0}, invalid=${item.invalid ?? 0}, failed=${item.failed ?? 0}`);
    });
  }

  return {
    sourceRoot: rootDir,
    providers: supported,
    failedProviders: failures,
    providerResults
  };
}

module.exports = {
  parseGlobalAccountImportArgs,
  runGlobalAccountImport
};
