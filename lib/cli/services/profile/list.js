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
const {
  activityOf,
  readAccountActivity,
  renderPrefix,
  runAnimatedList
} = require('./account-list-animator');

function createProfileListService(options = {}) {
  const {
    fs,
    path,
    processObj,
    aiHomeDir,
    cliConfigs,
    listPageSize,
    getAccountStateIndex,
    checkStatus,
    formatAccountPlanBadge,
    formatUsageLabel,
    refreshIndexedStateForAccount
  } = options;
  const renderAccountPlanBadge = typeof formatAccountPlanBadge === 'function'
    ? formatAccountPlanBadge
    : () => '';

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
    let tools = Object.keys(cliConfigs)
      .filter((tool) => listCliAccountRefRecords(fs, aiHomeDir, tool, { bestEffort: true }).length > 0);

    if (filterCliName) {
      tools = tools.filter((t) => t === filterCliName);
    }

    if (tools.length === 0) {
      console.log('  No profiles found.');
      return;
    }

    // 全局行集合：所有 provider 的行收集完后统一渲染/动画，保证整屏重绘完整。
    const outputRows = [];
    const rowMeta = [];
    outputRows.push(() => '\n\x1b[36m📦 AI Home Accounts Overview\x1b[0m\n');
    rowMeta.push(null);

    tools.forEach((tool) => {
      outputRows.push(() => `\x1b[33m▶ ${tool}\x1b[0m`);
      rowMeta.push(null);
      const indexedStates = getAccountStateIndex().listStates(tool);
      const indexedMap = new Map(indexedStates.map((row) => [row.accountRef, row]));
      let records = listCliAccountRefRecords(fs, aiHomeDir, tool, { bestEffort: true });
      if (filterAccountId && /^\d+$/.test(String(filterAccountId))) {
        records = records.filter((record) => record.cliAccountId === String(filterAccountId));
      }
      if (records.length === 0) {
        outputRows.push(() => '  (Empty)');
        rowMeta.push(null);
        return;
      }
      const seenAccounts = new Map();
      const defaultRef = readDefaultAccountRef(fs, aiHomeDir, tool);
      const mobileRef = tool === 'codex' ? readCodexMobileAccountRef() : '';

      records.forEach((record) => {
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

        const quotaBadge = !runtimeBlocked && !apiKeyMode && quotaStatus === 'exhausted'
          ? '\x1b[31m[额度已耗尽]\x1b[0m'
          : '';
        const statusBadge = operationalStatus === 'down'
          ? '\x1b[90m[关闭]\x1b[0m'
          : runtimeBlocked
          ? (isAuthInvalidRuntimeStatus(runtimeStatus) ? '\x1b[31m[认证失效]\x1b[0m' : '\x1b[31m[运行态不可用]\x1b[0m')
          : !configured
          ? '\x1b[90m[待登录]\x1b[0m'
          : '';
        const roleBadges = [
          accountRef === defaultRef ? '\x1b[32m[★ Default]\x1b[0m' : '',
          tool === 'codex' && accountRef === mobileRef ? '\x1b[35m[📱 Mobile]\x1b[0m' : ''
        ].filter(Boolean).join(' ');
        const accountBadges = [roleBadges, statusBadge, quotaBadge].filter(Boolean).join(' ');
        const accountBadgesSuffix = accountBadges ? `  ${accountBadges}` : '';
        const planBadge = renderAccountPlanBadge(tool, accountRef, { apiKeyMode });
        const planPrefix = planBadge ? `${planBadge} ` : '';
        const accountInfo = configured && accountName !== 'Unknown' ? `(${accountName})` : '';

        let duplicateWarning = '';
        if (configured && accountName !== 'Unknown' && accountName !== 'Token Configured' && !accountName.startsWith('API Key')) {
          if (seenAccounts.has(accountName)) {
            duplicateWarning = ` \x1b[31m[⚠️ Duplicate of ID ${seenAccounts.get(accountName)}]\x1b[0m`;
          } else {
            seenAccounts.set(accountName, id);
          }
        }

        outputRows.push((prefix) => `${prefix}${planPrefix}Account ID: \x1b[36m${id}\x1b[0m${accountBadgesSuffix} \x1b[35m${accountInfo}\x1b[0m ${usageLabel} ${duplicateWarning}`.replace(/\s+$/, ''));
        rowMeta.push({ provider: tool, accountRef });
      });
    });

    const animator = runAnimatedList({
      renderLine: (prefix, index) => {
        const render = outputRows[index];
        return render ? render(prefix) : '';
      },
      lineCount: outputRows.length,
      readActivity: () => readAccountActivity(aiHomeDir, fs),
      activityOfRow: (activities, index) => {
        const meta = rowMeta[index];
        return meta && meta.accountRef ? activityOf(activities, meta.provider, meta.accountRef) : null;
      },
      keepAlive: !!(processObj && processObj.stdin && typeof processObj.stdin.resume === 'function'),
      processObj,
      onExit: null
    });

    if (!animator) {
      outputRows.forEach((render) => console.log(render(renderPrefix(null, null, { staticMarker: '●' }))));
      console.log('');
      return;
    }

    if (processObj && processObj.stdin && typeof processObj.stdin.resume === 'function') {
      try { processObj.stdin.resume(); } catch (_error) {}
    }

    // 动画常驻：Ctrl+C 时停掉动画、打印静态最终态再退出。
    const finalize = () => {
      if (typeof animator.stop === 'function') animator.stop();
      const activities = readAccountActivity(aiHomeDir, fs);
      processObj.stdout.write('\x1b[H\x1b[J');
      outputRows.forEach((render, index) => {
        const meta = rowMeta[index];
        const activity = meta && meta.accountRef ? activityOf(activities, meta.provider, meta.accountRef) : null;
        console.log(render(renderPrefix(activity, null, { staticMarker: '●' })));
      });
      console.log('');
    };
    if (processObj && typeof processObj.on === 'function') {
      processObj.on('SIGINT', () => {
        finalize();
        processObj.exit(130);
      });
    }
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
