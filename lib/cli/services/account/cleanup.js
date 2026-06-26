'use strict';

function createAccountCleanupService(options = {}) {
  const {
    fs,
    path,
    profilesDir,
    getProfileDir,
    accountStateService
  } = options;

  function listNumericDirs(dirPath) {
    if (!fs.existsSync(dirPath)) return [];
    return fs.readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => Number(a) - Number(b));
  }

  function listCliAccountIds(cliName) {
    const toolDir = path.join(profilesDir, String(cliName || '').trim());
    return listNumericDirs(toolDir);
  }

  function parseDeleteSelectorTokens(tokens) {
    const items = Array.isArray(tokens) ? tokens : [];
    const ids = [];
    items.forEach((tokenRaw) => {
      const token = String(tokenRaw || '').trim();
      if (!token) return;
      token.split(',').forEach((partRaw) => {
        const part = String(partRaw || '').trim();
        if (!part) return;
        if (/^\d+$/.test(part)) {
          ids.push(part);
          return;
        }
        const rangeMatch = part.match(/^(\d+)-(\d+)$/);
        if (rangeMatch) {
          const start = Number(rangeMatch[1]);
          const end = Number(rangeMatch[2]);
          if (!Number.isFinite(start) || !Number.isFinite(end) || start <= 0 || end <= 0 || start > end) {
            throw new Error(`invalid_delete_selector:${part}`);
          }
          for (let current = start; current <= end; current += 1) {
            ids.push(String(current));
          }
          return;
        }
        throw new Error(`invalid_delete_selector:${part}`);
      });
    });
    return Array.from(new Set(ids)).sort((a, b) => Number(a) - Number(b));
  }

  function deleteAccountsForCli(cliName, ids) {
    const provider = String(cliName || '').trim();
    if (!provider) {
      return { provider, requestedIds: [], deletedIds: [], missingIds: [] };
    }
    const requestedIds = Array.isArray(ids) ? ids.filter((id) => /^\d+$/.test(String(id || ''))) : [];
    const deletedIds = [];
    const missingIds = [];

    requestedIds.forEach((id) => {
      const profileDir = getProfileDir(provider, id);
      if (!fs.existsSync(profileDir)) {
        missingIds.push(String(id));
        return;
      }
      fs.rmSync(profileDir, { recursive: true, force: true });
      if (accountStateService && typeof accountStateService.deleteAccount === 'function') {
        accountStateService.deleteAccount(provider, String(id));
      }
      deletedIds.push(String(id));
    });

    return { provider, requestedIds, deletedIds, missingIds };
  }

  function deleteAllAccountsForCli(cliName) {
    const ids = listCliAccountIds(cliName);
    const result = deleteAccountsForCli(cliName, ids);
    return { ...result, totalBeforeDelete: ids.length };
  }

  return {
    parseDeleteSelectorTokens,
    deleteAccountsForCli,
    deleteAllAccountsForCli
  };
}

module.exports = {
  createAccountCleanupService
};
