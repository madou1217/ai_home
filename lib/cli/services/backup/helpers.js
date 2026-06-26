'use strict';

function createBackupHelperService(options = {}) {
  const {
    fs,
    path,
    processObj,
    aiHomeDir,
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

  function expandSelectorsToPaths(selectors) {
    if (!selectors || selectors.length === 0) return ['profiles'];
    const targetSet = new Set();

    selectors.forEach((selRaw) => {
      const sel = String(selRaw || '').trim();
      if (!sel) return;

      if (sel.includes(':')) {
        const [toolRaw, idStrRaw] = sel.split(':');
        const tool = (toolRaw || '').trim();
        const idStr = (idStrRaw || '').trim();
        if (!cliConfigs[tool] || !idStr) return;

        const ids = idStr.split(',').map((x) => x.trim()).filter((x) => /^\d+$/.test(x));
        ids.forEach((id) => {
          const p = `profiles/${tool}/${id}`;
          if (fs.existsSync(path.join(aiHomeDir, p))) targetSet.add(p);
        });
        return;
      }

      if (cliConfigs[sel]) {
        const p = `profiles/${sel}`;
        if (fs.existsSync(path.join(aiHomeDir, p))) targetSet.add(p);
      }
    });

    return Array.from(targetSet);
  }

  return {
    ensureAesSuffix,
    defaultExportName,
    parseExportArgs,
    parseImportArgs,
    renderStageProgress,
    expandSelectorsToPaths
  };
}

module.exports = {
  createBackupHelperService
};
