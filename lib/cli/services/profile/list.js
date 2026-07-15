'use strict';

const { resolveEffectiveAccountStatus } = require('../../../account/status-file');
const {
  deriveRuntimeStatus,
  isBlockingRuntimeStatus,
  isAuthInvalidRuntimeStatus,
  formatRuntimeStatusLabel
} = require('../../../account/runtime-view');
const { readAccountCredentials } = require('../../../server/account-credential-store');
const { listCliAccountRefRecords } = require('../../../server/account-ref-store');
const { readDefaultAccountRef } = require('../../../account/default-account-store');

function createProfileListService(options = {}) {
  const {
    fs,
    path,
    processObj,
    readline,
    aiHomeDir,
    cliConfigs,
    listPageSize,
    getAccountStateIndex,
    checkStatus,
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

  function readLatestIndexedRow(accountRef, fallbackRow) {
    if (typeof getAccountStateIndex !== 'function') return fallbackRow;
    const index = getAccountStateIndex();
    if (!index || typeof index.getAccountState !== 'function') return fallbackRow;
    return index.getAccountState(accountRef) || fallbackRow;
  }

  function readCodexMobileAccountRef() {
    const env = (processObj && processObj.env) || {};
    const envRef = String(env.AIH_CODEX_DESKTOP_ACCOUNT_REF || '').trim();
    if (/^acct_[a-f0-9]{20}$/.test(envRef)) return envRef;
    const statePath = path.join(aiHomeDir, 'run', 'codex', 'desktop-hook-state.json');
    try {
      if (!fs.existsSync(statePath)) return '';
      const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const stateRef = String(parsed && parsed.desktopAccountRef || '').trim();
      return /^acct_[a-f0-9]{20}$/.test(stateRef) ? stateRef : '';
    } catch (_error) {
      return '';
    }
  }

  function listProfiles(filterCliName = null, filterAccountId = null) {
    console.log('\n\x1b[36m📦 AI Home Accounts Overview\x1b[0m\n');

    let tools = Object.keys(cliConfigs)
      .filter((tool) => listCliAccountRefRecords(fs, aiHomeDir, tool, { bestEffort: true }).length > 0);

    if (filterCliName) {
      tools = tools.filter((t) => t === filterCliName);
    }

    if (tools.length === 0) {
      console.log('  No profiles found.');
      return;
    }

    tools.forEach((tool) => {
      console.log(`\x1b[33m▶ ${tool}\x1b[0m`);
      const indexedStates = getAccountStateIndex().listStates(tool);
      const indexedMap = new Map(indexedStates.map((row) => [row.accountRef, row]));
      let records = listCliAccountRefRecords(fs, aiHomeDir, tool, { bestEffort: true });
      if (filterAccountId && /^\d+$/.test(String(filterAccountId))) {
        records = records.filter((record) => record.cliAccountId === String(filterAccountId));
      }
      if (records.length === 0) {
        console.log('  (Empty)');
      } else {
        const seenAccounts = new Map();
        const defaultRef = readDefaultAccountRef(fs, aiHomeDir, tool);
        const mobileRef = tool === 'codex' ? readCodexMobileAccountRef() : '';

        const interactivePager = !!(processObj.stdout && processObj.stdout.isTTY);
        let cursor = 0;
        while (cursor < records.length) {
          const batch = records.slice(cursor, cursor + listPageSize);
          batch.forEach((record) => {
            const id = record.cliAccountId;
            const accountRef = record.accountRef;
            const status = checkStatus(tool, accountRef);
            const accountName = status && status.accountName ? String(status.accountName) : 'Unknown';
            let configured = !!(status && status.configured);
            let usageLabel = '';
            let remainingPct = null;
            let quotaStatus = '';
            const row = indexedMap.get(accountRef) || null;
            const credentials = readAccountCredentials(fs, aiHomeDir, accountRef);
            const apiKeyMode = Boolean(
              (row && row.apiKeyMode)
              || credentials.OPENAI_API_KEY
              || credentials.ANTHROPIC_API_KEY
              || credentials.ANTHROPIC_AUTH_TOKEN
              || credentials.GEMINI_API_KEY
              || credentials.GOOGLE_API_KEY
            );
            let operationalStatus = resolveEffectiveAccountStatus(row && row.status);

            const refreshed = refreshIndexedStateForAccount(tool, accountRef, { refreshSnapshot: false });
            if (refreshed) {
              if (refreshed.status !== undefined && refreshed.status !== null) {
                operationalStatus = resolveEffectiveAccountStatus(refreshed.status);
              }
              if (typeof refreshed.configured === 'boolean') configured = refreshed.configured;
              quotaStatus = String(refreshed.quotaStatus || '').trim();
              // Keep the numeric value for sorting/fallback, but let
              // formatUsageLabel render the per-window detail (5h / 7days) so
              // ls speaks the same language as `usage` and the PTY title.
              if (typeof refreshed.remainingPct === 'number') {
                remainingPct = refreshed.remainingPct;
              }
            } else if (row && typeof row.remainingPct === 'number') {
              remainingPct = row.remainingPct;
            }
            const latestRow = readLatestIndexedRow(accountRef, row);
            const runtimeStatus = deriveRuntimeStatus(latestRow);
            const runtimeBlocked = isBlockingRuntimeStatus(runtimeStatus);
            const accountStatus = operationalStatus === 'down' ? '\x1b[90m关闭\x1b[0m' : '\x1b[32m启用\x1b[0m';

            if (apiKeyMode) {
              // ✅ API Key 模式:显示 Base URL (如果有)
              const baseUrl = String(
                credentials.OPENAI_BASE_URL
                || credentials.ANTHROPIC_BASE_URL
                || credentials.GEMINI_BASE_URL
                || ''
              ).trim();

              if (baseUrl) {
                usageLabel = `\x1b[90m[Base URL: ${baseUrl}]\x1b[0m`;
              } else {
                usageLabel = '\x1b[90m[Remaining: API Key mode]\x1b[0m';
              }
            } else if (!usageLabel && configured) {
              // Prefer the per-window detail (5h / 7days) from the cache so ls
              // matches `usage` and the title; fall back to the single numeric
              // value when no windowed snapshot is available.
              usageLabel = formatUsageLabel(tool, accountRef, accountName);
              if (!usageLabel && typeof remainingPct === 'number') {
                usageLabel = `\x1b[36m[Remaining: ${remainingPct.toFixed(1)}%]\x1b[0m`;
              }
            }

            if (runtimeBlocked) {
              usageLabel = `\x1b[31m${formatRuntimeStatusLabel(runtimeStatus)}\x1b[0m`;
              remainingPct = null;
            }

            if (!configured) {
              usageLabel = '\x1b[90m[Remaining: Unconfigured (login required)]\x1b[0m';
            } else if (!apiKeyMode && !usageLabel) {
              usageLabel = '\x1b[90m[Remaining: Unknown]\x1b[0m';
            }
            if (!filterAccountId && !runtimeBlocked && configured && !apiKeyMode && Number.isFinite(remainingPct) && remainingPct <= 0) {
              return;
            }

            const quotaBadge = runtimeBlocked
              ? (isAuthInvalidRuntimeStatus(runtimeStatus) ? '\x1b[31m[认证失效]\x1b[0m ' : '\x1b[31m[运行态不可用]\x1b[0m ')
              : (!apiKeyMode && quotaStatus === 'exhausted')
              ? '\x1b[31m[额度已耗尽]\x1b[0m '
              : '';
            const roleBadges = [
              accountRef === defaultRef ? '\x1b[32m[★ Default]\x1b[0m' : '',
              tool === 'codex' && accountRef === mobileRef ? '\x1b[35m[📱 Mobile]\x1b[0m' : ''
            ].filter(Boolean).join(' ');
            const rolePrefix = roleBadges ? `${roleBadges} ` : '';
            const statusStr = runtimeBlocked
              ? (isAuthInvalidRuntimeStatus(runtimeStatus) ? '\x1b[31mAuth Expired\x1b[0m' : '\x1b[31mRuntime Blocked\x1b[0m')
              : configured
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

            console.log(`  - Account ID: \x1b[36m${id}\x1b[0m  ${rolePrefix}[${statusStr}] [${accountStatus}] ${quotaBadge}\x1b[35m${accountInfo}\x1b[0m ${usageLabel} ${duplicateWarning}`);
          });
          cursor += batch.length;
          if (cursor >= records.length) break;
          const remaining = records.length - cursor;
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
    let tools = Object.keys(cliConfigs)
      .filter((tool) => listCliAccountRefRecords(fs, aiHomeDir, tool, { bestEffort: true }).length > 0);

    if (filterCliName) {
      tools = tools.filter((t) => t === filterCliName);
    }

    const providers = {};
    let total = 0;
    tools.forEach((tool) => {
      const count = listCliAccountRefRecords(fs, aiHomeDir, tool, { bestEffort: true }).length;
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
