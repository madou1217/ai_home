'use strict';

const { execFileSync } = require('node:child_process');
const { createAccountRemovalService } = require('../../../account/account-removal');
const { readGoAccounts } = require('../../../account/go-bridge/go-account-store-reader');
const { readServerConfig } = require('../../../server/server-config-store');
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
    const ids = new Set(
      listCliAccountRefRecords(fs, aiHomeDir, cliName, { bestEffort: true })
        .map((record) => record.cliAccountId)
        .filter((cliAccountId) => /^\d+$/.test(cliAccountId))
    );
    // Go 独有账号没有 Node ref（agy）：删除/列表都必须把 Go 侧的数字别名并进来。
    readGoAccounts(aiHomeDir, { fs }).accounts.forEach((account) => {
      if (account.provider !== cliName) return;
      if (!/^\d+$/.test(String(account.cliAccountId))) return;
      ids.add(String(account.cliAccountId));
    });
    return Array.from(ids).sort((left, right) => Number(left) - Number(right));
  }

  // findGoOnlyAccountRef 在 Node 台账没有时按数字别名查 Go 账号。
  function findGoOnlyAccountRef(cliName, id) {
    const target = String(id);
    const account = readGoAccounts(aiHomeDir, { fs }).accounts.find((item) => (
      item.provider === cliName && String(item.cliAccountId) === target
    ));
    return account ? account.accountRef : '';
  }

  // deleteGoOnlyAccount 调用运行中的宿主删除路由。
  //
  // 该路由已经处理 Go 独有账号、agy 暖机进程驱逐与运行投影清理；CLI 不能直接删
  // Go 库，否则会绕开这些不变量。使用同步 curl 是为了保持 CLI 当前同步输出语义。
  function deleteGoOnlyAccount(cliName, accountRef) {
    const config = readServerConfig({ fs, aiHomeDir });
    const port = Number(config && config.port) || 9527;
    const key = String((config && config.managementKey) || '').trim();
    const url = 'http://127.0.0.1:' + port
      + '/v0/webui/accounts/' + encodeURIComponent(cliName)
      + '/' + encodeURIComponent(accountRef);
    try {
      const output = execFileSync('curl', [
        '-sS', '-m', '60', '-o', '/dev/null', '-w', '%{http_code}',
        '-X', 'DELETE',
        '-H', 'Authorization: Bearer ' + key,
        url
      ], { encoding: 'utf8' });
      const status = Number(String(output || '').trim());
      return status >= 200 && status < 300;
    } catch (_error) {
      return false;
    }
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
        // Go 独有账号（agy）没有 Node ref：交给宿主删除路由，不能判 missing。
        const goRef = findGoOnlyAccountRef(provider, id);
        if (goRef && deleteGoOnlyAccount(provider, goRef)) {
          deletedIds.push(String(id));
        } else {
          missingIds.push(String(id));
        }
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
