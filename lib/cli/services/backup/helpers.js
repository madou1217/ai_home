'use strict';

function createBackupHelperService(options = {}) {
  const {
    path,
    processObj,
    cliConfigs
  } = options;

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function defaultExportName() {
    const d = new Date();
    const ts = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}${pad2(d.getHours())}${pad2(d.getMinutes())}`;
    return `ai-home+${ts}.zip`;
  }

  function ensureAesSuffix(fileName) {
    if (!fileName) return defaultExportName();
    return fileName.endsWith('.zip') ? fileName : `${fileName}.zip`;
  }

  function parseExportArgs(exportArgs) {
    if (!exportArgs || exportArgs.length === 0) {
      return { targetFile: defaultExportName(), selectors: [] };
    }

    const first = exportArgs[0];
    const looksLikeSelector = first.includes(':') || cliConfigs[first];

    if (looksLikeSelector) {
      return { targetFile: defaultExportName(), selectors: exportArgs };
    }

    return { targetFile: first, selectors: exportArgs.slice(1) };
  }

  function parseImportArgs(importArgs) {
    let targetFile = '';
    let overwrite = false;
    let provider = '';
    let folder = '';
    let seenProvider = false;
    const extra = [];
    const tokens = Array.isArray(importArgs) ? importArgs.slice() : [];

    function normalizeFolderHint(rawValue) {
      const normalized = String(rawValue || '').trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
      if (!normalized) throw new Error('Missing value for -f/--folder');
      if (path.isAbsolute(normalized)) throw new Error('Folder hint must be a relative path inside zip');
      if (normalized.split('/').includes('..')) throw new Error('Folder hint cannot contain ".."');
      return normalized;
    }

    function isProviderToken(value) {
      const key = String(value || '').trim().toLowerCase();
      return !!(key && cliConfigs && cliConfigs[key]);
    }

    for (let i = 0; i < tokens.length; i += 1) {
      const arg = String(tokens[i] || '').trim();
      if (!arg) continue;
      if (arg === '-o' || arg === '--overwrite') {
        overwrite = true;
        continue;
      }
      if (arg === '-f' || arg === '--folder' || arg === '--from') {
        folder = normalizeFolderHint(tokens[i + 1]);
        i += 1;
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
      if (
        !seenProvider
        && !targetFile
        && isProviderToken(arg)
        && i + 1 < tokens.length
      ) {
        provider = String(arg).trim().toLowerCase();
        seenProvider = true;
        continue;
      }
      if (!targetFile) {
        targetFile = arg;
        continue;
      }
      extra.push(arg);
    }
    if (extra.length > 0) {
      throw new Error(`Unexpected argument(s): ${extra.join(' ')}`);
    }
    return {
      targetFile,
      overwrite,
      provider,
      folder
    };
  }

  function buildProgressBar(current, total, width = 22) {
    const safeTotal = total > 0 ? total : 1;
    const ratio = Math.max(0, Math.min(1, current / safeTotal));
    const filled = Math.round(width * ratio);
    return `[${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}]`;
  }

  function renderStageProgress(prefix, current, total, label) {
    const safeTotal = total > 0 ? total : 1;
    const ratio = Math.max(0, Math.min(1, current / safeTotal));
    const pct = Math.round(ratio * 100);
    const bar = buildProgressBar(current, safeTotal);
    processObj.stdout.write(`\r${prefix} ${bar} ${String(pct).padStart(3, ' ')}% ${label}\x1b[K`);
    if (current >= safeTotal) {
      processObj.stdout.write('\n');
    }
  }

  return {
    ensureAesSuffix,
    defaultExportName,
    parseExportArgs,
    parseImportArgs,
    renderStageProgress
  };
}

module.exports = {
  createBackupHelperService
};
