'use strict';

async function runCodexImporter(actionArgs, deps = {}) {
  const parseCodexBulkImportArgs = deps.parseCodexBulkImportArgs;
  const importCodexTokensFromOutput = deps.importCodexTokensFromOutput;
  const log = deps.log || console.log;
  const error = deps.error || console.error;
  const exit = typeof deps.exit === 'function' ? deps.exit : () => {};

  if (typeof parseCodexBulkImportArgs !== 'function' || typeof importCodexTokensFromOutput !== 'function') {
    error('\x1b[31m[aih] codex import service misconfigured.\x1b[0m');
    exit(1);
    throw new Error('codex import service misconfigured');
  }

  try {
    const parsed = parseCodexBulkImportArgs(actionArgs);
    if (typeof deps.onProgress === 'function') {
      parsed.onProgress = deps.onProgress;
    }
    if (deps.importSession && typeof deps.importSession === 'object') {
      parsed.importSession = deps.importSession;
    }
    const result = await importCodexTokensFromOutput(parsed);
    const modeLabel = result && result.dryRun ? 'dry-run' : 'write';
    log(`\x1b[36m[aih]\x1b[0m codex import done (${modeLabel})`);
    exit(0);
    return result;
  } catch (e) {
    error(`\x1b[31m[aih] codex import failed: ${e.message}\x1b[0m`);
    exit(1);
    return null;
  }
}

module.exports = {
  runCodexImporter
};
