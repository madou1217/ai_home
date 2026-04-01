'use strict';

function createBackupRestoreService(deps = {}) {
  const {
    fs,
    path,
    fse,
    ensureDir,
    profilesDir,
    checkStatus
  } = deps;

  function isNumericAccountId(name) {
    return /^\d+$/.test(String(name || ''));
  }

  function getProfileIdentityLabel(cliName, profileDir) {
    const { configured, accountName } = checkStatus(cliName, profileDir);
    if (!configured) return 'Pending Login';
    if (!accountName || accountName === 'Unknown') return 'Unknown';
    return accountName;
  }

  function formatRestoreEntry(entry) {
    return `${entry.tool} ${entry.id} (${entry.identity})`;
  }

  function printRestoreDetails(title, color, entries, consoleImpl = console) {
    if (!entries || entries.length === 0) return;
    consoleImpl.log(`${color}${title}\x1b[0m`);
    entries.forEach((entry) => {
      consoleImpl.log(`  - ${formatRestoreEntry(entry)}`);
    });
  }

  function restoreProfilesFromExtractedBackup(extractRoot, overwriteExisting, onAccountProgress) {
    const srcProfilesDir = path.join(extractRoot, 'profiles');
    if (!fs.existsSync(srcProfilesDir) || !fs.statSync(srcProfilesDir).isDirectory()) {
      throw new Error('Backup archive does not contain a profiles/ directory.');
    }

    ensureDir(profilesDir);
    const summary = {
      imported: 0,
      overwritten: 0,
      skipped: 0,
      metadataCopied: 0,
      importedAccounts: [],
      overwrittenAccounts: [],
      skippedAccounts: [],
      totalAccounts: 0
    };

    const tools = fs.readdirSync(srcProfilesDir)
      .filter((name) => fs.statSync(path.join(srcProfilesDir, name)).isDirectory());

    tools.forEach((tool) => {
      const srcToolDir = path.join(srcProfilesDir, tool);
      const entries = fs.readdirSync(srcToolDir, { withFileTypes: true });
      entries.forEach((entry) => {
        if (entry.isDirectory() && isNumericAccountId(entry.name)) {
          summary.totalAccounts += 1;
        }
      });
    });

    let processedAccounts = 0;
    tools.forEach((tool) => {
      const srcToolDir = path.join(srcProfilesDir, tool);
      const dstToolDir = path.join(profilesDir, tool);
      ensureDir(dstToolDir);

      const entries = fs.readdirSync(srcToolDir, { withFileTypes: true });
      entries.forEach((entry) => {
        const srcEntry = path.join(srcToolDir, entry.name);
        const dstEntry = path.join(dstToolDir, entry.name);

        if (entry.isDirectory() && isNumericAccountId(entry.name)) {
          if (fs.existsSync(dstEntry)) {
            if (!overwriteExisting) {
              summary.skipped += 1;
              summary.skippedAccounts.push({
                tool,
                id: entry.name,
                identity: getProfileIdentityLabel(tool, dstEntry)
              });
              processedAccounts += 1;
              if (typeof onAccountProgress === 'function') {
                onAccountProgress(processedAccounts, summary.totalAccounts, `${tool}:${entry.name} skipped`);
              }
              return;
            }
            fse.removeSync(dstEntry);
            fse.copySync(srcEntry, dstEntry, { overwrite: true });
            summary.overwritten += 1;
            summary.overwrittenAccounts.push({
              tool,
              id: entry.name,
              identity: getProfileIdentityLabel(tool, dstEntry)
            });
            processedAccounts += 1;
            if (typeof onAccountProgress === 'function') {
              onAccountProgress(processedAccounts, summary.totalAccounts, `${tool}:${entry.name} overwritten`);
            }
            return;
          }
          fse.copySync(srcEntry, dstEntry, { overwrite: true });
          summary.imported += 1;
          summary.importedAccounts.push({
            tool,
            id: entry.name,
            identity: getProfileIdentityLabel(tool, dstEntry)
          });
          processedAccounts += 1;
          if (typeof onAccountProgress === 'function') {
            onAccountProgress(processedAccounts, summary.totalAccounts, `${tool}:${entry.name} imported`);
          }
          return;
        }

        if (overwriteExisting || !fs.existsSync(dstEntry)) {
          fse.copySync(srcEntry, dstEntry, { overwrite: true });
          summary.metadataCopied += 1;
        }
      });
    });

    return summary;
  }

  return {
    printRestoreDetails,
    restoreProfilesFromExtractedBackup
  };
}

module.exports = {
  createBackupRestoreService
};
