'use strict';

const { createAccountRemovalService } = require('../../../account/account-removal');
const {
  listCliAccountRefRecords,
  resolveAccountRefByCliId
} = require('../../../server/account-ref-store');

function createAccountCleanupService(options = {}) {
  const {
    fs,
    aiHomeDir,
    accountStateService
  } = options;
  const accountRemovalService = createAccountRemovalService({
    ...options,
    fs,
    aiHomeDir,
    accountStateService
  });

  function listCliAccountIds(cliName) {
    return listCliAccountRefRecords(fs, aiHomeDir, cliName, { bestEffort: true })
      .map((record) => record.cliAccountId)
      .filter((cliAccountId) => /^\d+$/.test(cliAccountId))
      .sort((left, right) => Number(left) - Number(right));
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
    var provider = String(cliName || '').trim();
    if (!provider) {
      return { provider: provider, requestedIds: [], deletedIds: [], missingIds: [] };
    }
    var requestedIds = Array.isArray(ids) ? ids.filter(function (id) { return /^\d+$/.test(String(id || '')); }) : [];
    const deletedIds = [];
    const missingIds = [];

    requestedIds.forEach(function (id) {
      const account = resolveAccountRefByCliId(fs, aiHomeDir, provider, id, { bestEffort: true });
      if (!account) {
        missingIds.push(String(id));
        return;
      }
      const result = deleteAccountByRef(provider, account.accountRef);
      if (result.deleted) {
        deletedIds.push(String(id));
      } else {
        missingIds.push(String(id));
      }
    });

    return { provider: provider, requestedIds: requestedIds, deletedIds: deletedIds, missingIds: missingIds };
  }

  function deleteAccountByRef(cliName, accountRef) {
    return accountRemovalService.deleteAccountByRef(cliName, accountRef);
  }

  function deleteAllAccountsForCli(cliName) {
    const ids = listCliAccountIds(cliName);
    const result = deleteAccountsForCli(cliName, ids);
    return { ...result, totalBeforeDelete: ids.length };
  }

  return {
    parseDeleteSelectorTokens,
    deleteAccountByRef,
    deleteAccountsForCli,
    deleteAllAccountsForCli
  };
}

module.exports = {
  createAccountCleanupService
};
