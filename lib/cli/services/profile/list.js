'use strict';

function createProfileListService(options = {}) {
  const {
    fs,
    path,
    processObj,
    readline,
    profilesDir,
    cliConfigs,
    listPageSize,
    getToolAccountIds,
    getAccountStateIndex,
    checkStatus,
    isExhausted,
    formatUsageLabel,
    refreshIndexedStateForAccount
  } = options;

  function readPagerKey() {
    const stdin = processObj && processObj.stdin;
    if (stdin && stdin.isTTY && typeof stdin.fd === 'number' && typeof stdin.setRawMode === 'function' && typeof fs.readSync === 'function') {
      const wasRaw = !!stdin.isRaw;
      const wasPaused = typeof stdin.isPaused === 'function' ? stdin.isPaused() : false;
      try {
        stdin.setRawMode(true);
        if (typeof stdin.resume === 'function') stdin.resume();
        const buf = Buffer.alloc(1);
        const bytes = fs.readSync(stdin.fd, buf, 0, 1, null);
        if (bytes > 0) return String.fromCharCode(buf[0]);
      } catch (_error) {
      } finally {
        try { stdin.setRawMode(wasRaw); } catch (_error) {}
        if (wasPaused && typeof stdin.pause === 'function') stdin.pause();
      }
      return '';
    }
    try {
      return String(readline.keyIn('', { hideEchoBack: true, mask: '', limit: ` q${String.fromCharCode(3)}` }) || '');
    } catch (_error) {
      return String.fromCharCode(3);
    }
  }

  function showLsHelp(scope = null) {
    const target = scope ? `aih ${scope} ls` : 'aih ls';
    console.log(`
\x1b[36mAI Home List Mode Help\x1b[0m

\x1b[33mUsage:\x1b[0m
  ${target}
  ${target} <id>

\x1b[33mBehavior:\x1b[0m
  - Default output: first ${listPageSize} accounts.
  - Interactive mode: if output is a terminal (TTY), shows pager prompt after each page.
  - Keys in pager: \x1b[32mSpace\x1b[0m = next page, \x1b[32mq\x1b[0m = quit, \x1b[32mCtrl+C\x1b[0m = quit.
  - Non-interactive mode (pipe/redirect): show first ${listPageSize} and print omitted count.

\x1b[33mExamples:\x1b[0m
  aih ls
  aih codex ls
  aih codex ls 24444
  aih codex ls --help
`);
  }

  function listProfiles(filterCliName = null, filterAccountId = null) {
    console.log('\n\x1b[36m📦 AI Home Accounts Overview\x1b[0m\n');

    if (!fs.existsSync(profilesDir)) {
      console.log('  No profiles found.');
      return;
    }

    let tools = fs.readdirSync(profilesDir)
      .filter((f) => fs.statSync(path.join(profilesDir, f)).isDirectory())
      .filter((f) => !!cliConfigs[f]);

    if (filterCliName) {
      tools = tools.filter((t) => t === filterCliName);
    }

    if (tools.length === 0) {
      console.log('  No profiles found.');
      return;
    }

    tools.forEach((tool) => {
      console.log(`\x1b[33m▶ ${tool}\x1b[0m`);
      const toolDir = path.join(profilesDir, tool);
      const indexedStates = getAccountStateIndex().listStates(tool);
      const indexedMap = new Map(indexedStates.map((row) => [row.accountId, row]));
      let ids = [];
      if (indexedStates.length > 0) {
        const indexedIds = indexedStates
          .filter((row) => row && row.accountId)
          .map((row) => String(row.accountId));
        const fileIds = getToolAccountIds(tool).filter((id) => /^\d+$/.test(String(id || '')));
        ids = Array.from(new Set([...indexedIds, ...fileIds]))
          .sort((a, b) => Number(a) - Number(b));
      } else {
        ids = getToolAccountIds(tool);
      }
      if (filterAccountId && /^\d+$/.test(String(filterAccountId))) {
        ids = ids.filter((id) => String(id) === String(filterAccountId));
      }
      if (ids.length === 0) {
        console.log('  (Empty)');
      } else {
        const seenAccounts = new Map();
        let defaultId = null;
        try {
          const defPath = path.join(toolDir, '.aih_default');
          if (fs.existsSync(defPath)) defaultId = fs.readFileSync(defPath, 'utf8').trim();
        } catch (_error) {}

        const interactivePager = !!(processObj.stdout && processObj.stdout.isTTY);
        let cursor = 0;
        while (cursor < ids.length) {
          const batch = ids.slice(cursor, cursor + listPageSize);
          batch.forEach((id) => {
            if (!/^\d+$/.test(String(id || ''))) return;
            const pDir = path.join(toolDir, id);
            const status = checkStatus(tool, pDir);
            const accountName = status && status.accountName ? String(status.accountName) : 'Unknown';
            const apiKeyMode = !!(accountName && accountName.startsWith('API Key'));
            let configured = !!(status && status.configured);
            let usageLabel = '';
            let remainingPct = null;
            let exhaustedFlag = false;

            const refreshed = refreshIndexedStateForAccount(tool, id, { refreshSnapshot: false });
            if (refreshed) {
              if (typeof refreshed.configured === 'boolean') configured = refreshed.configured;
              if (typeof refreshed.exhausted === 'boolean') exhaustedFlag = refreshed.exhausted;
              if (typeof refreshed.remainingPct === 'number') {
                remainingPct = refreshed.remainingPct;
                usageLabel = `\x1b[36m[Remaining: ${refreshed.remainingPct.toFixed(1)}%]\x1b[0m`;
              }
            } else {
              const row = indexedMap.get(id);
              exhaustedFlag = !!(row && row.exhausted);
              if (row && typeof row.remainingPct === 'number') {
                remainingPct = row.remainingPct;
                usageLabel = `\x1b[36m[Remaining: ${row.remainingPct.toFixed(1)}%]\x1b[0m`;
              }
            }

            if (apiKeyMode) {
              usageLabel = '\x1b[90m[Remaining: API Key mode]\x1b[0m';
            } else if (!usageLabel && configured) {
              usageLabel = formatUsageLabel(tool, id, accountName);
            } else {
              exhaustedFlag = isExhausted(tool, id);
            }

            if (!configured) {
              usageLabel = '\x1b[90m[Remaining: Unconfigured (login required)]\x1b[0m';
            } else if (!apiKeyMode && !usageLabel) {
              usageLabel = '\x1b[90m[Remaining: Unknown]\x1b[0m';
            }
            if (!filterAccountId && configured && !apiKeyMode && Number.isFinite(remainingPct) && remainingPct <= 0) {
              return;
            }

            const exhausted = exhaustedFlag ? '\x1b[31m[Exhausted Limit]\x1b[0m ' : '';
            const isDefault = (id === defaultId) ? '\x1b[32m[★ Default]\x1b[0m ' : '';
            const statusStr = configured
              ? '\x1b[32mActive\x1b[0m'
              : '\x1b[90mPending Login\x1b[0m';
            const accountInfo = configured && accountName !== 'Unknown' ? `(${accountName})` : '';

            let duplicateWarning = '';
            if (configured && accountName !== 'Unknown' && accountName !== 'Token Configured' && !accountName.startsWith('API Key')) {
              if (seenAccounts.has(accountName)) {
                duplicateWarning = ` \x1b[31m[⚠️ Duplicate of ID ${seenAccounts.get(accountName)}]\x1b[0m`;
              } else {
                seenAccounts.set(accountName, id);
              }
            }

            console.log(`  - Account ID: \x1b[36m${id}\x1b[0m  ${isDefault}[${statusStr}] ${exhausted}\x1b[35m${accountInfo}\x1b[0m ${usageLabel} ${duplicateWarning}`);
          });
          cursor += batch.length;
          if (cursor >= ids.length) break;
          const remaining = ids.length - cursor;
          if (!interactivePager) {
            console.log(`  \x1b[90m... omitted ${remaining} accounts\x1b[0m`);
            break;
          }
          processObj.stdout.write(`  \x1b[90m-- More (${remaining} remaining) [Space=next, q=quit, Ctrl+C=quit]\x1b[0m`);
          const key = readPagerKey();
          processObj.stdout.write('\r\x1b[K');
          if (key === String.fromCharCode(3) || key.toLowerCase() === 'q') {
            console.log(`  \x1b[90m... omitted ${remaining} accounts\x1b[0m`);
            break;
          }
        }
      }
      console.log('');
    });
  }

  function countProfiles(filterCliName = null) {
    if (!fs.existsSync(profilesDir)) {
      return { total: 0, providers: {} };
    }

    let tools = fs.readdirSync(profilesDir)
      .filter((f) => fs.statSync(path.join(profilesDir, f)).isDirectory())
      .filter((f) => !!cliConfigs[f]);

    if (filterCliName) {
      tools = tools.filter((t) => t === filterCliName);
    }

    const providers = {};
    let total = 0;
    tools.forEach((tool) => {
      const count = getToolAccountIds(tool).filter((id) => /^\d+$/.test(String(id || ''))).length;
      providers[tool] = count;
      total += count;
    });

    return { total, providers };
  }

  return {
    showLsHelp,
    listProfiles,
    countProfiles
  };
}

module.exports = {
  createProfileListService
};
